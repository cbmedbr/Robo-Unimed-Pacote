import { Page } from "playwright";
import { logger } from "../utils/logger";
import { RoboError } from "./tipos";

/**
 * Etapas 2-3: Navega pelo menu para "Exames em aberto", filtra por nome
 * do paciente e clica na guia correta.
 *
 * Baseado no fluxo confirmado do robô de coleta (examesEmAberto.ts).
 */
export async function buscarEAbrirGuia(
  page: Page,
  nomePaciente: string,
  timeout: number,
  codigoGuia?: string
): Promise<void> {
  // 1. Navegar pelo menu (igual robô de coleta)
  logger.info("navegando pelo menu: Exames > Exames em aberto");

  await page.locator('#mainMenuItem2').click({ timeout });
  await new Promise((r) => setTimeout(r, 1500));

  await page.locator('a:has-text("Exames em aberto")').first().click({ timeout: 5000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Verificar se caiu pro login
  if (page.url().includes("Login.do")) {
    throw new RoboError("SESSAO_EXPIRADA", "Portal redirecionou para login após navegar");
  }

  // 2. Limpar campos de data (igual robô de coleta)
  const camposData = ['input[name="s_dt_ini"]', 'input[name="s_dt_fim"]', 'input[name="s_dt_atend_ini"]', 'input[name="s_dt_atend_fim"]'];
  for (const sel of camposData) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) await el.fill("");
    } catch {}
  }

  // 3. Filtrar por nome do paciente
  logger.info({ paciente: nomePaciente }, "filtrando por nome");
  await page.locator('input[name="s_nm_benef"]').first().fill(nomePaciente);

  // Clica Filtrar
  await page.locator('input[value="Filtrar"], button:has-text("Filtrar")').first().click();
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Verificar se caiu pro login ao filtrar
  if (page.url().includes("Login.do")) {
    throw new RoboError("SESSAO_EXPIRADA", "Portal redirecionou para login ao filtrar");
  }

  // 4. Ler resultados
  const textoBody = await page.textContent("body") || "";
  const matchCount = textoBody.match(/(\d+)\s+exame\(s\)\s+encontrado/i);
  const count = matchCount ? parseInt(matchCount[1]) : 0;

  logger.info({ count }, "exames encontrados");

  if (count === 0) {
    throw new RoboError(
      "PACIENTE_NAO_ENCONTRADO",
      `Nenhuma guia encontrada para "${nomePaciente}" em exames em aberto`
    );
  }

  // 5. Clicar na guia correta
  if (codigoGuia) {
    // Tenta clicar no link que contém o código da guia
    const linkGuia = page.locator(`a.MagnetoDataLink:has-text("${codigoGuia}")`).first();
    const visivel = await linkGuia.isVisible({ timeout: 2000 }).catch(() => false);
    if (visivel) {
      logger.info({ codigoGuia }, "clicando na guia pelo código");
      await linkGuia.click({ timeout });
    } else {
      // Fallback: clica na primeira (mais recente)
      logger.info("código da guia não encontrado na lista, clicando na primeira");
      await page.locator("tbody tr:nth-child(2) a.MagnetoDataLink").first().click({ timeout });
    }
  } else {
    // Sem código: clica na primeira
    logger.info("clicando na primeira guia");
    await page.locator("tbody tr:nth-child(2) a.MagnetoDataLink").first().click({ timeout });
  }

  // 6. Aguardar tela de execução
  await page.waitForURL(/\/sadt\/execucao\.do/, { timeout });

  logger.info("tela de execução da guia aberta");
}
