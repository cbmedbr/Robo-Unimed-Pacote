@echo off
rem Chamado pelo iniciar-servidor.bat da raiz, a cada inicio.
rem Prepara o plano Casacaresc neste PC (Python, dependencias, senha).
rem NUNCA impede o servidor de subir: se algo faltar, so avisa. O robo Unimed
rem e o SC Saude continuam funcionando normalmente.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
    where python >nul 2>&1 && set "PY=python"
)
rem Python instalado so para o usuario nem sempre esta no PATH desta janela.
if not defined PY call :achar_python
if not defined PY (
    where winget >nul 2>&1
    if not errorlevel 1 (
        echo.
        echo Instalando o Python para o plano Casacaresc. Uma vez so neste PC,
        echo pode levar alguns minutos. Nao feche a janela.
        winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements >nul 2>&1
        call :achar_python
    )
)
if not defined PY (
    echo.
    echo AVISO: nao consegui instalar o Python neste PC. O plano Casacaresc nao vai
    echo funcionar aqui ate instalar ^(https://www.python.org/downloads/ , marcar
    echo "Add Python to PATH"^). Unimed e SC Saude seguem normais.
    exit /b 0
)

rem Caminho exato do Python, para o servidor chamar o robo sem depender do PATH.
%PY% -c "import sys;print(sys.executable)" > ".python-path" 2>nul

echo Conferindo plano Casacaresc...
%PY% -m pip install -q --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo AVISO: nao consegui preparar o plano Casacaresc. Unimed e SC Saude seguem normais.
)

if exist ".env" exit /b 0

echo.
echo ============================================================
echo   PLANO CASACARESC - configurar a senha neste PC (uma vez so)
echo ============================================================
echo Senha do portal Conecta (clinica@lucianonoceti.com.br).
echo Se nao tiver a senha agora, so aperte ENTER para pular.
echo.
powershell -NoProfile -Command "$s=Read-Host -AsSecureString 'Senha do portal Casacaresc'; $p=[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); if(-not $p){exit 1}; $t=(Get-Content -Raw '.env.exemplo') -replace '(?m)^SENHA=.*$', ('SENHA=' + $p.Replace('$','$$')); [IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), $t)"
if errorlevel 1 (
    echo Pulei. Na proxima vez que abrir o iniciar.bat eu pergunto de novo.
) else (
    echo Senha do Casacaresc gravada neste PC.
)
exit /b 0

:achar_python
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if exist "%%D\python.exe" set "PY="%%D\python.exe""
)
if not defined PY (
    for /d %%D in ("%ProgramFiles%\Python3*") do (
        if exist "%%D\python.exe" set "PY="%%D\python.exe""
    )
)
exit /b 0
