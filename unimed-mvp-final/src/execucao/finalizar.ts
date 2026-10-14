import { Page, BrowserContext } from "playwright";
import path from "path";
import { logger } from "../utils/logger";
import { RoboError } from "./tipos";
import { encontrarPaginaConfirmacao, clicarConfirmar } from "./confirmar_finalizacao";

/**
 * Etapas 9-10: Clica "Finalizar Parcial", trata páginas intermediárias,
 * aguarda tela de sucesso e captura comprovante.
 *
 * Após clicar "Finalizar Parcial", o portal pode:
 *   1. Abrir popup/página intermediária (finalizar_msg.do) com confirmação
 *   2. Navegar pra tela de sucesso (sucesso_exe...)
 *   3. Mostrar dialog confirm() de confirmação
 *
 * O robô precisa tratar tudo isso pra chegar na tela "Operação realizada com sucesso!"
 */
export async function finalizarParcial(
  page: Page,
  sessaoId: string,
  screenshotDir: string,
  timeout: number
): Promise<string | null> {
  // Trazer página principal ao foco (popup do QR já fechou)
  await page.bringToFront();

  // Pequena espera pro portal processar o retorno do QR Code
  await new Promise((r) => setTimeout(r, 2000));

  // Screenshot antes de finalizar (diagnóstico)
  try {
    const debugPath = path.join(screenshotDir, `debug-antes-finalizar-${Date.now()}.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    logger.info({ path: debugPath }, "screenshot antes de finalizar");
  } catch {}

  // Registrar handler pra dialogs que possam aparecer
  page.on("dialog", async (dialog) => {
    logger.info({ tipo: dialog.type(), mensagem: dialog.message() }, "dialog após Finalizar Parcial");
    await dialog.accept();
    logger.info("dialog aceito");
  });

  // Clicar "Finalizar Parcial"
  logger.info("clicando 'Finalizar Parcial'");

  // O clique pode abrir popup — capturamos qualquer nova página
  const context = page.context();
  const novasPaginas: Page[] = [];

  const onPage = (p: Page) => {
    logger.info({ url: p.url() }, "nova página aberta após Finalizar Parcial");
    novasPaginas.push(p);
    // Registra handler de dialog na nova página também
    p.on("dialog", async (dialog) => {
      logger.info({ tipo: dialog.type(), mensagem: dialog.message() }, "dialog em página intermediária");
      await dialog.accept();
    });
  };
  context.on("page", onPage);

  await page.click("input#Button_Parcial", { timeout });

  // Aguardar processamento
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  // Diagnóstico: captura screenshots de TODAS as páginas abertas
  const todasPaginas = context.pages();
  for (let i = 0; i < todasPaginas.length; i++) {
    const p = todasPaginas[i];
    if (p.isClosed()) continue;
    try {
      const debugPath = path.join(screenshotDir, `debug-pagina-${i}-${Date.now()}.png`);
      await p.screenshot({ path: debugPath, fullPage: true });
      logger.info({ idx: i, url: p.url(), path: debugPath }, "screenshot de página após finalizar");
    } catch {}
  }

  // Confirmação do envio. Sem este clique nada chega à Unimed: a guia fica
  // em "Exames em aberto" e a sessão não existe para a operadora.
  //
  // A página é procurada por CONTEÚDO, não por endereço — em 14/10/2026 o
  // endereço mudou e o robô parou de confirmar em 100% das execuções.
  const paginaConfirmacao = await encontrarPaginaConfirmacao(context, 15000);
  let confirmou = false;

  if (paginaConfirmacao) {
    await paginaConfirmacao.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    confirmou = await clicarConfirmar(paginaConfirmacao);
    if (confirmou) {
      await paginaConfirmacao.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    }
    try {
      const depois = path.join(screenshotDir, `debug-apos-confirmacao-${Date.now()}.png`);
      await paginaConfirmacao.screenshot({ path: depois, fullPage: true });
      logger.info({ path: depois, confirmou }, "screenshot após a confirmação");
    } catch {}
  } else {
    // Pode ser legítimo: em alguns casos o portal vai direto ao sucesso.
    // Quem decide é a checagem da tela de sucesso, logo abaixo.
    logger.info("nenhuma página de confirmação apareceu após Finalizar Parcial");
  }

  // Aguardar portal processar e verificar tela de sucesso (com retry)
  let paginaSucesso: Page | null = null;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    await new Promise((r) => setTimeout(r, 5000));

    // Também aguarda a página principal recarregar
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      const url = p.url();
      // Tolerante a acento: o portal já apareceu com e sem, e uma diferença
      // de acentuação não pode decidir se a sessão foi gravada ou não.
      const temSucesso = url.includes("sucesso") ||
        await p.locator('text=/opera[çc][ãa]o realizada com sucesso|executad[ao] com sucesso|grava[çc][ãa]o realizada/i')
          .first()
          .isVisible({ timeout: 5000 })
          .catch(() => false);

      if (temSucesso) {
        paginaSucesso = p;
        logger.info({ url, tentativa }, "tela de sucesso encontrada!");
        break;
      }
    }
    if (paginaSucesso) break;
    logger.info({ tentativa }, "tela de sucesso não encontrada, tentando novamente...");
  }

  if (paginaSucesso) {
    logger.info("execução finalizada com sucesso no portal");
  } else {
    // Captura comprovante antes de lançar erro (para diagnóstico)
    const nomeErro = `exec-falha-${sessaoId}-${Date.now()}.png`;
    const caminhoErro = path.join(screenshotDir, nomeErro);
    try {
      await page.screenshot({ path: caminhoErro, fullPage: true });
      logger.info({ path: caminhoErro }, "screenshot de falha capturado");
    } catch {}

    context.removeListener("page", onPage);
    // A mensagem diz se a confirmação chegou a ser clicada. É o que decide se
    // repetir é seguro: sem o clique, nada foi enviado e repetir é seguro;
    // com o clique, repetir pode gravar a sessão duas vezes.
    throw new RoboError(
      "FINALIZACAO_EXECUCAO_FALHOU",
      "Tela de sucesso NÃO encontrada após Finalizar Parcial. " +
        (confirmou
          ? "A confirmação FOI clicada, então a execução pode ter sido gravada — confira no portal ANTES de repetir."
          : paginaConfirmacao
            ? "A página de confirmação apareceu mas não tinha botão Confirmar reconhecível — a execução NÃO foi enviada."
            : "Nenhuma página de confirmação apareceu — a execução NÃO foi enviada.")
    );
  }

  // Remover listener
  context.removeListener("page", onPage);

  // Capturar comprovante (da página de sucesso se existir, senão da principal)
  const paginaComprovante = paginaSucesso || page;
  const nomeArquivo = `exec-${sessaoId}-${Date.now()}.png`;
  const caminhoCompleto = path.join(screenshotDir, nomeArquivo);

  try {
    await paginaComprovante.screenshot({ path: caminhoCompleto, fullPage: true });
    logger.info({ path: caminhoCompleto }, "comprovante capturado");
    return caminhoCompleto;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "falha ao capturar comprovante");
    return null;
  }
}
