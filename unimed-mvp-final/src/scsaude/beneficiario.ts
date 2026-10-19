import { Page } from "playwright";
import { logger } from "../utils/logger";
import { ConfigScSaude, ErroScSaude, InputAutorizacaoScSaude } from "./tipos";
import { fecharInformativos, typeahead } from "./portal";

const OPERADORA_SC_SAUDE = "757444";
const P = "form-principal:";

/**
 * Do menu até o formulário de guia aberto, passando pela localização do
 * beneficiário.
 *
 * Caminho: Novo → Captura/Execução → operadora → tipo SADT → CPF →
 * Próximo Passo → Digitar uma Guia.
 *
 * O SOP manda usar **Captura/Execução** mesmo quando o objetivo é só solicitar
 * autorização — não é engano, é o caminho que a operação usa.
 */
export async function abrirFormularioGuia(
  page: Page,
  input: InputAutorizacaoScSaude,
  config: ConfigScSaude
): Promise<void> {
  // --- menu: Atendimentos → Novo ---
  await fecharInformativos(page);
  await page.getByText(/^Novo$/i).first().click({ timeout: config.clickTimeout });
  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});

  await page
    .locator('input[name="form-selecao:btn-proc-captura-execucao"]')
    .first()
    .click({ timeout: config.clickTimeout });
  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});

  // --- operadora ANTES do tipo ---
  //
  // A operadora é obrigatória, vem vazia, e escolhê-la LIMPA o tipo de
  // atendimento. Na ordem inversa o tipo é apagado e o "Próximo Passo"
  // continua desabilitado, sem dizer por quê.
  const selOperadora = `select[name="${P}select-operadora"]`;
  await page.waitForSelector(selOperadora, { state: "visible", timeout: config.navegacaoTimeout });
  await page.locator(selOperadora).selectOption({ value: OPERADORA_SC_SAUDE });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  logger.info("operadora SC Saúde selecionada");

  // --- tipo de atendimento: SADT EXATO ---
  //
  // As vizinhas são "SADT Internado" e "SADT Pronto Socorro": casar por
  // "contém SADT" pega a errada.
  const selTipo = `select[name="${P}select-tipo-atendimento"]`;
  await page.waitForSelector(selTipo, { state: "visible", timeout: config.navegacaoTimeout });
  await page.locator(selTipo).selectOption({ label: "SADT" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  logger.info("tipo de atendimento SADT selecionado");

  // --- beneficiário por CPF ---
  const cpf = (input.paciente.cpf || "").replace(/\D/g, "");
  if (cpf.length !== 11) {
    throw new ErroScSaude(
      "CPF_INVALIDO",
      `CPF do paciente inválido ou ausente ("${input.paciente.cpf}"). ` +
        "O portal do SC Saúde localiza o beneficiário pelo CPF — sem ele o robô não encontra o paciente."
    );
  }

  const escolhido = await typeahead(page, `input[name="${P}cpfBeneficiario:value"]`, cpf, "CPF do beneficiário");
  if (!escolhido) {
    throw new ErroScSaude(
      "BENEFICIARIO_NAO_LOCALIZADO",
      `O SC Saúde não tem beneficiário com o CPF ${cpf} (${input.paciente.nome_completo}). ` +
        "A busca devolve lista vazia, não erro — confira o CPF no cadastro do paciente."
    );
  }

  // --- Próximo Passo ---
  //
  // Só habilita depois que o typeahead gravou a escolha no campo oculto.
  const btnProximo = page.locator(`input[name="${P}criar-atendimento-button"]`);
  await esperarHabilitar(page, btnProximo, config.navegacaoTimeout);
  await btnProximo.click({ timeout: config.clickTimeout });
  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});

  await fecharInformativos(page);

  // --- Digitar uma Guia ---
  //
  // O texto "Digitar uma Guia" aparece DUAS vezes: no parágrafo informativo que
  // explica o botão, e no botão de verdade. `getByText` pega o parágrafo, o
  // clique não faz nada e a tela não muda — sem erro nenhum. Por isso a tag é
  // restrita a <a>.
  const urlAntes = page.url();
  await page.locator('a:has-text("Digitar uma Guia")').first().click({ timeout: config.clickTimeout });
  await page
    .waitForFunction((u) => location.href !== u, urlAntes, { timeout: config.navegacaoTimeout })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: config.navegacaoTimeout }).catch(() => {});
  await fecharInformativos(page);

  // Confirma que o formulário abriu mesmo, em vez de seguir para preencher
  // campos que não existem e falhar com "campo não encontrado".
  const temFormulario = await page
    .locator(`input[name="${P}nomeProfissionalSolicitante:value"]`)
    .first()
    .isVisible({ timeout: 15000 })
    .catch(() => false);

  if (!temFormulario) {
    throw new ErroScSaude(
      "FORMULARIO_NAO_ABRIU",
      'Cliquei em "Digitar uma Guia" mas o formulário da guia não apareceu.'
    );
  }

  logger.info({ url: page.url() }, "formulário da guia aberto");
}

async function esperarHabilitar(
  page: Page,
  botao: ReturnType<Page["locator"]>,
  timeout: number
): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    if (await botao.isEnabled().catch(() => false)) return;
    await page.waitForTimeout(500);
  }
  throw new ErroScSaude(
    "PROXIMO_PASSO_DESABILITADO",
    'O botão "Próximo Passo" não habilitou. Normalmente é a escolha do beneficiário que não foi ' +
      "gravada: o typeahead precisa que uma sugestão seja clicada, não basta digitar."
  );
}
