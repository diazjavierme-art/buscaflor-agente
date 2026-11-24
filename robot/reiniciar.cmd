@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
echo Reiniciando el robot de Buscaflor...
schtasks /End /TN "Buscaflor Robot AmbarX" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*robot\perfil*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*robot.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 3 /nobreak >nul
schtasks /Change /TN "Buscaflor Robot AmbarX" /ENABLE >nul 2>&1
schtasks /Run /TN "Buscaflor Robot AmbarX" >nul 2>&1
echo Listo: el robot vuelve a estar en marcha. Ya puedes cerrar esta ventana.
pause
