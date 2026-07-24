@echo off
rem Video Curator launcher - the server opens the browser itself once it
rem is actually listening (see openBrowser in server.js), so it always
rem lands on the real port even if a fallback port was used.
rem Usage: start.cmd ["C:\path\to\videos"]
node "%~dp0server.js" %*
