// index.ts — servidor HTTP local
//
// Endpoints:
//   GET  /health                       → status do servidor
//   POST /executar                     → dispara N jobs novos em fila (um por vez)
//   GET  /jobs/:id/status              → consulta status de um job
//   POST /verificar-em-analise         → verifica todas as guias em análise
//   POST /verificar/:jobId             → verifica UMA guia (botão manual)
//
// Execução é fire-and-forget: responde 202 imediatamente e processa em background.
//
// Cron interno: a cada 4 horas, verifica automaticamente todas as guias que
// ficaram "em análise" há até 15 dias.

import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { supabase } from "./supabase.js";
import { executarJob } from "./executor.js";
import { executarSessaoJob, type DadosExecucaoSessao } from "./executor-sessao.js";
import { verificarJobsEmAnalise, verificarUmaGuia } from "./verificador.js";

const app = express();

// CORS — permite o CRM (Vercel) chamar este servidor (localhost)
app.use(
  cors({
    origin: (origin, callback) => {
      // Permite chamadas sem origin (ex: curl, mesma origem)
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes("*")) return callback(null, true);
      if (config.corsOrigins.some((o) => origin === o || origin.startsWith(o))) {
        return callback(null, true);
      }
      console.warn(`CORS bloqueado: ${origin}`);
      callback(new Error("Origem não permitida"));
    },
    credentials: false,
  })
);

app.use(express.json());

// ============================================================================
// Rate-limit simples + tracking de jobs em execução
// ============================================================================

const jobsEmExecucao = new Set<string>();
const MAX_PARALELOS = 10; // segurança: não dispara mais que 10 ao mesmo tempo

// ============================================================================
// Auto-reset: jobs travados como "executando" por mais de 3 minutos → pendente
// ============================================================================
const RESET_INTERVALO_MS = 60_000; // checa a cada 1 minuto
const RESET_TIMEOUT_MS = 3 * 60_000; // 3 minutos

setInterval(async () => {
  try {
    const limite = new Date(Date.now() - RESET_TIMEOUT_MS).toISOString();
    // Autorização
    const { data: travadosAuth } = await supabase
      .from("unimed_aprovacao_jobs")
      .update({ status: "pendente", worker_id: null, pego_em: null, iniciado_em: null })
      .eq("status", "executando")
      .lt("iniciado_em", limite)
      .select("id, paciente_nome_snapshot");
    if (travadosAuth?.length) {
      console.log(`[auto-reset] ${travadosAuth.length} job(s) de autorização resetados:`, travadosAuth.map(j => j.paciente_nome_snapshot).join(", "));
    }
    // Execução
    const { data: travadosExec } = await supabase
      .from("unimed_execucao_jobs")
      .update({ status: "pendente", iniciado_em: null })
      .eq("status", "executando")
      .lt("iniciado_em", limite)
      .select("id, paciente_nome_snapshot");
    if (travadosExec?.length) {
      console.log(`[auto-reset] ${travadosExec.length} job(s) de execução resetados:`, travadosExec.map(j => j.paciente_nome_snapshot).join(", "));
    }
  } catch (err) {
    console.error("[auto-reset] Erro:", (err as Error).message);
  }
}, RESET_INTERVALO_MS);

// ============================================================================
// Health
// ============================================================================

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    versao: "1.0.0",
    pid: process.pid,
    jobs_em_execucao: jobsEmExecucao.size,
    sessoes_em_execucao: sessoesEmExecucao.size,
    robos: ["autorizacao", "execucao"],
  });
});

// ============================================================================
// Executar
// ============================================================================

app.post("/executar", async (req, res) => {
  const { jobIds } = req.body ?? {};

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ erro: "jobIds deve ser array não-vazio" });
  }

  if (jobsEmExecucao.size + jobIds.length > MAX_PARALELOS) {
    return res.status(429).json({
      erro: `Servidor já está com ${jobsEmExecucao.size} jobs em execução. Aguarde os atuais terminarem antes de disparar mais. Máximo: ${MAX_PARALELOS}.`,
    });
  }

  // Valida que todos os jobs existem e estão pendentes
  const { data: jobsValidos, error } = await supabase
    .from("unimed_aprovacao_jobs")
    .select("id, status")
    .in("id", jobIds);

  if (error) {
    return res.status(500).json({ erro: `Erro Supabase: ${error.message}` });
  }

  const idsValidos = (jobsValidos ?? [])
    .filter((j: any) => j.status === "pendente")
    .map((j: any) => j.id as string);

  const idsRecusados = jobIds.filter((id: string) => !idsValidos.includes(id));

  // Responde imediatamente
  res.status(202).json({
    aceitos: idsValidos.length,
    recusados: idsRecusados.length,
    detalhes_recusados: idsRecusados.length
      ? "Jobs já não estão pendentes (talvez foram disparados antes ou estão executando)"
      : undefined,
  });

  // Dispara em fila sequencial (um por vez) com intervalo entre jobs
  const DELAY_ENTRE_JOBS_MS = 3_000; // 3s entre jobs (só pra não ser simultâneo)
  (async () => {
    for (let i = 0; i < idsValidos.length; i++) {
      const jobId = idsValidos[i];
      // Delay entre jobs (não no primeiro)
      if (i > 0) {
        console.log(`[fila] Aguardando ${DELAY_ENTRE_JOBS_MS / 1000}s antes do próximo job...`);
        await new Promise((r) => setTimeout(r, DELAY_ENTRE_JOBS_MS));
      }
      jobsEmExecucao.add(jobId);
      console.log(`[fila] Iniciando job ${jobId} (${i + 1}/${idsValidos.length})`);
      try {
        await executarJob(jobId);
      } catch (e: any) {
        console.error(`[${jobId}] Erro fora do executor:`, e.message);
      } finally {
        jobsEmExecucao.delete(jobId);
      }
    }
    console.log(`[fila] Todos os ${idsValidos.length} jobs concluídos`);
  })().catch((e) => console.error("Erro na fila:", e));
});

// ============================================================================
// Executar Sessão (robô de execução de guias)
// ============================================================================

const sessoesEmExecucao = new Set<string>();

app.post("/executar-sessao", async (req, res) => {
  const dados = req.body as DadosExecucaoSessao | undefined;

  if (!dados?.sessao_id || !dados?.paciente?.nome_completo || !dados?.paciente?.carteirinha) {
    return res.status(400).json({
      erro: "Campos obrigatórios: sessao_id, paciente.nome_completo, paciente.carteirinha",
    });
  }

  // Limite: 1 execução de sessão por vez (operador precisa estar presente pra QR Code)
  if (sessoesEmExecucao.size >= 1) {
    return res.status(429).json({
      erro: "Já existe uma execução de sessão em andamento. Aguarde o operador finalizar o QR Code.",
    });
  }

  // Criar job no Supabase
  const { data: job, error } = await supabase
    .from("unimed_execucao_jobs")
    .insert({
      sessao_id: dados.sessao_id,
      paciente_nome_snapshot: dados.paciente.nome_completo,
      paciente_carteirinha_snapshot: dados.paciente.carteirinha,
      guia_codigo_snapshot: dados.guia?.codigo || "",
      data_execucao_snapshot: dados.data_execucao || new Date().toISOString().slice(0, 10),
      status: "pendente",
    })
    .select("id")
    .single();

  if (error || !job) {
    return res.status(500).json({ erro: `Erro ao criar job: ${error?.message}` });
  }

  // Responde imediatamente
  res.status(202).json({ aceito: true, execucao_id: job.id });

  // Executa em background (fire-and-forget)
  sessoesEmExecucao.add(job.id);
  executarSessaoJob(job.id, dados)
    .catch((e) => console.error(`[exec-${job.id}] Erro fora do executor:`, e.message))
    .finally(() => sessoesEmExecucao.delete(job.id));
});

// ============================================================================
// Status (debug)
// ============================================================================

app.get("/jobs/:id/status", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("unimed_aprovacao_jobs")
    .select("id, status, numero_guia_unimed, erro_codigo, erro_mensagem, duracao_ms")
    .eq("id", id)
    .maybeSingle();

  if (error) return res.status(500).json({ erro: error.message });
  if (!data) return res.status(404).json({ erro: "Job não encontrado" });

  res.json({
    ...data,
    em_execucao_local: jobsEmExecucao.has(id),
  });
});

// ============================================================================
// Verificação de guias em análise
// ============================================================================

// Estado: evita verificar 2x em paralelo (cron + manual sobreposto, ou 2 manuais)
let verificacaoEmAndamento = false;

/**
 * Verifica TODAS as guias em análise.
 * Aceita { forcar?: true } pra incluir guias com mais de 15 dias (fora do prazo
 * automático). Sem body, faz verificação padrão.
 */
app.post("/verificar-em-analise", async (req, res) => {
  if (verificacaoEmAndamento) {
    return res.status(429).json({
      erro: "Já existe uma verificação em andamento. Aguarde terminar.",
    });
  }

  const forcar = req.body?.forcar === true;

  // Responde imediatamente — processamento em background
  res.status(202).json({ aceito: true, forcar });

  verificacaoEmAndamento = true;
  try {
    await verificarJobsEmAnalise(forcar);
  } catch (e: any) {
    console.error("[cron] Erro fatal na verificação:", e.message);
  } finally {
    verificacaoEmAndamento = false;
  }
});

/**
 * Verifica UMA guia específica (botão manual na UI).
 * Síncrono: aguarda terminar e retorna resultado.
 */
app.post("/verificar/:jobId", async (req, res) => {
  const { jobId } = req.params;

  if (verificacaoEmAndamento) {
    return res.status(429).json({
      erro: "Já existe uma verificação em andamento. Aguarde terminar.",
    });
  }

  verificacaoEmAndamento = true;
  try {
    const r = await verificarUmaGuia(jobId);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ ok: false, erro: e.message });
  } finally {
    verificacaoEmAndamento = false;
  }
});

// ============================================================================
// Cron interno: verifica a cada 4 horas
// ============================================================================

const CRON_INTERVALO_MS = 4 * 60 * 60 * 1000; // 4 horas
let cronHandle: NodeJS.Timeout | null = null;

async function rodarCron() {
  if (verificacaoEmAndamento) {
    console.log("[cron] Já tem verificação em andamento, pulando este ciclo.");
    return;
  }
  verificacaoEmAndamento = true;
  try {
    await verificarJobsEmAnalise(false);
  } catch (e: any) {
    console.error("[cron] Erro fatal:", e.message);
  } finally {
    verificacaoEmAndamento = false;
  }
}

function iniciarCron() {
  // Roda primeira verificação 5min depois do startup (evita peso no boot)
  const delayInicial = 5 * 60 * 1000;
  setTimeout(() => {
    rodarCron();
    cronHandle = setInterval(rodarCron, CRON_INTERVALO_MS);
  }, delayInicial);
}

// ============================================================================
// Inicialização e cleanup
// ============================================================================

const server = app.listen(config.port, () => {
  console.log("\n===========================================");
  console.log(`  🤖 Robô Unimed — Servidor Local`);
  console.log("===========================================");
  console.log(`  Servidor escutando em http://localhost:${config.port}`);
  console.log(`  PID: ${process.pid}`);
  console.log(`  Caminho do robô: ${config.roboCaminho}`);
  console.log(`  Headless: ${config.roboHeadless ? "SIM" : "NÃO (visível)"}`);
  console.log(`  Timeout por job: ${config.roboTimeoutMs / 1000}s`);
  console.log(`  Origens CORS: ${config.corsOrigins.join(", ")}`);
  console.log(`  Cron de verificação: a cada 4h, guias até 15 dias`);
  console.log("===========================================\n");
  console.log("Pode minimizar essa janela. Não feche.\n");

  // Inicia cron de verificação automática
  iniciarCron();
});

// Cleanup quando recebe SIGTERM/SIGINT
async function cleanup() {
  console.log("\nFechando servidor...");
  if (cronHandle) {
    clearInterval(cronHandle);
    cronHandle = null;
  }
  if (jobsEmExecucao.size > 0) {
    console.log(
      `${jobsEmExecucao.size} job(s) em execução. Aguardando até 30s pra terminarem...`
    );
    const ate = Date.now() + 30_000;
    while (jobsEmExecucao.size > 0 && Date.now() < ate) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (jobsEmExecucao.size > 0) {
      console.warn(`${jobsEmExecucao.size} job(s) ainda em execução. Encerrando assim mesmo.`);
    }
  }
  server.close(() => {
    console.log("Servidor fechado.");
    process.exit(0);
  });
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
