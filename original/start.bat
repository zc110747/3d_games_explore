@echo off
setlocal
cd /d "%~dp0"
title Sanguo Bawang - Local Server

echo ============================================
echo   Sanguo Bawang - Local Server
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

if not exist "site\index.html" goto no_site
if not exist "site\assets\game.zip" goto no_pack

rem ---------------------------------------------------------------
rem  If a server is already listening on 8787, reuse it instead of
rem  starting a second copy on 8788 (two instances = stale content).
rem ---------------------------------------------------------------
node -e "require('http').get({host:'127.0.0.1',port:8787,path:'/api/health',timeout:1200},function(s){s.resume();s.on('end',function(){process.exit(s.statusCode===200?0:1)})}).on('error',function(){process.exit(1)}).on('timeout',function(){process.exit(1)});" >nul 2>nul
if not errorlevel 1 goto already_running

echo Starting server...
echo.

rem SGBY_OPEN=1: the server opens the browser itself after binding,
rem so a port fallback still opens the real address.
set SGBY_OPEN=1
node server\server.mjs
set CODE=%ERRORLEVEL%

if not "%CODE%"=="0" goto fail

echo.
echo Server stopped.
echo.
pause
exit /b 0

:already_running
echo A server is already running on port 8787.
echo Opening it in your browser.
echo.
echo   If the page still looks outdated:
echo     1. Close that server window (Ctrl+C)
echo     2. Run this script again
echo     3. Press Ctrl+F5 in the browser
echo.
start "" http://127.0.0.1:8787/
echo.
pause
exit /b 0

:no_node
echo [ERROR] Node.js not found in PATH.
echo         Install Node.js 18+ and try again.
echo.
pause
exit /b 1

:no_site
echo [ERROR] site\index.html not found.
echo         Keep the extracted frontend files under the "site" folder.
echo.
pause
exit /b 1

:no_pack
echo [ERROR] site\assets\game.zip not found.
echo         The game resource pack is required.
echo.
pause
exit /b 1

:fail
echo.
echo [ERROR] Server exited with code %CODE%.
echo.
pause
exit /b 1
