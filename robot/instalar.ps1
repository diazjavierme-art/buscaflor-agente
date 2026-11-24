# Buscaflor - Instalar el robot de AmbarX (ejecutar UNA vez, como administrador)
# 1) Descarga Node.js portable y la librería para manejar Chrome.
# 2) Te pide el usuario y la contraseña de AmbarX que usará el robot (se guardan solo en este ordenador, en config.json, visible solo para administradores).
# 3) Crea la tarea de Windows "Buscaflor Robot AmbarX" que lo arranca al encender el ordenador (sin iniciar sesión) y lo relanza si se para.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
function Paso($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Hay que ejecutarlo como administrador: clic derecho en instalar.cmd > Ejecutar como administrador." -ForegroundColor Red; Read-Host "Enter para salir"; exit 1 }
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Paso "Buscando Chrome"
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LocalAppData\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chrome) { throw "No encuentro Chrome instalado." }
  Write-Host $chrome

  Paso "Descargando Node.js (portable, no se instala en Windows)"
  $nodeDir = Join-Path $dir 'node'
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    $zip = Join-Path $env:TEMP 'node-bf.zip'
    Invoke-WebRequest 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip' -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP 'node-bf'; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip $tmp -Force
    Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $nodeDir
    Remove-Item $zip -Force
  }
  $node = Join-Path $nodeDir 'node.exe'
  & $node --version

  Paso "Instalando la librería para manejar Chrome (puppeteer-core)"
  Push-Location $dir; & (Join-Path $nodeDir 'npm.cmd') install --no-audit --no-fund --omit=dev; Pop-Location
  if (-not (Test-Path (Join-Path $dir 'node_modules\puppeteer-core'))) { throw "No se instaló puppeteer-core" }

  Paso "Usuario de AmbarX para el robot"
  Write-Host "Recomendado: un usuario propio en AmbarX (por ejemplo 'robot') para no cerrar la sesión de nadie."
  $u = Read-Host "Usuario de AmbarX"
  $p = Read-Host "Contraseña de AmbarX" -AsSecureString
  $c = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p))
  $cfg = [ordered]@{ ambarxUrl = 'http://localhost:9070/AmbarX/'; usuario = $u; clave = $c; chrome = $chrome; perfil = (Join-Path $dir 'perfil'); visible = $false }
  $cfgPath = Join-Path $dir 'config.json'
  ($cfg | ConvertTo-Json) | Out-File -Encoding utf8 $cfgPath
  icacls $cfgPath /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" "$($env:USERNAME):R" | Out-Null   # solo SYSTEM y Administradores
  New-Item -ItemType Directory -Force (Join-Path $dir 'perfil') | Out-Null

  Paso "Creando la tarea de Windows 'Buscaflor Robot AmbarX'"
  $accion = New-ScheduledTaskAction -Execute $node -Argument "`"$(Join-Path $dir 'robot.js')`"" -WorkingDirectory $dir
  $t1 = New-ScheduledTaskTrigger -AtStartup
  $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $quien = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $ajustes = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName 'Buscaflor Robot AmbarX' -Action $accion -Trigger @($t1, $t2) -Principal $quien -Settings $ajustes -Force | Out-Null
  Disable-ScheduledTask -TaskName 'Buscaflor Robot AmbarX' | Out-Null
  Write-Host "Tarea creada (de momento parada)."

  Write-Host "`nINSTALADO. Ahora haz doble clic en configurar.cmd para iniciar sesión en la app (Firebase) una sola vez." -ForegroundColor Green
  "OK $(Get-Date -Format s)" | Out-File -Encoding utf8 (Join-Path $dir 'instalar_resultado.txt')
} catch {
  Write-Host "`nError: $($_.Exception.Message)" -ForegroundColor Red
  "ERROR $(Get-Date -Format s): $($_.Exception.Message)" | Out-File -Encoding utf8 (Join-Path $dir 'instalar_resultado.txt')
}
Read-Host "`nPulsa Enter para salir"
