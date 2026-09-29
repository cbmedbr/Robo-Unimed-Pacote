# SC Saúde — mapeamento do portal

> **Status: reconhecimento em andamento.** Nada implementado no robô ainda, nada em produção.
> Este documento registra o que já foi confirmado **contra o portal real**, para que o adaptador
> seja escrito em cima de fato e não de suposição.
>
> O processo de negócio descrito pela operação está no documento *"Solicitação de autorização
> SC Saúde"*. Este arquivo cobre **como o portal se comporta** — inclusive várias coisas que
> aquele documento não menciona porque quem opera à mão nem percebe.

---

## 1. Acesso

| | |
|---|---|
| Portal | `https://portal.scsaude.sc.gov.br/sistemas` |
| Após login | `https://atendimento.scsaude.sc.gov.br/home` |
| Versão vista | Atendimento 4.56.5 |
| Operadora (id interno) | `757444` |

Credenciais ficam em `unimed-mvp-final/.env` como `SCSAUDE_USUARIO` e `SCSAUDE_SENHA`, fora do
controle de versão. **Este repositório é público — nunca commite as credenciais.**

> **A senha precisa estar entre aspas no `.env`.** Ela contém `#`, e o `dotenv` trata isso como
> início de comentário: sem aspas o valor é truncado no `#` e o portal responde apenas
> "usuário e/ou senha inválidos", sem nada apontando para o arquivo de configuração.
> Foi o primeiro problema que enfrentamos, e custou duas rodadas.

---

## 2. Fluxo mapeado

Tudo abaixo foi confirmado executando contra o portal em 29/09/2026.

### 2.1 Login

| Campo | Seletor |
|---|---|
| Usuário | `input[name="username"]` |
| Senha | `input[name="password"]` (id é `senha`, não `password`) |
| Entrar | `input[name="submit"]` |

O botão é `input[type=submit]` com `value="Entrar"` — **não tem texto**. Clicar por texto
(`getByText`) acha outro elemento e o formulário nunca é enviado, sem erro aparente.

Erros de login aparecem em `#login-error`, `#username-error` e `#password-error`.

### 2.2 Menu

Após o login, a tela oferece **Análise de Contas · Atendimento · Setup**. Clicar em
"Atendimento" leva para outro domínio (`atendimento.scsaude.sc.gov.br`) — a navegação entre
domínios derruba qualquer `page.evaluate()` disparado cedo demais.

Menu lateral: Painel · Atendimentos (Novo, Meus Atendimentos, Solicitações e Encaminhamentos) · Sair.

### 2.3 Novo atendimento

`/atendimentos/novo` oferece dois caminhos:

| Botão | Seletor |
|---|---|
| Solicitação de Autorização | `input[name="form-selecao:btn-proc-solic-aut"]` |
| Captura / Execução | `input[name="form-selecao:btn-proc-captura-execucao"]` |

O SOP manda usar **Captura / Execução** mesmo para solicitar autorização.

### 2.4 Localizar o beneficiário

| Campo | Seletor |
|---|---|
| Operadora | `select[name="form-principal:select-operadora"]` |
| Tipo de atendimento | `select[name="form-principal:select-tipo-atendimento"]` |
| Nº da carteira | `input[name="form-principal:numeroCarteira:value"]` |
| Nome | `input[name="form-principal:nomeBeneficiario:value"]` |
| CPF | `input[name="form-principal:cpfBeneficiario:value"]` |
| Próximo Passo | `input[name="form-principal:criar-atendimento-button"]` |

Quatro armadilhas, nenhuma delas no documento da operação:

1. **A operadora é obrigatória e vem vazia.** Só existe uma opção real ("SC Saúde", valor `757444`).
   Sem ela o "Próximo Passo" fica `disabled`.
2. **Escolher a operadora limpa o tipo de atendimento.** A ordem correta é operadora → esperar o
   recarregamento → tipo.
3. **O tipo tem vizinhas parecidas:** Internação, SADT, SADT Internado, SADT Pronto Socorro.
   A correta é `SADT` exato — casar por "contém SADT" pega a errada.
4. **Os três campos de busca são typeahead** (`data-provide="typeahead"`), com um
   `:hiddenId` que guarda a escolha. `fill()` grava o valor sem disparar a busca: é preciso
   **digitar** (`pressSequentially`) e clicar na sugestão. O botão só habilita depois disso.

O formulário monta em AJAX. Espere pelo elemento (`waitForSelector`), nunca por tempo fixo.

### 2.5 Capturar Guias

`/guias/capturas?cid=1` — é a "nuvem" do documento. Tem:

- botão **Digitar uma Guia** (leva ao formulário de nova solicitação)
- filtro por Número da Guia e intervalo de Data da Solicitação
- tabela: Data · Número da Guia · Tipo da Guia · Solicitante · Senha · Validade · Situação
- ícone **Capturar guias**, habilitado conforme o status

### 2.6 Formulário da guia

`/solicitacoes/exames/novo?cid=1`, alcançado pelo botão **Digitar uma Guia**.

| Campo | Seletor (prefixo `form-principal:`) |
|---|---|
| Nº guia do prestador | `numeGuiaPrestador` |
| Nº guia principal | `numeGuiaPrincipal` |
| Carteirinha | `numeroCarteira` |
| Atendimento RN | `atendimentoRN` (radio `:0` / `:1`) |
| **Profissional solicitante** | `nomeProfissionalSolicitante:value` |
| Conselho | `conselhoProfissional` |
| **Nº do conselho** | `numConselhoProfissionalSolicitante:value` |
| UF do conselho | `ufConselho` |
| CBOS | `cbosProfissional` (select) |
| **Contratado solicitante** | `idPrestSolicitante:value` e `razaoPrestSolicitante:value` |
| Caráter | `caraterAtendimento` (select) |
| Data da solicitação | `dtSolicitacao:value` |
| Indicação clínica | `indicacaoClinica` (textarea) |
| Observação | `observacaoInput` (textarea) |

Procedimentos, em lista indexada (`procedimentos-solicitados-list:tabelaProcedimentos:0:`):

| Campo | Seletor |
|---|---|
| Tabela | `…:0:procedimento:tabela` (select) |
| Código | `…:0:procedimento:codigo` |
| Descrição | `…:0:procedimento:descricao` |
| Quantidade | `…:0:quantidadeSolicitada` |
| Incluir | `procedimentos-solicitados-list:btnAddProcedimento` |

O índice `:0:` indica que o portal aceita **várias linhas** de procedimento.

**Opções confirmadas:**

- `caraterAtendimento`: Selecione · **Eletiva** · Urgência/Emergência
- `tabela`: Selecione · 00 · 18 · 19 · 20 · **22 - TUSS _ Procedimentos e eventos em saúde** · 98
  — confirma o "tabela sempre 22" do documento da operação
- `cbosProfissional`: só "Selecione" com o formulário vazio; deve popular depois que o
  profissional for escolhido

**Todo campo terminado em `:value` é typeahead.** É o mesmo padrão dos campos de busca do
beneficiário: exige digitar e clicar na sugestão, e `fill()` não funciona. Isso vale para o
profissional solicitante, o número do conselho e o contratado solicitante — justamente os três
campos mais delicados do formulário.

**Botões da tela:** Anexar Documentos · Anexos · Beneficiário · Solicitar OPME · Solicitar
Radioterapia · Solicitar Quimioterapia · **Solicitar Autorização** · **Gerar Guia** ·
Incluir Procedimento.

> Os dois últimos em negrito são os que enviam a solicitação. O script de reconhecimento nunca
> os clica — estão na lista de proibidos.

#### Comportamento confirmado com um caso real (29/09/2026)

Preenchemos o formulário inteiro com um pedido de verdade, **parando antes de solicitar**.
Tudo abaixo foi observado, não deduzido:

| Campo | O que acontece |
|---|---|
| Carteirinha, nome, CNS | já vêm preenchidos do beneficiário escolhido |
| Atend. a RN | já vem em **Não** — não precisa mexer |
| Profissional solicitante | typeahead por **nome**; devolve `<nº conselho> - <Nome do Médico>` |
| Conselho / nº / UF | preenchem **sozinhos** ao escolher o profissional |
| CBOS | preenche **sozinho** (`225125`, "Médico clínico") e é a única opção |
| Contratado solicitante | typeahead; ver a cadeia de fallback abaixo |
| Data da solicitação | já vem com **a data de hoje** |
| Caráter | select comum, "Eletiva" |
| Indicação clínica | textarea comum |
| Procedimento | **também é typeahead**, não um campo de texto |
| Quantidade | campo comum |

**A cadeia de fallback do contratado solicitante funciona como o documento descreve.** No caso
testado, a médica é de outro estado e a clínica dela não tem cadastro:

```
"<nome da clínica do pedido>"  → nenhuma sugestão
"consultorio"                  → 99999999999999 - CONSULTORIO
```

O prestador genérico tem código `99999999999999`. Vale notar que o fallback **não é um erro**:
é o caminho normal para médico de fora, e vai acontecer com frequência.

**O procedimento é typeahead e devolve a regra de cobertura na descrição:**

```
22 - 10101118 - Sessao de Psicoterapia / Psicologo - (12 ou ate 40 por ano se cumprir diretriz)
```

Ou seja, o próprio portal informa o limite anual. Isso é informação nova, que não estava no
documento da operação, e pode importar para o CRM ao calcular quantidade.

#### Modal "Anexar Documento"

Abre por cima do formulário e tem: **Arquivo para anexar** (botão *Adicionar*), **Mensagem**
(textarea) e os botões **Anexar** / **Cancelar**.

A tela ainda lista, acima, os **Documentos Necessários** — no caso, "1. Pedido Médico" — com um
ícone de clipe na linha.

#### Informativos modais

O portal abre informativos que ficam **por cima e engolem os cliques**, e aparecem de forma
**intermitente**: no mesmo fluxo, um paciente disparou o modal e outro não.

Sempre tentar fechar (botão "Fechar") antes de cada clique importante. Existe um checkbox
"Ok. Entendi. Não abrir automaticamente", mas é preferível que a automação seja resistente ao
modal a depender de uma preferência da conta que também afeta quem usa o portal à mão.

#### Cuidado com seleção por texto

Três vezes o mesmo erro pegou o reconhecimento:

| Elemento | Armadilha |
|---|---|
| Entrar | é `input[type=submit]`, **não tem texto** — clicar por texto pega outro elemento |
| Próximo Passo | idem |
| Digitar uma Guia | o texto aparece **também no parágrafo informativo** que cita o botão |

Regra para o adaptador: **selecionar por `name`/`id` sempre que existir**; por texto só em último
caso e restringindo a tag (`a:has-text(...)`, nunca `getByText`). Este portal é generoso nisso —
quase tudo tem `name` estável no padrão `form-principal:…`.

---

## 3. API REST interna

O portal usa endpoints JSON que apareceram no tráfego. Não vamos automatizar por eles —
automação de tela é mais previsível e a sessão já funciona —, mas são úteis para diagnóstico:

| Endpoint | Para quê |
|---|---|
| `/rest/operadoras/757444/beneficiarios?numeroCarteira=` | busca por carteirinha |
| `/rest/operadoras/757444/beneficiarios?cpf=` | busca por CPF |
| `/rest/operadoras/757444/beneficiarios?nome=` | busca por nome |
| `/rest/operadoras/757444/profissionais?nome=` | busca do médico solicitante |
| `/rest/operadoras/757444/prestadores/local?nome=` | busca do contratado solicitante |
| `/rest/beneficios?origem=P&beneficioCodigoTuss=&codigoTabela=` | busca do procedimento |
| `/rest/solicitacoes/quantidades/{diarias,mensais,periodo}` | números do painel |

A busca devolve `numeroCarteira`, `pessoa.nome`, `pessoa.cpf`, entre outros. Quando não encontra,
responde **`200` com lista vazia** — nunca um erro. Quem consumir isso precisa tratar a lista
vazia explicitamente, senão a falha passa em silêncio.

---

## 4. Carteirinhas do CRM podem não bater

No primeiro paciente testado, a carteirinha guardada no CRM **não existia no SC Saúde**: faltava
um zero à esquerda e o dígito final era outro (16 dígitos no CRM contra 17 no portal). A busca
por CPF encontrou a paciente normalmente e devolveu o número correto.

Consequências para o desenho:

- **Buscar por CPF primeiro**, carteirinha como segunda tentativa. O CPF não muda quando o
  paciente troca de cartão — ressalva que o próprio documento da operação faz.
- **Vale auditar as carteirinhas de SC Saúde no CRM** antes de ligar a automação, usando a API
  de consulta por CPF. Se o problema for generalizado, o robô falharia em boa parte dos
  pacientes — e falharia em silêncio, porque o portal só devolve lista vazia.

---

## 5. Regras de negócio

### Procedimentos

| Tipo | Código |
|---|---|
| Sessões típicas | `10101118` |
| Sessões atípicas | `13107208` |

Psicopedagogia e avaliação neuro **não existem no SC Saúde por enquanto** (decidido em 29/09/2026).

### Quantidade

Típicas: **4 sessões** em fevereiro, abril, junho, setembro e novembro; **5** nos demais meses.
São os meses de 30 dias mais fevereiro contra os de 31 — ou seja, é uma contagem de semanas.

Atípicas: 5, ou conforme o pedido médico quando for 2× por semana.

> **Quem calcula é o CRM**, não o robô (decidido em 29/09/2026). É a mesma regra adotada para a
> Unimed em 22/09: o robô digita o que recebe e não recalcula nada. Ter dois donos da mesma
> decisão foi o que produziu os bugs de agosto.

### Outros campos do formulário

- Caráter de atendimento: **eletiva**
- Indicação: sempre o CID
- Tabela: **22** (normalmente já preenchida)
- CBOS: normalmente automático; quando não vier, usar **clínico**
- Contratado solicitante: o local onde o médico atende. Se não estiver na lista →
  "pesquisar outros prestadores" → busca pelo nome do local → se nada aparecer, **"consultório"**
- Telefone em alerta de guia em análise: genérico **48999999999**

---

## 6. Status possíveis da guia

Autorizada · Parcialmente autorizada · Em análise · Executada · Cancelada · Negada

"Parcialmente autorizada" casa com a leitura de quantidade autorizada já implementada para a
Unimed em 22/09 — a guia deve ser gravada com o **autorizado**, não com o pedido.

---

## 7. A etapa de captura

Guia autorizada na hora já é capturada automaticamente. Guia que cai **em análise** fica na nuvem
e precisa ser **capturada depois**, manualmente, quando for autorizada.

É um fluxo inteiro que não existe na Unimed: além de ler o status, precisa **agir** no portal.
Fica fora do primeiro corte.

---

## 8. Como isolar numa máquina só

O `iniciar.bat` puxa da `main` automaticamente, então **manter o código numa branch não protege
ninguém**: no instante do merge, todas as máquinas recebem.

O isolamento tem que ser em tempo de execução:

```
SCSAUDE_HABILITADO=true
```

no `.env` **apenas** da máquina de teste. O servidor recusa job de SC Saúde sem essa variável, e
nas demais máquinas o código fica inerte mesmo presente. Mesmo princípio do `SENHA_VERSAO.txt`:
controle por máquina, não por branch.

---

## 9. O que falta

O caminho feliz está mapeado do login até o **formulário preenchido**, com um caso real, e o
modal de anexo também. O que resta são as telas que **só aparecem depois de enviar uma
solicitação** — que o reconhecimento somente-leitura não alcança:

1. Os alertas: "A guia solicitada possui alertas" e o pedido de telefone/e-mail
2. As telas de resultado: Guia Autorizada e Guia em Análise
3. A tela de captura de uma guia que ficou em análise

Para essas três, o caminho é acompanhar uma autorização real feita pela colaboradora que opera
o portal, com o observador ligado.

Para essas quatro só há dois caminhos: alguém percorre o fluxo manualmente com o navegador
instrumentado, ou a primeira execução real do robô é acompanhada de perto, salvando os dumps.

Além disso, antes de escrever o adaptador:

5. Decidir como o CRM identifica um job como SC Saúde e roteia
6. Ensinar o CRM a regra de quantidade por mês
7. Auditar as carteirinhas de SC Saúde no CRM
