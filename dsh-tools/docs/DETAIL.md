# dsh-qgis-driver

Drive a running QGIS from DeepSeek Harness. The bundle finds the newest local
`dsh_qgis_driver` instance through the plugin's registry entry and talks to it over
the plugin's JSONL file channel (REST is the fallback). One machine, no address to
configure.

## Prerequisites

1. QGIS 4.x with the `dsh_qgis_driver` plugin installed and running.
2. The plugin's HTTP server is started (Remote Control enabled).

## Connection

No configuration: the bundle picks the newest `~/.qgis-live/<pid>-dsh_qgis_driver.json`
registry entry (dead PIDs skipped) and reads that entry's `live_dir` + `token`.

- each call appends one JSON line to `<live_dir>/commands.jsonl` and tails
  `<live_dir>/results.jsonl` from a stored byte offset, matching the reply by `id`;
- the plugin's poll timer (QGIS main thread) drains the command file, validates the
  token (`hmac.compare_digest`) and appends the reply — the same `_dispatch` as REST,
  so every tool behaves identically;
- if the file channel is unavailable, the bundle falls back to `GET /api/health` and
  REST on `127.0.0.1:<port>` with the same registry token.

Timeouts: `QGIS_LIVE_FILE_TIMEOUT_MS` (default 15000 ms) for the transport, and the
plugin interrupts one main-thread call after `QGIS_LIVE_EVAL_TIMEOUT` (default 10 s).

## Tools

The bundle registers **10 tools**: 3 core pyeval tools plus 7 consolidated
tools that dispatch on an `action` argument. Merging related operations into
one tool keeps the first-turn prompt small — 10 descriptions instead of the
54 individual tools this bundle used to expose.

| Tool | Actions |
| --- | --- |
| `execute_qgis_sync` | run PyQGIS on the QGIS main thread (short tasks only, < 3 s); the bundled `pyqgis-reference` skill carries the QGIS 4 idioms and the renames that trip models |
| `submit_qgis_async` | run Python off-thread, returns a `task_id`; `tasks=[{name,code}] + max_workers` submits a bounded worker pool |
| `check_qgis_task` | poll an async task (result is popped on first read); `task_ids=[…]` polls a whole group |
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

### Parallel shards (`tasks[]`)

`submit_qgis_async` also takes `tasks: [{name, code}]` plus `max_workers` (default 4, cap 32).
The plugin registers every shard as a `queued` task up front, then runs them in one shared
`ThreadPoolExecutor`, so N shards never spin up N unthrottled threads. It replies immediately:

```jsonc
{"tasks": [{"name": "shard-1", "task_id": "…"}, …], "count": 2}
```

Poll the group in one call with `check_qgis_task {"task_ids": ["…", "…"]}`; unfinished shards
report `queued` / `running`, finished ones are popped on first read exactly like a single task.

Channel details: the plugin command is `pyeval_group` (`POST /api/pyeval_group`, body
`{tasks, max_workers}`), and the file channel maps `/api/pyeval_group` in `routeToCommand()`.
If the plugin predates the endpoint, the bundle falls back to one `/api/pyeval_async` per shard
and adds a `note` to the result — same shape, no concurrency cap.

What it buys, measured on this machine: I/O shards (4 × 0.4 s) go from **1.61 s** at
`max_workers=1` to **0.41 s** at 4. numpy/BLAS shards do **not** speed up (8 × 600² matmul:
1.09 s vs 1.11 s) — BLAS already saturates the cores, parallel shards only oversubscribe;
pure-Python CPU shards are GIL-bound. Shard I/O and per-file work, not linear algebra.

### Cancelling a task (`check_qgis_task {"cancel": true}`)

`check_qgis_task` with `cancel: true` and `task_id` / `task_ids` stops a background task instead of
polling it. Python threads cannot be killed, so what cancellation can honestly do is bounded:

| task state | result |
|---|---|
| `queued` (a shard waiting for a pool slot) | stops for real — `{"cancelled": true, "was": "queued", "status": "cancelled"}`, the shard never runs |
| `running` | not killable, but stoppable *cooperatively*: `{"cancelled": false, "status": "running", "reason": "already running: Python cannot stop a thread, it will finish on its own"}`, plus `cancel_requested: true` on the task record. The snippet stops within one loop iteration if it polls `dsh_should_stop()` |
| `done` / `error` / already read | `{"cancelled": false, "was": "done", "reason": "task already done"}` — nothing to stop |

A cancelled shard answers `{"status": "cancelled", "result": null, "error": "cancelled before it started"}`
on its next poll, then it is popped like any other finished task.

A long snippet can honour the request itself: every background namespace exposes
`dsh_should_stop()` (and `dsh_task_id`), so a loop bails out on the next iteration instead of
running to the end:

```python
for i, path in enumerate(paths):
    if dsh_should_stop():
        result = {"stopped_after": i}
        break
    process(path)
```

Without that poll a running shard still runs to completion — the flag is only advisory.
 Writes to QGIS are serial anyway,
so cancelling the queued tail of a group is the useful case: it stops the remaining file work
without waiting for the whole batch.

Channel details: plugin command `task_cancel` (`POST /api/task_cancel`, body `{task_id}` or
`{task_ids}`), mapped in `routeToCommand()` for the file channel.

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

### Call-time guards (why the first call works)

Every tool validates the call before it reaches QGIS, so a first attempt either runs or comes
back with something a model can correct in one step:

- `action` must be one of that tool's enum values — an unknown one fails locally with
  `qgis_layer: unknown action "exports" — did you mean "export"? valid actions: ...`
  (no QGIS round trip, no Python traceback).
- Any other enum parameter is checked the same way: `qgis_layer export: invalid format
  "geojosn" — did you mean "geojson"?`.
- A `KeyError` on a parameter the schema declares is reported as `missing required parameter
  "path"` instead of the old `object not found` hint — the call was incomplete, not the project.
- Parameters an action cannot run without are checked before the round trip
  (`REQUIRED_ARGS` in `tools.js`): `qgis_layer export` without `path` or `qgis_layout add_item`
  without `kind` fails locally, so a wrong first call costs a sentence instead of a QGIS call.
- Every failure that does come from QGIS is prefixed with `tool action:` so one line names the
  call that failed.

### Descriptions carry the calling contract

Descriptions follow the shape the harness uses for `ops_bash`: what runs and whether state
persists, then the canonical parameter choice, then the exact result shape and the next step,
then the known traps with the sanctioned fix. Ambiguous parameters get their own description
(`path` vs `paths`, `layer` vs `layers`, `inline` cost, `confirm` for writes). This is what a
model reads before its first call, so keep result keys exact (`{format,file_path,image_path,
size_bytes}`), keep it short, and never promise behaviour the body does not have.

Because it is billed on every request, the budget is spent deliberately (measured, 2026-11-19):

| text | before | after |
| --- | --- | --- |
| ten tool descriptions | 3864 chars | 2539 chars (-34%) |
| all description strings | 5810 chars | 4194 chars (-28%) |

What was cut is redundancy, not contract: the action list moved out of prose because the schema
already carries it in `enum` (`ops_bash` does not enumerate its own parameters either), and
"returns JSON" / "one round-trip" filler is gone. What stayed is what a first call needs —
the per-action required mapping (`create` -> layout_name, `export` -> path with an extension),
the exact result keys, the headless boundary, and one trap per tool. The `qgis_layer export`
trap is the example: with `layers[]` the path is a filename and each layer lands at
`<stem>_<layer><ext>`, which is not guessable — trimming that line costs a failed call.

## Autostart (local)

When no live QGIS instance is found, the bundle starts QGIS by spawning it
directly — no `cmd.exe`, no batch wrapper, so quoting/locale differences cannot
break it.

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

## One writer at a time (instance write lease)

Two agents editing one QGIS do not crash each other — they silently overwrite each
other. One renames a layout while the other exports it, and both report success.

Mutating actions therefore take a lease on the instance before they run, and release
it in a `finally`:

| Serialised | Not serialised (deliberate) |
| --- | --- |
| `qgis_project` open/save/save_as/set_crs, `qgis_layer` add/create/remove/visibility/crs/style/symbol/classify/style_multi/style_rule/labels/annotate/reproject, `qgis_feature` add/update/delete/field_*, `qgis_layout` create/add_item/update_item/legend_edit/align, `qgis_plugin instruction` writes | `action=list/*` reads, `qgis_layer export`, `qgis_layout export`, `qgis_map render`, `execute_qgis_sync`, `submit_qgis_async` |

Reads and exports stay lock-free on purpose: parallel rendering is what the shard API
is for. The lease belongs to the calling agent (`exec.agent.name`), is re-entrant for
the same owner, expires after `ttl` (120 s from the tools, 300 s default) so a killed
agent cannot freeze the instance, and reports the holder:

```
qgis_project set_crs: another agent ("other-agent") has been writing to this QGIS
instance for 9s — wait for it, then retry. Reads are never blocked.
```

Inspect or clear it with `qgis_plugin action=lock op=status|acquire|release`.

## Hard timeout on the main-thread call

`execute_qgis_sync` runs on the QGIS main thread: a `while True:` used to freeze the
whole application, and the caller only saw a transport timeout. The plugin now arms a
watchdog around the eval and injects `MainThreadTimeout` (a `BaseException`, so
`except Exception:` in the snippet cannot swallow it) into the main thread:

```
pyeval stopped: it ran longer than 10s (hard timeout) and was interrupted, so the QGIS
instance stays usable. Split the work into submit_qgis_async tasks[] shards; if you
expect a longer single call, raise QGIS_LIVE_EVAL_TIMEOUT.
```

Measured: a runaway loop returns at 10.2 s and the instance keeps serving. The budget
defaults to 10 s, strictly below the 15 s transport wait, so the caller gets this
explanation instead of a bare timeout. A call blocked inside a C function (`time.sleep`,
network, a long GEOS computation) cannot be interrupted mid-call — Python only raises
the exception at the next bytecode — so it stops when that call returns.

## Regression suite

`dsh-tools/tests/` holds the checks that would have caught the regressions this
session fixed. Both are plain scripts: no framework, exit code 1 on failure.

| Script | Covers | Needs QGIS |
| --- | --- | --- |
| `tests/pure.mjs` | endpoint mapping, guards, required-parameter table, batching, lease table, error text, skill frontmatter | no |
| `tests/live.mjs` | lease acquire/refuse/release, runaway-loop interruption, instance survival, group submit + cancel | yes (skips when no instance) |

```
ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness.exe" dsh-tools/tests/pure.mjs
ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness.exe" dsh-tools/tests/live.mjs
```

## Status badge visibility

The composer-row badge is hidden by default. It appears on its own after the
first QGIS tool call in the session, or right away when *Settings →
dsh-qgis-driver → show connection status widget* is enabled. Calls use the
plugin's file channel (`commands.jsonl` → `results.jsonl`).

## Code layout

Two rules keep the tree from drifting back into patchwork:

- `dsh-tools/tools.js` owns every tool definition (`registerConsolidatedTools`);
  `dsh-tools/index.js` owns transport only (target discovery, file channel, REST, autostart,
  inline attachments) and registers that one bundle. Adding a tool in `index.js` has no effect —
  the old single-function layer there was removed in rc-0.1.41.
- `qgis-plugin/profile_store.py` is the single implementation of the `~/.qgis-live` root and of
  the bundled+user JSON profile layout. `layer_org` and `scale_style` supply profile *content*
  only; anything that needs a registry path imports `profile_store.registry_dir()`.
- `skills/<name>/SKILL.md` is published by `registerSkillProvider()` in `dsh-tools/index.js`
  (frontmatter `name`/`description` only). A new document is picked up by dropping the directory
  in — do not register it a second time anywhere else, and do not assume a skill exists in the
  catalog without a reload.
