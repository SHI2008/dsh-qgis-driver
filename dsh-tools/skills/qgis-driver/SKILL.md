---
name: qgis-driver
description: "Drive QGIS from DSH through the qgis_* tools: load layers, set CRS/symbology, add layout elements, run Processing, and export PNG/PDF. Load when the task involves a real QGIS project, a thematic map, or spatial analysis that the tools can do without hand-written PyQGIS."
---

# QGIS driver — usage conventions

Ten tools cover the whole loop. Prefer them over `execute_qgis_sync`: every batch below is one
round-trip, while hand-written pyeval is one round-trip per step.

## Tools

| tool | actions |
|---|---|
| `qgis_project` | info / open / save / save_as / set_crs |
| `qgis_layer` | list / info / fields / add / create / remove / visibility / crs / style / symbol / classify / style_multi / style_rule / labels / annotate / reproject / export / export_table |
| `qgis_feature` | query / table / select / select_by_location / selected / add / update / delete / field_add / field_calc / field_delete / field_rename |
| `qgis_layout` | list / create / info / add_item / update_item / legend_edit / align / export / export_atlas |
| `qgis_analysis` | list / help / run / zonal_stats / reclassify |
| `qgis_map` | render / screenshot / set_extent / zoom_to_layer |
| `qgis_plugin` | status / describe / open / reload / bridge / instruction / lock / log / restart |
| `execute_qgis_sync` / `submit_qgis_async` / `check_qgis_task` | escape hatch for anything not covered; `submit_qgis_async` takes `tasks=[{name,code}] + max_workers` for a bounded worker pool, `check_qgis_task` takes `task_ids=[]` for a whole group (add `cancel=true` to stop it) |

## Rules

1. **Batch first.** Any repeated action takes an array and returns `{count, results}`:
   `paths[]` (layer add), `layers[]` (style/symbol/classify/export/query/update/delete),
   `specs[]` (field ops), `runs[]` (analysis run), `items[]` / `updates[]` (layout),
   `layouts[] + formats[]` (export). One call per group, not per object.
2. **Outputs are PNG.** Visual results come back as `image_path`; open it with `read_image`.
   `format: "pdf"` adds `file_path` and still returns a PNG preview. Never pass `format: pdf`
   just to look at the map.
3. **Inline the preview when you must look at it now.** `qgis_layout` (export / export_atlas),
   `qgis_map` (render / screenshot) and `qgis_layer` (export) accept `inline: true`: the same
   call then returns the PNG preview as an image block beside the usual JSON, so verification
   needs no second call. Off by default — an inlined image rides every later request of this
   session (≈2k tokens for a full-page preview) and invalidates the cached prompt suffix, so use
   it for the verification call itself, not for archiving. If the route's model declares no image
   input, or the preview is too large, the call still succeeds and adds one note saying why the
   image was skipped.
4. **Errors are one short English line**: `Type: body (hint)`, prefixed with the call that failed
   (`qgis_layer export: missing required parameter "path"`). Unknown actions, invalid enum
   values and the parameters an action cannot do without (`path` for export, `kind` for
   add_item, `index` for update_item) are rejected locally, before QGIS runs — read that line
   and retry, do not switch tools. A timeout means the QGIS instance died — the call
   already retried on a fresh one; re-run it once before debugging.
5. **Check what exists** before acting: `qgis_layer action=list`, `qgis_layout action=list`,
   `qgis_project action=info`. Names are case-sensitive; use `id` when names collide.
6. **No status polling loops.** `qgis_plugin action=status` only when a call fails; it reports
   `calls`/`errors`/`last_error`, and `qgis_plugin action=log op=error` lists what failed and
   `op=slow` what took longest. That is faster than guessing why a run went quiet.
7. **Parallel shards for long jobs.** `submit_qgis_async tasks=[{name,code}] max_workers=N`
   runs the shards in one bounded pool and `check_qgis_task task_ids=[…]` polls them in one
   call. Shards are pure Python (no `iface`/`QgsProject`) and pay off on I/O and per-file work,
   not on numpy/BLAS. Reads may fan out across subagents; **writes stay serial** — one agent
   owns project/layout mutation. `check_qgis_task task_ids=[…] cancel=true` stops the queued
   tail of a group (a running shard only records the request). See the `qgis-batch-parallel`
   skill before splitting a run.
8. **Writes take a lease by themselves.** Mutating actions (`add`, `style`, `set_crs`, layout
   edits, field changes…) reserve the instance first, so two agents cannot silently overwrite
   each other; reads and exports never wait. If a call answers `another agent ("x") has been
   writing…`, wait and retry instead of working around it. `qgis_plugin action=lock op=status`
   shows the holder.
9. **Your permission scope can be narrower than you think.** The bundle refuses calls the
   current scope does not allow, with one line saying which scope is active. `read` = look and
   render only (no project change, no file written, no Python); `write` (default) = edit,
   export, analyse; `danger` = also delete, open/save arbitrary projects, and raw PyQGIS.
   A refused call cannot open a dialog: nothing in this bundle can. Say which call is blocked,
   ask the user with `ask_user_question` to pick the wider scope in the composer selector
   (只读 / 编辑 / 完全), and retry — the switch takes effect on your next call, with no reload.
   Do not hunt for a workaround.
10. **A wedged instance has one escape hatch.** `qgis_plugin action=restart` kills the process
   and the next call starts a fresh one (unsaved edits are lost, needs `danger`). `reload`
   cannot re-import in a headless process, so reach for `restart` only when calls keep timing
   out or the audit log shows the main thread stuck.
11. **One main-thread call is capped at 10 s**, except the three heavy actions
   (`qgis_layout export` / `export_atlas`, `qgis_analysis run`), which get 120 s — a real
   A4 export at 200 dpi does not fit in ten seconds. Anything else that overruns is
   interrupted and the instance stays usable; split it into `submit_qgis_async` shards
   instead of raising `QGIS_LIVE_EVAL_TIMEOUT`.
12. **Never write a `.py` file and never start a second QGIS.** The tempting loop — dump a
    script to temp, run it with `H:\QGIS\apps\Python312\python.exe`, read the output — creates
    a second `QgsApplication`, fights the live instance over the same data, renders fonts
    differently, and returns results in a shape nothing else can read. The driver *is* the
    execution path: `execute_qgis_sync` for main-thread PyQGIS, `submit_qgis_async tasks[]`
    for background work, `qgis_analysis run` for Processing. If a call is too slow or too big,
    say so and split it — do not escape the driver.

## Availability

All ten tools are registered globally: every agent — including subagents — can call them,
including `qgis_map` and `qgis_plugin` (deferred descriptions still callable). If your tool list
does not show `qgis_*`, call it anyway; the listing can lag a reload. Never conclude "the tool is
missing" from a listing alone, and do not fall back to hand-written `execute_qgis_sync` for a job
that has a dedicated action.

## Recipes

- **Load a folder of shapefiles**: one call
  `qgis_layer action=add paths=[{path:"…"},…] crs_file="<study>.prj" set_project=true`
  (ArcGIS custom `.prj` is not parsed from the layer, so `crs_file` matters).
- **Thematic map**: `qgis_layout create` → `add_item items=[{kind:"map",fit_layer:"X",…},
  {kind:"text",…},{kind:"legend",…},{kind:"scalebar",…},{kind:"north_arrow",…}]` → `export`.
- **Choropleth**: `qgis_analysis run runs=[{algorithm:"native:reclassifybytable",params:{…}}]`,
  then `qgis_layer action=style` on the output, then the map recipe.
- **Data check**: `qgis_feature action=query layers=[…] expression="pop > 1e6" limit=5`.

## GUI only

`qgis_map action=set_extent|zoom_to_layer|screenshot` need a real canvas; the driver starts a
headless QGIS by default and a GUI instance automatically for these four calls. Everything else
runs headless. `screenshot` returns `{target, image_path}` like every other visual action.

## Pitfalls (each cost a debugging session)

- `prj.write()/read()` loses layers: build layers, layout and export inside one call chain.
- A layout map caches; after changing symbology call `export` again (the tool invalidates).
- `QgsSingleSymbolRenderer` needs a `QgsSymbol`, not a symbol layer.
- Never reuse a renderer's own symbol when re-styling — clone it.
- `initializeDefaults()` is required before exporting a layout (the create action does it).
- `QgsProject` has no `extent()`; use layer extents.

### Raw PyQGIS

Raw code runs inside an already-initialised QGIS: `prj` is the live project, `P` holds the tool
arguments, `_prj_extent()` gives the combined extent, and you assign `result`. Never call
`QgsApplication.initQgis()`.

Before writing more than a few lines, load the **`pyqgis-reference`** skill that ships in this
same bundle (`dsh-tools/skills/pyqgis-reference/SKILL.md`): layer/feature/geometry/CRS/expression/
processing/rendering/layout idioms for QGIS 4.2, plus the table of QGIS 3 names that fail
(`setBufferEnabled`, `setLegendFilterByMapEnabled`, `renderer.symbol`, `setProviderKey`,
`layer.setItemVisibilityChecked`, layout `IndexError` on export, stale `wrapped C/C++ object`).
One reference read is cheaper than three tracebacks.

