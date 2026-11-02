@echo off
rem Reality starten: Doppelklick genuegt. Beenden mit Strg+C oder Fenster schliessen.
rem Keine runden Klammern in Meldungen innerhalb von if-Bloecken: sie beenden den Block.
setlocal EnableExtensions
title Reality
cd /d "%~dp0"

echo.
echo   Reality wird gestartet ...
echo.

rem --- Voraussetzungen ---------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [Fehler] Node.js fehlt. Bitte Node 24 installieren: https://nodejs.org
  goto fail
)
where docker >nul 2>nul
if errorlevel 1 (
  echo   [Fehler] Docker fehlt. Bitte Docker Desktop installieren: https://www.docker.com/products/docker-desktop
  goto fail
)

rem --- Docker Desktop starten, falls es nicht laeuft -----------------------------
docker info >nul 2>nul
if not errorlevel 1 goto docker_ok
echo   Docker Desktop wird gestartet, das kann eine Minute dauern ...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
)
set /a tries=0
:wait_docker
timeout /t 3 /nobreak >nul
docker info >nul 2>nul
if not errorlevel 1 goto docker_ok
set /a tries+=1
if %tries% geq 60 (
  echo   [Fehler] Docker antwortet nach 3 Minuten nicht. Bitte Docker Desktop von Hand starten.
  goto fail
)
goto wait_docker
:docker_ok
echo   [ok] Docker laeuft.

rem --- Erster Start: Abhaengigkeiten und Einstellungen ---------------------------
if not exist "node_modules" (
  echo   Erster Start: Pakete werden installiert ...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto fail
)
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo   [ok] Einstellungen angelegt: .env - dort META_MODEL_API_KEY eintragen fuer Muse Spark
)

rem --- Datenbank ------------------------------------------------------------------
echo   Datenbank wird gestartet ...
docker compose up -d --wait postgres >nul
if errorlevel 1 (
  echo   [Fehler] Postgres konnte nicht gestartet werden.
  goto fail
)
echo   [ok] Datenbank laeuft.

rem --- Sandbox fuer Analysen ------------------------------------------------------
docker image inspect reality-sandbox-python:dev >nul 2>nul
if errorlevel 1 (
  echo   Erster Start: Sandbox wird gebaut, einmalig und dauert ein paar Minuten ...
  docker build -t reality-sandbox-python:dev sandbox/python
  if errorlevel 1 goto fail
)
docker image inspect reality-sandbox-node:dev >nul 2>nul
if errorlevel 1 (
  echo   Erster Start: Sandbox fuer Node-Werkzeuge wird gebaut ...
  docker build -t reality-sandbox-node:dev sandbox/node
  if errorlevel 1 goto fail
)
echo   [ok] Sandbox bereit.

rem --- Computer der Bots ----------------------------------------------------------
rem Scheitert der Download, startet Reality trotzdem: nur die Computer fehlen dann.
set "COMPUTER_IMG=ghcr.io/agent-infra/sandbox:1.11.0"
if exist ".env" for /f "tokens=1,* delims==" %%a in ('findstr /b "COMPUTER_IMAGE=" ".env"') do set "COMPUTER_IMG=%%b"
docker image inspect "%COMPUTER_IMG%" >nul 2>nul
if not errorlevel 1 goto computer_ok
echo   Erster Start: Computer der Bots mit KiCad und FreeCAD werden gebaut, einmalig etwa 12 GB ...
if /i "%COMPUTER_IMG%"=="reality-computer:dev" (
  rem KiCad und FreeCAD gehoeren dazu: dieses Image wird hier gebaut, nicht geladen.
  docker build -t reality-computer:dev sandbox/computer
) else (
  docker pull "%COMPUTER_IMG%"
)
if not errorlevel 1 goto computer_ok
echo   [Hinweis] Computer-Image "%COMPUTER_IMG%" fehlt. Reality startet ohne Bot-Computer.
echo   Selbst gebautes Image: docker build -t reality-computer:dev sandbox/computer
goto computer_done
:computer_ok
echo   [ok] Computer der Bots bereit.
:computer_done

rem --- Starten und Browser oeffnen ------------------------------------------------
echo.
echo   Reality laeuft gleich auf  http://localhost:5173
echo   Beim ersten Aufruf legst du dein Konto an (es wird Administrator).
echo   Beenden: dieses Fenster schliessen oder Strg+C.
echo.
start "" /min cmd /c "timeout /t 10 /nobreak >nul & start http://localhost:5173"
call npm run dev
goto end

:fail
echo.
echo   Start abgebrochen. Die Meldung oben nennt den Grund.
pause
exit /b 1

:end
endlocal
