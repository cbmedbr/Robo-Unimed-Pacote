import type { UnimedJob } from "./types.js";

/**
 * Qual portal um job deve usar.
 *
 * A decisão sai do **plano do paciente**, não de uma escolha de quem opera: a
 * colaboradora abre o mesmo robô de sempre e não seleciona portal nenhum.
 */
export type Operadora = "unimed" | "scsaude";

/**
 * Subcomando do robô por operadora. É o que `index.ts` do robô espera.
 *
 * `autorizar` é o comando padrão do robô e podia ser omitido, mas passar
 * explícito deixa o log do spawn legível: dá para ver no comando qual portal
 * foi usado, sem precisar deduzir.
 */
export const COMANDO_POR_OPERADORA: Record<Operadora, string> = {
  unimed: "autorizar",
  scsaude: "scsaude",
};

/**
 * Descobre a operadora pelo nome do plano gravado no job.
 *
 * O nome vem de `plano_saude_nome_snapshot`, que é um retrato de quando o job
 * foi criado — e os nomes no CRM variam ("SC Saúde", "SC SAUDE", "Plano SC
 * Saude"). Por isso a comparação é frouxa, sem acento e sem caixa.
 *
 * Default `unimed`: é o que o robô sempre fez, e um plano desconhecido cair no
 * caminho conhecido é melhor do que falhar na largada.
 */
export function operadoraDoJob(job: Pick<UnimedJob, "plano_saude_nome_snapshot">): Operadora {
  const plano = normalizar(job.plano_saude_nome_snapshot);
  if (!plano) return "unimed";
  if (/\bsc\s*saude\b/.test(plano)) return "scsaude";
  return "unimed";
}

function normalizar(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
