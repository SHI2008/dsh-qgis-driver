# Migration / cross-machine setup

`geo_driver` is split into two portable ends that talk to each other over HTTP:

| End | What it is | Where it lives |
| --- | --- | --- |
| **QGIS plugin** (`geo_driver`) | The server: runs inside QGIS, exposes a token-authenticated HTTP API | `H:\shichencai\Code\Python\qgis-plugin-geo_driver` (this machine) |
| **DSH bundle** (`@local/qgis-driver-tools`) | The client: registers `execute_qgis_sync` / `submit_qgis_async` / `check_qgis_task` tools that call the QGIS API | `H:\shichencai\Code\qgis-driver-dsh-tools` (this machine) |

The two ends can live on **the same PC** (default: automatic localhost discovery) or on **two different machines** (remote mode: the client connects to the server's `host:port` using a shared **Key**).

---

## 1. Prepare the QGIS plugin (the server end)

On the machine that runs QGIS:

1. Copy the whole plugin folder into QGIS's plugins directory:
   - Windows: `C:\Users\<user>\AppData\Roaming\QGIS\QGIS4\profiles\default\python\plugins\geo_driver`
   - Linux: `~/.local/share/QGIS/QGIS4/profiles/default/python/plugins/geo_driver`
2. Enable it in **Plugins → Manage and Install Plugins → Installed** (or leave the plugin's auto-start setting on).

### Make it reachable from another machine

The plugin reads three environment variables at startup:

| Variable | Default | Meaning |
| --- | --- | --- |
| `QGIS_LIVE_HOST` | `127.0.0.1` | Address to bind. Use `0.0.0.0` to accept connections from other machines. |
| `QGIS_LIVE_PORT` | `0` (auto) | Fixed TCP port to listen on. Pick one, e.g. `8200`. |
| `QGIS_LIVE_API_KEY` | *(auto-generated per session)* | The stable **Key** remote clients must present. Set it to a fixed secret so it survives restarts. |

Example (Windows, set once before starting QGIS):

```powershell
setx QGIS_LIVE_HOST 0.0.0.0
setx QGIS_LIVE_PORT 8200
setx QGIS_LIVE_API_KEY "change-this-long-random-secret"
```

> **Security:** with `QGIS_LIVE_HOST=0.0.0.0` the server accepts requests from any host on the network. The Key is the only barrier, and the transport is plain HTTP (no TLS). Only do this on a trusted network/VPN, and use a long random Key. The menu item **Remote Control** shows the current connection info.

After QGIS starts, confirm the server is up:

```bash
curl -s http://<server-ip>:8200/api/health
# {"id": ..., "result": {"ok": true, "pid": ..., "plugin": "geo_driver"}}
```

(No token is needed for `/api/health`; all other endpoints require the Key.)

---

## 2. Configure the DSH bundle (the client end)

On the machine that runs DeepSeek Harness:

1. Install the bundle folder as a plugin (Plugins → Add plugin → choose local dir `qgis-driver-dsh-tools`), or `plugin_manager install_bundle` with the folder path.
2. Tell it where the remote QGIS is, using **one** of:

   **Option A — edit `cordis.patch.yml` (persists in the bundle):**

   ```yaml
   - insert:
       - id: qgis-driver-tools
         name: '@local/qgis-driver-tools'
         config:
           host: 192.168.1.50   # the QGIS machine's IP / hostname
           port: 8200
           key: change-this-long-random-secret
   ```

   **Option B — environment variables on the Harness process:**

   ```text
   QGIS_LIVE_REMOTE_HOST=192.168.1.50
   QGIS_LIVE_REMOTE_PORT=8200
   QGIS_LIVE_REMOTE_KEY=change-this-long-random-secret
   ```

3. Re-enable the bundle so it picks up the new config (Plugins → toggle it off and back on).

With **no** `host`+`port` configured, the bundle falls back to automatic localhost discovery (`~/.qgis-live/*-geo_driver.json`), which is what you want for same-PC use.

### Handshake rules

- `host` + `port` are both required to enter remote mode; `key` is required in remote mode.
- The client first probes `GET /api/health`. If the Key is wrong the server answers `401`, and the tool reports **"QGIS 凭证已过期或无效（Key/token 不匹配）"**.
- If the server is unreachable, the tool reports the connection failure instead of guessing a local instance.

---

## 3. The three tools

| Tool | Purpose |
| --- | --- |
| `execute_qgis_sync` | Run code on the QGIS main thread (has `iface`/`QgsProject`). Keep it under ~3 s or the QGIS UI freezes. |
| `submit_qgis_async` | Run code in a background thread (no QGIS objects); returns a `task_id` immediately. |
| `check_qgis_task` | Poll an async task by `task_id`; returns the result once done (and consumes it). |

These are the same three tools regardless of whether the connection is local or remote — the transport is chosen at startup.
