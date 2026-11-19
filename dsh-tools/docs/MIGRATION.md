# Migration / cross-machine setup

`dsh_qgis_driver` is split into two portable ends that talk to each other over HTTP:

| End | What it is | Where it lives |
| --- | --- | --- |
| **QGIS plugin** (`dsh_qgis_driver`) | The server: runs inside QGIS, exposes a token-authenticated HTTP API | `H:\shichencai\Code\Python\qgis-plugin-dsh_qgis_driver` (this machine) |
| **DSH bundle** (`@local/dsh-qgis-driver`) | The client: registers `execute_qgis_sync` / `submit_qgis_async` / `check_qgis_task` tools that call the QGIS API | `H:\shichencai\Code\dsh-qgis-driver\dsh-tools` (this machine) |

The two ends can live on **the same PC** (default: automatic localhost discovery) or on **two different machines** (remote mode: the client connects to the server's `host:port` using a shared **Key**).

---

## 1. Prepare the QGIS plugin (the server end)

On the machine that runs QGIS:

1. Copy the whole plugin folder into QGIS's plugins directory:
   - Windows: `C:\Users\<user>\AppData\Roaming\QGIS\QGIS4\profiles\default\python\plugins\dsh_qgis_driver`
   - Linux: `~/.local/share/QGIS/QGIS4/profiles/default/python/plugins/dsh_qgis_driver`
2. Enable it in **Plugins → Manage and Install Plugins → Installed** (or leave the plugin's auto-start setting on).

### Keep it local

The plugin's HTTP surface listens on `127.0.0.1` only; there is nothing to
configure for a second machine. The DSH bundle finds the instance through
`~/.qgis-live` and authenticates with the per-session token written there.

### Handshake rules

- `host` + `port` are both required to enter remote mode; `key` is required in remote mode.
- The client first probes `GET /api/health`. If the Key is wrong the server answers `401`, and the tool reports **"QGIS 凭证已过期或无效（Key/token 不匹配）"**.
- If the server is unreachable, the tool reports the connection failure instead of guessing a local instance.

---

## 3. Tools

The bundle registers 30 tools. Three core ones:

| Tool | Purpose |
| --- | --- |
| `execute_qgis_sync` | Run code on the QGIS main thread (has `iface`/`QgsProject`). Keep it under ~3 s or the QGIS UI freezes. |
| `submit_qgis_async` | Run code in a background thread (no QGIS objects); returns a `task_id` immediately. |
| `check_qgis_task` | Poll an async task by `task_id`; returns the result once done (and consumes it). |

Plus 27 dedicated GIS tools (layers, features, layouts, algorithms, rendering,
export, styling, project/save, selection) — see `docs/DETAIL.md` for the full
table. The transport is chosen at startup: a configured remote `host:port+Key`
wins; otherwise local registry discovery; otherwise local autostart (below).

## 4. Local autostart

When QGIS is on the same machine and no live instance is found, the bundle
spawns QGIS directly and waits for the registry file — headless
`apps/Python312/python.exe -u scripts/qgis-headless.py` by default (no window,
Processing initialised, plugin imported straight from `qgis-plugin/`), and
`bin/qgis-bin.exe` only for map-canvas tools (`set_extent` / `zoom_to_layer` /
`screenshot`) or when the `headless` toggle is off. The GUI path syncs
`qgis-plugin/` into
`%APPDATA%\QGIS\QGIS4\profiles\default\python\plugins\dsh_qgis_driver` and
enables the plugin in `QGIS4.ini` `[PythonPlugins]` (skip the copy with
`QGIS_LIVE_AUTOSTART_SYNC=0`).

Override the launch command with config `autostart.command` or
`QGIS_LIVE_AUTOSTART_CMD`; tune the wait with `autostart.timeoutMs` /
`QGIS_LIVE_AUTOSTART_TIMEOUT_MS`.
