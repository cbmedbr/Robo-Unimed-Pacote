@echo off
rem Chamado pelo iniciar-servidor.bat da raiz, a cada inicio.
rem Prepara o plano Casacaresc neste PC: Python, dependencias e senha.
rem NUNCA impede o servidor de subir: se algo faltar, so avisa. Unimed e
rem SC Saude continuam funcionando normalmente.
setlocal
cd /d "%~dp0"

rem ---- Python ----------------------------------------------------------
rem Cada candidato e TESTADO de verdade. "where python" acha o atalho da
rem Microsoft Store (WindowsApps), que existe mas nao roda nada; e "py" pode
rem existir sem Python instalado. Foi o PYTHON_AUSENTE de 17/11/2026.
set "PY="
call :testar py -3
if not defined PY call :testar python
if not defined PY call :achar_python
if not defined PY call :instalar_python
if not defined PY (
    echo.
    echo AVISO: nao consegui instalar o Python neste PC. O plano Casacaresc nao vai
    echo funcionar aqui. Instale pelo site https://www.python.org/downloads/
    echo marcando "Add Python to PATH" e abra o iniciar.bat de novo.
    echo Unimed e SC Saude seguem normais.
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

rem ---- sub-rotinas -------------------------------------------------------
:testar
%* -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=%*"
exit /b 0

:achar_python
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*" "%ProgramFiles%\Python3*") do (
    if not defined PY if exist "%%~D\python.exe" call :testar "%%~D\python.exe"
)
exit /b 0

:instalar_python
echo.
echo ============================================================
echo   Instalando o Python (uma vez so neste PC, alguns minutos)
echo   Nao feche esta janela.
echo ============================================================
where winget >nul 2>&1
if not errorlevel 1 (
    winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    call :achar_python
)
if defined PY exit /b 0
echo Baixando o instalador oficial do Python...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $f=Join-Path $env:TEMP 'python-instalador.exe'; Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe' -OutFile $f -UseBasicParsing; Start-Process $f -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=1' -Wait"
call :achar_python
if defined PY echo Python instalado.
exit /b 0
