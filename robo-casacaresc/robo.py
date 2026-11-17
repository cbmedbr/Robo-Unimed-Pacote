# -*- coding: utf-8 -*-
"""
Robo de autorizacao de guias SP/SADT - CASACARESC (portal Benner Conecta)
Clinica Luciano Noceti

Le a planilha pacientes.xlsx, pede a autorizacao de cada paciente no portal
e grava o resultado em resultados/.
"""
import os
import re
import sys
import time
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from openpyxl import Workbook, load_workbook
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PASTA = Path(__file__).resolve().parent
load_dotenv(PASTA / ".env")

URL_BASE = "https://portalconectasaude.com.br"
URL_LOGIN = URL_BASE + "/Account/Login"
URL_NOVA_GUIA = URL_BASE + "/Guias/SpSadt/NovaGuiaEletiva"

EMAIL = os.getenv("EMAIL", "").strip()
SENHA = os.getenv("SENHA", "").strip()
MODO_TESTE = os.getenv("MODO_TESTE", "sim").strip().lower() in ("sim", "s", "true", "1", "yes")
CODIGO_TIPICO = os.getenv("CODIGO_TIPICO", "50000470").strip()
CODIGO_TEA = os.getenv("CODIGO_TEA", "225000286").strip()
EXECUTANTE = os.getenv("EXECUTANTE", "LUCIANO NOCETI E VIEIRA - MATRIZ").strip()
CBO = os.getenv("CBO", "Psicólogo clínico").strip()
DIAS_JANELA = int(os.getenv("DIAS_JANELA", "31"))
LENTIDAO_MS = int(os.getenv("LENTIDAO_MS", "150"))

PLANILHA = PASTA / "pacientes.xlsx"
PASTA_RESULT = PASTA / "resultados"
PASTA_PRINTS = PASTA_RESULT / "prints"
PERFIL = PASTA / "perfil_navegador"

DIAS = {"seg": 0, "ter": 1, "qua": 2, "qui": 3, "sex": 4, "sab": 5, "dom": 6}


# ------------------------------------------------------------------ utilidades
def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def sem_acento(txt):
    txt = unicodedata.normalize("NFKD", str(txt))
    return "".join(c for c in txt if not unicodedata.combining(c)).lower().strip()


def calcular_quantidade(dias_semana_txt, inicio=None):
    """Conta quantos atendimentos caem nos proximos DIAS_JANELA dias (comecando hoje)."""
    inicio = inicio or date.today()
    dias = []
    for parte in re.split(r"[,;/]+|\s+e\s+|\s+", sem_acento(dias_semana_txt)):
        parte = parte.strip()[:3]
        if parte in DIAS:
            dias.append(DIAS[parte])
    if not dias:
        raise ValueError(f"dia da semana invalido: '{dias_semana_txt}' (use seg, ter, qua, qui, sex, sab)")
    total = 0
    for i in range(DIAS_JANELA):
        if (inicio + timedelta(days=i)).weekday() in dias:
            total += 1
    return total


def ler_planilha():
    if not PLANILHA.exists():
        sys.exit(f"Nao achei a planilha {PLANILHA.name} na pasta do robo.")
    ws = load_workbook(PLANILHA, data_only=True).active
    linhas = list(ws.iter_rows(values_only=True))
    cab = [sem_acento(c or "") for c in linhas[0]]

    def col(nome):
        return cab.index(nome) if nome in cab else None

    ic, ip, it, idias, iq, inome = (col("carteirinha"), col("profissional"), col("tipo"),
                                     col("dias_semana"), col("quantidade"), col("paciente"))
    if ic is None or ip is None:
        sys.exit("A planilha precisa ter as colunas 'carteirinha' e 'profissional'.")
    pacientes = []
    for n, l in enumerate(linhas[1:], start=2):
        if not l or l[ic] in (None, ""):
            continue
        cart = re.sub(r"\D", "", str(l[ic]).split(".")[0] if isinstance(l[ic], float) else str(l[ic]))
        tipo = sem_acento(l[it]) if it is not None and l[it] else "tipico"
        codigo = CODIGO_TEA if tipo.startswith("tea") else CODIGO_TIPICO
        qtd = None
        if iq is not None and l[iq] not in (None, ""):
            qtd = int(float(l[iq]))
        elif idias is not None and l[idias]:
            qtd = calcular_quantidade(l[idias])
        pacientes.append({
            "linha": n,
            "paciente": (l[inome] if inome is not None else "") or "",
            "carteirinha": cart,
            "profissional": str(l[ip]).strip(),
            "tipo": "TEA" if tipo.startswith("tea") else "TIPICO",
            "codigo": codigo,
            "quantidade": qtd,
        })
    return pacientes


# ------------------------------------------------------------------ navegador
def visivel(loc):
    try:
        return loc.count() > 0 and loc.first.is_visible()
    except Exception:
        return False


def esperar_passo(page, n, timeout=30000):
    page.get_by_text(re.compile(rf"Passo\s+{n}\s+de\s+5")).first.wait_for(timeout=timeout)
    time.sleep(0.6)


def clicar_proximo(page):
    btn = page.locator("button:visible, a:visible, input[type=button]:visible, input[type=submit]:visible") \
              .filter(has_text=re.compile(r"Pr[oó]ximo", re.I))
    if btn.count() == 0:
        btn = page.locator("input[value*='Próximo']:visible, input[value*='Proximo']:visible")
    btn.last.scroll_into_view_if_needed()
    btn.last.click()


def campo_por_label(page, texto_label, seletor="input"):
    """Acha o campo que vem logo depois de um label (ex: 'Beneficiário*')."""
    lbl = page.locator("label:visible").filter(has_text=re.compile(rf"^\s*{texto_label}\s*\*?\s*$", re.I)).first
    lbl.wait_for(timeout=20000)
    alvo = lbl.get_attribute("for")
    if alvo:
        el = page.locator(f"[id='{alvo}']")
        if el.count() and el.first.is_visible():
            return el.first
    return lbl.locator(f"xpath=following::{seletor}[not(@type='hidden')][1]")


def lupa_depois_de(campo):
    return campo.locator(
        "xpath=following::*[(self::button or self::a or self::span or self::i) and "
        "(contains(@class,'search') or .//*[contains(@class,'search')])][1]"
    )


def select2_container_por_label(page, texto_label):
    lbl = page.locator("label:visible").filter(has_text=re.compile(rf"^\s*{texto_label}\s*\*?\s*$", re.I)).first
    lbl.wait_for(timeout=20000)
    return lbl.locator(
        "xpath=following::*[contains(@class,'select2-selection') or contains(@class,'select2-choice')][1]"
    )


def select2_campo_busca(page):
    return page.locator(
        ".select2-container--open .select2-search__field, .select2-drop-active input.select2-input, "
        ".select2-dropdown input.select2-search__field"
    ).first


def select2_opcoes(page):
    return page.locator(
        ".select2-container--open .select2-results__option, .select2-drop-active .select2-result, "
        ".select2-results li"
    )


def fazer_login(page):
    page.goto(URL_NOVA_GUIA, wait_until="domcontentloaded")
    time.sleep(1.5)
    if "/Account/Login" not in page.url:
        log("Ja estava logado.")
        return
    if not EMAIL or not SENHA:
        sys.exit("Preencha EMAIL e SENHA no arquivo .env antes de rodar.")
    log("Fazendo login...")
    page.locator("input[type=email], input[name*='mail' i], input[id*='mail' i]").first.fill(EMAIL)
    page.locator("input[type=password]").first.fill(SENHA)
    lembrar = page.locator("input[type=checkbox]")
    if lembrar.count() and not lembrar.first.is_checked():
        lembrar.first.check()
    page.locator("button, input[type=submit]").filter(has_text=re.compile("Acessar", re.I)).first.click() \
        if page.locator("button").filter(has_text=re.compile("Acessar", re.I)).count() \
        else page.locator("input[type=submit]").first.click()
    try:
        page.wait_for_url(lambda u: "/Account/Login" not in u, timeout=60000)
    except PWTimeout:
        print("\n*** O login nao passou sozinho. Se apareceu codigo de 2 fatores ou captcha, "
              "resolva na janela do navegador e aperte ENTER aqui. ***")
        input()
    log("Login ok.")


# ------------------------------------------------------------------ passos da guia
def passo1_beneficiario(page, p):
    page.goto(URL_NOVA_GUIA, wait_until="domcontentloaded")
    esperar_passo(page, 1)
    campo = campo_por_label(page, "Benefici[aá]rio")
    campo.click()
    campo.fill("")
    campo.type(p["carteirinha"], delay=30)
    lupa = lupa_depois_de(campo)
    if visivel(lupa):
        lupa.first.click()
    else:
        campo.press("Enter")
    # espera o portal carregar os dados do beneficiario
    time.sleep(2.5)
    page.wait_for_load_state("networkidle")
    erro = page.locator(".alert-danger:visible, .toast-error:visible, .validation-summary-errors:visible")
    if visivel(erro):
        raise RuntimeError("Portal recusou a carteirinha: " + erro.first.inner_text().strip()[:200])
    clicar_proximo(page)
    esperar_passo(page, 2)


def passo2_solicitante(page, p):
    nome = p["profissional"]
    caixa = select2_container_por_label(page, "Solicitante")
    caixa.click()
    busca = select2_campo_busca(page)
    busca.fill(nome)
    busca.press("Enter")
    time.sleep(1.5)

    alvo = sem_acento(nome)
    escolhido = False
    opcoes = select2_opcoes(page)
    for i in range(opcoes.count()):
        t = opcoes.nth(i).inner_text()
        if alvo in sem_acento(t) and "selecionar outro" not in sem_acento(t):
            opcoes.nth(i).click()
            escolhido = True
            break

    if not escolhido:
        # abre o "Selecionar outro..." e pesquisa no modal
        outro = select2_opcoes(page).filter(has_text=re.compile("Selecionar outro", re.I))
        if not visivel(outro):
            caixa.click()
            outro = select2_opcoes(page).filter(has_text=re.compile("Selecionar outro", re.I))
        outro.first.click()
        modal = page.locator(".modal:visible").last
        modal.wait_for(timeout=15000)
        campo_nome = modal.locator("input[type=text]:visible, input:not([type]):visible").first
        campo_nome.fill(nome)
        campo_nome.press("Enter")
        time.sleep(2)
        linhas = modal.locator("tbody tr")
        linhas.first.wait_for(timeout=15000)
        melhor = None
        for i in range(linhas.count()):
            t = sem_acento(linhas.nth(i).inner_text())
            if alvo in t:
                # prefere a pessoa fisica (tem CRP) e nao a empresa (CNPJ)
                if "crp" in t:
                    melhor = linhas.nth(i)
                    break
                melhor = melhor or linhas.nth(i)
        if melhor is None:
            raise RuntimeError(f"Profissional '{nome}' nao encontrado no portal.")
        melhor.click()
        time.sleep(1.5)

    # CBO
    cbo = page.locator("select:visible").filter(has=page.locator("option", has_text=re.compile("Psic", re.I))).first
    cbo.wait_for(timeout=15000)
    opcoes_cbo = cbo.locator("option")
    valor = None
    for i in range(opcoes_cbo.count()):
        if sem_acento(CBO) in sem_acento(opcoes_cbo.nth(i).inner_text()):
            valor = opcoes_cbo.nth(i).get_attribute("value")
            break
    if valor is None:
        raise RuntimeError("Nao achei o CBO de psicologo clinico.")
    cbo.select_option(value=valor)
    time.sleep(0.8)
    clicar_proximo(page)
    esperar_passo(page, 3)


def passo3_procedimento(page, p):
    codigo, qtd = p["codigo"], p["quantidade"]
    campo = campo_por_label(page, "Procedimento ou Item Assistencial")
    campo.scroll_into_view_if_needed()
    campo.click()
    campo.fill("")
    campo.type(codigo, delay=30)
    lupa = lupa_depois_de(campo)
    if visivel(lupa):
        lupa.first.click()
    else:
        campo.press("Enter")
    time.sleep(2)

    # se abrir modal de resultado, clica na linha do codigo
    modal = page.locator(".modal:visible")
    if visivel(modal):
        linha = modal.last.locator("tbody tr").filter(has_text=codigo)
        if visivel(linha):
            linha.first.click()
            time.sleep(1.5)

    item = page.locator(f"xpath=//*[contains(normalize-space(.), '{codigo} |') and "
                        f"not(.//*[contains(normalize-space(.), '{codigo} |')])]").first
    item.wait_for(timeout=15000)
    campo_qtd = item.locator("xpath=following::input[not(@type='hidden')][1]")
    campo_qtd.click()
    campo_qtd.fill(str(qtd))
    campo_qtd.press("Tab")
    time.sleep(0.8)
    clicar_proximo(page)
    esperar_passo(page, 4)


def passo4_executante(page, p):
    caixa = page.get_by_text(re.compile("Selecione um prestador", re.I))
    if visivel(caixa):
        caixa.first.click()
    else:
        select2_container_por_label(page, "Contratado Executante").click()
    time.sleep(1)
    opcoes = select2_opcoes(page)
    escolhido = False
    for i in range(opcoes.count()):
        if sem_acento(EXECUTANTE) in sem_acento(opcoes.nth(i).inner_text()):
            opcoes.nth(i).click()
            escolhido = True
            break
    if not escolhido:
        raise RuntimeError(f"Nao achei o executante '{EXECUTANTE}'.")
    time.sleep(2)  # espera o CNES preencher
    clicar_proximo(page)
    esperar_passo(page, 5)


def passo5_anexos(page, p):
    # nunca inclui anexo
    clicar_proximo(page)
    page.get_by_text(re.compile("Itens Solicitados", re.I)).first.wait_for(timeout=30000)
    time.sleep(1)


def conferir_resumo(page, p):
    texto = sem_acento(page.locator("body").inner_text())
    problemas = []
    if sem_acento(p["profissional"]) not in texto:
        problemas.append("profissional nao bate")
    if "psicologo clinico" not in texto:
        problemas.append("CBO nao e psicologo clinico")
    if sem_acento(EXECUTANTE)[:20] not in texto:
        problemas.append("executante nao bate")
    linha = page.locator("tr").filter(has_text=re.compile("psicoterapia|sess", re.I))
    if linha.count() == 0:
        problemas.append("procedimento nao aparece no resumo")
    else:
        celulas = [c.strip() for c in linha.first.locator("td").all_inner_texts()]
        if str(p["quantidade"]) not in celulas:
            problemas.append(f"quantidade no resumo diferente de {p['quantidade']} ({celulas})")
    if p["carteirinha"] not in re.sub(r"\D", "", page.locator("body").inner_text()):
        problemas.append("carteirinha nao aparece no resumo")
    return problemas


def autorizar(page):
    btn = page.locator("button:visible, a:visible, input[type=submit]:visible") \
              .filter(has_text=re.compile(r"Autorizar", re.I)).last
    btn.scroll_into_view_if_needed()
    btn.click()
    try:
        page.wait_for_load_state("networkidle", timeout=60000)
    except PWTimeout:
        pass
    time.sleep(3)
    texto = page.locator("body").inner_text()
    m = re.search(r"(?:guia|n[uú]mero|senha)[^\d]{0,40}(\d{5,})", texto, re.I)
    return (m.group(1) if m else ""), texto


# ------------------------------------------------------------------ principal
def print_tela(page, p, sufixo):
    PASTA_PRINTS.mkdir(parents=True, exist_ok=True)
    arq = PASTA_PRINTS / f"{datetime.now():%Y%m%d_%H%M%S}_{p['carteirinha']}_{sufixo}.png"
    try:
        page.screenshot(path=str(arq), full_page=True)
    except Exception:
        pass
    return arq.name


def processar(page, p):
    passo1_beneficiario(page, p)
    passo2_solicitante(page, p)
    passo3_procedimento(page, p)
    passo4_executante(page, p)
    passo5_anexos(page, p)
    problemas = conferir_resumo(page, p)
    if problemas:
        return "CONFERIR", "", "Resumo com divergencia: " + "; ".join(problemas), print_tela(page, p, "divergencia")
    if MODO_TESTE:
        return "TESTE_OK", "", "Tudo certo ate o resumo. Nao clicou em Autorizar (MODO_TESTE=sim).", \
               print_tela(page, p, "resumo")
    numero, texto = autorizar(page)
    status = "AUTORIZADO" if numero else "ENVIADO"
    msg = re.sub(r"\s+", " ", texto)[:300]
    return status, numero, msg, print_tela(page, p, "autorizado")


def main():
    pacientes = ler_planilha()
    if not pacientes:
        sys.exit("A planilha esta vazia.")
    sem_qtd = [p for p in pacientes if not p["quantidade"]]
    if sem_qtd:
        sys.exit("Linhas sem quantidade e sem dias_semana: " + ", ".join(str(p["linha"]) for p in sem_qtd))

    log(f"{len(pacientes)} paciente(s) na planilha. MODO_TESTE={'SIM (nao autoriza)' if MODO_TESTE else 'NAO (vai autorizar de verdade)'}")
    PASTA_RESULT.mkdir(exist_ok=True)

    wb = Workbook()
    ws = wb.active
    ws.title = "resultado"
    ws.append(["linha", "paciente", "carteirinha", "profissional", "tipo", "codigo", "quantidade",
               "status", "numero_guia", "mensagem", "print", "horario"])
    arq_result = PASTA_RESULT / f"resultado_{datetime.now():%Y%m%d_%H%M}.xlsx"

    with sync_playwright() as pw:
        try:
            ctx = pw.chromium.launch_persistent_context(str(PERFIL), channel="msedge", headless=False,
                                                        slow_mo=LENTIDAO_MS, viewport={"width": 1366, "height": 850})
        except Exception:
            ctx = pw.chromium.launch_persistent_context(str(PERFIL), channel="chrome", headless=False,
                                                        slow_mo=LENTIDAO_MS, viewport={"width": 1366, "height": 850})
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.set_default_timeout(30000)
        page.on("dialog", lambda d: (log(f"Aviso do portal: {d.message}"), d.accept()))

        fazer_login(page)

        for i, p in enumerate(pacientes, 1):
            log(f"({i}/{len(pacientes)}) {p['paciente'] or p['carteirinha']} | {p['profissional']} | "
                f"{p['tipo']} {p['codigo']} x{p['quantidade']}")
            try:
                status, numero, msg, prt = processar(page, p)
            except Exception as e:
                status, numero, msg, prt = "ERRO", "", str(e).splitlines()[0][:300], print_tela(page, p, "erro")
            log(f"   -> {status} {numero} {msg[:120]}")
            ws.append([p["linha"], p["paciente"], p["carteirinha"], p["profissional"], p["tipo"], p["codigo"],
                       p["quantidade"], status, numero, msg, prt, f"{datetime.now():%d/%m/%Y %H:%M}"])
            wb.save(arq_result)

        ctx.close()

    log(f"Fim. Resultado salvo em: {arq_result}")


if __name__ == "__main__":
    main()
