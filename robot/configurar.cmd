@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
echo Parando un momento el robot automatico para poder abrir su Chrome...
schtasks /End /TN "Buscaflor Robot AmbarX" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*robot\perfil*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*robot.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 3 /nobreak >nul
echo.
echo Se abre AmbarX en una ventana de Chrome del robot.
echo 1) El robot entra solo y elige la empresa de Buscaflor (unos 20 segundos).
echo 2) Abajo a la derecha sale el panel de Buscaflor: inicia sesion en la app con tu email.
echo 3) Cuando el panel diga que esta conectado, cierra la ventana de Chrome.
"%~dp0node\node.exe" "%~dp0robot.js" --visible
echo.
echo Volviendo a poner en marcha el robot automatico...
schtasks /Run /TN "Buscaflor Robot AmbarX" >nul 2>&1
echo Listo. Ya puedes cerrar esta ventana.
pause
