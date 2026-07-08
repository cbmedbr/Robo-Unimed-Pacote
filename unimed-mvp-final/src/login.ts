import { Page } from "playwright";
import { logger } from "./utils/logger";
import { Config } from "./types";

/**
 * Faz login no portal SGU-Card.
 *
 * NOTA SOBRE SELETORES: o portal é Java/Struts antigo. Os seletores abaixo
 * são tentativas baseadas em padrões comuns. Se falharem, ajuste inspecionando
 * o DOM real do portal. Os fallbacks tentam várias estratégias.
 */
export async function fazerLogin(page: Page, config: Config): Promise<void> {
  logger.info({ url: config.unimedUrl }, "navegando para portal");

  await page.goto(config.unimedUrl, {
    waitUntil: "networkidle",
    timeout: config.navegacaoTimeout,
  });

  logger.info("preenchendo credenciais");

  // Tenta múltiplos seletores possíveis para o campo de usuário
  const seletoresUsuario = [
    'input[name="cd_usuario"]',
    'input[name="usuario"]',
    'input[name="login"]',
    'input[id="cd_usuario"]',
    'input[type="text"]:visible',
  ];

  let preenchido = false;
  for (const sel of seletoresUsuario) {
    try {
      const elem = page.locator(sel).first();
      if (await elem.isVisible({ timeout: 2000 })) {
        await elem.fill(config.unimedUsuario);
        preenchido = true;
        logger.debug({ seletor: sel }, "campo usuário preenchido");
        break;
      }
    } catch {
      // tenta próximo
    }
  }

  if (!preenchido) {
    throw new Error("LOGIN_FALHOU: campo de usuário não encontrado. Verifique seletores em src/login.ts");
  }

  // Senha
  const seletoresSenha = [
    'input[name="senha"]',
    'input[name="password"]',
    'input[type="password"]',
  ];

  preenchido = false;
  for (const sel of seletoresSenha) {
    try {
      const elem = page.locator(sel).first();
      if (await elem.isVisible({ timeout: 2000 })) {
        await elem.fill(config.unimedSenha);
        preenchido = true;
        logger.debug({ seletor: sel }, "campo senha preenchido");
        break;
      }
    } catch {
      // tenta próximo
    }
  }

  if (!preenchido) {
    throw new Error("LOGIN_FALHOU: campo de senha não encontrado");
  }

  // Botão entrar
  logger.info("clicando entrar");
  const botaoEntrar = [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Entrar")',
    'input[value*="Entrar" i]',
  ];

  let clicado = false;
  for (const sel of botaoEntrar) {
    try {
      const elem = page.locator(sel).first();
      if (await elem.isVisible({ timeout: 2000 })) {
        await elem.click();
        clicado = true;
        break;
      }
    } catch {
      // tenta próximo
    }
  }

  if (!clicado) {
    // Fallback: tenta submit pelo Enter
    logger.warn("botão entrar não encontrado, tentando Enter");
    await page.keyboard.press("Enter");
  }

  // Aguarda redirecionamento pós-login
  // Sucesso é caracterizado por sair da página de login
  // (URL não contém mais Login.do, ou aparece menu superior com "Exames")
  try {
    await Promise.race([
      page.waitForURL((url) => !url.toString().includes("Login.do"), {
        timeout: config.navegacaoTimeout,
      }),
      page.waitForSelector('text=Exames', { timeout: config.navegacaoTimeout }),
    ]);
  } catch {
    throw new Error("LOGIN_FALHOU: portal não redirecionou após login. Verifique credenciais.");
  }

  logger.info("login bem-sucedido");

  if (config.debug) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
