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

    // Função auxiliar: preenche a data no próximo campo dt_serie_N vazio
    async function preencherDataSerie() {
      const proximoCampo = await page.evaluate(() => {
        for (let i = 1; i <= 10; i++) {
          const el = document.getElementById(`dt_serie_${i}`) as HTMLInputElement | null;
          if (!el) continue;
          if (!el.value || el.value.trim() === '') return i;
        }
        return null;
      });

      if (proximoCampo === null) {
        throw new RoboError(
          "SESSOES_ESGOTADAS",
          "Todos os 10 campos de data da série já estão preenchidos. Não há espaço para nova execução."
        );
      }

      const dataExec = new Date(dados.data_execucao.includes("T") ? dados.data_execucao : dados.data_execucao + "T12:00:00");
      const dd = String(dataExec.getDate()).padStart(2, "0");
      const mm = String(dataExec.getMonth() + 1).padStart(2, "0");
      const yyyy = dataExec.getFullYear();
      const hh = String(dataExec.getHours()).padStart(2, "0");
      const min = String(dataExec.getMinutes()).padStart(2, "0");
      const dataHoraSerie = `${dd}/${mm}/${yyyy} ${hh}:${min}`;

      const campoId = `dt_serie_${proximoCampo}`;
      logger.info({ campoId, dataHoraSerie }, "preenchendo campo da série");

      await page.evaluate((id) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) {
          el.disabled = false;
          el.style.display = '';
          const img = el.nextElementSibling;
          if (img && img.tagName === 'IMG') (img as HTMLElement).style.display = '';
        }
      }, campoId);

      await page.locator(`#${campoId}`).fill(dataHoraSerie);
      await page.locator(`#${campoId}`).press("Tab");
      await page.locator(`#${campoId}`).dispatchEvent("change");
      await new Promise((r) => setTimeout(r, 1000));

      logger.info({ campoId, valor: dataHoraSerie }, "data da série preenchida");
    }

    // 6. Abrir popup do cartão (ou detectar guia em série)
    logger.info("=== ETAPA 6: ABRIR POPUP CARTÃO ===");
    const resultado = await abrirPopupCartao(page, context, 20_000);

    let comprovantePath: string | null = null;

    if (resultado.serie) {
      // === FLUXO SÉRIE SEM POPUP: preencher data → Finalizar Parcial ===
      // Campos dt_serie_N já estão visíveis, não precisa de token antes
      logger.info("=== FLUXO SÉRIE: preenchendo data e finalizando parcial ===");
      await preencherDataSerie();

      registrarDialogHandler(page);

      context.on("page", (p) => {
        logger.info({ url: p.url() }, "nova página detectada (série)");
        registrarDialogHandler(p);
      });

      await page.locator('input#Button_Parcial').click({ timeout: 10000 });
      logger.info("clicou 'Finalizar Parcial' (série)");

      // Polling: aguarda finalizar_msg.do aparecer em qualquer página (até 15s)
      let paginaMsg: import("playwright").Page | null = null;
      const inicioMsg = Date.now();
      while (Date.now() - inicioMsg < 15000) {
        for (const p of context.pages()) {
          if (p.isClosed()) continue;
          if (p.url().includes("finalizar_msg")) {
            paginaMsg = p;
            break;
          }
        }
        if (paginaMsg) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      let confirmouMsg = false;
      if (paginaMsg) {
        logger.info({ url: paginaMsg.url() }, "página finalizar_msg detectada");
        await paginaMsg.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        registrarDialogHandler(paginaMsg);

        const botoesConfirmar = [
          'input[value="Confirmar"]',
          'button:has-text("Confirmar")',
          'input[type="submit"]',
          'input[type="button"]',
        ];

        for (const sel of botoesConfirmar) {
          const visivel = await paginaMsg.locator(sel).first().isVisible({ timeout: 3000 }).catch(() => false);
          if (visivel) {
            logger.info({ seletor: sel }, "clicando Confirmar na finalizar_msg");
            await paginaMsg.locator(sel).first().click();
            confirmouMsg = true;
            break;
          }
        }
      }

      if (confirmouMsg) {
        logger.info("confirmação clicada — aguardando portal processar");
      } else {
        logger.error("página finalizar_msg não encontrada ou sem botão Confirmar");
      }

      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));

      let paginaSucesso: import("playwright").Page | null = null;
      for (const p of context.pages()) {
        if (p.isClosed()) continue;
        const url = p.url();
        const temSucesso = url.includes("sucesso") ||
          await p.locator('text=/Opera[çc][ãa]o realizada com sucesso/i').first().isVisible({ timeout: 2000 }).catch(() => false);
        if (temSucesso) {
          paginaSucesso = p;
          logger.info({ url }, "tela de sucesso encontrada!");
          break;
        }
      }

      if (paginaSucesso) {
        logger.info("execução finalizada com sucesso no portal (série)");
      } else if (!confirmouMsg) {
        throw new RoboError("EXECUCAO_FALHOU", "Confirmação não foi clicada e tela de sucesso não apareceu — execução NÃO gravada");
      } else {
        logger.warn("tela de sucesso NÃO encontrada (série) mas confirmação foi clicada — verificar manualmente");
      }

      const paginaComprovante = paginaSucesso || page;
      const nomeArquivo = `exec-${dados.sessao_id}-${Date.now()}.png`;
      const caminhoCompleto = path.join(comprovantesDir, nomeArquivo);
      try {
        await paginaComprovante.screenshot({ path: caminhoCompleto, fullPage: true });
        logger.info({ path: caminhoCompleto }, "comprovante capturado (série)");
        comprovantePath = caminhoCompleto;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "falha ao capturar comprovante (série)");
      }
    } else {
      // === FLUXO NORMAL: popup + QR Code (token) → preencher data → Finalizar Parcial ===
      const popup = resultado.page;

      registrarDialogHandler(popup);

      await popup.addInitScript(() => {
        window.confirm = () => {
          console.log("[robo] confirm() interceptado — retornando true");
          return true;
        };
      });
      logger.info("script de auto-accept confirm() injetado no popup");

      // 8-9. QR Code (operador apresenta)
      logger.info("=== ETAPAS 8-9: AGUARDAR QR CODE ===");
      await aguardarQrCode(popup, onStatusUpdate);

      logger.info("aguardando dialog de confirmação do portal...");
      const inicioDialog = Date.now();
      while (!dialogRecebido && Date.now() - inicioDialog < 15000) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (dialogRecebido) {
        logger.info("dialog de confirmação aceito — execução registrada");
      } else {
        logger.warn("dialog de confirmação não apareceu em 15s — verificando páginas abertas");
        for (const p of context.pages()) {
          if (!p.isClosed()) {
            logger.info({ url: p.url() }, "página aberta no contexto");
          }
        }
      }

      await page.bringToFront();
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));

      // 9. Preencher data (calendário só aparece DEPOIS do token/QR Code)
      logger.info("=== ETAPA 9: PREENCHER DATA DA SESSÃO (pós-token) ===");
      await preencherDataSerie();

      // 10. Finalizar Parcial + comprovante
      logger.info("=== ETAPA 10: FINALIZAR PARCIAL ===");
      comprovantePath = await finalizarParcial(
        page,
        dados.sessao_id,
        comprovantesDir,
        config.navegacaoTimeout
      );
    }

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
