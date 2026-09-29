// observar-scsaude.ts — ferramenta de diagnóstico, rodada À MÃO.
//
// NÃO é parte do robô. Nada no servidor ou no iniciar.bat chama este arquivo:
// ele fica inerte no disco até alguém executá-lo de propósito.
//
// O QUE FAZ
//   Abre um Chrome no portal do SC Saúde e OBSERVA. A pessoa usa o portal
//   normalmente; o script salva cada tela nova (HTML + imagem + lista de
//   campos) para podermos escrever o robô em cima do que o portal realmente
//   faz, em vez de adivinhar.
//
// O QUE NÃO FAZ
//   Não clica, não preenche, não envia nada. Não faz login: quem entra é a
//   pessoa, com a senha dela. Se o script falhar, sobra um Chrome normal.
//
// COMO USAR
//   observar-scsaude.bat   (ou: npx ts-node -T observar-scsaude.ts)
//   Faça UMA autorização do começo ao fim, sem pressa.
//   Ao terminar, feche a janela do Chrome.
//
// O RESULTADO
//   Pasta "recon-scsaude-manual/<data-hora>", com os dumps e um RESUMO.txt.
//   ATENÇÃO: contém nome, CPF e carteirinha de paciente. Não vai para o git
//   (está no .gitignore) e não deve ser publicado em lugar nenhum.

import { chromium, Page } from "playwright";
import fs from "fs";
import path from "path";

const URL = "https://portal.scsaude.sc.gov.br/sistemas";
// Uma subpasta por execução: se a pessoa rodar duas vezes, os arquivos da
// segunda não se misturam com os da primeira.
const CARIMBO = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const PASTA = path.resolve("recon-scsaude-manual", CARIMBO);
const RESUMO = path.join(PASTA, "RESUMO.txt");

let n = 0;
const vistas = new Set<string>();

function anotar(texto: string) {
  console.log(texto);
  try { fs.appendFileSync(RESUMO, texto + "\n", "utf-8"); } catch { /* segue */ }
}

async function capturar(page: Page) {
  let d: any;
  try {
    d = await page.evaluate(() => {
      const limpar = (s: string) => (s || "").replace(/\s+/g, " ").trim();
      const visivel = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const campos = Array.from(document.querySelectorAll("input, select, textarea"))
        .filter(visivel)
        .map((e: any) => `${e.tagName.toLowerCase()}[name=${e.name || "-"}] type=${e.type || "-"}`);
      const botoes = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a"))
        .filter(visivel)
        .map((e: any) => limpar(e.innerText || e.value || ""))
        .filter((t: string) => t.length > 1 && t.length < 60);
      const listas = Array.from(document.querySelectorAll("select"))
        .filter(visivel)
        .map((s: any) => `${s.name}: ${Array.from(s.options).map((o: any) => limpar(o.text)).slice(0, 12).join(" | ")}`);
      const texto = limpar(document.body.innerText).slice(0, 3000);
      return {
        url: location.href,
        titulo: document.title,
        campos: [...new Set(campos)],
        botoes: [...new Set(botoes)],
        listas,
        // assinatura: muda quando a tela muda de verdade. O portal troca de
        // tela por AJAX sem mudar a URL, então não dá para usar navegação.
        assinatura: `${location.pathname}|${campos.length}|${texto.length}|${texto.slice(0, 400)}`,
      };
    });
  } catch {
    return; // página navegando; a próxima volta pega
  }

  if (!d || vistas.has(d.assinatura)) return;
  vistas.add(d.assinatura);

  n++;
  const base = String(n).padStart(2, "0");
  try {
    fs.writeFileSync(path.join(PASTA, `${base}.html`), await page.content(), "utf-8");
    await page.screenshot({ path: path.join(PASTA, `${base}.png`), fullPage: true });
  } catch { /* segue */ }

  anotar(`\n===== TELA ${base} — ${d.titulo}`);
  anotar(`url: ${d.url}`);
  anotar(`botoes: ${JSON.stringify(d.botoes.slice(0, 22))}`);
  d.campos.slice(0, 40).forEach((c: string) => anotar(`  campo  ${c}`));
  d.listas.slice(0, 10).forEach((l: string) => anotar(`  select ${l}`));
}

(async () => {
  fs.mkdirSync(PASTA, { recursive: true });
  fs.writeFileSync(RESUMO, `Observação do portal SC Saúde — ${new Date().toLocaleString("pt-BR")}\n`, "utf-8");

  const browser = await chromium.launch({ headless: false, args: ["--start-maximized"] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  async function ouvirRest(r: any) {
    const u = r.url();
    if (!/\/rest\//.test(u)) return;
    let corpo = "";
    try { corpo = (await r.text()).slice(0, 400); } catch { /* sem corpo */ }
    anotar(`  [API ${r.status()}] ${u.slice(0, 140)}`);
    if (corpo) anotar(`        ${corpo.replace(/\s+/g, " ")}`);
  }
  page.on("response", ouvirRest);
  context.on("page", (nova) => nova.on("response", ouvirRest));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

  console.log(`
============================================================
  OBSERVADOR DO PORTAL SC SAUDE

  1. Faca login normalmente, com seu usuario e senha.
  2. Faca UMA autorizacao do comeco ao fim:
        Novo > Captura/Execucao > SADT > localizar paciente
        Digitar uma Guia > preencher > Anexar > Solicitar
        ate aparecer o resultado (Autorizada ou Em Analise)
  3. Se tiver uma guia antiga EM ANALISE, abra a tela de
     captura dela tambem.
  4. Ao terminar, FECHE a janela do Chrome.

  IMPORTANTE: nao passe voando pelas telas. Uns 3 segundos
  em cada uma, para o observador conseguir registrar.

  Este programa nao clica em nada. So observa.

  O resultado vai para a pasta:
    recon-scsaude-manual\\${CARIMBO}
============================================================
`);

  let vivo = true;
  browser.on("disconnected", () => { vivo = false; });
  while (vivo) {
    for (const p of context.pages()) {
      if (!p.isClosed()) await capturar(p).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  console.log(`\nPronto. ${n} telas registradas em:\n  ${PASTA}\n\nEnvie a pasta inteira (ou pelo menos o RESUMO.txt) para quem pediu.`);
})();
