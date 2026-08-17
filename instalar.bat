@echo off
setlocal EnableDelayedExpansion
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
echo [4/4] Configurando credenciais (.env)...
echo.

if exist "%~dp0servidor-local\.env" (
    echo O arquivo servidor-local\.env ja existe - nao vou sobrescrever.
    echo Para trocar a senha da Unimed, edite a linha UNIMED_SENHA nesse arquivo.
    goto :fim
)

echo As credenciais NAO ficam no GitHub - cada PC tem o seu .env.
echo Peca a senha do portal e a chave do Supabase ao responsavel pelo robo.
echo (Use um gerenciador de senhas, nao mande por e-mail ou WhatsApp.)
echo.

set "UNIMED_USER=300788"
set /p "UNIMED_USER=Usuario do portal Unimed [300788]: "

for /f "delims=" %%i in ('powershell -NoProfile -Command "$s=Read-Host -AsSecureString 'Senha do portal Unimed'; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set "UNIMED_PWD=%%i"

if "!UNIMED_PWD!"=="" (
    echo.
    echo ERRO: senha nao pode ficar vazia.
    pause
    exit /b 1
)

for /f "delims=" %%i in ('powershell -NoProfile -Command "$s=Read-Host -AsSecureString 'Service role key do Supabase'; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set "SUPA_KEY=%%i"

if "!SUPA_KEY!"=="" (
    echo.
    echo ERRO: service role key nao pode ficar vazia.
    pause
    exit /b 1
)

rem ROBO_CAMINHO e detectado a partir da pasta deste script
set "ROBO_DIR=%~dp0unimed-mvp-final"

(
    echo # Gerado por instalar.bat - NAO versionar este arquivo.
    echo SUPABASE_URL=https://fptpcfdyzjlemjuiyaxw.supabase.co
    echo SUPABASE_SERVICE_ROLE_KEY=!SUPA_KEY!
    echo UNIMED_USUARIO=!UNIMED_USER!
    echo UNIMED_SENHA=!UNIMED_PWD!
    echo ROBO_CAMINHO=!ROBO_DIR!
    echo ROBO_TIMEOUT_MS=180000
    echo ROBO_HEADLESS=false
    echo PORT=9876
    echo CORS_ORIGINS=https://crm-luciano-noceti.vercel.app,http://localhost:5173
) > "%~dp0servidor-local\.env"

rem O robo tambem tem .env proprio, usado quando ele roda sozinho pela linha
rem de comando. Quando o servidor o dispara, as credenciais vem do servidor.
if not exist "%~dp0unimed-mvp-final\.env" (
    (
        echo # Gerado por instalar.bat - NAO versionar este arquivo.
        echo UNIMED_USUARIO=!UNIMED_USER!
        echo UNIMED_SENHA=!UNIMED_PWD!
        echo UNIMED_URL=https://rda.unimedsc.com.br/cmagnet/Login.do
        echo HEADLESS=false
        echo SCREENSHOT_DIR=./screenshots
        echo LOG_LEVEL=info
        echo DEBUG=false
        echo NAVEGACAO_TIMEOUT=30000
        echo CLICK_TIMEOUT=10000
    ) > "%~dp0unimed-mvp-final\.env"
)

echo.
echo Credenciais gravadas em servidor-local\.env e unimed-mvp-final\.env
echo Esses arquivos estao no .gitignore e nunca vao para o GitHub.

:fim
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
