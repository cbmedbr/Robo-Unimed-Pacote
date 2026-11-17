@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem --- Python ---
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
    where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
    echo.
    echo ERRO: Python nao esta instalado neste computador.
    echo Vou abrir o site. Na instalacao MARQUE "Add Python to PATH".
    echo Depois abra o iniciar.bat de novo.
    start https://www.python.org/downloads/
    goto :erro
)

rem --- Dependencias (rapido quando ja estao instaladas; instala as novas sozinho) ---
echo Conferindo dependencias...
%PY% -m pip install -q -r requirements.txt
if errorlevel 1 (
    echo ERRO: nao consegui instalar as dependencias do robo.
    goto :erro
)

rem --- Senha (.env fica so neste PC, nunca vai pro GitHub) ---
if not exist ".env" (
    echo.
    echo ============================================================
    echo   PRIMEIRA VEZ NESTE PC - configurar a senha do portal
    echo ============================================================
    powershell -NoProfile -Command "$s=Read-Host -AsSecureString 'Senha do portal Conecta (clinica@lucianonoceti.com.br)'; $p=[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); if(-not $p){exit 1}; $t=(Get-Content -Raw '.env.exemplo') -replace '(?m)^SENHA=.*$', ('SENHA=' + $p.Replace('$','$$')); [IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), $t)"
    if errorlevel 1 (
        echo ERRO: a senha nao pode ficar vazia.
        goto :erro
    )
    echo Senha gravada no arquivo .env deste PC.
)

rem --- Planilha de pacientes ---
if not exist "pacientes.xlsx" (
    copy /y "pacientes-modelo.xlsx" "pacientes.xlsx" >nul
    echo.
    echo Criei a planilha pacientes.xlsx. Preencha os pacientes, salve,
    echo feche o Excel e abra o iniciar.bat de novo.
    start "" "pacientes.xlsx"
    goto :fim
)

echo.
%PY% robo.py
echo.
echo Terminou. O resultado esta na pasta "resultados".
goto :fim

:erro
echo.
:fim
pause
