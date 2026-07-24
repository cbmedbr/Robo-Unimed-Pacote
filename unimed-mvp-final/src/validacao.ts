import fs from "fs";
import path from "path";
import { InputAutorizacao, ResultadoErro } from "./types";
import { logger } from "./utils/logger";

const EXTENSOES_VALIDAS = [".pdf", ".jpg", ".jpeg", ".png", ".gif", ".doc", ".xls"];
const TAMANHO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const REGEX_CID = /^[A-Z]\d{2}(\.\d{1,2})?$/;
const REGEX_CRM = /^\d+$/;
const REGEX_UF = /^[A-Z]{2}$/;

/**
 * Erro de validação que carrega contexto estruturado.
 */
export class ErroValidacao extends Error {
  constructor(
    public erroCodigo: ResultadoErro["erro_codigo"],
    public mensagemDetalhada: string
  ) {
    super(mensagemDetalhada);
    this.name = "ErroValidacao";
  }
}

/**
 * Valida o input completo antes de abrir o browser.
 * Lança ErroValidacao se algo estiver errado.
 */
export function validarInput(input: InputAutorizacao): void {
  logger.info("iniciando validação do input");

  // Paciente
  if (!input.paciente?.nome || input.paciente.nome.length < 3) {
    throw new ErroValidacao("VALIDACAO_INPUT", "paciente.nome inválido ou muito curto");
  }

  if (!input.paciente.carteirinha_raw) {
    throw new ErroValidacao("CARTEIRINHA_INVALIDA", "carteirinha_raw vazio");
  }

  // Verificar consistência tipo vs prefixo
  const apenasDigitos = input.paciente.carteirinha_raw.replace(/\D/g, "");
  const prefixo = apenasDigitos.substring(0, 4);
  const tipoEsperado = prefixo === "0025" ? "LOCAL" : "INTERCAMBIO";

  if (input.paciente.tipo !== tipoEsperado) {
    throw new ErroValidacao(
      "CARTEIRINHA_INVALIDA",
      `tipo do paciente (${input.paciente.tipo}) não bate com prefixo da carteirinha (${prefixo} → ${tipoEsperado})`
    );
  }

  // Local: 17 dígitos
  if (input.paciente.tipo === "LOCAL" && apenasDigitos.length !== 17) {
    throw new ErroValidacao(
      "CARTEIRINHA_INVALIDA",
      `carteirinha LOCAL deve ter 17 dígitos, tem ${apenasDigitos.length}`
    );
  }

  // Médico
  if (!input.medico_solicitante?.nome || input.medico_solicitante.nome.length < 3) {
    throw new ErroValidacao("MEDICO_DADOS_INVALIDOS", "medico_solicitante.nome inválido");
  }

  if (!REGEX_UF.test(input.medico_solicitante.uf_crm)) {
    throw new ErroValidacao(
      "MEDICO_DADOS_INVALIDOS",
      `uf_crm deve ter exatamente 2 letras maiúsculas, recebido: "${input.medico_solicitante.uf_crm}"`
    );
  }

  if (!REGEX_CRM.test(input.medico_solicitante.numero_crm)) {
    throw new ErroValidacao(
      "MEDICO_DADOS_INVALIDOS",
      `numero_crm deve ter apenas dígitos, recebido: "${input.medico_solicitante.numero_crm}"`
    );
  }

  // CID
  if (!REGEX_CID.test(input.cid)) {
    throw new ErroValidacao(
      "CID_INVALIDO",
      `CID inválido: "${input.cid}". Formato esperado: letra+2 dígitos+(.dígitos), ex: G60.8`
    );
  }

  if (!input.indicacao_clinica_formatada?.startsWith("CID ")) {
    throw new ErroValidacao(
      "VALIDACAO_INPUT",
      `indicacao_clinica_formatada deve começar com "CID ", recebido: "${input.indicacao_clinica_formatada}"`
    );
  }

  // Procedimento — agora 4 códigos possíveis
  const CODIGOS_VALIDOS = ["50000470", "2250005103", "2250005278", "2250005367"];
  if (!CODIGOS_VALIDOS.includes(input.procedimento.codigo)) {
    throw new ErroValidacao(
      "PROCEDIMENTO_INVALIDO",
      `código de procedimento inválido: ${input.procedimento.codigo}. Válidos: ${CODIGOS_VALIDOS.join(", ")}`
    );
  }

  // Mapeamento tipo → código esperado
  const codigoPorTipo: Record<string, string> = {
    TIPICO: "50000470",
    ATIPICO: "2250005103",
    PSICOPEDAGOGIA: "2250005278",
    AVALIACAO_NEURO: "2250005367",
  };
  const codigoEsperado = codigoPorTipo[input.procedimento.tipo];
  if (!codigoEsperado) {
    throw new ErroValidacao(
      "PROCEDIMENTO_INVALIDO",
      `tipo de procedimento desconhecido: ${input.procedimento.tipo}`
    );
  }
  if (input.procedimento.codigo !== codigoEsperado) {
    throw new ErroValidacao(
      "PROCEDIMENTO_INVALIDO",
      `tipo (${input.procedimento.tipo}) não bate com código (${input.procedimento.codigo}). Esperado: ${codigoEsperado}`
    );
  }

  // Quantidade: aceita qualquer número entre 1 e 60 (recepcionista pode editar)
  const qtd = input.procedimento.quantidade_solicitada;
  if (typeof qtd !== "number" || qtd < 1 || qtd > 60 || !Number.isInteger(qtd)) {
    throw new ErroValidacao(
      "PROCEDIMENTO_INVALIDO",
      `quantidade inválida: ${qtd}. Deve ser inteiro entre 1 e 60.`
    );
  }

  // Especialidade
  if (input.especialidade_pedido !== "PSICOLOGIA") {
    throw new ErroValidacao(
      "ESPECIALIDADE_INVALIDA",
      `especialidade_pedido deve ser "PSICOLOGIA", recebido: "${input.especialidade_pedido}". Pedidos de outras especialidades não são aceitos pela clínica.`
    );
  }

  // PDF
  if (!input.pedido_medico_path) {
    throw new ErroValidacao("PDF_NAO_ENCONTRADO", "pedido_medico_path não informado");
  }

  const absPath = path.resolve(input.pedido_medico_path);
  if (!fs.existsSync(absPath)) {
    throw new ErroValidacao("PDF_NAO_ENCONTRADO", `arquivo não existe: ${absPath}`);
  }

  const ext = path.extname(absPath).toLowerCase();
  if (!EXTENSOES_VALIDAS.includes(ext)) {
    throw new ErroValidacao(
      "PDF_FORMATO_INVALIDO",
      `extensão "${ext}" não aceita. Aceitas: ${EXTENSOES_VALIDAS.join(", ")}`
    );
  }

  const stats = fs.statSync(absPath);
  if (stats.size > TAMANHO_MAX_BYTES) {
    throw new ErroValidacao(
      "PDF_MUITO_GRANDE",
      `arquivo tem ${(stats.size / 1024 / 1024).toFixed(2)}MB, máximo é 5MB`
    );
  }

  logger.info("validação OK");
}
