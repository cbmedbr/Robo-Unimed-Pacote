# -*- coding: utf-8 -*-
"""
Robo de autorizacao de guias SP/SADT - CASACARESC (portal Benner Conecta)
Clinica Luciano Noceti

So recebe dados do CRM. Quem chama e o servidor-local (mesmo servidor do robo
Unimed), com:   python robo.py --input pedido.json

O robo preenche a guia, confere o resumo e, se tudo bater com o pedido, clica em
Autorizar sozinho (decisao da operacao, 17/11/2026). Resumo diferente do pedido:
NAO autoriza. Depois do clique le o recibo (numero, senha, datas, quantidade) e
devolve para o servidor, que grava a guia no CRM.

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
# CBO pelo CODIGO (so digitos). O nome com acento vinha corrompido do .env no
# Windows (PowerShell le o arquivo como ANSI) e o robo nao achava a opcao.
CBO_CODIGO = re.sub(r"\D", "", os.getenv("CBO_CODIGO", "251510")) or "251510"
LENTIDAO_MS = int(os.getenv("LENTIDAO_MS", "150"))
PROCESSAMENTO_MIN = int(os.getenv("PROCESSAMENTO_MIN", "5"))
HEADLESS = False  # conferencia humana: a janela precisa aparecer sempre

PASTA_PRINTS = PASTA / "resultados" / "prints"
PERFIL = PASTA / "perfil_navegador"



JS_MARCAR_QTD = """(codigo) => {
  const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  let alvo = null;
  for (const el of document.querySelectorAll('input, textarea, span, div, td, label, p, li')) {
    if (!vis(el)) continue;
    const valor = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || '') : '';
    const texto = el.children.length === 0 ? (el.textContent || '') : '';
    const t = valor || texto;
    if (t.includes(codigo) && t.includes('|')) alvo = el;
  }
  if (!alvo) return false;
  document.querySelectorAll('[data-robo-qtd]').forEach(e => e.removeAttribute('data-robo-qtd'));
  const campos = Array.from(document.querySelectorAll('input')).filter(i =>
    vis(i) && !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(i.type) && i !== alvo);
  for (const i of campos) {
    if (alvo.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING) {
      i.setAttribute('data-robo-qtd', '1');
      return true;
    }
  }
  return false;
}"""


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
        # O Enter no campo pode ja ter aberto o modal de busca sozinho.
        if not visivel(page.locator(".modal:visible")):
            outro = select2_opcoes(page).filter(has_text=re.compile("Selecionar outro", re.I))
            if not visivel(outro):
                caixa.click()
                outro = select2_opcoes(page).filter(has_text=re.compile("Selecionar outro", re.I))
            outro.first.click()
        modal = page.locator(".modal:visible").last
        modal.wait_for(timeout=15000)
        # So digitar o nome e apertar Enter (nao precisa da lupa/Pesquisar).
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

    # CBO: as opcoes chegam depois que o psicologo e escolhido. Espera a
    # opcao com o codigo aparecer em algum select visivel (ate 20s).
    cbo, valor = None, None
    limite = time.time() + 20
    while time.time() < limite and valor is None:
        selects = page.locator("select:visible")
        for i in range(selects.count()):
            opcoes = selects.nth(i).locator("option")
            for j in range(opcoes.count()):
                if CBO_CODIGO in opcoes.nth(j).inner_text():
                    cbo, valor = selects.nth(i), opcoes.nth(j).get_attribute("value")
                    break
            if valor is not None:
                break
        if valor is None:
            time.sleep(0.5)
    if valor is None:
        raise RuntimeError(f"Nao achei o CBO {CBO_CODIGO} (psicologo clinico) depois de escolher o psicologo.")
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

    # O item escolhido aparece numa caixa cinza ("50000470 | Sessao de ...") que
    # pode ser texto OU o valor de um campo. A quantidade e o primeiro campo
    # visivel depois dele. Marca esse campo e preenche (ate 15s esperando).
    achou = False
    limite = time.time() + 15
    while time.time() < limite and not achou:
        achou = page.evaluate(JS_MARCAR_QTD, codigo)
        if not achou:
            time.sleep(0.5)
    if not achou:
        raise RuntimeError(f"O procedimento {codigo} nao apareceu na lista depois da pesquisa.")
    campo_qtd = page.locator("[data-robo-qtd='1']").first
    campo_qtd.click()
    campo_qtd.fill(str(qtd))
    campo_qtd.press("Tab")
    time.sleep(0.5)
    if (campo_qtd.input_value() or "").strip() != str(qtd):
        raise RuntimeError(f"Nao consegui trocar a quantidade para {qtd}.")
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


JS_QTD_AUTORIZADA = r"""(codigo) => {
  for (const tab of document.querySelectorAll('table')) {
    const linhas = Array.from(tab.querySelectorAll('tr'));
    const cab = linhas.find(tr => /qt[a-z]*\.?\s*aut/i.test(tr.textContent));
    if (!cab) continue;
    const col = Array.from(cab.children).findIndex(c => /qt[a-z]*\.?\s*aut/i.test(c.textContent));
    if (col < 0) continue;
    for (const tr of linhas) {
      if (tr === cab) continue;
      const t = tr.textContent || '';
      if (t.includes(codigo) || /psicoterapia/i.test(t)) {
        const v = ((tr.children[col] && tr.children[col].textContent) || '').trim();
        if (/^\d+$/.test(v)) return parseInt(v, 10);
      }
    }
  }
  return null;
}"""


def _data_iso(br):
    try:
        return datetime.strptime(br, "%d/%m/%Y").strftime("%Y-%m-%d")
    except Exception:
        return None


def ler_recibo(page, p):
    """Le o que o portal mostrou depois do Autorizar. Nunca levanta erro."""
    texto = page.locator("body").inner_text()
    t = sem_acento(texto)

    def achar(padroes):
        for pad in padroes:
            m = re.search(pad, texto, re.I)
            if m:
                return m.group(1).strip()
        return None

    numero_operadora = achar([
        r"Guia\s+Atribu[ií]do\s+pela\s+Operadora\s*[:\-]?\s*(\d{4,})",
        r"N[º°o]?\.?\s*(?:da\s+)?Guia\s+(?:na|da)\s+Operadora\s*[:\-]?\s*(\d{4,})",
    ])
    numero_prestador = achar([r"N[º°o]?\.?\s*(?:da\s+)?Guia\s+(?:no\s+|do\s+)?Prestador\s*[:\-]?\s*(\d{4,})"])
    numero_generico = achar([r"N[uú]mero\s+da\s+Guia\s*[:\-]?\s*(\d{4,})", r"\bGuia\s*(?:n[º°o.]*)?\s*[:\-]\s*(\d{4,})"])
    senha = achar([r"\bSenha\s*[:\-]?\s*([A-Z0-9]{4,})"])
    m_id = re.search(r"[?&]id=(\d{5,})", page.url)
    numero = numero_operadora or numero_generico or numero_prestador or senha or (m_id.group(1) if m_id else None)

    data_aut = _data_iso(achar([r"Data\s+(?:da|de)\s+Autoriza[çc][ãa]o\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})"]) or "")
    validade = _data_iso(achar([
        r"Data\s+de\s+Validade\s+da\s+Senha\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})",
        r"Validade[^\d\n]{0,30}(\d{2}/\d{2}/\d{4})",
    ]) or "")
    try:
        qtd_aut = page.evaluate(JS_QTD_AUTORIZADA, p["codigo"])
    except Exception:
        qtd_aut = None

    if re.search(r"\b(negad[ao]|indeferid[ao])\b", t):
        situacao = "NEGADA"
    elif re.search(r"em (analise|auditoria|estudo)|aguardando (analise|auditoria)|enviada para processamento", t):
        situacao = "EM_ANALISE"
    elif re.search(r"\bautorizad[ao]\b|\baprovad[ao]\b", t):
        situacao = "APROVADO"
    else:
        # Sem palavra clara de desfecho: nao da para dizer que liberou.
        situacao = "EM_ANALISE"
    return {
        "numero": numero, "numero_prestador": numero_prestador, "numero_operadora_recibo": numero_operadora,
        "senha": senha, "data_autorizacao": data_aut, "data_validade": validade,
        "quantidade_autorizada": qtd_aut, "situacao": situacao,
    }


def autorizar_sozinho(page, ctx, p, problemas):
    """Clica em Autorizar quando o resumo bate com o pedido e devolve a pagina do recibo.

    Divergencia no resumo: NAO autoriza (erro RESUMO_DIVERGENTE). Depois do clique,
    nunca devolve falha por causa da leitura: a guia pode ja existir na operadora, e
    um "falhou" faria alguem pedir de novo e duplicar.
    """
    if problemas:
        e = ErroRobo("RESUMO_DIVERGENTE",
                     "O resumo do portal veio diferente do pedido (" + "; ".join(problemas) +
                     "). O robo NAO autorizou. Confira o cadastro e peca de novo.")
        e.shot = print_tela(page, p, "erro")
        raise e

    paginas_antes = set(ctx.pages)
    btn = page.locator("button:visible, a:visible, input[type=submit]:visible") \
              .filter(has_text=re.compile(r"^\s*Autorizar\s*$", re.I)).last
    btn.scroll_into_view_if_needed()
    log("Resumo conferido. Clicando em Autorizar...")
    btn.click()

    recibo = None
    limite = time.time() + 90
    while time.time() < limite:
        novas = [pg for pg in ctx.pages if pg not in paginas_antes]
        if novas:
            recibo = novas[-1]
            break
        if not ainda_no_resumo(page):
            recibo = page
            break
        time.sleep(1)
    if recibo is None:
        e = ErroRobo("AUTORIZAR_SEM_RESPOSTA",
                     "Cliquei em Autorizar mas o portal nao saiu do resumo em 90s. "
                     "CONFIRA NO PORTAL se a guia foi emitida antes de pedir de novo.")
        e.shot = print_tela(page, p, "erro")
        raise e
    try:
        recibo.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    time.sleep(2)

    # O portal responde "Guia enviada para processamento... aguarde nesta pagina
    # para ver o resultado" e so depois mostra o desfecho. Espera na pagina ate
    # o aviso sumir (ate PROCESSAMENTO_MIN). Se nao sumir, a guia segue como em
    # analise e a checagem de 4 em 4 horas resolve depois.
    limite = time.time() + PROCESSAMENTO_MIN * 60
    while time.time() < limite and em_processamento(recibo):
        log("Portal processando a guia, aguardando o resultado...")
        time.sleep(10)
    try:
        recibo.wait_for_load_state("networkidle", timeout=20000)
    except Exception:
        pass
    time.sleep(2)
    return recibo


def em_processamento(pg):
    try:
        return "enviada para processamento" in sem_acento(pg.locator("body").inner_text())
    except Exception:
        return False


def print_tela(page, p, sufixo):
    PASTA_PRINTS.mkdir(parents=True, exist_ok=True)
    arq = PASTA_PRINTS / f"{datetime.now():%Y%m%d_%H%M%S}_{p.get('job_id') or p.get('carteirinha')}_{sufixo}.png"
    try:
        page.screenshot(path=str(arq), full_page=True)
        if sufixo == "erro":
            try:
                arq.with_suffix(".html").write_text(page.content(), encoding="utf-8")
            except Exception:
                pass
        return str(arq)
    except Exception:
        return None


def resultado(dados):
    print("\n=== RESULTADO ===")
    print(json.dumps(dados, ensure_ascii=False, indent=2), flush=True)



# ------------------------------------------------------------------ consulta de guia
URL_PESQUISA = URL_BASE + "/Guias/PesquisaGuia/PesquisaGuias"

JS_LER_PESQUISA = r"""(numero) => {
  const norm = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  for (const tab of document.querySelectorAll('table')) {
    const linhas = Array.from(tab.querySelectorAll('tr'));
    const cab = linhas.find(tr => /guia prestador/.test(norm(tr.textContent)) && /situa/.test(norm(tr.textContent)));
    if (!cab) continue;
    const nomes = Array.from(cab.children).map(c => norm(c.textContent));
    const col = (re) => nomes.findIndex(n => re.test(n));
    const iPrest = col(/guia prestador/), iOper = col(/guia operadora/), iSit = col(/situa/), iData = col(/data/);
    for (const tr of linhas) {
      if (tr === cab) continue;
      const cels = Array.from(tr.children).map(c => (c.textContent || '').trim());
      if (iPrest >= 0 && cels[iPrest] === String(numero)) {
        return { situacao: cels[iSit] || '', operadora: iOper >= 0 ? cels[iOper] : '', data: iData >= 0 ? cels[iData] : '' };
      }
    }
  }
  return null;
}"""


def situacao_do_texto(txt):
    t = sem_acento(txt)
    if re.search(r"autorizad|aprovad|liberad", t):
        return "APROVADO"
    if re.search(r"negad|indeferid|cancelad|recusad", t):
        return "NEGADA"
    return "EM_ANALISE"


def campo_depois_do_texto(page, trecho):
    return page.locator(
        f"xpath=//*[not(*) and contains(normalize-space(.), '{trecho}')]/following::input[not(@type='hidden')][1]"
    ).first


def consultar_guia(page, numero_prestador, data_solicitacao_br):
    """Pesquisa de Guias: filtra pelo No Guia Prestador a partir da data da solicitacao.

    Devolve {'situacao', 'situacao_texto', 'numero_operadora', 'data'} ou None se nao achou.
    """
    page.goto(URL_PESQUISA, wait_until="domcontentloaded")
    time.sleep(2)
    filtrar = page.locator("button:visible, a:visible").filter(has_text=re.compile(r"^\s*Filtrar\s*$", re.I))
    campo = campo_depois_do_texto(page, "Guia Prestador")
    if not visivel(campo) and visivel(filtrar):
        filtrar.first.click()
        time.sleep(1)
    campo.wait_for(timeout=20000)
    campo.click()
    campo.fill(str(numero_prestador))

    data = campo_depois_do_texto(page, "Data da Solicita")
    if visivel(data):
        data.click()
        data.press("Control+a")
        data.type(data_solicitacao_br, delay=40)
        data.press("Tab")

    botao = page.locator("button:visible, input[type=submit]:visible, input[type=button]:visible, a.btn:visible") \
                .filter(has_text=re.compile(r"^\s*Pesquisar\s*$", re.I))
    if botao.count() == 0:
        botao = page.locator("input[value='Pesquisar']:visible")
    botao.first.click()

    limite = time.time() + 40
    while time.time() < limite:
        t = sem_acento(page.locator("body").inner_text())
        if "resultados encontrados" in t or "resultado encontrado" in t or "nao existem registros" in t:
            break
        time.sleep(1)
    time.sleep(1)
    linha = page.evaluate(JS_LER_PESQUISA, str(numero_prestador))
    if not linha:
        return None
    oper = re.sub(r"\D", "", linha.get("operadora") or "")
    return {
        "situacao": situacao_do_texto(linha.get("situacao") or ""),
        "situacao_texto": (linha.get("situacao") or "").strip(),
        "numero_operadora": oper or None,
        "data": (linha.get("data") or "").strip(),
    }


def abrir_navegador(pw, perfil=None):
    perfil = perfil or PERFIL
    try:
        ctx = pw.chromium.launch_persistent_context(str(perfil), channel="msedge", headless=HEADLESS,
                                                    slow_mo=LENTIDAO_MS, viewport={"width": 1366, "height": 850})
    except Exception:
        ctx = pw.chromium.launch_persistent_context(str(perfil), channel="chrome", headless=HEADLESS,
                                                    slow_mo=LENTIDAO_MS, viewport={"width": 1366, "height": 850})
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.set_default_timeout(30000)
    page.on("dialog", lambda d: (log(f"Aviso do portal: {d.message}"), d.accept()))
    return ctx, page


def modo_verificar(caminho):
    """Checagem das guias em analise: python robo.py --verificar lista.json

    Entrada: {"guias": [{"job_id", "numero_prestador", "data_solicitacao": "AAAA-MM-DD"}]}
    Saida: === RESULTADO === {"resultados": [{"job_id", "numero_prestador", "situacao",
           "situacao_texto", "numero_operadora"}]}  situacao: APROVADO | NEGADA |
           EM_ANALISE | NAO_ENCONTRADA | ERRO
    """
    with open(caminho, encoding="utf-8") as f:
        guias = json.load(f).get("guias") or []
    saida = []
    with sync_playwright() as pw:
        # Perfil proprio: a checagem pode cair no meio de uma autorizacao, e dois
        # navegadores nao abrem o mesmo perfil ao mesmo tempo.
        ctx = None
        try:
            ctx, page = abrir_navegador(pw, PASTA / "perfil_verificacao")
            fazer_login(page)
            for g in guias:
                num = str(g.get("numero_prestador") or "")
                try:
                    d = datetime.strptime(str(g.get("data_solicitacao"))[:10], "%Y-%m-%d").strftime("%d/%m/%Y")
                    r = consultar_guia(page, num, d)
                    if r is None:
                        saida.append({"job_id": g.get("job_id"), "numero_prestador": num, "situacao": "NAO_ENCONTRADA",
                                      "situacao_texto": None, "numero_operadora": None})
                    else:
                        saida.append({"job_id": g.get("job_id"), "numero_prestador": num, **r})
                    log(f"Guia {num}: {saida[-1]['situacao']} {saida[-1].get('situacao_texto') or ''}")
                except Exception as e:
                    saida.append({"job_id": g.get("job_id"), "numero_prestador": num, "situacao": "ERRO",
                                  "situacao_texto": str(e).splitlines()[0][:200] if str(e) else "erro",
                                  "numero_operadora": None})
        except Exception as e:
            for g in guias:
                if not any(x["job_id"] == g.get("job_id") for x in saida):
                    saida.append({"job_id": g.get("job_id"), "numero_prestador": g.get("numero_prestador"),
                                  "situacao": "ERRO", "situacao_texto": str(e).splitlines()[0][:200] if str(e) else "erro",
                                  "numero_operadora": None})
        finally:
            try:
                if ctx:
                    ctx.close()
            except Exception:
                pass
    resultado({"resultados": saida})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input")
    ap.add_argument("--verificar")
    args = ap.parse_args()
    if args.verificar:
        modo_verificar(args.verificar)
        return
    if not args.input:
        ap.error("use --input pedido.json ou --verificar lista.json")
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
                etapa = "autorizar"
                recibo = autorizar_sozinho(page, ctx, p, problemas)
                etapa = "leitura_recibo"
                dados = ler_recibo(recibo, p)
                comprovante = print_tela(recibo, p, "comprovante")
                dados["numero_operadora"] = dados.get("numero_operadora_recibo")
                dados["situacao_texto"] = None
                # A chave da checagem de 4 em 4 horas e o No Guia Prestador.
                if dados.get("numero_prestador"):
                    dados["numero"] = dados["numero_prestador"]
                if dados["numero"]:
                    # A Pesquisa de Guias e a fonte da situacao e do No Guia Operadora.
                    try:
                        r = consultar_guia(recibo, dados["numero"], datetime.now().strftime("%d/%m/%Y"))
                        if r:
                            dados["situacao"] = r["situacao"]
                            dados["numero_operadora"] = r["numero_operadora"]
                            dados["situacao_texto"] = r["situacao_texto"]
                            log(f"Pesquisa de Guias: {r['situacao_texto']} | operadora {r['numero_operadora']}")
                    except Exception as e:
                        log(f"Nao consegui consultar a guia na Pesquisa de Guias: {e}")
                try:
                    Path(comprovante).with_suffix(".html").write_text(recibo.content(), encoding="utf-8")
                except Exception:
                    pass
                campos = [("numero da guia", dados["numero"])]
                if dados["situacao"] == "APROVADO":
                    campos += [("data de autorizacao", dados["data_autorizacao"]), ("validade", dados["data_validade"])]
                faltou = [n for n, v in campos if not v]
                obs = ("Guia autorizada pelo robo, mas ele nao leu na tela: " + ", ".join(faltou) +
                       ". Confira no comprovante anexado.") if faltou else None
                log(f"Autorizada: guia {dados['numero']} | aut {dados['data_autorizacao']} | "
                    f"validade {dados['data_validade']} | qtd {dados['quantidade_autorizada']}")
                resultado({
                    "sucesso": True,
                    "numero_guia": dados["numero"],
                    "numero_operadora": dados["numero_operadora"],
                    "senha_autorizacao": dados["senha"],
                    "situacao": dados["situacao"],
                    "observacao": obs,
                    "quantidade_solicitada": p["quantidade"],
                    "quantidade_autorizada": dados["quantidade_autorizada"],
                    "data_autorizacao": dados["data_autorizacao"],
                    "data_validade": dados["data_validade"],
                    "screenshot_comprovante_path": comprovante,
                    "duracao_ms": int((time.time() - inicio) * 1000),
                })
            except ErroRobo:
                raise
            except Exception as e:
                if etapa == "leitura_recibo":
                    # Autorizar ja foi clicado: a guia existe. Sucesso com recado, nunca falha.
                    resultado({"sucesso": True, "numero_guia": None, "situacao": "APROVADO",
                               "observacao": "Guia autorizada pelo robo, mas ele nao conseguiu ler o recibo. "
                                             "Confira no portal e preencha numero e datas.",
                               "quantidade_solicitada": p["quantidade"], "quantidade_autorizada": None,
                               "screenshot_comprovante_path": None,
                               "duracao_ms": int((time.time() - inicio) * 1000)})
                    return
                shot = print_tela(page, p, "erro") if not page.is_closed() else None
                msg = str(e).splitlines()[0][:400] if str(e) else e.__class__.__name__
                erro = ErroRobo("ERRO_" + etapa.upper(), f"Falhou na etapa '{etapa}': {msg}")
                erro.shot = shot
                raise erro
            finally:
                try:
                    ctx.close()
                except Exception:
                    pass
    except ErroRobo as e:
        shot = getattr(e, "shot", None)
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
