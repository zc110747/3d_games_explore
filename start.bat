@echo off
rem ===========================================================================
rem  Sango Ba Ye 3D remake - one click launcher (P3)
rem
rem  What it does:
rem    1) checks Node.js / project files
rem    2) if port 8787 is already serving, just opens the browser
rem    3) otherwise starts original\server\server.mjs and opens the browser
rem
rem  Notes:
rem    * This file is pure ASCII on purpose (cmd code page safety).
rem    * Every exit path ends with PAUSE so a double-click window never vanishes.
rem    * Closing this window stops the local server.
rem ===========================================================================
setlocal
title SGBY 3D - local server
cd /d "%~dp0original"

set "URL=http://127.0.0.1:8787/index3d.html"
set "EXITCODE=0"

where node >nul 2>nul
if errorlevel 1 goto :no_node
if not exist "server\server.mjs" goto :no_server
if not exist "site\index3d.html" goto :no_site

echo ==========================================================
echo   Sango Ba Ye - 3D remake (P3 city management)
echo ----------------------------------------------------------
echo   URL   : %URL%
echo   Root  : %CD%
echo   Close this window to stop the server.
echo ==========================================================
echo.

rem ---- already running? (port 8787 open) --------------------
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient('127.0.0.1',8787);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto :open_only

rem ---- open the browser ~2s later, then serve in foreground --
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & rundll32 url.dll,FileProtocolHandler %URL%"
echo [INFO] starting local server, browser will open in a moment...
echo.
node server\server.mjs
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" (
  echo [ERROR] server exited with code %EXITCODE%
  echo         If the port was busy, the server may have moved to 8788-8797;
  echo         check its console output above and open the printed URL.
) else (
  echo [INFO] server stopped.
)
goto :done

:open_only
echo [INFO] port 8787 is already serving - opening browser only.
start "" "%URL%"
goto :done

:no_node
echo [ERROR] Node.js was not found in PATH.
echo         Install Node.js 18 or newer: https://nodejs.org/
set "EXITCODE=1"
goto :done

:no_server
echo [ERROR] original\server\server.mjs not found.
echo         Run this file from the repository root.
set "EXITCODE=1"
goto :done

:no_site
echo [ERROR] original\site\index3d.html not found.
set "EXITCODE=1"
goto :done

:done
echo.
pause
exit /b %EXITCODE%
