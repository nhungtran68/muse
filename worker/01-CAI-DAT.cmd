@echo off
setlocal
cd /d "%~dp0"
if not exist package.json (
  echo Khong tim thay package.json. Hay giai nen file ZIP truoc khi chay cai dat.
  goto :end
)
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Chua co Node.js. Hay cai Node.js 22 tro len, sau do chay lai tep nay.
  goto :end
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo Khong tim thay npm.cmd. Hay cai lai Node.js va chay lai tep nay.
  goto :end
)
echo Dang cai thu vien cho worker...
call npm.cmd ci
if errorlevel 1 (
  echo Cai thu vien that bai. Xem thong bao loi o phia tren.
  goto :end
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" goto :browserReady
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" goto :browserReady
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" goto :browserReady
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" goto :browserReady
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" goto :browserReady
echo Dang cai Chromium cho worker...
call npx.cmd playwright install chromium
if errorlevel 1 (
  echo Cai Chromium that bai. Xem thong bao loi o phia tren.
  goto :end
)
:browserReady
echo Cai dat hoan tat. Bay gio mo 02-CHAY-WORKER.cmd.
:end
pause
