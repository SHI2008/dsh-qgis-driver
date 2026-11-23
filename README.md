# dsh-qgis-driver

Drive the QGIS running on this machine from DeepSeek Harness. A local agent can
load layers, style them, run Processing, assemble a print layout and export
PNG/PDF — without hand-written PyQGIS in most cases.

Code runs inside the QGIS process, so it sees the real project, and it is
reversible: nothing leaves the machine.

This repository ships **two artifacts** that work together:

| Artifact | What it is | Where |
| --- | --- | --- |
| `dsh_qgis_driver` | QGIS plugin: a headless execution service. No dock, no menu, no settings — enable it and it starts. | `qgis-plugin/` |
| `@local/dsh-qgis-driver` | DSH bundle: the `qgis_*` tools, the permission switch, and three bundled skills. | `dsh-tools/` |

The plugin is derived from [QGIS Live Harness](https://github.com/yamamoto-ryuzo/QGIS-Live-Harness)
by yamamoto-ryuzo (GPL-3.0); see [NOTICE](NOTICE).

## How they find each other

The plugin writes `<pid>-dsh_qgis_driver.json` (host, `http_port`, `token`,
live dir) to `~/.qgis-live/`. The bundle picks the newest live entry, talks to it
through `commands.jsonl`/`results.jsonl` (`/api/cmd` over HTTP as a fallback),
and reports a heartbeat-file-backed status. **No address, port or key to
configure** — that is why the settings page has nothing to type.

Only `127.0.0.1` is bound, and every HTTP call carries the per-session token.

## Install

1. **QGIS side** — QGIS 4.x (tested on 4.2.3) → *Plugins → Manage and Install
   Plugins → Install from ZIP* → `dsh_qgis_driver-<version>.zip`, then enable it.
   Nothing else to set up; the service starts with the plugin.
2. **DSH side** — unpack `dsh-qgis-driver-<version>.tgz` somewhere stable and add
   it as a DSH bundle (or `link:` a checkout of `dsh-tools/`). Reload DSH.

The connection badge appears to the right of the composer when an instance is
live; next to it sits the permission switch.

## Tools

| Tool | Use it for |
| --- | --- |
| `qgis_project` | open / save / set CRS, project info |
| `qgis_layer` | add, create, CRS, symbols, categories, labels, export, reproject |
| `qgis_feature` | query, select, add/update/delete, fields (one or many layers) |
| `qgis_layout` | print layout: items, table, graticule, export PNG/PDF |
| `qgis_analysis` | Processing algorithms, zonal stats, reclassify |
| `qgis_map` | headless map render, extent, screenshot |
| `qgis_plugin` | instance status, write lease, audit log, restart |
| `execute_qgis_sync` | raw PyQGIS on the main thread (< 60 s, `prj`/`P` ready) |
| `submit_qgis_async` / `check_qgis_task` | worker-thread shards, polling, cancel |

## Safety rails

- **Permission scope** — `read` / `write` / `danger`, switchable from the composer
  or Settings, effective on the very next call. `danger` is required for deletes,
  opening projects and arbitrary Python.
- **One writer at a time** — mutating tools take an instance write lease, so two
  agents cannot silently interleave project edits. Reads and renders never wait.
- **Hard timeout** — one main-thread call is capped (60 s default, 120 s for
  heavy actions); a runaway snippet is interrupted and the instance stays usable.
- **Busy is not dead** — a long call reports `BUSY` instead of a transport error,
  and a wedged instance can be recovered with `qgis_plugin action=restart`.
- **Audit log** — every call is recorded (`qgis_plugin action=log`, `op=error|slow`).

## Requirements

- Tested on **Windows 10/11 with QGIS 4.2.3**. The built-in headless launcher is
  Windows-only; on other platforms start QGIS yourself (the bundle still finds it).
- The launcher locates QGIS via the `qgisRoot` setting, `QGIS_ROOT`/`QGIS_BIN`/
  `QGIS_PREFIX_PATH`, the OSGeo4W registry entry, `H:\QGIS`, `Program Files`, then
  a capped sweep of drive roots. A QGIS MSI on an unusual drive is found by that
  sweep — or set the root once in Settings → QGIS install root.
- DSH capable of loading a bundle (Node 18+).

## Layout

```
qgis-plugin/     QGIS plugin (execution service, ~2.4k Python lines)
dsh-tools/       DSH bundle (tools, client, skills, tests, docs)
  docs/          DETAIL.md (design + failure vocabulary), MIGRATION.md
  skills/        qgis-driver, qgis-batch-parallel, pyqgis-reference
  tests/         pure, docdrift, batch, live, chaos
scripts/         bump.mjs (versions), pack.mjs (artifacts), qgis-headless.py
RELEASE.md       release checklist
```

## Development

```bash
# tests (node from DSH; ELECTRON_RUN_AS_NODE avoids needing a separate node)
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dsh-tools/tests/pure.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dsh-tools/tests/docdrift.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dsh-tools/tests/batch.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dsh-tools/tests/live.mjs    # needs an instance
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dsh-tools/tests/chaos.mjs   # needs an instance

# versions + artifacts
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/bump.mjs 0.1.62-rc 0.18.5
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/pack.mjs
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the dual
attribution (this fork © 2026 SHI2008; QGIS plugin side derived from © 2025
yamamoto-ryuzo).

AI-assisted: the code was written with AI assistance; the author reviews and is
responsible for it.
