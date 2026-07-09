@echo off
rem Video Curator launcher - opens the browser once the server is up.
rem Usage: start.cmd ["C:\path\to\videos"]
start "" /min cmd /c "timeout /t 1 >nul & start "" http://localhost:4321"
node "%~dp0server.js" %*
