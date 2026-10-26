import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { supabase } from "./supabase.js";
import type { UnimedJob } from "./types.js";

/**
 * Converte um job do CRM no input do adaptador do SC Saúde.
 *
 * Separado de `jobParaInputRobo` (que serve a Unimed) porque os dois portais
 * pedem coisas diferentes: o SC Saúde localiza o beneficiário por **CPF**, usa
 * **outros códigos de procedimento** e não tem o conceito de local/intercâmbio.
 */

const PASTA_TEMP = path.join(os.tmpdir(), "unimed-jobs");

/**
 * Procedimento no SC Saúde, por categoria do CRM.
 *
 * A chave é o valor do enum `categoria_atendimento_tipo` do banco. **A sessão
 * atípica se chama `aba`** — escrevi `atipico` na primeira versão, que é como
 * o SOP fala dela, e nenhum job teria casado: os 280 jobs atípicos desde
 * agosto falhariam com PROCEDIMENTO_SEM_EQUIVALENTE. O nome do SOP e o nome do
 * enum são diferentes, e quem manda aqui é o enum.
 */
const PROCEDIMENTO_SCSAUDE: Record<string, string> = {
  tipico: "10101118",
  aba: "13107208",
};

export class ErroPreparoScSaude extends Error {
  constructor(
    public codigo: string,
    mensagem: string
  ) {
    super(mensagem);
  }
}

export interface InputScSaude {
  job_id: string;
  paciente: { nome_completo: string; cpf: string; carteirinha?: string | null };
  medico_solicitante: {
    nome: string;
    numero_conselho: string;
    uf: string;
    local_atendimento?: string | null;
  };
  indicacao_clinica: string;
  procedimento: { codigo: string; quantidade: number };
  pedido_medico_path: string;
}

export async function jobParaInputScSaude(
  job: UnimedJob
): Promise<{ input: InputScSaude; pdfLocalPath: string }> {
  // --- procedimento ---
  //
  // Psicopedagogia e avaliação neuro não existem no SC Saúde (decidido em
  // 29/09/2026). Falhar aqui, com nome, é melhor do que o robô procurar um
  // código que o portal não tem e devolver "procedimento não localizado".
  const categoria = job.procedimento_categoria ?? "tipico";
  const codigo = PROCEDIMENTO_SCSAUDE[categoria];
  if (!codigo) {
    throw new ErroPreparoScSaude(
      "PROCEDIMENTO_SEM_EQUIVALENTE",
      `O SC Saúde não atende "${categoria}" — só sessão típica e atípica. ` +
        "Esse pedido precisa ser feito por fora."
    );
  }

  // --- CPF: é por ele que o portal acha o beneficiário ---
  const { data: paciente } = await supabase
    .from("pacientes")
    .select("cpf, numero_carteirinha")
    .eq("id", job.paciente_id)
    .maybeSingle();

  const cpf = (paciente?.cpf ?? "").replace(/\D/g, "");
  if (cpf.length !== 11) {
    throw new ErroPreparoScSaude(
      "CPF_AUSENTE",
      `O paciente ${job.paciente_nome_snapshot} está sem CPF no cadastro. ` +
        "O portal do SC Saúde localiza o beneficiário pelo CPF — sem ele o robô não consegue abrir a guia."
    );
  }

  // --- indicação clínica: mesma regra da Unimed ---
  //
  // `CID <código> <descrição>`, texto montado aqui e não pelo robô. Nos casos
  // reais a colaboradora digitava só o código; mandar a descrição junto é mais
  // completo e o portal aceita texto livre.
  const codigoCid = (job.cid_snapshot ?? "").trim();
  const { data: cid } = await supabase
    .from("cids")
    .select("descricao")
    .eq("codigo", codigoCid)
    .maybeSingle();

  const descricaoCid = (cid?.descricao ?? "").trim();
  if (!descricaoCid) {
    throw new ErroPreparoScSaude(
      "CID_SEM_DESCRICAO",
      `Não há descrição para o CID "${codigoCid}" na tabela de CIDs, então não dá para montar a ` +
        "indicação clínica. Corrija o CID no cadastro do paciente ou cadastre o código."
    );
  }

  // --- pedido médico ---
  const pathStorage = job.pedido_medico_path_snapshot;
  if (!pathStorage) {
    throw new ErroPreparoScSaude(
      "PEDIDO_MEDICO_AUSENTE",
      `O paciente ${job.paciente_nome_snapshot} está sem pedido médico anexado. ` +
        "O SC Saúde exige o documento para autorizar."
    );
  }

  const { data: arquivo, error } = await supabase.storage.from("documentos").download(pathStorage);
  if (error || !arquivo) {
    throw new ErroPreparoScSaude(
      "PEDIDO_MEDICO_NAO_BAIXOU",
      `Não consegui baixar o pedido médico (${pathStorage}): ${error?.message ?? "resposta vazia"}.`
    );
  }

  await fs.mkdir(PASTA_TEMP, { recursive: true });
  const pdfLocal = path.join(PASTA_TEMP, `${job.id}-scsaude.pdf`);
  await fs.writeFile(pdfLocal, Buffer.from(await arquivo.arrayBuffer()));

  return {
    pdfLocalPath: pdfLocal,
    input: {
      job_id: job.id,
      paciente: {
        nome_completo: job.paciente_nome_snapshot,
        cpf,
        // Só para conferência: o portal preenche a carteirinha sozinho a partir
        // do CPF, e a do CRM pode não bater (ver SCSAUDE_PORTAL.md, seção 4).
        carteirinha: paciente?.numero_carteirinha ?? null,
      },
      medico_solicitante: {
        nome: job.medico_nome_snapshot,
        numero_conselho: (job.medico_crm_snapshot ?? "").replace(/\D/g, ""),
        uf: job.medico_uf_snapshot,
        // O CRM não guarda onde o médico atende — a tabela `medicos` não tem
        // essa coluna. Então o contratado solicitante cai direto no fallback
        // "consultório", que o SOP já prevê como caminho normal para médico de
        // fora. Se um dia o CRM passar a guardar o local, é só preencher aqui.
        local_atendimento: null,
      },
      indicacao_clinica: `CID ${codigoCid} ${descricaoCid}`,
      procedimento: { codigo, quantidade: job.procedimento_quantidade },
      pedido_medico_path: pdfLocal,
    },
  };
}
