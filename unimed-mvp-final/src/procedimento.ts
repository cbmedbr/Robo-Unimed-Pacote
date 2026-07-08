import { Page } from "playwright";
import { InputAutorizacao, Config } from "./types";
import { logger } from "./utils/logger";

/**
 * Preenche a linha de procedimento na tabela "Procedimentos e Itens Assistenciais Solicitados".
 *
 * Após preencher código e quantidade, clica em "Atualizar" para validar.
 * Após atualizar, descrição preenche automaticamente.
 */
export async function preencherProcedimento(
  page: Page,
  input: InputAutorizacao,
  config: Config
): Promise<void> {
  logger.info(
    {
      codigo: input.procedimento.codigo,
      quantidade: input.procedimento.quantidade_solicitada,
    },
    "preenchendo procedimento"
  );

  // Campos reais identificados no HTML:
  // - CD_ITEM_1: código do procedimento (input pequeno)
  // - DS_ITEM_1: descrição (preenche automaticamente após código + Tab)
  // - NR_QTD_1: quantidade solicitada
  // - DS_COMPLEMENTO_1: complemento opcional

  // Preenche código — usa pressSequentially para simular digitação real
  // (fill() pode não disparar os eventos JS do SGU corretamente)
  const campoCodigoProcedimento = page.locator('#CD_ITEM_1');
  await campoCodigoProcedimento.click({ timeout: config.clickTimeout });
  await campoCodigoProcedimento.fill("");
  await campoCodigoProcedimento.pressSequentially(input.procedimento.codigo, { delay: 50 });
  logger.info({ valor: input.procedimento.codigo }, "código digitado no campo");

  // Aguarda brevemente antes do Tab — o SGU pode estar processando
  await page.waitForTimeout(500);

  // Tab dispara busca assíncrona do procedimento no SGU — timeout maior
  // O SGU pode abrir dialog de confirmação — aceitar automaticamente
  page.once("dialog", (dialog) => {
    logger.info({ message: dialog.message() }, "dialog do SGU detectado ao tabular procedimento");
    dialog.accept().catch(() => {});
  });

  try {
    await campoCodigoProcedimento.press("Tab", { timeout: 20000 });
  } catch (tabErr) {
    // Se Tab falhou, tenta clicar fora do campo como alternativa
    logger.warn({ err: (tabErr as Error).message }, "Tab falhou, tentando click fora do campo");
    await page.locator('#NR_QTD_1').click({ timeout: 5000 }).catch(() => {});
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  // Aguarda o SGU processar a busca do procedimento
  await page.waitForTimeout(1000);

  // Preenche quantidade
  await page.locator('#NR_QTD_1').click({ timeout: config.clickTimeout });
  await page.locator('#NR_QTD_1').fill(String(input.procedimento.quantidade_solicitada));

  // Clica "Atualizar" (botão à direita da tabela) — id="BtnAtualizar"
  logger.info("clicando Atualizar para validar linha de procedimento");
  await page
    .locator('#BtnAtualizar')
    .click({ timeout: config.clickTimeout });

  await page.waitForLoadState("networkidle").catch(() => {});

  // Verifica se descrição foi preenchida automaticamente (sinaliza que código foi aceito)
  const descricaoPorCodigo: Record<string, string> = {
    "50000470": "SESSAO DE PSICOTERAPIA",
    "2250005103": "TERAPIA ABA",
    "2250005278": "PSICOPEDAGOGIA",
    "2250005367": "AVALIACAO NEUROPSICOLOGICA",
  };
  const descricaoEsperada =
    descricaoPorCodigo[input.procedimento.codigo] ?? "";

  try {
    await page.waitForSelector(`text=${descricaoEsperada}`, {
      timeout: config.clickTimeout,
    });
    logger.info({ descricaoEsperada }, "procedimento validado");
  } catch {
    logger.warn(
      { descricaoEsperada },
      "descrição esperada não apareceu — pode ter falhado ou portal usa texto diferente"
    );
  }

  // Mensagem de duplicidade (faixa amarela) é apenas warning, não erro
  const temDuplicidade = await page
    .locator('text=foi solicitado pela última vez')
    .isVisible()
    .catch(() => false);

  if (temDuplicidade) {
    logger.warn("portal exibiu aviso de duplicidade do procedimento — continuando");
  }
}
