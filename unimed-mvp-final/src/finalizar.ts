import { Page } from "playwright";
import { Config, InputAutorizacao } from "./types";
import { logger } from "./utils/logger";
import { capturarScreenshot } from "./utils/screenshot";

/**
 * Finaliza a autorização: clica Finalizar > Gerar autorização > captura número.
 */
export async function finalizarGuia(
  page: Page,
  config: Config,
  input: InputAutorizacao
): Promise<{
  numero_guia: string;
  data_autorizacao: string;
  screenshot_comprovante_path: string | null;
}> {
  logger.info("iniciando finalização da guia");

  // Verifica se o campo solicitante foi limpo pelo SGU (acontece após Atualizar procedimento)
  try {
    const solicitanteValor = await page.locator('#NM_PROFISSIONAL').inputValue().catch(() => "");
    if (!solicitanteValor.trim()) {
      logger.warn("campo NM_PROFISSIONAL foi limpo pelo SGU — precisaria re-preencher o médico");
    } else {
      logger.info({ solicitante: solicitanteValor }, "campo solicitante OK");
    }
  } catch {}

  // Garante profissional executante (psicólogo do paciente ou Luciano como default)
  await garantirProfissionalExecutante(page, config, input);

  // Clica "Finalizar e Gerar guia"
  logger.info("clicando 'Finalizar e Gerar guia'");
  await page.locator('#Botao_Finalizar, input[name="Botao_Finalizar"], input[value="Finalizar"]')
    .first()
    .click({ timeout: 60000 });

  // Portal pode demorar até 30s pra processar a finalização
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  // Aguarda tela de confirmação de sucesso
  // Sinais de sucesso: ícone verde + "Nº Guia: XXXXXXXX"
  logger.info("aguardando tela de sucesso com número da guia");

  // Aguarda o portal processar
  await new Promise((r) => setTimeout(r, 5000));

  // PRIMEIRO: detecta se há erro de validação visível.
  // Se houver, o número de #NR_GUIA é apenas RESERVA, não confirmação.
  // Mensagens típicas: faixa vermelha no topo do form com texto de erro.
  const conteudoInicial = await page.content();
  const padroesErro: { regex: RegExp; nome: string }[] = [
    { regex: /N[\u00e3a]o \u00e9 permitido/i, nome: "não é permitido" },
    { regex: /valor do campo .* (?:\u00e9 inv|invalid|obrigat)/i, nome: "campo inválido/obrigatório" },
    { regex: /preench(?:a|er) (?:o|os) campo/i, nome: "preencher campo" },
    { regex: /campo.*obrigat\u00f3rio/i, nome: "campo obrigatório" },
    { regex: /Existem erros/i, nome: "existem erros" },
  ];

  for (const { regex, nome } of padroesErro) {
    const match = conteudoInicial.match(regex);
    if (match) {
      // Pega contexto ao redor do erro
      const idx = match.index || 0;
      const trecho = conteudoInicial
        .substring(Math.max(0, idx - 100), idx + 400)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      logger.error({ tipoErro: nome, trecho }, "erro de validação detectado pelo portal");

      // Dump pra inspeção
      try {
        const fs = await import("fs");
        const pathMod = await import("path");
        const dumpPath = pathMod.resolve("./dump-finalizacao.html");
        fs.writeFileSync(dumpPath, conteudoInicial, "utf-8");
        const screenshotPath = pathMod.resolve("./dump-finalizacao.png");
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info({ dumpPath, screenshotPath }, "dump da tela de erro salvo");
      } catch {
        // ignora
      }

      throw new Error(`FINALIZACAO_FALHOU: portal rejeitou a finalização. Mensagem: "${trecho}". A guia NÃO foi salva.`);
    }
  }

  let numeroGuia: string | null = null;
  let senhaAutorizacao: string | null = null;
  let situacaoGuia: "APROVADO" | "EM_ANALISE" | "NEGADA" = "APROVADO";

  // ESTRATÉGIA 0: detecta tela de "Lista de guias de solicitação" (página de sucesso pós-geração).
  // Quando o portal redireciona para /exames/novo/lista_impressao.do, mostra:
  //   "Operação realizada com sucesso!"
  //   tabela com colunas Data Solicitação | Nº Guia | Situação | Tipo | Senha de Autorização | ...
  // Aguarda essa tela aparecer e extrai o número da tabela.
  try {
    await page.waitForFunction(
      () => {
        const texto = document.body.innerText || "";
        return /Opera[\u00e7c][\u00e3a]o realizada com sucesso/i.test(texto);
      },
      { timeout: 5000 }
    );
    logger.info("tela 'Operação realizada com sucesso' detectada");

    // Tenta capturar número da guia por múltiplos seletores
    // 1) Link com id #linkNrGuia (guias autorizadas/em execução)
    let numero = await page
      .locator('#linkNrGuia')
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => null);

    // 2) Link com classe MagnetoDataLink na tabela de resultados
    if (!numero || !/^\d{8,}$/.test(numero.trim())) {
      numero = await page
        .locator('td.MagnetoDataTD a.MagnetoDataLink')
        .first()
        .textContent({ timeout: 2000 })
        .catch(() => null);
    }

    // 3) TD com número de 8+ dígitos (guias em estudo — sem link, só texto no TD)
    if (!numero || !/^\d{8,}$/.test(numero.trim())) {
      const tds = await page.locator('td.MagnetoDataTD').allTextContents().catch(() => []);
      for (const td of tds) {
        const clean = td.trim();
        if (/^\d{8,}$/.test(clean)) {
          numero = clean;
          break;
        }
      }
    }

    if (numero && /^\d{8,}$/.test(numero.trim())) {
      numeroGuia = numero.trim();
      logger.info({ numeroGuia, fonte: "tabela sucesso" }, "número da guia capturado");
    }

    // Captura senha de autorização também (5ª td da linha de dados)
    if (numeroGuia) {
      try {
        // Senha aparece como número de 7 dígitos numa td logo após "SP/SADT"
        const conteudoSucesso = await page.content();
        const matchSenha = conteudoSucesso.match(/SP\/SADT[\s\S]*?<td[^>]*>(\d{6,8})/i);
        if (matchSenha) {
          senhaAutorizacao = matchSenha[1];
          logger.info({ senha: senhaAutorizacao }, "senha de autorização capturada");
        }

        // Detecta situação da guia.
        // Coluna "Situação" aparece logo após o número da guia. Pode conter:
        //   "Em execução" → guia aprovada (status APROVADO)
        //   "Em estudo" ou "Em análise" → guia gerada mas aguardando análise (status EM_ANALISE)
        //   "Negado" → guia negada pela Unimed (status NEGADA)
        // Buscamos o trecho próximo ao linkNrGuia ou no conteúdo geral da tabela.

        // Primeiro: detectar NEGADO (prioridade — evita cadastrar guia ativa por engano)
        const matchNegado = conteudoSucesso.match(
          /(?:linkNrGuia[\s\S]{0,500}?)?<span>\s*(Negad[ao]|Recusad[ao]|N[ãa]o\s+autorizad[ao]|Cancelad[ao])\s*<\/span>/i
        ) || conteudoSucesso.match(
          /Situa[çc][ãa]o[\s\S]{0,200}?(Negad[ao]|Recusad[ao])/i
        );
        if (matchNegado) {
          situacaoGuia = "NEGADA";
          logger.error(
            { texto_situacao: matchNegado[1] },
            "guia NEGADA pela Unimed"
          );
        } else {
          // Segundo: detectar EM ANÁLISE
          const matchEmAnalise = conteudoSucesso.match(
            /(?:linkNrGuia[\s\S]{0,500}?)?<span>\s*(Em\s+(?:estudo|an[áa]lise))\s*<\/span>/i
          ) || conteudoSucesso.match(
            /Situa[çc][ãa]o[\s\S]{0,200}?(Em\s+(?:estudo|an[áa]lise))/i
          );
          if (matchEmAnalise) {
            situacaoGuia = "EM_ANALISE";
            logger.warn(
              { texto_situacao: matchEmAnalise[1] },
              "guia ficou EM ANÁLISE — Unimed precisa aprovar manualmente"
            );
          } else {
            const matchEmExecucao = conteudoSucesso.match(
              /linkNrGuia[\s\S]{0,500}?<span>\s*Em\s+execu[çc][ãa]o\s*<\/span>/i
            );
            if (matchEmExecucao) {
              situacaoGuia = "APROVADO";
              logger.info("guia autorizada — situação EM EXECUÇÃO");
            } else {
              // Não achou nenhum — assumir EM_ANALISE por segurança (melhor pedir revisão do que liberar indevidamente)
              situacaoGuia = "EM_ANALISE";
              logger.warn("situação da guia não detectada no HTML, assumindo EM_ANALISE por segurança");
            }
          }
        }
      } catch {
        // ignora se não achar senha/situação
      }
    }
  } catch {
    logger.debug("tela de sucesso não detectada — tentando outras estratégias");
  }

  // ESTRATÉGIA 1: input #NR_GUIA (caso ainda esteja no formulário antigo)
  if (!numeroGuia) {
    try {
      const valor = await page.locator('#NR_GUIA').inputValue({ timeout: 2000 });
      if (valor && /^\d{8,}$/.test(valor)) {
        numeroGuia = valor;
        logger.info({ numeroGuia, fonte: "#NR_GUIA" }, "número da guia capturado");
      }
    } catch {
      logger.debug("#NR_GUIA não encontrado ou vazio");
    }
  }

  // ESTRATÉGIA 2: regex no texto da página
  if (!numeroGuia) {
    try {
      const conteudo = await page.content();
      const match = conteudo.match(/N[\u00ba\u00b0o]\s*Guia[:\s]*(\d{8,})/i);
      if (match) {
        numeroGuia = match[1];
        logger.info({ numeroGuia, fonte: "regex texto" }, "número da guia capturado");
      }
    } catch {
      logger.debug("regex no texto falhou");
    }
  }

  // ESTRATÉGIA 3: aguarda mensagem de sucesso ou redirecionamento
  if (!numeroGuia) {
    try {
      await page.waitForFunction(
        () => {
          const texto = document.body.innerText;
          const match = texto.match(/N[\u00ba\u00b0o]\s*Guia[:\s]*(\d{8,})|guia.*(\d{8,})/i);
          return match !== null;
        },
        { timeout: 10000 }
      );

      const conteudo = await page.content();
      const match = conteudo.match(/N[\u00ba\u00b0o]\s*Guia[:\s]*(\d{8,})|guia.*?(\d{8,})/i);
      numeroGuia = match?.[1] || match?.[2] || null;
      if (numeroGuia) {
        logger.info({ numeroGuia, fonte: "waitForFunction" }, "número da guia capturado");
      }
    } catch {
      logger.error("timeout esperando número da guia aparecer");
    }
  }

  // Verifica se houve algum indicador de erro de validação
  const temErroValidacao = await page
    .locator('text=/Existem erros|campo.*obrigat|valor.*inv\u00e1lido|n\u00e3o foi poss\u00edvel/i')
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (temErroValidacao) {
    logger.warn("portal exibiu mensagem de erro/validação");
  }

  // === DUMP da tela de sucesso (SEMPRE, para diagnóstico da situação) ===
  try {
    const fs = await import("fs");
    const pathMod = await import("path");
    const html = await page.content();
    const dumpPath = pathMod.resolve("./dump-sucesso.html");
    fs.writeFileSync(dumpPath, html, "utf-8");
    const screenshotPath = pathMod.resolve("./dump-sucesso.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    logger.info({ dumpPath, screenshotPath, situacaoGuia, numeroGuia }, "dump da tela de sucesso salvo");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "falha ao dumpar tela de sucesso");
  }

  // === DUMP adicional se falhou capturar número ===
  if (!numeroGuia) {
    try {
      const fs = await import("fs");
      const pathMod = await import("path");
      const html = await page.content();
      const dumpPath = pathMod.resolve("./dump-finalizacao.html");
      fs.writeFileSync(dumpPath, html, "utf-8");
      const screenshotPath = pathMod.resolve("./dump-finalizacao.png");
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info({ dumpPath, screenshotPath }, "dump da finalização salvo");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "falha ao dumpar finalização");
    }
  }

  if (!numeroGuia) {
    const screenshotErro = await capturarScreenshot(
      page,
      "finalizacao_falhou",
      config.screenshotDir
    );
    throw new Error(
      `FINALIZACAO_FALHOU: número da guia não capturado. Screenshot: ${screenshotErro}. URL atual: ${page.url()}`
    );
  }

  logger.info({ numeroGuia }, "guia gerada com sucesso");

  // Captura screenshot do comprovante
  const screenshotPath = await capturarScreenshot(
    page,
    `sucesso_${numeroGuia}`,
    config.screenshotDir
  );

  const dataAutorizacao = new Date().toISOString().split("T")[0];

  return {
    numero_guia: numeroGuia,
    data_autorizacao: dataAutorizacao,
    screenshot_comprovante_path: screenshotPath,
    senha_autorizacao: senhaAutorizacao,
    situacao: situacaoGuia,
  };
}

async function garantirProfissionalExecutante(page: Page, config: Config, input: InputAutorizacao): Promise<void> {
  if (!input.psicologo_executante_nome) {
    throw new Error(
      "FINALIZACAO_FALHOU: psicologo_executante_nome não informado. " +
      "Não é permitido usar fallback para Luciano — o psicólogo correto deve ser selecionado no CRM."
    );
  }
  const nomeBusca = input.psicologo_executante_nome;
  logger.info({ nomeBusca }, "garantindo profissional executante");

  // Acha dinamicamente o select que tem opção com o nome do psicólogo
  // Normaliza acentos (CRM pode ter "Débora", SGU tem "DEBORA")
  // Normaliza fora do evaluate e passa os termos já prontos
  const stripAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const termosNormalizados = stripAccents(nomeBusca).split(/\s+/);

  const resultado = await page.evaluate((termos) => {
    function strip(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(); }
    var selects = document.querySelectorAll('select');
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      for (var j = 0; j < sel.options.length; j++) {
        var o = sel.options[j];
        var textoNorm = strip(o.text);
        var ok = true;
        for (var k = 0; k < termos.length; k++) {
          if (textoNorm.indexOf(termos[k]) === -1) { ok = false; break; }
        }
        if (ok) {
          return {
            name: sel.getAttribute('name'),
            id: sel.getAttribute('id'),
            value: o.value,
            text: o.text,
          };
        }
      }
    }
      if (match) {
        return {
          name: sel.getAttribute('name'),
          id: sel.getAttribute('id'),
          value: match.value,
          text: match.text,
        };
      }
    }
    return null;
  }, termosNormalizados);

  if (!resultado) {
    // CRÍTICO: não pode continuar com executante errado (SGU default = primeiro da lista)
    throw new Error(
      `FINALIZACAO_FALHOU: profissional executante "${nomeBusca}" não encontrado no select do SGU. ` +
      `Verifique se o psicólogo está cadastrado como profissional na Unimed.`
    );
  }

  logger.info({ resultado }, "select do profissional executante encontrado");
  const seletor = resultado.id
    ? `#${resultado.id}`
    : `select[name="${resultado.name}"]`;
  await page.locator(seletor).selectOption({ value: resultado.value });
  logger.info({ seletor, value: resultado.value, text: resultado.text }, "profissional executante selecionado");

  // Aguarda Botao_Finalizar aparecer (fica oculto até escolher executante)
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('#Botao_Finalizar') as HTMLInputElement | null;
      if (!btn) return false;
      const rect = btn.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
    { timeout: 10000 }
  ).catch(() => {
    logger.warn("Botao_Finalizar não apareceu após selecionar executante");
  });
}
