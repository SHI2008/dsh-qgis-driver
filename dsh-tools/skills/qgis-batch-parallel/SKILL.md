---
name: qgis-batch-parallel
description: "Split a long QGIS processing job across worker shards (submit_qgis_async tasks[]) or across subagents — read-parallel, write-serial. Load when one tool call would loop over dozens of layers/files/tiles, when a run takes minutes, or when several agents must share one QGIS instance."
---

# Batch and parallel QGIS work

Both channels below share one rule: **reads may run in parallel, writes must be serial**.
A QGIS project is single-document state; two shards mutating layers/layouts at once corrupt it.

## 1. Worker shards — `submit_qgis_async tasks=[…]`

```jsonc
// one call, one pool, N shards
submit_qgis_async({
  "tasks": [{"name": "shard-1", "code": "…"}, {"name": "shard-2", "code": "…"}],
  "max_workers": 4
})
// -> {"tasks": [{"name": "shard-1", "task_id": "…"}, …], "count": 2}

check_qgis_task({ "task_ids": ["…", "…"] })   // one call polls the whole group
```

- Each shard gets a **fresh pure-Python namespace**: no `iface`, no `QgsProject`, no
  `processing.run`. Put the result in `result` (`result = {...}`); `eval` returns it otherwise.
- Finished tasks are **evicted on first read** — poll, record, move on. A task still
  `queued`/`running` is reported as such, never as an empty result.
- `max_workers` defaults to 4, capped at 32. Size it to the cores you actually want to spend,
  not to the shard count.
- Older plugin builds without `/api/pyeval_group` fall back to per-shard submission
  automatically; the result then carries a `note` — same shape, no concurrency cap.

### Stopping a group

```
check_qgis_task({ "task_ids": ["…", "…"], "cancel": true })
```

- A shard still **`queued`** stops for real — it never runs, and its next poll says
  `{"status": "cancelled", "error": "cancelled before it started"}`.
- A shard already **`running`** cannot be interrupted (Python threads cannot be killed). You get
  `{"cancelled": false, "status": "running", "reason": "already running: …"}` and the task record
  keeps `cancel_requested: true`; it finishes on its own. Do not poll it to death waiting.
- Cancel only pays off on the **queued tail**, which is exactly the expensive case: 200 shards
  discovered to be wrong at shard 3 cost one call instead of 197 remaining shards.

### What actually gets faster

| shard work | parallel gain | why |
|---|---|---|
| I/O (file reads, GDAL dataset open, HTTP, sleep) | **large** | measured here: 4 × 0.4 s → 1.61 s serial vs **0.41 s** at `max_workers=4` |
| single-threaded C extension (zlib, PIL, some shapely/GDAL calls) | moderate | GIL released during the C call |
| numpy/BLAS heavy | **none** | measured here: 8 shards × 600² matmul, 1.09 s at `max_workers=1` vs 1.11 s at 8 — BLAS already uses every core, so threads only oversubscribe |
| pure-Python CPU loops | **none** | GIL |

So: shard I/O and per-file work; do not shard big linear algebra.

### Shape of a shard

```python
# shard code — self-contained, returns one JSON-able object
import json, os
result = {"file": "a.tif", "ok": True}
```

Never end a shard by writing to the QGIS project. Have it return data; the orchestrator
applies the single write step afterwards.

## 2. Subagents — read-parallel, write-serial

Every agent (root or subagent) sees the same ten `qgis_*` tools against the **same** QGIS
instance, so concurrency is a coordination problem, not a permission one.

- **Fan out reads**: N subagents each analyse a different layer set / folder / region and
  return findings. Nothing they do can collide.
- **Keep writes on one lane**: project mutation (`qgis_layer add/remove/style`, `qgis_layout`,
  `qgis_project save`) goes through a single agent, applied after the parallel reads return.
- **Never let two agents export or edit the same layout** — the last writer wins silently.
- Prefer one orchestrator that merges results and performs the write step, instead of N agents
  each patching the project.

```
orchestrator: split → subagent A (read layers 1-20) ∥ subagent B (read 21-40)
              → merge → single write pass (style + layout + export)
```

## 3. Inside one call

For repeated *tool* actions, prefer the built-in batch params over sharding: `paths[]`,
`layers[]`, `specs[]`, `runs[]`, `items[]`/`updates[]`, `layouts[] + formats[]` — one
round-trip, no task bookkeeping. Shard only what one pyeval call cannot finish (minutes-long
Processing, hundreds of files).
