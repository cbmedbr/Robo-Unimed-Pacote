import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "./supabase.js";
import type { UnimedJob } from "./types.js";

/**
 * Robô CASACARESC (portal Benner Conecta), em `robo-casacaresc/` na raiz.
 *
 * Diferente da Unimed e do SC Saúde: é Python, acha o beneficiário pela
 * carteirinha, o SOLICITANTE é o próprio psicólogo (CRP) e não tem anexo.
 * Ele para no resumo e espera uma pessoa clicar em Autorizar (conferência
 * humana obrigatória, pedido da operação em 17/11/2026).
 */

export const PASTA_CASACARESC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "robo-casacaresc"
);

/** Procedimento no Casacaresc, por categoria do CRM (enum: a atípica é `aba`). */
export const PROCEDIMENTO_CASACARESC: Record<string, string> = {
  tipico: "50000470",
  aba: "2250005286",
};

export class ErroPreparoCasacaresc extends Error {
  constructor(
    public codigo: string,
    mensagem: string
  ) {
    super(mensagem);
  }
}

export interface InputCasacaresc {
  job_id: string;
  paciente: { nome: string; carteirinha: string };
  profissional: { nome: string };
  procedimento: { codigo: string; categoria: string; quantidade: number };
}

/**
 * Python que o `preparar.bat` gravou neste PC (`.python-path`). Sem ele, procura
 * nas pastas onde o instalador costuma pôr. Não usa `py`/`python` do PATH: o
 * servidor sobe numa janela aberta antes da instalação e não enxerga o PATH novo
 * (foi o "spawn py ENOENT" de 17/11/2026).
 */
export function pythonCasacaresc(): { cmd: string; args: string[] } | null {
  const arq = path.join(PASTA_CASACARESC, ".python-path");
  if (existsSync(arq)) {
    const exe = readFileSync(arq, "utf8").trim().replace(/^"|"$/g, "");
    if (exe && existsSync(exe)) return { cmd: exe, args: [] };
  }
  const bases = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Python") : "",
    process.env.ProgramFiles ?? "",
  ].filter(Boolean);
  for (const base of bases) {
    if (!existsSync(base)) continue;
    const pastas = readdirSync(base).filter((n) => /^Python3\d+$/i.test(n)).sort().reverse();
    for (const p of pastas) {
      const exe = path.join(base, p, "python.exe");
      if (existsSync(exe)) return { cmd: exe, args: [] };
    }
  }
  return process.platform === "win32" ? null : { cmd: "python3", args: [] };
}

export async function jobParaInputCasacaresc(
  job: UnimedJob
): Promise<{ input: InputCasacaresc; pdfLocalPath: string }> {
  if (!existsSync(path.join(PASTA_CASACARESC, ".env"))) {
    throw new ErroPreparoCasacaresc(
      "CASACARESC_SEM_SENHA",
      "Este computador ainda não tem a senha do portal Casacaresc. " +
        "Feche a janela do robô e abra o iniciar.bat de novo: ele pede a senha."
    );
  }

  if (!pythonCasacaresc()) {
    throw new ErroPreparoCasacaresc(
      "PYTHON_AUSENTE",
      "Este computador ainda não tem o Python, que o robô da Casacaresc usa. " +
        "Feche a janela do robô e abra o iniciar.bat de novo: ele instala sozinho."
    );
  }

  const categoria = job.procedimento_categoria ?? "tipico";
  const codigo = PROCEDIMENTO_CASACARESC[categoria];
  if (!codigo) {
    throw new ErroPreparoCasacaresc(
      "PROCEDIMENTO_SEM_EQUIVALENTE",
      `O robô Casacaresc só pede sessão típica e TEA (ABA), não "${categoria}". ` +
        "Esse pedido precisa ser feito por fora."
    );
  }

  let carteirinha = (job.carteirinha_snapshot ?? "").replace(/\D/g, "");
  if (!carteirinha) {
    const { data: paciente } = await supabase
      .from("pacientes")
      .select("numero_carteirinha")
      .eq("id", job.paciente_id)
      .maybeSingle();
    carteirinha = (paciente?.numero_carteirinha ?? "").replace(/\D/g, "");
  }
  if (!carteirinha) {
    throw new ErroPreparoCasacaresc(
      "CARTEIRINHA_AUSENTE",
      `O paciente ${job.paciente_nome_snapshot} está sem carteirinha no cadastro. ` +
        "O portal Casacaresc localiza o beneficiário pela carteirinha."
    );
  }

  const psicologo = (job.psicologo_executante_nome ?? "").trim();
  if (!psicologo) {
    throw new ErroPreparoCasacaresc(
      "PSICOLOGO_AUSENTE",
      "O pedido veio sem psicólogo. No Casacaresc o solicitante é o psicólogo que atende."
    );
  }

  const quantidade = Number(job.procedimento_quantidade ?? 0);
  if (!(quantidade > 0)) {
    throw new ErroPreparoCasacaresc("QUANTIDADE_INVALIDA", "Quantidade de sessões zerada no pedido.");
  }

  return {
    // Casacaresc não tem anexo. String vazia: o unlink do executor falha calado.
    pdfLocalPath: "",
    input: {
      job_id: job.id,
      paciente: { nome: job.paciente_nome_snapshot, carteirinha },
      profissional: { nome: psicologo },
      procedimento: { codigo, categoria, quantidade },
    },
  };
}
