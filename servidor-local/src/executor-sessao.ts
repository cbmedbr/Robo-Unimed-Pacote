// executor-sessao.ts — executa sessão de guia via subprocesso do robô
//
// Análogo ao executor.ts (autorização), mas para o fluxo de execução.
// Recebe dados da sessão, spawna o robô com comando "executar-sessao",
// e atualiza status no Supabase (tabela unimed_execucao_jobs).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";
import { supabase } from "./supabase.js";

const PASTA_TEMP = path.join(os.tmpdir(), "unimed-exec-jobs");
await fs.mkdir(PASTA_TEMP, { recursive: true });

export interface DadosExecucaoSessao {
  sessao_id: string;
  guia: {
    codigo: string;
    paciente_tipo: "LOCAL" | "INTERCAMBIO";
  };
  paciente: {
    nome_completo: string;
    carteirinha: string;
  };
  data_execucao: string;
}

interface ResultadoExecucao {
  sucesso: boolean;
  comprovante_path?: string | null;
  erro_codigo?: string;
  erro_mensagem?: string;
  duracao_ms?: number;
}

// ============================================================================
// Atualizar status no Supabase
// ============================================================================

async function atualizarStatus(
  jobId: string,
  status: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const update: Record<string, unknown> = { status, ...extra };

  if (status === "executando") update.iniciado_em = new Date().toISOString();
  if (status === "aguardando_qrcode") update.qrcode_aberto_em = new Date().toISOString();
  if (status === "sucesso" || status === "falhou") update.concluido_em = new Date().toISOString();

  const { error } = await supabase
    .from("unimed_execucao_jobs")
    .update(update)
    .eq("id", jobId);

  if (error) {
    console.error(`[exec-${jobId}] Erro ao atualizar status:`, error.message);
  }
}

// ============================================================================
// Execução do robô em subprocesso
// ============================================================================

function rodarSubprocesso(jobId: string, inputPath: string): Promise<ResultadoExecucao> {
  return new Promise((resolve) => {
    const inicioMs = Date.now();
    let stdoutTotal = "";
    let stderrTotal = "";
    let resolvido = false;

    function resolverUmaVez(r: ResultadoExecucao) {
      if (resolvido) return;
      resolvido = true;
      resolve(r);
    }

    const tsxCli = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
    const scriptPath = config.roboCaminho + "/src/index.ts";
    const proc = spawn(
      process.execPath,
      [tsxCli, scriptPath, "executar-sessao", "--input", inputPath],
      {
        cwd: config.roboCaminho,
        env: {
          ...process.env,
          UNIMED_USUARIO: config.unimedUsuario,
          UNIMED_SENHA: config.unimedSenha,
          HEADLESS: "false",
        },
      }
    );

    // Timeout de 5 minutos (mais que autorização — inclui tempo do QR Code)
    const timeout = setTimeout(() => {
      console.error(`[exec-${jobId}] Timeout (5 min) — matando processo`);
      proc.kill("SIGKILL");
      resolverUmaVez({
        sucesso: false,
        erro_codigo: "TIMEOUT",
        erro_mensagem: "Execução excedeu 5 minutos",
        duracao_ms: Date.now() - inicioMs,
      });
    }, 5 * 60 * 1000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutTotal += text;
      process.stdout.write(`[exec-${jobId}] ${text}`);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTotal += text;
      process.stderr.write(`[exec-${jobId}] ${text}`);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);

      // Tentar parsear JSON do stdout
      try {
        const match = stdoutTotal.match(/\{[\s\S]*"sucesso"\s*:/);
        if (match) {
          const jsonStart = stdoutTotal.indexOf("{", stdoutTotal.indexOf("RESULTADO"));
          if (jsonStart >= 0) {
            const parsed = JSON.parse(stdoutTotal.slice(jsonStart));
            resolverUmaVez({
              ...parsed,
              duracao_ms: Date.now() - inicioMs,
            });
            return;
          }
        }
      } catch {}

      if (code === 0) {
        resolverUmaVez({ sucesso: true, duracao_ms: Date.now() - inicioMs });
      } else {
        resolverUmaVez({
          sucesso: false,
          erro_codigo: "PROCESSO_FALHOU",
          erro_mensagem: stderrTotal.slice(-500) || `Processo saiu com código ${code}`,
          duracao_ms: Date.now() - inicioMs,
        });
      }
    });
  });
}

// ============================================================================
// Entry point
// ============================================================================

export async function executarSessaoJob(
  jobId: string,
  dados: DadosExecucaoSessao
): Promise<void> {
  console.log(`[exec-${jobId}] Iniciando execução de sessão`);

  // Atualizar status para executando
  await atualizarStatus(jobId, "executando");

  const inicioMs = Date.now();

  try {
    // Salvar input em arquivo temporário
    const inputPath = path.join(PASTA_TEMP, `${jobId}-input.json`);
    await fs.writeFile(inputPath, JSON.stringify(dados, null, 2));

    // Rodar robô como subprocesso
    const resultado = await rodarSubprocesso(jobId, inputPath);

    // Limpar arquivo temporário
    try { await fs.unlink(inputPath); } catch {}

    // Atualizar job com resultado
    if (resultado.sucesso) {
      await atualizarStatus(jobId, "sucesso", {
        comprovante_url: resultado.comprovante_path || null,
        duracao_ms: resultado.duracao_ms || (Date.now() - inicioMs),
      });
      console.log(`[exec-${jobId}] ✅ Sessão executada com sucesso`);
    } else {
      await atualizarStatus(jobId, "falhou", {
        erro_codigo: resultado.erro_codigo,
        erro_mensagem: resultado.erro_mensagem,
        duracao_ms: resultado.duracao_ms || (Date.now() - inicioMs),
      });
      console.log(`[exec-${jobId}] ❌ Falhou: ${resultado.erro_codigo} — ${resultado.erro_mensagem}`);
    }
  } catch (e: any) {
    console.error(`[exec-${jobId}] Erro fatal:`, e.message);
    await atualizarStatus(jobId, "falhou", {
      erro_codigo: "ERRO_PRE_EXECUCAO",
      erro_mensagem: e.message || "Erro antes de iniciar o robô",
      duracao_ms: Date.now() - inicioMs,
    });
  }
}
