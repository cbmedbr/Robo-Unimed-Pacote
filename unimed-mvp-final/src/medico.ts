import { Page } from "playwright";
import { InputAutorizacao, Config } from "./types";
import { logger } from "./utils/logger";

/**
 * Preenche o campo "Nome do profissional solicitante" no formulário de guia.
 *
 * São 4 caminhos possíveis:
 * - A: médico cooperado, encontrado na primeira busca
 * - B1: médico não cooperado, mas já cadastrado como externo
 * - B2: médico não cooperado, precisa cadastrar
 *
 * TODO (fase 2): adicionar lock no banco para evitar race condition no caminho B2
 * quando múltiplos robôs rodarem em paralelo tentando cadastrar o mesmo médico.
 */
export async function preencherMedicoSolicitante(
  page: Page,
  input: InputAutorizacao,
  config: Config
): Promise<void> {
  logger.info(
    { medico: input.medico_solicitante.nome, crm: input.medico_solicitante.numero_crm },
    "preenchendo médico solicitante"
  );

  // Clica na lupa do "Nome do profissional solicitante" e captura o popup do modal
  let pageModal = await clicarLupaMedicoSolicitante(page, config);

  // Preenche modal de localizar prestador (primeira tentativa, como cooperado)
  await preencherModalLocalizarPrestador(
    pageModal,
    {
      conselho: "CRM - Conselho Regional de Medicina",
      numeroCRM: input.medico_solicitante.numero_crm,
      cadastro: "Prestador da Rede Unimed",
    },
    config
  );

  // Verifica resultado: encontrou? lista vazia?
  const temResultados = await verificarResultadosBusca(pageModal);

  if (temResultados) {
    logger.info("CAMINHO A: médico cooperado encontrado");
    await selecionarMedicoNaLista(pageModal, input.medico_solicitante.nome, config);
    // Aguarda popup fechar e valor propagar pra página principal
    await aguardarCampoMedicoPreenchido(page, config);
    return;
  }

  logger.info("médico não é cooperado, tentando como Prestador Externo");

  // Fecha modal e abre de novo
  await fecharModal(pageModal);
  pageModal = await clicarLupaMedicoSolicitante(page, config);

  // Busca como Prestador Externo
  await preencherModalLocalizarPrestador(
    pageModal,
    {
      conselho: "CRM - Conselho Regional de Medicina",
      numeroCRM: input.medico_solicitante.numero_crm,
      cadastro: "Prestador Externo",
    },
    config
  );

  const temExternosCadastrados = await verificarResultadosBusca(pageModal);

  if (temExternosCadastrados) {
    // CAMINHO B1: tenta achar pelo nome
    const encontrouPeloNome = await tentarSelecionarPorNome(
      pageModal,
      input.medico_solicitante.nome,
      config
    );

    if (encontrouPeloNome) {
      logger.info("CAMINHO B1: médico já cadastrado como externo");
      await aguardarCampoMedicoPreenchido(page, config);
      return;
    }

    logger.info("médico externo existe mas com nome diferente, vai cadastrar novo");
  }

  // CAMINHO B2: precisa cadastrar como novo prestador externo
  // Verifica se a popup ainda está aberta. Se fechou, refaz o caminho.
  if (pageModal.isClosed()) {
    logger.warn("popup fechou inesperadamente, reabrindo para cadastrar prestador");
    pageModal = await clicarLupaMedicoSolicitante(page, config);
    await preencherModalLocalizarPrestador(
      pageModal,
      {
        conselho: "CRM - Conselho Regional de Medicina",
        numeroCRM: input.medico_solicitante.numero_crm,
        cadastro: "Prestador Externo",
      },
      config
    );
    // Aguarda página de resultado carregar para ter botão "Inserir novo"
    await new Promise((r) => setTimeout(r, 1500));
  }

  logger.info("CAMINHO B2: cadastrando novo prestador externo");
  await cadastrarPrestadorExterno(pageModal, input, config);

  // Após cadastrar, lista atualiza, clica no nome
  await selecionarMedicoNaLista(pageModal, input.medico_solicitante.nome, config);
  await aguardarCampoMedicoPreenchido(page, config);
}

/**
 * Clica na lupa do solicitante e retorna a página/popup onde o modal abriu.
 */
async function clicarLupaMedicoSolicitante(page: Page, config: Config): Promise<Page> {
  // Lupa do "Nome do profissional solicitante" — id real: link_busca_solic
  // (link_busca_solicloc é a lupa "local de atendimento", queremos a outra)
  await page.locator('#link_busca_solic').click({ timeout: config.clickTimeout });

  // O modal abre em popup separado. Faz polling em todas as páginas do contexto.
  // IMPORTANTE: queremos a página de BUSCA (`localizar.do`), não a de resultado.
  logger.info("buscando popup de busca de prestador (localizar.do)");

  let pageModal: Page | null = null;
  const inicio = Date.now();

  while (Date.now() - inicio < config.navegacaoTimeout) {
    const todasPaginas = page.context().pages();
    for (const p of todasPaginas) {
      if (p.isClosed()) continue;
      const url = p.url();
      // Aceita SOMENTE a URL de busca (localizar.do), não a de resultado
      if (url.includes("/modal/busca_prest/localizar.do")) {
        pageModal = p;
        logger.info({ url }, "popup de busca de prestador aberto");
        break;
      }
    }
    if (pageModal) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!pageModal) {
    throw new Error("MEDICO_NAO_LOCALIZADO: popup de busca de prestador não abriu");
  }

  return pageModal;
}

async function preencherModalLocalizarPrestador(
  page: Page,
  dados: { conselho: string; numeroCRM: string; cadastro: string },
  config: Config
): Promise<void> {
  // Conselho profissional (select) - usa seletor tr:has-text
  try {
    const select = page
      .locator('tr:has-text("Conselho profissional") select, td:has-text("Conselho profissional") + td select')
      .first();
    await select.selectOption({ label: dados.conselho });
    logger.info("conselho profissional selecionado no modal");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "falha ao selecionar conselho");
  }

  // Número do conselho - usa tr:has-text
  try {
    const inputCRM = page
      .locator('tr:has-text("N\u00famero do Conselho") input[type="text"], td:has-text("N\u00famero do Conselho") + td input')
      .first();
    await inputCRM.fill(dados.numeroCRM);
    logger.info("CRM preenchido no modal");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "falha ao preencher CRM");
  }

  // Cadastro (select) - "Prestador da Rede Unimed" / "Prestador Externo"
  try {
    const select = page
      .locator('tr:has-text("Cadastro") select, td:has-text("Cadastro") + td select')
      .first();
    await select.selectOption({ label: dados.cadastro });
    logger.info({ cadastro: dados.cadastro }, "cadastro selecionado no modal");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "falha ao selecionar cadastro");
  }

  // Clica Localizar
  await page
    .locator('button:has-text("Localizar"), input[value="Localizar"]')
    .last()
    .click({ timeout: config.clickTimeout });

  await page.waitForLoadState("networkidle").catch(() => {});
}

async function selecionarOpcaoSelect(
  page: Page,
  labelTexto: string,
  valorTexto: string
): Promise<void> {
  // Acha o select pelo label próximo
  const select = page
    .locator(`:has-text("${labelTexto}")`)
    .locator('select')
    .first();

  await select.selectOption({ label: valorTexto });
}

async function verificarResultadosBusca(page: Page): Promise<boolean> {
  // === DUMP do resultado se DUMP_HTML_RESULTADO estiver ativo ===
  if (process.env.DUMP_HTML_RESULTADO === "true") {
    const html = await page.content();
    const fs = await import("fs");
    const pathMod = await import("path");
    const dumpPath = pathMod.resolve("./dump-modal-resultado.html");
    fs.writeFileSync(dumpPath, html, "utf-8");
    logger.info({ dumpPath, tamanhoBytes: html.length }, "HTML do modal de resultado salvo");

    const screenshotPath = pathMod.resolve("./dump-modal-resultado.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    logger.info({ screenshotPath }, "Screenshot do modal de resultado salvo");

    throw new Error("DUMP_HTML_RESULTADO: arquivos do resultado salvos com sucesso");
  }

  // Aguarda 1s pra página carregar resultado
  await new Promise((r) => setTimeout(r, 1000));

  // Mensagens de "não encontrado"
  const mensagensVazio = [
    'N\u00e3o foram encontrados registros',
    '0 Prestador(es) encontrado',
    'Nenhum registro encontrado',
    'Nenhum prestador encontrado',
    'sem resultados',
    'no rows found',
  ];

  for (const msg of mensagensVazio) {
    const visivel = await page
      .locator(`text=${msg}`)
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (visivel) {
      logger.info({ mensagem: msg }, "busca vazia detectada");
      return false;
    }
  }

  // Verifica também se URL está em "resultado.do" e a tabela de resultados está vazia
  if (page.url().includes("/resultado.do")) {
    const linhasTabela = await page
      .locator("table tr")
      .count()
      .catch(() => 0);
    logger.info({ url: page.url(), linhasTabela }, "página de resultado");
    // Se tem pouquíssimas linhas (só header), é vazio
    if (linhasTabela <= 2) {
      logger.info("tabela praticamente vazia, considerando busca como vazia");
      return false;
    }
  }

  // Se não tem mensagem de vazio e há linhas, assume que encontrou
  return true;
}

async function selecionarMedicoNaLista(
  page: Page,
  nomeMedico: string,
  config: Config
): Promise<void> {
  // Estratégias de clique em ordem de preferência:
  // 1. Nome exato
  // 2. Nome sem prefixo "DR." / "DRA."
  // 3. Primeiro nome + último sobrenome (match parcial)
  // 4. Só o sobrenome principal
  // 5. Primeiro link da coluna "Nome do Prestador" (Pessoa Física)

  const nomeLimpo = nomeMedico.replace(/^(DR\.?|DRA\.?)\s*/i, '').trim();
  const partes = nomeLimpo.split(/\s+/);
  const primeiroNome = partes[0] || '';
  const ultimoSobrenome = partes[partes.length - 1] || '';

  const tentativas = [
    nomeMedico,                                    // "THALES R. SCHOTT DA SILVA"
    nomeLimpo,                                     // "THALES R. SCHOTT DA SILVA" (sem DR)
    partes.slice(0, 3).join(' '),                  // "THALES R. SCHOTT"
    `${primeiroNome} ${ultimoSobrenome}`,          // "THALES SILVA"
    primeiroNome,                                  // "THALES"
  ];

  // Também tenta expandir abreviações: "R." → qualquer palavra
  // Ex: "THALES R. SCHOTT" deve achar "THALES ROBERTO SCHOTT"
  // Procura links que contenham o primeiro nome E o sobrenome principal
  if (partes.length >= 2) {
    // Pega primeiro nome + sobrenomes não-abreviados (>2 chars)
    const sobrenomesReais = partes.slice(1).filter(p => p.length > 2 && !p.endsWith('.'));
    if (sobrenomesReais.length > 0) {
      tentativas.push(`${primeiroNome} ${sobrenomesReais.join(' ')}`);
    }
  }

  for (const nome of tentativas) {
    if (!nome || nome.length < 3) continue;
    try {
      const link = page.locator(`a:has-text("${nome}")`).first();
      const visivel = await link.isVisible({ timeout: 1500 }).catch(() => false);
      if (visivel) {
        await link.click({ timeout: config.clickTimeout });
        await page.waitForLoadState("networkidle").catch(() => {});
        logger.info({ nomeBuscado: nome, nomeOriginal: nomeMedico }, "médico selecionado pelo nome");
        return;
      }
    } catch {
      // próxima tentativa
    }
  }

  // Fallback: clica no primeiro link Pessoa Física na tabela
  // A coluna "Pessoa" indica "Física" ou "Jurídica". Queremos Física (o médico).
  logger.warn({ nomeMedico }, "nome não encontrado, clicando primeiro resultado Pessoa Física");
  try {
    // Linha que contém "Física" → clica no link da coluna "Nome do Prestador"
    const linhaFisica = page.locator('table tr:has-text("Física")').first();
    const linkNome = linhaFisica.locator('td:nth-child(2) a').first();
    const visivel = await linkNome.isVisible({ timeout: 2000 }).catch(() => false);
    if (visivel) {
      await linkNome.click({ timeout: config.clickTimeout });
    } else {
      // Último fallback: qualquer link na segunda coluna
      await page.locator('table tr td:nth-child(2) a').first().click({ timeout: config.clickTimeout });
    }
  } catch {
    // Último fallback: qualquer link da tabela
    await page.locator('table a').first().click({ timeout: config.clickTimeout });
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  logger.info({ nomeMedico }, "médico selecionado via fallback");
}

async function tentarSelecionarPorNome(
  page: Page,
  nomeMedico: string,
  config: Config
): Promise<boolean> {
  if (page.isClosed()) {
    logger.warn("página já fechada antes de tentarSelecionarPorNome");
    return false;
  }
  try {
    const link = page.locator(`a:has-text("${nomeMedico}")`).first();
    const visivel = await link.isVisible({ timeout: 2000 }).catch(() => false);
    if (visivel) {
      await link.click({ timeout: config.clickTimeout });
      await page.waitForLoadState("networkidle").catch(() => {});
      return true;
    }
    return false;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, "tentarSelecionarPorNome falhou (esperado se nome não bate)");
    return false;
  }
}

async function fecharModal(page: Page): Promise<void> {
  // Tenta clicar Cancelar primeiro
  const seletoresCancelar = [
    'button:has-text("Cancelar")',
    'input[value="Cancelar"]',
    'a:has-text("Cancelar")',
  ];

  for (const sel of seletoresCancelar) {
    try {
      const elem = page.locator(sel).first();
      if (await elem.isVisible({ timeout: 1000 })) {
        await elem.click();
        await page.waitForLoadState("networkidle").catch(() => {});
        // Espera a popup fechar ou recarregar
        await new Promise((r) => setTimeout(r, 1000));
        return;
      }
    } catch {
      // próximo
    }
  }

  // Fallback: fecha a popup explicitamente
  // (não usar ESC porque às vezes não funciona em popups)
  logger.warn("Cancelar não encontrado, fechando janela popup explicitamente");
  try {
    await page.close();
  } catch {
    logger.debug("popup já estava fechada");
  }
}

async function cadastrarPrestadorExterno(
  page: Page,
  input: InputAutorizacao,
  config: Config
): Promise<void> {
  // Verifica se a popup está acessível
  if (page.isClosed()) {
    throw new Error("MEDICO_CADASTRO_FALHOU: popup foi fechada antes do cadastro");
  }

  // Clica "Inserir novo"
  logger.info("clicando 'Inserir novo'");
  await page
    .locator('a:has-text("Inserir novo"), button:has-text("Inserir novo"), input[value*="Inserir"]')
    .first()
    .click({ timeout: config.clickTimeout });

  // Após "Inserir novo", o formulário pode:
  //  (a) navegar na MESMA popup (URL muda para cadastrar.do)
  //  (b) abrir em popup separada
  // Estratégia: primeiro espera a mesma page navegar, depois faz polling geral.
  logger.info("buscando formulário de cadastro de prestador externo");

  // Espera navegação na mesma page (caso mais comum)
  await page.waitForLoadState("networkidle").catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  let pageCadastro: Page | null = null;

  // Checa se a PRÓPRIA page agora mostra o formulário (navegação interna)
  if (page.url().includes("cadastrar.do")) {
    logger.info({ url: page.url() }, "formulário de cadastro abriu na mesma popup");
    pageCadastro = page;
  } else {
    // Checa texto na mesma page (URL pode não ter mudado mas o conteúdo sim)
    const visivelMesma = await page
      .locator('text=/Cadastrar prestador externo|Cadastro de prestador|Nome do Prestador/i')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (visivelMesma) {
      logger.info("formulário detectado por texto na mesma popup");
      pageCadastro = page;
    }
  }

  // Fallback: polling em todas as páginas (popup separada)
  if (!pageCadastro) {
    const inicio = Date.now();
    while (Date.now() - inicio < config.navegacaoTimeout) {
      const todasPaginas = page.context().pages();
      for (const p of todasPaginas) {
        if (p === page || p.isClosed()) continue;
        const visivel = await p
          .locator('text=/Cadastrar prestador externo|Cadastro de prestador|Nome do Prestador/i')
          .first()
          .isVisible({ timeout: 1000 })
          .catch(() => false);
        if (visivel) {
          pageCadastro = p;
          logger.info({ url: p.url() }, "formulário de cadastro encontrado em popup separada");
          break;
        }
      }
      if (pageCadastro) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (!pageCadastro) {
    throw new Error("MEDICO_CADASTRO_FALHOU: formulário de cadastro de prestador externo não abriu");
  }

  // Aguarda DOM carregar completamente
  await pageCadastro.waitForLoadState("domcontentloaded").catch(() => {});
  await pageCadastro.waitForLoadState("networkidle").catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  // === DUMP do formulário se DUMP_HTML_CADASTRO estiver ativo ===
  if (process.env.DUMP_HTML_CADASTRO === "true") {
    const html = await pageCadastro.content();
    const fs = await import("fs");
    const pathMod = await import("path");
    const dumpPath = pathMod.resolve("./dump-form-cadastro.html");
    fs.writeFileSync(dumpPath, html, "utf-8");
    logger.info({ dumpPath }, "HTML do formulário de cadastro salvo");

    const screenshotPath = pathMod.resolve("./dump-form-cadastro.png");
    await pageCadastro.screenshot({ path: screenshotPath, fullPage: true });
    logger.info({ screenshotPath }, "Screenshot do formulário de cadastro salvo");

    throw new Error("DUMP_HTML_CADASTRO: arquivos do cadastro salvos com sucesso");
  }

  // Preenche dados — campos obrigatórios lançam erro se falharem (antes
  // eram silenciosos e o form era submetido vazio, travando o fluxo).
  logger.info("preenchendo dados do prestador externo");

  // Nome do Prestador
  {
    const inputNome = pageCadastro
      .locator('tr:has-text("Nome do Prestador") input[type="text"], td:has-text("Nome do Prestador") + td input, input[name*="nm_prestador" i]')
      .first();
    const visivel = await inputNome.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visivel) throw new Error("MEDICO_CADASTRO_FALHOU: campo 'Nome do Prestador' não encontrado no formulário");
    await inputNome.fill(input.medico_solicitante.nome);
    logger.info("nome do prestador preenchido");
  }

  // Pessoa Física (radio default já marcado, mas garante)
  try {
    const radioFisica = pageCadastro.locator('input[type="radio"][value*="F"]').first();
    await radioFisica.check({ timeout: 2000 });
    logger.info("Pessoa Física marcado");
  } catch {
    logger.debug("radio Pessoa Física já marcado ou não encontrado");
  }

  // Conselho profissional
  {
    const select = pageCadastro
      .locator('tr:has-text("Conselho profissional") select, td:has-text("Conselho profissional") + td select, select[name*="conselho" i]')
      .first();
    const visivel = await select.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visivel) throw new Error("MEDICO_CADASTRO_FALHOU: campo 'Conselho profissional' não encontrado");
    await select.selectOption({ label: "CRM - Conselho Regional de Medicina" });
    logger.info("conselho selecionado no cadastro");
  }

  // Número do conselho
  {
    const inputNumConselho = pageCadastro
      .locator('tr:has-text("N\u00famero do Conselho") input[type="text"], td:has-text("N\u00famero do Conselho") + td input, input[name*="nr_conselho" i]')
      .first();
    const visivel = await inputNumConselho.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visivel) throw new Error("MEDICO_CADASTRO_FALHOU: campo 'Número do Conselho' não encontrado");
    await inputNumConselho.fill(input.medico_solicitante.numero_crm);
    logger.info("número do conselho preenchido no cadastro");
  }

  // UF do conselho
  {
    const selectUF = pageCadastro
      .locator('tr:has-text("UF do conselho") select, td:has-text("UF do conselho") + td select, select[name*="uf" i]')
      .first();
    const visivel = await selectUF.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visivel) throw new Error("MEDICO_CADASTRO_FALHOU: campo 'UF do conselho' não encontrado");
    await selectUF.selectOption({ value: input.medico_solicitante.uf_crm });
    logger.info("UF preenchida no cadastro");
  }

  // CBO: clica na lupa, busca 2251, seleciona Médico clínico (225125)
  await preencherCBO(pageCadastro, config);

  // Clica Cadastrar
  logger.info("clicando Cadastrar");
  await pageCadastro
    .locator('button:has-text("Cadastrar"), input[value="Cadastrar"]')
    .first()
    .click({ timeout: config.clickTimeout });

  await pageCadastro.waitForLoadState("networkidle").catch(() => {});
  logger.info("prestador externo cadastrado");
}

/**
 * Aguarda o campo "Nome do profissional solicitante" na página principal ser preenchido.
 * A popup do portal preenche esse campo via JavaScript ao selecionar o médico.
 * Sem essa espera, o robô avança e o campo fica vazio → erro na finalização.
 */
async function aguardarCampoMedicoPreenchido(page: Page, config: Config): Promise<void> {
  // Primeiro: aguarda popup de busca fechar (o portal propaga via JS ao fechar)
  logger.info("aguardando popup de busca fechar...");
  const inicio = Date.now();
  const timeout = config.navegacaoTimeout || 15000;

  // Aguarda até sobrar só 1 página (a principal) — popup fechou
  while (Date.now() - inicio < timeout) {
    const paginasAbertas = page.context().pages().filter(p => !p.isClosed());
    if (paginasAbertas.length <= 1) {
      logger.info("popup fechou, verificando campo solicitante");
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Espera extra pro JavaScript do portal propagar o valor
  await new Promise((r) => setTimeout(r, 2000));

  // Tenta ler o campo do solicitante
  const seletores = [
    'input[name="NM_PROFISSIONAL"]',
    'input[name="nm_profissional"]',
    '#NM_PROFISSIONAL',
    '#nm_profissional',
    '#NM_SOLIC',
    'input[name="NM_SOLIC"]',
  ];

  // Polling por mais alguns segundos
  const inicio2 = Date.now();
  while (Date.now() - inicio2 < 10000) {
    for (const sel of seletores) {
      try {
        const val = await page.locator(sel).first().inputValue({ timeout: 500 });
        if (val && val.trim().length > 2) {
          logger.info({ campo: sel, valor: val.trim() }, "campo médico solicitante confirmado");
          return;
        }
      } catch {}
    }

    // Tenta também ler texto visível próximo ao label (portal pode usar span em vez de input)
    try {
      const textoSolic = await page
        .locator('td:has-text("profissional solicitante") + td, td:has-text("profissional solicitante") ~ td')
        .first()
        .textContent({ timeout: 500 });
      if (textoSolic && textoSolic.trim().length > 3) {
        logger.info({ valor: textoSolic.trim() }, "campo solicitante encontrado como texto");
        return;
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 1000));
  }

  // Último fallback: dump pra diagnóstico
  logger.warn("campo médico solicitante NÃO foi preenchido pela popup");

  // Salva screenshot pra debug
  try {
    const fs = await import("fs");
    const pathMod = await import("path");
    const dumpPath = pathMod.resolve("./dump-medico-vazio.png");
    await page.screenshot({ path: dumpPath, fullPage: true });
    logger.info({ dumpPath }, "screenshot do campo vazio salvo");

    // Lista todas as páginas abertas pra diagnóstico
    for (const p of page.context().pages()) {
      if (!p.isClosed()) {
        logger.info({ url: p.url() }, "página ainda aberta");
      }
    }
  } catch {}

  logger.error("FALHA: campo médico solicitante permanece vazio após timeout");
  throw new Error("MEDICO_CAMPO_VAZIO: o portal não preencheu o nome do profissional solicitante após selecionar na lista. Tente novamente.");
}

async function preencherCBO(page: Page, config: Config): Promise<void> {
  logger.info("preenchendo CBO");

  // Registra páginas existentes ANTES de clicar na lupa
  const paginasAntes = new Set(page.context().pages().filter(p => !p.isClosed()).map(p => p));

  // Clica na lupa do CBO
  const lupaCBO = page
    .locator(':has-text("C\u00f3digo CBO")')
    .locator('a, button, img[src*="search"], img[src*="lupa"]')
    .first();

  await lupaCBO.click({ timeout: config.clickTimeout });
  await new Promise((r) => setTimeout(r, 2000));

  // Espera uma NOVA popup abrir (que não existia antes)
  let pageCBO: Page | null = null;
  const inicio = Date.now();
  while (Date.now() - inicio < config.navegacaoTimeout) {
    for (const p of page.context().pages()) {
      if (p.isClosed() || paginasAntes.has(p)) continue;
      pageCBO = p;
      logger.info({ url: p.url() }, "popup CBO detectada (nova janela)");
      break;
    }
    if (pageCBO) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!pageCBO) {
    logger.warn("popup CBO não abriu, tentando preencher direto via JS");
    // Fallback: seta o valor do CBO direto via JavaScript no form
    await page.evaluate(() => {
      const codInput = document.querySelector('input[name="CD_CBOS"], input[id="CD_CBOS"]') as HTMLInputElement;
      const nomeInput = document.querySelector('input[name="NM_CBOS"], input[id="NM_CBOS"]') as HTMLInputElement;
      if (codInput) { codInput.readOnly = false; codInput.value = '225125'; codInput.readOnly = true; }
      if (nomeInput) { nomeInput.readOnly = false; nomeInput.value = 'Médico clínico'; nomeInput.readOnly = true; }
    });
    logger.info("CBO 225125 preenchido via JS (fallback)");
    return;
  }

  await pageCBO.waitForLoadState("domcontentloaded").catch(() => {});
  await pageCBO.waitForLoadState("networkidle").catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  // Aguarda qualquer input aparecer no DOM antes de tentar interagir
  await pageCBO.waitForSelector('input', { timeout: 15000 }).catch(() => {
    logger.warn("nenhum input encontrado no popup CBO após 15s");
  });

  // Tenta localizar input editável de forma ampla via evaluate
  const inputInfo = await pageCBO.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    for (const inp of inputs) {
      const tipo = (inp.getAttribute('type') || 'text').toLowerCase();
      if (['text', 'search', ''].includes(tipo) && !inp.readOnly && !inp.disabled) {
        return { name: inp.name, id: inp.id, type: inp.type || 'text', tagName: inp.tagName };
      }
    }
    // fallback: primeiro input qualquer
    const primeiro = inputs[0];
    return primeiro ? { name: primeiro.name, id: primeiro.id, type: primeiro.type, tagName: primeiro.tagName } : null;
  });

  logger.info({ inputInfo }, "inputs detectados no popup CBO");

  if (inputInfo && inputInfo.id) {
    await pageCBO.locator(`#${inputInfo.id}`).fill("2251");
    logger.info({ seletor: `#${inputInfo.id}` }, "código CBO 2251 preenchido pelo id");
  } else if (inputInfo && inputInfo.name) {
    await pageCBO.locator(`input[name="${inputInfo.name}"]`).fill("2251");
    logger.info({ seletor: `input[name="${inputInfo.name}"]` }, "código CBO 2251 preenchido pelo name");
  } else {
    // Fallback final: primeiro input visível
    await pageCBO.locator('input').first().fill("2251");
    logger.info("código CBO 2251 preenchido (fallback input genérico)");
  }

  // Clica Consultar
  await pageCBO
    .locator('button:has-text("Consultar"), input[value="Consultar"]')
    .first()
    .click({ timeout: config.clickTimeout });

  await pageCBO.waitForLoadState("networkidle").catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // Clica em "Médico clínico" (código 225125)
  await pageCBO
    .locator('a:has-text("M\u00e9dico cl\u00ednico"), text=M\u00e9dico cl\u00ednico')
    .first()
    .click({ timeout: config.clickTimeout });

  await pageCBO.waitForLoadState("networkidle").catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  logger.info("CBO 225125 (Médico clínico) selecionado");
}
