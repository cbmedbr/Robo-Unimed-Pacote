import { chromium, Page } from "playwright";
import { lerSituacaoNaTela, lerNumeroDaGuia } from "../src/scsaude/finalizar";

/**
 * Telas sintéticas, montadas a partir do que o SCSAUDE_PORTAL.md registrou em
 * 27/10/2026. Não substituem o portal — servem para provar que o classificador
 * separa o que precisa separar, em especial que ele NÃO dá a guia por enviada
 * enquanto o botão "Solicitar Autorização" ainda está na tela.
 */
const CASOS: { nome: string; html: string; espera: string | null; pendencia?: boolean }[] = [
  {
    nome: "formulario preenchido, antes de enviar",
    html: `<h1>Guia SADT</h1>
           <a href="#">Solicitar Autorização</a>
           <div>Situação: digitação</div>`,
    espera: null,
  },
  {
    nome: "formulario com a palavra 'em analise' solta na tela (armadilha)",
    html: `<h1>Guia SADT</h1>
           <a href="#">Solicitar Autorização</a>
           <select><option>Em análise</option><option>Autorizado</option></select>`,
    espera: null,
  },
  {
    nome: "guia em analise (barra do 13.3, sem Solicitar)",
    html: `<div>⚙ Em análise</div>
           <div>Número da Guia: 90014477</div>
           <div>Senha:</div><div>Validade da Senha:</div>
           <nav>Anexar Documentos · Anexos · Beneficiário · Resumo da Guia ·
                Cancelar Guia · Mensagens Guia · Priorizar Guia</nav>`,
    espera: "EM_ANALISE",
  },
  {
    nome: "aguardando justificativa tecnica",
    html: `<div>Aguardando justificativa técnica do solicitante</div>
           <div>Número da Guia: 90014478</div>
           <nav>Mensagens Guia · Anexar Documentos</nav>`,
    espera: "EM_ANALISE",
    pendencia: true,
  },
  {
    nome: "aguardando documentacao do prestador",
    html: `<div>Aguardando documentação do prestador</div><nav>Anexar Documentos</nav>`,
    espera: "EM_ANALISE",
    pendencia: true,
  },
  {
    nome: "pericia",
    html: `<div>Situação da guia: Perícia</div><nav>Resumo da Guia</nav>`,
    espera: "EM_ANALISE",
    pendencia: true,
  },
  {
    nome: "guia capturada (autorizada)",
    html: `<h2>Guia Capturada</h2>
           <div>Número da Guia: 90014479</div><div>Senha: 557788</div>
           <div>Validade da Senha: 31/12/2026</div>`,
    espera: "AUTORIZADA",
  },
  {
    nome: "guia negada",
    html: `<h2>Guia Negada</h2><div>Motivo: fora de cobertura</div>`,
    espera: "NEGADA",
  },
];

async function carregar(page: Page, html: string) {
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`
  );
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let falhas = 0;

  for (const caso of CASOS) {
    await carregar(page, caso.html);
    const r = await lerSituacaoNaTela(page);
    const obtido = r?.situacao ?? null;
    const ok = obtido === caso.espera;
    const temPend = !!r?.pendencia;
    const okPend = caso.pendencia === undefined ? true : temPend === caso.pendencia;

    if (!ok || !okPend) falhas++;
    console.log(
      `${ok && okPend ? "  ok  " : " FALHA"} | ${caso.nome}\n` +
        `         esperado=${caso.espera} obtido=${obtido}` +
        (caso.pendencia !== undefined ? ` pendencia=${temPend}` : "") +
        (r?.pendencia ? `\n         -> "${r.pendencia}"` : "")
    );
  }

  // numero da guia
  await carregar(page, `<div>Número da Guia: 90014477</div>`);
  const n1 = await lerNumeroDaGuia(page);
  await carregar(page, `<div>Nº Guia 90014480</div>`);
  const n2 = await lerNumeroDaGuia(page);
  await carregar(page, `<div>guia sem numero nenhum aqui</div>`);
  const n3 = await lerNumeroDaGuia(page);

  console.log(`\nnumero da guia: "${n1}" | "${n2}" | ${JSON.stringify(n3)}`);
  if (n1 !== "90014477" || n2 !== "90014480" || n3 !== null) falhas++;

  await browser.close();
  console.log(falhas === 0 ? "\nTUDO OK" : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
})();
