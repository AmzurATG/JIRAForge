@echo off
cd /d "%~dp0.."
node scripts\cleanup-old-exports.js
pause
