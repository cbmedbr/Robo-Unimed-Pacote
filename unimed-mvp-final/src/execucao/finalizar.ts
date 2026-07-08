import { Page, BrowserContext } from "playwright";
import path from "path";
import { logger } from "../utils/logger";
import { RoboError } from "./tipos";

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

  // Verificar se alguma página intermediária precisa de ação
  // (finalizar_msg.do pode ter botão de confirmação)
  for (const p of todasPaginas) {
    if (p.isClosed()) continue;
    const url = p.url();

    // Página intermediária finalizar_msg.do
    if (url.includes("finalizar_msg")) {
      logger.info({ url }, "página intermediária finalizar_msg detectada");

      // Tenta clicar em qualquer botão de confirmação
      const botoesConfirmar = [
        'input[type="submit"]',
        'input[type="button"]',
        'button:has-text("OK")',
        'button:has-text("Confirmar")',
        'button:has-text("Sim")',
        'a:has-text("OK")',
        'a:has-text("Confirmar")',
        'a:has-text("Sim")',
        'input[value="OK"]',
        'input[value="Confirmar"]',
        'input[value="Sim"]',
      ];

      for (const sel of botoesConfirmar) {
        try {
          const btn = p.locator(sel).first();
          if (await btn.isVisible({ timeout: 1000 })) {
            logger.info({ seletor: sel }, "clicando botão na página intermediária");
            await btn.click();
            await p.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
            break;
          }
        } catch {}
      }

      // Screenshot após clicar
      try {
        const debugPath = path.join(screenshotDir, `debug-apos-intermediaria-${Date.now()}.png`);
        await p.screenshot({ path: debugPath, fullPage: true });
        logger.info({ path: debugPath }, "screenshot após página intermediária");
      } catch {}
    }
  }

  // Aguardar mais um pouco e verificar se chegou na tela de sucesso
  await new Promise((r) => setTimeout(r, 2000));

  // Verificar tela de sucesso em qualquer página
  let paginaSucesso: Page | null = null;
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    const url = p.url();
    const temSucesso = url.includes("sucesso") ||
      await p.locator('text=/Operação realizada com sucesso/i').first().isVisible({ timeout: 2000 }).catch(() => false);

    if (temSucesso) {
      paginaSucesso = p;
      logger.info({ url }, "tela de sucesso encontrada!");
      break;
    }
  }

  if (paginaSucesso) {
    logger.info("execução finalizada com sucesso no portal");
  } else {
    logger.warn("tela de sucesso NÃO encontrada — verificar se a execução foi gravada");
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
