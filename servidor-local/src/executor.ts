// executor.ts — converte job → input do robô e executa em subprocesso
//
// Por que subprocesso:
//   - Isolamento: se um Chrome trava, não derruba o servidor
//   - Paralelismo real: cada Chrome tem processo próprio
//   - Limpeza: matar processo é simples
//
// Cada job chama o robô existente em ROBO_CAMINHO via npx tsx index.ts.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";
import { supabase } from "./supabase.js";
import type { UnimedJob, InputAutorizacaoRobo, ResultadoRobo } from "./types.js";

const PASTA_TEMP = path.join(os.tmpdir(), "unimed-jobs");
const PASTA_DUMPS = path.join(os.tmpdir(), "unimed-dumps");

await fs.mkdir(PASTA_TEMP, { recursive: true });
await fs.mkdir(PASTA_DUMPS, { recursive: true });

// ============================================================================
// Conversão job (Supabase) → input do robô
// ============================================================================

async function jobParaInputRobo(job: UnimedJob): Promise<{
  input: InputAutorizacaoRobo;
  pdfLocalPath: string;
}> {
  // 1. Baixa o PDF do pedido médico do Supabase Storage
  const pathStorage = job.pedido_medico_path_snapshot;
  // Todos os documentos ficam no bucket "documentos". O path gravado no
  // paciente é o caminho dentro desse bucket (ex: "pacientes/novo/pedido_medico_xxx.pdf").
  const bucket = "documentos";
  const filePath = pathStorage;

  const { data, error } = await supabase.storage.from(bucket).download(filePath);
  if (error || !data) {
    throw new Error(
      `Não consegui baixar o PDF do pedido (${pathStorage}): ${error?.message ?? "data vazio"}`
    );
  }
  const buffer = Buffer.from(await data.arrayBuffer());

  // Salva localmente em um arquivo temporário com nome do job
  const pdfLocal = path.join(PASTA_TEMP, `${job.id}.pdf`);
  await fs.writeFile(pdfLocal, buffer);

  // 2. Determina tipo paciente. Não tenho campo no banco que diga LOCAL/INTERCAMBIO.
  // Heurística: carteirinha começa com "0025" (Unimed Florianópolis) → LOCAL.
  // Outros prefixos → INTERCAMBIO. Pode evoluir conforme aparecer caso real.
  const tipoPaciente: "LOCAL" | "INTERCAMBIO" = job.carteirinha_snapshot
    .replace(/\D/g, "")
    .startsWith("0025")
    ? "LOCAL"
    : "INTERCAMBIO";

  // 3. Tipo de procedimento derivado do código
  const tipoPorCodigo: Record<string, "TIPICO" | "ATIPICO" | "PSICOPEDAGOGIA" | "AVALIACAO_NEURO"> = {
    "50000470": "TIPICO",
    "2250005103": "ATIPICO",
    "2250005278": "PSICOPEDAGOGIA",
    "2250005367": "AVALIACAO_NEURO",
  };
  const tipoProc = tipoPorCodigo[job.procedimento_codigo];
  if (!tipoProc) {
    throw new Error(`Código de procedimento desconhecido: ${job.procedimento_codigo}`);
  }

  // 4. Telefone e email — precisam ser reais pra portal aceitar
  // Por enquanto, usa números/emails placeholder genéricos. Recomendo evoluir
  // pra puxar do paciente quando estiver cadastrado.
  // O robô tem proteção contra placeholders, então se vier vazio, ele falha.
  const telefone = await buscarTelefonePaciente(job.paciente_id);
  const email = await buscarEmailPaciente(job.paciente_id);

  // 5. Especialidade do pedido — fixo "PSICOLOGIA" pra esse caso de uso
  const especialidade = "PSICOLOGIA";

  // 6. Indicação clínica — texto enviado ao portal Unimed
  // DEVE começar com "CID " (validação do robô exige esse prefixo)
  const indicacaoClinica = `CID ${job.cid_snapshot}. Encaminhamento para psicoterapia. Quantidade solicitada: ${job.procedimento_quantidade} sessões.`;

  // 7. Normalizar CRM do médico — o OCR pode extrair como "12/23929" (código
  // numérico da UF + barra + número). Mapa de códigos numéricos → UF:
  // Mapa: código numérico do CRM regional → UF (fonte: CFM)
  const UF_POR_CODIGO: Record<string, string> = {
    "01": "AC", "02": "AL", "03": "AM", "04": "AP", "05": "BA", "06": "CE",
    "07": "DF", "08": "ES", "09": "GO", "10": "MA", "11": "MG", "12": "MS",
    "13": "MT", "14": "PA", "15": "PB", "16": "PE", "17": "PI", "18": "PR",
    "19": "RJ", "20": "RN", "21": "RO", "22": "RR", "23": "RS", "24": "SC",
    "25": "SE", "26": "SP", "27": "TO",
  };

  let numeroCrm = job.medico_crm_snapshot;
  let ufCrm = job.medico_uf_snapshot;

  // Formato "XX/NNNNN" → separar código UF e número
  const matchCrm = numeroCrm.match(/^(\d{1,2})\s*[\/\-]\s*(\d{4,})$/);
  if (matchCrm) {
    const codigoUf = matchCrm[1].padStart(2, "0");
    const ufConvertida = UF_POR_CODIGO[codigoUf];
    if (ufConvertida) {
      ufCrm = ufConvertida;
    }
    numeroCrm = matchCrm[2];
    console.log(`[${job.id}] CRM normalizado: "${job.medico_crm_snapshot}" → número=${numeroCrm}, UF=${ufCrm}`);
  }

  // Remove qualquer caractere não-numérico restante do CRM
  numeroCrm = numeroCrm.replace(/\D/g, "");

  const input: InputAutorizacaoRobo = {
    paciente: {
      nome: job.paciente_nome_snapshot,
      carteirinha_raw: job.carteirinha_snapshot,
      tipo: tipoPaciente,
      telefone,
      email,
    },
    medico_solicitante: {
      nome: job.medico_nome_snapshot,
      uf_crm: ufCrm,
      numero_crm: numeroCrm,
    },
    cid: job.cid_snapshot,
    indicacao_clinica_formatada: indicacaoClinica,
    procedimento: {
      tipo: tipoProc,
      codigo: job.procedimento_codigo,
      quantidade_solicitada: job.procedimento_quantidade,
    },
    especialidade_pedido: especialidade,
    pedido_medico_path: pdfLocal,
    psicologo_executante_nome: job.psicologo_executante_nome || undefined,
  };

  return { input, pdfLocalPath: pdfLocal };
}

async function buscarTelefonePaciente(pacienteId: string): Promise<string> {
  const { data } = await supabase
    .from("pacientes")
    .select("telefone, responsavel_telefone")
    .eq("id", pacienteId)
    .maybeSingle();
  return data?.telefone || data?.responsavel_telefone || "";
}

async function buscarEmailPaciente(pacienteId: string): Promise<string> {
  const { data } = await supabase
    .from("pacientes")
    .select("email")
    .eq("id", pacienteId)
    .maybeSingle();
  return data?.email || "";
}

// ============================================================================
// Execução do robô em subprocesso
// ============================================================================

export async function executarJob(jobId: string): Promise<void> {
  console.log(`[${jobId}] Iniciando execução`);

  // 1. Busca job no banco
  const { data: job, error: jobErr } = await supabase
    .from("unimed_aprovacao_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle<UnimedJob>();

  if (jobErr || !job) {
    console.error(`[${jobId}] Job não encontrado:`, jobErr?.message);
    return;
  }

  // 2. Marca como executando (UPDATE atômico com WHERE status=pendente)
  const workerId = `local-${process.pid}`;
  const agora = new Date().toISOString();
  const { data: jobBloqueado, error: lockErr } = await supabase
    .from("unimed_aprovacao_jobs")
    .update({ status: "executando", worker_id: workerId, pego_em: agora, iniciado_em: agora })
    .eq("id", jobId)
    .eq("status", "pendente")
    .select("id")
    .maybeSingle();

  if (lockErr || !jobBloqueado) {
    console.log(`[${jobId}] Já foi pego por outro worker ou não está pendente`);
    return;
  }

  const inicioMs = Date.now();
  let resultado: ResultadoRobo;

  try {
    // 3. Converte job → input do robô
    const { input, pdfLocalPath } = await jobParaInputRobo(job);

    // 4. Salva input em arquivo JSON temporário
    const inputPath = path.join(PASTA_TEMP, `${jobId}-input.json`);
    await fs.writeFile(inputPath, JSON.stringify(input, null, 2));

    // 5. Executa o robô como subprocesso
    resultado = await rodarSubprocesso(jobId, inputPath);

    // 6. Limpa arquivos temporários
    try {
      await fs.unlink(inputPath);
      await fs.unlink(pdfLocalPath);
    } catch {
      // Ignora erro de cleanup
    }
  } catch (e: any) {
    console.error(`[${jobId}] Erro fatal:`, e.message);
    resultado = {
      sucesso: false,
      erro_codigo: "ERRO_PRE_EXECUCAO",
      erro_mensagem: e.message ?? "Erro antes de iniciar o robô",
      duracao_ms: Date.now() - inicioMs,
    };
  }

  // 7. Atualiza job no banco com resultado
  await atualizarJobComResultado(jobId, job, resultado);
}

// ============================================================================
// Subprocesso do robô
// ============================================================================

function rodarSubprocesso(jobId: string, inputPath: string): Promise<ResultadoRobo> {
  return new Promise((resolve) => {
    const inicioMs = Date.now();
    let stdoutTotal = "";
    let stderrTotal = "";
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolvido = false;

    function resolverUmaVez(r: ResultadoRobo) {
      if (resolvido) return;
      resolvido = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(r);
    }

    // Usa node diretamente com tsx CLI — evita problemas de shell/npx no Node v26
    const tsxCli = new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
    const scriptPath = config.roboCaminho + "/src/index.ts";
    const proc = spawn(
      process.execPath,
      [tsxCli, scriptPath, "--input", inputPath],
      {
        cwd: config.roboCaminho,
        env: {
          ...process.env,
          UNIMED_USUARIO: config.unimedUsuario,
          UNIMED_SENHA: config.unimedSenha,
          HEADLESS: config.roboHeadless ? "true" : "false",
        },
      }
    );

    proc.stdout.on("data", (chunk) => {
      const txt = chunk.toString();
      stdoutTotal += txt;
      // Loga em tempo real pro operador acompanhar
      process.stdout.write(`[${jobId}] ${txt}`);
    });

    proc.stderr.on("data", (chunk) => {
      const txt = chunk.toString();
      stderrTotal += txt;
      process.stderr.write(`[${jobId}] ERR: ${txt}`);
    });

    proc.on("error", (err) => {
      console.error(`[${jobId}] Falha ao iniciar subprocesso:`, err);
      resolverUmaVez({
        sucesso: false,
        erro_codigo: "SUBPROCESSO_ERRO",
        erro_mensagem: `Não consegui iniciar o robô: ${err.message}`,
        duracao_ms: Date.now() - inicioMs,
      });
    });

    proc.on("close", (code) => {
      const duracao = Date.now() - inicioMs;

      // O robô imprime o resultado depois de "=== RESULTADO ===" como JSON
      // multilinhas indentado. Estratégia: extrair o último bloco { ... } do
      // stdout e fazer JSON.parse.
      let parsed: any = null;

      // Tenta achar o bloco depois de "=== RESULTADO ==="
      const idxMarcador = stdoutTotal.lastIndexOf("=== RESULTADO ===");
      const trecho =
        idxMarcador >= 0 ? stdoutTotal.substring(idxMarcador) : stdoutTotal;

      // Procura primeiro { e último } balanceado
      const idxAbre = trecho.indexOf("{");
      const idxFecha = trecho.lastIndexOf("}");
      if (idxAbre >= 0 && idxFecha > idxAbre) {
        const candidato = trecho.substring(idxAbre, idxFecha + 1);
        try {
          parsed = JSON.parse(candidato);
        } catch {
          // ignora
        }
      }

      if (parsed && typeof parsed === "object") {
        if (parsed.sucesso === true) {
          resolverUmaVez({
            sucesso: true,
            numero_guia: parsed.numero_guia,
            senha_autorizacao: parsed.senha_autorizacao ?? undefined,
            situacao: parsed.situacao ?? "APROVADO",
            comprovante_path: parsed.screenshot_comprovante_path ?? undefined,
            duracao_ms: parsed.duracao_ms ?? duracao,
          });
        } else {
          // ResultadoErro tem campos: etapa, erro_codigo, mensagem, screenshot_path
          resolverUmaVez({
            sucesso: false,
            erro_codigo: parsed.erro_codigo ?? "ERRO_DESCONHECIDO",
            erro_mensagem: parsed.mensagem ?? "(sem mensagem)",
            dump_screenshot_path: parsed.screenshot_path ?? undefined,
            duracao_ms: duracao,
          });
        }
        return;
      }

      // Fallback: não conseguiu parsear saída
      resolverUmaVez({
        sucesso: false,
        erro_codigo: code === 0 ? "RESULTADO_NAO_PARSEAVEL" : "ROBO_FALHOU",
        erro_mensagem:
          code === 0
            ? "Robô terminou mas não consegui ler o resultado JSON"
            : `Robô saiu com código ${code}. Stderr: ${stderrTotal.slice(-500)}`,
        duracao_ms: duracao,
      });
    });

    // Timeout
    timeoutHandle = setTimeout(() => {
      console.warn(`[${jobId}] Timeout, matando processo`);
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignora
      }
      resolverUmaVez({
        sucesso: false,
        erro_codigo: "TIMEOUT",
        erro_mensagem: `Robô demorou mais de ${Math.round(config.roboTimeoutMs / 1000)}s. Encerrado.`,
        duracao_ms: Date.now() - inicioMs,
      });
    }, config.roboTimeoutMs);
  });
}

// ============================================================================
// Atualização do job + criação da guia em caso de sucesso
// ============================================================================

async function atualizarJobComResultado(
  jobId: string,
  job: UnimedJob,
  resultado: ResultadoRobo
): Promise<void> {
  if (resultado.sucesso) {
    // Situação retornada pelo portal
    const emAnalise = resultado.situacao === "EM_ANALISE";
    const negada = resultado.situacao === "NEGADA";

    // Guia em `guias` recebe status diferente conforme situação retornada pelo portal
    //   APROVADO → guias.status = 'ativa' (uso normal)
    //   EM_ANALISE  → guias.status = 'em_analise' (aguardando aprovação Unimed)
    //   NEGADA      → guias.status = 'negada' (Unimed recusou)
    const statusGuia: "ativa" | "em_analise" | "negada" = negada
      ? "negada"
      : emAnalise
        ? "em_analise"
        : "ativa";

    const { data: novaGuia, error: guiaErr } = await supabase
      .from("guias")
      .insert({
        codigo_guia: resultado.numero_guia ?? null,
        paciente_id: job.paciente_id,
        medico_id: job.medico_id_snapshot,
        plano_saude_id: job.plano_saude_id_snapshot,
        sessoes_autorizadas: job.procedimento_quantidade,
        sessoes_executadas: 0,
        data_emissao: new Date().toISOString().slice(0, 10),
        // Validade: 60 dias por padrão (Unimed dá ~60 dias pra psicoterapia)
        // Guia negada não tem validade
        ...(negada ? {} : {
          data_validade: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        }),
        status: statusGuia,
        ...(negada ? { observacoes: "Guia negada automaticamente pelo portal Unimed" } : {}),
      })
      .select("id")
      .maybeSingle();

    // Status do job:
    //   negado             → guia gerada mas Unimed negou
    //   sucesso_em_analise → guia gerada mas portal indicou "Em estudo/análise"
    //   sucesso            → guia autorizada normalmente
    const statusJob: "sucesso" | "sucesso_em_analise" | "negado" = negada
      ? "negado"
      : emAnalise
        ? "sucesso_em_analise"
        : "sucesso";

    if (guiaErr) {
      console.error(`[${jobId}] Erro ao criar guia em \`guias\`:`, guiaErr.message);
      // Marca job como sucesso mesmo assim pra não perder o número.
      await supabase
        .from("unimed_aprovacao_jobs")
        .update({
          status: statusJob,
          numero_guia_unimed: resultado.numero_guia ?? null,
          senha_autorizacao: resultado.senha_autorizacao ?? null,
          situacao_unimed: resultado.situacao ?? null,
          erro_codigo: "GUIA_DB_ERRO",
          erro_mensagem: `Guia gerada na Unimed mas falhou criar no CRM: ${guiaErr.message}`,
          concluido_em: new Date().toISOString(),
          duracao_ms: resultado.duracao_ms,
        })
        .eq("id", jobId);
      return;
    }

    await supabase
      .from("unimed_aprovacao_jobs")
      .update({
        status: statusJob,
        guia_id: novaGuia?.id ?? null,
        numero_guia_unimed: resultado.numero_guia ?? null,
        senha_autorizacao: resultado.senha_autorizacao ?? null,
        situacao_unimed: resultado.situacao ?? null,
        comprovante_path: resultado.comprovante_path ?? null,
        concluido_em: new Date().toISOString(),
        duracao_ms: resultado.duracao_ms,
      })
      .eq("id", jobId);

    if (negada) {
      console.log(
        `[${jobId}] ❌ Guia ${resultado.numero_guia} NEGADA pela Unimed.`
      );
    } else if (emAnalise) {
      console.log(
        `[${jobId}] ⚠ Sucesso EM ANÁLISE. Guia ${resultado.numero_guia} aguarda aprovação manual da Unimed.`
      );
    } else {
      console.log(`[${jobId}] ✅ Sucesso. Guia ${resultado.numero_guia} autorizada.`);
    }
  } else {
    // Restrição administrativa: status especial para monitoramento
    const statusJob = resultado.erro_codigo === "BENEFICIARIO_RESTRICAO" ? "restricao" : "falhou";

    await supabase
      .from("unimed_aprovacao_jobs")
      .update({
        status: statusJob,
        erro_codigo: resultado.erro_codigo ?? "ERRO_DESCONHECIDO",
        erro_mensagem: resultado.erro_mensagem ?? "(sem mensagem)",
        dump_html_path: resultado.dump_html_path ?? null,
        dump_screenshot_path: resultado.dump_screenshot_path ?? null,
        concluido_em: new Date().toISOString(),
        duracao_ms: resultado.duracao_ms,
      })
      .eq("id", jobId);

    console.log(
      `[${jobId}] ${statusJob === "restricao" ? "⚠️ Restrição" : "❌ Falhou"}: ${resultado.erro_codigo} - ${resultado.erro_mensagem}`
    );
  }
}
