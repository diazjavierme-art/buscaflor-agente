@echo off
echo Se abre AmbarX en una ventana de Chrome del robot.
echo 1) Si pide usuario, el robot entra solo (espera 30 segundos).
echo 2) Abajo a la derecha sale el panel de Buscaflor: inicia sesion en la app con tu email.
echo 3) Cuando el panel diga que esta conectado, cierra la ventana de Chrome.
"%~dp0node\node.exe" "%~dp0robot.js" --visible
pause
