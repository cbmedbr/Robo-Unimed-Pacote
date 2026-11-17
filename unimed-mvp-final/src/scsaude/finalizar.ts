import path from "path";
import { Page } from "playwright";
import { logger } from "../utils/logger";
import { ConfigScSaude, ErroScSaude, ResultadoScSaude, SituacaoScSaude } from "./tipos";
import { apareceu, fecharInformativos } from "./portal";

/**
 * Envia a solicitação e lê o resultado.
 *
 * Sequência, mapeada com duas autorizações reais em 16/10/2026:
 *
 *   Solicitar Autorização
 *     → modal "Alertas"                  → "OK, entendi"      (quando há alerta)
 *     → modal "Resultado da Autorização"
 *          → "Guia Autorizada"           → "Finalizar e Gerar a Guia"
 *               → tela "Guia Capturada"  ← número, senha e validade
 *
 * O estado é lido pela **faixa no topo da página**, não pela URL. A quebra da
 * execução da Unimed em 14/10 foi exatamente isto: a URL mudou e o robô parou
 * de reconhecer a tela. O texto da faixa é o que a operadora precisa manter,
 * porque é o que a pessoa lê.
 */
/**
 * Modo conferência: para antes de solicitar e espera a pessoa decidir.
 *
 * Decidido pela operação em 27/10/2026. Emitir autorização é **irreversível**:
 * um dado errado só aparece quando a guia já existe no portal da operadora, e
 * aí o conserto é manual e caro. O robô faz o trabalho chato — achar o
 * paciente, o médico, o contratado, digitar e anexar — e devolve a decisão de
 * enviar para quem responde por ela.
 *
 * Depois que a pessoa clica, o robô volta a trabalhar: lê o resultado e a tela
 * de Guia Capturada, para o CRM não ficar sem o número, a senha e a validade.
 */
async function aguardarConferenciaHumana(
  page: Page,
  config: ConfigScSaude,
  jobId: string
): Promise<ResultadoScSaude> {
  const minutos = Math.round(config.esperaConferenciaMs / 60000);

  console.log(`
============================================================
  GUIA PREENCHIDA — FALTA VOCE CONFERIR

  O robo preencheu tudo e PAROU de proposito. Nada foi
  enviado para o SC Saude ainda.

  1. Confira os dados na tela.
  2. Se estiver certo, clique em SOLICITAR AUTORIZACAO.
  3. Siga ate o fim (Finalizar e Gerar a Guia).

  O robo espera ${minutos} minutos e, assim que a guia sair,
  anota sozinho o numero, a senha e a validade no sistema.

  Se algo estiver errado, basta fechar a janela: nada foi
  enviado e nenhuma guia foi criada.
============================================================
`);

  logger.info({ jobId, esperaMs: config.esperaConferenciaMs }, "aguardando conferência humana");

  const inicio = Date.now();

  while (Date.now() - inicio < config.esperaConferenciaMs) {
    if (page.isClosed()) {
      return {
        sucesso: false,
        situacao: "AGUARDANDO_CONFERENCIA",
        erro_codigo: "CONFERENCIA_CANCELADA",
        erro_mensagem:
          "A janela foi fechada durante a conferência. Nada foi enviado ao SC Saúde e nenhuma " +
          "guia foi criada — o pedido pode ser refeito sem risco de duplicidade.",
      };
    }

    const estado = await lerSituacaoNaTela(page);

    if (estado?.situacao === "AUTORIZADA") {
      logger.info("a pessoa concluiu a solicitação — lendo a guia");
      const dados = await lerGuiaCapturada(page, config);
      const print = await capturar(page, config, `scsaude-guia-${dados.numero_guia ?? jobId}`);
      return { sucesso: true, situacao: "AUTORIZADA", comprovante_path: print, ...dados };
    }

    // A guia pode ir para análise também pelas mãos da pessoa — e este é o
    // caminho que roda de verdade, porque a conferência manual é o padrão.
    // Sem este ramo o robô ficava girando até estourar os minutos de espera e
    // devolvia CONFERENCIA_NAO_CONCLUIDA: a guia existia na operadora e o CRM
    // não ficava sabendo.
    if (estado?.situacao === "EM_ANALISE") {
      return resultadoEmAnalise(page, config, jobId, estado.pendencia, []);
    }

    if (estado?.situacao === "NEGADA") {
      return {
        sucesso: false,
        situacao: "NEGADA",
        erro_codigo: "GUIA_NEGADA",
        erro_mensagem: "O SC Saúde negou a solicitação.",
      };
    }

    await page.waitForTimeout(3000);
  }

  const print = await capturar(page, config, `scsaude-conferencia-expirou-${jobId}`);
  return {
    sucesso: false,
    situacao: "AGUARDANDO_CONFERENCIA",
    comprovante_path: print,
    erro_codigo: "CONFERENCIA_NAO_CONCLUIDA",
    erro_mensagem:
      `A guia foi preenchida e ficou ${minutos} minutos esperando conferência sem ser concluída. ` +
      "A janela continua aberta: dá para terminar à mão. Se a guia foi gerada depois disso, " +
      "ela existe no portal mesmo que o sistema não tenha anotado — confira antes de pedir de novo.",
  };
}

export async function solicitarEGerarGuia(
  page: Page,
  config: ConfigScSaude,
  jobId: string
): Promise<ResultadoScSaude> {
  await fecharInformativos(page);

  // Para aqui quando a conferência é manual — que é o padrão.
  if (config.conferenciaManual) {
    return aguardarConferenciaHumana(page, config, jobId);
  }

  // --- Solicitar Autorização ---
  const botaoSolicitar = page
    .locator('a:has-text("Solicitar Autorização"), button:has-text("Solicitar Autorização")')
    .first();

  if (!(await apareceu(botaoSolicitar, 10000))) {
    throw new ErroScSaude(
      "SOLICITAR_BOTAO_NAO_ENCONTRADO",
      'Não achei o botão "Solicitar Autorização" na barra da guia.'
    );
  }

  logger.info("clicando 'Solicitar Autorização'");
  await botaoSolicitar.click({ timeout: config.clickTimeout });
  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});

  // --- modal "Alertas" (quando houver) ---
  //
  // Alerta NÃO impede a autorização: nos dois casos reais a guia saiu
  // autorizada com SCAUT_0152 presente. Por isso aqui só se registra e segue.
  const alertas = await lerEFecharAlertas(page);

  // --- modal "Resultado da Autorização" ---
  const situacao = await lerResultado(page, config);

  if (situacao.situacao === "NEGADA") {
    return {
      sucesso: false,
      situacao: "NEGADA",
      alertas,
      erro_codigo: "GUIA_NEGADA",
      erro_mensagem: "O SC Saúde negou a solicitação.",
    };
  }

  if (situacao.situacao === "EM_ANALISE") {
    return resultadoEmAnalise(page, config, jobId, situacao.pendencia, alertas);
  }

  // --- Finalizar e Gerar a Guia ---
  const botaoGerar = page
    .locator(
      'button:has-text("Finalizar e Gerar a Guia"), a:has-text("Finalizar e Gerar a Guia"), ' +
        'input[value="Finalizar e Gerar a Guia"]'
    )
    .first();

  if (!(await apareceu(botaoGerar, 10000))) {
    throw new ErroScSaude(
      "GERAR_GUIA_NAO_ENCONTRADO",
      'A guia foi autorizada mas não achei o botão "Finalizar e Gerar a Guia". ' +
        "Sem ele a guia NÃO é criada — a autorização sozinha não basta."
    );
  }

  logger.info("clicando 'Finalizar e Gerar a Guia'");
  await botaoGerar.click({ timeout: config.clickTimeout });
  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});

  // --- tela "Guia Capturada" ---
  const dados = await lerGuiaCapturada(page, config);
  const print = await capturar(page, config, `scsaude-guia-${dados.numero_guia ?? jobId}`);

  return {
    sucesso: true,
    situacao: "AUTORIZADA",
    alertas,
    comprovante_path: print,
    ...dados,
  };
}

// ---------------------------------------------------------------------------

/**
 * Situacoes que o portal pode mostrar depois que a solicitacao foi enviada.
 *
 * Os rotulos saem do filtro de situacao do portal (SCSAUDE_PORTAL.md, secao 6).
 * Quatro deles **nao sao espera**: a guia parou porque falta alguma coisa do
 * nosso lado. Eles vao para conferencia humana igual a analise, mas com texto
 * dizendo o que fazer — tratar tudo como "em analise" faria a clinica esperar
 * por algo que nunca chega sozinho.
 */
const PENDENCIAS: { regex: RegExp; oQueFazer: string }[] = [
  {
    regex: /Aguardando\s+justificativa\s+t[ée]cnica/i,
    oQueFazer:
      "a auditoria pediu justificativa técnica. Responda por *Mensagens Guia*, dentro da guia.",
  },
  {
    regex: /Aguardando\s+documenta[çc][ãa]o/i,
    oQueFazer: "a auditoria pediu documento. Use *Anexar Documentos*, dentro da guia.",
  },
  {
    regex: /Aguardando\s+retorno\s+do\s+prestador/i,
    oQueFazer: "a auditoria está esperando retorno nosso. Veja *Mensagens Guia*, dentro da guia.",
  },
  { regex: /Per[íi]cia/i, oQueFazer: "a guia foi para perícia. O prazo é da operadora." },
];

/**
 * Le a situacao da guia na tela aberta.
 *
 * Devolve `null` quando a tela ainda nao decidiu nada — e o que permite usar
 * isto dentro de um laco de espera.
 *
 * **Por que o botao entra na conta:** o texto "Em analise" sozinho nao serve
 * de marcador. Antes de enviar, a tela e o formulario, que tem *Solicitar
 * Autorizacao*; na guia em analise esse botao some (SCSAUDE_PORTAL.md, 13.3).
 * Exigir a ausencia dele evita dar a guia por enviada enquanto a pessoa ainda
 * esta conferindo.
 */
export async function lerSituacaoNaTela(
  page: Page
): Promise<{ situacao: SituacaoScSaude; pendencia: string | null } | null> {
  const texto = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(
    /\s+/g,
    " "
  );

  if (/Guia\s+Capturada/i.test(texto)) return { situacao: "AUTORIZADA", pendencia: null };
  if (/Guia\s+Negada|Solicita[çc][ãa]o\s+Negada/i.test(texto)) {
    return { situacao: "NEGADA", pendencia: null };
  }

  const aindaPodeSolicitar = await page
    .locator('a:has-text("Solicitar Autorização"), button:has-text("Solicitar Autorização")')
    .first()
    .isVisible()
    .catch(() => false);

  if (aindaPodeSolicitar) return null;

  for (const { regex, oQueFazer } of PENDENCIAS) {
    if (regex.test(texto)) return { situacao: "EM_ANALISE", pendencia: oQueFazer };
  }

  if (/Em\s+an[áa]lise|Guia\s+em\s+an[áa]lise/i.test(texto)) {
    return { situacao: "EM_ANALISE", pendencia: null };
  }

  if (/Guia\s+Autorizada/i.test(texto)) return { situacao: "AUTORIZADA", pendencia: null };

  return null;
}

/**
 * Monta o resultado de uma guia que foi para analise.
 *
 * **Isto e sucesso, nao erro.** A solicitacao chegou a operadora e a guia
 * existe no portal — so falta a auditoria decidir. Para a sessao ABA
 * (`13107208`) a analise e o caminho NORMAL, nao a excecao
 * (SCSAUDE_PORTAL.md, 13.1): devolver erro encheria o CRM de alarme falso em
 * todo pedido atipico.
 *
 * O desfecho vai para o CRM como `EM_ANALISE`, o mesmo estado que a Unimed ja
 * produz — a guia nasce em `guias` com `status = em_analise` e fica esperando
 * alguem conferir. O robo nao acompanha: consultar guia em analise no SC Saude
 * nao esta automatizado.
 */
async function resultadoEmAnalise(
  page: Page,
  config: ConfigScSaude,
  jobId: string,
  pendencia: string | null,
  alertas: string[]
): Promise<ResultadoScSaude> {
  const numero = await lerNumeroDaGuia(page);
  const print = await capturar(page, config, `scsaude-em-analise-${numero ?? jobId}`);

  const comoAchar = numero
    ? `A guia é a nº ${numero}.`
    : "Não consegui ler o número da guia na tela — procure em *Meus Atendimentos* pelo " +
      "beneficiário e pela data de hoje.";

  logger.info({ jobId, numero, pendencia }, "guia foi para análise");

  return {
    sucesso: true,
    situacao: "EM_ANALISE",
    numero_guia: numero,
    // Em analise nao existe senha: e justamente o marcador mais confiavel do
    // estado (SCSAUDE_PORTAL.md, 13.2). Explicito para ninguem ler a ausencia
    // como falha de leitura.
    senha: null,
    validade_senha: null,
    alertas,
    comprovante_path: print,
    observacao:
      "A guia foi enviada e está EM ANÁLISE na operadora — não há senha ainda. " +
      comoAchar +
      (pendencia
        ? ` ATENÇÃO, isto não é só esperar: ${pendencia}`
        : " Não é preciso refazer o pedido; alguém precisa acompanhar no portal até a auditoria decidir."),
  };
}

/**
 * Numero da guia, por rotulo, sem falhar quando nao acha.
 *
 * A tela da guia em analise nunca foi vista em execucao real — so em modo
 * somente-leitura, em 27/10/2026. Entao aqui nao se inventa seletor: tenta os
 * rotulos conhecidos e, nao achando, devolve `null`, e a mensagem manda
 * procurar pelo beneficiario. Guia sem numero e pior de achar, mas e melhor do
 * que o robo falhar numa guia que a operadora ja recebeu.
 */
export async function lerNumeroDaGuia(page: Page): Promise<string | null> {
  const texto = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(
    /[ \t]+/g,
    " "
  );

  for (const rotulo of [
    /N[úu]mero da Guia\s*:?\s*([0-9]{4,})/i,
    /N[ºo°]\s*Guia\s*:?\s*([0-9]{4,})/i,
    /Guia\s*:?\s*([0-9]{8,})/i,
  ]) {
    const m = texto.match(rotulo);
    if (m) return m[1].trim();
  }

  return null;
}

async function lerEFecharAlertas(page: Page): Promise<string[]> {
  const modal = page.locator('.modal:visible:has-text("A guia solicitada possui alertas")').first();

  // O modal de alertas chega depois do AJAX da solicitação. Ausência aqui
  // significa "não houve alerta", que é caso normal — por isso só devolve
  // lista vazia em vez de falhar.
  if (!(await apareceu(modal, 6000))) return [];

  const texto = ((await modal.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const codigos = [...texto.matchAll(/SCAUT_\d+/g)].map((m) => m[0]);
  const alertas = [...new Set(codigos)];

  logger.warn({ alertas, texto: texto.slice(0, 300) }, "o portal acusou alertas na guia");

  const ok = modal.locator('button:has-text("OK, entendi"), a:has-text("OK, entendi")').first();
  if (await apareceu(ok, 3000)) {
    await ok.click();
    await page.waitForTimeout(1500);
  }

  return alertas.length ? alertas : ["(alerta sem código reconhecido)"];
}

/**
 * Lê o resultado da autorização.
 *
 * Procura primeiro no modal "Resultado da Autorização"; se ele já tiver sido
 * fechado, cai para a faixa no topo da página, que carrega o mesmo estado.
 */
async function lerResultado(
  page: Page,
  config: ConfigScSaude
): Promise<{ situacao: SituacaoScSaude; pendencia: string | null }> {
  const inicio = Date.now();

  while (Date.now() - inicio < config.navegacaoTimeout) {
    const estado = await lerSituacaoNaTela(page);
    if (estado) return estado;

    await page.waitForTimeout(1500);
  }

  throw new ErroScSaude(
    "RESULTADO_NAO_RECONHECIDO",
    'Cliquei em "Solicitar Autorização" mas não reconheci o resultado na tela — nem autorizada, ' +
      "nem em análise, nem negada. A solicitação pode ou não ter sido enviada: confira no portal " +
      "antes de repetir."
  );
}

/**
 * Extrai número da guia, senha e validade da tela "Guia Capturada".
 *
 * Lê por rótulo, varrendo o texto da página: a tela é um resumo com pares
 * rótulo/valor, e depender da posição exata das células quebraria no primeiro
 * ajuste de layout.
 */
async function lerGuiaCapturada(
  page: Page,
  config: ConfigScSaude
): Promise<Pick<ResultadoScSaude, "numero_guia" | "senha" | "validade_senha" | "data_solicitacao">> {
  const inicio = Date.now();

  while (Date.now() - inicio < config.navegacaoTimeout) {
    const texto = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(
      /[ \t]+/g,
      " "
    );

    if (/Guia\s+Capturada/i.test(texto)) {
      const pegar = (rotulo: RegExp) => {
        const m = texto.match(rotulo);
        return m ? m[1].trim() : null;
      };

      const dados = {
        numero_guia: pegar(/N[úu]mero da Guia\s*:?\s*([0-9]+)/i),
        senha: pegar(/Senha\s*:?\s*([0-9]+)/i),
        validade_senha: pegar(/Validade da Senha\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i),
        data_solicitacao: pegar(/Data da Solicita[çc][ãa]o\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i),
      };

      if (!dados.numero_guia) {
        throw new ErroScSaude(
          "NUMERO_GUIA_NAO_CAPTURADO",
          'A tela "Guia Capturada" apareceu mas não consegui ler o número da guia. ' +
            "A guia existe no portal — não repita o pedido, busque o número à mão."
        );
      }

      logger.info(dados, "guia capturada");
      return dados;
    }

    await page.waitForTimeout(1500);
  }

  throw new ErroScSaude(
    "GUIA_NAO_CAPTURADA",
    'Cliquei em "Finalizar e Gerar a Guia" mas a tela "Guia Capturada" não apareceu. ' +
      "A guia pode ter sido criada — confira em Meus Atendimentos antes de repetir."
  );
}

async function capturar(page: Page, config: ConfigScSaude, nome: string): Promise<string | null> {
  const destino = path.join(config.screenshotDir, "comprovantes", `${nome}-${Date.now()}.png`);
  try {
    await page.screenshot({ path: destino, fullPage: true });
    return destino;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "não consegui salvar o comprovante");
    return null;
  }
}
