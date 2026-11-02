@echo off
cd /d "%~dp0"
npm install
npx playwright install chromium
pause
