import { Page } from "playwright";
import { logger } from "../utils/logger";
import { ErroScSaude } from "./tipos";

/**
 * Os dois padrões que se repetem no portal inteiro do SC Saúde.
 *
 * Ficam juntos aqui porque cada tela do fluxo precisa dos dois, e tê-los
 * copiados em cada módulo é como as cópias divergem.
 */

// ---------------------------------------------------------------------------
// Esperar um elemento aparecer
// ---------------------------------------------------------------------------

/**
 * Espera o elemento ficar visível. `true` se apareceu, `false` se não.
 *
 * **Use isto, nunca `isVisible({ timeout })`.** O `isVisible()` do Playwright
 * não espera: ele checa na hora e devolve `false` se o elemento ainda não
 * renderizou, e o `timeout` passado a ele não o faz tentar de novo. É fácil
 * escrever `isVisible({ timeout: 8000 })` achando que espera 8 segundos —
 * medimos 66ms contra os 2,5s que o `waitFor` espera no mesmo caso.
 *
 * Esse engano derrubou execuções da Unimed em 28/10/2026: a checagem dizia
 * esperar 15 segundos e a sessão inteira durava 6.
 *
 * `isVisible()` continua certo quando a pergunta é mesmo "está aí AGORA?" —
 * por exemplo ao varrer uma lista de candidatos já renderizada.
 */
export async function apareceu(
  alvo: { waitFor: (o: { state: "visible"; timeout: number }) => Promise<void> },
  timeout: number
): Promise<boolean> {
  return alvo
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Informativos modais
// ---------------------------------------------------------------------------

/**
 * Fecha os informativos que o portal abre por cima da tela.
 *
 * Eles **engolem o clique seguinte** e aparecem de forma intermitente: no mesmo
 * fluxo, um paciente disparou o modal e outro não. Por isso se chama isto antes
 * de cada clique importante, e não uma vez no começo.
 *
 * Existe um checkbox "Ok. Entendi. Não abrir automaticamente" no portal, mas
 * depender dele seria depender de uma preferência da conta que também muda a
 * vida de quem usa o portal à mão.
 */
export async function fecharInformativos(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const botao = page
      .locator(
        '.modal:visible button:has-text("Fechar"), .modal:visible a:has-text("Fechar"), ' +
          'button:visible:has-text("Fechar"), button:visible:has-text("OK, entendi")'
      )
      .first();

    if (!(await botao.isVisible({ timeout: 2000 }).catch(() => false))) return;

    await botao.click().catch(() => {});
    await page.waitForTimeout(1000);
    logger.info("informativo fechado");
  }
}

// ---------------------------------------------------------------------------
// Typeahead
// ---------------------------------------------------------------------------

/**
 * Preenche um campo typeahead e escolhe a sugestão.
 *
 * Todo campo cujo `name` termina em `:value` é typeahead neste portal —
 * profissional solicitante, número do conselho, contratado solicitante e o
 * procedimento. **`fill()` não funciona neles**: grava o valor sem disparar a
 * busca, o campo oculto (`:hiddenId`) fica vazio e o portal ignora a escolha,
 * sem erro nenhum. É preciso digitar tecla a tecla e clicar na sugestão.
 *
 * @param filtro quando dado, escolhe a primeira sugestão que casar; senão, a primeira
 * @returns o texto da sugestão escolhida, ou `null` se não veio nenhuma
 */
export async function typeahead(
  page: Page,
  seletor: string,
  valor: string,
  rotulo: string,
  filtro?: RegExp
): Promise<string | null> {
  const campo = page.locator(seletor).first();

  if (!(await apareceu(campo, 8000))) {
    throw new ErroScSaude(
      "CAMPO_NAO_ENCONTRADO",
      `Campo "${rotulo}" não existe nesta tela (${seletor}).`
    );
  }

  await campo.click();
  await campo.fill("");
  await campo.pressSequentially(valor, { delay: 110 });

  // A busca é por AJAX; a lista demora. Espera a lista aparecer em vez de
  // dormir um tempo fixo, que é o que torna isto frágil em máquina lenta.
  const lista = page.locator("ul.typeahead li:visible, .dropdown-menu li:visible, .tt-suggestion:visible");
  // A lista de sugestões chega por AJAX: ela NUNCA está lá no instante do
  // último caractere. Com `isVisible` este caminho falharia sempre, e todo
  // typeahead do adaptador — médico, contratado, procedimento — morreria.
  const veio = await apareceu(lista.first(), 8000);

  if (!veio) {
    logger.warn({ rotulo, valor }, "typeahead não devolveu sugestão");
    return null;
  }

  let alvo = lista.first();

  if (filtro) {
    const total = await lista.count();
    let achou = false;
    for (let i = 0; i < total; i++) {
      const item = lista.nth(i);
      const texto = ((await item.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (filtro.test(texto)) {
        alvo = item;
        achou = true;
        break;
      }
    }
    if (!achou) {
      logger.warn({ rotulo, valor, filtro: String(filtro) }, "nenhuma sugestão casou com o filtro");
      return null;
    }
  }

  const escolhido = ((await alvo.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  await alvo.click();

  // O portal recarrega pedaços do formulário ao escolher (o profissional
  // preenche conselho/UF/CBOS sozinho, por exemplo).
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  logger.info({ rotulo, escolhido }, "typeahead resolvido");
  return escolhido;
}

/**
 * Lê o valor que ficou num campo, "" quando vazio e `null` quando o campo não
 * existe. A distinção importa: campo ausente é problema de mapeamento, campo
 * vazio é problema de preenchimento.
 */
export async function lerCampo(page: Page, seletor: string): Promise<string | null> {
  const valor = await page.locator(seletor).first().inputValue().catch(() => null);
  return valor === null ? null : valor.trim();
}
