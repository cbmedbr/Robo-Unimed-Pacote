# Unimed MVP — Automação de Autorização de Guias

MVP de automação de autorização de guias no portal SGU-Card da Unimed SC, para a Clínica Luciano Noceti (psicologia).

## Status

**MVP standalone funcional.** Recebe um JSON com dados da guia + PDF do pedido médico, executa o fluxo completo no portal Unimed e retorna o número da guia gerada.

⚠️ **Importante**: os seletores HTML foram escritos com base em screenshots do portal. Provavelmente alguns vão precisar de ajuste no primeiro teste real. Os erros vão guiar quais ajustar.

## Pré-requisitos

- Node.js 20+
- npm
- Conexão estável com a internet
- Credenciais válidas do portal Unimed SC

## Instalação

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Edite o .env com a senha real
```

## Uso

```bash
npm run autorizar -- --input test/exemplo-input.json
```

Opções:
- `--input` ou `-i`: caminho para o JSON (obrigatório)
- `--dry-run`: apenas valida o input, não executa o robô

Modo debug (slowMo + browser visível + 10s para inspecionar antes de fechar):

```bash
DEBUG=true npm run autorizar -- --input test/exemplo-input.json
```

## Estrutura do JSON de input

Veja `test/exemplo-input.json` (LOCAL típico) e `test/exemplo-intercambio-atipico.json` (INTERCÂMBIO atípico — ABA).

## Estrutura do JSON de output

**Sucesso:**
```json
{
  "sucesso": true,
  "numero_guia": "50139017644",
  "data_autorizacao": "2026-05-07",
  "screenshot_comprovante_path": "./screenshots/2026-05-07T...sucesso_50139017644.png",
  "duracao_ms": 47823
}
```

**Erro:**
```json
{
  "sucesso": false,
  "etapa": "medico",
  "erro_codigo": "MEDICO_NAO_LOCALIZADO",
  "mensagem": "...",
  "screenshot_path": "./screenshots/...",
  "tentativas": 1,
  "timestamp": "..."
}
```

## Códigos de erro

Ver `src/types.ts` (tipo `ErroCodigo`).

Os mais comuns no primeiro teste:
- `LOGIN_FALHOU`: seletor de campo de login precisa ajuste
- `MENU_NAO_ENCONTRADO`: seletor do botão "Novo Exame" precisa ajuste
- `MEDICO_NAO_LOCALIZADO`: lupa do médico ou seletor de modal precisa ajuste
- `PDF_UPLOAD_FALHOU`: ícone de clipe ou modal de anexo precisa ajuste

Quando algum desses aparecer, abra o screenshot em `./screenshots/`, abra o portal manualmente, inspecione o DOM no momento do erro, e ajuste o seletor correspondente em `src/<modulo>.ts`.

## Estrutura de arquivos

```
unimed-mvp/
├── src/
│   ├── index.ts            CLI entry point
│   ├── types.ts            Interfaces TypeScript
│   ├── validacao.ts        Validação do JSON antes de abrir browser
│   ├── login.ts            Login no portal
│   ├── autorizacao.ts      Orquestrador principal
│   ├── beneficiario.ts     LOCAL vs INTERCAMBIO
│   ├── medico.ts           4 caminhos do médico solicitante
│   ├── procedimento.ts     Linha de procedimento
│   ├── anexo.ts            Upload de PDF
│   ├── finalizar.ts        Finaliza e captura número da guia
│   └── utils/
│       ├── config.ts       Carrega .env
│       ├── logger.ts       Logs estruturados (pino)
│       ├── retry.ts        Retry exponencial
│       └── screenshot.ts   Captura tela em erro
├── test/
│   ├── exemplo-input.json
│   └── exemplo-intercambio-atipico.json
├── pedidos-teste/          (PDFs reais — gitignored)
├── screenshots/            (saída do robô — gitignored)
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Workflow recomendado de teste

1. Antes de tudo, garanta que tem 1 PDF de pedido médico real em `pedidos-teste/` (com qualquer nome — apenas ajuste o `pedido_medico_path` no JSON)
2. Edite `test/exemplo-input.json` com dados reais de um paciente da clínica que **realmente precisa** de uma guia (porque o robô vai gerá-la de verdade)
3. Rode com `DEBUG=true` para acompanhar visualmente:
   ```bash
   DEBUG=true npm run autorizar -- --input test/exemplo-input.json
   ```
4. Quando o robô parar com erro, abra o screenshot e veja em qual etapa falhou
5. Ajuste o seletor correspondente em `src/<modulo>.ts`
6. Tente de novo

Espere 3-5 iterações de ajuste antes do robô conseguir completar o fluxo do início ao fim na primeira vez.

## LGPD

- O PDF do pedido médico é processado em memória; após sucesso, o arquivo permanece onde estava (não duplicado)
- Screenshots em `./screenshots/` podem conter dados pessoais — limpe periodicamente
- Logs **não** persistem dados sensíveis (telefone, email, CPF são redacted via pino)
- Senha **nunca** vai para logs

## TODO para fase 2 (integração com CRM)

- Lock no banco para evitar duplicação de cadastro de médico externo (race condition)
- API REST para CRM disparar autorização
- Persistência do resultado no Supabase
- Workflow n8n para orquestração
- Integração com IA Haiku para extração do pedido médico em JSON
- Limpeza automática de screenshots > 30 dias (LGPD)
