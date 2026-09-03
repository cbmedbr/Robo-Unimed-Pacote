// executor-sessao.ts — executa sessão de guia via subprocesso do robô
//
// Análogo ao executor.ts (autorização), mas para o fluxo de execução.
// Recebe dados da sessão, spawna o robô com comando "executar-sessao",
// e atualiza status no Supabase (tabela unimed_execucao_jobs).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { supabase } from "./supabase.js";

const PASTA_TEMP = path.join(os.tmpdir(), "unimed-exec-jobs");
await fs.mkdir(PASTA_TEMP, { recursive: true });

export interface DadosExecucaoSessao {
  sessao_id: string;
  guia: {
    // `id` e a guia que a colaboradora escolheu na tela. O `codigo` e o que o
    // robo digita no filtro do portal; o `id` e o que gravamos no agendamento
    // ao concluir, para o CRM debitar a MESMA guia que foi executada la.
    id?: string | null;
    codigo: string;
    paciente_tipo: "LOCAL" | "INTERCAMBIO";
  };
  paciente: {
    nome_completo: string;
    carteirinha: string;
  };
  data_execucao: string;
  qrcode_valor?: string | null;
}

interface ResultadoExecucao {
  sucesso: boolean;
  comprovante_path?: string | null;
  erro_codigo?: string;
  erro_mensagem?: string;
  duracao_ms?: number;
  /** false quando o portal nao tinha a guia pedida e o robo abriu a primeira */
  guia_codigo_confere?: boolean;
  guia_codigo_pedido?: string;
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

    // fileURLToPath, NÃO `.pathname`: pathname faz percent-encoding e uma pasta
    // com acento vira "Jo%C3%A3o", caminho que não existe. Ver executor.ts.
    const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
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
      const duracao = Date.now() - inicioMs;

      // Parsear JSON do stdout — mesmo padrão robusto do executor.ts
      let parsed: any = null;
      const idxMarcador = stdoutTotal.lastIndexOf("=== RESULTADO ===");
      const trecho = idxMarcador >= 0 ? stdoutTotal.substring(idxMarcador) : stdoutTotal;

      const idxAbre = trecho.indexOf("{");
      const idxFecha = trecho.lastIndexOf("}");
      if (idxAbre >= 0 && idxFecha > idxAbre) {
        try {
          parsed = JSON.parse(trecho.substring(idxAbre, idxFecha + 1));
        } catch {}
      }

      if (parsed && typeof parsed === "object" && typeof parsed.sucesso === "boolean") {
        resolverUmaVez({ ...parsed, duracao_ms: parsed.duracao_ms ?? duracao });
        return;
      }

      // Fallback: sem JSON válido → SEMPRE falha (nunca assumir sucesso por exit code)
      resolverUmaVez({
        sucesso: false,
        erro_codigo: code === 0 ? "RESULTADO_NAO_PARSEAVEL" : "PROCESSO_FALHOU",
        erro_mensagem: code === 0
          ? "Robô terminou mas não produziu resultado JSON válido"
          : `Processo saiu com código ${code}. Stderr: ${stderrTotal.slice(-500)}`,
        duracao_ms: duracao,
      });
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
      // PRIMEIRO: marcar agendamento como executado no CRM
      // Usa data_execucao do agendamento (não a data atual) para respeitar execuções retroativas
      const agUpdate: Record<string, unknown> = {
        status_execucao: "executado",
        data_execucao: dados.data_execucao || new Date().toISOString(),
        executado_por: "Robô Unimed",
      };
      if (dados.qrcode_valor) {
        agUpdate.token_execucao = dados.qrcode_valor;
      }
      // A guia escolhida na tela e a que foi executada no portal — grava ela no
      // agendamento. Sem isto o UPDATE ia sem guia_id, o gatilho
      // trg_vincular_guia_ao_executar mantinha a que ja estava vinculada (ou
      // escolhia uma sozinho, pela data de emissao mais antiga), e o credito de
      // sessoes_executadas mais abaixo caia numa guia possivelmente diferente da
      // que o robo abriu na Unimed.
      if (dados.guia?.id) {
        agUpdate.guia_id = dados.guia.id;
      }

      let agOk = false;
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        const { error: agErr } = await supabase
          .from("agendamentos")
          .update(agUpdate)
          .eq("id", dados.sessao_id);

        if (!agErr) {
          agOk = true;
          console.log(`[exec-${jobId}] Agendamento ${dados.sessao_id} status_execucao → executado`);
          break;
        }
        console.error(`[exec-${jobId}] Erro ao marcar agendamento (tentativa ${tentativa + 1}/2):`, agErr.message);
        if (tentativa === 0) await new Promise(r => setTimeout(r, 1000));
      }

      if (!agOk) {
        console.error(`[exec-${jobId}] ⚠️ Agendamento NÃO atualizado após 2 tentativas — job marcado como sucesso_parcial`);
      }

      // DEPOIS: marcar job como sucesso (ou sucesso_parcial se agendamento não atualizou)
      // A guia pedida pode nao estar em "exames em aberto" — o robo entao abre a
      // primeira da lista. Isso era so um log dentro do robo; agora que a
      // colaboradora escolhe a guia na tela, precisa aparecer no job.
      const guiaDivergiu = resultado.guia_codigo_confere === false;
      if (guiaDivergiu) {
        console.warn(
          `[exec-${jobId}] ⚠️ Guia ${resultado.guia_codigo_pedido} não estava em exames em aberto — o portal executou a primeira da lista`
        );
      }

      const avisoGuia = guiaDivergiu
        ? `Guia ${resultado.guia_codigo_pedido} não estava em exames em aberto — o portal executou a primeira da lista.`
        : null;
      const avisoAgendamento = agOk
        ? null
        : "Executado na Unimed mas falhou ao atualizar agendamento no CRM";
      const avisos = [avisoAgendamento, avisoGuia].filter(Boolean).join(" ");

      await atualizarStatus(jobId, agOk ? "sucesso" : "sucesso_parcial", {
        comprovante_url: resultado.comprovante_path || null,
        duracao_ms: resultado.duracao_ms || (Date.now() - inicioMs),
        ...(avisos ? { erro_mensagem: avisos } : {}),
      });

      // Incrementar sessoes_executadas na guia.
      // Fonte da verdade: a guia que o agendamento tem DEPOIS do update acima.
      // Releitura em vez de confiar em dados.guia.id porque o gatilho do banco
      // pode ter recusado ou substituido a guia enviada — creditar a que a tela
      // pediu, quando o banco gravou outra, e como o saldo saia errado.
      const { data: agData } = await supabase
        .from("agendamentos")
        .select("guia_id")
        .eq("id", dados.sessao_id)
        .maybeSingle();

      if (dados.guia?.id && agData?.guia_id && agData.guia_id !== dados.guia.id) {
        console.warn(
          `[exec-${jobId}] ⚠️ Guia escolhida (${dados.guia.id}) difere da gravada (${agData.guia_id}) — creditando a gravada`
        );
      }

      if (agData?.guia_id) {
        const { data: guiaData } = await supabase
          .from("guias")
          .select("sessoes_executadas")
          .eq("id", agData.guia_id)
          .maybeSingle();

        const atual = guiaData?.sessoes_executadas ?? 0;
        const { error: guiaErr } = await supabase
          .from("guias")
          .update({ sessoes_executadas: atual + 1 })
          .eq("id", agData.guia_id);

        if (guiaErr) {
          console.warn(`[exec-${jobId}] Erro ao incrementar sessoes_executadas:`, guiaErr.message);
        } else {
          console.log(`[exec-${jobId}] Guia ${agData.guia_id} sessoes_executadas: ${atual} → ${atual + 1}`);
        }
      }

      console.log(`[exec-${jobId}] ✅ Sessão executada com sucesso${agOk ? "" : " (parcial — agendamento não atualizado)"}`);
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
