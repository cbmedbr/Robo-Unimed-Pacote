export interface DadosExecucao {
  sessao_id: string;
  guia: {
    codigo: string;
    paciente_tipo: "LOCAL" | "INTERCAMBIO";
  };
  paciente: {
    nome_completo: string;
    carteirinha: string;
  };
  data_execucao: string; // YYYY-MM-DD
}

export interface ResultadoExecucao {
  sucesso: boolean;
  comprovante_path?: string | null;
  erro_codigo?: string;
  erro_mensagem?: string;
  duracao_ms?: number;
  /**
   * false quando o portal nao tinha a guia pedida em "exames em aberto" e o
   * robo abriu a primeira da lista. O CRM passou a deixar a colaboradora
   * escolher a guia, entao esse desvio precisa chegar ao job em vez de morrer
   * no log do robo.
   */
  guia_codigo_confere?: boolean;
  guia_codigo_pedido?: string;
}

export class RoboError extends Error {
  codigo: string;
  constructor(codigo: string, mensagem?: string) {
    super(mensagem || codigo);
    this.codigo = codigo;
  }
}
