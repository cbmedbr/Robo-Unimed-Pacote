/**
 * Tipos do adaptador do SC Saúde.
 *
 * Separado do da Unimed de propósito (decidido em 19/10/2026): os dois portais
 * não se parecem — a Unimed é JSF com popups e QR Code, o SC Saúde é REST com
 * typeahead. O pouco que dá para compartilhar são utilitários (logger,
 * screenshot), não o fluxo. Assim uma mudança de tela num portal não arrisca o
 * outro, que foi exatamente o tipo de quebra que nos custou caro em outubro.
 */

export interface ConfigScSaude {
  usuario: string;
  senha: string;
  url: string;
  headless: boolean;
  screenshotDir: string;
  debug: boolean;
  navegacaoTimeout: number;
  clickTimeout: number;
}

export interface InputAutorizacaoScSaude {
  job_id: string;

  paciente: {
    nome_completo: string;
    /** Só dígitos. É por ele que o portal localiza o beneficiário. */
    cpf: string;
    /** Opcional: o portal preenche sozinho a partir do CPF. Serve para conferir. */
    carteirinha?: string | null;
  };

  medico_solicitante: {
    nome: string;
    /** Só dígitos. */
    numero_conselho: string;
    uf: string;
    /** Local onde o médico atende. Vazio cai direto no fallback "consultorio". */
    local_atendimento?: string | null;
  };

  /** Texto pronto, vindo do CRM. O robô não monta nem completa. */
  indicacao_clinica: string;

  procedimento: {
    /** 10101118 típica · 13107208 atípica */
    codigo: string;
    /** Calculada pelo CRM. O robô digita o que recebe. */
    quantidade: number;
  };

  /** Caminho local do PDF do pedido médico. */
  pedido_medico_path: string;
}

export type SituacaoScSaude = "AUTORIZADA" | "EM_ANALISE" | "NEGADA";

export interface ResultadoScSaude {
  sucesso: boolean;
  numero_guia?: string | null;
  senha?: string | null;
  /** dd/MM/yyyy, como o portal mostra. */
  validade_senha?: string | null;
  data_solicitacao?: string | null;
  situacao?: SituacaoScSaude;
  /** Críticas que o portal exibiu (SCAUT_xxxx). Alerta não impede autorização. */
  alertas?: string[];
  comprovante_path?: string | null;
  erro_codigo?: string;
  erro_mensagem?: string;
  duracao_ms?: number;
}

export type EtapaScSaude =
  | "validacao"
  | "login"
  | "beneficiario"
  | "formulario"
  | "anexo"
  | "autorizacao"
  | "captura";

export class ErroScSaude extends Error {
  constructor(
    public codigo: string,
    mensagem?: string
  ) {
    super(mensagem || codigo);
    this.name = "ErroScSaude";
  }
}
