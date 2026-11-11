@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   电磁场实验台 —— 本地服务器
echo   http://127.0.0.1:8765/
echo   关闭这个窗口即可停止
echo.
start "" http://127.0.0.1:8765/
python -m http.server 8765 --bind 127.0.0.1
if errorlevel 1 (
  echo.
  echo 没找到 python，试试用 Node:
  npx --yes http-server -p 8765 -c-1
)
pause
