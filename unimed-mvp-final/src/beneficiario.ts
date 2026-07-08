import { Page } from "playwright";
import { InputAutorizacao, Config } from "./types";
import { logger } from "./utils/logger";

/**
 * Navega de "Exames em aberto" até abrir o formulário de digitação de guia.
 * Retorna a Page onde o formulário ficou aberto (pode ser popup ou principal).
 *
 * Caminho:
 * 1. Menu Exames > Exames em aberto
 * 2. Clica + Novo Exame
 * 3. Modal "Passe o cartão" → clica "Se tiver problemas com o cartão"
 * 4. Modal "Problemas com o cartão do beneficiário?" abre
 * 5. Decide LOCAL ou INTERCAMBIO
 * 6. Localiza/cadastra beneficiário
 * 7. Clica "Digitação de guia SP/SADT"
 * 8. Clica "Digitar solicitação manualmente..."
 */
export async function abrirFormularioGuia(
  page: Page,
  input: InputAutorizacao,
  config: Config
): Promise<Page> {
  logger.info("abrindo navegação Exames > Exames em aberto");

  // Menu Exames
  await page.locator('text=Exames').first().click({ timeout: config.clickTimeout });
  await page.waitForLoadState("networkidle");

  // Ícone Exames em aberto (lateral)
  await page.locator('text=Exames em aberto').first().click({ timeout: config.clickTimeout });
  await page.waitForLoadState("networkidle");

  // Botão + Novo Exame
  logger.info("clicando + Novo Exame");
  const botoesPossiveis = [
    'button:has-text("Novo Exame")',
    'a:has-text("Novo Exame")',
    'text=+ Novo Exame',
  ];

  let clicado = false;
  for (const sel of botoesPossiveis) {
    try {
      const elem = page.locator(sel).first();
      if (await elem.isVisible({ timeout: 2000 })) {
        await elem.click();
        clicado = true;
        break;
      }
    } catch {
      // próximo
    }
  }

  if (!clicado) {
    throw new Error("MENU_NAO_ENCONTRADO: botão '+ Novo Exame' não localizado");
  }

  // Após "+ Novo Exame", aparece o modal "Passe o cartão..."
  // O modal pode abrir em: (a) popup separado, (b) iframe, ou (c) modal embutido
  // Estratégia robusta: faz polling em TODAS as páginas do contexto e seus frames
  logger.info("aguardando modal 'Passe o cartão' (verificando todas as janelas/frames)");

  let pageDoCartao: Page | null = null;
  const inicioBusca = Date.now();
  const timeoutMs = config.navegacaoTimeout;

  while (Date.now() - inicioBusca < timeoutMs) {
    const todasPaginas = page.context().pages();
    logger.debug({ qtdPaginas: todasPaginas.length }, "varrendo páginas do contexto");

    for (const p of todasPaginas) {
      if (p.isClosed()) continue;

      try {
        const visivel = await p
          .locator('text=/Passe o|Se tiver problemas|virtual.*QR/i')
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);

        if (visivel) {
          pageDoCartao = p;
          logger.info(
            { url: p.url() },
            p === page
              ? "modal 'Passe o cartão' encontrado na página principal"
              : "modal 'Passe o cartão' encontrado em POPUP"
          );
          break;
        }

        for (const frame of p.frames()) {
          const visivelFrame = await frame
            .locator('text=/Passe o|Se tiver problemas|virtual.*QR/i')
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);

          if (visivelFrame) {
            pageDoCartao = p;
            logger.info({ frameUrl: frame.url() }, "modal 'Passe o cartão' encontrado em IFRAME");
            break;
          }
        }

        if (pageDoCartao) break;
      } catch {
        // continua
      }
    }

    if (pageDoCartao) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!pageDoCartao) {
    throw new Error("MODAL_NOVO_EXAME_NAO_ABRIU: modal 'Passe o cartão' não apareceu em nenhuma janela");
  }

  logger.info("clicando 'Se tiver problemas com o cartão, clique aqui'");

  let cliqueOk = false;
  try {
    const link = pageDoCartao.locator('a:has-text("clique aqui")');
    const count = await link.count();
    if (count > 0) {
      // Pega o PRIMEIRO 'clique aqui' (que é o "Se tiver problemas com o cartão")
      // Há dois links com o mesmo texto na tela; o primeiro é o que queremos
      await link.first().click({ timeout: config.clickTimeout });
      cliqueOk = true;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "falha ao clicar na page, tentando frames");
  }

  if (!cliqueOk) {
    for (const frame of pageDoCartao.frames()) {
      try {
        const link = frame.locator('a:has-text("clique aqui")');
        const count = await link.count();
        if (count > 0) {
          await link.first().click({ timeout: config.clickTimeout });
          cliqueOk = true;
          logger.info({ frameUrl: frame.url() }, "cliquei no link via frame");
          break;
        }
      } catch {
        // continua
      }
    }
  }

  if (!cliqueOk) {
    throw new Error("MODAL_NOVO_EXAME_NAO_ABRIU: link 'clique aqui' não foi clicável");
  }

  await pageDoCartao.waitForLoadState("networkidle").catch(() => {});

  // Após clicar 'clique aqui', aparece o modal "Problemas com o cartão"
  logger.info("aguardando modal de tipo de beneficiário (LOCAL/INTERCAMBIO)");

  let pageBeneficiario: Page = pageDoCartao;
  const inicioBeneficiario = Date.now();
  let achouBeneficiario = false;

  while (Date.now() - inicioBeneficiario < timeoutMs) {
    const todasPaginas = page.context().pages();
    for (const p of todasPaginas) {
      if (p.isClosed()) continue;

      const visivel = await p
        .locator('text=/Problemas com o|Localize o|Cadastre o/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (visivel) {
        pageBeneficiario = p;
        achouBeneficiario = true;
        logger.info({ url: p.url() }, "modal de tipo de beneficiário encontrado");
        break;
      }

      for (const frame of p.frames()) {
        const visivelFrame = await frame
          .locator('text=/Problemas com o|Localize o|Cadastre o/i')
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);

        if (visivelFrame) {
          pageBeneficiario = p;
          achouBeneficiario = true;
          logger.info({ frameUrl: frame.url() }, "modal de beneficiário em iframe");
          break;
        }
      }

      if (achouBeneficiario) break;
    }

    if (achouBeneficiario) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!achouBeneficiario) {
    throw new Error("MODAL_NOVO_EXAME_NAO_ABRIU: modal de tipo de beneficiário não apareceu");
  }

  if (input.paciente.tipo === "LOCAL") {
    await fluxoBeneficiarioLocal(pageBeneficiario, input, config);
  } else {
    await fluxoBeneficiarioIntercambio(pageBeneficiario, input, config);
  }

  // Após localizar/cadastrar, o portal pode ter:
  // (a) fechado o mini popup do cartão e aberto janela maior
  // (b) navegado a popup atual para a próxima tela
  // (c) navegado a página principal
  // Estratégia robusta: faz polling buscando "Digitação de guia SP/SADT" em
  // todas as páginas/frames disponíveis no momento.
  await new Promise((r) => setTimeout(r, 1500)); // dá tempo do portal estabilizar

  logger.info("buscando 'Digitação de guia SP/SADT' em todas as janelas");

  let pageDigitacao: Page | null = null;
  const inicioBuscaDig = Date.now();

  while (Date.now() - inicioBuscaDig < timeoutMs) {
    const todasPaginas = page.context().pages();
    logger.debug({ qtdPaginas: todasPaginas.length }, "varrendo para Digitação");

    // Detectar restrição administrativa (popup de bloqueio do SGU)
    for (const p of todasPaginas) {
      if (p.isClosed()) continue;
      try {
        const textoBody = await p.textContent("body", { timeout: 300 }).catch(() => "");
        if (textoBody?.includes("restrições administrativas") || textoBody?.includes("não pode realizar atendimentos") || textoBody?.includes("não liberada pela Unimed Origem")) {
          logger.error({ url: p.url() }, "beneficiário com restrição administrativa");
          throw new Error("BENEFICIARIO_RESTRICAO: Este beneficiário possui restrições administrativas e não pode realizar atendimentos. Consulta não liberada pela Unimed Origem.");
        }
      } catch (e) {
        if ((e as Error).message?.startsWith("BENEFICIARIO_RESTRICAO")) throw e;
      }
    }

    for (const p of todasPaginas) {
      if (p.isClosed()) continue;

      try {
        const visivel = await p
          .locator('a:has-text("SADT")')
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);

        if (visivel) {
          pageDigitacao = p;
          logger.info(
            { url: p.url() },
            "'Digitação de guia SP/SADT' encontrada"
          );
          break;
        }

        // tenta em iframes
        for (const frame of p.frames()) {
          const visivelFrame = await frame
            .locator('a:has-text("SADT")')
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);
          if (visivelFrame) {
            pageDigitacao = p;
            logger.info({ frameUrl: frame.url() }, "'Digitação' em iframe");
            break;
          }
        }

        if (pageDigitacao) break;
      } catch {
        // continua
      }
    }

    if (pageDigitacao) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!pageDigitacao) {
    throw new Error("BENEFICIARIO_NAO_LOCALIZADO: link 'Digitação de guia SP/SADT' não encontrado");
  }

  // Clica em "Digitação de guia SP/SADT"
  logger.info("clicando 'Digitação de guia SP/SADT'");
  await pageDigitacao
    .locator('a:has-text("SADT")')
    .first()
    .click({ timeout: config.clickTimeout });
  await pageDigitacao.waitForLoadState("networkidle").catch(() => {});

  // Após esse clique, pode aparecer modal "Selecione o tipo de digitação"
  // numa nova janela ou na mesma. Busca de novo.
  // Seletor diferente por tipo:
  // - LOCAL/padrão: "Digitar solicitação manualmente" (sem validação) — primeiro link
  // - INTERCAMBIO: "Autorizar solicitação" (com validação) — segundo link
  // A tela tem dois links com "manualmente"; o LOCAL pega o primeiro (sem senha),
  // o INTERCAMBIO precisa do segundo que faz a validação/autorização.
  const seletorManual = input.paciente.tipo === "INTERCAMBIO"
    ? 'a:has-text("Autorizar solicita"), a:has-text("realizar valida")'
    : 'a:has-text("manualmente")';

  logger.info({ seletorManual, tipo: input.paciente.tipo }, "buscando link de digitação");

  let pageManual: Page | null = null;
  const inicioBuscaManual = Date.now();

  while (Date.now() - inicioBuscaManual < timeoutMs) {
    const todasPaginas = page.context().pages();

    for (const p of todasPaginas) {
      if (p.isClosed()) continue;

      const visivel = await p
        .locator(seletorManual)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (visivel) {
        pageManual = p;
        logger.info({ url: p.url() }, "link de digitação encontrado");
        break;
      }

      for (const frame of p.frames()) {
        const visivelFrame = await frame
          .locator(seletorManual)
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);
        if (visivelFrame) {
          pageManual = p;
          break;
        }
      }

      if (pageManual) break;
    }

    if (pageManual) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!pageManual) {
    throw new Error("BENEFICIARIO_NAO_LOCALIZADO: link de digitação não encontrado");
  }

  logger.info({ tipo: input.paciente.tipo }, "clicando link de digitação");
  await pageManual
    .locator(seletorManual)
    .first()
    .click({ timeout: config.clickTimeout });
  await pageManual.waitForLoadState("networkidle").catch(() => {});

  // Após esse clique, abre o formulário grande "Digitação de guia SP/SADT"
  // que pode estar em popup grande, na principal ou em iframe.
  // Busca pelo título "Dados da Guia" ou "Dados do Beneficiário"
  await new Promise((r) => setTimeout(r, 2000)); // form é grande, dá tempo de carregar

  logger.info("buscando formulário grande (Dados da Guia/Beneficiário)");

  let pageFormulario: Page | null = null;
  const inicioBuscaForm = Date.now();

  while (Date.now() - inicioBuscaForm < timeoutMs) {
    const todasPaginas = page.context().pages();
    logger.debug({ qtdPaginas: todasPaginas.length }, "varrendo para formulário");

    for (const p of todasPaginas) {
      if (p.isClosed()) continue;

      try {
        // Busca pelo título "Dados da Guia" ou pelo label "Nome do Contratado"
        const visivel = await p
          .locator('text=/Dados da Guia|Dados do|Nome do Contratado/i')
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);

        if (visivel) {
          pageFormulario = p;
          logger.info(
            { url: p.url() },
            "formulário grande encontrado"
          );
          break;
        }

        for (const frame of p.frames()) {
          const visivelFrame = await frame
            .locator('text=/Dados da Guia|Dados do|Nome do Contratado/i')
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);
          if (visivelFrame) {
            pageFormulario = p;
            logger.info({ frameUrl: frame.url() }, "formulário em iframe");
            break;
          }
        }

        if (pageFormulario) break;
      } catch {
        // continua
      }
    }

    if (pageFormulario) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!pageFormulario) {
    throw new Error("BENEFICIARIO_NAO_LOCALIZADO: formulário de digitação não foi localizado após cliques");
  }

  logger.info({ url: pageFormulario.url() }, "formulário de digitação de guia aberto");

  // IMPORTANTE: retorna a página onde o formulário está aberto
  // para que os módulos seguintes (médico, procedimento, anexo, finalizar)
  // operem na janela correta.
  return pageFormulario;
}

async function fluxoBeneficiarioLocal(
  page: Page,
  input: InputAutorizacao,
  config: Config
): Promise<void> {
  logger.info({ tipo: "LOCAL" }, "iniciando fluxo de beneficiário local");

  await page
    .locator('a:has-text("Localize")')
    .first()
    .click({ timeout: config.clickTimeout });

  await page.waitForLoadState("networkidle");

  // Modal "Localizar beneficiário" abre.
  // Carteirinha LOCAL tem 17 dígitos divididos em 4 inputs:
  // - 4 dígitos (ex: 0025)
  // - 4 dígitos (ex: 5007)
  // - 6 dígitos (ex: 001295)
  // - 2 dígitos (ex: 00)
  const apenasDigitos = input.paciente.carteirinha_raw.replace(/\D/g, "");
  const parte1 = apenasDigitos.substring(0, 4);   // CD_UNIMED
  const parte2 = apenasDigitos.substring(4, 8);   // CD_CARTEIRA
  const parte3 = apenasDigitos.substring(8, 14);  // CD_FAMILIA
  const parte4 = apenasDigitos.substring(14, 16); // CD_DEPEN
  const parte5 = apenasDigitos.substring(16);     // DV (dígito verificador)

  logger.info({ partes: [parte1, parte2, parte3, parte4, parte5] }, "preenchendo carteirinha LOCAL");

  // Tenta achar os 4 inputs da carteirinha
  // Geralmente são inputs em sequência dentro de um campo "Número da Carteira"
  const inputsCarteira = page.locator('input[type="text"]').locator(
    'visible=true'
  );

  // Estratégia: pega todos os inputs visíveis no modal e preenche os 4 primeiros
  // Esta parte provavelmente vai precisar ser ajustada com seletores mais específicos
  // após inspecionar o DOM real
  const todosInputs = await page
    .locator('input[type="text"]:visible')
    .all();

  // Diagnóstico: listar todos os inputs com name, id, maxlength
  const inputInfo = [];
  for (let i = 0; i < todosInputs.length; i++) {
    const el = todosInputs[i];
    const name = await el.getAttribute("name").catch(() => null);
    const id = await el.getAttribute("id").catch(() => null);
    const maxlen = await el.getAttribute("maxlength").catch(() => null);
    const size = await el.getAttribute("size").catch(() => null);
    inputInfo.push({ i, name, id, maxlength: maxlen, size });
  }
  logger.info({ qtdInputs: todosInputs.length, inputs: inputInfo }, "inputs visíveis no modal LOCAL");

  // Preenche os inputs da carteirinha por name (mais confiável que posição)
  const fillByNameLocal = async (name: string, value: string) => {
    const el = page.locator(`input[name="${name}"]`);
    const vis = await el.isVisible({ timeout: 1000 }).catch(() => false);
    if (vis) {
      await el.fill(value);
      logger.info({ name, value }, `preencheu ${name}`);
      return true;
    }
    return false;
  };

  // Tenta por name primeiro (mais seguro)
  const porName =
    await fillByNameLocal("CD_UNIMED", parte1) &&
    await fillByNameLocal("CD_CARTAO", parte2) &&
    await fillByNameLocal("CD_BENEF", parte3) &&
    await fillByNameLocal("CD_DEPEN", parte4);

  if (porName) {
    // Tenta DV separado
    await fillByNameLocal("NR_DV", parte5);
    logger.info("preencheu por name");
  } else if (todosInputs.length >= 4) {
    // Fallback por posição (sem DV — igual ao que funcionava antes)
    await todosInputs[0].fill(parte1);
    await todosInputs[1].fill(parte2);
    await todosInputs[2].fill(parte3);
    await todosInputs[3].fill(parte4);
    logger.info("preencheu por posição (4 campos, sem DV)");
  } else {
    throw new Error(
      "BENEFICIARIO_NAO_LOCALIZADO: não encontrou inputs da carteirinha. " +
        `Encontrou ${todosInputs.length}. Ajuste seletores em beneficiario.ts`
    );
  }

  // Clica Localizar
  await page
    .locator('button:has-text("Localizar"), input[value="Localizar"]')
    .first()
    .click({ timeout: config.clickTimeout });

  await page.waitForLoadState("networkidle");

  // Verifica se beneficiário foi encontrado (busca pelo nome do paciente na página)
  try {
    await page.waitForSelector(`text=${input.paciente.nome}`, {
      timeout: config.clickTimeout,
    });
    logger.info("beneficiário local localizado");
  } catch {
    throw new Error(
      `BENEFICIARIO_NAO_LOCALIZADO: paciente "${input.paciente.nome}" não encontrado após busca por carteirinha`
    );
  }
}

async function fluxoBeneficiarioIntercambio(
  page: Page,
  input: InputAutorizacao,
  config: Config
): Promise<void> {
  logger.info({ tipo: "INTERCAMBIO" }, "iniciando fluxo de beneficiário intercâmbio");

  await page
    .locator('a:has-text("Cadastre")')
    .first()
    .click({ timeout: config.clickTimeout });

  await page.waitForLoadState("networkidle");

  // Modal "Verificar beneficiário"
  // O formulário de intercâmbio tem múltiplos inputs para a carteirinha:
  //   3 inputs: [Código Unimed 4] [Número 11] [Dígito verificador 2]  → total 17
  //   4 inputs: [4][4][6][2] + dígito verificador separado            → total 17
  //   1 input:  campo único (fallback — preenche tudo)
  logger.info("preenchendo carteirinha intercâmbio");

  const apenasDigitos = input.paciente.carteirinha_raw.replace(/\D/g, "");

  // Diagnóstico AMPLIADO: captura TODOS os elementos de formulário visíveis
  // (inputs de qualquer tipo + selects), não apenas input[type="text"]
  const todosElementos = await page.evaluate(() => {
    const result: Array<{
      i: number; tag: string; type: string | null; name: string | null;
      id: string | null; value: string | null; maxlength: string | null;
      options?: Array<{ value: string; text: string; selected: boolean }>;
    }> = [];
    const elements = document.querySelectorAll('input, select, textarea');
    let idx = 0;
    elements.forEach((el) => {
      const htmlEl = el as HTMLElement;
      const rect = htmlEl.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && htmlEl.offsetParent !== null;
      if (!visible) return;
      const info: typeof result[0] = {
        i: idx++,
        tag: el.tagName,
        type: (el as HTMLInputElement).type || null,
        name: el.getAttribute('name'),
        id: el.getAttribute('id'),
        value: (el as HTMLInputElement).value || null,
        maxlength: el.getAttribute('maxlength'),
      };
      if (el.tagName === 'SELECT') {
        info.options = Array.from((el as HTMLSelectElement).options).map(o => ({
          value: o.value, text: o.text, selected: o.selected,
        }));
      }
      result.push(info);
    });
    return result;
  });
  logger.info({ carteirinha: apenasDigitos, elementos: todosElementos }, "DIAGNÓSTICO AMPLIADO INTERCAMBIO");

  // Preenche pelo nome dos campos (mais robusto que por índice)
  // CD_BENEF = Código da Unimed do Beneficiário = primeiros 4 dígitos (ex: "0865")
  // CD_CARTAO = Número do beneficiário = dígitos 4-13 (10 dígitos)
  // CD_DEPEN  = Código dependente     = dígitos 14-15 (2 dígitos)
  // NR_DV     = Dígito verificador    = dígito 16 (1 dígito)
  // Total: 4+10+2+1 = 17 dígitos
  const fillByName = async (name: string, value: string) => {
    const loc = page.locator(`input[name="${name}"]`);
    const count = await loc.count();
    if (count > 0) {
      await loc.first().fill(value);
      logger.info({ name, value }, `preencheu ${name}`);
    } else {
      logger.warn({ name }, `campo ${name} não encontrado`);
    }
  };

  await fillByName("CD_UNIMED", apenasDigitos.substring(0, 4));   // "0865" — Código da Unimed do Beneficiário
  await fillByName("CD_CARTAO", apenasDigitos.substring(4, 8));   // "0004"
  await fillByName("CD_BENEF",  apenasDigitos.substring(8, 14));  // "475488"
  await fillByName("CD_DEPEN",  apenasDigitos.substring(14, 16)); // "01"
  await fillByName("NR_DV",     apenasDigitos.substring(16));     // "5"

  // Clica Verificar
  await page
    .locator('button:has-text("Verificar"), input[value="Verificar"]')
    .first()
    .click({ timeout: config.clickTimeout });

  await page.waitForLoadState("networkidle");

  // Após Verificar, há dois cenários possíveis:
  // A) Paciente NOVO: aparece "Cadastrar beneficiário externo" → clicar Atualizar
  // B) Paciente JÁ CADASTRADO: vai direto para lista de exames ou outra tela
  // Fazemos polling em todas as páginas do contexto buscando qualquer um dos sinais.
  logger.info("aguardando resultado pós-Verificar (novo ou já cadastrado)");

  let cenario: "novo" | "ja_cadastrado" | null = null;
  const inicioVerificar = Date.now();

  while (Date.now() - inicioVerificar < config.navegacaoTimeout) {
    const todasPaginas = page.context().pages();

    for (const p of todasPaginas) {
      if (p.isClosed()) continue;

      try {
        // Cenário A: paciente novo — tela "Cadastrar beneficiário externo"
        const telaNovoVisivel = await p
          .locator('text=/Cadastrar benefici|externo sem cart/i')
          .first()
          .isVisible({ timeout: 300 })
          .catch(() => false);

        if (telaNovoVisivel) {
          cenario = "novo";
          logger.info({ url: p.url() }, "cenário A: paciente novo (Cadastrar beneficiário externo)");
          // Clica Atualizar
          await p
            .locator('button:has-text("Atualizar"), input[value="Atualizar"]')
            .first()
            .click({ timeout: config.clickTimeout });
          await p.waitForLoadState("networkidle");
          logger.info("clicou Atualizar — beneficiário externo cadastrado");
          break;
        }

        // Cenário B: paciente já cadastrado — aparece lista de exames ou digitação
        const jaCadastrado = await p
          .locator('text=/Exames dispon|Digita.*guia SP|lista_guia|Localizar Guia/i')
          .first()
          .isVisible({ timeout: 300 })
          .catch(() => false);

        if (jaCadastrado) {
          cenario = "ja_cadastrado";
          logger.info({ url: p.url() }, "cenário B: paciente já cadastrado — pulando Atualizar");
          break;
        }
      } catch {
        // continua polling
      }
    }

    if (cenario) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!cenario) {
    // Dump para diagnóstico
    try {
      const fs = await import("fs");
      const pathMod = await import("path");
      const html = await page.content();
      fs.writeFileSync(pathMod.resolve("./dump-intercambio-verificar.html"), html, "utf-8");
      await page.screenshot({ path: pathMod.resolve("./dump-intercambio-verificar.png"), fullPage: true }).catch(() => {});
      logger.error({ url: page.url() }, "dump pós-Verificar salvo");
    } catch { /* ignora */ }

    throw new Error("INTERCAMBIO_VERIFICACAO_FALHOU: tela de cadastro externo não apareceu após Verificar. Veja dump-intercambio-verificar.html/.png");
  }

  logger.info({ cenario }, "beneficiário intercâmbio processado");
}
