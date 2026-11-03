@echo off
title Muse Brand Worker V2
cd /d "%~dp0"
set "MUSE_ASR_BACKEND=docker"
node worker-v2.mjs
echo.
echo Worker da dung. Hay xem thong bao o phia tren.
pause
