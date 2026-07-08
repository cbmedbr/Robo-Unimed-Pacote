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
  roboCaminho: obrigatorio("ROBO_CAMINHO"),
  roboTimeoutMs: parseInt(opcional("ROBO_TIMEOUT_MS", "180000"), 10),
  roboHeadless: opcional("ROBO_HEADLESS", "false") === "true",
  port: parseInt(opcional("PORT", "9876"), 10),
  corsOrigins: opcional("CORS_ORIGINS", "*").split(",").map((s) => s.trim()),
};
