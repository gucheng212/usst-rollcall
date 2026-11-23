@echo off
chcp 65001 >nul
title USST Rollcall
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Please install Node.js 20 or newer from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)

echo Starting USST Rollcall on http://127.0.0.1:8619 ...
echo Keep this window open while using the app. Press Ctrl+C to stop.
echo.

rem Open the browser a couple of seconds after the server boots.
start "" /b cmd /c "timeout /t 2 >nul && start http://127.0.0.1:8619"

node server\index.mjs
if errorlevel 1 (
  echo.
  echo [ERROR] The server exited with an error.
  echo If the message above says EADDRINUSE, port 8619 is already taken:
  echo close the other window, or run  set PORT=8700 ^&^& node server\index.mjs
  pause
)
