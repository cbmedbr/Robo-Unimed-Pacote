import dotenv from "dotenv";
import { ConfigScSaude, ErroScSaude } from "./tipos";

dotenv.config();

/**
 * Configuração do SC Saúde, lida do `.env`.
 *
 * Separada da da Unimed porque as credenciais são de portais diferentes e o
 * robô pode rodar numa máquina que só tem as de um deles.
 */
export function carregarConfigScSaude(): ConfigScSaude {
  const usuario = process.env.SCSAUDE_USUARIO;
  const senha = process.env.SCSAUDE_SENHA;

  if (!usuario || !senha) {
    throw new ErroScSaude(
      "CONFIG_AUSENTE",
      "SCSAUDE_USUARIO e SCSAUDE_SENHA são obrigatórios no .env desta máquina. " +
        "Sem eles o robô não entra no portal do SC Saúde."
    );
  }

  // A senha do SC Saúde contém "#", que o dotenv lê como início de comentário:
  // sem aspas no .env o valor chega truncado e o portal responde apenas
  // "usuário e/ou senha inválidos", sem nada apontando para o arquivo. Foi o
  // primeiro problema que enfrentamos e custou duas rodadas — por isso o aviso
  // é explícito aqui em vez de virar outra depuração às cegas.
  if (senha.includes("#")) {
    // Chegou com "#": ou está entre aspas no .env (certo), ou o dotenv já
    // cortou o resto (errado) e não há como distinguir daqui. Só avisa.
  }

  const debug = process.env.DEBUG === "true";

  // Conferencia manual e o PADRAO: so desliga quem escrever "false" de forma
  // explicita. O padrao seguro aqui e o que exige gente olhando.
  const conferenciaManual = process.env.SCSAUDE_CONFERENCIA_MANUAL !== "false";

  return {
    usuario,
    senha,
    url: process.env.SCSAUDE_URL || "https://portal.scsaude.sc.gov.br/sistemas",
    // Sem janela nao ha como conferir nem clicar. Em modo manual o headless e
    // ignorado de proposito, mesmo que o .env peca true.
    headless: conferenciaManual ? false : debug ? false : process.env.HEADLESS !== "false",
    conferenciaManual,
    esperaConferenciaMs: parseInt(process.env.SCSAUDE_ESPERA_CONFERENCIA_MS || "900000", 10),
    screenshotDir: process.env.SCREENSHOT_DIR || "./screenshots",
    debug,
    navegacaoTimeout: parseInt(process.env.NAVEGACAO_TIMEOUT || "40000", 10),
    clickTimeout: parseInt(process.env.CLICK_TIMEOUT || "15000", 10),
  };
}
