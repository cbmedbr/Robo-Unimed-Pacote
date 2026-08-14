import { Page } from "playwright";
import { logger } from "../utils/logger";
import { RoboError } from "./tipos";

/**
 * Garante "03 - Outras Terapias" no campo obrigatório *Tipo de atendimento*.
 *
 * Para paciente LOCAL o portal já traz o campo preenchido, mas para paciente de
 * INTERCÂMBIO ele vem como "Selecione" — e o portal recusa a execução da guia
 * com o campo em branco. Por isso o robô sempre garante o valor em vez de
 * confiar no pré-preenchimento.
 *
 * O `id`/`name` do select é procurado em uma lista de candidatos e, se nenhum
 * casar, por qualquer `<select>` que tenha uma opção "Outras Terapias" — o SGU
 * usa nomes diferentes entre as telas de autorização e de execução.
 */
async function selecionarTipoAtendimento(page: Page): Promise<void> {
  const CANDIDATOS = [
    "select#DM_TP_ATEND_SADT",
    'select[name="DM_TP_ATEND_SADT"]',
    "select#DM_TIPO_ATENDIMENTO",
    'select[name="DM_TIPO_ATENDIMENTO"]',
  ];

  let seletor: string | null = null;
  for (const candidato of CANDIDATOS) {
    if ((await page.locator(candidato).count()) > 0) {
      seletor = candidato;
      break;
    }
  }

  if (!seletor) {
    const identificador = await page.evaluate(() => {
      for (const sel of Array.from(document.querySelectorAll("select"))) {
        const temOpcao = Array.from(sel.options).some((o) => /outras\s+terapias/i.test(o.text));
        if (temOpcao) return sel.id || sel.name || null;
      }
      return null;
    });
    if (identificador) {
      seletor = `select#${identificador}, select[name="${identificador}"]`;
      logger.info({ identificador }, "campo Tipo de atendimento localizado por fallback");
    }
  }

  if (!seletor) {
    throw new RoboError(
      "TIPO_ATENDIMENTO_NAO_ENCONTRADO",
      "Campo obrigatório 'Tipo de atendimento' não encontrado na tela de execução"
    );
  }

  const campo = page.locator(seletor).first();
  const valorAtual = await campo.inputValue().catch(() => "");

  // Descobre o value real da opção "Outras Terapias" (normalmente "03")
  const valorAlvo = await campo.evaluate((el) => {
    const sel = el as HTMLSelectElement;
    const opcao = Array.from(sel.options).find(
      (o) => /outras\s+terapias/i.test(o.text) || o.value === "03"
    );
    return opcao ? opcao.value : null;
  });

  if (!valorAlvo) {
    throw new RoboError(
      "TIPO_ATENDIMENTO_SEM_OPCAO",
      "Opção 'Outras Terapias' não existe no campo Tipo de atendimento desta guia"
    );
  }

  if (valorAtual === valorAlvo) {
    logger.info({ valorAtual }, "tipo de atendimento já está em 'Outras Terapias'");
    return;
  }

  logger.info({ seletor, valorAtual, valorAlvo }, "selecionando tipo de atendimento: 03 - Outras Terapias");
  await campo.selectOption({ value: valorAlvo });
  await new Promise((r) => setTimeout(r, 500));

  const valorFinal = await campo.inputValue().catch(() => "");
  if (valorFinal !== valorAlvo) {
    throw new RoboError(
      "TIPO_ATENDIMENTO_NAO_PREENCHIDO",
      `Não foi possível selecionar 'Outras Terapias' no Tipo de atendimento (valor após seleção: "${valorFinal}")`
    );
  }

  logger.info({ valorFinal }, "tipo de atendimento preenchido");
}

/**
 * Etapas 4-5: Seleciona Tipo de atendimento e Regime de Atendimento e valida
 * sessões disponíveis.
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

  // Tipo de atendimento: 03 - Outras Terapias.
  // Vem ANTES do regime porque o portal recarrega parte do formulário ao mudar
  // este campo, o que limparia o regime se ele fosse selecionado primeiro.
  await selecionarTipoAtendimento(page);

  // Selecionar Regime de Atendimento: 01 - Ambulatorial
  logger.info("selecionando regime de atendimento: 01 - Ambulatorial");
  await page.selectOption("select#DM_REGIME_ATEND", { label: "01 - Ambulatorial" });

  // Verificar outros campos estão em seus valores padrão
  // Indicação de acidente: 9 - Não acidente (pré-preenchido)
  // Caráter: 1 - Eletivo (pré-preenchido)

  logger.info("execução preparada — tipo de atendimento e regime selecionados");

  return { qtSolicitadas, qtAutorizadas };
}
