# trocar-senha.ps1 — atualiza a senha do portal Unimed nos arquivos .env
#
# Uso normal: rodar o trocar-senha.bat e digitar a senha quando pedir.
#
# O parametro -Senha existe para automacao e testes. Evite usar no dia a dia:
# a senha fica gravada no historico do PowerShell.

param(
    [string]$Senha = "",
    [string]$Raiz = ""
)

$ErrorActionPreference = "Stop"

if (-not $Raiz) { $Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Atualizar-Env {
    param([string]$Caminho, [string]$NovaSenha)

    if (-not (Test-Path $Caminho)) {
        return "ausente"
    }

    $linhas = @(Get-Content -LiteralPath $Caminho)
    $achou = $false

    for ($i = 0; $i -lt $linhas.Count; $i++) {
        if ($linhas[$i] -match '^\s*UNIMED_SENHA\s*=') {
            $linhas[$i] = "UNIMED_SENHA=$NovaSenha"
            $achou = $true
        }
    }

    if (-not $achou) { $linhas += "UNIMED_SENHA=$NovaSenha" }

    # UTF-8 sem BOM: com BOM o dotenv nao reconhece a primeira variavel
    $utf8SemBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Caminho, $linhas, $utf8SemBom)

    if ($achou) { return "atualizado" } else { return "adicionado" }
}

$alvos = @(
    (Join-Path $Raiz "servidor-local\.env"),
    (Join-Path $Raiz "unimed-mvp-final\.env")
)

$existentes = @($alvos | Where-Object { Test-Path $_ })
if ($existentes.Count -eq 0) {
    Write-Host ""
    Write-Host "ERRO: nenhum arquivo .env encontrado em:" -ForegroundColor Red
    $alvos | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "Este PC ainda nao foi configurado. Rode o instalar.bat primeiro."
    exit 1
}

if (-not $Senha) {
    Write-Host ""
    Write-Host "Troca de senha do portal Unimed" -ForegroundColor Cyan
    Write-Host "A senha nao aparece na tela enquanto voce digita."
    Write-Host ""
    $segura = Read-Host -AsSecureString "Nova senha"
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

Write-Host ""
foreach ($alvo in $alvos) {
    $r = Atualizar-Env -Caminho $alvo -NovaSenha $Senha
    $nome = $alvo.Replace($Raiz, "").TrimStart("\")
    switch ($r) {
        "atualizado" { Write-Host "  OK       $nome" -ForegroundColor Green }
        "adicionado" { Write-Host "  OK       $nome (linha UNIMED_SENHA criada)" -ForegroundColor Green }
        "ausente"    { Write-Host "  IGNORADO $nome (arquivo nao existe neste PC)" -ForegroundColor DarkGray }
    }
}

Write-Host ""
Write-Host "Senha atualizada." -ForegroundColor Green
Write-Host ""
Write-Host "FALTA UM PASSO: reinicie o servidor." -ForegroundColor Yellow
Write-Host "  1. Feche a janela preta do robo (a do iniciar.bat)"
Write-Host "  2. Abra o iniciar.bat de novo"
Write-Host ""
Write-Host "Sem reiniciar, o robo continua tentando com a senha antiga."
Write-Host ""
