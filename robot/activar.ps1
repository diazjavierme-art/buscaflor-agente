# Buscaflor - Activar el robot (como administrador), después de configurar.cmd
$dir = $PSScriptRoot
Enable-ScheduledTask -TaskName 'Buscaflor Robot AmbarX' | Out-Null
Start-ScheduledTask -TaskName 'Buscaflor Robot AmbarX'
Start-Sleep 5
Get-ScheduledTask -TaskName 'Buscaflor Robot AmbarX' | Select-Object TaskName, State | Format-Table
Write-Host "Robot activado. Arranca solo con el ordenador. Registro en robot.log" -ForegroundColor Green
"ACTIVADO $(Get-Date -Format s)" | Out-File -Encoding utf8 (Join-Path $dir 'activar_resultado.txt')
Read-Host "Pulsa Enter para salir"
