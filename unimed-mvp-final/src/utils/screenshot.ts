import { Page } from "playwright";
import path from "path";
import fs from "fs";
import { logger } from "./logger";

/**
 * Captura screenshot da página atual.
 * Retorna o caminho absoluto do arquivo salvo, ou null se falhou.
 */
export async function capturarScreenshot(
  page: Page,
  identificador: string,
  screenshotDir: string = "./screenshots"
): Promise<string | null> {
  try {
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeId = identificador.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${timestamp}_${safeId}.png`;
    const filepath = path.resolve(screenshotDir, filename);

    await page.screenshot({ path: filepath, fullPage: true });
    logger.debug({ screenshot: filepath }, "screenshot capturado");

    return filepath;
  } catch (err) {
    logger.error({ err }, "falha ao capturar screenshot");
    return null;
  }
}
