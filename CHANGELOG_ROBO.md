# Changelog — Robô Unimed

> Registro cronológico de todas as alterações no robô. Toda mudança DEVE ser registrada aqui com data, arquivos afetados e descrição.

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
