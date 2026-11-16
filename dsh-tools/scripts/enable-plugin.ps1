# Enable dsh_qgis_driver in the QGIS 4 profile settings.
# QGIS 4 stores plugin enable-state in %APPDATA%\QGIS\QGIS4\profiles\<profile>\QGIS\QGIS4.ini
# under the [PythonPlugins] section (NOT the Windows registry).
$ErrorActionPreference = 'SilentlyContinue'
$ini = Join-Path $env:APPDATA 'QGIS\QGIS4\profiles\default\QGIS\QGIS4.ini'
if (-not (Test-Path -LiteralPath $ini)) { exit 0 }

$t = [System.IO.File]::ReadAllText($ini)
if ($t -match '(?m)^dsh_qgis_driver=') { exit 0 }   # already enabled

$nl = [Environment]::NewLine
if ($t -match '(?m)^\[PythonPlugins\][ \t]*\r?$') {
    $t = [regex]::Replace($t, '(?m)^(\[PythonPlugins\][ \t]*\r?$)', ('${1}dsh_qgis_driver=true' + $nl))
} else {
    $t = $t.TrimEnd() + $nl + $nl + '[PythonPlugins]' + $nl + 'dsh_qgis_driver=true' + $nl
}
# Write UTF-8 without BOM (QSettings parses this cleanly; a BOM can break it).
[System.IO.File]::WriteAllText($ini, $t, [System.Text.UTF8Encoding]::new($false))
