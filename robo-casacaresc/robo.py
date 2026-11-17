# -*- coding: utf-8 -*-
"""
Robo de autorizacao de guias SP/SADT - CASACARESC (portal Benner Conecta)
Clinica Luciano Noceti

So recebe dados do CRM. Quem chama e o servidor-local (mesmo servidor do robo
Unimed), com:   python robo.py --input pedido.json

O robo preenche a guia e PARA no resumo. Quem clica em Autorizar e uma pessoa
(conferencia humana obrigatoria). Depois do clique o robo le o resultado e
devolve para o servidor, que grava no CRM.

Saida: a ultima coisa impressa e "=== RESULTADO ===" seguida de um JSON, no
mesmo contrato do robo Unimed/SC Saude (ver servidor-local/src/executor.ts).
"""
import argparse
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

PASTA = Path(__file__).resolve().parent
# variaveis que o servidor passa no ambiente tem prioridade sobre o .env
load_dotenv(PASTA / ".env", override=False)

URL_BASE = "https://portalconectasaude.com.br"
URL_NOVA_GUIA = URL_BASE + "/Guias/SpSadt/NovaGuiaEletiva"

EMAIL = os.getenv("CASACARESC_EMAIL", os.getenv("EMAIL", "clinica@lucianonoceti.com.br")).strip()
SENHA = os.getenv("CASACARESC_SENHA", os.getenv("SENHA", "")).strip()
EXECUTANTE = os.getenv("EXECUTANTE", "LUCIANO NOCETI E VIEIRA - MATRIZ").strip()
CBO = os.getenv("CBO", "Psicólogo clínico").strip()
LENTIDAO_MS = int(os.getenv("LENTIDAO_MS", "150"))
CONFERENCIA_MIN = int(os.getenv("CONFERENCIA_MIN", "15"))
HEADLESS = False  # conferencia humana: a janela precisa aparecer sempre

PASTA_PRINTS = PASTA / "resultados" / "prints"
PERFIL = PASTA / "perfil_navegador"


class ErroRobo(Exception):
    def __init__(self, codigo, mensagem):
        super().__init__(mensagem)
        self.codigo = codigo
        self.mensagem = mensagem


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def sem_acento(txt):
    txt = unicodedata.normalize("NFKD", str(txt))
    return "".join(c for c in txt if not unicodedata.combining(c)).lower().strip()


def ler_pedido(caminho):
    with open(caminho, encoding="utf-8") as f:
        d = json.load(f)
    p = {
        "job_id": d.get("job_id", ""),
        "paciente": (d.get("paciente") or {}).get("nome", ""),
        "carteirinha": re.sub(r"\D", "", str((d.get("paciente") or {}).get("carteirinha", ""))),
        "profissional": str((d.get("profissional") or {}).get("nome", "")).strip(),
        "codigo": str((d.get("procedimento") or {}).get("codigo", "")).strip(),
        "quantidade": int((d.get("procedimento") or {}).get("quantidade") or 0),
    }
    if not p["carteirinha"]:
        raise ErroRobo("CARTEIRINHA_AUSENTE", f"Paciente {p['paciente']} sem carteirinha no CRM.")
    if not p["profissional"]:
        raise ErroRobo("PSICOLOGO_AUSENTE", "Pedido sem psicologo. O solicitante na Casacaresc e o psicologo.")
    if not p["codigo"]:
        raise ErroRobo("PROCEDIMENTO_AUSENTE", "Pedido sem codigo de procedimento.")
    if p["quantidade"] < 1:
        raise ErroRobo("QUANTIDADE_INVALIDA", "Quantidade de sessoes zerada no pedido.")
    return p


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
        raise ErroRobo("CONFIG_AUSENTE", "Senha do portal Casacaresc nao configurada neste PC. Feche o robo e abra o iniciar.bat de novo: ele pede a senha.")
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
        log("Login nao passou sozinho (2 fatores ou captcha?). Esperando ate 5 min resolverem na janela...")
        page.wait_for_url(lambda u: "/Account/Login" not in u, timeout=300000)
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


def banner(page, texto, cor="#0f766e"):
    """Faixa fixa no topo do portal avisando a pessoa o que fazer."""
    try:
        page.evaluate(
            """([t, c]) => {
                let el = document.getElementById('robo-cln-aviso');
                if (!el) { el = document.createElement('div'); el.id = 'robo-cln-aviso'; document.body.appendChild(el); }
                el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px 20px;' +
                  'font:bold 17px Arial;color:#fff;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3);background:' + c;
                el.textContent = t;
            }""",
            [texto, cor],
        )
    except Exception:
        pass


def ainda_no_resumo(page):
    btn = page.locator("button:visible, a:visible, input[type=submit]:visible") \
              .filter(has_text=re.compile(r"^\s*Autorizar\s*$", re.I))
    try:
        return btn.count() > 0 and "NovaGuia" in page.url
    except Exception:
        return False


def ler_desfecho(page):
    texto = page.locator("body").inner_text()
    t = sem_acento(texto)
    m = re.search(r"(?:n[uú]mero\s+da\s+guia|guia\s+(?:n[º°o.]*|numero)?|senha)[^\d]{0,40}(\d{5,})", texto, re.I)
    numero = m.group(1) if m else ""
    if not numero:
        m2 = re.search(r"[?&]id=(\d{5,})", page.url)
        numero = m2.group(1) if m2 else ""
    if re.search(r"\b(negad[ao]|indeferid[ao])\b", t):
        situacao = "NEGADA"
    elif re.search(r"em (analise|auditoria|estudo)|aguardando (analise|auditoria)", t):
        situacao = "EM_ANALISE"
    else:
        situacao = "APROVADO"
    return numero, situacao, re.sub(r"\s+", " ", texto)[:400]


def aguardar_conferencia_humana(page, p, problemas):
    aviso = (f"ROBO: confira a guia de {p['paciente'] or p['carteirinha']} "
             f"({p['quantidade']} sessoes) e clique em AUTORIZAR. Se estiver errada, feche esta janela.")
    if problemas:
        banner(page, "ATENCAO, o robo achou diferenca: " + "; ".join(problemas) +
               ". Corrija antes de autorizar ou feche a janela.", "#b91c1c")
    else:
        banner(page, aviso)
    log("Guia preenchida. Esperando uma pessoa conferir e clicar em Autorizar...")

    limite = time.time() + CONFERENCIA_MIN * 60
    while time.time() < limite:
        try:
            if page.is_closed():
                raise ErroRobo("CONFERENCIA_CANCELADA", "A janela foi fechada sem autorizar. Nenhuma guia foi emitida.")
            if not ainda_no_resumo(page):
                try:
                    page.wait_for_load_state("networkidle", timeout=20000)
                except PWTimeout:
                    pass
                time.sleep(2)
                if ainda_no_resumo(page):
                    continue  # portal so mostrou um aviso; segue esperando
                return ler_desfecho(page)
            time.sleep(2)
        except ErroRobo:
            raise
        except Exception as e:
            if "closed" in str(e).lower() or "target" in str(e).lower():
                raise ErroRobo("CONFERENCIA_CANCELADA", "A janela foi fechada sem autorizar. Nenhuma guia foi emitida.")
            time.sleep(2)
    raise ErroRobo("CONFERENCIA_NAO_CONCLUIDA",
                   f"Ninguem clicou em Autorizar em {CONFERENCIA_MIN} minutos. Nenhuma guia foi emitida, pode pedir de novo.")


def print_tela(page, p, sufixo):
    PASTA_PRINTS.mkdir(parents=True, exist_ok=True)
    arq = PASTA_PRINTS / f"{datetime.now():%Y%m%d_%H%M%S}_{p.get('job_id') or p.get('carteirinha')}_{sufixo}.png"
    try:
        page.screenshot(path=str(arq), full_page=True)
        return str(arq)
    except Exception:
        return None


def resultado(dados):
    print("\n=== RESULTADO ===")
    print(json.dumps(dados, ensure_ascii=False, indent=2), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    args = ap.parse_args()
    inicio = time.time()
    etapa = "leitura_pedido"
    p = {}
    page = None
    ctx = None
    try:
        p = ler_pedido(args.input)
        log(f"Pedido {p['job_id']}: {p['paciente']} | {p['profissional']} | {p['codigo']} x{p['quantidade']}")
        with sync_playwright() as pw:
            etapa = "abrir_navegador"
            try:
                ctx = pw.chromium.launch_persistent_context(str(PERFIL), channel="msedge", headless=HEADLESS,
                                                            slow_mo=LENTIDAO_MS, viewport={"width": 1366, "height": 850})
            except Exception:
                ctx = pw.chromium.launch_persistent_context(str(PERFIL), channel="chrome", headless=HEADLESS,
                                                            slow_mo=LENTIDAO_MS, viewport={"width": 1366, "height": 850})
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.set_default_timeout(30000)
            page.on("dialog", lambda d: (log(f"Aviso do portal: {d.message}"), d.accept()))
            try:
                etapa = "login"; fazer_login(page)
                etapa = "beneficiario"; passo1_beneficiario(page, p)
                etapa = "solicitante"; passo2_solicitante(page, p)
                etapa = "procedimento"; passo3_procedimento(page, p)
                etapa = "executante"; passo4_executante(page, p)
                etapa = "anexos"; passo5_anexos(page, p)
                etapa = "resumo"; problemas = conferir_resumo(page, p)
                etapa = "conferencia_humana"
                numero, situacao, texto = aguardar_conferencia_humana(page, p, problemas)
                comprovante = print_tela(page, p, "comprovante")
                obs = None
                if not numero:
                    obs = "Robo nao achou o numero da guia na tela depois do Autorizar. Confira o comprovante e preencha o numero."
                if problemas:
                    obs = ((obs + " ") if obs else "") + "Robo apontou diferenca no resumo antes do Autorizar: " + "; ".join(problemas)
                resultado({
                    "sucesso": True,
                    "numero_guia": numero or None,
                    "situacao": situacao,
                    "observacao": obs,
                    "quantidade_solicitada": p["quantidade"],
                    "quantidade_autorizada": None,
                    "screenshot_comprovante_path": comprovante,
                    "duracao_ms": int((time.time() - inicio) * 1000),
                })
            finally:
                try:
                    ctx.close()
                except Exception:
                    pass
    except ErroRobo as e:
        shot = print_tela(page, p, "erro") if page is not None and not page.is_closed() else None
        resultado({"sucesso": False, "etapa": etapa, "erro_codigo": e.codigo, "mensagem": e.mensagem,
                   "screenshot_path": shot})
    except Exception as e:
        shot = None
        try:
            if page is not None and not page.is_closed():
                shot = print_tela(page, p, "erro")
        except Exception:
            pass
        msg = str(e).splitlines()[0][:400] if str(e) else e.__class__.__name__
        resultado({"sucesso": False, "etapa": etapa, "erro_codigo": "ERRO_" + etapa.upper(),
                   "mensagem": f"Falhou na etapa '{etapa}': {msg}", "screenshot_path": shot})


if __name__ == "__main__":
    main()
