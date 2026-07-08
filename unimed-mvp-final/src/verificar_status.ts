// src/verificar_status.ts
//
// Verifica o status atual de uma guia já gerada no portal Unimed.
// Usado pelo cron do servidor local pra acompanhar guias que ficaram
// "Em estudo" / "Em análise" até virarem autorizadas (ou negadas).
//
// Fluxo:
//   1. Login no portal (reusa fazerLogin)
//   2. Navega pra /exames/emaberto/lista.do (ou .../finalizadas se não achar)
//   3. Filtra por número da guia (se houver filtro); senão, varre a lista
//   4. Lê a coluna Situação e captura senha de autorização atualizada
//   5. Retorna estado atual
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
// Verifica UMA guia
// ============================================================================

export async function verificarStatusGuia(
  numeroGuia: string,
  config: Config
): Promise<ResultadoVerificacao> {
  const inicio = Date.now();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({
      headless: config.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext();
    const page = await context.newPage();

    // 1. Login
    await fazerLogin(page, config);

    // 2. Verifica
    return await verificarNaPagina(page, numeroGuia, config, inicio);
  } catch (err) {
    const mensagem = (err as Error).message;
    logger.error({ numeroGuia, mensagem }, "erro ao verificar status");
    return {
      numero_guia: numeroGuia,
      situacao: "ERRO",
      senha_autorizacao: null,
      motivo: `Erro técnico: ${mensagem}`,
      verificado_em: new Date().toISOString(),
      duracao_ms: Date.now() - inicio,
    };
  } finally {
    try {
      await context?.close();
      await browser?.close();
    } catch {
      // ignora
    }
  }
}

// ============================================================================
// Verifica VÁRIAS guias na mesma sessão (mais eficiente: 1 login só)
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
        const r = await verificarNaPagina(page, guia, config, inicio);
        resultados.push(r);
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
// Função core: navega e lê o status
// ============================================================================

async function verificarNaPagina(
  page: Page,
  numeroGuia: string,
  config: Config,
  inicio: number
): Promise<ResultadoVerificacao> {
  logger.info({ numeroGuia }, "verificando status da guia");

  // 1. Navega pra "Exames em aberto"
  // O dynaHash da URL muda a cada sessão, então vou clicar no menu por texto.
  await navegarParaExamesEmAberto(page, config);

  // 2. Procura a guia. Estratégias em ordem:
  //    A. Tem filtro/busca por número → usa
  //    B. Varre a tabela atual (e próximas páginas se houver)
  //    C. Se não achar em "em aberto", tenta "finalizadas" (já autorizadas)

  let situacaoTexto = await tentarAcharGuiaNaPagina(page, numeroGuia, config);

  if (!situacaoTexto) {
    // Tenta "finalizadas" — guia pode já ter sido autorizada
    logger.info({ numeroGuia }, "não achei em 'em aberto', tentando 'finalizadas'");
    await navegarParaExamesFinalizados(page, config);
    situacaoTexto = await tentarAcharGuiaNaPagina(page, numeroGuia, config);
  }

  if (!situacaoTexto) {
    return {
      numero_guia: numeroGuia,
      situacao: "NAO_ENCONTRADA",
      senha_autorizacao: null,
      motivo: "Guia não encontrada nas listas de em aberto ou finalizadas",
      verificado_em: new Date().toISOString(),
      duracao_ms: Date.now() - inicio,
    };
  }

  // 3. Interpreta o texto da situação
  const { situacao, senha_autorizacao, motivo } = interpretarSituacao(
    situacaoTexto.textoSituacao,
    situacaoTexto.htmlLinha
  );

  return {
    numero_guia: numeroGuia,
    situacao,
    senha_autorizacao,
    motivo,
    verificado_em: new Date().toISOString(),
    duracao_ms: Date.now() - inicio,
  };
}

// ============================================================================
// Navegação
// ============================================================================

async function navegarParaExamesEmAberto(page: Page, config: Config): Promise<void> {
  // O menu lateral tem link tipo: loadFirstMenu('3', '/cmagnet/./exames/emaberto/lista.do?...')
  // O CD_MENU=3 é "Exames em aberto" (confirmado no dump da tela final).
  // Estratégia: clicar no link com texto "Em aberto" dentro da seção "SP/SADT".

  // Estratégia 1: link direto pela URL parcial (mais robusto que clicar em texto)
  try {
    const baseUrl = new URL(config.unimedUrl).origin;
    const url = `${baseUrl}/cmagnet/exames/emaberto/lista.do?z=0&CD_MENU=3`;
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: config.navegacaoTimeout,
    });
    logger.debug({ url }, "navegou direto pra exames em aberto");
    return;
  } catch (err) {
    logger.warn({ erro: (err as Error).message }, "navegação direta falhou, tentando via menu");
  }

  // Estratégia 2: clicar no menu lateral
  try {
    // Tenta link/botão com texto "Em aberto" próximo de "SP/SADT" ou "Exame"
    const linkExames = page
      .locator("a")
      .filter({ hasText: /Em aberto/i })
      .first();
    await linkExames.click({ timeout: config.navegacaoTimeout });
    await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout });
  } catch (err) {
    throw new Error(`Não consegui navegar pra "Exames em aberto": ${(err as Error).message}`);
  }
}

async function navegarParaExamesFinalizados(page: Page, config: Config): Promise<void> {
  try {
    const baseUrl = new URL(config.unimedUrl).origin;
    const url = `${baseUrl}/cmagnet/exames/sadt/finalizadas.do?z=0&CD_MENU=21`;
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: config.navegacaoTimeout,
    });
    return;
  } catch (err) {
    logger.warn({ erro: (err as Error).message }, "navegação direta finalizadas falhou");
  }

  try {
    const linkFin = page
      .locator("a")
      .filter({ hasText: /Finalizadas/i })
      .first();
    await linkFin.click({ timeout: config.navegacaoTimeout });
    await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout });
  } catch {
    // Se não achar, segue — a função chamadora vai lidar
  }
}

// ============================================================================
// Busca pela guia na página
// ============================================================================

interface AchadoGuia {
  textoSituacao: string;
  htmlLinha: string;
}

async function tentarAcharGuiaNaPagina(
  page: Page,
  numeroGuia: string,
  config: Config
): Promise<AchadoGuia | null> {
  // Estratégia A: usar campo de filtro por número de guia, se houver
  const filtroUsado = await tentarUsarFiltroNumeroGuia(page, numeroGuia, config);
  if (filtroUsado) {
    // Filtrou — vê o que sobrou na tabela
    await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});
  }

  // Estratégia B: varrer a tabela paginando até achar ou esgotar
  const maxPaginas = filtroUsado ? 1 : 20; // se filtrou, só 1 página esperada
  for (let i = 0; i < maxPaginas; i++) {
    const achado = await buscarGuiaNaTabela(page, numeroGuia);
    if (achado) return achado;

    // Tenta paginar
    const temProxima = await irParaProximaPagina(page, config);
    if (!temProxima) break;
  }

  return null;
}

async function tentarUsarFiltroNumeroGuia(
  page: Page,
  numeroGuia: string,
  config: Config
): Promise<boolean> {
  // O portal Unimed costuma ter campo de filtro "Nº Guia" que aparece ao clicar no botão "Filtrar".
  // Não tenho garantia 100% do seletor — tento alguns.
  const seletoresPossiveis = [
    'input[name="nr_guia"]',
    'input[name="nrGuia"]',
    'input[name="NR_GUIA"]',
    'input[id="nr_guia"]',
    'input[id="NR_GUIA"]',
  ];

  // Antes, talvez precisar clicar num botão "Filtrar" pra expandir o painel
  try {
    const btnFiltrar = page.locator("button, input[type=button], a").filter({
      hasText: /^Filtrar$/i,
    }).first();
    if (await btnFiltrar.isVisible({ timeout: 1500 })) {
      await btnFiltrar.click();
      await page.waitForTimeout(500);
    }
  } catch {
    // Painel pode já estar aberto, ou não existir
  }

  for (const sel of seletoresPossiveis) {
    try {
      const campo = page.locator(sel).first();
      if (await campo.isVisible({ timeout: 1500 })) {
        await campo.fill(numeroGuia);
        // Tenta clicar em botão de buscar/filtrar
        const btnBuscar = page
          .locator("button, input[type=button], input[type=submit]")
          .filter({ hasText: /Filtrar|Buscar|Pesquisar/i })
          .first();
        if (await btnBuscar.isVisible({ timeout: 1500 })) {
          await btnBuscar.click();
        } else {
          // Sem botão visível → Enter no próprio campo
          await campo.press("Enter");
        }
        logger.debug({ seletor: sel }, "filtro por número de guia aplicado");
        return true;
      }
    } catch {
      // Tenta próximo seletor
    }
  }

  return false;
}

async function buscarGuiaNaTabela(
  page: Page,
  numeroGuia: string
): Promise<AchadoGuia | null> {
  // Procura na tabela uma linha que contenha o número da guia.
  // No HTML do portal a tabela tem:
  //   <td><a id="linkNrGuia">NUMERO</a></td>
  //   <td>(Situação com <span>texto</span>)</td>
  //   ...

  const html = await page.content();

  // Regex que captura a linha completa contendo o número da guia.
  // tr...td com numero...td...situação até fechar </tr>
  const re = new RegExp(
    `<tr[^>]*>(?:[\\s\\S](?!</tr>))*?${numeroGuia}(?:[\\s\\S](?!</tr>))*?</tr>`,
    "i"
  );
  const match = html.match(re);
  if (!match) return null;

  const htmlLinha = match[0];

  // Dentro da linha, procura o <span> da coluna situação.
  // Coluna 2 (depois do número da guia) tem o span de texto.
  const matchSpan = htmlLinha.match(/<span[^>]*>\s*([^<]+?)\s*<\/span>/i);
  const textoSituacao = matchSpan ? matchSpan[1].trim() : "";

  return { textoSituacao, htmlLinha };
}

async function irParaProximaPagina(page: Page, config: Config): Promise<boolean> {
  // Procura link/botão "Próxima"
  try {
    const linkProxima = page
      .locator("a, button")
      .filter({ hasText: /^Pr[óo]xima$/i })
      .first();
    if (await linkProxima.isVisible({ timeout: 1500 })) {
      await linkProxima.click();
      await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout });
      await page.waitForTimeout(300);
      return true;
    }
  } catch {
    // Sem próxima página
  }
  return false;
}

// ============================================================================
// Interpretação do texto
// ============================================================================

function interpretarSituacao(
  textoSituacao: string,
  htmlLinha: string
): { situacao: SituacaoVerificada; senha_autorizacao: string | null; motivo: string | null } {
  const txt = textoSituacao.toLowerCase();

  // Captura senha de autorização da linha, se aparecer
  // Padrão: célula com 6-8 dígitos. Geralmente coluna "Senha".
  const matchSenha = htmlLinha.match(/<td[^>]*>\s*(\d{6,8})\s*&nbsp;\s*<\/td>/);
  const senha = matchSenha ? matchSenha[1] : null;

  if (/em execu[çc][ãa]o|autorizad[ao]|liberad[ao]/i.test(txt)) {
    return { situacao: "APROVADO", senha_autorizacao: senha, motivo: null };
  }

  if (/em estudo|em an[áa]lise|aguardando/i.test(txt)) {
    return { situacao: "EM_ANALISE", senha_autorizacao: senha, motivo: null };
  }

  if (/negad[ao]|recusad[ao]|n[ãa]o autorizad[ao]|cancelad[ao]/i.test(txt)) {
    return {
      situacao: "NEGADA",
      senha_autorizacao: null,
      motivo: textoSituacao,
    };
  }

  // Texto desconhecido — registra como em análise por segurança
  return {
    situacao: "EM_ANALISE",
    senha_autorizacao: senha,
    motivo: `Situação não interpretada: "${textoSituacao}"`,
  };
}
