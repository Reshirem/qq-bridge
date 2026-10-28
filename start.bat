@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Prefer an explicit FFMPEG_PATH; otherwise detect the portable sibling install.
if not defined FFMPEG_PATH if exist "%~dp0..\ffmpeg\bin\ffmpeg.exe" set "FFMPEG_PATH=%~dp0..\ffmpeg\bin\ffmpeg.exe"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
rem Start the separately installed A_Memorix runtime when its local config exists.
rem Failure is non-fatal: the bridge itself can run without long-term memory.
if exist "%~dp0state\a-memorix\config.toml" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\a-memorix.ps1" start
    if errorlevel 1 echo [warning] A_Memorix did not start; the bridge will continue without it.
)
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
