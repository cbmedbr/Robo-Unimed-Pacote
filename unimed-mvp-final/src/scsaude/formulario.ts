import { Page } from "playwright";
import { logger } from "../utils/logger";
import { ConfigScSaude, ErroScSaude, InputAutorizacaoScSaude } from "./tipos";
import { fecharInformativos, lerCampo, typeahead } from "./portal";

const P = "form-principal:";
const LINHA_PROC = `${P}procedimentos-solicitados-list:tabelaProcedimentos:0:`;

/** Prestador genérico do portal, usado quando o local do médico não tem cadastro. */
const CONSULTORIO_GENERICO = /CONSULTORIO/i;

/**
 * Preenche a guia. Não envia nada — quem envia é `finalizar.ts`.
 *
 * O que já vem pronto e NÃO se mexe (confirmado com caso real em 29/09/2026):
 * carteirinha, nome e CNS do beneficiário; "Atend. a RN" já em Não; data da
 * solicitação já com a data de hoje. Mexer nesses campos só cria caminho para
 * quebrar.
 */
export async function preencherFormulario(
  page: Page,
  input: InputAutorizacaoScSaude,
  config: ConfigScSaude
): Promise<void> {
  await fecharInformativos(page);

  await preencherMedico(page, input);
  await conferirCbos(page);
  await preencherContratado(page, input);
  await preencherCaraterEIndicacao(page, input);
  await preencherProcedimento(page, input, config);

  logger.info("formulário preenchido");
}

// ---------------------------------------------------------------------------

/**
 * Profissional solicitante, por nome.
 *
 * Escolher o profissional faz o portal preencher sozinho conselho, número, UF
 * e CBOS. Se o nome não achar, tenta pelo número do conselho — que é o outro
 * caminho que o SOP prevê.
 */
async function preencherMedico(page: Page, input: InputAutorizacaoScSaude): Promise<void> {
  const { nome, numero_conselho } = input.medico_solicitante;

  let escolhido = await typeahead(
    page,
    `input[name="${P}nomeProfissionalSolicitante:value"]`,
    nome,
    "profissional solicitante (por nome)"
  );

  if (!escolhido && numero_conselho) {
    logger.warn({ nome }, "médico não encontrado pelo nome — tentando pelo número do conselho");
    escolhido = await typeahead(
      page,
      `input[name="${P}numConselhoProfissionalSolicitante:value"]`,
      numero_conselho.replace(/\D/g, ""),
      "profissional solicitante (por conselho)"
    );
  }

  if (!escolhido) {
    throw new ErroScSaude(
      "MEDICO_NAO_LOCALIZADO",
      `O SC Saúde não encontrou o médico "${nome}" (conselho ${numero_conselho}), nem por nome ` +
        "nem por número do conselho. Confira o cadastro do médico no CRM."
    );
  }
}

/**
 * O CBOS preenche sozinho ao escolher o profissional. Aqui só se confere: se
 * ficou vazio, o portal recusaria a guia adiante e o erro sairia ilegível.
 */
async function conferirCbos(page: Page): Promise<void> {
  const cbos = await lerCampo(page, `select[name="${P}cbosProfissional"]`);

  if (cbos === null) {
    logger.warn("campo CBOS não existe nesta tela — seguindo");
    return;
  }

  if (!cbos) {
    throw new ErroScSaude(
      "CBOS_NAO_PREENCHIDO",
      "O CBOS não foi preenchido ao escolher o profissional. Normalmente ele vem sozinho; " +
        "quando não vem, o cadastro do médico no portal está incompleto."
    );
  }

  logger.info({ cbos }, "CBOS preenchido pelo portal");
}

/**
 * Contratado solicitante — o local onde o médico atende.
 *
 * A cadeia de fallback é a do SOP, e **cair no genérico não é erro**: é o
 * caminho normal para médico de fora do estado, cuja clínica não tem cadastro
 * no SC Saúde. Confirmado com caso real.
 */
async function preencherContratado(page: Page, input: InputAutorizacaoScSaude): Promise<void> {
  const seletor = `input[name="${P}razaoPrestSolicitante:value"]`;
  const local = (input.medico_solicitante.local_atendimento || "").trim();

  if (local) {
    const achou = await typeahead(page, seletor, local, "contratado solicitante (local do médico)");
    if (achou) return;
    logger.info({ local }, "local do médico sem cadastro no SC Saúde — caindo para consultório genérico");
  }

  const generico = await typeahead(
    page,
    seletor,
    "consultorio",
    "contratado solicitante (genérico)",
    CONSULTORIO_GENERICO
  );

  if (!generico) {
    throw new ErroScSaude(
      "CONTRATADO_NAO_LOCALIZADO",
      'Não achei o contratado solicitante: nem o local do médico, nem o "consultório" genérico. ' +
        "Sem esse campo o portal recusa a solicitação."
    );
  }
}

async function preencherCaraterEIndicacao(page: Page, input: InputAutorizacaoScSaude): Promise<void> {
  await page
    .locator(`select[name="${P}caraterAtendimento"]`)
    .selectOption({ label: "Eletiva" })
    .catch(() => {
      logger.warn("não consegui selecionar caráter Eletiva — seguindo com o que o portal trouxe");
    });

  // A indicação clínica vem pronta do CRM, começando pelo CID. O robô não monta
  // nem completa esse texto — mesma regra da Unimed, decidida em 30/09/2026.
  const texto = (input.indicacao_clinica || "").trim();
  if (!texto) {
    throw new ErroScSaude(
      "INDICACAO_CLINICA_VAZIA",
      "O CRM não mandou indicação clínica. O campo é obrigatório e a guia seria recusada."
    );
  }

  const campo = page.locator(`textarea[name="${P}indicacaoClinica"]`).first();
  await campo.fill(texto);

  const gravado = await lerCampo(page, `textarea[name="${P}indicacaoClinica"]`);
  if (!gravado) {
    throw new ErroScSaude(
      "INDICACAO_CLINICA_NAO_PREENCHIDA",
      `A indicação clínica continuou vazia depois de preencher ("${texto}").`
    );
  }

  logger.info({ indicacaoClinica: gravado }, "caráter e indicação clínica preenchidos");
}

/**
 * Procedimento e quantidade.
 *
 * O código do procedimento **também é typeahead**, não um campo de texto comum
 * — foi surpresa no reconhecimento. A sugestão devolve a regra de cobertura
 * junto, por exemplo:
 *
 *   22 - 10101118 - Sessao de Psicoterapia / Psicologo - (12 ou ate 40 por ano...)
 */
async function preencherProcedimento(
  page: Page,
  input: InputAutorizacaoScSaude,
  config: ConfigScSaude
): Promise<void> {
  // Tabela 22 (TUSS). Normalmente já vem; garantir é barato.
  const selTabela = page.locator(`select[name="${LINHA_PROC}procedimento:tabela"]`);
  if ((await selTabela.count()) > 0) {
    const opcoes = await selTabela.locator("option").allInnerTexts().catch(() => []);
    const t22 = opcoes.find((o) => /^\s*22\s*-/.test(o));
    if (t22) await selTabela.selectOption({ label: t22 }).catch(() => {});
  }

  const codigo = (input.procedimento.codigo || "").trim();
  const escolhido = await typeahead(
    page,
    `input[name="${LINHA_PROC}procedimento:codigo"]`,
    codigo,
    "procedimento",
    new RegExp(codigo)
  );

  if (!escolhido) {
    throw new ErroScSaude(
      "PROCEDIMENTO_NAO_LOCALIZADO",
      `O SC Saúde não devolveu o procedimento ${codigo}. Confira o código: ` +
        "10101118 para sessão típica, 13107208 para atípica."
    );
  }

  const qtd = input.procedimento.quantidade;
  if (!Number.isInteger(qtd) || qtd < 1) {
    throw new ErroScSaude(
      "QUANTIDADE_INVALIDA",
      `Quantidade inválida (${qtd}). Quem calcula é o CRM; o robô só digita o que recebe.`
    );
  }

  await page.locator(`input[name="${LINHA_PROC}quantidadeSolicitada"]`).first().fill(String(qtd));
  logger.info({ procedimento: escolhido, quantidade: qtd }, "procedimento preenchido");

  // A SC Saúde libera exatamente um mês de terapia. Pedir acima disso dispara a
  // crítica SCAUT_0155 — que não impede a autorização, mas sinaliza que a conta
  // do CRM saiu da regra. Registrar ajuda a achar isso depois no log.
  if (qtd > 5) {
    logger.warn(
      { quantidade: qtd },
      "quantidade acima de um mês de terapia — o portal provavelmente vai acusar SCAUT_0155"
    );
  }

  void config;
}
