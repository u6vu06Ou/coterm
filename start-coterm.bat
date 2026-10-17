@echo off
REM 雙擊這個檔案就會啟動 Coterm（開發模式 npm run dev）。
REM 要重開：把跳出來的這個黑色視窗關掉，再雙擊一次本檔。
title Coterm dev - close this window to stop
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist node_modules\ (
  echo First run: installing dependencies, please wait...
  call npm install
)
echo.
echo  Starting Coterm...  (close this black window to STOP the app)
echo.
call npm run dev
echo.
echo  Coterm stopped. Press any key to close.
pause >nul
