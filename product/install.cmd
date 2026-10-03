@echo off
rem Kursor installer for Windows — runs install.ps1 (which finds Node.js and starts install.mjs).
rem   product\install.cmd [options]      (--help lists them)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
