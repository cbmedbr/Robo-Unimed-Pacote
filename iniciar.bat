@echo off
rem Este arquivo e proposital e permanentemente MINIMO.
rem
rem O cmd.exe le o .bat linha a linha enquanto executa, guardando a posicao
rem em bytes. Se o "git pull" abaixo reescrever ESTE arquivo, o cmd continua
rem lendo o arquivo novo a partir da posicao antiga e executa lixo.
rem
rem Por isso toda a logica fica em iniciar-servidor.bat, que so e aberto
rem depois que o pull terminou. Evite adicionar linhas aqui.
cd /d "%~dp0"
echo Atualizando codigo do robo...
git pull origin main
call "%~dp0iniciar-servidor.bat"
