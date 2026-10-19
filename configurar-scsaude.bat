@echo off
echo ==========================================
echo   Robo - Ligar o SC Saude neste PC
echo ==========================================
echo.
echo Use SOMENTE no computador combinado para o teste.
echo Nos demais, o SC Saude deve continuar desligado.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0configurar-scsaude.ps1" -Raiz "%~dp0."
pause
