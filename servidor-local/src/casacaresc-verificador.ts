import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { supabase } from "./supabase.js";
import { operadoraDoJob } from "./operadora.js";
import { PASTA_CASACARESC, PROCEDIMENTO_CASACARESC, pythonCasacaresc } from "./casacaresc-job.js";

/**
 * Checagem das guias Casacaresc em análise (17/11/2026).
 *
 * Pedido da operação: guia que fica "Em análise" no portal é conferida a cada
 * 4 horas, SEM prazo, até sair Autorizada ou Negada. Quem consulta é o robô
 * Python (`robo.py --verificar`), na tela Pesquisa de Guias, filtrando pelo
 * Nº Guia Prestador a partir da data da solicitação.
 *
 * Enquanto a guia está em análise o CRM bloqueia novo pedido do paciente.
 */

interface JobCasa {
  id: string;
  numero_guia_unimed: string;
  guia_id: string | null;
  paciente_nome_snapshot: string;
  plano_saude_nome_snapshot: string | null;
  procedimento_categoria: string | null;
  procedimento_quantidade: number | null;
  created_at: string;
}

interface ResultadoCasa {
  job_id: string;
  numero_prestador: string;
  // SEM_SENHA: este PC não tem a senha do portal. Não é falha da guia: nada é
  // gravado e outro PC (com senha) confere.
  situacao: "APROVADO" | "NEGADA" | "EM_ANALISE" | "NAO_ENCONTRADA" | "ERRO" | "SEM_SENHA";
  situacao_texto: string | null;
  numero_operadora: string | null;
  // Só na APROVADO, quando o robô consegue abrir a guia (senão vem vazio).
  data_autorizacao?: string | null;
  data_validade?: string | null;
  quantidade_autorizada?: number | null;
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function hojeIso(): string {
  // Data de Brasília (o PC pode estar em outro fuso; toISOString é UTC).
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function entradaDoJob(j: JobCasa) {
  return {
    job_id: j.id,
    numero_prestador: j.numero_guia_unimed,
    data_solicitacao: j.created_at.slice(0, 10),
    codigo: PROCEDIMENTO_CASACARESC[j.procedimento_categoria ?? ""] ?? "",
  };
}

const PASTA_TEMP = path.join(os.tmpdir(), "unimed-jobs");
const TIMEOUT_MS = 15 * 60_000;

async function listarCasacarescEmAnalise(): Promise<JobCasa[]> {
  const { data, error } = await supabase
    .from("unimed_aprovacao_jobs")
    .select("id, numero_guia_unimed, guia_id, paciente_nome_snapshot, plano_saude_nome_snapshot, procedimento_categoria, procedimento_quantidade, created_at")
    .eq("status", "sucesso_em_analise")
    .not("numero_guia_unimed", "is", null);
  if (error) {
    console.error("[casacaresc] Erro ao listar guias em análise:", error.message);
    return [];
  }
  return ((data ?? []) as JobCasa[]).filter(
    (j) => operadoraDoJob({ plano_saude_nome_snapshot: j.plano_saude_nome_snapshot ?? "" }) === "casacaresc"
  );
}

function rodarRoboVerificar(entradaPath: string): Promise<ResultadoCasa[]> {
  return new Promise((resolve) => {
    const py = pythonCasacaresc();
    if (!py) {
      console.warn("[casacaresc] Sem Python neste PC: checagem das guias em análise pulada.");
      resolve([]);
      return;
    }
    let saida = "";
    const proc = spawn(py.cmd, [...py.args, "-u", path.join(PASTA_CASACARESC, "robo.py"), "--verificar", entradaPath], {
      cwd: PASTA_CASACARESC,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignora
      }
    }, TIMEOUT_MS);
    proc.stdout.on("data", (c) => {
      const t = c.toString();
      saida += t;
      process.stdout.write(`[casacaresc-verif] ${t}`);
    });
    proc.stderr.on("data", (c) => process.stderr.write(`[casacaresc-verif] ERR: ${c.toString()}`));
    proc.on("error", (e) => {
      clearTimeout(timer);
      console.error("[casacaresc] Não consegui iniciar o robô de checagem:", e.message);
      resolve([]);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      const i = saida.lastIndexOf("=== RESULTADO ===");
      const trecho = i >= 0 ? saida.substring(i) : saida;
      const a = trecho.indexOf("{");
      const b = trecho.lastIndexOf("}");
      try {
        const parsed = JSON.parse(trecho.substring(a, b + 1));
        resolve((parsed.resultados ?? []) as ResultadoCasa[]);
      } catch {
        console.error("[casacaresc] Não consegui ler o resultado da checagem.");
        resolve([]);
      }
    });
  });
}

async function aplicar(job: JobCasa, r: ResultadoCasa): Promise<void> {
  const agora = new Date().toISOString();
  const quem = `${job.numero_guia_unimed} (${job.paciente_nome_snapshot})`;

  if (r.situacao === "SEM_SENHA") {
    // Não grava nada: antes este PC marcava a guia com "senha não configurada"
    // a cada 4h e escondia o resultado do PC que tem a senha.
    console.log(`[casacaresc] Guia ${quem}: este PC não tem a senha do portal, checagem pulada.`);
    return;
  }

  if (r.situacao === "APROVADO") {
    console.log(`[casacaresc] ✓ Guia ${quem} AUTORIZADA (operadora ${r.numero_operadora ?? "-"})`);
    if (job.guia_id) {
      // Mesma regra da autorização na hora (executor.ts): a guia vale 60 dias
      // a partir do dia em que a operadora autorizou. O que o robô não leu cai
      // no padrão (hoje / +60 dias / quantidade já gravada) e vira recado.
      const recados: string[] = [];
      const lida = DATA_ISO.test(r.data_autorizacao ?? "");
      const emissao = lida ? r.data_autorizacao! : hojeIso();
      if (!lida) recados.push("data da autorização não lida (usado o dia da checagem)");
      let validade: string;
      if (DATA_ISO.test(r.data_validade ?? "")) {
        validade = r.data_validade!;
      } else {
        const v = new Date(emissao + "T12:00:00");
        v.setDate(v.getDate() + 60);
        validade = v.toISOString().slice(0, 10);
      }
      const qtd = Number.isInteger(r.quantidade_autorizada) && (r.quantidade_autorizada as number) > 0
        ? (r.quantidade_autorizada as number)
        : null;
      if (qtd == null) recados.push("quantidade autorizada não lida (mantida a pedida)");

      const { data: atual } = await supabase.from("guias").select("observacoes").eq("id", job.guia_id).maybeSingle();
      const dia = emissao.split("-").reverse().join("/");
      const nota =
        `Casacaresc: autorizada pela operadora em ${dia} (checagem automática).` +
        (recados.length ? ` Conferir no portal: ${recados.join("; ")}.` : "");
      const { error: errGuia } = await supabase
        .from("guias")
        .update({
          status: "ativa",
          ...(r.numero_operadora ? { codigo_guia: r.numero_operadora } : {}),
          data_emissao: emissao,
          mes_utilizacao: emissao.slice(0, 8) + "01",
          data_validade: validade,
          ...(qtd != null ? { sessoes_autorizadas: qtd } : {}),
          observacoes: [atual?.observacoes, nota].filter(Boolean).join("\n"),
        })
        .eq("id", job.guia_id);
      if (errGuia) {
        // Deixa o job em análise: a próxima checagem tenta gravar de novo.
        console.error(`[casacaresc] Guia ${quem} autorizada mas não consegui atualizar no CRM:`, errGuia.message);
        await supabase
          .from("unimed_aprovacao_jobs")
          .update({ erro_mensagem: `Autorizada no portal, mas o CRM não aceitou a atualização: ${errGuia.message}`, updated_at: agora })
          .eq("id", job.id);
        return;
      }
    }
    await supabase
      .from("unimed_aprovacao_jobs")
      .update({
        status: "sucesso",
        situacao_unimed: "APROVADO",
        erro_codigo: null,
        erro_mensagem: null,
        concluido_em: agora,
        updated_at: agora,
      })
      .eq("id", job.id);
    return;
  }

  if (r.situacao === "NEGADA") {
    console.log(`[casacaresc] ✕ Guia ${quem} NEGADA: ${r.situacao_texto ?? ""}`);
    await supabase
      .from("unimed_aprovacao_jobs")
      .update({
        status: "negado",
        situacao_unimed: "NEGADA",
        erro_mensagem: `Portal Casacaresc: "${r.situacao_texto ?? "negada"}"`,
        concluido_em: agora,
        updated_at: agora,
      })
      .eq("id", job.id);
    if (job.guia_id) {
      await supabase.from("guias").update({ status: "negada" }).eq("id", job.guia_id);
    }
    return;
  }

  if (r.situacao === "EM_ANALISE") {
    console.log(`[casacaresc] ⏳ Guia ${quem} segue em análise`);
    // Limpa recado velho de checagem que falhou (ex.: PC sem senha).
    await supabase
      .from("unimed_aprovacao_jobs")
      .update({ erro_codigo: null, erro_mensagem: null, updated_at: agora })
      .eq("id", job.id);
    return;
  }

  // NAO_ENCONTRADA / ERRO: continua em análise e tenta de novo na próxima rodada.
  console.warn(`[casacaresc] ? Guia ${quem}: ${r.situacao} ${r.situacao_texto ?? ""}`);
  await supabase
    .from("unimed_aprovacao_jobs")
    .update({
      erro_mensagem:
        r.situacao === "NAO_ENCONTRADA"
          ? "Checagem automática não achou a guia na Pesquisa de Guias. Tenta de novo em 4h."
          : `Checagem automática falhou: ${r.situacao_texto ?? "erro"}. Tenta de novo em 4h.`,
      updated_at: agora,
    })
    .eq("id", job.id);
}

/** Roda a checagem de todas as guias Casacaresc em análise. Nunca lança erro. */
export async function verificarCasacarescEmAnalise(): Promise<void> {
  try {
    const jobs = await listarCasacarescEmAnalise();
    if (jobs.length === 0) {
      console.log("[casacaresc] Nenhuma guia em análise pra checar.");
      return;
    }
    console.log(`[casacaresc] Checando ${jobs.length} guia(s) em análise...`);
    await fs.mkdir(PASTA_TEMP, { recursive: true });
    const entrada = path.join(PASTA_TEMP, `casacaresc-verificar-${Date.now()}.json`);
    await fs.writeFile(
      entrada,
      JSON.stringify({ guias: jobs.map(entradaDoJob) })
    );
    const resultados = await rodarRoboVerificar(entrada);
    await fs.unlink(entrada).catch(() => {});
    const porJob = new Map(resultados.map((r) => [r.job_id, r]));
    for (const job of jobs) {
      const r = porJob.get(job.id);
      if (r) await aplicar(job, r);
    }
  } catch (e: any) {
    console.error("[casacaresc] Erro na checagem das guias em análise:", e?.message ?? e);
  }
}

/** Checagem de UMA guia (botão manual). */
export async function verificarUmaCasacaresc(
  jobId: string
): Promise<{ ok: boolean; erro?: string; situacao?: ResultadoCasa["situacao"]; situacao_texto?: string | null }> {
  const jobs = await listarCasacarescEmAnalise();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, erro: "Guia Casacaresc não está em análise" };
  await fs.mkdir(PASTA_TEMP, { recursive: true });
  const entrada = path.join(PASTA_TEMP, `casacaresc-verificar-${jobId}.json`);
  await fs.writeFile(entrada, JSON.stringify({ guias: [entradaDoJob(job)] }));
  const [r] = await rodarRoboVerificar(entrada);
  await fs.unlink(entrada).catch(() => {});
  if (!r) return { ok: false, erro: "Checagem não retornou resultado" };
  if (r.situacao === "SEM_SENHA") {
    return {
      ok: false,
      situacao: r.situacao,
      erro: "Este computador não tem a senha do portal Casacaresc. Feche a janela do robô e abra o iniciar.bat de novo: ele pede a senha.",
    };
  }
  await aplicar(job, r);
  return { ok: true, situacao: r.situacao, situacao_texto: r.situacao_texto };
}
