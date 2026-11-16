@echo off
rem ---------------------------------------------------------------------------
rem Start QGIS with the dsh_qgis_driver plugin enabled, for the DSH bundle's
rem autostart path (called when no live QGIS instance is found).
rem
rem Environment (all optional):
rem   QGIS_BIN              full path to qgis-bin.exe (auto-detected otherwise)
rem   QGIS_LIVE_PORT        fixed HTTP port (default: 0 = auto)
rem   QGIS_LIVE_API_KEY     stable Key for remote clients (default: unset)
rem   WEBENGINE_LIVE_DIR    live dir handed to the plugin (default: %LOCALAPPDATA%\qgis-live-autostart)
rem   QGIS_LIVE_AUTOSTART_SYNC=0   skip copying the plugin into the QGIS profile
rem ---------------------------------------------------------------------------
setlocal EnableExtensions

if "%WEBENGINE_LIVE_DIR%"=="" set "WEBENGINE_LIVE_DIR=%LOCALAPPDATA%\qgis-live-autostart"
if "%QGIS_LIVE_PORT%"=="" set "QGIS_LIVE_PORT=0"

rem --- 1. locate qgis-bin.exe -------------------------------------------------
set "BIN=%QGIS_BIN%"
if not "%BIN%"=="" if not exist "%BIN%" set "BIN="
if "%BIN%"=="" if exist "H:\QGIS\bin\qgis-bin.exe" set "BIN=H:\QGIS\bin\qgis-bin.exe"
if "%BIN%"=="" if exist "C:\Program Files\QGIS 4.2.3\bin\qgis-bin.exe" set "BIN=C:\Program Files\QGIS 4.2.3\bin\qgis-bin.exe"
if "%BIN%"=="" for /d %%D in ("%ProgramFiles%\QGIS*") do if exist "%%~fD\bin\qgis-bin.exe" set "BIN=%%~fD\bin\qgis-bin.exe"
if "%BIN%"=="" for /f "delims=" %%P in ('where qgis-bin.exe 2^>nul') do set "BIN=%%P"
if "%BIN%"=="" (
  echo [dsh-qgis-driver] qgis-bin.exe not found. Set QGIS_BIN to its full path. 1>&2
  exit /b 2
)

rem --- 2. sync the plugin into the QGIS profile (portable install) ------------
if "%QGIS_LIVE_AUTOSTART_SYNC%"=="0" goto launch
set "SRC=%~dp0..\..\qgis-plugin"
set "DST=%APPDATA%\QGIS\QGIS4\profiles\default\python\plugins\dsh_qgis_driver"
if exist "%SRC%\metadata.txt" (
  robocopy "%SRC%" "%DST%" /MIR /NFL /NDL /NJH /NJS /NP >nul
)

rem --- 3. enable the plugin in the QGIS4 profile INI --------------------------
rem QGIS 4 stores plugin enable-state in QGIS4.ini [PythonPlugins], not the registry.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-plugin.ps1" >nul 2>&1

:launch
echo [dsh-qgis-driver] launching "%BIN%" (port %QGIS_LIVE_PORT%, live dir %WEBENGINE_LIVE_DIR%)
start "" "%BIN%"
exit /b 0
