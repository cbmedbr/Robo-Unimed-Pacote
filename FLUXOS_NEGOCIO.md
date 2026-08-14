# Fluxos de Negócio — Robô Unimed (SOP oficial)

> **Fonte da verdade do processo.** Este documento descreve *o que* o robô precisa fazer no portal
> da Unimed, do ponto de vista da operação. O `DOCUMENTACAO_ROBO.md` descreve *como* isso está
> implementado (seletores, arquivos, códigos de erro).
>
> **REGRA:** a sequência de passos aqui descrita não pode ser alterada por refatoração, "melhoria"
> ou otimização. Qualquer mudança na ordem, nos cliques ou nas datas usadas precisa de confirmação
> explícita da operação antes de ir para o código. Se uma alteração no código conflitar com este
> documento, o documento vence — pare e pergunte.

**Credenciais:** usuário e senha do portal ficam em `servidor-local/.env` e `unimed-mvp-final/.env`
(`UNIMED_USUARIO` / `UNIMED_SENHA`). Nunca escreva a senha neste ou em qualquer outro arquivo versionado.

---

## 0. Invariantes — regras que nunca podem ser quebradas

1. **Na execução de sessão, sempre "Finalizar parcial" + "Confirmar a sessão".**
   Nunca clicar em **"Gravar e finalizar"** (`#Button_Submit`). O botão correto é `#Button_Parcial`.
2. **A data registrada é sempre a data exata em que a sessão foi realizada** — nunca a data de hoje,
   nunca a data em que o robô rodou. Vale para os dois fluxos de execução.
3. **Paciente intercâmbio não apresenta token.** A execução é feita direto pelo campo de data da série.
4. **Paciente local apresenta token (QR Code)** antes de informar a data da sessão.
5. **Filtro de busca da guia:** o campo *Data de atendimento* é sempre **apagado** (fica em branco) e a
   busca é feita **pelo nome do beneficiário**.
6. **Toda guia é:** Tipo de atendimento = *Outras terapias*; Regime de atendimento = *Ambulatorial*.
7. **Profissional executante é sempre o psicólogo que realmente atendeu**, conforme o agendamento no CRM.
   Não existe fallback para outro profissional — se o psicólogo não vier informado, o robô deve falhar.
8. **Prestador/contratado é sempre a Clínica Luciano Noceti**, código na operadora `300788`.

---

## 1. Execução de guia — paciente LOCAL (com token)

1. Acessar o portal da Unimed e fazer **login**.
2. Menu principal → **Exames** → **Exames em aberto**.
3. Campo **Data de atendimento**: apagar a data, deixar em branco.
4. Campo **Nome do beneficiário**: digitar o nome do paciente.
5. Clicar na **guia autorizada** correspondente ao paciente.
6. Conferir as informações da guia:
   - Tipo de atendimento: **Outras terapias**
   - Regime de atendimento: **Ambulatorial**
7. Clicar em **Adicionar execução cartão**.
8. Na janela que abrir, clicar em **Clique aqui**.
9. A câmera é aberta para **validação do token de atendimento** (QR Code apresentado pelo paciente).
10. Após a validação, o sistema abre o calendário → **selecionar a data correta da sessão realizada**.
11. Clicar **somente** em **Finalizar parcial**.
12. Na janela seguinte, clicar em **Confirmar a sessão**.

> ⚠️ **Atenção:** nunca clicar em "Gravar e finalizar". O procedimento correto é *Finalizar parcial* →
> *Confirmar a sessão*. E sempre usar a data exata em que a sessão foi realizada.

---

## 2. Execução de guia — paciente INTERCÂMBIO (sem token)

1. Acessar o portal e fazer **login**.
2. Menu principal → **Exames** → **Exames em aberto**.
3. Campo **Data de atendimento**: apagar a data, deixar em branco.
4. Campo **Nome do beneficiário**: digitar o nome do paciente.
5. Clicar na **guia autorizada** correspondente ao paciente.
   - Tipo de atendimento: **Outras terapias** → em intercâmbio este campo vem em branco
     ("Selecione") e é **obrigatório**: precisa ser selecionado como *03 - Outras Terapias*, senão o
     portal recusa a execução.
   - Regime de atendimento: **Ambulatorial**

> **Importante:** para pacientes intercâmbio **não é necessária a apresentação do token** para
> executar a guia.

6. No campo **Data e Assinatura de Procedimentos em Série**, clicar no ícone de calendário ao lado do
   campo de data.
7. Selecionar a **data em que a sessão foi realizada**.
8. Clicar em **Finalizar parcial** para concluir a execução da sessão.

---

## 3. Solicitação de autorização para data retroativa

### 3.1 Acesso e abertura
1. Acessar o portal da Unimed e fazer **login**.
2. Menu principal → **Exames** → **Exames em aberto** → **Novo exame**.

### 3.2 Identificação do beneficiário
3. Clicar em **"Se tiver problemas com o cartão"**.
4. Selecionar a opção conforme o tipo de carteirinha:
   - **Beneficiário local sem cartão ou cartão não lê** → carteirinhas locais
   - **Beneficiário de intercâmbio sem cartão** → carteirinhas de intercâmbio
5. Preencher o número da carteirinha.
   **Importante:** para carteirinhas **locais**, *não informar o último dígito*.
6. Clicar em **Localizar**.

### 3.3 Digitação da guia SADT
7. Clicar em **Digitar guia SADT**.
8. Selecionar **Digitar solicitação manualmente e realizar validação para autorizar**.

### 3.4 Dados iniciais
9. **Data de emissão:** alterar para a data retroativa, quando necessário.
10. **Atendimento a RN:** Não.
11. **E-mail:** `atendimento@lucianonoceti.com.br`
12. **Telefone:** número cadastrado do paciente.

### 3.5 Dados do solicitante
13. **Nome do contratado:** clicar na lupa → **Código na operadora: 300788** → **Localizar** →
    selecionar **Clínica Luciano Noceti – código 300788**.
14. **Nome do profissional solicitante:** clicar na lupa → no campo **Número do Conselho**, informar o
    CRM do médico solicitante → selecionar o médico observando a **UF indicada no pedido médico**.
15. Caso o médico **não seja localizado**:
    - Conselho profissional: **CRM – Conselho Regional de Medicina**
    - Digitar novamente o número do CRM
    - Marcar **Prestador externo**
    - Clicar em **Localizar**
    - Selecionar o médico correto conforme a UF do pedido médico

### 3.6 Demais campos
16. **Data da solicitação:** alterar para a data retroativa, quando necessário.
17. **Caráter de atendimento:** Eletivo.
18. **Tipo de atendimento:** Outras terapias.
19. **Indicação de acidente:** Não acidente.

### 3.7 Procedimentos solicitados
20. Informar o **código do procedimento** conforme o pedido médico.
21. Solicitar **5 sessões por autorização**.

### 3.8 Dados do contratado executante
22. **Data do atendimento:** alterar para a data retroativa correspondente ao atendimento.
23. **Nome do profissional executante:** selecionar o **psicólogo que efetivamente realizou o
    atendimento**, conforme o agendamento do paciente no CRM.

### 3.9 Anexar documentos
24. Clicar no ícone de **Anexo** → **Escolher arquivo** → anexar o **pedido médico** → **Anexar**.
25. Após a confirmação do anexo, clicar em **Finalizar**.

### 3.10 Geração da guia
26. Após finalizar a solicitação, clicar em **Gerar guia** para concluir a autorização retroativa.

---

## 4. Mapeamento SOP → código

| Passo do SOP | Implementação |
|---|---|
| Login | `unimed-mvp-final/src/login.ts` → `fazerLogin()` |
| Exames → Exames em aberto, limpar data, filtrar por nome, abrir guia | `src/execucao/buscar_e_abrir_guia.ts` |
| Conferir regime ambulatorial / sessões disponíveis | `src/execucao/preparar_execucao.ts` |
| Adicionar execução cartão / detectar fluxo série | `src/execucao/abrir_popup_cartao.ts` |
| "Clique aqui" + validação do token (QR Code) | `src/execucao/aguardar_qrcode.ts` |
| Selecionar a data da sessão (`dt_serie_N`) | `src/executar_sessao.ts` → `preencherDataSerie()` |
| Finalizar parcial + Confirmar (fluxo com token) | `src/execucao/finalizar.ts` → `finalizarParcial()` |
| Finalizar parcial + Confirmar (fluxo série/intercâmbio) | `src/executar_sessao.ts` (bloco `resultado.serie`) |
| Novo exame → beneficiário local/intercâmbio → guia SADT | `src/beneficiario.ts` |
| Datas, RN, contratado 300788, caráter, tipo de atendimento, acidente | `src/autorizacao.ts` → `preencherCamposBasicos()` |
| Médico solicitante (cooperado / prestador externo / cadastro) | `src/medico.ts` |
| Código do procedimento + quantidade de sessões | `src/procedimento.ts` |
| Anexo do pedido médico | `src/anexo.ts` |
| Data do atendimento + profissional executante + Finalizar/Gerar guia | `src/finalizar.ts` |

---

## 5. Pontos em que o robô se afasta da letra do SOP — todos confirmados

Nos quatro pontos abaixo a implementação difere do passo a passo manual descrito acima. **Todos foram
revisados e confirmados pela operação em 12/08/2026: o comportamento atual está correto e deve ser
mantido.** Não são bugs nem dívida técnica — não "corrija" nenhum deles sem uma nova decisão explícita.

1. **Critério token vs. sem token.** O SOP separa por tipo de paciente (local = com token, intercâmbio =
   sem token). O robô decide pela detecção do campo oculto `is_serie_1` no portal
   (`execucao/abrir_popup_cartao.ts`). O resultado prático é o mesmo, e é isso que importa — manter.
   Se um dia o SGU mudar esse campo oculto, o fluxo série deixa de ser detectado; é o único risco a
   vigiar aqui.
2. **Significado de "retroativa".** Retroativo é exatamente **forçar a data para o dia 1º do mês**, na
   renovação mensal (`autorizacao.ts`, `finalizar.ts` → `ehRetroativo`). É esse o comportamento
   desejado — não existe nem é preciso existir entrada para uma data retroativa arbitrária.
3. **Quantidade de sessões.** O SOP fixa 5 sessões por autorização; o robô aceita de 1 a 60 conforme o
   que vier do CRM (`validacao.ts`). **Manter como está** — a quantidade é decidida no CRM, sem trava
   em 5 no robô.
4. **E-mail e telefone.** O SOP manda preencher e-mail `atendimento@lucianonoceti.com.br` e o telefone
   do paciente. O robô **deixa o celular em branco** e só preenche e-mail se for um e-mail real do
   paciente, porque o portal rejeita a guia quando telefone/e-mail são do prestador
   (`autorizacao.ts`, `preencherCamposBasicos`). **Manter** — é assim que funciona.
