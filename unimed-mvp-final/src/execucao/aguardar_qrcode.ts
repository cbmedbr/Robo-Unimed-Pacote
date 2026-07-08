import { Page } from "playwright";
import { logger } from "../utils/logger";
import { RoboError } from "./tipos";

/**
 * Etapas 7-8: Clica "clique aqui" (QR Code) no popup e aguarda validação biométrica.
 *
 * Timeout de 180s (3 min) — QR Code expira em 2-3 min.
 *
 * Dois resultados possíveis:
 * - Popup fecha automaticamente → SUCESSO (validação OK)
 * - Popup mostra "Erro!" → QR_CODE_INVALIDO
 * - Timeout → TIMEOUT_QR_CODE
 */
export async function aguardarQrCode(
  popup: Page,
  onStatusUpdate?: (status: string) => Promise<void>
): Promise<void> {
  const TIMEOUT_QR = 180_000; // 3 minutos

  // Clicar no link "clique aqui" que abre a webcam/QR Code
  logger.info("clicando 'clique aqui' para abrir QR Code");
  await popup.click("a#qr-code");

  // Aguardar navegação para a tela do QR Code
  await popup.waitForURL(/\/qrcode\.do/, { timeout: 5000 }).catch(() => {
    logger.warn("URL não mudou para qrcode.do — pode estar em outra estrutura");
  });

  logger.info("webcam aberta — aguardando operador apresentar QR Code");
  if (onStatusUpdate) await onStatusUpdate("aguardando_qrcode");

  // Aguardar resultado da validação
  const resultado = await Promise.race([
    popup
      .waitForEvent("close", { timeout: TIMEOUT_QR })
      .then(() => "SUCESSO" as const),
    popup
      .waitForSelector("text=/Erro!/i", { timeout: TIMEOUT_QR })
      .then(() => "ERRO_BIOMETRICO" as const),
  ]).catch(() => "TIMEOUT_QR_CODE" as const);

  if (resultado === "SUCESSO") {
    logger.info("QR Code validado com sucesso — popup fechou");
    return;
  }

  // Fechar popup se ainda aberto
  if (!popup.isClosed()) {
    await popup.close().catch(() => {});
  }

  if (resultado === "ERRO_BIOMETRICO") {
    throw new RoboError(
      "QR_CODE_INVALIDO",
      "Validação biométrica falhou — 'Erro! Passe o cartão novamente'"
    );
  }

  throw new RoboError(
    "TIMEOUT_QR_CODE",
    "Operador não apresentou QR Code dentro de 3 minutos"
  );
}
