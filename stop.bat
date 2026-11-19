@echo off
chcp 65001 >nul
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":8090 .*LISTENING"') do taskkill /f /pid %%P >nul 2>nul
echo   stopped
timeout /t 1 >nul

