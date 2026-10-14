import { BrowserContext, Page } from "playwright";
import { logger } from "../utils/logger";

/**
 * A confirmação que vem depois de "Finalizar Parcial".
 *
 * O portal abre uma página perguntando:
 *
 *   "Você confirma a realização parcial desta guia e o envio destas
 *    informações à Unimed? Após o envio a Unimed irá processar o pagamento
 *    desta guia e as informações não poderão mais serem alteradas."
 *
 * **Sem clicar em Confirmar nessa página, nada é enviado à Unimed.** A guia
 * continua em "Exames em aberto" e a sessão não existe para a operadora.
 *
 * ------------------------------------------------------------------
 * Por que isto virou um módulo próprio
 * ------------------------------------------------------------------
 * Até 14/10/2026 os dois fluxos de execução achavam essa página testando
 * `url.includes("finalizar_msg")`. Em 14/10 o robô passou a falhar em 100%
 * das execuções (6 de 6, contra 2-6% de erro nos dias anteriores): a página
 * de confirmação aparecia normalmente, o robô a fotografava, mas não entrava
 * no bloco que clica em Confirmar — e esperava 30 segundos por uma tela de
 * sucesso que nunca viria.
 *
 * Identificar a página pelo endereço é frágil: o endereço é detalhe de
 * implementação do portal e muda sem aviso. O texto da pergunta é o que a
 * operadora precisa manter, porque é ele que o usuário lê antes de autorizar
 * o envio. Por isso a busca agora é por conteúdo, com o endereço antigo
 * mantido apenas como mais um sinal.
 */

/** Sinais de que a página é a confirmação do envio. */
const PADRAO_TEXTO = /confirma a realiza[çc][ãa]o parcial|envio destas informa[çc][õo]es|Confirma[çc][ãa]o/i;

/** Seletores do botão Confirmar, do mais específico para o mais genérico. */
const SELETORES_CONFIRMAR = [
  'input[value="Confirmar"]',
  'button:has-text("Confirmar")',
  'a:has-text("Confirmar")',
  'input[value="OK"]',
  'button:has-text("OK")',
  'input[value="Sim"]',
  'button:has-text("Sim")',
];

/** Nunca clicar nestes: cancelam o envio. */
const PROIBIDO = /cancelar|voltar|fechar|sair/i;

/**
 * Procura a página de confirmação em todas as abas abertas, por até
 * `timeoutMs`. `null` quando nenhuma aparece — o portal pode ter ido direto
 * para a tela de sucesso.
 */
export async function encontrarPaginaConfirmacao(
  context: BrowserContext,
  timeoutMs = 15000
): Promise<Page | null> {
  const inicio = Date.now();

  while (Date.now() - inicio < timeoutMs) {
    for (const p of context.pages()) {
      if (p.isClosed()) continue;

      // Sinal 1: o endereço antigo, mantido para não quebrar o que funciona.
      if (p.url().includes("finalizar_msg")) {
        logger.info({ url: p.url() }, "página de confirmação encontrada pelo endereço");
        return p;
      }

      // Sinal 2: o texto da pergunta — o que resiste a troca de endereço.
      const texto = await p.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (!PADRAO_TEXTO.test(texto)) continue;

      // Só vale se houver mesmo um botão de confirmar: a palavra
      // "Confirmação" sozinha também aparece em outras telas do portal.
      const temBotao = await temBotaoConfirmar(p);
      if (temBotao) {
        logger.info({ url: p.url() }, "página de confirmação encontrada pelo texto");
        return p;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return null;
}

async function temBotaoConfirmar(page: Page): Promise<boolean> {
  for (const sel of SELETORES_CONFIRMAR) {
    const visivel = await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false);
    if (visivel) return true;
  }
  return false;
}

/**
 * Clica em Confirmar. Retorna `false` se não achou botão nenhum.
 *
 * Checa o rótulo antes de clicar: a lista de seletores termina em opções
 * genéricas, e num formulário com "Confirmar" e "Cancelar" lado a lado um
 * seletor genérico pode pegar o Cancelar — que descarta a execução em
 * silêncio, exatamente o resultado que não podemos ter.
 */
export async function clicarConfirmar(page: Page): Promise<boolean> {
  // Diagnóstico: com o portal mudando, saber quais botões existiam na hora
  // é o que permite consertar sem precisar de acesso à máquina de quem usa.
  const botoes = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button, a'))
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => ({
          tag: el.tagName,
          value: (el as HTMLInputElement).value || el.textContent?.trim() || null,
          name: el.getAttribute("name"),
          id: el.getAttribute("id"),
        }))
    )
    .catch(() => []);
  logger.info({ botoes }, "botões na página de confirmação");

  for (const sel of SELETORES_CONFIRMAR) {
    const alvo = page.locator(sel).first();
    if (!(await alvo.isVisible({ timeout: 1000 }).catch(() => false))) continue;

    const rotulo = (
      (await alvo.getAttribute("value").catch(() => null)) ||
      (await alvo.textContent().catch(() => null)) ||
      ""
    ).trim();

    if (PROIBIDO.test(rotulo)) {
      logger.warn({ seletor: sel, rotulo }, "seletor casou com botão de cancelar — ignorando");
      continue;
    }

    logger.info({ seletor: sel, rotulo }, "clicando Confirmar");
    await alvo.click();
    return true;
  }

  logger.error({ url: page.url() }, "página de confirmação sem botão Confirmar reconhecível");
  return false;
}
