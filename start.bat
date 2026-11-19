@echo off
chcp 65001 >nul
title Chat Demo
cd /d "%~dp0"

echo.
echo   Chat Demo - http://127.0.0.1:8090/
echo.

netstat -ano | findstr /r /c:":8090 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   Port 8090 busy, killing old process...
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":8090 .*LISTENING"') do taskkill /f /pid %%P >nul 2>nul
  ping -n 2 127.0.0.1 >nul
)

start "" "pocketbase\pocketbase.exe" serve --http=127.0.0.1:8090 --dir="pocketbase\pb_data" --publicDir="pocketbase\pb_public" --hooksDir="pocketbase\pb_hooks"
ping -n 3 127.0.0.1 >nul
start "" http://127.0.0.1:8090/

echo   http://127.0.0.1:8090/
echo   admin@example.com (首次运行请改密码)
echo.
pause
