// config.ts — carrega e valida variáveis de ambiente

import "dotenv/config";

function obrigatorio(nome: string): string {
  const v = process.env[nome];
  if (!v) {
    console.error(`\n❌ Variável de ambiente obrigatória ausente: ${nome}`);
    console.error(`   Verifique seu arquivo .env\n`);
    process.exit(1);
  }
  return v;
}

function opcional(nome: string, padrao: string): string {
  return process.env[nome] ?? padrao;
}

export const config = {
  supabaseUrl: obrigatorio("SUPABASE_URL"),
  supabaseServiceRoleKey: obrigatorio("SUPABASE_SERVICE_ROLE_KEY"),
  unimedUsuario: obrigatorio("UNIMED_USUARIO"),
  unimedSenha: obrigatorio("UNIMED_SENHA"),

  // ---------------------------------------------------------------------
  // SC Saúde — desligado por padrão
  //
  // O `iniciar.bat` puxa da main automaticamente, então manter o código numa
  // branch não protegeria ninguém: no instante do merge, todas as máquinas
  // recebem. O isolamento é em tempo de execução — só a máquina com
  // SCSAUDE_HABILITADO=true no .env aceita job de SC Saúde.
  //
  // As credenciais são opcionais de propósito: a máquina que não opera SC
  // Saúde não precisa tê-las, e o servidor não deve recusar a subir por isso.
  // ---------------------------------------------------------------------
  scsaudeHabilitado: opcional("SCSAUDE_HABILITADO", "false") === "true",
  scsaudeUsuario: process.env.SCSAUDE_USUARIO ?? "",
  scsaudeSenha: process.env.SCSAUDE_SENHA ?? "",
  roboCaminho: obrigatorio("ROBO_CAMINHO"),
  roboTimeoutMs: parseInt(opcional("ROBO_TIMEOUT_MS", "180000"), 10),

  // O SC Saúde para e espera a pessoa conferir antes de emitir, então o job
  // dura o tempo de alguém ler a tela com calma. Com os 3 minutos da Unimed o
  // servidor mataria o robô no meio da conferência, fechando a janela com a
  // guia preenchida na frente da pessoa. 25 minutos cobre a espera de 15 do
  // robô mais o tempo de preencher.
  scsaudeTimeoutMs: parseInt(opcional("SCSAUDE_TIMEOUT_MS", "1500000"), 10),
  roboHeadless: opcional("ROBO_HEADLESS", "false") === "true",
  port: parseInt(opcional("PORT", "9876"), 10),
  corsOrigins: opcional("CORS_ORIGINS", "*").split(",").map((s) => s.trim()),
};
