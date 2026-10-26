@echo off
rem Rebuilds IntelliPointer from this folder and updates the installed app + shortcuts.
cd /d "%~dp0desktop"
call npm run app:install
echo.
pause
