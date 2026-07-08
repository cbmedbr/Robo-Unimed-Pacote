// types.ts — tipos do servidor local

export interface UnimedJob {
  id: string;
  paciente_id: string;
  guia_id: string | null;

  // Snapshot dos dados
  carteirinha_snapshot: string;
  paciente_nome_snapshot: string;
  plano_saude_id_snapshot: string | null;
  plano_saude_nome_snapshot: string;
  medico_id_snapshot: string | null;
  medico_nome_snapshot: string;
  medico_crm_snapshot: string;
  medico_uf_snapshot: string;
  cid_snapshot: string;
  procedimento_codigo: "50000470" | "2250005103" | "2250005278" | "2250005367";
  procedimento_categoria?: "tipico" | "atipico" | "psicopedagogia" | "avaliacao_neuro" | null;
  procedimento_quantidade: number;
  pedido_medico_path_snapshot: string;
  psicologo_executante_nome: string | null;

  status: "pendente" | "executando" | "sucesso" | "falhou" | "cancelado";
  tentativa: number;
  worker_id: string | null;
}

export interface ResultadoRobo {
  sucesso: boolean;
  numero_guia?: string;
  senha_autorizacao?: string;
  /**
   * Situação da guia retornada pela Unimed.
   * - "APROVADO": guia autorizada normalmente
   * - "EM_ANALISE": gerada mas aguarda análise manual da Unimed
   * Só preenchido em caso de sucesso.
   */
  situacao?: "APROVADO" | "EM_ANALISE";
  comprovante_path?: string;
  erro_codigo?: string;
  erro_mensagem?: string;
  dump_html_path?: string;
  dump_screenshot_path?: string;
  duracao_ms: number;
}

// Schema esperado pelo robô (espelho de InputAutorizacao em unimed-mvp-final/src/types.ts)
export interface InputAutorizacaoRobo {
  paciente: {
    nome: string;
    carteirinha_raw: string;
    tipo: "LOCAL" | "INTERCAMBIO";
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
    tipo: "TIPICO" | "ATIPICO" | "PSICOPEDAGOGIA" | "AVALIACAO_NEURO";
    codigo: "50000470" | "2250005103" | "2250005278" | "2250005367";
    quantidade_solicitada: number;
  };
  especialidade_pedido: string;
  pedido_medico_path: string;
  psicologo_executante_nome?: string;
}
