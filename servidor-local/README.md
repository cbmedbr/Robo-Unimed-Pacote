# Robô Unimed — Servidor Local

Servidor HTTP que roda na máquina da recepcionista e dispara o robô Playwright para gerar guias na Unimed.

## Visão geral

Quando a recepcionista clica "Executar Selecionadas" no CRM:

1. CRM (Vercel) cria N jobs no Supabase com status `pendente`
2. CRM faz `POST http://localhost:9876/executar { jobIds }` para este servidor
3. Este servidor pega cada job, prepara input, chama o robô (`unimed-mvp-final`) em subprocesso
4. Robô abre Chrome visível, faz login no portal Unimed, gera a guia
5. Servidor atualiza job no Supabase (sucesso ou falha) e cria a guia em `guias`
6. CRM ouve via Realtime e atualiza a UI automaticamente

Múltiplos jobs rodam em paralelo (até 10 simultâneos por padrão).

## Pré-requisitos

- **Windows 10 ou 11** (testado)
- **Node.js 20 ou superior** — instalar de https://nodejs.org/
- **Robô já instalado** em algum caminho (ex: `C:\Users\55489\Downloads\unimed-mvp\unimed-mvp`)
- **Credenciais Unimed SC** (usuário/senha do portal)
- **Service role key do Supabase** (achar em: dashboard → Settings → API → "service_role" key)

## Passo a passo de instalação

### 1. Copiar arquivos pra máquina da recepcionista

Caminho recomendado: `C:\Robo-Unimed\`

A pasta deve conter:
```
C:\Robo-Unimed\
├── package.json
├── tsconfig.json
├── iniciar-robo.bat
├── .env.example
└── src\
    ├── index.ts
    ├── config.ts
    ├── supabase.ts
    ├── executor.ts
    └── types.ts
```

### 2. Configurar .env

```powershell
cd C:\Robo-Unimed
copy .env.example .env
notepad .env
```

Preencha:
- `SUPABASE_SERVICE_ROLE_KEY` — pega no dashboard do Supabase
- `UNIMED_SENHA` — senha do portal SGU-Card
- `ROBO_CAMINHO` — caminho da pasta `unimed-mvp-final` no PC dela. Use barras invertidas duplas:
  - Ex: `C:\\Users\\55489\\Downloads\\unimed-mvp\\unimed-mvp`

Salve.

### 3. Primeira inicialização

Dê duplo clique em `iniciar-robo.bat`. Na primeira vez ele instala dependências (~1 min). Depois inicia o servidor.

Se aparecer:
```
🤖 Robô Unimed — Servidor Local
Servidor escutando em http://localhost:9876
```

Está rodando.

### 4. Atalho na área de trabalho

1. Clica com botão direito em `iniciar-robo.bat`
2. "Enviar para" → "Área de trabalho (criar atalho)"
3. Renomeia o atalho na área de trabalho pra `Iniciar Robô Unimed`
4. Clica direito → Propriedades → Mudar ícone → escolhe um ícone bonitinho (opcional)

### 5. (Opcional) Iniciar com o Windows

Pra não depender da recepcionista lembrar de iniciar:

1. `Win + R` → digita `shell:startup` → Enter
2. Cola o atalho (do passo 4) nessa pasta
3. Próxima vez que reiniciar o PC, servidor já sobe sozinho

## Como usar no dia a dia

1. **De manhã**: recepcionista liga o PC → atalho na área de trabalho → clica
2. Janela preta abre e fica aberta. **NÃO FECHAR.**
3. CRM detecta servidor online (banner amarelo some)
4. Ela trabalha normal — clica "Executar selecionadas" no CRM, Chrome abre visível, robô trabalha
5. **Ao final do dia**: pode fechar a janela preta

## Solução de problemas

### Banner "Servidor offline" no CRM mas janela preta está aberta

- Confirma que está em "Servidor escutando em http://localhost:9876" (sem erro depois)
- Se mostrar erro, lê a mensagem e ajusta `.env`
- Se outra app está usando porta 9876: muda `PORT=9877` no `.env`, reinicia, e avisa Vinicius pra ajustar URL no CRM

### Robô não abre Chrome

- Verifica que o `ROBO_CAMINHO` no `.env` está correto e que a pasta tem `package.json`, `src/index.ts`, etc.
- Tenta rodar manualmente o robô uma vez na pasta dele pra garantir que dependências (Playwright) estão instaladas:
  ```powershell
  cd C:\Users\55489\Downloads\unimed-mvp\unimed-mvp
  npm install
  npx playwright install chromium
  ```

### Erro "SUPABASE_SERVICE_ROLE_KEY ausente"

- Edita `.env`, preenche a chave, salva, reinicia o servidor (fecha janela preta e abre de novo)

### Job ficou em "executando" pra sempre

- Algum Chrome travou ou o servidor caiu antes de finalizar
- Limpeza manual via SQL no Supabase:
  ```sql
  UPDATE unimed_aprovacao_jobs 
  SET status='falhou', erro_codigo='WORKER_DESAPARECEU', erro_mensagem='Servidor caiu durante execução' 
  WHERE status='executando' AND iniciado_em < now() - interval '10 minutes';
  ```

### CORS bloqueado no console do navegador

- Edita `.env`: adiciona o domínio do CRM em `CORS_ORIGINS`. Exemplo:
  ```
  CORS_ORIGINS=https://crm.lucianonoceti.com,http://localhost:5173
  ```
- Reinicia servidor

## Mudar configurações

Tudo está em `.env`. Edita, salva, reinicia o servidor (fecha janela e abre de novo).

Configurações úteis:
- `ROBO_HEADLESS=true` — se quiser que o Chrome rode invisível (não recomendado pra MVP — recepcionista perde visibilidade)
- `ROBO_TIMEOUT_MS=180000` — 3 minutos por job. Aumenta se a Unimed estiver lenta.
- `PORT=9876` — porta do servidor

## Logs e debug

A janela preta mostra tudo em tempo real:
- `[abc123-...]` — logs do job
- `[abc123] ✅ Sucesso. Guia 50139384999` — sucesso
- `[abc123] ❌ Falhou: ERRO_X - mensagem` — falha

Logs não são gravados em arquivo (pra não encher disco). Se precisar guardar histórico, copia da janela preta antes de fechar.

## Arquitetura técnica

- **Express** servindo HTTP em localhost:9876
- **Supabase JS** com service_role pra ler/escrever jobs e guias
- **Subprocesso** spawn pra rodar o robô em isolamento
- **RPC `pegar_proximo_unimed_job`** garante lock atômico (mesmo job não roda 2x)
- **Promise.all** dispara N jobs em paralelo
- **Timeout** de 3 minutos por job — se travar, mata processo
- **CORS** restrito aos domínios do CRM
