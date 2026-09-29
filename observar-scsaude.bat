@echo off
setlocal

rem ---------------------------------------------------------------------
rem Observador do portal SC Saude - FERRAMENTA DE DIAGNOSTICO.
rem
rem NAO faz parte do robo e NAO e chamado por nada. Fica parado no disco
rem ate alguem clicar nele de proposito. Se voce nao foi orientado a
rem rodar isto, pode ignorar este arquivo.
rem
rem Ele abre um Chrome no portal do SC Saude e so observa: nao clica,
rem nao preenche e nao envia nada. Quem conduz e a pessoa.
rem ---------------------------------------------------------------------

set "RAIZ=%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERRO: Node.js nao esta instalado neste computador.
    goto :fim
)

if not exist "%RAIZ%unimed-mvp-final\node_modules\playwright\index.js" (
    echo.
    echo ERRO: as dependencias do robo estao faltando.
    echo Feche esta janela e rode o instalar.bat nesta pasta.
    goto :fim
)

cd /d "%RAIZ%unimed-mvp-final"
npx ts-node -T observar-scsaude.ts

echo.
echo ============================================================
echo   OBSERVACAO ENCERRADA
echo ============================================================
echo.
echo O resultado esta na subpasta mais recente de:
echo   %RAIZ%unimed-mvp-final\recon-scsaude-manual
echo.
echo Compacte essa subpasta (botao direito ^> Enviar para ^> Pasta
echo compactada) e mande para o responsavel pelo robo.
echo.
echo Ela tem dado de paciente: mande so para ele, por um canal
echo interno. Nao publique em lugar nenhum.
echo.

:fim
pause
