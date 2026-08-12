# Robô Unimed — instruções para o agente

## Leitura obrigatória antes de alterar qualquer código do robô

1. **`FLUXOS_NEGOCIO.md`** — o SOP da operação: a sequência exata de passos que o robô executa no
   portal. É a fonte da verdade do processo. **A sequência descrita ali não pode ser alterada por
   refatoração ou otimização.** Se uma mudança de código conflitar com o SOP, pare e pergunte.
2. **`DOCUMENTACAO_ROBO.md`** — como o processo está implementado (arquitetura, seletores, códigos de
   erro). Toda alteração no robô deve atualizar este documento.
3. **`CHANGELOG_ROBO.md`** — registro cronológico das mudanças.

## Invariantes do processo (resumo — detalhes no `FLUXOS_NEGOCIO.md`)

- Execução de sessão: sempre **Finalizar parcial** (`#Button_Parcial`) + **Confirmar**. Nunca
  "Gravar e finalizar" (`#Button_Submit`).
- A data gravada é sempre a data em que a sessão foi realizada — nunca a data de hoje.
- Paciente intercâmbio não apresenta token; paciente local apresenta QR Code antes da data.
- Busca da guia: campo *Data de atendimento* em branco, filtro pelo nome do beneficiário.
- Toda guia: tipo de atendimento *Outras terapias*, regime *Ambulatorial*.
- Profissional executante é o psicólogo que realmente atendeu — sem fallback.

## Estrutura

- `servidor-local/` — servidor HTTP (Express, porta 9876) que recebe chamadas do CRM, cria jobs no
  Supabase e spawna o robô como subprocesso.
- `unimed-mvp-final/` — robô Playwright que automatiza o portal SGU-Card da Unimed.
- O CRM (`CRM-ClinicaLN`) fica em outro repositório e consome este servidor via HTTP.

## Credenciais

Ficam em `servidor-local/.env` e `unimed-mvp-final/.env` (`UNIMED_USUARIO`, `UNIMED_SENHA`), fora do
controle de versão. Nunca escreva senhas em arquivos versionados, documentação ou mensagens de commit.
