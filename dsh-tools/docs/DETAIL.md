# dsh-qgis-driver

Drive a running QGIS from DeepSeek Harness. This bundle registers three tools that
call the `dsh_qgis_driver` plugin's REST API — either on the **same machine** (auto
discovery) or a **remote machine** (host + port + Key).

## Prerequisites

1. QGIS 4.x with the `dsh_qgis_driver` plugin installed and running.
2. The plugin's HTTP server is started (Remote Control enabled).

## Connection modes

### Local (default)

The bundle auto-discovers a running QGIS: it picks the newest
`~/.qgis-live/<pid>-dsh_qgis_driver.json` registry entry (up to 3 candidates) and probes
`GET /api/health` with the stored per-session token. A `401` is reported as an
expired/invalid credential; a dead or refused instance falls through to the next
candidate. No configuration is needed.

### Remote (cross-machine)

To drive a QGIS on **another machine**, configure the target in the bundle's
`cordis.patch.yml` `config:` field:

```yaml
- insert:
    - id: dsh-qgis-driver
      name: '@local/dsh-qgis-driver'
      config:
        host: 192.168.1.20   # the remote machine's reachable address
        port: 8000           # QGIS_LIVE_PORT on the remote QGIS
        key: your-secret     # QGIS_LIVE_API_KEY on the remote QGIS
```

or set the environment variables `QGIS_LIVE_REMOTE_HOST`, `QGIS_LIVE_REMOTE_PORT`,
`QGIS_LIVE_REMOTE_KEY` (config in the patch file takes precedence).

On the **remote QGIS side**, set these environment variables before QGIS starts,
then enable Remote Control:

| Variable | Meaning | Default |
| --- | --- | --- |
| `QGIS_LIVE_HOST` | Bind address; `0.0.0.0` = all interfaces | `127.0.0.1` |
| `QGIS_LIVE_PORT` | Fixed TCP port; `0` = auto-assign | `0` |
| `QGIS_LIVE_API_KEY` | Stable **Key** for remote clients | *(unset)* |

The remote client then authenticates with `Authorization: Bearer <Key>`
(the "port + Key" form). The per-session token in the registry still works for
the local machine.

## Tools

### `execute_qgis_sync`

Runs a snippet of Python on the QGIS **main thread**, with full access to `iface`,
`QgsProject`, and all other PyQGIS objects.

- **Constraint:** never run code that takes more than ~3 seconds — it freezes the QGIS GUI.
- **Use for:** quick reads — current project, layers, selected features, expression evaluation.

### `submit_qgis_async`

Runs a snippet of Python on a QGIS **background thread** and returns a `task_id`
immediately. The background namespace is pure Python (no `iface`/`QgsProject`).

- **Use for:** longer work that must not block the GUI.
- Poll the result with `check_qgis_task`.

### `check_qgis_task`

Returns one background task's state. A finished task is returned once and then
removed from the cache (`status` = `done` or `error`); a running task reports
`status` = `running`.

## Security

- **Local mode** authenticates with the per-session bearer token from the registry file.
- **Remote mode** authenticates with the stable `QGIS_LIVE_API_KEY` you configure.
  Use a strong key, keep it private, and prefer a trusted network (or a tunnel),
  because `pyeval` executes arbitrary Python inside QGIS.
