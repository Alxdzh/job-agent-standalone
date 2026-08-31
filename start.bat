@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0one-click-start.ps1" -RunOnly
if errorlevel 1 pause
