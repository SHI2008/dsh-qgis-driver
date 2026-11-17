# dsh-qgis-driver

Drive a running QGIS from DeepSeek Harness. This bundle registers three tools that
call the `dsh_qgis_driver` plugin's REST API — either on the **same machine** (auto
discovery) or a **remote machine** (host + port + Key).

## Prerequisites

1. QGIS 4.x with the `dsh_qgis_driver` plugin installed and running.
2. The plugin's HTTP server is started (Remote Control enabled).

## Connection modes

### Local (default)

The bundle talks to QGIS through the plugin's **JSONL file channel** — no HTTP port,
no auth header:

- it picks the newest `~/.qgis-live/<pid>-dsh_qgis_driver.json` registry entry (up to 3
  candidates, dead PIDs skipped) and reads that entry's `live_dir` + `token`;
- each call appends one JSON line to `<live_dir>/commands.jsonl` and tails
  `<live_dir>/results.jsonl` from a stored byte offset, matching the reply by `id`;
- the plugin's `_poll` timer (QGIS main thread) drains the command file, validates the
  token (`hmac.compare_digest`) and appends the reply — the same `_dispatch` as REST,
  so every tool behaves identically.

Timeout: `QGIS_LIVE_FILE_TIMEOUT_MS` (default 60000 ms). If the file channel is
unavailable (no readable `live_dir`), the bundle falls back to probing
`GET /api/health` and using REST on `127.0.0.1:<port>`. No configuration is needed.

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
`QGIS_LIVE_REMOTE_KEY` (config in the patch file takes precedence). You can
also set the same three fields (`host`, `port`, `key`) from the DSH **Settings**
page — the bundle declares a `Config` schema, so DSH renders a form for them.

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
| `qgis_create_layout` | Create a new empty print layout. |
| `qgis_export_atlas` | Export a layout's atlas to a multi-page PDF or PNG. |
| `qgis_undo` / `qgis_redo` | Undo/redo edits on a layer (edit-buffer undo stack). |
| `qgis_classify_layer` | Apply a categorized or graduated renderer by a field. |
| `qgis_reproject_layer` | Reproject a vector layer into a new memory layer (geometry transformed, attributes kept). |
| `qgis_create_memory_layer` | Create an empty in-memory vector layer with fields. |
| `qgis_export_table` | Export a layer's full attribute table to CSV/JSON (file or inline). |
| `qgis_open_project` | Open a `.qgs`/`.qgz` project file. |
| `qgis_status` | HTTP server / plugin status (pid, live dir, port, token). |
| `qgis_describe_plugins` | List plugins available to the AI (bridge self-descriptions). |
| `qgis_open_plugin` / `qgis_reload_plugin` | Open / reload a plugin (WebEngine plugin routing). |
| `qgis_bridge_call` | Call a plugin's bridge method in-process (JSON result). |
| `qgis_instruction` | Manage AI instruction files (agents / skills / prompts). |

Rarely-used, destructive, GUI-only, and diagnostic tools are registered with
`deferLoading: true`, so their descriptions load on demand (they still appear
in the tool list): `qgis_add_feature`, `qgis_update_features`,
`qgis_delete_features`, `qgis_save_project`, `qgis_layout_items`,
`qgis_set_project_crs`, `qgis_set_layer_style`, `qgis_plugin_status`,
`qgis_undo`, `qgis_redo`, `qgis_classify_layer`, `qgis_reproject_layer`,
`qgis_create_memory_layer`, `qgis_export_table`, `qgis_open_project`,
`qgis_list_algorithms`, `qgis_algorithm_help`, `qgis_export_atlas`,
`qgis_create_layout`, `qgis_export_layer`, `qgis_set_extent`,
`qgis_zoom_to_layer`, `qgis_screenshot`, plus the plugin-monitoring tools
(`qgis_status`, `qgis_describe_plugins`, `qgis_open_plugin`,
`qgis_reload_plugin`, `qgis_bridge_call`, `qgis_instruction`).

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
