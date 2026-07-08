import { Page } from "playwright";
import path from "path";
import { InputAutorizacao, Config } from "./types";
import { logger } from "./utils/logger";

/**
 * Anexa o PDF do pedido médico à linha de procedimento.
 *
 * Fluxo:
 * 1. Clica no ícone de clipe na coluna "Anexos" da linha de procedimento
 * 2. Modal "Anexar arquivos" abre
 * 3. Usa setInputFiles() do Playwright para injetar o caminho diretamente
 *    no <input type="file"> — sem abrir diálogo do sistema operacional
 * 4. Clica "Anexar"
 * 5. Clica "Finalizar" no modal
 */
export async function anexarPedidoMedico(
  page: Page,
  input: InputAutorizacao,
  config: Config
): Promise<void> {
  const caminhoAbsoluto = path.resolve(input.pedido_medico_path);
  logger.info({ pdfPath: caminhoAbsoluto }, "iniciando anexo do pedido médico");

  // Clica no ícone de clipe (anexo) da linha de procedimento
  // ID real: item_anexos_1 (linha 1 da tabela)
  await page.locator('#item_anexos_1').click({ timeout: config.clickTimeout });

  // Aguarda 1s para popup abrir
  await new Promise((r) => setTimeout(r, 1000));

  // O modal pode abrir em popup separado OU na mesma página.
  // Faz polling em todas as janelas/frames buscando o input[type="file"]
  // ou o texto "Anexar arquivos" / "Anexar" / "Anexos da guia".
  logger.info("buscando modal de anexo em todas as janelas");

  let paginaModal: Page | null = null;
  const inicio = Date.now();

  while (Date.now() - inicio < config.navegacaoTimeout) {
    const todasPaginas = page.context().pages();
    for (const p of todasPaginas) {
      if (p.isClosed()) continue;

      // Aceita janela cuja URL contém "anexo" OU que tem input file visível
      const url = p.url();
      const urlAnexo = url.includes("anexo") || url.includes("upload") || url.includes("attach");

      // Verifica se tem input[type="file"]
      const temFileInput = await p
        .locator('input[type="file"]')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      // Verifica texto comum de modais de anexo
      const temTextoAnexo = await p
        .locator('text=/Anexar arquivos|Anexos da guia|Selecionar arquivo|Escolher arquivo/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if ((urlAnexo && temFileInput) || temTextoAnexo) {
        paginaModal = p;
        logger.info({ url, urlAnexo, temFileInput, temTextoAnexo }, "modal de anexo encontrado");
        break;
      }
    }
    if (paginaModal) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!paginaModal) {
    // === DUMP do estado atual se DUMP_HTML_ANEXO estiver ativo ===
    if (process.env.DUMP_HTML_ANEXO === "true") {
      const fs = await import("fs");
      const pathMod = await import("path");
      const todasPaginas = page.context().pages();
      for (let i = 0; i < todasPaginas.length; i++) {
        const p = todasPaginas[i];
        if (p.isClosed()) continue;
        try {
          const html = await p.content();
          const dumpPath = pathMod.resolve(`./dump-anexo-page${i}.html`);
          fs.writeFileSync(dumpPath, html, "utf-8");
          const screenshotPath = pathMod.resolve(`./dump-anexo-page${i}.png`);
          await p.screenshot({ path: screenshotPath, fullPage: true });
          logger.info({ idx: i, url: p.url(), dumpPath, screenshotPath }, "dump da página salvo");
        } catch (err) {
          logger.warn({ err: (err as Error).message }, "falha ao dumpar página");
        }
      }
    }
    throw new Error("PDF_UPLOAD_FALHOU: modal 'Anexar arquivos' não abriu");
  }

  // Injeta o arquivo no input file
  logger.info("injetando arquivo via setInputFiles");
  const fileInput = paginaModal.locator('input[type="file"]').first();
  await fileInput.setInputFiles(caminhoAbsoluto);
  logger.info("arquivo injetado");

  // Aguarda 500ms para upload processar
  await new Promise((r) => setTimeout(r, 500));

  // Clica Anexar (nem todos os portais têm esse botão; alguns fazem upload automático)
  logger.info("tentando clicar Anexar");
  try {
    await paginaModal
      .locator('button:has-text("Anexar"), input[value="Anexar"]')
      .first()
      .click({ timeout: 5000 });
    logger.info("Anexar clicado");
  } catch {
    logger.debug("botão Anexar não encontrado ou não necessário");
  }

  await paginaModal.waitForLoadState("networkidle").catch(() => {});

  // Verifica que o anexo aparece na lista
  try {
    await paginaModal.waitForSelector('text=/Total de registros:\\s*1|1 anexo|1 arquivo/', {
      timeout: 5000,
    });
    logger.info("anexo confirmado na lista");
  } catch {
    logger.warn("contador de anexo não apareceu — pode ter funcionado mesmo assim");
  }

  // Clica Finalizar no modal (fecha a popup de anexo)
  logger.info("clicando Finalizar no modal de anexo");
  try {
    await paginaModal
      .locator('button:has-text("Finalizar"), input[value="Finalizar"]')
      .first()
      .click({ timeout: 5000 });
  } catch {
    logger.debug("botão Finalizar do modal não encontrado, fechando popup");
    if (paginaModal !== page) {
      await paginaModal.close().catch(() => {});
    }
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  logger.info("anexo concluído");
}
