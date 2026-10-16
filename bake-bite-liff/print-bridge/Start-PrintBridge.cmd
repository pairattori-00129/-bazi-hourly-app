@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -STA -File "%~dp0BakeBite-PrintBridge.ps1"
pause
