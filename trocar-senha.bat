@echo off
echo ==========================================
echo   Robo Unimed - Trocar senha do portal
echo ==========================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0trocar-senha.ps1" -Raiz "%~dp0."
pause
