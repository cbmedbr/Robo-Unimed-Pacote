# Changelog — Robô Unimed

> Registro cronológico de todas as alterações no robô. Toda mudança DEVE ser registrada aqui com data, arquivos afetados e descrição.

---

## 17/08/2026

### Setup: robô pede a senha nova sozinho quando ela é trocada
**Arquivos:** `SENHA_VERSAO.txt` (novo), `iniciar-servidor.bat` (novo), `servidor-local/src/senha-versao.ts` (novo), `iniciar.bat`, `trocar-senha.ps1`, `servidor-local/src/index.ts`, `LEIA-ME.txt`, `.gitignore`
- Trocar a senha exigia avisar cada funcionário e passar PC por PC
- `SENHA_VERSAO.txt` é versionado e muda a cada troca; `.senha-versao` fica só no PC (gitignored) e guarda a versão já aplicada ali. Se diferem, o robô pede a senha antes de iniciar — uma vez por PC
- `trocar-senha.ps1` grava o marcador ao concluir, então o pedido não se repete
- **`iniciar.bat` foi reduzido ao mínimo** e delega para `iniciar-servidor.bat`: o `cmd.exe` lê o `.bat` linha a linha enquanto executa, então o `git pull` reescrevendo o próprio arquivo em execução fazia o resto virar lixo. O arquivo chamado só é aberto depois do pull terminar
- Guarda equivalente no servidor (`verificarVersaoSenha()` em `index.ts`): cobre a primeira execução após o pull, quando o `.bat` antigo ainda estava rodando. Sem ela o servidor subiria com a senha velha e só falharia no login, no meio de um atendimento
- Nenhuma senha entra no repositório — `SENHA_VERSAO.txt` guarda só uma data

### Setup: script para trocar a senha da Unimed nos PCs da equipe
**Arquivos:** `trocar-senha.bat` (novo), `trocar-senha.ps1` (novo), `LEIA-ME.txt`
- Trocar a senha exigia abrir os dois `.env` no Bloco de Notas em cada PC — inviável para a recepção
- `trocar-senha.bat` pede a senha nova (mascarada, com confirmação) e atualiza `UNIMED_SENHA` nos dois `.env`, criando a linha se não existir
- Escreve UTF-8 **sem BOM**: com BOM o `dotenv` não reconhece a primeira variável do arquivo
- Se nenhum `.env` existe, avisa que o PC não foi configurado e manda rodar o `instalar.bat`
- Lembra na tela que é preciso reiniciar o servidor, que é o passo mais esquecido
- Testado no Windows PowerShell 5.1, que é o que o `.bat` invoca

### Setup: instalador passa a criar o `.env` pedindo as credenciais
**Arquivos:** `instalar.bat`, `LEIA-ME.txt`, `CLAUDE.md`
- Colaborador novo não conseguia rodar o robô sem receber uma cópia manual do `.env`
- `instalar.bat` agora pede usuário/senha da Unimed e a service role key do Supabase (entrada mascarada) e monta `servidor-local/.env` e `unimed-mvp-final/.env`
- `ROBO_CAMINHO` é detectado a partir da pasta do script, em vez do caminho fixo da máquina do desenvolvedor anterior
- Corrigido nome errado da variável na instrução do instalador: era `SUPABASE_SERVICE_KEY`, o servidor exige `SUPABASE_SERVICE_ROLE_KEY` (`servidor-local/src/config.ts`) — quem seguisse a instrução antiga tinha o servidor abortando no boot
- Se o `.env` já existe, o instalador não sobrescreve
- Documentado que o repositório é **público** e que credenciais nunca entram no controle de versão, com o procedimento de troca de senha (inclui reiniciar o servidor, já que a config é lida só no boot)

---

## 14/08/2026

### Fix: guia de paciente intercâmbio não executava por campo obrigatório em branco
**Arquivos:** `unimed-mvp-final/src/execucao/preparar_execucao.ts`, `FLUXOS_NEGOCIO.md`, `DOCUMENTACAO_ROBO.md`
- `prepararExecucao()` assumia que *Tipo de atendimento* vinha pré-preenchido pelo portal — verdade para paciente LOCAL, falso para INTERCÂMBIO, onde o campo aparece como "Selecione"
- Sendo campo obrigatório, o portal recusava a execução da guia
- Agora o robô sempre garante "03 - Outras Terapias", em vez de confiar no pré-preenchimento
- O `<select>` é procurado por `DM_TP_ATEND_SADT` / `DM_TIPO_ATENDIMENTO` e, se não achar, por qualquer `<select>` que tenha uma opção "Outras Terapias" — o SGU usa nomes diferentes entre as telas de autorização e execução
- Seleção é conferida depois de aplicada; novos erros `TIPO_ATENDIMENTO_NAO_ENCONTRADO`, `TIPO_ATENDIMENTO_SEM_OPCAO` e `TIPO_ATENDIMENTO_NAO_PREENCHIDO`
- Tipo de atendimento é selecionado ANTES do regime, porque o portal recarrega parte do formulário ao mudar aquele campo

---

## 12/08/2026

### Doc: fluxos de negócio registrados como fonte da verdade
**Arquivos:** `FLUXOS_NEGOCIO.md` (novo), `CLAUDE.md` (novo), `DOCUMENTACAO_ROBO.md`
- SOP da operação (execução local com token, execução intercâmbio sem token, autorização retroativa) documentado passo a passo
- Corrigida a seção "FLUXO SÉRIE" da documentação, que ainda dizia "Gravar e Finalizar" (`#Button_Submit`) — o código usa `#Button_Parcial` desde 04/08

### Fix: sessão gravada no dia anterior ao realizado (erro de fuso horário)
**Arquivos:** `unimed-mvp-final/src/executar_sessao.ts`
- `new Date("2026-08-12T00:00:00+00:00")` era convertido para 11/08 21:00 no fuso de Brasília (UTC-3), e o robô gravava `dt_serie_N` no **dia errado**
- Ocorria sempre que o CRM mandava `data_execucao` como timestamp UTC (coluna `timestamptz` do Supabase) em vez de data pura
- Nova função `formatarDataSerie()`: datas de calendário (`YYYY-MM-DD` ou meia-noite UTC) são lidas literalmente da string; só instantes com hora real passam por conversão de fuso
- A data recebida do CRM agora aparece no log junto com a data formatada

### Fix: robô reportava sucesso sem o portal ter gravado a execução (fluxo série)
**Arquivos:** `unimed-mvp-final/src/executar_sessao.ts`, `DOCUMENTACAO_ROBO.md`
- Se a tela de sucesso não aparecesse mas o botão "Confirmar" tivesse sido clicado, o robô apenas logava um warning e retornava `sucesso: true`
- O servidor então marcava o agendamento como **executado no CRM** e incrementava `sessoes_executadas`, enquanto na Unimed a guia continuava em aberto
- Agora: 3 tentativas de 5s procurando a tela de sucesso (mesmo padrão do fluxo normal) e, se não encontrar, lança `FINALIZACAO_EXECUCAO_FALHOU`
- A mensagem de erro do portal (ex: "devem existir itens executados") é capturada e incluída no erro, mais screenshot de diagnóstico

---

## 04/08/2026

### Fix: CRM não marcava agendamento como executado após sucesso no portal
**Arquivos:** `servidor-local/src/executor-sessao.ts`
- Job era marcado como `sucesso` ANTES de atualizar o agendamento — se o update falhasse, agendamento ficava preso em `aguardando_execucao`
- Invertida a ordem: agora atualiza agendamento primeiro, com retry (2 tentativas)
- Se falhar após 2 tentativas, job vai como `sucesso_parcial` com mensagem de erro
- `data_execucao` agora usa `dados.data_execucao` (data do agendamento) em vez de `new Date()` (data atual)

### Fix: validação de CRM aceitava apenas 4+ dígitos
**Arquivos:** `unimed-mvp-final/src/validacao.ts`
- Regex `/^\d{4,}$/` rejeitava CRMs válidos com menos de 4 dígitos (ex: "942")
- Alterado para `/^\d+$/` — aceita qualquer quantidade de dígitos

---

## 20/07/2026

### Fix: fluxo série no robô de execução
**Arquivos:** `unimed-mvp-final/src/executar_sessao.ts`, `unimed-mvp-final/src/execucao/abrir_popup_cartao.ts`
- Guias com procedimento em série não tinham botão "Adicionar Execução Cartão" — o robô detecta `is_serie_1 = '1'` e segue fluxo diferente
- Preenche `dt_serie_N` (próximo campo vazio) com data/hora da sessão antes de clicar "Gravar e Finalizar"
- Detecta e clica "Confirmar" na página `finalizar_msg.do`
- Não chama `finalizarParcial` (o "Gravar e Finalizar" já faz tudo no fluxo série)

### Fix: falso positivo "Não há itens disponíveis para execução"
**Arquivos:** `unimed-mvp-final/src/execucao/abrir_popup_cartao.ts`
- `textContent("body")` pegava texto de elementos ocultos (`display:none`)
- Trocado por `page.evaluate()` que verifica `el.style.display !== 'none'` e `el.offsetParent !== null`
- Removido seletor `:visible:has-text(...)` que dava match no `<body>` (Playwright busca descendentes)

### Fix: atualizar CRM após execução bem-sucedida
**Arquivos:** `servidor-local/src/executor-sessao.ts`
- Ao receber `sucesso: true` do robô, agora atualiza `agendamentos.status_execucao = 'executado'`
- Incrementa `guias.sessoes_executadas + 1`
- Sessão sai da aba "Aguardando Execução" e vai para "Executadas"

### Fix: esconder badge "Executado" na aba Aguardando Execução
**Arquivos:** `CRM-ClinicaLN/src/pages/guias/AguardandoExecucao.jsx`
- Badge de sucesso confundia quando o paciente voltava para a próxima sessão
- Agora só mostra badges de erro/pendente/executando

### Criação da documentação do robô
**Arquivos:** `DOCUMENTACAO_ROBO.md`, `CHANGELOG_ROBO.md`
- Documentação completa de arquitetura, fluxos, códigos de erro, configuração
- Changelog para registro cronológico de alterações

---

## 22/06/2026

### Fix: fluxo INTERCAMBIO — 5 campos da carteirinha
**Arquivos:** `unimed-mvp-final/src/beneficiario.ts`
- Formulário de intercâmbio tem 5 campos: `CD_UNIMED`, `CD_CARTAO`, `CD_BENEF`, `CD_DEPEN`, `NR_DV`
- Mapeamento: 0-4 | 4-8 | 8-14 | 14-16 | 16+
- Preenchimento por `name` (robusto) em vez de por índice

### Fix: INTERCAMBIO deve clicar "Autorizar solicitação"
**Arquivos:** `unimed-mvp-final/src/beneficiario.ts`
- O robô clicava "Solicitação já autorizada" (exige senha) em vez de "Autorizar solicitação"
- Seletor diferente por tipo: LOCAL usa `a:has-text("manualmente")`, INTERCAMBIO usa `a:has-text("Autorizar solicita")`

### Fix: campos obrigatórios do formulário de autorização
**Arquivos:** `unimed-mvp-final/src/autorizacao.ts`
- `DT_SOLICITACAO` com formato `dd/MM/yyyy HH:mm` (portal exige hora)
- Celular removido (campo não obrigatório, máscara causava erro)
- Liminar judicial: seleciona "Não"

### Fix: profissional executante dinâmico
**Arquivos:** `unimed-mvp-final/src/finalizar.ts`
- Busca dinâmica do `<select>` com "LUCIANO" nas opções (sem hardcode de ID do select)
- Aguarda `#Botao_Finalizar` ficar visível após selecionar executante

### Fix: primeira_guia_fila — trigger broadcast quebrado
**Aplicado via:** Supabase migration
- `broadcast_table_change()` usava `NEW.id` mas tabela `primeira_guia_fila` tem PK `paciente_id`
- Trigger removido da tabela
- 20+ pacientes inseridos retroativamente

### Fix: planos regionais Unimed
**Aplicado via:** Supabase SQL
- 414 pacientes com `plano_saude_nome_snapshot = 'Unimed'` atualizados para a regional correta
- Derivado dos 4 primeiros dígitos da carteirinha via `fin_planos_precos`

### Botão "Reprocessar OCR" na PrimeiraGuia
**Arquivos:** `CRM-ClinicaLN/src/pages/PrimeiraGuia.jsx`
- Botão no dropdown "Solicitar Guia" para pacientes com pedido médico mas OCR `sem_pedido`
