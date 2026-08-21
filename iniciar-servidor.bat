@echo off
setlocal EnableDelayedExpansion

set "RAIZ=%~dp0"

rem ---------------------------------------------------------------------
rem Pre-checagem do ambiente
rem
rem Sem isto, uma dependencia faltando aparecia como um stack trace de
rem MODULE_NOT_FOUND (ou a janela fechando sozinha), sem indicar o que fazer.
rem ---------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERRO: Node.js nao esta instalado neste computador.
    echo Baixe em https://nodejs.org e instale, depois rode o instalar.bat.
    goto :erro
)

rem Checar o ARQUIVO que o servidor realmente carrega, nao so a pasta:
rem uma pasta node_modules pode existir e estar oca (foi o que aconteceu ao
rem copiar de dentro do OneDrive, que deixa arquivos como atalho de nuvem).
if not exist "%RAIZ%servidor-local\node_modules\tsx\dist\cli.mjs" (
    echo.
    echo ERRO: as dependencias do SERVIDOR estao faltando ou incompletas.
    echo.
    echo Feche esta janela e rode, nesta pasta:
    echo   Remove-Item servidor-local\node_modules -Recurse -Force
    echo   instalar.bat
    goto :erro
)

if not exist "%RAIZ%unimed-mvp-final\node_modules\playwright\index.js" (
    echo.
    echo ERRO: as dependencias do ROBO estao faltando ou incompletas.
    echo O servidor ate abre, mas o robo falha na hora de executar a guia.
    echo.
    echo Feche esta janela e rode, nesta pasta:
    echo   Remove-Item unimed-mvp-final\node_modules -Recurse -Force
    echo   instalar.bat
    goto :erro
)

rem Restos de OneDrive dentro do .git quebram o git pull com
rem "fatal: bad object refs/desktop.ini" — a maquina para de receber
rem atualizacoes em silencio. Limpar e barato, entao limpa sozinho.
if exist "%RAIZ%.git" (
    del /s /q "%RAIZ%.git\desktop.ini" >nul 2>&1
)

if not exist "%RAIZ%servidor-local\.env" (
    echo.
    echo ERRO: o arquivo servidor-local\.env nao existe.
    echo Feche esta janela e rode o instalar.bat para configurar as credenciais.
    goto :erro
)

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

rem Se chegou aqui, o servidor PAROU. Nunca deixar a janela fechar sozinha:
rem sem isto, qualquer falha na largada some da tela antes de ser lida.
echo.
echo ============================================================
echo   O SERVIDOR PAROU
echo ============================================================
echo.
echo Se voce nao fechou de proposito, a mensagem de erro esta
echo logo acima. Tire um print dela e mande para o responsavel.
echo.

:erro
echo.
pause
