@echo off
chcp 65001 >nul
setlocal
set "MUSE_ASR_BACKEND=docker"
set "MUSE_WORKER_DATA_DIR=%LOCALAPPDATA%\MuseBrandWorker"
echo setup>"%MUSE_WORKER_DATA_DIR%\setup.pending"
timeout /t 3 /nobreak >nul
cd /d "%~dp0"
node worker-v2.mjs --diagnose
set "LOGIN_RESULT=%errorlevel%"
del "%MUSE_WORKER_DATA_DIR%\setup.pending" >nul 2>&1
if not "%LOGIN_RESULT%"=="0" (
  echo Khong the hoan tat dang nhap. Xem loi phia tren va chay lai tep nay.
  pause
  exit /b %LOGIN_RESULT%
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-background.ps1"
pause
