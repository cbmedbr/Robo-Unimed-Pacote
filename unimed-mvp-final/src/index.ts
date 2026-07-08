#!/usr/bin/env node
import fs from "fs";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { InputAutorizacao, ResultadoAutorizacao } from "./types";
import { validarInput, ErroValidacao } from "./validacao";
import { executarAutorizacao } from "./autorizacao";
import { verificarStatusEmLote } from "./verificar_status";
import { executarSessao } from "./executar_sessao";
import { DadosExecucao } from "./execucao/tipos";
import { carregarConfig } from "./utils/config";
import { logger } from "./utils/logger";

async function comandoAutorizar(inputPath: string, dryRun: boolean): Promise<void> {
  if (!fs.existsSync(inputPath)) {
    logger.error({ inputPath }, "arquivo de input não encontrado");
    process.exit(1);
  }

  let input: InputAutorizacao;
  try {
    const conteudo = fs.readFileSync(inputPath, "utf-8");
    input = JSON.parse(conteudo);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "falha ao ler/parsear JSON de input");
    process.exit(1);
  }

  try {
    validarInput(input);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      const resultado: ResultadoAutorizacao = {
        sucesso: false,
        etapa: "validacao",
        erro_codigo: err.erroCodigo,
        mensagem: err.mensagemDetalhada,
        screenshot_path: null,
        tentativas: 0,
        timestamp: new Date().toISOString(),
      };
      console.log(JSON.stringify(resultado, null, 2));
      process.exit(1);
    }
    throw err;
  }

  if (dryRun) {
    logger.info("dry-run: validação OK, não executando robô");
    process.exit(0);
  }

  const config = carregarConfig();

  logger.info(
    { paciente: input.paciente.nome, tipo: input.paciente.tipo },
    "iniciando autorização"
  );

  const resultado = await executarAutorizacao(input, config);

  console.log("\n=== RESULTADO ===");
  console.log(JSON.stringify(resultado, null, 2));

  process.exit(resultado.sucesso ? 0 : 1);
}

async function comandoVerificar(
  guiasPath: string | undefined,
  guiasCli: string[]
): Promise<void> {
  let numeros: string[] = [];

  if (guiasPath) {
    if (!fs.existsSync(guiasPath)) {
      logger.error({ guiasPath }, "arquivo de guias não encontrado");
      process.exit(1);
    }
    try {
      const conteudo = fs.readFileSync(guiasPath, "utf-8");
      const parsed = JSON.parse(conteudo);
      if (!Array.isArray(parsed)) {
        throw new Error("arquivo deve conter um array de strings");
      }
      numeros = parsed.map((v) => String(v));
    } catch (err) {
      logger.error({ err: (err as Error).message }, "falha ao ler arquivo de guias");
      process.exit(1);
    }
  }

  if (guiasCli.length > 0) {
    numeros = [...numeros, ...guiasCli];
  }

  numeros = Array.from(new Set(numeros.filter((s) => /^\d+$/.test(s))));

  if (numeros.length === 0) {
    logger.error("nenhuma guia válida pra verificar");
    process.exit(1);
  }

  const config = carregarConfig();

  logger.info({ qtd: numeros.length }, "iniciando verificação de status");

  const resultados = await verificarStatusEmLote(numeros, config);

  console.log("\n=== RESULTADO ===");
  console.log(JSON.stringify({ resultados }, null, 2));

  process.exit(0);
}

async function comandoExecutarSessao(inputPath: string): Promise<void> {
  if (!fs.existsSync(inputPath)) {
    logger.error({ inputPath }, "arquivo de input não encontrado");
    process.exit(1);
  }

  let dados: DadosExecucao;
  try {
    const conteudo = fs.readFileSync(inputPath, "utf-8");
    dados = JSON.parse(conteudo);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "falha ao ler/parsear JSON de input");
    process.exit(1);
  }

  if (!dados.sessao_id || !dados.paciente?.nome_completo || !dados.paciente?.carteirinha) {
    logger.error("input inválido: faltam campos obrigatórios (sessao_id, paciente.nome_completo, paciente.carteirinha)");
    process.exit(1);
  }

  logger.info(
    { paciente: dados.paciente.nome_completo, sessao_id: dados.sessao_id },
    "iniciando execução de sessão"
  );

  const resultado = await executarSessao(dados);

  console.log("\n=== RESULTADO ===");
  console.log(JSON.stringify(resultado, null, 2));

  process.exit(resultado.sucesso ? 0 : 1);
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .command(
      ["autorizar", "$0"],
      "Gera uma nova guia na Unimed (comando padrão)",
      (y) =>
        y
          .option("input", {
            alias: "i",
            type: "string",
            describe: "Caminho para o arquivo JSON de input",
            demandOption: true,
          })
          .option("dry-run", {
            type: "boolean",
            default: false,
            describe: "Apenas valida o input, não executa o robô",
          })
    )
    .command(
      "executar-sessao",
      "Executa 1 sessão de uma guia já autorizada (com QR Code)",
      (y) =>
        y.option("input", {
          alias: "i",
          type: "string",
          describe: "Caminho para o arquivo JSON com dados da sessão",
          demandOption: true,
        })
    )
    .command(
      "verificar",
      "Verifica status de guias já geradas (Em estudo / Em análise)",
      (y) =>
        y
          .option("guias-file", {
            type: "string",
            describe: "Caminho para JSON contendo array de números de guia",
          })
          .option("guia", {
            type: "array",
            string: true,
            default: [] as string[],
            describe: "Número da guia (pode repetir: --guia X --guia Y)",
          })
    )
    .help()
    .parseAsync();

  const comando = argv._[0] as string | undefined;

  if (comando === "executar-sessao") {
    await comandoExecutarSessao((argv as any).input as string);
  } else if (comando === "verificar") {
    await comandoVerificar(
      (argv as any)["guias-file"] as string | undefined,
      ((argv as any).guia ?? []) as string[]
    );
  } else {
    await comandoAutorizar(
      (argv as any).input as string,
      ((argv as any)["dry-run"] ?? false) as boolean
    );
  }
}

main().catch((err) => {
  logger.fatal({ err }, "erro não tratado");
  process.exit(1);
});
