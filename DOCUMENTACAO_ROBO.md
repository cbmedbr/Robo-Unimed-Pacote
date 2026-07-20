# Documentação Completa — Robô Unimed

> **Última atualização:** 20/07/2026  
> **REGRA:** Toda alteração no robô DEVE atualizar este documento. Antes de modificar qualquer arquivo do robô, leia este documento inteiro para entender o funcionamento completo.

---

## 1. Arquitetura Geral

O sistema é dividido em dois projetos Node.js independentes:

### `servidor-local/` — Servidor HTTP (localhost:9876)
- Roda na máquina do operador
- Recebe requisições do CRM (Vercel)
- Cria jobs no Supabase
- Spawna o robô como **subprocesso** (cada job = 1 processo Chrome isolado)
- Parsea o resultado do stdout do subprocesso

### `unimed-mvp-final/` — Robô (Playwright)
- Automação de browser via Playwright
- Roda como subprocesso do servidor
- Recebe input via JSON (stdin ou argumento)
- Retorna resultado via stdout (marcador `=== RESULTADO ===`)
- Cada execução abre e fecha seu próprio Chrome

### Fluxo de dados
```
CRM (Vercel) → POST localhost:9876/executar ou /executar-sessao
  → servidor-local cria job no Supabase
  → spawna: npx tsx unimed-mvp-final/src/index.ts [comando] [args]
  → subprocesso abre Chrome, executa automação
  → subprocesso imprime JSON após "=== RESULTADO ==="
  → servidor-local parsea resultado, atualiza Supabase
```

### Tabelas Supabase
- `unimed_aprovacao_jobs` — jobs de autorização de guia
- `unimed_execucao_jobs` — jobs de execução de sessão
- `guias` — guias criadas após autorização bem-sucedida
- `pacientes` — dados do paciente (telefone, email)
- Bucket `documentos` — PDFs dos pedidos médicos

---

## 2. Robô de Autorização — Fluxo Completo

**Comando:** `npx tsx src/index.ts autorizar` (default)

### Etapa 0: Validação de Input (`validacao.ts`)
Antes de abrir o browser, valida:
- `paciente.nome` ≥ 3 caracteres
- `carteirinha_raw`: se começa com `0025` → tipo deve ser `LOCAL`; senão → `INTERCAMBIO`. Deve ter exatamente 17 dígitos
- `medico_solicitante`: nome ≥ 3 chars, `uf_crm` = 2 letras maiúsculas, `numero_crm` = 4+ dígitos
- `cid`: formato `/^[A-Z]\d{2}(\.\d{1,2})?$/`
- `indicacao_clinica_formatada`: deve começar com `"CID "`
- `procedimento.codigo`: um de `50000470`, `2250005103`, `2250005278`, `2250005367`
- Quantidade: inteiro 1–60
- `especialidade_pedido`: deve ser `"PSICOLOGIA"`
- PDF: arquivo deve existir, extensão válida (.pdf/.jpg/.png/.doc/.xls), máximo 5 MB

### Etapa 1: Login (`login.ts`)
- Navega para `https://rda.unimedsc.com.br/cmagnet/Login.do`
- Seletores do campo usuário (em ordem): `input[name="cd_usuario"]`, `input[name="usuario"]`, `input[name="login"]`, `input[id="cd_usuario"]`, `input[type="text"]:visible`
- Seletores do campo senha: `input[name="senha"]`, `input[name="password"]`, `input[type="password"]`
- Seletores do botão entrar: `input[type="submit"]`, `button[type="submit"]`, `button:has-text("Entrar")`, `input[value*="Entrar" i]`; fallback: tecla `Enter`
- Sucesso: URL não contém mais `Login.do` OU `text=Exames` aparece

### Etapa 2: Navegação até o formulário (`beneficiario.ts` → `abrirFormularioGuia`)

1. **Menu Exames:** Clica `text=Exames` → `text=Exames em aberto`
2. **Novo Exame:** Clica `button:has-text("Novo Exame")` ou `a:has-text("Novo Exame")` ou `text=+ Novo Exame`
3. **Modal "Passe o cartão":** Faz polling em TODAS as páginas/frames por `text=/Passe o|Se tiver problemas|virtual.*QR/i`
4. **Clica "Se tiver problemas com o cartão, clique aqui":** `a:has-text("clique aqui")` (primeiro)
5. **Modal de tipo:** Faz polling por `text=/Problemas com o|Localize o|Cadastre o/i`

### Etapa 3: Beneficiário — Dois fluxos

#### LOCAL (carteirinha começa com 0025)
- Clica `a:has-text("Localize")`
- Divide carteirinha (17 dígitos): posições 0-4 | 4-8 | 8-14 | 14-16
- Preenche por índice nos 4 primeiros `input[type="text"]:visible`
- Clica `button:has-text("Localizar")` ou `input[value="Localizar"]`
- Aguarda nome do paciente aparecer na tela

#### INTERCAMBIO (carteirinha NÃO começa com 0025)
- Clica `a:has-text("Cadastre")`
- **5 campos** no formulário de verificação:
  - `CD_UNIMED` ← dígitos 0-4 (ex: "0865")
  - `CD_CARTAO` ← dígitos 4-8 (ex: "0004")
  - `CD_BENEF` ← dígitos 8-14 (ex: "475488")
  - `CD_DEPEN` ← dígitos 14-16 (ex: "01")
  - `NR_DV` ← dígito 16+ (ex: "5")
- Clica `button:has-text("Verificar")` ou `input[value="Verificar"]`
- Aguarda cenário A (cadastro novo → clica Atualizar) ou cenário B (já existe)

### Etapa 4: Tipo de digitação
- Faz polling por `a:has-text("SADT")` (link "Digitação de guia SP/SADT")
- Clica o link
- **Diferença por tipo:**
  - LOCAL: clica `a:has-text("manualmente")` (sem validação — "Solicitação já autorizada")
  - INTERCAMBIO: clica `a:has-text("Autorizar solicita")` ou `a:has-text("realizar valida")` ("Autorizar solicitação" — com validação)
- Faz polling pelo formulário grande (`text=/Dados da Guia|Dados do|Nome do Contratado/i`)

### Etapa 5: Campos básicos do formulário (`autorizacao.ts` → `preencherCamposBasicos`)
- `#DT_EMISSAO_GUIA` → hoje (dd/MM/yyyy) + Tab
- `#DT_SOLICITACAO` → hoje com hora (`dd/MM/yyyy 00:00`) + Tab
- `select[name="FG_ATENDIMENTO_RN"]` → valor `"N"` (Não)
- Celular: **não preenche** (evita erro de validação de máscara)
- Email `#ds_email`: preenche apenas se for email real (sem placeholders)
- **Nome do Contratado** (sub-fluxo):
  - Clica `#link_busca_contrt` (lupa)
  - Faz polling por modal "Localizar prestador" em todas as janelas
  - Preenche código `300788` no campo "Código na Operadora"
  - Clica Localizar
  - Clica `a:has-text("CLINICA LUCIANO NOCETI")`
- `#DM_CARATER_SOLIC` → valor `"1"` (Eletivo)
- `#DS_INDIC_CLINICA` → texto da indicação clínica
- `select[name="DM_TP_ATEND_SADT"]` → valor `"03"` (Outras Terapias)
- `select[name="DM_TP_ACIDENTE"]` → valor `"9"` (Não acidente)
- `select[name="FG_LIMINAR_JUDICIAL"]` → valor `"N"` ou primeira opção com "Não"

### Etapa 6: Médico solicitante (`medico.ts`)
- Clica `#link_busca_solic` → abre popup "Localizar prestador"
- Preenche: Conselho = CRM, Número = CRM do médico, Cadastro = "Prestador da Rede Unimed"
- Clica Localizar

**Caminho A:** Encontrado como cooperado → seleciona na lista por nome (5 estratégias de fallback)

**Caminho B:** Não encontrado → fecha popup, reabre, busca como "Prestador Externo":
- **B1:** Encontrado como externo → seleciona
- **B2:** Não encontrado → clica "Inserir novo" → preenche formulário de cadastro:
  - Nome, Pessoa Física, Conselho CRM, Número, UF
  - CBO: abre popup de busca, preenche "2251", clica "Médico clínico" (225125)
  - Clica Cadastrar

### Etapa 7: Procedimento (`procedimento.ts`)
- `#CD_ITEM_1` → digita código do procedimento (ex: `50000470`)
- Tab (dispara lookup assíncrono do SGU)
- `#NR_QTD_1` → preenche quantidade
- Clica `#BtnAtualizar` para validar a linha
- Aguarda descrição esperada (ex: "SESSAO DE PSICOTERAPIA")

### Etapa 8: Anexo do pedido médico (`anexo.ts`)
- Clica `#item_anexos_1` (ícone de anexo na linha do procedimento)
- Faz polling por modal de anexo em todas as janelas (URL contendo "anexo"/"upload" + `input[type="file"]`)
- Injeta arquivo via `fileInput.setInputFiles(path)` — sem diálogo do OS
- Clica "Anexar" se existir
- Verifica "Total de registros: 1"
- Clica "Finalizar" para fechar modal

### Etapa 9: Profissional executante (`finalizar.ts` → `garantirProfissionalExecutante`)
- `page.evaluate()` busca dinamicamente o `<select>` que contém opção com "LUCIANO" no texto
- Seleciona a opção pelo `value` encontrado
- Aguarda `#Botao_Finalizar` ficar visível (fica oculto até selecionar executante)

### Etapa 10: Finalização (`finalizar.ts`)
- Clica `#Botao_Finalizar` ou `input[name="Botao_Finalizar"]` ou `input[value="Finalizar"]`
- **Detecção de erros:** busca no HTML padrões de erro de validação
- **Captura do número da guia** (4 estratégias em ordem):
  1. Aguarda "Operação realizada com sucesso" → lê `#linkNrGuia`
  2. Lê `#NR_GUIA` (input)
  3. Regex no HTML: `/Nº\s*Guia[:\s]*(\d{8,})/i`
  4. `waitForFunction` com polling
- **Detecção de situação:** NEGADA, EM_ANALISE, EM_EXECUCAO (default: EM_ANALISE)
- **Captura de senha:** regex no HTML da tela de sucesso
- Salva `dump-sucesso.html` + `dump-sucesso.png`

---

## 3. Robô de Execução de Sessão — Fluxo Completo

**Comando:** `npx tsx src/index.ts executar-sessao`  
**Sempre visível** (headless=false) — operador precisa apresentar QR Code da webcam.

### Etapa 1: Login
Mesmo `fazerLogin()` da autorização.

### Etapas 2-3: Buscar e abrir guia (`execucao/buscar_e_abrir_guia.ts`)
1. Clica menu Exames → "Exames em aberto"
2. Limpa filtros de data
3. Preenche nome do paciente em `input[name="s_nm_benef"]`
4. Clica Filtrar
5. Verifica contagem de exames encontrados
6. Clica na guia pelo código (ou primeira da lista)
7. Aguarda URL conter `/sadt/execucao.do`

### Etapas 4-5: Preparar execução (`execucao/preparar_execucao.ts`)
- Lê quantidade solicitada/autorizada dos campos `QT_SOLIC_1` e `QT_AUTORIZADA_1`
- Se `qtAutorizadas === 0` → erro `SEM_SESSOES_DISPONIVEIS`
- Seleciona regime: `select#DM_REGIME_ATEND` → "01 - Ambulatorial"

### Etapa 6: Abrir popup cartão (`execucao/abrir_popup_cartao.ts`)
Salva dump HTML + screenshot para diagnóstico.

**Verificações de bloqueio (apenas elementos VISÍVEIS):**
- `#trLembreteSemItens` visível (display !== none) → erro `SEM_ITENS_EXECUCAO`
- Texto "não possui itens liberados" visível → erro `SEM_ITENS_EXECUCAO`

**Busca do botão** (em ordem):
```
a#adicionar_execucao_carteirinha
a[id*='adicionar_execucao']
a:has-text('Adicionar Execução')
a:has-text('Execução Cartão')
a:has-text('Execução Carteirinha')
input[value*='Adicionar Execução']
button:has-text('Adicionar Execução')
a:has-text('Executar')
```

**Se botão não encontrado:**
- Verifica `input[id="is_serie_1"]` valor `'1'` + `#Button_Submit` visível → retorna `{ page, serie: true }`
- Verifica Qtde = 0 na tabela → erro `SESSOES_ESGOTADAS`
- Senão → erro `POPUP_NAO_ABRIU`

### Dois fluxos a partir daqui:

#### FLUXO NORMAL (não-série)
1. Clica botão → captura popup via `context.waitForEvent("page")`
2. Injeta `window.confirm = () => true` no popup
3. **QR Code** (`execucao/aguardar_qrcode.ts`):
   - Clica `a#qr-code` no popup
   - Aguarda URL conter `/qrcode.do`
   - `Promise.race` com timeout de 180s:
     - Popup fecha → sucesso (operador escaneou, portal validou)
     - `text=/Erro!/i` aparece → erro `QR_CODE_INVALIDO`
     - Timeout → erro `TIMEOUT_QR_CODE`
4. Aguarda dialog de confirmação (15s)
5. **Finalizar Parcial** (`execucao/finalizar.ts`):
   - Clica `input#Button_Parcial`
   - Trata página intermediária `finalizar_msg.do` (clica Confirmar/OK)
   - Aguarda tela de sucesso
   - Captura screenshot comprovante

#### FLUXO SÉRIE (guia com procedimento em série)
O formulário de série tem 10 campos `dt_serie_1` a `dt_serie_10` na seção "Data e Assinatura de Procedimentos em Série". Cada campo aceita `dd/MM/yyyy HH:mm`. O campo 1 começa habilitado; os demais ficam `disabled` até o anterior ser preenchido.

1. **Encontra o próximo `dt_serie_N` vazio** (1 a 10)
2. **Habilita o campo** se estiver disabled (`el.disabled = false`)
3. **Preenche com data/hora** da sessão (formato `dd/MM/yyyy HH:mm`) + dispara evento `change`
4. Clica `#Button_Submit` ("Gravar e Finalizar")
5. Detecta nova página `finalizar_msg.do` (popup de confirmação HTML, não dialog JS)
6. Clica `input[value="Confirmar"]` na `finalizar_msg.do`
7. Aguarda processamento e tela de sucesso
8. Captura screenshot comprovante
9. **NÃO** chama `finalizarParcial` (o "Gravar e Finalizar" já faz tudo)

**Nota:** O JS do portal (`verificarSubmit`) lê o último `dt_serie` preenchido e envia junto com o submit. Sem preencher ao menos um `dt_serie`, o portal retorna "Para gravar a guia, devem existir itens executados".

---

## 4. Verificação de Status (Cron)

### Agendamento
- Primeira execução: 5 minutos após iniciar o servidor
- Intervalo: a cada 4 horas
- Endpoint manual: `POST /verificar-em-analise` (com `{ forcar: true }` para ignorar limite de 15 dias)

### Fluxo (`verificar_status.ts`)
1. Login no portal
2. Para cada número de guia:
   - Navega para "Exames em aberto"
   - Filtra pelo número da guia
   - Lê situação na tabela (texto do `<span>` na linha)
   - Se não encontrada → tenta "Exames finalizados"
3. Interpreta situação:
   - `"em execução|autorizado|liberado"` → `APROVADO`
   - `"em estudo|em análise|aguardando"` → `EM_ANALISE`
   - `"negado|recusado|não autorizado|cancelado"` → `NEGADA`
4. Atualiza Supabase:
   - APROVADO → job `status="sucesso"`, guia `status="ativa"`
   - NEGADA → job `status="falhou"`, guia `status="negada"`
   - EM_ANALISE → sem alteração

---

## 5. Códigos de Erro

### Validação
| Código | Causa |
|---|---|
| `VALIDACAO_INPUT` | Falha genérica de validação |
| `PDF_NAO_ENCONTRADO` | Arquivo não existe no path |
| `PDF_MUITO_GRANDE` | Arquivo > 5 MB |
| `PDF_FORMATO_INVALIDO` | Extensão não permitida |
| `ESPECIALIDADE_INVALIDA` | Diferente de "PSICOLOGIA" |
| `CARTEIRINHA_INVALIDA` | Quantidade de dígitos errada ou tipo incompatível com prefixo |
| `MEDICO_DADOS_INVALIDOS` | Nome curto, UF errada, CRM não numérico |
| `CID_INVALIDO` | Formato não bate com regex |

### Login
| Código | Causa |
|---|---|
| `LOGIN_FALHOU` | Campo não encontrado ou sem redirect |
| `LOGIN_TIMEOUT` | Timeout durante login |

### Navegação
| Código | Causa |
|---|---|
| `MENU_NAO_ENCONTRADO` | Botão "+ Novo Exame" não achado |
| `MODAL_NOVO_EXAME_NAO_ABRIU` | Modal "Passe o cartão" ou link "clique aqui" não apareceu |
| `SESSAO_EXPIRADA` | Redirect para Login.do no meio do fluxo |

### Beneficiário
| Código | Causa |
|---|---|
| `BENEFICIARIO_NAO_LOCALIZADO` | Paciente não encontrado, ou link SADT ausente |
| `BENEFICIARIO_RESTRICAO` | SGU mostra restrição administrativa |
| `INTERCAMBIO_VERIFICACAO_FALHOU` | Tela pós-Verificar não apareceu |

### Médico
| Código | Causa |
|---|---|
| `MEDICO_NAO_LOCALIZADO` | Popup de busca não abriu |
| `MEDICO_CADASTRO_FALHOU` | Formulário de cadastro externo não encontrado |
| `CBO_NAO_ENCONTRADO` | Popup de CBO não abriu (tem fallback via JS) |

### Formulário
| Código | Causa |
|---|---|
| `CAMPO_OBRIGATORIO_REJEITADO` | Modal ou campo obrigatório não encontrado |
| `PROCEDIMENTO_INVALIDO` | Código inválido |

### Anexo
| Código | Causa |
|---|---|
| `PDF_UPLOAD_FALHOU` | Modal de anexo não abriu |

### Finalização
| Código | Causa |
|---|---|
| `FINALIZACAO_FALHOU` | Portal rejeitou com erro de validação |
| `GUIA_NAO_GERADA` | Número da guia não capturado |

### Execução de Sessão
| Código | Causa |
|---|---|
| `SEM_SESSOES_DISPONIVEIS` | qtAutorizadas = 0 |
| `SEM_ITENS_EXECUCAO` | Mensagem visível de bloqueio no portal |
| `SESSOES_ESGOTADAS` | Qtde = 0 na tabela de procedimentos |
| `POPUP_NAO_ABRIU` | Botão "Adicionar Execução Cartão" não encontrado |
| `QR_CODE_INVALIDO` | Erro biométrico do portal |
| `TIMEOUT_QR_CODE` | QR Code não escaneado em 3 minutos |

### Servidor
| Código | Causa |
|---|---|
| `TIMEOUT` | Subprocesso matado após timeout |
| `SUBPROCESSO_ERRO` | Falha ao spawnar processo |
| `RESULTADO_NAO_PARSEAVEL` | Saiu com código 0 mas stdout sem JSON válido |
| `ROBO_FALHOU` | Saiu com código não-zero sem JSON |
| `ERRO_PRE_EXECUCAO` | Erro antes de iniciar o robô (ex: download de PDF) |
| `GUIA_DB_ERRO` | Guia obtida mas falhou ao inserir no banco |

---

## 6. Configuração

### `unimed-mvp-final/.env`
| Variável | Default | Descrição |
|---|---|---|
| `UNIMED_USUARIO` | — | Login do portal (ex: `300788`) |
| `UNIMED_SENHA` | — | Senha do portal |
| `UNIMED_URL` | `https://rda.unimedsc.com.br/cmagnet/Login.do` | URL de login |
| `HEADLESS` | `false` | Browser invisível |
| `SCREENSHOT_DIR` | `./screenshots` | Diretório de screenshots |
| `LOG_LEVEL` | `info` | Nível de log |
| `DEBUG` | `false` | Modo debug (delay de 10s no final) |
| `NAVEGACAO_TIMEOUT` | `30000` | Timeout de navegação (ms) |
| `CLICK_TIMEOUT` | `10000` | Timeout de clique (ms) |

### `servidor-local/.env`
| Variável | Default | Descrição |
|---|---|---|
| `SUPABASE_URL` | — | URL do Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service role key (bypass RLS) |
| `UNIMED_USUARIO` | — | Login do portal |
| `UNIMED_SENHA` | — | Senha do portal |
| `ROBO_CAMINHO` | — | Path absoluto para `unimed-mvp-final/` |
| `ROBO_TIMEOUT_MS` | `180000` | Timeout do subprocesso (ms) |
| `ROBO_HEADLESS` | `false` | Browser invisível |
| `PORT` | `9876` | Porta do servidor |
| `CORS_ORIGINS` | `*` | Origens permitidas |

---

## 7. Como o CRM dispara jobs

### Autorização
1. CRM cria linha em `unimed_aprovacao_jobs` com `status='pendente'`
2. CRM chama `POST localhost:9876/executar` com `{ jobIds: [id1, id2, ...] }`
3. Servidor valida, responde 202, executa sequencialmente (3s entre jobs)

### Execução de sessão
1. CRM chama `POST localhost:9876/executar-sessao` com dados completos
2. Servidor cria linha em `unimed_execucao_jobs`, responde 202
3. Executa em background (1 por vez — operador precisa estar presente)

### Health check
- CRM faz polling em `GET localhost:9876/health`
- Retorna `{ ok: true }` se servidor está rodando

---

## 8. Problemas conhecidos e workarounds

1. **Campo `NM_PROFISSIONAL` limpo pelo portal** — Após clicar "Atualizar procedimento", o SGU pode limpar o campo do médico solicitante. O robô loga warning mas não consegue re-preencher.

2. **Seleção de médico por nome é frágil** — Se o nome no SGU difere do CRM (iniciais, prefixo DR.), o robô tenta 5 estratégias de fallback. Último recurso: primeiro link "Pessoa Física" na tabela.

3. **Override de `window.confirm()`** — O popup de QR Code precisa de `addInitScript` para auto-aceitar `confirm()`. Backup: handler de dialog registrado.

4. **Situação default = EM_ANALISE** — Se o HTML da finalização não bater com nenhum padrão, o robô reporta EM_ANALISE (conservador). Pode gerar ciclos desnecessários de verificação.

5. **Detecção de série é frágil** — Depende de `input[id="is_serie_1"]` com `value='1'`. Se o SGU mudar esse hidden field, o fluxo série não será detectado.

---

## 9. Mapa de Arquivos

### `unimed-mvp-final/src/`
| Arquivo | Função |
|---|---|
| `index.ts` | Entry point — roteia para autorizar/executar/verificar |
| `autorizacao.ts` | Orquestrador de autorização + campos básicos |
| `executar_sessao.ts` | Orquestrador de execução de sessão |
| `beneficiario.ts` | Navegação + cadastro beneficiário (LOCAL/INTERCAMBIO) |
| `medico.ts` | Busca/cadastro de médico solicitante |
| `procedimento.ts` | Preenchimento do procedimento |
| `anexo.ts` | Upload do pedido médico |
| `finalizar.ts` | Finalização da guia + captura do número |
| `login.ts` | Login no portal |
| `validacao.ts` | Validação do input |
| `types.ts` | Tipos TypeScript |
| `verificar_status.ts` | Verificação de status de guias |

### `unimed-mvp-final/src/execucao/`
| Arquivo | Função |
|---|---|
| `buscar_e_abrir_guia.ts` | Menu → filtro → abre guia |
| `preparar_execucao.ts` | Lê sessões + seleciona regime |
| `abrir_popup_cartao.ts` | Detecta série / abre popup do cartão |
| `aguardar_qrcode.ts` | Espera operador escanear QR Code |
| `finalizar.ts` | Clica Finalizar Parcial + confirmações |
| `tipos.ts` | Tipos + classe RoboError |

### `servidor-local/src/`
| Arquivo | Função |
|---|---|
| `index.ts` | Servidor HTTP + cron |
| `executor.ts` | Converte job → input do robô (autorização) |
| `executor-sessao.ts` | Converte job → input do robô (execução) |
| `verificador.ts` | Lógica do cron de verificação |
| `types.ts` | Tipos do servidor |
| `config.ts` | Leitura de .env |
| `supabase.ts` | Cliente Supabase |
