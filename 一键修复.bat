@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "LOG=%~dp0fix.log"

echo ===== memo-desk repair ===== > "%LOG%"
echo time: %date% %time% >> "%LOG%"
echo.
echo [1/3] Clearing "from Internet" blocks (Unblock-File)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >> "%LOG%" 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); Get-ChildItem -LiteralPath $d -Filter '*.lnk' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >> "%LOG%" 2>&1

echo [2/3] Closing old memo-desk instances (so only ONE instance remains)...
rem 按命令行精确过滤，只结束本程序，绝不误杀其它 Electron 软件
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*memo-desk*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >> "%LOG%" 2>&1
echo       waiting 3s...
ping -n 4 127.0.0.1 >nul

echo [3/3] Starting one clean instance...
start "" wscript.exe "%~dp0start-memo.vbs"

echo.
echo ===== Done =====
echo - Panel is a thin strip on the RIGHT screen edge: move mouse there, or press Ctrl+Alt+M
echo - Notes are kept in the "memo-userdata" folder next to this file
echo - Log written to: %LOG%
echo.
pause
