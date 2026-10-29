import fs from "fs";
import { Page } from "playwright";
import { logger } from "../utils/logger";
import { ConfigScSaude, ErroScSaude, InputAutorizacaoScSaude } from "./tipos";
import { apareceu, fecharInformativos } from "./portal";

/**
 * Anexa o pedido médico.
 *
 * A guia lista, no topo, os **Documentos Necessários** — nos casos reais de
 * 16/10 foi "1. Pedido Médico com Justificativa técnica". O modal "Anexar
 * Documento" tem: Arquivo para anexar (Adicionar), Mensagem (textarea) e os
 * botões Anexar / Cancelar.
 */
export async function anexarPedidoMedico(
  page: Page,
  input: InputAutorizacaoScSaude,
  config: ConfigScSaude
): Promise<void> {
  const caminho = input.pedido_medico_path;

  if (!caminho || !fs.existsSync(caminho)) {
    throw new ErroScSaude(
      "PEDIDO_MEDICO_AUSENTE",
      `O arquivo do pedido médico não existe no caminho recebido ("${caminho}"). ` +
        "O SC Saúde exige o pedido anexado para autorizar."
    );
  }

  await fecharInformativos(page);

  const botaoAbrir = page.getByText(/Anexar\s+Documentos?/i).first();
  if (!(await apareceu(botaoAbrir, 10000))) {
    throw new ErroScSaude(
      "ANEXO_BOTAO_NAO_ENCONTRADO",
      'Não achei o botão "Anexar Documentos" na barra da guia.'
    );
  }

  await botaoAbrir.click({ timeout: config.clickTimeout });
  await page.waitForTimeout(2000);

  // O input de arquivo costuma ficar escondido atrás do botão "Adicionar".
  // setInputFiles funciona mesmo invisível, e é mais estável do que abrir o
  // diálogo nativo do sistema — que o Playwright não controla no Windows.
  const inputArquivo = page.locator('input[type="file"]').first();
  if (!(await inputArquivo.count())) {
    throw new ErroScSaude(
      "ANEXO_MODAL_SEM_CAMPO",
      'O modal de anexo abriu mas não tem campo de arquivo (input[type=file]).'
    );
  }

  await inputArquivo.setInputFiles(caminho);
  logger.info({ caminho }, "pedido médico selecionado no modal de anexo");

  const botaoAnexar = page
    .locator('.modal:visible button:has-text("Anexar"), .modal:visible input[value="Anexar"]')
    .first();

  if (!(await apareceu(botaoAnexar, 5000))) {
    throw new ErroScSaude("ANEXO_SEM_BOTAO_CONFIRMAR", 'O modal de anexo não tem botão "Anexar".');
  }

  await botaoAnexar.click();
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  logger.info("pedido médico anexado");
}
