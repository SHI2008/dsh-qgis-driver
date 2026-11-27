# Reply text for the 0.18.19 review

Paste the section below as a comment on the version page (or in the reply to the
notification mail) if the reviewer asks what the plugin is for, since it installs
with no menu, dialog or dock.

Keep it short: the reviewer only needs one way to see it working.

---

Thanks for reviewing. `dsh_qgis_driver` is a service plugin: it adds no GUI on
purpose, so "nothing appears" is the expected state.

What it does: on enable it starts a local command channel for an external agent
(DeepSeek Harness bundle, optional) - a file channel under `%USERPROFILE%\.qgis-live`
and a REST server on `127.0.0.1` with a per-session token. The agent then uses
PyQGIS on the GUI thread, runs Processing algorithms, builds print layouts and
exports PNG/PDF. Any client that speaks JSONL or the REST routes works; the
bundle is not required to run the plugin.

Sixty-second self-check, after enabling the plugin in *Plugins → Manage and
Install Plugins*:

1. `%USERPROFILE%\.qgis-live\<pid>-dsh_qgis_driver.json` appears. It holds `host`,
   `http_port` and `token`.
2. In PowerShell (replace port and token from that file):

   ```powershell
   $f = Get-Content "$env:USERPROFILE\.qgis-live\<pid>-dsh_qgis_driver.json" | ConvertFrom-Json
   Invoke-RestMethod -Headers @{ Authorization = "Bearer $($f.token)" } -Uri "http://127.0.0.1:$($f.http_port)/api/status"
   ```

   It answers with the QGIS pid, version, loaded font count and uptime, which
   proves the plugin is serving inside the running QGIS.
3. Disable the plugin and the file plus the port disappear.

Notes for the review:

- The HTTP server binds `127.0.0.1` only, there is no remote mode and no stable
  API key; the token file is user-only.
- `pyeval` executes Python inside the plugin's own interpreter. That is the
  feature, and the trust boundary is the local user account - it is documented in
  `about` and in the README.
- License is GPL-3.0-or-later, and `LICENSE` ships in the zip. The QGIS side is
  derived from QGIS Live Harness by yamamoto-ryuzo; `NOTICE` records that.
- Version 0.18.19 passed the automated security and quality checks and the Qt6
  check; the fixes in it were the `_as_list` undefined name (F821) and the
  deprecated `supportsQt6` flag.
