@echo off
setlocal EnableDelayedExpansion

set "RAIZ=%~dp0"

rem ---------------------------------------------------------------------
rem Troca de senha obrigatoria
rem
rem SENHA_VERSAO.txt vem do GitHub e muda quando a senha do portal e
rem trocada. .senha-versao fica so neste PC e guarda a ultima versao ja
rem aplicada aqui. Se os dois diferem, pede a senha antes de iniciar.
rem ---------------------------------------------------------------------
set "VERSAO_REPO="
set "VERSAO_LOCAL="
if exist "%RAIZ%SENHA_VERSAO.txt" set /p VERSAO_REPO=<"%RAIZ%SENHA_VERSAO.txt"
if exist "%RAIZ%.senha-versao" set /p VERSAO_LOCAL=<"%RAIZ%.senha-versao"

if not defined VERSAO_REPO goto :iniciar
if "!VERSAO_REPO!"=="!VERSAO_LOCAL!" goto :iniciar

echo.
echo ============================================================
echo   ATENCAO - A SENHA DO PORTAL UNIMED FOI TROCADA
echo ============================================================
echo.
echo Digite a senha nova para atualizar neste computador.
echo Isso e pedido uma unica vez por PC.
echo.
echo Se voce nao tem a senha, feche esta janela e peca ao
echo responsavel pelo robo.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%RAIZ%trocar-senha.ps1" -Raiz "%RAIZ%."
if errorlevel 1 (
    echo.
    echo ============================================================
    echo   A SENHA NAO FOI ATUALIZADA - o robo nao vai iniciar
    echo ============================================================
    echo.
    echo Rode o iniciar.bat de novo quando tiver a senha correta.
    echo.
    pause
    exit /b 1
)

:iniciar
echo.
echo Iniciando servidor do Robo Unimed...
cd /d "%RAIZ%servidor-local"
npm run dev
