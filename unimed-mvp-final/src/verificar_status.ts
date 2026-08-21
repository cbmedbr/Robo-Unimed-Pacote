// src/verificar_status.ts
//
// Verifica o status atual de uma guia já gerada no portal Unimed.
// Usado pelo cron do servidor local pra acompanhar guias que ficaram
// "Em estudo" até virarem autorizadas (ou negadas).
//
// TELA USADA: Utilitários > Consulta Solicitações
//   /cmagnet/utilitarios/consulta_guias/index.do
//
// É a ÚNICA tela que enxerga os três estados. Confirmado em 21/08/2026 contra
// guias reais de cada tipo:
//   50142824072 → "Executado"   (autorizada e já executada)
//   50143762989 → "Em estudo"   (ainda em análise)
//   50143768031 → "Negado"      (recusada)
//
// "Exames em aberto" e "Exames finalizados" NÃO servem: só listam guias já
// autorizadas e não têm coluna de situação.
//
// NAVEGAÇÃO: nunca montar a URL na mão. O portal exige o `dynaHash` da sessão
// e, sem ele, responde a tela de login com HTTP 200 — sem lançar erro, o que
// fazia a versão anterior achar que tinha navegado e ler uma página vazia.
// O href do link do menu já vem com o hash correto; é dele que partimos.
//
// IMPORTANTE: assume Chrome HEADLESS por padrão (rodar invisível).

import { Browser, BrowserContext, Page, chromium } from "playwright";
import { logger } from "./utils/logger";
import { fazerLogin } from "./login";
import { Config } from "./types";

export type SituacaoVerificada =
  | "APROVADO"
  | "EM_ANALISE"
  | "NEGADA"
  | "NAO_ENCONTRADA"
  | "ERRO";

export interface ResultadoVerificacao {
  numero_guia: string;
  situacao: SituacaoVerificada;
  senha_autorizacao: string | null;
  motivo: string | null;
  verificado_em: string;
  duracao_ms: number;
}

// ============================================================================
// Verifica UMA guia (mantido para uso avulso)
// ============================================================================

export async function verificarStatusGuia(
  numeroGuia: string,
  config: Config
): Promise<ResultadoVerificacao> {
  const [r] = await verificarStatusEmLote([numeroGuia], config);
  return r;
}

// ============================================================================
// Verifica VÁRIAS guias na mesma sessão (1 login só)
// ============================================================================

export async function verificarStatusEmLote(
  numerosGuia: string[],
  config: Config
): Promise<ResultadoVerificacao[]> {
  if (numerosGuia.length === 0) return [];

  const resultados: ResultadoVerificacao[] = [];
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({
      headless: config.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext();
    const page = await context.newPage();

    await fazerLogin(page, config);

    for (const guia of numerosGuia) {
      const inicio = Date.now();
      try {
        resultados.push(await verificarNaPagina(page, guia, config, inicio));
      } catch (err) {
        resultados.push({
          numero_guia: guia,
          situacao: "ERRO",
          senha_autorizacao: null,
          motivo: `Erro: ${(err as Error).message}`,
          verificado_em: new Date().toISOString(),
          duracao_ms: Date.now() - inicio,
        });
      }
    }
  } catch (err) {
    // Falhou antes ou durante o login: marca o que sobrou como ERRO em vez de
    // devolver lista curta (o chamador casa resultado por número de guia).
    const jaFeitas = new Set(resultados.map((r) => r.numero_guia));
    for (const guia of numerosGuia.filter((g) => !jaFeitas.has(g))) {
      resultados.push({
        numero_guia: guia,
        situacao: "ERRO",
        senha_autorizacao: null,
        motivo: `Erro de sessão: ${(err as Error).message}`,
        verificado_em: new Date().toISOString(),
        duracao_ms: 0,
      });
    }
  } finally {
    try {
      await context?.close();
      await browser?.close();
    } catch {
      // ignora
    }
  }

  return resultados;
}

// ============================================================================
// Core
// ============================================================================

async function verificarNaPagina(
  page: Page,
  numeroGuia: string,
  config: Config,
  inicio: number
): Promise<ResultadoVerificacao> {
  logger.info({ numeroGuia }, "verificando status da guia");

  await abrirConsultaSolicitacoes(page, config);
  const linha = await filtrarELerLinha(page, numeroGuia, config);

  if (!linha) {
    return {
      numero_guia: numeroGuia,
      situacao: "NAO_ENCONTRADA",
      senha_autorizacao: null,
      motivo: "Guia não retornou resultado em Consulta Solicitações",
      verificado_em: new Date().toISOString(),
      duracao_ms: Date.now() - inicio,
    };
  }

  const { situacao, senha_autorizacao, motivo } = interpretarLinha(linha, numeroGuia);

  logger.info({ numeroGuia, situacao, textoPortal: linha[0] }, "status lido");

  return {
    numero_guia: numeroGuia,
    situacao,
    senha_autorizacao,
    motivo,
    verificado_em: new Date().toISOString(),
    duracao_ms: Date.now() - inicio,
  };
}

/**
 * Abre Utilitários > Consulta Solicitações partindo do href do menu, que já
 * carrega o `dynaHash` da sessão. Montar a URL na mão cai na tela de login.
 */
async function abrirConsultaSolicitacoes(page: Page, config: Config): Promise<void> {
  const href = await page
    .locator('a[href*="consulta_guias"]')
    .first()
    .getAttribute("href", { timeout: config.clickTimeout })
    .catch(() => null);

  if (!href) {
    throw new Error("Link de 'Consulta Solicitações' não encontrado no menu");
  }

  const destino = new URL(href.replace("/./", "/"), page.url()).toString();
  await page.goto(destino, { waitUntil: "networkidle", timeout: config.navegacaoTimeout });

  if (page.url().includes("Login.do")) {
    throw new Error("Portal redirecionou para login ao abrir Consulta Solicitações");
  }
}

/**
 * Filtra pelo número da guia e devolve as células da linha encontrada.
 *
 * O campo de filtro se chama `s_nr_guia`. Não usar `html.includes(numero)` para
 * decidir se achou: o número volta ecoado no próprio campo do formulário, então
 * isso dá verdadeiro mesmo com zero resultados.
 */
async function filtrarELerLinha(
  page: Page,
  numeroGuia: string,
  config: Config
): Promise<string[] | null> {
  for (const sel of ['input[name="s_dt_ini"]', 'input[name="s_dt_fim"]']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) await el.fill("");
    } catch {
      // campo pode não existir nesta tela
    }
  }

  const campo = page.locator('input[name="s_nr_guia"]').first();
  if (!(await campo.isVisible({ timeout: config.clickTimeout }).catch(() => false))) {
    throw new Error("Campo de filtro 's_nr_guia' não encontrado na tela");
  }
  await campo.fill(numeroGuia);

  await page
    .locator('input[name="Button_FIltro"], input[value="Filtrar"], button:has-text("Filtrar")')
    .first()
    .click({ timeout: config.clickTimeout });
  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});

  if (page.url().includes("Login.do")) {
    throw new Error("Sessão expirou ao filtrar");
  }

  // Linha de dados = a que tem o número da guia em uma célula própria
  const linhas = await page.locator("tr").evaluateAll((trs, guia) =>
    trs
      .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").replace(/\s+/g, " ").trim()))
      .filter((celulas) => celulas.some((c) => c === guia)),
    numeroGuia
  );

  return linhas.length > 0 ? linhas[0] : null;
}

// ============================================================================
// Interpretação
// ============================================================================

/**
 * Layout confirmado da linha em Consulta Solicitações:
 *   [0] Situação   [1] Data de entrada   [2] Nº Guia   [3] Beneficiário
 *   [4] Origem     [5] Senha             [6] Contratado  [7] Profissional
 */
export function interpretarLinha(
  celulas: string[],
  numeroGuia: string
): { situacao: SituacaoVerificada; senha_autorizacao: string | null; motivo: string | null } {
  const texto = (celulas[0] || "").trim();
  const t = texto.toLowerCase();

  // Senha: célula de 6 a 9 dígitos que não seja o próprio número da guia.
  // "-" significa sem senha (guia não autorizada).
  const senha =
    celulas.find((c) => /^\d{6,9}$/.test(c) && c !== numeroGuia) ?? null;

  if (/executad|autorizad|liberad|em execu[çc][ãa]o/i.test(t)) {
    return { situacao: "APROVADO", senha_autorizacao: senha, motivo: null };
  }

  if (/em estudo|em an[áa]lise|aguardando|pendente/i.test(t)) {
    return { situacao: "EM_ANALISE", senha_autorizacao: senha, motivo: null };
  }

  if (/negad|recusad|n[ãa]o autorizad|cancelad|indeferid/i.test(t)) {
    return { situacao: "NEGADA", senha_autorizacao: null, motivo: texto };
  }

  // Situação desconhecida é ERRO, não "em análise".
  //
  // A versão anterior devolvia EM_ANALISE aqui "por segurança", e isso
  // escondeu por 45 dias o fato de que a verificação estava lendo a tela
  // errada: toda falha de leitura virava "continua em análise", que é
  // exatamente o estado em que a guia já estava.
  return {
    situacao: "ERRO",
    senha_autorizacao: senha,
    motivo: `Situação não reconhecida no portal: "${texto}"`,
  };
}
