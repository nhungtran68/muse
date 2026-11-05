@echo off
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
if errorlevel 1 (pause & exit /b 1)
if not exist "%LOCALAPPDATA%\MuseBrandWorker\auth\*.dpapi" (
  call "%LOCALAPPDATA%\MuseBrandWorker\app\worker\03-DANG-NHAP.cmd"
) else (
  call "%LOCALAPPDATA%\MuseBrandWorker\app\worker\02-CHAY-WORKER.cmd"
)
