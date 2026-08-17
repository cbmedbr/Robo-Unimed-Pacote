// senha-versao.ts — impede o servidor de subir com a senha do portal desatualizada
//
// Como funciona:
//   SENHA_VERSAO.txt  → versionado no GitHub, muda quando a senha do portal é trocada
//   .senha-versao     → só existe neste PC, gravado pelo trocar-senha.ps1
//
// Normalmente quem faz essa checagem é o `iniciar-servidor.bat`, que pede a
// senha antes de subir o servidor. Esta função é a rede de segurança para o
// caso em que o `.bat` não rodou a checagem — em especial a PRIMEIRA execução
// depois de um `git pull` que atualizou os próprios `.bat` (o cmd.exe lê o
// arquivo enquanto executa e pode perder as linhas novas).
//
// Sem isso, o servidor subiria com a senha antiga e só falharia lá na frente,
// no login do portal, no meio de um atendimento.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");

function lerArquivo(caminho: string): string {
  try {
    return fs.readFileSync(caminho, "utf8").replace(/^﻿/, "").trim();
  } catch {
    return "";
  }
}

export function verificarVersaoSenha(): void {
  const esperada = lerArquivo(path.join(RAIZ, "SENHA_VERSAO.txt"));

  // Sem o arquivo de controle não há o que verificar (ex: servidor rodando
  // fora da pasta do repositório).
  if (!esperada) return;

  const aplicada = lerArquivo(path.join(RAIZ, ".senha-versao"));
  if (aplicada === esperada) return;

  console.error("");
  console.error("============================================================");
  console.error("  A SENHA DO PORTAL UNIMED FOI TROCADA");
  console.error("============================================================");
  console.error("");
  console.error("  Este computador ainda está com a senha antiga, então o robô");
  console.error("  não conseguiria entrar no portal.");
  console.error("");
  console.error("  O QUE FAZER:");
  console.error("    1. Feche esta janela");
  console.error("    2. Abra o arquivo  trocar-senha.bat");
  console.error("    3. Digite a senha nova");
  console.error("    4. Abra o iniciar.bat de novo");
  console.error("");
  console.error("  Se você não tem a senha, peça ao responsável pelo robô.");
  console.error("");
  console.error("============================================================");
  console.error("");

  process.exit(1);
}
