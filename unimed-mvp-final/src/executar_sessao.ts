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

    // 6. Abrir popup do cartão (ou detectar guia em série)
    logger.info("=== ETAPA 6: ABRIR POPUP CARTÃO ===");
    const resultado = await abrirPopupCartao(page, context, 20_000);

    let comprovantePath: string | null = null;

    if (resultado.serie) {
      // === FLUXO SÉRIE: formulário já está na página, sem popup de cartão ===
      // Precisa preencher dt_serie_N com a data/hora antes de gravar.
      // "Gravar e Finalizar" faz tudo — não precisa de "Finalizar Parcial" depois.
      logger.info("=== FLUXO SÉRIE: preenchendo data da série e gravando ===");

      // Encontrar o próximo campo dt_serie vazio (1 a 10)
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

      // Formatar data/hora da sessão: dd/MM/yyyy HH:mm
      // data_execucao pode vir como "2026-07-17" ou "2026-07-17T14:00:00.000Z"
      const dataExec = new Date(dados.data_execucao.includes("T") ? dados.data_execucao : dados.data_execucao + "T12:00:00");
      const dd = String(dataExec.getDate()).padStart(2, "0");
      const mm = String(dataExec.getMonth() + 1).padStart(2, "0");
      const yyyy = dataExec.getFullYear();
      const hh = String(dataExec.getHours()).padStart(2, "0");
      const min = String(dataExec.getMinutes()).padStart(2, "0");
      const dataHoraSerie = `${dd}/${mm}/${yyyy} ${hh}:${min}`;

      const campoId = `dt_serie_${proximoCampo}`;
      logger.info({ campoId, dataHoraSerie }, "preenchendo campo da série");

      // Habilitar o campo se estiver disabled (campos 2-10 começam disabled)
      await page.evaluate((id) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) {
          el.disabled = false;
          el.style.display = '';
          // Mostra o datepicker trigger também
          const img = el.nextElementSibling;
          if (img && img.tagName === 'IMG') (img as HTMLElement).style.display = '';
        }
      }, campoId);

      await page.locator(`#${campoId}`).fill(dataHoraSerie);
      await page.locator(`#${campoId}`).press("Tab");
      // Dispara o change event que o portal espera
      await page.locator(`#${campoId}`).dispatchEvent("change");
      await new Promise((r) => setTimeout(r, 1000));

      logger.info({ campoId, valor: dataHoraSerie }, "data da série preenchida");

      registrarDialogHandler(page);

      // Captura novas páginas (finalizar_msg.do abre como nova janela)
      const novasPaginasSerie: import("playwright").Page[] = [];
      context.on("page", (p) => {
        logger.info({ url: p.url() }, "nova página detectada (série)");
        novasPaginasSerie.push(p);
        registrarDialogHandler(p);
      });

      // Clica "Gravar e Finalizar"
      await page.locator('#Button_Submit').click({ timeout: 10000 });
      logger.info("clicou 'Gravar e Finalizar'");

      // Aguarda a página finalizar_msg.do aparecer
      await new Promise((r) => setTimeout(r, 3000));

      // Busca e clica "Confirmar" na página finalizar_msg.do
      let confirmouMsg = false;
      for (const p of context.pages()) {
        if (p.isClosed()) continue;
        if (p.url().includes("finalizar_msg")) {
          logger.info({ url: p.url() }, "página finalizar_msg detectada");
          await p.waitForLoadState("domcontentloaded").catch(() => {});

          const botoesConfirmar = [
            'input[value="Confirmar"]',
            'button:has-text("Confirmar")',
            'input[type="submit"]',
            'input[type="button"]',
          ];

          for (const sel of botoesConfirmar) {
            const visivel = await p.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
            if (visivel) {
              logger.info({ seletor: sel }, "clicando Confirmar na finalizar_msg");
              await p.locator(sel).first().click();
              confirmouMsg = true;
              break;
            }
          }
          break;
        }
      }

      if (confirmouMsg) {
        logger.info("confirmação clicada — aguardando portal processar");
      } else {
        logger.warn("página finalizar_msg não encontrada ou sem botão Confirmar");
      }

      // Aguarda processamento
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));

      // Verifica tela de sucesso em qualquer página
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
      } else {
        logger.warn("tela de sucesso NÃO encontrada (série) — verificar se a execução foi gravada");
      }

      // Capturar comprovante
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
      // === FLUXO NORMAL: popup de cartão + QR Code ===
      const popup = resultado.page;

      // Registra handler no popup também
      registrarDialogHandler(popup);

      // Injeta script no popup pra auto-aceitar confirm() do portal.
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
