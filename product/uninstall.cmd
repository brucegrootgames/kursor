@echo off
rem Kursor uninstaller for Windows — runs uninstall.ps1 (which finds Node.js and starts uninstall.mjs).
rem   product\uninstall.cmd [--yes] [--keep-config] [--purge]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
exit /b %ERRORLEVEL%
