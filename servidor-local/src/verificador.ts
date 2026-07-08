// verificador.ts — busca guias em análise no Supabase, dispara o robô
// pra checar status atual, e atualiza o banco com o resultado.
//
// Regra: só verifica guias que estão em análise há ATÉ 15 dias. Após isso,
// o cron pula automaticamente (mas verificação manual via API continua disponível).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";
import { supabase } from "./supabase.js";

const PASTA_TEMP = path.join(os.tmpdir(), "unimed-verificacao");
await fs.mkdir(PASTA_TEMP, { recursive: true });

const PRAZO_AUTOMATICO_DIAS = 15;

export interface ResultadoVerificacaoRobo {
  numero_guia: string;
  situacao: "APROVADO" | "EM_ANALISE" | "NEGADA" | "NAO_ENCONTRADA" | "ERRO";
  senha_autorizacao: string | null;
  motivo: string | null;
  verificado_em: string;
  duracao_ms: number;
}

export interface JobEmAnalise {
  id: string;
  numero_guia_unimed: string;
  guia_id: string | null;
  paciente_nome_snapshot: string;
  created_at: string;
}

// ============================================================================
// Lista jobs em análise elegíveis pra verificação
// ============================================================================

/**
 * Retorna jobs com status='sucesso_em_analise' que ainda estão no prazo
 * de verificação automática (15 dias). Se forcarTodos=true, ignora prazo.
 */
export async function listarJobsEmAnalise(forcarTodos = false): Promise<JobEmAnalise[]> {
  let query = supabase
    .from("unimed_aprovacao_jobs")
    .select("id, numero_guia_unimed, guia_id, paciente_nome_snapshot, created_at")
    .eq("status", "sucesso_em_analise")
    .not("numero_guia_unimed", "is", null);

  if (!forcarTodos) {
    const prazo = new Date(Date.now() - PRAZO_AUTOMATICO_DIAS * 86400_000).toISOString();
    query = query.gte("created_at", prazo);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Erro ao listar jobs em análise:", error.message);
    return [];
  }
  return (data ?? []) as JobEmAnalise[];
}

// ============================================================================
// Roda o robô de verificação em subprocesso
// ============================================================================

async function rodarVerificadorSubprocesso(
  numerosGuia: string[]
): Promise<ResultadoVerificacaoRobo[]> {
  if (numerosGuia.length === 0) return [];

  // Salva números em arquivo temp (mais robusto que passar todos por CLI)
  const arquivo = path.join(PASTA_TEMP, `verificacao-${Date.now()}.json`);
  await fs.writeFile(arquivo, JSON.stringify(numerosGuia, null, 2));

  return new Promise((resolve) => {
    let stdoutTotal = "";
    let stderrTotal = "";
    let resolvido = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    function resolverUmaVez(r: ResultadoVerificacaoRobo[]) {
      if (resolvido) return;
      resolvido = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Cleanup arquivo
      fs.unlink(arquivo).catch(() => {});
      resolve(r);
    }

    const proc = spawn(
      "npx",
      ["tsx", "src/index.ts", "verificar", "--guias-file", arquivo],
      {
        cwd: config.roboCaminho,
        env: {
          ...process.env,
          UNIMED_USUARIO: config.unimedUsuario,
          UNIMED_SENHA: config.unimedSenha,
          // Verificação roda invisível por padrão (não atrapalha a recepcionista)
          HEADLESS: "true",
        },
        shell: process.platform === "win32",
      }
    );

    proc.stdout.on("data", (chunk) => {
      const txt = chunk.toString();
      stdoutTotal += txt;
      process.stdout.write(`[cron] ${txt}`);
    });

    proc.stderr.on("data", (chunk) => {
      const txt = chunk.toString();
      stderrTotal += txt;
      process.stderr.write(`[cron] ERR: ${txt}`);
    });

    proc.on("error", (err) => {
      console.error(`[cron] Falha ao iniciar verificador:`, err);
      resolverUmaVez(
        numerosGuia.map((g) => ({
          numero_guia: g,
          situacao: "ERRO" as const,
          senha_autorizacao: null,
          motivo: `Falha ao iniciar verificador: ${err.message}`,
          verificado_em: new Date().toISOString(),
          duracao_ms: 0,
        }))
      );
    });

    proc.on("close", (code) => {
      // Procura JSON na saída do robô (mesma estratégia do executor principal)
      const idxMarcador = stdoutTotal.lastIndexOf("=== RESULTADO ===");
      const trecho = idxMarcador >= 0 ? stdoutTotal.substring(idxMarcador) : stdoutTotal;
      const idxAbre = trecho.indexOf("{");
      const idxFecha = trecho.lastIndexOf("}");

      let parsed: any = null;
      if (idxAbre >= 0 && idxFecha > idxAbre) {
        const candidato = trecho.substring(idxAbre, idxFecha + 1);
        try {
          parsed = JSON.parse(candidato);
        } catch {
          // ignora
        }
      }

      if (parsed?.resultados && Array.isArray(parsed.resultados)) {
        resolverUmaVez(parsed.resultados as ResultadoVerificacaoRobo[]);
        return;
      }

      // Fallback: marca todos como erro
      console.error(
        `[cron] Não consegui parsear saída do verificador. code=${code}, stderr=${stderrTotal.slice(-300)}`
      );
      resolverUmaVez(
        numerosGuia.map((g) => ({
          numero_guia: g,
          situacao: "ERRO" as const,
          senha_autorizacao: null,
          motivo: "Não consegui ler saída do verificador",
          verificado_em: new Date().toISOString(),
          duracao_ms: 0,
        }))
      );
    });

    // Timeout: 90s por guia, capped em 10min
    const timeoutMs = Math.min(numerosGuia.length * 90_000, 600_000);
    timeoutHandle = setTimeout(() => {
      console.warn(`[cron] Timeout no verificador, matando processo`);
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignora
      }
      resolverUmaVez(
        numerosGuia.map((g) => ({
          numero_guia: g,
          situacao: "ERRO" as const,
          senha_autorizacao: null,
          motivo: "Timeout no verificador",
          verificado_em: new Date().toISOString(),
          duracao_ms: timeoutMs,
        }))
      );
    }, timeoutMs);
  });
}

// ============================================================================
// Atualiza job + guia com base no resultado da verificação
// ============================================================================

async function atualizarComResultado(
  job: JobEmAnalise,
  resultado: ResultadoVerificacaoRobo
): Promise<void> {
  switch (resultado.situacao) {
    case "APROVADO": {
      // Guia foi autorizada! Atualiza job e guia.
      console.log(
        `[cron] ✓ Guia ${resultado.numero_guia} (${job.paciente_nome_snapshot}) → AUTORIZADA`
      );

      await supabase
        .from("unimed_aprovacao_jobs")
        .update({
          status: "sucesso",
          situacao_unimed: "APROVADO",
          senha_autorizacao: resultado.senha_autorizacao ?? null,
          concluido_em: new Date().toISOString(),
        })
        .eq("id", job.id);

      if (job.guia_id) {
        await supabase.from("guias").update({ status: "ativa" }).eq("id", job.guia_id);
      }
      return;
    }

    case "NEGADA": {
      console.log(
        `[cron] ✕ Guia ${resultado.numero_guia} (${job.paciente_nome_snapshot}) → NEGADA. Motivo: ${resultado.motivo ?? "(sem motivo)"}`
      );

      await supabase
        .from("unimed_aprovacao_jobs")
        .update({
          status: "falhou",
          situacao_unimed: null,
          erro_codigo: "NEGADA_PELA_UNIMED",
          erro_mensagem: `Guia foi negada após análise: ${resultado.motivo ?? "(sem motivo)"}`,
          concluido_em: new Date().toISOString(),
        })
        .eq("id", job.id);

      if (job.guia_id) {
        await supabase.from("guias").update({ status: "negada" }).eq("id", job.guia_id);
      }
      return;
    }

    case "EM_ANALISE": {
      // Continua em análise — só atualiza o timestamp da última verificação.
      console.log(
        `[cron] ⏳ Guia ${resultado.numero_guia} (${job.paciente_nome_snapshot}) ainda em análise`
      );
      return;
    }

    case "NAO_ENCONTRADA": {
      console.warn(
        `[cron] ? Guia ${resultado.numero_guia} (${job.paciente_nome_snapshot}) NÃO encontrada no portal`
      );
      return;
    }

    case "ERRO": {
      console.error(
        `[cron] ERRO ao verificar ${resultado.numero_guia} (${job.paciente_nome_snapshot}): ${resultado.motivo}`
      );
      return;
    }
  }
}

// ============================================================================
// Função pública: verifica todos os jobs elegíveis
// ============================================================================

export interface ResumoVerificacao {
  total_jobs: number;
  autorizadas: number;
  negadas: number;
  em_analise: number;
  nao_encontradas: number;
  erros: number;
  duracao_total_ms: number;
}

export async function verificarJobsEmAnalise(
  forcarTodos = false
): Promise<ResumoVerificacao> {
  const inicio = Date.now();
  const jobs = await listarJobsEmAnalise(forcarTodos);

  if (jobs.length === 0) {
    console.log(
      `[cron] Nenhum job em análise pra verificar${forcarTodos ? "" : " (dentro do prazo de 15 dias)"}.`
    );
    return {
      total_jobs: 0,
      autorizadas: 0,
      negadas: 0,
      em_analise: 0,
      nao_encontradas: 0,
      erros: 0,
      duracao_total_ms: Date.now() - inicio,
    };
  }

  console.log(`[cron] Verificando ${jobs.length} guia(s) em análise...`);

  const numeros = jobs.map((j) => j.numero_guia_unimed);
  const resultados = await rodarVerificadorSubprocesso(numeros);

  // Mapeia resultados por número de guia pra encontrar o job correspondente
  const mapaResultados = new Map<string, ResultadoVerificacaoRobo>();
  for (const r of resultados) {
    mapaResultados.set(r.numero_guia, r);
  }

  const resumo: ResumoVerificacao = {
    total_jobs: jobs.length,
    autorizadas: 0,
    negadas: 0,
    em_analise: 0,
    nao_encontradas: 0,
    erros: 0,
    duracao_total_ms: 0,
  };

  for (const job of jobs) {
    const r = mapaResultados.get(job.numero_guia_unimed);
    if (!r) {
      resumo.erros++;
      continue;
    }

    await atualizarComResultado(job, r);

    switch (r.situacao) {
      case "APROVADO":
        resumo.autorizadas++;
        break;
      case "NEGADA":
        resumo.negadas++;
        break;
      case "EM_ANALISE":
        resumo.em_analise++;
        break;
      case "NAO_ENCONTRADA":
        resumo.nao_encontradas++;
        break;
      case "ERRO":
        resumo.erros++;
        break;
    }
  }

  resumo.duracao_total_ms = Date.now() - inicio;

  console.log(
    `[cron] Verificação concluída em ${Math.round(resumo.duracao_total_ms / 1000)}s: ${resumo.autorizadas} autorizadas, ${resumo.negadas} negadas, ${resumo.em_analise} em análise, ${resumo.nao_encontradas} não encontradas, ${resumo.erros} erros.`
  );

  return resumo;
}

// ============================================================================
// Verifica UMA guia específica (para botão manual na UI)
// ============================================================================

export async function verificarUmaGuia(jobId: string): Promise<{
  ok: boolean;
  resumo?: ResumoVerificacao;
  erro?: string;
}> {
  const { data: job, error } = await supabase
    .from("unimed_aprovacao_jobs")
    .select("id, numero_guia_unimed, guia_id, paciente_nome_snapshot, created_at, status")
    .eq("id", jobId)
    .maybeSingle();

  if (error || !job) {
    return { ok: false, erro: error?.message ?? "Job não encontrado" };
  }
  if (job.status !== "sucesso_em_analise") {
    return { ok: false, erro: `Job não está em análise (status=${job.status})` };
  }
  if (!job.numero_guia_unimed) {
    return { ok: false, erro: "Job não tem número de guia preenchido" };
  }

  console.log(
    `[manual] Verificando guia ${job.numero_guia_unimed} (${job.paciente_nome_snapshot})...`
  );

  const resultados = await rodarVerificadorSubprocesso([job.numero_guia_unimed]);
  const r = resultados[0];

  if (!r) {
    return { ok: false, erro: "Verificador não retornou resultado" };
  }

  await atualizarComResultado(job as JobEmAnalise, r);

  return {
    ok: true,
    resumo: {
      total_jobs: 1,
      autorizadas: r.situacao === "APROVADO" ? 1 : 0,
      negadas: r.situacao === "NEGADA" ? 1 : 0,
      em_analise: r.situacao === "EM_ANALISE" ? 1 : 0,
      nao_encontradas: r.situacao === "NAO_ENCONTRADA" ? 1 : 0,
      erros: r.situacao === "ERRO" ? 1 : 0,
      duracao_total_ms: r.duracao_ms,
    },
  };
}
