@echo off
chcp 65001 >nul
set "MUSE_INSTALLED=%LOCALAPPDATA%\MuseBrandWorker\app\worker"
if exist "%MUSE_INSTALLED%\supervisor.mjs" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%MUSE_INSTALLED%\start-background.ps1"
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" -Start
  if errorlevel 1 pause
)
