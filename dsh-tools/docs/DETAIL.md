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

The bundle registers **10 tools**: 3 core pyeval tools plus 7 consolidated
tools that dispatch on an `action` argument. Merging related operations into
one tool keeps the first-turn prompt small — 10 descriptions instead of the
54 individual tools this bundle used to expose.

| Tool | Actions |
| --- | --- |
| `execute_qgis_sync` | run PyQGIS on the QGIS main thread (short tasks only, < 3 s) |
| `submit_qgis_async` | run Python off-thread, returns a `task_id` |
| `check_qgis_task` | poll an async task (result is popped on first read) |
| `qgis_project` | `info` / `open` / `save` / `save_as` / `set_crs` |
| `qgis_layer` | `list` / `info` / `fields` / `add` / `create` / `remove` / `visibility` / `crs` / `style` / `symbol` / `classify` / `style_multi` / `style_rule` / `labels` / `annotate` / `reproject` / `export` / `export_table` |
| `qgis_feature` | `query` / `table` / `select` / `select_by_location` / `selected` / `add` / `update` / `delete` / `field_add` / `field_calc` / `field_delete` / `field_rename` |
| `qgis_layout` | `list` / `create` / `info` / `add_item` / `update_item` / `legend_edit` / `align` / `export` / `export_atlas` |
| `qgis_analysis` | `list` / `help` / `run` (processing algorithms) / `zonal_stats` / `reclassify` |
| `qgis_map` | `render` / `screenshot` / `set_extent` / `zoom_to_layer` |
| `qgis_plugin` | `status` / `describe` / `open` / `reload` / `bridge` / `instruction` |

Image-returning actions (`qgis_map render|screenshot`, `qgis_layout export`)
write the PNG to a temp file and return its path; open it with `read_image`.

`qgis_map` and `qgis_plugin` carry `deferLoading: true`, so their descriptions
load on demand — they stay callable but do not cost prompt space up front.

Where a layer name is ambiguous, pass the layer id instead: `qgis_layer list`

### Batch (one round-trip for N items)

Repeated operations run in a single `pyeval`: pass an array, get `{count, results: [...]}`.

| call | array | entry |
|---|---|---|
| `qgis_layer add` | `paths` | `{path, crs_file?, name?}` |
| `qgis_layer style` / `symbol` / `classify` / `export` | `layers` | layer name (export derives one file per layer) |
| `qgis_feature query` / `select` / `select_by_location` / `update` / `delete` | `layers` | layer name |
| `qgis_feature field_add` / `field_calc` / `field_delete` / `field_rename` | `specs` | `{field, field_type?, expression?, new_name?}` |
| `qgis_analysis run` | `runs` | `{algorithm, params}` |
| `qgis_layout add_item` | `items` | item args (`kind`, `x`, `y`, …) |
| `qgis_layout update_item` | `updates` | `{index, x?, y?, width?, height?, remove?}` |
| `qgis_layout export` / `export_atlas` | `layouts` (+ `formats: ["png","pdf"]`) | layout name |

The single-object form (`kind` / `layer` / `field` / `algorithm`) is unchanged; array and
single form are mutually exclusive per call.

### Outputs (one shape for every action)

Everything visual comes back as a **PNG under `%TEMP%\dsh-qgis-driver\`**, in `image_path`,
and is read with the `read_image` tool. PNG is the only format the model can look at directly,
so it is always produced:

| action | returns |
|---|---|
| `qgis_layout export|export_atlas` (`format` omitted or `png`) | `image_path`, `size_bytes` |
| `qgis_layout export|export_atlas` (`format: "pdf"`) | `image_path` (PNG preview) + `file_path` (PDF for delivery) |
| `qgis_map render|screenshot` | `image_path`, `width`, `height` |
| `qgis_layer export`, `qgis_layer export_table` | `file_path` (= `path`), `bytes` / `rows` |

`formats: ["png","pdf"]` yields one result per format; both carry `image_path`, the PDF one adds
`file_path`. Never request `format: "pdf"` when you only need to look at the map — the PNG entry
alone is cheaper.

`layout` and `layout_name` are interchangeable for every `qgis_layout` action.

### Inline previews (`inline: true`, opt-in)

`qgis_layout export|export_atlas`, `qgis_map render|screenshot` and `qgis_layer export` accept
`inline: true`. The call then returns the PNG preview as an image block **beside** the unchanged
JSON, so the model can look at it without a second `read_image` round trip:

```json
qgis_layout {"action":"export","layouts":["A3"],"formats":["pdf"],"inline":true}
→ text block: {"count":1,"results":[{... "file_path":"...pdf", "image_path":"...png"}]}
→ image block: the same PNG (attachment reference, webp-normalized)
```

The image is committed through the harness attachment store, exactly like `read_image`: it is a
durable reference, not base64, so it survives reloads and prompt cache. Cost is roughly 2.2k
tokens for a full A4 preview (billed once; later requests hit the prompt cache), and it only
pays off on the verification call, so it defaults to off. Every refusal — no `image_path` in the
result, a route whose model declares no image input, an oversized preview, a missing attachment
service — still returns the normal text result and appends one short note saying why the image
was skipped. An image block can never fail a QGIS call.

## Autostart (local)

When no live QGIS instance is found and the target is local (not a configured
remote `host:port`), the bundle starts QGIS by spawning it directly — no
`cmd.exe`, no batch wrapper, so quoting/locale differences cannot break it.

**Two modes, headless first:**

- **Headless (default)** — `apps/Python312/python.exe -u scripts/qgis-headless.py`
  with an OSGeo4W-style environment built in-process. The script boots a
  windowless `QgsApplication`, initialises the Processing framework (so
  `qgis_run_processing` works there too) and imports the plugin straight from
  this repository's `qgis-plugin/` — no profile copy needed.
- **GUI** — `bin/qgis-bin.exe`, used only when the call needs a map canvas
  (`qgis_set_extent` / `qgis_zoom_to_layer` / `qgis_screenshot`) or when the
  `headless` config toggle is off. This path copies `qgis-plugin/` into the
  QGIS profile plugin dir and writes `dsh_qgis_driver=true` into the QGIS4.ini
  `[PythonPlugins]` section.

Registry entries carry `"gui": true|false`, so a GUI-only tool never lands on a
headless instance: it looks for a GUI instance and launches one if missing.

Override the launcher with config `autostart.command` or env
`QGIS_LIVE_AUTOSTART_CMD` (runs through `cmd.exe /d /s /c <command>`);
tune the wait with `autostart.timeoutMs` (default 90000) or
`QGIS_LIVE_AUTOSTART_TIMEOUT_MS`; force GUI launches with the `headless`
config toggle off; point at a non-standard install with `QGIS_ROOT`.

## Security

- **Local mode** authenticates with the per-session bearer token from the registry file.
- **Remote mode** authenticates with the stable `QGIS_LIVE_API_KEY` you configure.
  Use a strong key, keep it private, and prefer a trusted network (or a tunnel),
  because `pyeval` executes arbitrary Python inside QGIS.

## Status badge visibility

The composer-row badge is hidden by default. It appears on its own after the
first QGIS tool call in the session, or right away when *Settings →
dsh-qgis-driver → show connection status widget* is enabled. Local calls use the
plugin's file channel (`commands.jsonl` → `results.jsonl`); remote calls use
REST with `host:port` + Key.
