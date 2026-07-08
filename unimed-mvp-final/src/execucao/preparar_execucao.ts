import { Page } from "playwright";
import { logger } from "../utils/logger";
import { RoboError } from "./tipos";

/**
 * Etapas 4-5: Seleciona Regime de Atendimento e valida sessões disponíveis.
 */
export async function prepararExecucao(page: Page): Promise<{ qtSolicitadas: number; qtAutorizadas: number }> {
  // Ler sessões disponíveis
  const qtSolicitadasStr = await page.inputValue('input[name="QT_SOLIC_1"]').catch(() => "0");
  const qtAutorizadasStr = await page.inputValue('input[name="QT_AUTORIZADA_1"]').catch(() => "0");

  const qtSolicitadas = parseInt(qtSolicitadasStr) || 0;
  const qtAutorizadas = parseInt(qtAutorizadasStr) || 0;

  logger.info({ qtSolicitadas, qtAutorizadas }, "sessões da guia");

  if (qtAutorizadas === 0) {
    throw new RoboError(
      "SEM_SESSOES_DISPONIVEIS",
      `Guia sem sessões autorizadas (solicitadas: ${qtSolicitadas}, autorizadas: ${qtAutorizadas})`
    );
  }

  // Verificar se há procedimentos extras (_2, _3)
  const temSegundo = await page.locator('input[name="QT_SOLIC_2"]').count();
  if (temSegundo > 0) {
    logger.warn("guia com mais de 1 procedimento — usando apenas o primeiro");
  }

  // Selecionar Regime de Atendimento: 01 - Ambulatorial
  logger.info("selecionando regime de atendimento: 01 - Ambulatorial");
  await page.selectOption("select#DM_REGIME_ATEND", { label: "01 - Ambulatorial" });

  // Verificar outros campos estão em seus valores padrão
  // Tipo de atendimento: 03 - Outras Terapias (pré-preenchido)
  // Indicação de acidente: 9 - Não acidente (pré-preenchido)
  // Caráter: 1 - Eletivo (pré-preenchido)

  logger.info("execução preparada — regime ambulatorial selecionado");

  return { qtSolicitadas, qtAutorizadas };
}
