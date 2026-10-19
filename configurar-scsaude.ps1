# configurar-scsaude.ps1 — liga o SC Saude NESTE computador
#
# Uso normal: rodar o configurar-scsaude.bat e digitar as credenciais.
#
# Existe porque o robo de SC Saude fica desligado por padrao: o codigo chega
# em todas as maquinas pelo git pull, mas so opera onde este script rodou.
#
# E existe tambem para ninguem precisar editar o .env no Bloco de Notas, que
# ja nos custou dois incidentes: um BOM invisivel que o dotenv nao le, e a
# senha truncada no "#" por falta de aspas.

param(
    [string]$Usuario = "",
    [string]$Senha = "",
    [string]$Raiz = "",
    [switch]$Desligar
)

$ErrorActionPreference = "Stop"

if (-not $Raiz) { $Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Raiz = (Resolve-Path -LiteralPath $Raiz).Path

# ---------------------------------------------------------------------------

function Definir-Variavel {
    param([string[]]$Linhas, [string]$Nome, [string]$Valor)

    $achou = $false
    for ($i = 0; $i -lt $Linhas.Count; $i++) {
        if ($Linhas[$i] -match "^\s*$Nome\s*=") {
            $Linhas[$i] = "$Nome=$Valor"
            $achou = $true
        }
    }
    if (-not $achou) { $Linhas += "$Nome=$Valor" }
    return , $Linhas
}

function Gravar-Env {
    param([string]$Caminho, [string]$Usuario, [string]$Senha, [bool]$Ligar)

    if (-not (Test-Path $Caminho)) { return "ausente" }

    $linhas = @(Get-Content -LiteralPath $Caminho)

    $linhas = Definir-Variavel -Linhas $linhas -Nome "SCSAUDE_HABILITADO" -Valor $(if ($Ligar) { "true" } else { "false" })

    if ($Ligar) {
        $linhas = Definir-Variavel -Linhas $linhas -Nome "SCSAUDE_USUARIO" -Valor $Usuario
        # ASPAS OBRIGATORIAS: a senha do SC Saude contem "#", e o dotenv trata
        # isso como inicio de comentario. Sem aspas o valor chega truncado e o
        # portal responde apenas "usuario e/ou senha invalidos", sem nada
        # apontando para este arquivo. Custou duas rodadas para descobrir.
        $linhas = Definir-Variavel -Linhas $linhas -Nome "SCSAUDE_SENHA" -Valor ('"' + $Senha + '"')
    }

    # UTF-8 SEM BOM: com BOM o dotenv nao reconhece a primeira variavel do
    # arquivo. E o que o Bloco de Notas grava por padrao.
    $utf8SemBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Caminho, $linhas, $utf8SemBom)

    return "ok"
}

# ---------------------------------------------------------------------------

$alvos = @(
    (Join-Path $Raiz "servidor-local\.env"),
    (Join-Path $Raiz "unimed-mvp-final\.env")
)

$existentes = @($alvos | Where-Object { Test-Path $_ })
if ($existentes.Count -eq 0) {
    Write-Host ""
    Write-Host "ERRO: nenhum arquivo .env encontrado neste PC." -ForegroundColor Red
    Write-Host "Rode o instalar.bat primeiro."
    Write-Host ""
    exit 1
}

if ($Desligar) {
    foreach ($alvo in $alvos) {
        $r = Gravar-Env -Caminho $alvo -Usuario "" -Senha "" -Ligar $false
        $nome = $alvo.Replace($Raiz, "").TrimStart("\")
        if ($r -eq "ok") { Write-Host "  OK  $nome" -ForegroundColor Green }
    }
    Write-Host ""
    Write-Host "SC Saude DESLIGADO neste computador." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "O usuario e a senha continuam guardados, so que inativos — assim"
    Write-Host "da para religar sem digitar tudo de novo. Quem bloqueia e a linha"
    Write-Host "SCSAUDE_HABILITADO=false."
    Write-Host ""
    Write-Host "Reinicie o servidor para valer: feche a janela preta e abra o iniciar.bat."
    Write-Host ""
    exit 0
}

if (-not $Usuario) {
    Write-Host ""
    Write-Host "Ligar o SC Saude neste computador" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "O robo de SC Saude esta em teste. Depois disto, ESTE computador"
    Write-Host "passa a aceitar pedidos de autorizacao do SC Saude."
    Write-Host ""
    $Usuario = Read-Host "Usuario do portal SC Saude"
}

if (-not $Usuario) {
    Write-Host "ERRO: usuario vazio. Nada foi alterado." -ForegroundColor Red
    exit 1
}

if (-not $Senha) {
    Write-Host "A senha nao aparece na tela enquanto voce digita."
    $segura = Read-Host -AsSecureString "Senha do portal SC Saude"
    $Senha = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura)
    )

    $seguraConf = Read-Host -AsSecureString "Digite de novo para conferir"
    $confirma = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguraConf)
    )

    if ($Senha -ne $confirma) {
        Write-Host ""
        Write-Host "ERRO: as duas senhas nao sao iguais. Nada foi alterado." -ForegroundColor Red
        exit 1
    }
}

if (-not $Senha) {
    Write-Host "ERRO: senha vazia. Nada foi alterado." -ForegroundColor Red
    exit 1
}

# A senha nao pode ter aspas duplas: elas quebrariam o proprio par de aspas
# que protege o "#".
if ($Senha.Contains('"')) {
    Write-Host ""
    Write-Host "ERRO: a senha tem aspas duplas, e isso quebra o arquivo de configuracao." -ForegroundColor Red
    Write-Host "Fale com o responsavel pelo robo antes de continuar."
    Write-Host ""
    exit 1
}

Write-Host ""
foreach ($alvo in $alvos) {
    $r = Gravar-Env -Caminho $alvo -Usuario $Usuario -Senha $Senha -Ligar $true
    $nome = $alvo.Replace($Raiz, "").TrimStart("\")
    switch ($r) {
        "ok"      { Write-Host "  OK       $nome" -ForegroundColor Green }
        "ausente" { Write-Host "  IGNORADO $nome (nao existe neste PC)" -ForegroundColor DarkGray }
    }
}

Write-Host ""
Write-Host "SC Saude LIGADO neste computador." -ForegroundColor Green
Write-Host ""
Write-Host "FALTA UM PASSO: reinicie o servidor." -ForegroundColor Yellow
Write-Host "  1. Feche a janela preta do robo (a do iniciar.bat)"
Write-Host "  2. Abra o iniciar.bat de novo"
Write-Host ""
Write-Host "Nos outros computadores nada muda: eles continuam recusando"
Write-Host "pedido de SC Saude, com uma mensagem explicando."
Write-Host ""
