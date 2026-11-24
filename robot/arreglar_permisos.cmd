@echo off
echo Dando permiso de lectura de config.json a tu usuario y al robot...
icacls "%~dp0config.json" /grant "%USERNAME%":R
icacls "%~dp0perfil" /grant "*S-1-5-18:(OI)(CI)F" /T /Q
echo.
echo Hecho. Ahora haz doble clic en configurar.cmd
pause
