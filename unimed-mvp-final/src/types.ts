/**
 * Tipos e interfaces do MVP de automação Unimed SC.
 */

export type TipoPaciente = "LOCAL" | "INTERCAMBIO";
export type TipoProcedimento = "TIPICO" | "ATIPICO" | "PSICOPEDAGOGIA" | "AVALIACAO_NEURO";
export type CodigoProcedimento = "50000470" | "2250005103" | "2250005278" | "2250005367";

/**
 * Estrutura do JSON de input que o robô recebe.
 * Validado por validacao.ts antes de abrir o navegador.
 */
export interface InputAutorizacao {
  paciente: {
    nome: string;
    carteirinha_raw: string;
    tipo: TipoPaciente;
    telefone: string;
    email: string;
  };
  medico_solicitante: {
    nome: string;
    uf_crm: string;
    numero_crm: string;
  };
  cid: string;
  indicacao_clinica_formatada: string;
  procedimento: {
    tipo: TipoProcedimento;
    codigo: CodigoProcedimento;
    quantidade_solicitada: number;
  };
  especialidade_pedido: string;
  pedido_medico_path: string;
  psicologo_executante_nome?: string;
}

/**
 * Códigos de erro possíveis durante o fluxo.
 */
export type ErroCodigo =
  // Validação de input
  | "VALIDACAO_INPUT"
  | "PDF_NAO_ENCONTRADO"
  | "PDF_MUITO_GRANDE"
  | "PDF_FORMATO_INVALIDO"
  | "ESPECIALIDADE_INVALIDA"
  | "CARTEIRINHA_INVALIDA"
  | "MEDICO_DADOS_INVALIDOS"
  | "CID_INVALIDO"
  // Login
  | "LOGIN_FALHOU"
  | "LOGIN_TIMEOUT"
  // Navegação
  | "MENU_NAO_ENCONTRADO"
  | "MODAL_NOVO_EXAME_NAO_ABRIU"
  // Beneficiário
  | "BENEFICIARIO_NAO_LOCALIZADO"
  | "BENEFICIARIO_RESTRICAO"
  | "INTERCAMBIO_VERIFICACAO_FALHOU"
  // Médico
  | "MEDICO_NAO_LOCALIZADO"
  | "MEDICO_CADASTRO_FALHOU"
  | "CBO_NAO_ENCONTRADO"
  // Formulário
  | "CAMPO_OBRIGATORIO_REJEITADO"
  | "PROCEDIMENTO_INVALIDO"
  // Anexo
  | "PDF_UPLOAD_FALHOU"
  // Finalização
  | "FINALIZACAO_FALHOU"
  | "GUIA_NAO_GERADA"
  | "NUMERO_GUIA_NAO_CAPTURADO"
  // Outros
  | "GUIA_DUPLICADA"
  | "CAPTCHA_INESPERADO"
  | "SESSAO_EXPIRADA"
  | "TIMEOUT"
  | "ERRO_DESCONHECIDO";

/**
 * Etapas do fluxo (para logging e tratamento de erro).
 */
export type Etapa =
  | "validacao"
  | "login"
  | "navegacao"
  | "beneficiario"
  | "medico"
  | "formulario"
  | "procedimento"
  | "anexo"
  | "finalizacao";

/**
 * Resultado de uma execução de autorização.
 */
export type ResultadoAutorizacao = ResultadoSucesso | ResultadoErro;

export interface ResultadoSucesso {
  sucesso: true;
  numero_guia: string;
  data_autorizacao: string;
  screenshot_comprovante_path: string | null;
  senha_autorizacao?: string | null;
  /**
   * Situação da guia na Unimed após geração.
   *  - "APROVADO": guia autorizada normalmente, pode ser usada
   *  - "EM_ANALISE": guia gerada mas aguarda análise manual da Unimed
   *    (recepcionista precisa acompanhar até virar autorizada)
   */
  situacao: "APROVADO" | "EM_ANALISE" | "NEGADA";
  duracao_ms: number;
}

export interface ResultadoErro {
  sucesso: false;
  etapa: Etapa;
  erro_codigo: ErroCodigo;
  mensagem: string;
  screenshot_path: string | null;
  tentativas: number;
  timestamp: string;
}

/**
 * Configuração lida do .env
 */
export interface Config {
  unimedUsuario: string;
  unimedSenha: string;
  unimedUrl: string;
  headless: boolean;
  screenshotDir: string;
  logLevel: string;
  debug: boolean;
  navegacaoTimeout: number;
  clickTimeout: number;
}
