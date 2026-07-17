@echo off
echo Atualizando codigo do robo...
cd /d "%~dp0unimed-mvp-final"
git pull origin main
cd /d "%~dp0servidor-local"
git pull origin main
echo Iniciando servidor do Robo Unimed...
npm run dev
