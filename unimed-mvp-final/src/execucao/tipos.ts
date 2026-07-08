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
}

export class RoboError extends Error {
  codigo: string;
  constructor(codigo: string, mensagem?: string) {
    super(mensagem || codigo);
    this.codigo = codigo;
  }
}
