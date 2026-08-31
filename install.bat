@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0one-click-start.ps1" -InstallOnly
if errorlevel 1 pause
