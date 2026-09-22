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
  /** Quantidade a digitar em NR_QTD_1. Desde 22/09/2026 varia (5, 9, 13…) — o CRM calcula. */
  procedimento_quantidade: number;
  pedido_medico_path_snapshot: string;
  psicologo_executante_nome: string | null;
  is_primeira_guia: boolean;

  // Frequência calculada pelo CRM (migration 314). `null` nos jobs anteriores a 22/09/2026.
  /** Dias distintos da semana em que o paciente atende neste tipo, com este psicólogo. */
  sessoes_por_semana: number | null;
  /** Os dias, abreviados. Ex: "qua, sex". */
  dias_semana: string | null;
  /** Até quando a guia precisa cobrir. */
  cobertura_ate: string | null;
  /** O psicólogo DA LINHA — `psicologo_executante_nome` sozinho errava com dois psicólogos. */
  psicologo_executante_id: string | null;

  status: "pendente" | "executando" | "sucesso" | "falhou" | "cancelado";
  tentativa: number;
  worker_id: string | null;
}

export interface ResultadoRobo {
  sucesso: boolean;
  numero_guia?: string;
  senha_autorizacao?: string;
  situacao?: "APROVADO" | "EM_ANALISE" | "NEGADA";
  /** Qt. Solic. lida no portal após gerar a guia. */
  quantidade_solicitada?: number | null;
  /** Qt. Autoriz. lida no portal — o que a Unimed liberou de fato. */
  quantidade_autorizada?: number | null;
  data_emissao_sgu?: string;
  mes_utilizacao?: string;
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
  is_primeira_guia?: boolean;
}
