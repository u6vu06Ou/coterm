@echo off
REM 雙擊啟動 Coterm dev（beta 身分）：和你正在用的 Coterm 完全分開，
REM 用另一份資料夾副本、另一個 port（43128），可以同時開著不改版的那個。
REM 要停止：關掉這個黑色視窗。
title Coterm DEV (beta sandbox) - close this window to stop
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
set COTERM_CHANNEL=beta
if not exist node_modules\ (
  echo First run: installing dependencies, please wait...
  call npm install
)
echo.
echo  Starting Coterm DEV in beta sandbox... (close this black window to STOP)
echo  Your real Coterm keeps running untouched.
echo.
call npm run dev
echo.
echo  Coterm DEV stopped. Press any key to close.
pause >nul
