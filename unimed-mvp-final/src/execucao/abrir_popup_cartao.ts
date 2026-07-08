import { Page, BrowserContext } from "playwright";
import { logger } from "../utils/logger";
import { RoboError } from "./tipos";

/**
 * Etapa 6: Clica "Adicionar Execução Cartão" e captura o popup.
 *
 * O SGU pode usar seletores diferentes dependendo do tipo de guia
 * (local vs intercâmbio). Tenta múltiplos seletores em ordem.
 */
export async function abrirPopupCartao(
  page: Page,
  context: BrowserContext,
  timeout: number
): Promise<Page> {
  logger.info({ url: page.url() }, "clicando 'Adicionar Execução Cartão'");

  // Salva dump HTML + screenshot para diagnóstico
  try {
    const fs = await import("fs");
    const pathMod = await import("path");
    const html = await page.content();
    const dumpPath = pathMod.resolve("./dump-execucao-cartao.html");
    fs.writeFileSync(dumpPath, html, "utf-8");
    const screenshotPath = pathMod.resolve("./dump-execucao-cartao.png");
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    logger.info({ dumpPath, screenshotPath, htmlLen: html.length }, "dump da tela de execução salvo");
  } catch (dumpErr) {
    logger.warn({ err: (dumpErr as Error).message }, "falha ao salvar dump");
  }

  // Detectar bloqueios do SGU antes de tentar clicar
  const textoBody = await page.textContent("body").catch(() => "") || "";

  if (textoBody.includes("Não há itens disponíveis para execução")) {
    logger.error("SGU bloqueou: 'Não há itens disponíveis para execução'");
    throw new RoboError(
      "SEM_ITENS_EXECUCAO",
      "Portal Unimed bloqueou: 'Não há itens disponíveis para execução'. Possíveis causas: guia de intercâmbio sem liberação do prestador local, profissional executante sem credenciamento, ou todas as sessões já executadas."
    );
  }

  if (textoBody.includes("não possui itens liberados para execução")) {
    logger.error("SGU bloqueou: 'Contratado executante não possui itens liberados para execução'");
    throw new RoboError(
      "SEM_ITENS_EXECUCAO",
      "Portal Unimed bloqueou: 'Contratado executante não possui itens liberados para execução'. A Unimed origem pode não ter liberado a execução para o prestador local (intercâmbio)."
    );
  }

  // Seletores possíveis para o botão de execução por cartão
  const seletores = [
    "a#adicionar_execucao_carteirinha",
    "a[id*='adicionar_execucao']",
    "a:has-text('Adicionar Execução')",
    "a:has-text('Execução Cartão')",
    "a:has-text('Execução Carteirinha')",
    "input[value*='Adicionar Execução']",
    "button:has-text('Adicionar Execução')",
    "a:has-text('Executar')",
  ];

  // Encontrar qual seletor está visível
  let seletorEncontrado: string | null = null;
  for (const sel of seletores) {
    const visivel = await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (visivel) {
      seletorEncontrado = sel;
      logger.info({ seletor: sel }, "botão de execução encontrado");
      break;
    }
  }

  if (!seletorEncontrado) {
    // Dump dos links visíveis para diagnóstico
    const links = await page.locator("a:visible").allTextContents().catch(() => []);
    const botoes = await page.locator("input[type='button']:visible, button:visible").allTextContents().catch(() => []);
    logger.error({ links: links.slice(0, 20), botoes: botoes.slice(0, 10) }, "nenhum botão de execução encontrado — links e botões visíveis");
    throw new RoboError(
      "POPUP_NAO_ABRIU",
      "Botão 'Adicionar Execução Cartão' não encontrado na página. Veja dump-execucao-cartao.html e .png para diagnóstico. Seletores tentados: " + seletores.join(", ")
    );
  }

  let popup: Page;
  try {
    const [popupPage] = await Promise.all([
      context.waitForEvent("page", { timeout }),
      page.click(seletorEncontrado),
    ]);
    popup = popupPage;
  } catch {
    // O popup pode não abrir como nova janela — verificar se abriu como modal na mesma página
    // ou se a página navegou
    const paginasAbertas = context.pages().filter(p => !p.isClosed());
    logger.warn(
      { totalPaginas: paginasAbertas.length, urls: paginasAbertas.map(p => p.url()) },
      "popup não abriu como nova janela — verificando páginas existentes"
    );

    // Se tem mais de uma página, a última pode ser o popup
    if (paginasAbertas.length > 1) {
      popup = paginasAbertas[paginasAbertas.length - 1];
      logger.info({ url: popup.url() }, "usando última página aberta como popup");
    } else {
      throw new RoboError(
        "POPUP_NAO_ABRIU",
        "Click em 'Adicionar Execução Cartão' não abriu popup em " + timeout + "ms"
      );
    }
  }

  await popup.waitForLoadState("domcontentloaded");
  logger.info({ url: popup.url() }, "popup do cartão aberto");

  return popup;
}
