import dotenv from "dotenv";
import { Config } from "../types";

dotenv.config();

export function carregarConfig(): Config {
  const usuario = process.env.UNIMED_USUARIO;
  const senha = process.env.UNIMED_SENHA;
  const url = process.env.UNIMED_URL || "https://rda.unimedsc.com.br/cmagnet/Login.do";

  if (!usuario || !senha) {
    throw new Error(
      "UNIMED_USUARIO e UNIMED_SENHA são obrigatórios no .env. Copie .env.example para .env e preencha."
    );
  }

  if (senha === "trocar_aqui") {
    throw new Error(
      "Senha ainda está com valor placeholder 'trocar_aqui'. Edite o .env com a senha real."
    );
  }

  const debug = process.env.DEBUG === "true";
  // Em modo debug, força HEADLESS=false para acompanhar visualmente
  const headless = debug ? false : process.env.HEADLESS !== "false";

  return {
    unimedUsuario: usuario,
    unimedSenha: senha,
    unimedUrl: url,
    headless,
    screenshotDir: process.env.SCREENSHOT_DIR || "./screenshots",
    logLevel: process.env.LOG_LEVEL || "info",
    debug,
    navegacaoTimeout: parseInt(process.env.NAVEGACAO_TIMEOUT || "30000", 10),
    clickTimeout: parseInt(process.env.CLICK_TIMEOUT || "10000", 10),
  };
}
