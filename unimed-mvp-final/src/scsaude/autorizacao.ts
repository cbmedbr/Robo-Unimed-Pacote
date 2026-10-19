import fs from "fs";
import path from "path";
import { Browser, chromium, Page } from "playwright";
import { logger } from "../utils/logger";
import {
  ConfigScSaude,
  ErroScSaude,
  EtapaScSaude,
  InputAutorizacaoScSaude,
  ResultadoScSaude,
} from "./tipos";
import { fazerLoginScSaude } from "./login";
import { abrirFormularioGuia } from "./beneficiario";
import { preencherFormulario } from "./formulario";
import { anexarPedidoMedico } from "./anexo";
import { solicitarEGerarGuia } from "./finalizar";

/**
 * Fluxo completo de autorização no SC Saúde.
 *
 * Espelha o papel de `autorizacao.ts` da Unimed, mas sem compartilhar código
 * com ele: os portais não se parecem, e manter os fluxos separados limita o
 * estrago de uma mudança de tela a um portal só.
 */
export async function executarAutorizacaoScSaude(
  input: InputAutorizacaoScSaude,
  config: ConfigScSaude
): Promise<ResultadoScSaude> {
  const inicio = Date.now();
  let browser: Browser | null = null;
  let page: Page | null = null;
  let etapa: EtapaScSaude = "validacao";

  try {
    validarInput(input);

    etapa = "login";

    browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.debug ? 400 : 0,
    });
    const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await contexto.newPage();
    page.setDefaultTimeout(config.clickTimeout);
    page.setDefaultNavigationTimeout(config.navegacaoTimeout);

    await fazerLoginScSaude(page, config);

    etapa = "beneficiario";
    await abrirFormularioGuia(page, input, config);

    etapa = "formulario";
    await preencherFormulario(page, input, config);

    etapa = "anexo";
    await anexarPedidoMedico(page, input, config);

    etapa = "autorizacao";
    const resultado = await solicitarEGerarGuia(page, config, input.job_id);

    const duracao = Date.now() - inicio;
    logger.info(
      { numero_guia: resultado.numero_guia, situacao: resultado.situacao, duracao_ms: duracao },
      resultado.sucesso ? "autorização SC Saúde concluída" : "autorização SC Saúde não concluída"
    );

    return { ...resultado, duracao_ms: duracao };
  } catch (err) {
    const e = err as Error;
    const codigo = err instanceof ErroScSaude ? err.codigo : "ERRO_DESCONHECIDO";

    logger.error({ etapa, codigo, erro: e.message }, "autorização SC Saúde falhou");

    const print = page ? await salvarPrintDeErro(page, config, input.job_id, etapa) : null;

    return {
      sucesso: false,
      erro_codigo: codigo,
      erro_mensagem: `[${etapa}] ${e.message}`,
      comprovante_path: print,
      duracao_ms: Date.now() - inicio,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * Valida o que o CRM mandou, antes de abrir navegador.
 *
 * Falhar aqui custa segundos e devolve uma mensagem que diz o que corrigir no
 * cadastro. Falhar no meio do portal custa um minuto e devolve um timeout.
 */
function validarInput(input: InputAutorizacaoScSaude): void {
  const faltando: string[] = [];

  if ((input.paciente?.cpf || "").replace(/\D/g, "").length !== 11) {
    faltando.push("CPF do paciente (o portal localiza o beneficiário por CPF)");
  }
  if (!input.paciente?.nome_completo?.trim()) faltando.push("nome do paciente");
  if (!input.medico_solicitante?.nome?.trim()) faltando.push("nome do médico solicitante");
  if (!input.indicacao_clinica?.trim()) faltando.push("indicação clínica (começa pelo CID)");
  if (!input.procedimento?.codigo?.trim()) faltando.push("código do procedimento");
  if (!Number.isInteger(input.procedimento?.quantidade) || input.procedimento.quantidade < 1) {
    faltando.push("quantidade de sessões");
  }
  if (!input.pedido_medico_path?.trim()) faltando.push("pedido médico (arquivo)");

  if (faltando.length) {
    throw new ErroScSaude(
      "VALIDACAO_INPUT",
      `Faltam dados para solicitar no SC Saúde: ${faltando.join("; ")}.`
    );
  }
}

async function salvarPrintDeErro(
  page: Page,
  config: ConfigScSaude,
  jobId: string,
  etapa: EtapaScSaude
): Promise<string | null> {
  const dir = path.join(config.screenshotDir, "comprovantes");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const destino = path.join(dir, `scsaude-falha-${etapa}-${jobId}-${Date.now()}.png`);
    await page.screenshot({ path: destino, fullPage: true });
    logger.info({ destino }, "print da falha salvo");
    return destino;
  } catch {
    return null;
  }
}
