import { chromium, Browser } from "playwright";
import path from "path";
import fs from "fs";
import { logger } from "./utils/logger";
import { carregarConfig } from "./utils/config";
import { fazerLogin } from "./login";
import { buscarEAbrirGuia } from "./execucao/buscar_e_abrir_guia";
import { prepararExecucao } from "./execucao/preparar_execucao";
import { abrirPopupCartao } from "./execucao/abrir_popup_cartao";
import { aguardarQrCode } from "./execucao/aguardar_qrcode";
import { finalizarParcial } from "./execucao/finalizar";
import { DadosExecucao, ResultadoExecucao, RoboError } from "./execucao/tipos";

/**
 * Orquestrador principal do robô de execução de sessões.
 *
 * Fluxo: login → buscar guia → preparar → popup cartão → QR Code → finalizar parcial
 *
 * Sempre roda com headless=false (operador precisa ver e apresentar QR Code).
 */
export async function executarSessao(
  dados: DadosExecucao,
  onStatusUpdate?: (status: string, extra?: Record<string, unknown>) => Promise<void>
): Promise<ResultadoExecucao> {
  const config = carregarConfig();
  const inicio = Date.now();

  // Garantir diretório de screenshots
  const comprovantesDir = path.join(config.screenshotDir, "comprovantes");
  if (!fs.existsSync(comprovantesDir)) {
    fs.mkdirSync(comprovantesDir, { recursive: true });
  }

  let browser: Browser | null = null;

  try {
    // Abrir browser SEMPRE visível (operador precisa da webcam)
    browser = await chromium.launch({
      headless: false,
      args: ["--no-sandbox"],
    });

    const context = await browser.newContext({
      permissions: ["camera"],
      viewport: { width: 1366, height: 768 },
    });

    const page = await context.newPage();

    // 1. Login
    logger.info("=== ETAPA 1: LOGIN ===");
    await fazerLogin(page, config);
    if (onStatusUpdate) await onStatusUpdate("executando");

    // 2-3. Buscar e abrir guia
    logger.info("=== ETAPAS 2-3: BUSCAR E ABRIR GUIA ===");
    await buscarEAbrirGuia(page, dados.paciente.nome_completo, config.navegacaoTimeout, dados.guia?.codigo);

    // 4-5. Preparar execução (regime + validar sessões)
    logger.info("=== ETAPAS 4-5: PREPARAR EXECUÇÃO ===");
    const { qtSolicitadas, qtAutorizadas } = await prepararExecucao(page);

    // Registrar handler para dialog de confirmação do portal.
    // Após QR Code, o portal mostra: "Você confirma a execução do procedimento em série?"
    // O dialog pode aparecer na página principal OU em qualquer outra página/popup do contexto.
    let dialogRecebido = false;

    function registrarDialogHandler(p: import("playwright").Page) {
      p.on("dialog", async (dialog) => {
        logger.info({ tipo: dialog.type(), mensagem: dialog.message(), url: p.url() }, "dialog do portal detectado");
        dialogRecebido = true;
        await dialog.accept();
        logger.info("dialog aceito (OK)");
      });
    }

    // Registra na página principal
    registrarDialogHandler(page);

    // Registra em qualquer nova página que abrir
    context.on("page", (novaPagina) => {
      logger.info({ url: novaPagina.url() }, "nova página detectada no contexto");
      registrarDialogHandler(novaPagina);
    });

    // 6. Abrir popup do cartão
    logger.info("=== ETAPA 6: ABRIR POPUP CARTÃO ===");
    const popup = await abrirPopupCartao(page, context, 20_000);

    // Registra handler no popup também
    registrarDialogHandler(popup);

    // Injeta script no popup pra auto-aceitar confirm() do portal.
    // Após QR Code, o portal navega pra exame_seriado_redirect.do e chama
    // confirm("Você confirma a execução do procedimento em série?").
    // Sem isso, Playwright rejeita o confirm e a execução não é registrada.
    await popup.addInitScript(() => {
      window.confirm = () => {
        console.log("[robo] confirm() interceptado — retornando true");
        return true;
      };
    });
    logger.info("script de auto-accept confirm() injetado no popup");

    // 7-8. QR Code (operador apresenta)
    logger.info("=== ETAPAS 7-8: AGUARDAR QR CODE ===");
    await aguardarQrCode(popup, onStatusUpdate);

    // Aguardar o dialog de confirmação ser processado
    logger.info("aguardando dialog de confirmação do portal...");
    const inicioDialog = Date.now();
    while (!dialogRecebido && Date.now() - inicioDialog < 15000) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (dialogRecebido) {
      logger.info("dialog de confirmação aceito — execução registrada");
    } else {
      logger.warn("dialog de confirmação não apareceu em 15s — verificando páginas abertas");
      // Log das páginas abertas pra diagnóstico
      for (const p of context.pages()) {
        if (!p.isClosed()) {
          logger.info({ url: p.url() }, "página aberta no contexto");
        }
      }
    }

    // Aguardar página atualizar após aceitar dialog
    await page.bringToFront();
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    // 9-10. Finalizar Parcial + comprovante
    logger.info("=== ETAPAS 9-10: FINALIZAR PARCIAL ===");
    const comprovantePath = await finalizarParcial(
      page,
      dados.sessao_id,
      comprovantesDir,
      config.navegacaoTimeout
    );

    const duracao = Date.now() - inicio;
    logger.info(
      { duracao_ms: duracao, sessao_id: dados.sessao_id },
      "✅ Execução de sessão concluída com sucesso"
    );

    return {
      sucesso: true,
      comprovante_path: comprovantePath,
      duracao_ms: duracao,
    };
  } catch (err) {
    const duracao = Date.now() - inicio;
    const codigo = err instanceof RoboError ? err.codigo : "ERRO_DESCONHECIDO";
    const mensagem = (err as Error).message || "Erro desconhecido";

    logger.error(
      { codigo, mensagem, duracao_ms: duracao, sessao_id: dados.sessao_id },
      "❌ Execução de sessão falhou"
    );

    return {
      sucesso: false,
      erro_codigo: codigo,
      erro_mensagem: mensagem,
      duracao_ms: duracao,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
