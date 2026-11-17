@echo off
rem ---------------------------------------------------------------------------
rem Start a HEADLESS QGIS (no window) with the dsh_qgis_driver plugin loaded.
rem Used by the DSH bundle's autostart path by default; GUI-only tools switch to
rem start-qgis.cmd instead.
rem
rem Environment (all optional):
rem   QGIS_PY               full path to python-qgis.bat (auto-detected otherwise)
rem   QGIS_BIN              full path to qgis-bin.exe (its bin\ is reused to find python-qgis.bat)
rem   QGIS_LIVE_PORT        fixed HTTP port (default: 0 = auto)
rem   QGIS_LIVE_API_KEY     stable Key for remote clients (default: unset)
rem   WEBENGINE_LIVE_DIR    live dir handed to the plugin (default: %LOCALAPPDATA%\qgis-live-autostart)
rem   QGIS_LIVE_AUTOSTART_SYNC=0   skip copying the plugin into the QGIS profile
rem ---------------------------------------------------------------------------
setlocal EnableExtensions

if "%WEBENGINE_LIVE_DIR%"=="" set "WEBENGINE_LIVE_DIR=%LOCALAPPDATA%\qgis-live-autostart"
if "%QGIS_LIVE_PORT%"=="" set "QGIS_LIVE_PORT=0"

rem --- 1. locate python-qgis.bat ---------------------------------------------
set "PY=%QGIS_PY%"
if not "%PY%"=="" if not exist "%PY%" set "PY="
if "%PY%"=="" for %%P in ("%QGIS_BIN%") do if exist "%%~dpPpython-qgis.bat" set "PY=%%~dpPpython-qgis.bat"
if "%PY%"=="" if exist "H:\QGIS\bin\python-qgis.bat" set "PY=H:\QGIS\bin\python-qgis.bat"
if "%PY%"=="" if exist "C:\Program Files\QGIS 4.2.3\bin\python-qgis.bat" set "PY=C:\Program Files\QGIS 4.2.3\bin\python-qgis.bat"
if "%PY%"=="" for /d %%D in ("%ProgramFiles%\QGIS*") do if exist "%%~fD\bin\python-qgis.bat" set "PY=%%~fD\bin\python-qgis.bat"
if "%PY%"=="" for /f "delims=" %%P in ('where python-qgis.bat 2^>nul') do set "PY=%%P"
if "%PY%"=="" (
  echo [dsh-qgis-driver] python-qgis.bat not found. Set QGIS_PY to its full path. 1>&2
  exit /b 2
)

rem --- 2. sync the plugin into the QGIS profile (so the package is importable) --
set "PROFILE_PLUGINS=%APPDATA%\QGIS\QGIS4\profiles\default\python\plugins"
if "%QGIS_LIVE_AUTOSTART_SYNC%"=="0" goto launch
set "SRC=%~dp0..\..\qgis-plugin"
if exist "%SRC%\metadata.txt" (
  robocopy "%SRC%" "%PROFILE_PLUGINS%\dsh_qgis_driver" /MIR /NFL /NDL /NJH /NJS /NP >nul
)

:launch
set "QGIS_LIVE_PLUGIN_DIR=%PROFILE_PLUGINS%"
echo [dsh-qgis-driver] launching headless QGIS (port %QGIS_LIVE_PORT%, live dir %WEBENGINE_LIVE_DIR%)
"%PY%" -u "%~dp0qgis-headless.py"
exit /b %ERRORLEVEL%
