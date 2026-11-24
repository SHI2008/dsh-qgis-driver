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
| `qgis_layer` | list / info / fields / add / create / remove / visibility / crs / style / symbol / classify / style_multi / style_rule / labels / annotate / reproject / raster_style / export / export_table |
| `qgis_feature` | query / table / select / select_by_location / selected / add / update / delete / field_add / field_calc / field_delete / field_rename |
| `qgis_layout` | list / create / info / add_item / update_item / legend_edit / align / export / export_atlas |
| `qgis_analysis` | list / help / run / zonal_stats / reclassify |
| `qgis_map` | render / screenshot / set_extent / zoom_to_layer |
| `qgis_plugin` | status / lock / log / restart |
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
11. **If a call reports `BUSY`, QGIS is working, not dead.** Every command runs on the GUI
   thread, so one long call queues the rest; the message names the call that holds it.
   Wait for it and retry. Restarting there throws away the running work and the project
   state. `STALLED` (heartbeat alive, nothing named) earns one retry, then `restart`.
   A single main-thread call is capped at 60 s — heavy actions
   (`qgis_layout export` / `export_atlas`, `qgis_analysis run`) get 120 s, because a real
   A4 export at 200 dpi does not fit in a minute either. Anything longer belongs in
   `submit_qgis_async` shards, not in a raised `QGIS_LIVE_EVAL_TIMEOUT`.
12. **Never write a `.py` file and never start a second QGIS.** The tempting loop — dump a
    script to temp, run it with the QGIS-bundled `python.exe`, read the output — creates
    a second `QgsApplication`, fights the live instance over the same data, renders fonts
    differently (with `QT_QPA_PLATFORM=offscreen` it has zero fonts, so every label exports
    as a black box while the exporter reports success), and returns results in a shape
    nothing else can read. The driver *is* the
    execution path: `execute_qgis_sync` for main-thread PyQGIS, `submit_qgis_async tasks[]`
    for background work, `qgis_analysis run` for Processing. If a call is too slow or too big,
    say so and split it — do not escape the driver. This is enforced: a snippet that calls
    `initQgis()`/`QgsApplication(...)` is refused with an explanation, because it would kill the
    instance for every later call.

## Before saying an algorithm is missing

`qgis_analysis list` is capped (default 200). It always returns `providers` with a count per
provider plus `total` and `truncated`, so check those before concluding something is not
installed: `list provider=native` (350 on the reference install), `provider=grass` (307),
`provider=gdal`, `provider=qgis`, `provider=pdal`. A provider missing from `providers` really
is not loaded — QGIS 4 ships no SAGA provider at all (install SAGA Next Gen, or use GRASS).

## SAGA is not in QGIS 4: map the job, don't hunt the provider

QGIS 4 dropped the SAGA provider. The installer still ships `apps/saga/saga_cmd.exe`, but no provider
drives it, and the QGIS 4.2 plugin repository carries no SAGA plugin at all — so `saga:*` will never
appear in `list`, no matter how you search. The reference install exposes 772 algorithms through the
providers that do exist (`3d` 1, `gdal` 59, `grass` 307, `native` 350, `pdal` 24, `qgis` 31).

Translate the job instead of the tool name (each id below was verified with `list` on the reference
install; re-check on the target machine with `list keyword=<word>`):

- Fill sinks / depressions: `native:fillsinkswangliu`, `grass:r.fill.dir`, `grass:r.fill.stats`
  (holes rather than sinks: `native:fillnodata`, `gdal:fillnodata`).
- Flow direction, flow accumulation, channel network, basins: `grass:r.watershed` — one call returns
  `accumulation`, `drainage`, `basin` and `stream` together.
- Slope / aspect / curvature: `native:slope`, `gdal:slope`, `grass:r.slope.aspect`.
- Interpolation: `qgis:idwinterpolation`, `qgis:tininterpolation`. Kriging is the one genuine gap —
  nothing in `3d`/`gdal`/`grass`/`native`/`qgis` provides it. `pykrige` installs into the QGIS
  interpreter in seconds and the recipe is in the `pyqgis-reference` skill ("Kriging: pull the
  package, do not substitute"); that call needs the `danger` scope. Never report IDW as kriging.
- Raster algebra and reclassification: `gdal:rastercalculator`, `native:reclassifybytable`.

## Calling GRASS / GDAL / native algorithms

`qgis_analysis action=help algorithm=<id>` is the authority for the *installed* version: it
returns every parameter name, whether it is optional, and — for enums — the accepted
`options`, plus `default`, `min`/`max` where the algorithm declares them. Read it before the
first run of an unfamiliar algorithm; do not recall GRASS/GDAL parameter names from memory
(`r.watershed` spells them `elevation`, `threshold`, `-s`, `accumulation`; `gdal:rastercalculator`
uses `INPUT_A`, `BAND_A`, `FORMULA`, `EXTENT_OPT`, `RTYPE`).

What help cannot tell you, and how to handle it:

- **GRASS region.** GRASS algorithms run on an explicit region. Leave `GRASS_REGION_PARAMETER`
  empty to inherit the input extent, but pass `GRASS_REGION_CELLSIZE_PARAMETER` when you need a
  specific cell size — "leave 0 for default" silently keeps the source resolution.
- **Output sinks.** Every `rasterDestination`/`vectorDestination`/`sink` must be filled, or the
  algorithm runs and writes nothing. Use `memory:<name>` for intermediate results (they come back
  as `added_layers`) or an absolute path for deliverables. `run` already reports
  `unwritten_outputs` when a declared sink came back empty — read it instead of assuming success.
- **`EXTENT_OPT` / `RTYPE` on GDAL.** These are enums with numeric or named options; the wrong
  value does not raise, it just produces an empty or wrongly typed raster. Check the `options`
  list from `help`.
- **Resampling and nodata** are parameter-level (`RESAMPLING`, `NO_DATA`, `NODATA`), not global
  settings; passing them on the wrong algorithm is silently ignored.
- **`native:viewshed` does not exist in QGIS 4.** Viewshed is `gdal:viewshed` (`INPUT`, `BAND`,
  `OBSERVER`, `OBSERVER_HEIGHT`, `TARGET_HEIGHT`, `MAX_DISTANCE`, `OUTPUT`) or `grass:r.viewshed`.
  `OBSERVER` is a point: pass `[x, y]` (or `"x,y"`) in the DEM's CRS — a layer name there is an error.
- **Outputs are named, not guessed.** `run` fills a sink you leave empty and tells you where it
  went: `memory_outputs` for a vector sink (the layer stays in the project), `written_outputs` for
  a raster or file sink (a real file; a raster returned as `memory:` cannot be read afterwards).
  `unwritten_outputs` names anything the algorithm claimed yet never wrote. Pass `output=<file>`,
  or `params={"OUTPUT": "<file>"}` to choose the path yourself.

## Recipes: the order that works first time

Follow a recipe instead of improvising. Each line is one tool call, and the argument names are the
ones the schema accepts — passing `layer_name`, `layout_name` where `layout` is expected, or a bare
string where an array is expected is the most common first-call failure.

**A thematic map from a layer that already exists**

1. `qgis_project action=info` — empty project? nothing to map yet.
2. `qgis_layer action=list` — use the exact names it returns.
3. `qgis_layer action=style layer="<name>" field="<field>" classes=5` (or `action=classify`).
4. `qgis_layout action=create layout_name="Map"`.
5. `qgis_layout action=add_item layout="Map" kind=map fit_layer="<name>" x=15 y=15 width=160`.
6. `qgis_layout action=add_item layout="Map" kind=legend x=185 y=15` (width defaults to 60 mm).
7. `qgis_layout action=add_item layout="Map" kind=scalebar x=15 y=190 segments=2 units_per_segment=5`.
8. `qgis_layout action=export layout="Map" formats=["png","pdf"] inline=true`.

**Analysis followed by a map**

1. `qgis_analysis action=help algorithm="<id>"` — parameter names and enum options.
2. `qgis_analysis action=run algorithm="<id>" params={...} output="C:/path/result.tif"` — an
   omitted raster sink gets a file and appears in `written_outputs`.
3. `qgis_layer action=raster_style layer="<result>" mode=pseudocolor classes=5`.
4. Continue with the map recipe from step 4.

**Several objects at once** — `layers=[...]`, `paths=[{path:...}, ...]`, `items=[{...}, ...]`,
`updates=[...]`, `runs=[{...}]`, `layouts=[...]`: one call, `{count, results}` back.

**Long job** — `submit_qgis_async tasks=[{name,code}, ...] max_workers=4`, then
`check_qgis_task task_ids=[...]` until every `status` is `done`.

## Write no scripts

The driver is the script runner. Do not create a `.py` file, do not call `qgis_process`, and do not
start a second QGIS: every one of those leaves the project you are editing. `execute_qgis_sync`
already runs inside the live project with `prj`, `P` (`prj` is the project, `P` the call's own
arguments) and `_prj_extent()`, and `submit_qgis_async` runs pure Python on worker threads. A
fragment that fails should be rewritten from the rename table, not retried verbatim, and
`initQgis()` / `QgsApplication(...)` are rejected by the service on purpose.

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

