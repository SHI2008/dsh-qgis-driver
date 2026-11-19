# Install and move (dsh-qgis-driver, AI Assisted)

Two ends, one machine. The QGIS plugin is the service; the DSH bundle is the
client. There is no remote mode, no host/port setting and no shared key.

| End | What it is | Where it lives |
| --- | --- | --- |
| **QGIS plugin** (`dsh_qgis_driver`) | The service: runs inside QGIS, executes what the agent asks, writes an audit log | `qgis-plugin/` in this repo; installed copy under `%APPDATA%\QGIS\QGIS4\profiles\default\python\plugins\dsh_qgis_driver` |
| **DSH bundle** (`@local/dsh-qgis-driver`) | The client: registers the ten `qgis_*` tools and the composer widgets | `dsh-tools/` in this repo, linked into the DSH profile |

## 1. QGIS side

1. Copy `qgis-plugin/` into the QGIS plugin folder shown above (the ZIP in
   `dist/` is the same folder, ready for "Install from ZIP").
2. Enable **dsh_qgis_driver** in *Plugins → Manage and Install Plugins*.
   Enabling starts the service; disabling stops it. There is no menu and no
   dialog.
3. Nothing else to configure. The plugin binds `127.0.0.1` on a free port,
   writes a per-session token plus its live dir into `~/.qgis-live/`, and
   publishes a 1 s heartbeat there.

## 2. DSH side

1. Link `dsh-tools/` into the DSH profile as `@local/dsh-qgis-driver`
   (it is a `link:` dependency, so editing the repo is editing the bundle).
2. Reload the plugin in DSH settings. The ten `qgis_*` tools appear, the
   connection badge and the permission switch appear to the right of the
   composer.
3. Permission scope defaults to `write`. Reads, renders and the audit log always
   work; `danger` is needed for arbitrary Python, deletes and `restart`.

## 3. Discovery (no configuration)

The bundle takes the newest live instance for the current user:

1. `~/.qgis-live/*-dsh_qgis_driver.json` → pid, live dir, port, token;
2. the plugin's `commands.jsonl` / `results.jsonl` file channel (primary);
3. the plugin's loopback REST port with `Authorization: Bearer <token>`
   (fallback, and what the audit endpoints use).

If nothing is registered, the bundle starts QGIS itself (headless by default,
`QGIS_LIVE_AUTOSTART_CMD` to override). A dead instance is reported once; the
next call starts a fresh one.

## 4. Moving to another machine

Copy two things and nothing else:

* the repo (or `dist/dsh_qgis-driver-<version>.tgz`) into the DSH profile;
* the repo (or `dist/dsh_qgis_driver-<version>.zip`) into the QGIS plugin
  folder.

`~/.qgis-live/` is per-machine state (registry, tokens, audit logs, profiles).
Never copy it; the plugin recreates it on start.

## 5. Troubleshooting order

1. `qgis_plugin action=status` — pid, port, calls, errors, last_error, busy.
2. `qgis_plugin action=log op=error limit=20` — what failed and why.
3. `qgis_plugin action=log op=slow limit=10` — what is slow.
4. `BUSY` means it is working: wait and retry. `STALLED` means the GUI thread is
   blocked inside Qt/C++: one retry, then `qgis_plugin action=restart` (needs
   `danger`; unsaved edits are lost).
