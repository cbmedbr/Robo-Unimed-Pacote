import { Page } from "playwright";
import { logger } from "../utils/logger";
import { RoboError } from "./tipos";

/**
 * Etapas 2-3: Navega pelo menu para "Exames em aberto", filtra por nome
 * do paciente e clica na guia correta.
 *
 * Baseado no fluxo confirmado do robô de coleta (examesEmAberto.ts).
 */
/**
 * O que aconteceu na escolha da guia. O CRM passou a deixar a colaboradora
 * escolher qual guia executar, entao "abriu outra" deixou de ser detalhe de
 * log: ela precisa saber que a guia pedida nao estava em exames em aberto.
 */
export interface ResultadoAberturaGuia {
  /** true quando abrimos exatamente a guia pedida */
  codigoConfere: boolean;
  /** codigo pedido pelo CRM (vazio quando nenhum foi enviado) */
  codigoPedido: string;
}

export async function buscarEAbrirGuia(
  page: Page,
  nomePaciente: string,
  timeout: number,
  codigoGuia?: string
): Promise<ResultadoAberturaGuia> {
  // 1. Navegar pelo menu (igual robô de coleta)
  logger.info("navegando pelo menu: Exames > Exames em aberto");

  await page.locator('#mainMenuItem2').click({ timeout });
  await new Promise((r) => setTimeout(r, 1500));

  // `noWaitAfter` porque o clique AQUI dispara navegação, e por padrão o
  // Playwright espera essa navegação terminar dentro do timeout do clique.
  // Quando o portal demora, o clique FUNCIONA e mesmo assim lança timeout —
  // foi o que aconteceu em 28/10/2026: o log dizia "click action done" e em
  // seguida "waiting for scheduled navigations to finish", estourando com
  // ERRO_DESCONHECIDO. Quem espera a navegação é a linha de baixo, que já
  // existia e já tolera demora.
  //
  // O timeout também era 5000 fixo, destoando dos 30s que todos os outros
  // cliques deste arquivo usam.
  await page
    .locator('a:has-text("Exames em aberto")')
    .first()
    .click({ timeout, noWaitAfter: true });

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Verificar se caiu pro login
  if (page.url().includes("Login.do")) {
    throw new RoboError("SESSAO_EXPIRADA", "Portal redirecionou para login após navegar");
  }

  // Confirma que a tela abriu, em vez de seguir e falhar adiante com um erro
  // que não aponta para cá. O filtro por nome do beneficiário é o que
  // caracteriza a tela de exames em aberto.
  const abriu = await page
    .locator('input[name="s_nm_benef"]')
    .first()
    .isVisible({ timeout: 15000 })
    .catch(() => false);

  if (!abriu) {
    throw new RoboError(
      "EXAMES_EM_ABERTO_NAO_ABRIU",
      "Cliquei em 'Exames em aberto' mas a tela de filtro não apareceu. " +
        "Normalmente é lentidão do portal — tente de novo. Nada foi alterado."
    );
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
  // Mesma razao do clique anterior: a espera de navegacao fica com o
  // waitForLoadState abaixo, nao embutida no clique.
  await page
    .locator('input[value="Filtrar"], button:has-text("Filtrar")')
    .first()
    .click({ timeout, noWaitAfter: true });
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
  let codigoConfere = false;
  if (codigoGuia) {
    // Tenta clicar no link que contém o código da guia
    const linkGuia = page.locator(`a.MagnetoDataLink:has-text("${codigoGuia}")`).first();
    const visivel = await linkGuia.isVisible({ timeout: 2000 }).catch(() => false);
    if (visivel) {
      logger.info({ codigoGuia }, "clicando na guia pelo código");
      await linkGuia.click({ timeout, noWaitAfter: true });
      codigoConfere = true;
    } else {
      // Fallback: clica na primeira (mais recente)
      // Volta no resultado: quem escolheu a guia na tela precisa saber que o
      // robo executou outra.
      logger.warn({ codigoGuia }, "código da guia não encontrado na lista, clicando na primeira");
      await page.locator("tbody tr:nth-child(2) a.MagnetoDataLink").first().click({ timeout, noWaitAfter: true });
    }
  } else {
    // Sem código: clica na primeira
    logger.info("clicando na primeira guia");
    await page.locator("tbody tr:nth-child(2) a.MagnetoDataLink").first().click({ timeout, noWaitAfter: true });
  }

  // 6. Aguardar tela de execução
  await page.waitForURL(/\/sadt\/execucao\.do/, { timeout });

  logger.info("tela de execução da guia aberta");

  return { codigoConfere, codigoPedido: codigoGuia || "" };
}
