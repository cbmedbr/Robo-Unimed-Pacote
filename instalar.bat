@echo off
echo ==========================================
echo   Robo Unimed - Instalacao
echo   Autorizacao + Execucao de Guias
echo ==========================================
echo.

echo [1/4] Instalando dependencias do robo...
cd /d "%~dp0unimed-mvp-final"
call npm install
if errorlevel 1 (
    echo ERRO: Falha ao instalar dependencias do robo
    pause
    exit /b 1
)

echo.
echo [2/4] Instalando Playwright (Chrome)...
call npx playwright install chromium
if errorlevel 1 (
    echo AVISO: Playwright pode precisar ser instalado manualmente
)

echo.
echo [3/4] Instalando dependencias do servidor local...
cd /d "%~dp0servidor-local"
call npm install
if errorlevel 1 (
    echo ERRO: Falha ao instalar dependencias do servidor
    pause
    exit /b 1
)

echo.
echo [4/4] Verificando .env...
if not exist ".env" (
    echo AVISO: Arquivo .env nao encontrado no servidor-local!
    echo Copie o .env do PC atual ou crie um com:
    echo   SUPABASE_URL=https://fptpcfdyzjlemjuiyaxw.supabase.co
    echo   SUPABASE_SERVICE_KEY=sua_chave_aqui
    echo   UNIMED_USUARIO=300788
    echo   UNIMED_SENHA=sua_senha_aqui
    echo   PORT=9876
    echo   ROBO_CAMINHO=C:\Robo-Unimed\unimed-mvp-final
)

echo.
echo ==========================================
echo   Instalacao concluida!
echo.
echo   Para iniciar o servidor:
echo     cd servidor-local
echo     npm run dev
echo.
echo   O servidor roda em http://localhost:9876
echo   O CRM chama esse endereco automaticamente.
echo ==========================================
pause
