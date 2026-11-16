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

### Dedicated GIS tools

| Tool | What it does |
| --- | --- |
| `qgis_list_layers` | List project layers (id, name, type, CRS, feature count, geometry). |
| `qgis_layer_fields` | List a layer's fields (name, type, alias) — check this before writing expressions or edits. |
| `qgis_list_layouts` | List print layout names. |
| `qgis_list_algorithms` | List processing algorithms (optional keyword filter). |
| `qgis_algorithm_help` | Show an algorithm's parameter names/types before running it. |
| `qgis_run_processing` | Run a processing algorithm (spatial analysis). |
| `qgis_query_features` | Query features by attribute expression; returns bounded JSON rows. |
| `qgis_add_layer` | Load a file/service as a new project layer. |
| `qgis_export_layer` | Export a vector layer to GPKG/GeoJSON/Shapefile/CSV. |
| `qgis_render_map` | Offscreen-render the project map to PNG (returns a local image path). |
| `qgis_export_layout` | Export a print layout to PNG/PDF (returns a local file path). |
| `qgis_set_extent` | Set the map canvas extent (GUI sessions only). |
| `qgis_zoom_to_layer` | Zoom the map canvas to a layer (GUI sessions only). |
| `qgis_screenshot` | Capture the map canvas or the main window to PNG (GUI sessions only). |
| `qgis_project_info` | Project overview: file, title, CRS, extent, layers, layouts, QGIS version. |
| `qgis_select_features` | Select features in a layer by attribute expression. |
| `qgis_selected_features` | Read the currently selected features' attributes. |
| `qgis_add_feature` | Add one feature to an editable layer (optional WKT geometry). |
| `qgis_update_features` | Bulk-update attributes by expression (requires `confirm`). |
| `qgis_delete_features` | Delete features by expression (requires `confirm`). |
| `qgis_set_layer_visibility` | Show/hide a layer in the layer tree. |
| `qgis_remove_layer` | Remove a layer from the project (source file untouched). |
| `qgis_save_project` | Save the current project (`.qgs`/`.qgz`). |
| `qgis_layout_items` | List a print layout's items (id/type/uuid). |
| `qgis_set_project_crs` | Change the project CRS (does not reproject existing layers). |
| `qgis_set_layer_style` | Set a layer's base color and opacity. |
| `qgis_plugin_status` | Diagnostic: QGIS version and whether the plugin is loaded/active. |

Rarely-used and destructive tools (`qgis_add_feature`, `qgis_update_features`,
`qgis_delete_features`, `qgis_save_project`, `qgis_layout_items`,
`qgis_set_project_crs`, `qgis_set_layer_style`, `qgis_plugin_status`) are registered
with `deferLoading: true`, so their descriptions load on demand.

Image-returning tools write the PNG to a local temp file and return its path;
open it with the `read_image` tool.

## Autostart (local)

When no live QGIS instance is found and the target is local (not a configured
remote `host:port`), the bundle launches QGIS via the bundled
`scripts/start-qgis.cmd`, then waits for it to publish its registry file.

The launcher: locates `qgis-bin.exe`; syncs this repo's `qgis-plugin/` into the
QGIS profile plugin directory (skip with `QGIS_LIVE_AUTOSTART_SYNC=0`); enables the
plugin by writing `dsh_qgis_driver=true` into the QGIS4.ini `[PythonPlugins]`
section (QGIS 4 stores this in the INI, not the Windows registry); then starts QGIS.

Override the command via config `autostart.command` or env `QGIS_LIVE_AUTOSTART_CMD`;
tune the wait with `autostart.timeoutMs` (default 90000) or
`QGIS_LIVE_AUTOSTART_TIMEOUT_MS`.

## Security

- **Local mode** authenticates with the per-session bearer token from the registry file.
- **Remote mode** authenticates with the stable `QGIS_LIVE_API_KEY` you configure.
  Use a strong key, keep it private, and prefer a trusted network (or a tunnel),
  because `pyeval` executes arbitrary Python inside QGIS.
