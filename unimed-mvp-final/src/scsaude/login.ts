import { Page } from "playwright";
import { logger } from "../utils/logger";
import { ConfigScSaude, ErroScSaude } from "./tipos";

/**
 * Login no portal do SC Saúde e entrada no sistema "Atendimento".
 *
 * Duas coisas que custaram tempo no reconhecimento:
 *
 * 1. O botão Entrar é `input[type=submit]` com `value="Entrar"` e **não tem
 *    texto**. Clicar por texto acha outro elemento e o formulário nunca é
 *    enviado — sem erro, a página só fica parada.
 * 2. Entrar em "Atendimento" troca de domínio (`portal.` → `atendimento.`), e
 *    qualquer `page.evaluate()` disparado cedo demais morre na navegação.
 */
export async function fazerLoginScSaude(page: Page, config: ConfigScSaude): Promise<void> {
  logger.info({ url: config.url }, "abrindo portal do SC Saúde");

  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: config.navegacaoTimeout });

  await page.locator('input[name="username"]').fill(config.usuario);
  await page.locator('input[name="password"]').fill(config.senha);
  await page.locator('input[name="submit"]').click();

  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});

  // Erro de login tem lugar próprio na tela. Ler isso evita que a falha vire
  // um timeout genérico três passos adiante.
  for (const sel of ["#login-error", "#username-error", "#password-error"]) {
    const texto = await page
      .locator(sel)
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => null);
    const limpo = (texto || "").replace(/\s+/g, " ").trim();
    if (limpo) {
      throw new ErroScSaude(
        "LOGIN_FALHOU",
        `Portal recusou o login: "${limpo}". Confira SCSAUDE_USUARIO e SCSAUDE_SENHA no .env — ` +
          "lembrando que a senha precisa estar entre aspas, porque contém #."
      );
    }
  }

  logger.info("login aceito — entrando em Atendimento");

  const atendimento = page.getByText(/Atendimento/i).first();
  if (!(await atendimento.isVisible({ timeout: 15000 }).catch(() => false))) {
    throw new ErroScSaude(
      "MENU_NAO_ENCONTRADO",
      'Entrou no portal mas não achou o sistema "Atendimento" na tela de sistemas disponíveis.'
    );
  }

  await atendimento.click();

  // Troca de domínio: esperar a navegação assentar antes de qualquer leitura.
  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});
  logger.info({ url: page.url() }, "dentro do Atendimento");
}
