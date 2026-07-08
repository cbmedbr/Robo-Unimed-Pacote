@echo off
REM ============================================================================
REM Robo Unimed - Inicia servidor local
REM Coloque um atalho deste arquivo na area de trabalho da recepcionista.
REM ============================================================================

title Robo Unimed - Servidor Local

REM Vai pra pasta do servidor (mesmo lugar deste .bat)
cd /d "%~dp0"

REM Verifica se Node.js esta instalado
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERRO] Node.js nao encontrado.
  echo Instale em: https://nodejs.org/  (versao 20 ou superior)
  echo.
  pause
  exit /b 1
)

REM Verifica se as dependencias estao instaladas
if not exist "node_modules\" (
  echo Instalando dependencias pela primeira vez...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao instalar dependencias.
    echo Verifique sua conexao e rode "npm install" manualmente.
    pause
    exit /b 1
  )
)

REM Verifica se .env existe
if not exist ".env" (
  echo.
  echo [ERRO] Arquivo .env nao encontrado.
  echo Copie .env.example para .env e preencha as credenciais.
  echo.
  pause
  exit /b 1
)

REM Inicia o servidor
echo.
echo Iniciando servidor... (NAO FECHE esta janela)
echo.
call npm run start:dev

REM Se cair aqui, o servidor parou
echo.
echo Servidor parou. Pressione qualquer tecla pra fechar.
pause >nul
