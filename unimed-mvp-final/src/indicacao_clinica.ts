import { Page } from "playwright";
import { logger } from "./utils/logger";

/**
 * Campo "Indicação clínica" do formulário de autorização.
 *
 * Passou a ser **obrigatório** para o tipo de atendimento "03 - Outras
 * Terapias": o portal recusa a guia com "O valor do campo Indicação clínica é
 * obrigatório para esse tipo de atendimento". Antes disso era opcional, e o
 * robô podia não preenchê-lo sem ninguém perceber — foi o que gerou a glosa.
 *
 * O texto vem pronto do CRM (`executor.ts`) e começa sempre com o CID do
 * paciente, que é o que a operadora exige ver aqui. O robô não monta nem
 * completa esse texto — só garante que ele chega ao portal.
 *
 * Fica em módulo separado porque `autorizacao.ts` (que preenche) e
 * `finalizar.ts` (que confere antes de finalizar) precisam dos mesmos
 * seletores, e um já importa o outro.
 */

/** Seletores do campo, na ordem em que o SGU já apareceu. */
const SELETORES = [
  "#DS_INDIC_CLINICA",
  'textarea[name="DS_INDIC_CLINICA"]',
  'input[name="DS_INDIC_CLINICA"]',
];

/** `maxlength` do campo no portal. Acima disso o navegador corta sozinho. */
const LIMITE = 500;

/** Lê o que está no campo. `null` = campo não existe nesta tela. */
export async function lerIndicacaoClinica(page: Page): Promise<string | null> {
  for (const sel of SELETORES) {
    const valor = await page.locator(sel).first().inputValue().catch(() => null);
    if (valor !== null) return valor.trim();
  }
  return null;
}

/**
 * Preenche o campo e **confere que o valor ficou lá**.
 *
 * Confere em vez de confiar no `fill()` porque este formulário recarrega
 * pedaços por AJAX: já aconteceu de um campo aceitar o valor e ser esvaziado
 * logo depois, sem erro nenhum.
 *
 * Lança se o campo não existir ou continuar vazio — o portal recusaria a guia
 * de qualquer forma, e falhar aqui dá uma mensagem legível em vez de HTML de
 * erro no meio do log.
 */
export async function preencherIndicacaoClinica(page: Page, texto: string): Promise<void> {
  const limpo = (texto ?? "").trim();
  if (!limpo) {
    throw new Error(
      "INDICACAO_CLINICA_VAZIA: o CRM não mandou texto de indicação clínica. " +
        "O campo é obrigatório no portal e a guia seria recusada."
    );
  }

  const final = limpo.length > LIMITE ? limpo.slice(0, LIMITE) : limpo;
  if (final !== limpo) {
    logger.warn(
      { tamanho: limpo.length, limite: LIMITE },
      "indicação clínica maior que o limite do campo — cortada"
    );
  }

  let seletor: string | null = null;
  for (const sel of SELETORES) {
    if ((await page.locator(sel).count()) > 0) {
      seletor = sel;
      break;
    }
  }

  if (!seletor) {
    throw new Error(
      "INDICACAO_CLINICA_NAO_ENCONTRADA: campo 'Indicação clínica' não existe nesta tela " +
        `(procurado em: ${SELETORES.join(", ")}). Ele é obrigatório para 'Outras Terapias'.`
    );
  }

  const campo = page.locator(seletor).first();
  await campo.fill(final);
  await campo.press("Tab").catch(() => {});

  const gravado = await lerIndicacaoClinica(page);
  if (!gravado) {
    throw new Error(
      `INDICACAO_CLINICA_NAO_PREENCHIDA: o campo continuou vazio depois de preencher ("${final}").`
    );
  }

  logger.info({ indicacaoClinica: gravado }, "campo Indicação clínica preenchido");
}
