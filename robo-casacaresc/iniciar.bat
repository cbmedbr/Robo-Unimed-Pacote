@echo off
rem Arquivo propositalmente MINIMO (mesmo motivo do iniciar.bat da raiz):
rem se o git pull reescrever este arquivo no meio da execucao, o cmd le lixo.
rem Toda a logica fica em rodar-robo.bat, aberto so depois do pull.
cd /d "%~dp0.."
echo Atualizando todos os robos...
git pull origin main
call "%~dp0rodar-robo.bat"
