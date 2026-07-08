import { chromium, Browser, Page } from "playwright";
import { InputAutorizacao, ResultadoAutorizacao, Config, Etapa, ErroCodigo } from "./types";
import { logger } from "./utils/logger";
import { capturarScreenshot } from "./utils/screenshot";
import { fazerLogin } from "./login";
import { abrirFormularioGuia } from "./beneficiario";
import { preencherMedicoSolicitante } from "./medico";
import { preencherProcedimento } from "./procedimento";
import { anexarPedidoMedico } from "./anexo";
import { finalizarGuia } from "./finalizar";

/**
 * Orquestrador do fluxo completo de autorização.
 * Recebe input já validado e retorna ResultadoAutorizacao.
 */
export async function executarAutorizacao(
  input: InputAutorizacao,
  config: Config
): Promise<ResultadoAutorizacao> {
  const inicio = Date.now();
  let browser: Browser | null = null;
  let page: Page | null = null;
  let etapaAtual: Etapa = "login";

  try {
    logger.info("abrindo navegador");
    browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.debug ? 500 : 0,
    });

    const contexto = await browser.newContext({
      acceptDownloads: false,
      viewport: { width: 1366, height: 768 },
    });

    page = await contexto.newPage();

    // Configura timeouts globais
    page.setDefaultTimeout(config.clickTimeout);
    page.setDefaultNavigationTimeout(config.navegacaoTimeout);

    // === LOGIN ===
    etapaAtual = "login";
    await fazerLogin(page, config);

    // === NAVEGAÇÃO + BENEFICIÁRIO ===
    // Retorna a página onde o formulário ficou aberto (pode ser popup ou principal)
    etapaAtual = "beneficiario";
    const pageFormulario = await abrirFormularioGuia(page, input, config);

    // === FORMULÁRIO PRINCIPAL ===
    etapaAtual = "formulario";
    await preencherCamposBasicos(pageFormulario, input, config);

    // === MÉDICO ===
    etapaAtual = "medico";
    await preencherMedicoSolicitante(pageFormulario, input, config);

    // === PROCEDIMENTO ===
    etapaAtual = "procedimento";
    await preencherProcedimento(pageFormulario, input, config);

    // === ANEXO ===
    etapaAtual = "anexo";
    await anexarPedidoMedico(pageFormulario, input, config);

    // === FINALIZAÇÃO ===
    etapaAtual = "finalizacao";
    const {
      numero_guia,
      data_autorizacao,
      screenshot_comprovante_path,
      senha_autorizacao,
      situacao,
    } = await finalizarGuia(pageFormulario, config, input);

    const duracao = Date.now() - inicio;
    logger.info(
      { numero_guia, situacao, duracao_ms: duracao },
      "autorização concluída"
    );

    return {
      sucesso: true,
      numero_guia,
      data_autorizacao,
      screenshot_comprovante_path,
      senha_autorizacao,
      situacao,
      duracao_ms: duracao,
    };
  } catch (err) {
    const mensagem = (err as Error).message;
    const erroCodigo = extrairCodigoErro(mensagem) ?? "ERRO_DESCONHECIDO";

    logger.error({ etapa: etapaAtual, erroCodigo, mensagem }, "falha na autorização");

    let screenshotPath: string | null = null;
    if (page) {
      screenshotPath = await capturarScreenshot(
        page,
        `erro_${etapaAtual}_${erroCodigo}`,
        config.screenshotDir
      );
    }

    return {
      sucesso: false,
      etapa: etapaAtual,
      erro_codigo: erroCodigo,
      mensagem,
      screenshot_path: screenshotPath,
      tentativas: 1,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (browser) {
      // Em modo debug, mantém aberto por 10s para inspeção
      if (config.debug) {
        logger.info("modo debug: aguardando 10s antes de fechar browser");
        await new Promise((r) => setTimeout(r, 10000));
      }
      await browser.close();
    }
  }
}

/**
 * Preenche os campos fixos do formulário principal.
 * Médico e procedimento são preenchidos em módulos separados.
 */
async function preencherCamposBasicos(
  page: Page,
  input: InputAutorizacao,
  config: Config
): Promise<void> {
  logger.info("preenchendo campos básicos do formulário");

  // === DIAGNÓSTICO: confirma que estamos na janela certa ===
  logger.info({ url: page.url() }, "URL da página onde vamos preencher");

  // Conta inputs visíveis para confirmar que estamos no formulário
  const totalInputs = await page.locator('input').count();
  const totalSelects = await page.locator('select').count();
  logger.info({ totalInputs, totalSelects }, "elementos no formulário");

  // Lista todas as páginas do contexto
  const todasPaginas = page.context().pages();
  for (let i = 0; i < todasPaginas.length; i++) {
    const p = todasPaginas[i];
    if (!p.isClosed()) {
      logger.info({ idx: i, url: p.url(), eAtual: p === page }, "página no contexto");
    }
  }

  // === MODO DUMP HTML ===
  // Se a variável de ambiente DUMP_HTML=true, salva o HTML do formulário e sai.
  // Isso permite inspecionar o HTML real e escrever seletores corretos.
  if (process.env.DUMP_HTML === "true") {
    const html = await page.content();
    const fs = await import("fs");
    const path = await import("path");
    const dumpPath = path.resolve("./dump-formulario.html");
    fs.writeFileSync(dumpPath, html, "utf-8");
    logger.info({ dumpPath, tamanhoBytes: html.length }, "HTML do formulário salvo");

    // Tira screenshot full page também
    const screenshotPath = path.resolve("./dump-formulario.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    logger.info({ screenshotPath }, "Screenshot do formulário salvo");

    throw new Error("DUMP_HTML: arquivos salvos com sucesso (não é erro real, foi solicitado pelo usuário)");
  }

  // Aguarda o formulário estar realmente pronto (campo NM_CONTRATADO existir)
  try {
    await page.waitForSelector('#NM_CONTRATADO', {
      timeout: 5000,
    }).catch(() => {});
  } catch {
    // continua mesmo se não achar
  }

  // Data de emissão + Data de solicitação: hoje (formato dd/MM/yyyy)
  const hoje = new Date();
  const dd = String(hoje.getDate()).padStart(2, "0");
  const mm = String(hoje.getMonth() + 1).padStart(2, "0");
  const yyyy = hoje.getFullYear();
  const dataHoje = `${dd}/${mm}/${yyyy}`;

  try {
    await page.locator('#DT_EMISSAO_GUIA').fill(dataHoje);
    await page.locator('#DT_EMISSAO_GUIA').press("Tab");
    logger.info({ dataEmissao: dataHoje }, "campo Data de emissão preenchido");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "campo Data de emissão não preenchido");
  }

  // Data da Solicitação — formato dd/MM/yyyy HH:mm (com hora)
  const dataHojeComHora = `${dataHoje} 00:00`;
  try {
    await page.locator('#DT_SOLICITACAO').fill(dataHojeComHora);
    await page.locator('#DT_SOLICITACAO').press("Tab");
    logger.info({ dataSolicitacao: dataHojeComHora }, "campo Data da Solicitação preenchido");
  } catch {
    try {
      await page.locator('input[name="DT_SOLICITACAO"]').fill(dataHojeComHora);
      await page.locator('input[name="DT_SOLICITACAO"]').press("Tab");
      logger.info({ dataSolicitacao: dataHojeComHora }, "campo Data da Solicitação preenchido (via name)");
    } catch (err2) {
      logger.warn({ err: (err2 as Error).message }, "campo Data da Solicitação não preenchido");
    }
  }

  // Atendimento a RN: Não (value="N")
  try {
    await page.locator('select[name="FG_ATENDIMENTO_RN"]').selectOption({ value: "N" });
    logger.info("campo Atendimento a RN preenchido");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "campo Atendimento a RN não preenchido");
  }

  // Telefone (Celular SMS) — id="nr_celular"
  // ATENÇÃO: o portal valida que o telefone/email NÃO pode ser do prestador.
  // Só preenche se houver telefone real do paciente. Placeholders e valores
  // genéricos (ex: 48999999999, "example.com") fazem a guia ser rejeitada.
  const telefonePlaceholders = ["48999999999", "00000000000", "11111111111", "99999999999"];
  const telRaw = (input.paciente.telefone || "").replace(/\D/g, "");
  if (telRaw && telRaw.length >= 10 && !telefonePlaceholders.includes(telRaw)) {
    // Preenche Telefone fixo (obrigatório no SGU)
    try {
      const telFixoSel = page.locator('#nr_fone').first();
      if (await telFixoSel.isVisible({ timeout: 1000 }).catch(() => false)) {
        await telFixoSel.click();
        await telFixoSel.fill("");
        await telFixoSel.pressSequentially(telRaw, { delay: 30 });
        await telFixoSel.press("Tab");
        logger.info({ telefone: telRaw }, "campo Telefone fixo preenchido");
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "campo Telefone fixo não preenchido");
    }
    // Preenche Celular SMS
    try {
      await page.locator('#nr_celular').click();
      await page.locator('#nr_celular').fill("");
      await page.locator('#nr_celular').pressSequentially(telRaw, { delay: 30 });
      await page.locator('#nr_celular').press("Tab");
      logger.info({ telefone: telRaw }, "campo Celular preenchido");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "campo Celular (SMS) não preenchido");
    }
  } else {
    logger.info({ telefoneRecebido: telRaw }, "campos Telefone/Celular deixados em branco (placeholder ou ausente)");
  }

  // E-mail — id="ds_email"
  // Mesma lógica: só preenche se for e-mail real do paciente
  const emailPlaceholders = ["@example.com", "@test.com", "@teste.com", "vinicius@example"];
  const emailRaw = (input.paciente.email || "").trim().toLowerCase();
  const ehPlaceholder = emailPlaceholders.some((p) => emailRaw.includes(p));
  if (emailRaw && emailRaw.includes("@") && !ehPlaceholder) {
    try {
      await page.locator('#ds_email').fill(emailRaw, { timeout: 3000 });
      logger.info({ email: emailRaw }, "campo E-mail preenchido");
    } catch {
      logger.warn("campo E-mail não preenchido");
    }
  } else {
    logger.info({ emailRecebido: emailRaw }, "campo E-mail deixado em branco (placeholder ou ausente)");
  }

  // Nome do Contratado: clica lupa #link_busca_contrt, busca 300788, seleciona Clínica
  await preencherNomeContratado(page, config);

  // OBS: Médico solicitante é preenchido em módulo separado (medico.ts)

  // Caráter do atendimento: 1 - Eletivo (value="1")
  try {
    await page.locator('#DM_CARATER_SOLIC').selectOption({ value: "1" });
    logger.info("campo Caráter do atendimento preenchido");
  } catch {
    logger.warn("campo Caráter do atendimento não encontrado");
  }

  // Indicação clínica: "CID XXX" — id="DS_INDIC_CLINICA"
  try {
    await page.locator('#DS_INDIC_CLINICA').fill(input.indicacao_clinica_formatada);
    logger.info("campo Indicação clínica preenchido");
  } catch {
    logger.warn("campo Indicação clínica não encontrado");
  }

  // Tipo de atendimento: 03 - Outras Terapias (value="03")
  try {
    await page.locator('select[name="DM_TP_ATEND_SADT"]').selectOption({ value: "03" });
    logger.info("campo Tipo de atendimento preenchido");
  } catch {
    logger.warn("campo Tipo de atendimento não encontrado");
  }

  // Indicação de acidente: 9 - Não acidente (value="9")
  try {
    await page.locator('select[name="DM_TP_ACIDENTE"]').selectOption({ value: "9" });
    logger.info("campo Indicação de acidente preenchido");
  } catch {
    logger.warn("campo Indicação de acidente não encontrado");
  }

  // Liminar judicial — seleciona "Não" (primeira opção com "Não" no texto)
  try {
    const selectLiminar = page.locator('select[name="FG_LIMINAR_JUDICIAL"]');
    const count = await selectLiminar.count();
    if (count > 0) {
      // Tenta value "N" primeiro, senão busca opção com "Não"
      try {
        await selectLiminar.selectOption({ value: "N" });
      } catch {
        const opts = await selectLiminar.locator('option').all();
        for (const opt of opts) {
          const txt = (await opt.textContent() || "").trim();
          if (/n[ãa]o/i.test(txt)) {
            const val = await opt.getAttribute("value");
            if (val !== null) { await selectLiminar.selectOption({ value: val }); break; }
          }
        }
      }
      logger.info("campo Liminar judicial preenchido (Não)");
    } else {
      logger.warn("campo Liminar judicial não encontrado");
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "campo Liminar judicial não preenchido");
  }

  logger.info("campos básicos preenchidos");
}

async function preencherNomeContratado(page: Page, config: Config): Promise<void> {
  logger.info("preenchendo Nome do Contratado");

  // Clica na lupa de localizar contratado — id real: link_busca_contrt
  // (link_busca_contrtloc é a lupa "local de atendimento", a outra lupa abre o modal completo)
  await page.locator('#link_busca_contrt').click({ timeout: config.clickTimeout });

  // O modal "Localizar prestador" pode abrir em qualquer janela.
  // Faz polling buscando em todas as páginas do contexto.
  logger.info("buscando modal 'Localizar prestador'");

  let pageModal: Page | null = null;
  const inicio = Date.now();

  while (Date.now() - inicio < config.navegacaoTimeout) {
    const todasPaginas = page.context().pages();
    for (const p of todasPaginas) {
      if (p.isClosed()) continue;
      const visivel = await p
        .locator('text=Localizar prestador')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (visivel) {
        pageModal = p;
        logger.info({ url: p.url() }, "modal 'Localizar prestador' encontrado");
        break;
      }
    }
    if (pageModal) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!pageModal) {
    throw new Error("CAMPO_OBRIGATORIO_REJEITADO: modal 'Localizar prestador' não abriu");
  }

  // === DUMP do modal se DUMP_HTML_MODAL estiver ativo ===
  if (process.env.DUMP_HTML_MODAL === "true") {
    const html = await pageModal.content();
    const fs = await import("fs");
    const pathMod = await import("path");
    const dumpPath = pathMod.resolve("./dump-modal-prestador.html");
    fs.writeFileSync(dumpPath, html, "utf-8");
    logger.info({ dumpPath, tamanhoBytes: html.length }, "HTML do modal salvo");

    const screenshotPath = pathMod.resolve("./dump-modal-prestador.png");
    await pageModal.screenshot({ path: screenshotPath, fullPage: true });
    logger.info({ screenshotPath }, "Screenshot do modal salvo");

    throw new Error("DUMP_HTML_MODAL: arquivos do modal salvos com sucesso");
  }

  // Preenche Código na Operadora.
  // Estratégia robusta: encontra o label "Código na Operadora" e pega o
  // input que está logo após ele (irmão na mesma linha da tabela).
  // Como o nome exato do campo varia, tenta múltiplos seletores em ordem.
  logger.info("preenchendo Código na Operadora no modal");
  let preenchido = false;
  const seletoresCodigo = [
    // Por label (mais robusto - usa proximidade do texto)
    'tr:has-text("C\u00f3digo na Operadora") input[type="text"]',
    'td:has-text("C\u00f3digo na Operadora") + td input',
    // Por name comum em portais Unimed
    'input[name="CD_OPER_PREST_LOC"]',
    'input[name="CD_OPER"]',
    'input[name="cdOperadora"]',
    'input[name*="OPER"]',
    'input[id*="OPER"]',
  ];

  for (const sel of seletoresCodigo) {
    try {
      const elem = pageModal.locator(sel).first();
      const visivel = await elem.isVisible({ timeout: 1000 });
      if (visivel) {
        await elem.fill("300788");
        logger.info({ seletor: sel }, "Código preenchido com seletor");
        preenchido = true;
        break;
      }
    } catch {
      // próximo
    }
  }

  if (!preenchido) {
    throw new Error("CAMPO_OBRIGATORIO_REJEITADO: campo 'Código na Operadora' não encontrado no modal. Use DUMP_HTML_MODAL=true pra inspecionar.");
  }

  // Localizar
  await pageModal
    .locator('button:has-text("Localizar"), input[value="Localizar"]')
    .last()
    .click({ timeout: config.clickTimeout });

  await pageModal.waitForLoadState("networkidle").catch(() => {});

  // Clica em CLINICA LUCIANO NOCETI LTDA
  await pageModal
    .locator('a:has-text("CLINICA LUCIANO NOCETI"), a:has-text("CL\u00cdNICA LUCIANO NOCETI")')
    .first()
    .click({ timeout: config.clickTimeout });

  await page.waitForLoadState("networkidle").catch(() => {});
  logger.info("Nome do Contratado preenchido");
}

/**
 * Seleciona uma opção em um <select> usando regex no texto da opção.
 * Playwright só aceita string em selectOption, então precisamos enumerar.
 */
async function selecionarPorRegex(
  select: ReturnType<Page["locator"]>,
  regex: RegExp
): Promise<void> {
  const opcoes = await select.locator("option").all();
  for (const opcao of opcoes) {
    const texto = (await opcao.textContent())?.trim() ?? "";
    if (regex.test(texto)) {
      const value = await opcao.getAttribute("value");
      if (value !== null) {
        await select.selectOption({ value });
        return;
      }
    }
  }
  throw new Error(`opção não encontrada para regex ${regex}`);
}

/**
 * Extrai código de erro padronizado a partir da mensagem.
 */
function extrairCodigoErro(mensagem: string): ErroCodigo | null {
  const padroes: Record<string, ErroCodigo> = {
    LOGIN_FALHOU: "LOGIN_FALHOU",
    LOGIN_TIMEOUT: "LOGIN_TIMEOUT",
    MENU_NAO_ENCONTRADO: "MENU_NAO_ENCONTRADO",
    MODAL_NOVO_EXAME_NAO_ABRIU: "MODAL_NOVO_EXAME_NAO_ABRIU",
    BENEFICIARIO_NAO_LOCALIZADO: "BENEFICIARIO_NAO_LOCALIZADO",
    BENEFICIARIO_RESTRICAO: "BENEFICIARIO_RESTRICAO",
    INTERCAMBIO_VERIFICACAO_FALHOU: "INTERCAMBIO_VERIFICACAO_FALHOU",
    MEDICO_NAO_LOCALIZADO: "MEDICO_NAO_LOCALIZADO",
    MEDICO_CADASTRO_FALHOU: "MEDICO_CADASTRO_FALHOU",
    CBO_NAO_ENCONTRADO: "CBO_NAO_ENCONTRADO",
    PROCEDIMENTO_INVALIDO: "PROCEDIMENTO_INVALIDO",
    PDF_UPLOAD_FALHOU: "PDF_UPLOAD_FALHOU",
    FINALIZACAO_FALHOU: "FINALIZACAO_FALHOU",
    GUIA_NAO_GERADA: "GUIA_NAO_GERADA",
    NUMERO_GUIA_NAO_CAPTURADO: "NUMERO_GUIA_NAO_CAPTURADO",
    GUIA_DUPLICADA: "GUIA_DUPLICADA",
    CAPTCHA_INESPERADO: "CAPTCHA_INESPERADO",
    SESSAO_EXPIRADA: "SESSAO_EXPIRADA",
    TIMEOUT: "TIMEOUT",
  };

  for (const [chave, codigo] of Object.entries(padroes)) {
    if (mensagem.includes(chave)) return codigo;
  }

  return null;
}
