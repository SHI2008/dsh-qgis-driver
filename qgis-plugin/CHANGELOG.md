# Changelog — dsh-qgis-driver

Change history of this plugin. Follows Keep a Changelog.
Versions are kept in sync with `version` in `metadata.txt`.

## [Unreleased]

### Added
- `audit` command and `_audit_read()`: the audit jsonl is readable through the control
  surface (`tail` / `error` / `slow`, `args` truncated to 160 chars), and `status` reports
  `calls`, `errors` and `last_error` from in-memory counters.
- Instance write lease (`write_lock` over `/api/cmd`, `WriteGate` in `live_driver`): mutating
  actions reserve the instance and release it in a `finally`, another writer is told who holds it
  and for how long, and the lease expires on its own (`DEFAULT_WRITE_TTL`) so a killed client
  cannot freeze QGIS. Reads and exports never take it — parallel rendering stays possible.
- Main-thread hard timeout: one `pyeval` is armed with a watchdog and interrupted with
  `MainThreadTimeout` (a `BaseException`, so `except Exception:` cannot swallow it). A runaway
  loop now returns in ~10 s and the instance keeps serving; `QGIS_LIVE_EVAL_TIMEOUT` overrides
  the budget, which defaults below the 15 s transport wait so the caller sees the explanation
  instead of a bare timeout.
- Cooperative cancellation for background work: every task namespace now exposes
  `dsh_should_stop()` (and `dsh_task_id`), so a long snippet can bail out on the next iteration
  after `task_cancel` instead of running to the end. `TaskRegistry.stop_requested()` is the single
  predicate behind it. Without polling, a running shard still finishes on its own — the flag stays
  advisory, because Python threads cannot be killed.

### Changed
- Internal consolidation (no behaviour change): `layer_org` and `scale_style` now share one
  `profile_store.ProfileStore` for the bundled+user JSON profile layout instead of two copies of
  the same `list_profiles`/`load_profile`/`profiles_dir`/`_bundled_dir` code; `ai_client`,
  `credential_store`, `connection_info`, `__init__` and `live_driver` all resolve the
  `~/.qgis-live` registry root through `profile_store.registry_dir()` (one implementation of the
  `QGIS_LIVE_REGISTRY` override). Verified identical profile ids, payloads and paths against the
  previous implementation.

### Added
- `task_cancel` command / `POST /api/task_cancel`: cancel one task (`task_id`) or a group
  (`task_ids`). A shard still queued in the pool never starts and reports `cancelled`; a running
  shard cannot be interrupted (Python cannot kill a thread), so it records `cancel_requested` and
  finishes on its own. Exposed as `check_qgis_task {"cancel": true}`.
- `pyeval_group` command / `POST /api/pyeval_group`: submit `{tasks: [{name, code}], max_workers}`
  and the plugin queues every shard, then runs it in one shared `ThreadPoolExecutor` (default 4,
  cap 32) instead of one unthrottled thread per task. Task entries now carry `name` and start as
  `queued`, so a group is pollable item by item with the existing `task_status` channel.
- Batch execution for repeated operations (one round-trip instead of N), all returning
  `{count, results}`: `qgis_layer add` (`paths`), `qgis_layer style|symbol|classify|export`
  (`layers`), `qgis_feature query|select|select_by_location|update|delete` (`layers`),
  `qgis_feature field_*` (`specs`), `qgis_analysis run` (`runs`), `qgis_layout add_item`
  (`items`), `update_item` (`updates`), `export|export_atlas` (`layouts` + `formats`).
  The single-object form is unchanged.
- `qgis_layout export` with `format=pdf` now works without an explicit `path` (writes a temp
  PDF and returns `file_path`), so `formats: ["png","pdf"]` batches end to end.

### Fixed
- `qgis_feature field_add` failed with `QgsField(): arguments did not match any overloaded call`
  (integer type ids instead of `QVariant.<Type>`).
- Batch `qgis_layer export` with one `path` no longer overwrites itself: each layer gets
  `<stem>_<layer><ext>`.
- Field ops return `{layer, field}` instead of dumping the whole field list.

### Changed
- One output shape for every action: all visual results are a PNG `image_path` (read with
  `read_image`); a PDF export additionally returns `file_path` and its PNG preview, so the
  model never has to guess which of PNG/PDF came back. Vector/table exports return `file_path`.

### Fixed
- `layout` and `layout_name` are now accepted interchangeably by every `qgis_layout` action
  (previously `add_item` required `layout` while `export` required `layout_name`).

- **Fixed**: `qgis_layer action=style` no longer crashes QGIS. It reused the
  layer renderer's own symbol object (which the old renderer owns and deletes
  on replacement), leaving a dangling pointer that segfaulted at the next
  render — typically a layout export minutes later. The symbol is now cloned
  before it is modified and handed to a new renderer.
- **Fixed**: `qgis_layout action=export` now refreshes the layout and clears
  every map item's render cache first, and reports a clean error when the
  exporter returns a non-zero result instead of returning a 0-byte file.

- **Changed**: the tool surface was condensed from 54 tools to 10 — related
  operations now share one tool and dispatch on an `action` argument
  (`qgis_project`, `qgis_layer`, `qgis_feature`, `qgis_layout`, `qgis_analysis`,
  `qgis_map`, `qgis_plugin`) alongside the three core pyeval tools
  (`execute_qgis_sync` / `submit_qgis_async` / `check_qgis_task`). The legacy
  per-operation tools are no longer registered; `qgis_map` and `qgis_plugin`
  additionally declare `deferLoading: true`.
- **Changed**: image-returning actions (`qgis_map render|screenshot`,
  `qgis_layout export`) write the PNG to a temp file and return its path instead
  of inlining base64.

- **Added**: coverage actions inside the existing aggregates, so routine map
  production no longer needs hand-written PyQGIS — `qgis_layer` gained
  `style_multi` (one symbol per attribute value), `style_rule` (rule-based
  symbology), `symbol` (line width / point size / outline) and `annotate`
  (label layer from feature centroids); `qgis_layout` gained `legend_edit`
  (font size, columns, item text, remove item, title) and `align`
  (left/right/top/bottom/center/distribute); `qgis_feature` gained `table`
  (sorted, paged attribute table); `qgis_analysis` gained `zonal_stats` and
  `reclassify`; `qgis_project` gained `save_as`. The aggregate count stays at
  ten — no new tool names.

- **Changed**: the composer status badge is hidden by default — it appears
  after the first QGIS tool call in a session, or immediately when the `dock`
  setting is enabled in Settings.
- **Fixed**: local file-channel calls fail faster and explain themselves — 15 s
  default timeout (`QGIS_LIVE_FILE_TIMEOUT_MS` overrides), the unanswered
  `live_dir` is skipped for the rest of the process, one automatic retry
  against another live instance, and the error states whether `results.jsonl`
  grew at all.

- **Changed**: autostart is headless by default and no longer goes through a
  `.cmd`/`.bat` wrapper — the bundle spawns `apps/Python312/python.exe` directly
  with the OSGeo4W environment it builds itself (PATH/PYTHONHOME/PYTHONPATH/
  QGIS_PREFIX_PATH/QT_PLUGIN_PATH/GDAL/PROJ), boots a windowless QGIS
  (`scripts/qgis-headless.py`, Processing initialised, plugin imported straight
  from `qgis-plugin/`) and only map-canvas tools (`set_extent` /
  `zoom_to_layer` / `screenshot`) bring up the GUI. The registry records
  `gui: true|false` and the `headless` config toggle (on by default) is exposed
  in the Settings form.
- **Changed**: translation support reduced to English + Simplified Chinese; the de/es/fr/hi/it/ja/pt/ru catalogs were removed (every `zh*` locale uses `i18n/zh.json`, everything else falls back to English).

### Added
- DSH client UI: a QGIS connection-status widget in the composer dock
  (`conversation.composer.dock`, off by default, toggled by the `dock`
  setting). It is a compact right-aligned badge that shows the channel
  (file / REST) and expands the detail line on click.
- DSH client UI: a dedicated **Settings** section (`settings.section`) with
  an editable host/port/Key/dock form, read and written through the Host's
  same-origin `/api/dsh-qgis-driver/config` route (persisted with
  `configEditor.edit`).
- DSH bundle: dual connection channels. Local calls now go through the
  plugin's JSONL file channel (`<live_dir>/commands.jsonl` →
  `<live_dir>/results.jsonl`, same token, same `_dispatch`, no HTTP port);
  remote calls keep using REST. The status widget reports which channel is
  in use (`QGIS_LIVE_FILE_TIMEOUT_MS` overrides the 60 s reply timeout).
- REST async execution channel: `POST /api/pyeval_async` returns a
  `task_id` immediately and `GET /api/tasks/<task_id>` polls the result
  (live_driver.py `TaskRegistry` + `submit_pyeval_async`; http_api.py
  routes). Async code runs in a fresh namespace on a background thread.
- Cross-machine (remote) access: `QGIS_LIVE_HOST` selects the bind address
  (default `127.0.0.1`; `0.0.0.0` for all interfaces), `QGIS_LIVE_PORT`
  fixes the port, and `QGIS_LIVE_API_KEY` is a stable Key remote clients
  can use (`Authorization: Bearer <Key>`) instead of the per-session token.
  A non-loopback bind also drops the loopback Host/Origin guard. The bound
  host is now recorded in the registry JSON and shown in Connection Info.
- DSH bundle: eight P0 daily-workflow tools — `qgis_layer_fields`,
  `qgis_query_features`, `qgis_algorithm_help`, `qgis_add_layer`,
  `qgis_export_layer`, `qgis_set_extent`, `qgis_zoom_to_layer` and
  `qgis_screenshot` (canvas/main-window PNG path).
- DSH bundle: thirteen P1/P2 tools — `qgis_project_info`, `qgis_select_features`,
  `qgis_selected_features`, `qgis_add_feature`, `qgis_update_features`,
  `qgis_delete_features`, `qgis_set_layer_visibility`, `qgis_remove_layer`,
  `qgis_save_project`, `qgis_layout_items`, `qgis_set_project_crs`,
  `qgis_set_layer_style`, `qgis_plugin_status`. Eight of them use
  `deferLoading: true` (destructive or rarely used). The bundle now
  registers 30 tools.
- DSH bundle autostart: when no live QGIS is found locally, the bundle starts
  QGIS itself and waits for the registry file — headless `python.exe` by
  default, `qgis-bin.exe` when a map canvas is needed (the GUI path syncs the
  plugin into the QGIS profile and enables it in QGIS4.ini `[PythonPlugins]`).
  Override with config `autostart.command`/`autostart.timeoutMs` or
  `QGIS_LIVE_AUTOSTART_CMD`/`QGIS_LIVE_AUTOSTART_TIMEOUT_MS`.
- DSH bundle: two P1 layout tools — `qgis_create_layout` (new empty print
  layout) and `qgis_export_atlas` (export a layout's atlas to multi-page
  PDF or PNG). Note: a layout must call `initializeDefaults()` before
  `QgsLayoutExporter` can export it.
- DSH bundle: P2 + tool-surface + data-surface tools — `qgis_undo`/`qgis_redo`
  (per-layer edit-buffer undo), `qgis_classify_layer` (categorized/graduated),
  `qgis_reproject_layer` (new memory layer with transformed geometry),
  `qgis_create_memory_layer`, `qgis_export_table` (full attribute table as
  CSV/JSON), `qgis_open_project`, and the 6 plugin REST/control tools exposed
  as DSH tools (`qgis_status`, `qgis_describe_plugins`, `qgis_open_plugin`,
  `qgis_reload_plugin`, `qgis_bridge_call`, `qgis_instruction`). The bundle
  now registers 45 tools (the ten CLI/WebEngine tools listed under Removed
  were dropped).

### Removed
- The entire MCP surface: the `/mcp` Streamable HTTP endpoint and its
  `_mcp`/`_tool_call`/`_tool_screenshot` handlers, the bundled stdio
  shim `mcp_stdio.py`, the outbound MCP client in ai_client.py
  (`McpSession`/`_McpHttp`/`_McpStdio`/`mcp_discover`/`_oauth_*` and the
  `mcp_<server>__<tool>` extra tools), the AI panel "MCP" settings row
  and `_McpDialog`, and the connection-info dialog's MCP tab and client
  configs. `mcp_http.py` was renamed to `http_api.py`.
- DSH bundle: ten tools that only serve external CLIs or WebEngine plugins —
  `qgis_eval`, `qgis_devreload`, `qgis_devin_run/status/result/abort` and
  `qgis_copilot_run/status/result/abort` (outbound Devin/Copilot CLI +
  WebEngine-only routing). The plugin now serves DeepSeek Harness
  exclusively, so these are no longer relevant.

### Changed
- Connection Info dialog now shows only the REST example, token and
  session details (MCP tab and stdio/HTTP client configs removed).
- Devin/Copilot ACP sessions no longer receive dsh_qgis_driver's `/mcp` as an
  MCP server (`mcpServers: []`).
- i18n catalogs: removed the `_McpDialog` context and all MCP keys.
- Menu label "Remote Control (localhost only)" → "Remote Control", and the
  connection-info / enablement dialogs no longer claim localhost-only.
- DSH bundle now declares a `Config` schema (`host`/`port`/`key`), so remote
  connection settings are configurable from the DSH Settings page (previously
  only via env vars). The schemastery runtime is vendored under
  `dsh-tools/node_modules` so the linked bundle resolves it (profile
  node_modules is not visible from a symlink's real path).
- DSH bundle: low-frequency tools now use `deferLoading: true` so their
  descriptions load on demand (26 tools deferred).

### Notes
- This fork is not intended to be merged upstream.

## [Fork] - 2026-11-16

Independent maintenance fork starts from upstream v0.16.2
(tag `upstream-0.16.2`, commit `af25aed`).

### Added
- i18n/zh.json: filled the 8 missing Chinese entries (suggested prompts
  feature).
- metadata.txt: Japanese words in `about` replaced with English
  (AI Assistant / Hot Reload).

### Changed
- All hardcoded Japanese protocol/tool descriptions translated to
  English (67 strings across bridge.py, live_driver.py, mcp_http.py,
  mcp_stdio.py, ai_client.py and ai_panel.py).
- Provider tag (Japanese katakana for "Bridge") renamed to `【Bridge】`;
  all nine i18n catalogs and the panel tooltip updated.
- Repository documentation translated to English: README, CHANGELOG,
  docs/ site, prompts/, skills/, verify/logic-sheet.md,
  verify/features.json and scale_style/default.json.
- Source comments and docstrings translated to English in all 16 Python
  modules.

### Removed
- Generated verification artifacts: the 191 feature pages under
  `verify/features/`, `verify/index.html` and the three
  `verify/results/static-2026-11-1{3,4,5}.json` snapshots. They are
  reproducible from `verify/features.json` and `verify/logic-sheet.md`.

### Notes
- This fork is not intended to be merged upstream.

## [0.16.2] - 2026-11-16

### Added
- live_driver.py / bridge.py / mcp_http.py / ai_panel.py:
  **persistent audit log for control commands**. Every command passing
  through `_handle` (file JSONL / REST `/api/*` / MCP / AI panel) is
  appended to `~/.qgis-live/audit-<date>.jsonl` (following
  QGIS_LIVE_REGISTRY). Records carry ts/id/type/plugin_id/method/
  args summary/origin (call path)/ok/duration ms, mask secrets-like
  keys such as token, api_key and password, and never record the
  session token. Token mismatches arriving via files (unauthorized)
  are audited too. Forwarded commands to other plugins are recorded
  only once, at the forwarding source. In addition to daily rotation,
  QSettings `dsh_qgis_driver/audit/*` controls enabling, the file size cap
  (default 5 MB, rolled over to a timestamped generation when
  exceeded) and the number of retained generations (default 14).
  Retrieval uses the new bridge methods `auditLog(n, filter)`
  (field-match dict / substring string) and
  `auditSettings(enabled, max_bytes, max_files)`.

## Pre-fork notes (kept for history)

### Added
- ai_client.py: added place-name navigation guidance to the Guidelines
  of SYSTEM_PROMPT. It now states "to move to a place name, prefer
  searchAddress of geo_search" and "QgsMapCanvas has no zoom-level
  API; use zoomScale (scale denominator) / setExtent / zoomByFactor /
  zoomToFeatureExtent, and convert EPSG:4326 latitude/longitude to the
  canvas CRS before setCenter". This prevents the model from trying the
  nonexistent setZoomLevel and hard-coding coordinates
- ai_client.py / ai_panel.py / live_driver.py / mcp_http.py:
  **added a third instruction kind `prompts` (suggested prompts)**.
  Selecting one from the "Suggested…" combo on the panel input row
  inserts the file body into the input field, and entries can be
  created/edited with the ✎ button, the `/prompt` command, the
  instruction editor (kind=Prompts) and the `ai_*` /
  `qgis_instruction` tools (kind=prompts). Placement follows the same
  model as agents/skills: bundled `<plugin>/prompts/*.md` plus user
  overrides in `~/.qgis-live/prompts/*.md`. The bundled canned
  instructions are six items: layer organization, standard line width,
  image export and state diagnostics (dsh_qgis_driver), legend creation
  (geo_legend) and feature search (geo_search)
- ai_client.py: **bundled instructions (skills/agents) are now
  aggregated from all managed plugins**. Previously only
  `dsh_qgis_driver/skills|agents/` was scanned, but every plugin that has
  `qgis-plugin/<id>/skills|agents/*.md` (geo_legend/geo_webview etc.)
  is now scanned, so domain-specific procedure documents can be
  shipped with the plugin that owns that domain. `when` (the use_when
  header line) was added to the result metadata of
  `ai_list_instructions`/`list_skills` so the model can obtain
  decision material for skill selection. In addition,
  `skills/webgis-convert.md` was moved to the geo_webview side
  (KASUGAI Canvas is geo_webview's responsibility)
- scale_style.py + scale_style/default.json: **added a scale-linked
  standard line width service**. Unlike CAD, GIS can tie line widths
  to scale, so the standard width table per category × scale band is
  managed in profile JSON (same shape as layer_org: bundled + user
  overrides in `~/.qgis-live/scale_style/`, switched with QSettings),
  and the bridge methods `scaleStyleProfiles`/`scaleStyleTable`/
  `setScaleStyleProfile`/`suggestScaleWidth`/`applyScaleWidth` were
  added. `applyScaleWidth` modes: `mm` = fix the paper width for the
  current scale, `meters` = real-world width (m, RenderMetersInMapUnits)
  linked to zoom, `rules` = generate a rule-based renderer that
  switches widths per scale band (delegates to geo_legend's
  `applyRules` when loaded, otherwise falls back to the internal
  implementation). Categories are inferred from layer name/geom and
  the bundled profile provides `road_major`/`river`/`boundary`/
  `contour` etc. `status()` now reports the active profile as well.
  A bundled skill `skills/scale-line-width.md` was added too, so the
  AI chat can consult the procedure on demand when a line-width
  request comes in
- devin_tasks.py + mcp_http.py/live_driver.py: **added Devin CLI
  delegation tools** `qgis_devin_run`/`qgis_devin_status`/
  `qgis_devin_result`/`qgis_devin_abort`. They start a Devin session as
  a background task and allow status polling, log retrieval and kill
  by task_id. Usable from every path: AI panel, MCP and REST.
  The engine is selected with the `engine` argument:
  `acp` = drive `devin acp` over JSON-RPC (shares IDE authentication,
  so `devin auth login` is not needed; resume via session/load,
  automatic response to session/request_permission, permission_mode→
  session/set_mode mapping dangerous→bypass),
  `print` = `devin -p` (requires `devin auth login`;
  supports `--respect-workspace-trust false`/`--prompt-file`/`-r`/
  `--model`), `auto` (default) = acp when IDE authentication exists,
  otherwise print
- ai_client.py/ai_panel.py: **added Devin as a provider**. Each entry
  in the provider list now carries a connection-type tag
  ([API]/[ACP]/[Bridge]), and Devin is offered in two forms:
  `devin_acp` (Devin [ACP]) makes a resident `devin acp` session the
  chat engine, with Devin itself running the tool loop
  (devin_tasks.AcpSession: initialize→authenticate (shares IDE
  authentication)→session/new|load→session/prompt, interruption via
  session/cancel, and dsh_qgis_driver's own /mcp injected as an MCP server
  so Devin can operate QGIS too; the endpoint field = working dir,
  no API key needed). `devin_bridge` (Devin [Bridge]) is a
  pseudo-provider that injects qgis_devin_* tool delegation
  instructions into an OpenAI-compatible chat (the tool loop stays on
  the panel side as before). `copilot_acp` (GitHub Copilot [ACP])
  drives a `copilot --acp --stdio` session through the same mechanism
  (authentication is delegated to the CLI's gh login, and authenticate
  is attempted best-effort when authMethods are advertised).
  `copilot_bridge` (GitHub Copilot [Bridge]) is a pseudo-provider that
  injects qgis_copilot_* tool delegation instructions into an
  OpenAI-compatible chat. Each combo item has a type description
  tooltip, and the "?" button next to the provider field pops up the
  differences between the three types
- devin_tasks.py + mcp_http.py/live_driver.py: **added Copilot CLI
  delegation tools** `qgis_copilot_run`/`qgis_copilot_status`/
  `qgis_copilot_result`/`qgis_copilot_abort` (shared via the agent
  argument of devin_tasks.run. `copilot -p` avoids cmd quoting
  problems by launching node+npm-loader.js directly,
  dangerous=COPILOT_ALLOW_ALL=true allows all tools + dir trust,
  -r resumes the session. The acp engine is supported by the same
  worker too)

### Fixed
- live_driver.py / qgis-session.mjs: **fixed "open_dialog re-shown on
  reload" opening even administrative dialogs**. `reload_plugin_now`
  and the fallback `reloadCode` unconditionally called open_dialog() on
  every plugin that has `open_dialog`, but an opt-out now skips the
  re-display when the plugin defines `open_dialog_on_reload = False`.
  geo_launcher (the install management window) uses this flag. The
  `open_plugin` command is an explicit "open it" request, so it still
  opens unconditionally
- ai_panel.py: **fixed the dock being widened on its own by a long
  single line of tool output (e.g. the JSON argument of
  `qgis_pyeval`)**. Tool output is rendered in `<pre>` (a block that
  cannot wrap), so the QTextDocument idealWidth grew and the dock was
  pushed wider through the QTextBrowser sizeHint. The view's
  horizontal sizePolicy is now Ignored so the content width is not
  propagated to the layout, and overflow is left to horizontal
  scrolling inside the view. The attachment image thumbnail was also
  changed to scaled(220x44, KeepAspectRatio) so that even a wide
  panorama image does not push the dock wider from the attach row
- __init__.py: **fixed a crash (access violation) in reloadPlugin via
  hot reload**. When `unload()` called `iface.removePluginMenu` inside
  a QMenu triggered handler, it rewrote the menu hierarchy while the
  popup was being processed and Qt crashed internally (observed:
  reloading dsh_qgis_driver from the "Reload all" of the old ID
  `qgis_live_driver`'s hot reload). `_defer_hot_reload` now defers the
  reload itself with `QTimer.singleShot(0)` until after the event
  completes, and the plugin menu operations in `unload()`/`initGui`
  (removePluginMenu, sweep) were also changed to deferred execution
  via `_defer_menu_cleanup`. So that the deferred sweep does not
  mistakenly delete new-generation actions, `_sweep_menu_actions`
  excludes its own current objects by reference identity
- live_driver.py: **added `_bridge_args` to normalize kwargs-style
  arguments of `bridge_call`**. When the model calls with
  `args=[{"k": v,...}]`, `args={"k": v}` or `args=[pos..., {"k": v}]`,
  the trailing dict is expanded as kwargs only when its keys fit
  unbound parameter names (previously `fn(*args)` passed the dict as-is
  as the first positional argument, failing with "layer not found"
  etc.). Ordinary dict arguments (such as
  geo_report.setItemProperties) still pass as positional arguments as
  before, because the keys do not match
- ai_client.py: fixed Copilot send errors for **Responses-API-only
  models (GPT-6 series etc.) that do not accept `/chat/completions`**.
  This is detected in advance from `supported_endpoints` of
  `GET /models`, and undetected models fall back automatically to
  `POST {api}/responses` after a `model_not_supported` error and learn
  it. The internal message sequence is still kept in chat format and
  converted to the Responses format (instructions/input/function_call/
  function_call_output) only when sending

### Changed
- **Renamed the plugin ID from `qgis_live_driver` to `dsh_qgis_driver`**
  (unifying the `geo_` series). Folder name, metadata name, bridge
  `pluginId`, the `<pid>-dsh_qgis_driver.json` registry, hot reload
  `CTRL_ID`, the `tr` context and the QSettings prefix were migrated to
  the new ID. No functional changes

## [0.15.3] - 2026-11-12

### Changed
- geo_toolbar.py: added an `ensure_visible` argument to
  `geo_suite_toolbar()` (default True, guarantees the visible state).
  The same-shaped helpers in each plugin were aligned to this
  specification, so that the GeoSuite toolbar is shown even when used
  individually with the driver not running. Paths that do not want to
  change visibility (e.g. removeAction on unload) pass False

## [0.15.2] - 2026-11-07

### Added
- bridge.py: added the AI panel (openAiPanel), connection info
  (openConnInfo), Deploy Mode dialog (openDeployMode), hot reload
  (listDevPlugins/hotReload) and remote control toggle (remoteControl)
  as bridge methods, so that all of the driver's own features can also
  be operated from bridge_call

## [0.15.1] - 2026-11-07

### Added

- Added **Anthropic (Claude)** and **Azure OpenAI** to the AI assistant
  panel providers. Anthropic natively implements the Messages API
  (`POST /v1/messages`, `x-api-key`+`anthropic-version`,
  tools=`input_schema`, tool_use/tool_result blocks), supports paging
  for the model list via `GET /v1/models`, and aggregates usage from
  `input_tokens`/`output_tokens`. Azure OpenAI sends OpenAI-compatible
  Chat Completions with the `api-key` header and
  `…/openai/deployments/<deployment>/chat/completions?api-version=`
  (default `2024-10-21`), and "Fetch" lists `/openai/deployments`
  (falling back to `/openai/models` when unavailable).
  Grok/Mistral/Groq/DeepSeek etc. remain usable as before by changing
  the endpoint of the OpenAI-compatible provider
- Added an AI assistant (chat) launch button to the GeoSuite toolbar.
  It sits to the right of the mode badge and opens/brings the existing
  AI assistant dock to the front when clicked. This was added because
  the toolbar had no AI-related entry point; it uses the same panel as
  launching from the menu. The icon is the bundled `icon_ai.png`
  ("AI" glyph)
- **Connection Info dialog** (new `connection_info.py`): opened from
  `Plugins > dsh-qgis-driver > Connection Info`. The topmost row
  always shows the Harness repository row (path display + copy +
  "Browse…" + "Refresh") and the remote control state, and the content
  is split into tabs: `MCP` (endpoint URL + stdio/Streamable HTTP
  configuration JSON), `REST` (API base + curl example), `Session`
  (registry/live dir/token in per-row copyable fields). When remote
  control is OFF, only the enabling procedure and the stdio shim
  configuration are shown. It also appears automatically right after
  the toggle is turned ON, guiding first-time users on "how to connect
  next"
- **Explicit harness repo path**: with a standalone install (no
  marker/junction) `repo_root()` could not resolve the repo and Deploy
  Mode was unusable, so explicit specification via QSettings
  `dsh_qgis_driver/harness_repo` was added (resolution order: QSettings >
  marker.repo > junction inference). The Deploy Mode dialog has a repo
  row + "Browse…" button at the top, and the Connection Info dialog
  also has a repo display + "Select…" button. Once specified, even a
  standalone install can proceed to junction-ification by
  deploy-plugin.ps1 with "Switch to development mode"
- Added `qgis_instruction` to the tool list of the stdio shim
  (`mcp_stdio.py`) (identical to HTTP-side `/mcp`,
  op=list|read|save|delete)
- The hot reload menu now shows a disabled "(no development plugins)"
  placeholder when it is empty

### Changed

- Deploy mode detection now prioritizes "actual placement
  (junction/dir)". The declared marker is used for complementing when
  not placed and for divergence detection (`declared`/`diverged` of
  `deploy_state`), and no longer overwrites the actual state with an
  old declaration. The Deploy Mode dialog appends `(declared: ...)`
  when the declaration and the actual state diverge

### Fixed

- Fixed the Deploy Mode dialog's mode switching failing with
  `[WinError 2]` in environments where `powershell` is not on QGIS's
  PATH (minimal OSGeo4W-style PATH). `switch_mode()` now prefers the
  full path
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
- Mode badge: the mode in use is no longer shown as text but as a
  non-intrusive gear icon only (`/mActionOptions.svg`) (the tooltip
  shows the mode name)
- Fixed the `mcp_stdio.py` docstring to the current specification (the
  enabling condition changed from a description assuming
  `WEBENGINE_LIVE_DIR` to "enable Remote Control")

### Security

- plugins.qgis.org security scan support: added http/https scheme
  validation via `_require_http_scheme` to all 5 `urlopen` call sites
  (rejecting schemes such as file:)
- Changed the log path fallback from hard-coded `/tmp` to
  `tempfile.gettempdir()`
- `eval` in `pyeval` is explicitly suppressed with `# nosec B307`
  because arbitrary Python execution is its main purpose
- Added `# nosec B110/B112` to 65 try/except/pass|continue sites
  (making the design intent explicit; addressing site scan findings)
- Eliminated partial-path subprocess launches: `icacls`/`security`/
  `secret-tool` are now resolved to full paths with `shutil.which()`
  (falling back to `%SystemRoot%\System32` when absent). `# nosec` was
  added to intentional calls (subprocess list arguments, user
  configured MCP commands, validated mode arguments, and B105 false
  positives on URL/placeholder strings) so that scans without
  `.bandit` applied report nothing either

### Maintenance

- Cleaned up flake8 findings: changed bare `except:` to
  `except Exception:`, expanded single-line `def f(): ...`
  definitions, and removed unused variables. Remaining long-line E501
  is explicitly suppressed in the bundled `.flake8` configuration
- LOW findings (try/except/pass, subprocess audit hints, hard-coded
  string false positives, etc.) are suppressed in the bundled
  `.bandit` configuration as reviewed

## [0.15.0] - 2026-10-19

### Added

- **GeoSuite shared toolbar** (`geo_toolbar.py`): aggregates the
  toolbar items of managed plugins into a single `QToolBar`
  (objectName="GeoSuite"). Because it is find-or-create, whichever
  plugin is enabled first lands on the same toolbar (each plugin has
  the same small helper, independent of the driver). Display is forced
  while the driver is active (toggleViewAction disabled + periodic
  re-show). geo_search/geo_webview/geo_report/geo_import/geo_legend
  migrated from plugin toolbars to GeoSuite (geo_excel has no toolbar
  items).
- **Mode badge** (always shown at the start of the toolbar): always
  displays the current deploy mode as a text button such as
  "Development mode/In use mode" (dev = "Development mode" with red
  background and white text for attention, use = gear icon only,
  non-intrusive). It refreshes automatically every 5 seconds via
  `deploy_state()` and opens the Deploy Mode dialog when clicked.
  i18n support for 9 languages

## [0.14.0] - 2026-10-19

### Added

- **Deploy Mode dialog** (`mode_switch.py`): the deploy mode can be
  switched explicitly from `Plugins > dsh-qgis-driver > Deploy Mode`.
  Switching between development mode (junction=repo preferred) and use
  mode (copy=snapshot) is done by launching the harness-side
  `deploy-plugin.ps1`, and the script is resolved from the `repo` key
  of the mode declaration marker
  `profiles/<profile>/qgis_live_mode.json` even while copy-placed. The
  dialog lists the declared mode and the actual placement form
  (junction/dir/not placed) of each plugin, and "Reload plugins after
  switching" (default ON) applies non-driver plugins on the spot. The
  bridge method `deployMode()` exposes the state read-only (the switch
  itself is UI-only). When switching to dev, existing real plugins are
  parked to `qgis_live_parked/<id>` and restored when switching to use
  (if there is no parked copy they stay not placed). New placement or
  update of the use version is done with the "Install the current repo
  as the use version" button (`deploy-plugin.ps1 -Install`=release
  operation). Parked plugins are shown as `(+parked)` in the list. UI
  strings were added to the 9-language catalogs

## [0.13.0] - 2026-10-19

### Added

- **Layer organization service `layer_org`** (`layer_org.py`): a shared
  service that standardizes the display of layers added across
  plugins. `plugins['dsh_qgis_driver'].layer_org.place_all([(layer, ctx)])`
  groups, renames and applies .qml styles to layers according to the
  rules of a profile JSON. Profiles have two tiers,
  `<plugin>/layer_org/*.json` (bundled defaults) +
  `~/.qgis-live/layer_org/*.json` (per user/industry, same-name
  preferred), and the active one is QSettings
  `dsh_qgis_driver/layer_org/profile`. The match conditions
  (format/ext/provider/layer_type/geom/plugin/name_re/dataset_re/
  url_re/tags) are evaluated first-match-wins with all keys ANDed, and
  `root`/`fallback`/`rename`/`style`/`top`/`collapsed` are applied.
  The bundled `default.json` provides generic placement for services,
  vectors (by geometry) and rasters. Bridge methods
  `layerOrgProfiles`/`layerOrgRules`/`setLayerOrgProfile`/
  `organizeLayers` (supports dry)/`placeLayer` were added and are
  reachable from `bridge_call`/`describe_plugins`. geo_import
  automatically hands layers added on load to this service (falling
  back to the conventional flat addition when the driver is not loaded
  or the profile is disabled)

### Changed

- Migrated the translation method to `i18n/<lang>.json` (a Harness-wide
  policy change). `.ts`/`.qm` were abolished and a JSON catalog of
  `{"context": {"English source": "translation"}}` was introduced.
  Startup loading is unified through `install_translator()` of
  `i18n_json.py` (the common loader for all plugins). All translation
  paths including `QT_TRANSLATE_NOOP` work unchanged.

## [0.12.0] - 2026-10-18

### Added

- Added translation catalogs for de/es/fr/hi/it/pt/ru/zh
  (`i18n/dsh_qgis_driver_<lang>.ts`/`.qm`) to match the adopted language set
  (AGENTS.md) (164 messages each). Together with ja, all 9 languages
  are bundled.

## [0.11.0] - 2026-10-18

### Added

- **Internationalization (i18n) support**: unified UI strings to English
  sources and set up the Qt translation (`.ts`/`.qm`) path. Added
  `i18n/dsh_qgis_driver_ja.ts`/`.qm` (all 164 messages translated).
  `__init__.py` loads `QTranslator` at startup and switches to Japanese
  display according to the UI locale. The AI panel, MCP settings dialog
  and menu items are also translatable (using
  `QCoreApplication.translate` / `QT_TRANSLATE_NOOP`).
- Refreshed `README.md` to the English version and separated the
  Japanese documentation into `README_JP.md`.

### Changed

- **Restricted hot reload targets to plugins under
  `<repo>/qgis-plugin/`** (`hot_reload.py`): previously the id in
  plugin.config.json was preferred and, when it could not be found, all
  loaded plugins (including third-party ones) were candidates. Now only
  plugins whose deploy destination resolves under
  `<repo>/qgis-plugin/` (junction placement) are candidates, and in
  environments without such plugins (-Copy placement or ordinary use)
  there are no candidates ("Reload all" is hidden as well)

## [0.10.0] - 2026-10-18

### Added

- **Persisted AI panel visibility state** (`__init__.py`): if the AI
  panel is open, it reopens automatically after a hot reload (or a QGIS
  restart). The state is stored in `dsh_qgis_driver/ai_panel_open`, and if
  the dock was closed it is restored closed. This removes the hassle of
  reopening the panel when iterating UI development of
  ai_panel.py/ai_client.py via hot reload
- **Image attachments for the AI assistant**
  (`ai_panel.py`+`ai_client.py`): images can be attached by pasting
  into the input field (Ctrl+V), dragging & dropping image files, or
  the "📎" button (file dialog). Attached images are normalized to PNG
  (downscaled to 2048 px on the long side) and saved to temp, then
  shown as thumbnail chips above the input field where they can be
  removed individually. On send they are bundled into the user message
  (image_url content array for OpenAI, inlineData for Gemini) and remain
  in the chat display and history, so the model can refer to them in
  later turns. Image-only (no text) sending and image restoration on
  "Resend" are also supported

### Removed

- **Abolished the "Send screenshot as image" checkbox**: image sending
  is now determined automatically from the image-capability estimate of
  the selected model. While a model outside the "Image input available"
  group is selected (non-vision in the fetched list, or a manually
  entered non-vision name), images cannot be attached at all (the 📎
  button is disabled too) and screenshot results are returned to the
  model as text (path) only

## [0.9.0] - 2026-10-18

### Added

- **"Hot Reload" submenu in the menu** (new `hot_reload.py`): lists
  development target plugins under
  `Plugins > dsh-qgis-driver > Hot Reload`, and manually reloads the
  selected plugin with sys.modules cleanup + reloadPlugin (+ open_dialog
  re-display). No QGIS restart or deploy needed. Candidates are, with
  junction placement, the ids of plugin.config.json traced from the own
  plugin's realpath to the repo; in environments where that cannot be
  found, all loaded plugins. "Reload all" reloads them in one go (the
  control-side dsh_qgis_driver last; the plugin itself can also be
  reloaded). The list is rebuilt every time the menu is opened, so it
  follows changes in plugin.config.json or the load state
- `live_driver.reload_plugin_now()`: extracted the body of the
  reload_plugin command into a module function and shared it with hot
  reload

## [0.8.0] - 2026-10-18

### Added

- **`use_when:` field in instruction headers** (`ai_client.py`): in
  agents/skills .md files, `use_when: <when to use>` (aliases
  when/when_to_use/usage/when-to-use, optional) can now be written
  right after the title and description. The value appears as
  `use when:` in the Agents/Skills list of the prompt and in the output
  of `ai_list_instructions`, so the model can choose by seeing "when
  this instruction should be used". The format description of
  `ai_save_instruction`, the panel combo tooltips and the hints in the
  edit dialog were aligned to the same notation

## [0.7.4] - 2026-10-18

### Removed

- **Removed the bundled skill `skills/qgis-basics.md`**: its pyeval
  basic recipes were causing model misbehavior (runtime errors), so it
  is no longer bundled. The bundled-default mechanism of
  `<plugin>/skills/` itself remains, so procedure documents can be
  provided from the user side `~/.qgis-live/skills/` or future bundled
  items if needed

## [0.7.3] - 2026-10-18

### Changed

- **Enter now sends and Shift+Enter inserts a newline**
  (`ai_panel.py`): to match common AI chat UIs, the send key changed
  from Ctrl+Enter to Enter (Ctrl+Enter still sends). Enter while an IME
  conversion is in progress (committing) does not send. The "Ask AI to
  fix" field of the instruction editor dialog behaves the same way
- **The send button now shows state** (`ai_panel.py`): it shows "Send"
  while idle (disabled while the input is empty) and turns into a red
  "■ Stop" while running, so the button tells whether the model is
  thinking or accepting input. The stop display is shown immediately
  and repainted at once when the send is confirmed, so the response is
  fast after pressing Enter. Clicking stop changes it to "Stopping…"
  (disabled), showing that the request has been accepted
- **The chat input field is released while editing instructions**
  (`ai_panel.py`): opening the "Edit" dialog no longer takes over the
  chat input field as the instruction body editor. Messages can still
  be sent to the AI as usual while it is open (the send button remains
  "Send")

### Added

- **"Ask AI to fix" field in the instruction editor dialog**
  (`ai_panel.py`): writing a fix instruction in the prompt field at the
  bottom of the dialog and sending it sends it together with the body
  in the edit field to the chat AI, and the result the AI saves with
  `ai_save_instruction` is reflected in the edit field (it is not
  overwritten while there are unsaved manual edits; if a file with the
  same name appears while creating a new one, it is selected)

### Fixed

- **Model reverting to the old selection on every startup**
  (`ai_panel.py`): when the saved model was not in the recommended
  list, the combo displayed the saved value but currentIndex still
  pointed at the first enabled item (e.g. gemini-2.5-flash), and
  `_current_model` returned `currentData()` unconditionally, so the old
  model was written back on save and on send. Fixed so that itemData is
  trusted only when the display text matches that item's ID
- **Stale Gemini default model** (`ai_client.py`): `gemini-2.5-flash`
  was discontinued on the API side (404), so the default was updated to
  `gemini-3.8-flash`. The recommended model list was also updated to
  the 3.x series

## [0.7.2] - 2026-10-18

### Added

- **Scroll sync in the instruction editor dialog** (`ai_panel.py`): the
  scroll positions of the edit (Markdown) pane and the preview pane now
  follow each other proportionally. So that the edit pane is not
  rewound by setMarkdown rewinding the preview to the top, reverse
  synchronization during rendering is suppressed and the position is
  realigned to the edit pane after rendering
- **Instruction editing from the chat input** (`ai_panel.py`): input
  starting with `/` is executed as a local command instead of being
  sent to the API. `/agent` (list + current value)/`/agent <name>`
  (switch)/`/agent <name> <body>` (save and select), `/skill` (list)/
  `/skill <name>` (show body)/`/skill <name> <body>` (save), `/help`
  (usage). The body can be written with newlines from the second line
  on. Unknown `/` commands are still sent to the API as before
- **Instruction edit mode** (`ai_panel.py`): the "Edit" dialog is now
  non-modal, and while it is open the chat input field becomes the edit
  field for that instruction body. The input field ⇄ dialog edit field
  are synchronized both ways (the live preview updates immediately
  too), and Ctrl+Enter/"Save" saves. The placeholder shows the target
  being edited, and closing the dialog returns the input field to normal
  mode plus the draft from before editing

### Fixed

- **Allow saving an empty MCP configuration**
  (`ai_client.py`+`ai_panel.py`): saving an external MCP server
  configuration as empty produced a "JSON is invalid" error and MCP
  could not be disabled. Empty input is now normalized to
  `{"mcpServers": {}}` before saving and treated as no MCP servers
  (unset). The dialog description was updated as well. Also, the
  client_secret migration notice is now limited to increases in
  `$store:` references so that it is not shown erroneously by
  normalization such as an empty save
- **Stop not working while waiting for OAuth authorization**
  (`ai_client.py`+`ai_panel.py`): while the authorization_code flow of
  an MCP connection polled for the browser response for up to 180
  seconds, the "Stop" button was not observed and the panel stayed in
  "Stopping…". The `is_aborted` callback is now propagated from
  `mcp_discover`→`McpSession`→`_McpHttp`→`_oauth_authorize` to abort
  the wait loop and the server connection loop immediately. On stop,
  `_mcp_done` is returned to disconnected so the next send rediscovers
- **Placeholder overlapping while an IME conversion is in progress**
  (`ai_panel.py`): `QPlainTextEdit` keeps the document empty even
  during preedit, so the placeholder was drawn overlapping the
  uncommitted string when Japanese input started. `_Input` now hides
  the placeholder during conversion and restores it on commit/focus out

## [0.7.1] - 2026-10-18

### Added

- **External MCP secrets now go to the credential store**
  (`ai_client.py`): when `oauth.client_secret` in `mcp_servers.json`
  was saved in plaintext, it is now migrated automatically to the OS
  credential store (credential_store, the same place as API keys) and
  only the reference `"$store:mcp:<server>:client_secret"` remains in
  the configuration file. If storing fails it is an error and it is not
  saved in plaintext (same policy as API keys). Values of `headers`/
  `env`/`oauth.client_id` are also resolved from the store at
  connection time with the `"$store:<key>"` notation. The settings
  dialog displays the migrated JSON and notifies it; when client_secret
  is unspecified it works as a public client that sends `client_id` in
  the body without Basic authentication

## [0.7.0] - 2026-10-18

### Added

- **Agents/skills (instruction files)** (`ai_client.py`+`ai_panel.py`):
  `~/.qgis-live/agents/*.md` are always-injected instructions selected
  with the panel combo (multiple definitions, switching, per-chat
  memory). `~/.qgis-live/skills/*.md` are on-demand procedure documents
  whose list only is included in the prompt, and the model reads the
  body with `open()` of `qgis_pyeval` (progressive disclosure). Both can
  be created/edited/deleted from the "Edit" dialog (agent/skill
  switching with a kind combo, edit/preview two-pane split, live
  preview of the Markdown being typed), and user-side files with the
  same name take precedence over the bundled defaults in
  `<plugin>/<kind>/`. `skills/qgis-basics.md` was added as a bundled
  example
- **AI editing and selecting instructions itself** (`ai_client.py`):
  panel-local tools `ai_list_instructions` / `ai_read_instruction` /
  `ai_save_instruction` / `ai_delete_instruction` / `ai_select_agent`
  (saves always go to the user side; bundled items cannot be deleted
  and are overwritten by saving with the same name). The agent list is
  also included in the prompt with id + description + [active] marker so
  the model can select autonomously. When a save is requested, the
  prompt states the guidance to distinguish agents/skills from the
  intent and explain the reason. For external orchestrators, the
  MCP/REST `qgis_instruction` tool (op=list|read|save|delete) is
  exposed as well
- **External MCP server connection (MCP client)** (`ai_client.py`):
  added a stdlib-only MCP client. Configuration is
  `~/.qgis-live/mcp_servers.json` (Claude Desktop compatible),
  `command`=stdio child process / `url`=Streamable HTTP (both JSON and
  SSE, follows Mcp-Session-Id). HTTP authentication supports fixed
  `headers` values as well as both `oauth` authorization_code+PKCE
  (when authorize_url is specified: browser consent→localhost callback
  reception→token persisted to mcp_tokens.json, automatic refresh_token
  renewal) and client_credentials (when only token_url is specified,
  client_id/secret, extra for provider-specific form parameters). One
  retry on 401. On connection/authentication errors, a guide to check
  the application-side settings (Redirect URI registration,
  authorization_code enabled, id/secret match) is shown. Discovered
  tools are mangled to `mcp_<server>__<tool>` and mixed into function
  calling, and the panel executes them locally via the session. The API
  settings have an "MCP" row (state display + settings dialog; the
  dialog has a connection example BOX and an "Insert example into
  editor" button), and saving reconnects on the next send. Connection
  failures are shown separately per server
- **Operational features** (`ai_panel.py`+`ai_client.py`): a stop
  button while running (stops at a round-trip boundary), "Resend" for
  the last question, a confirmation mode before tool execution (Yes/No
  each time when the check is ON), a context limit for conversation
  history (truncating from old turns), usage/cumulative cost display at
  the bottom right (accumulating the measured usage from API responses
  per chat, ctx = the latest measured prompt_tokens or a character-count
  estimate), persistence of chat history to `~/.qgis-live/chats.json`
  (latest 50), and Markdown export of the displayed chat (↓) and history
  deletion (✕)

### Changed

- Simplified the API settings display toggle to a ⚙ icon button

## [0.6.0] - 2026-10-18

### Added

- **Added a GitHub Copilot provider to the AI assistant**
  (`CopilotProvider` in `ai_client.py`). The message format is
  OpenAI-compatible, but authentication exchanges the GitHub token in
  the API key field (`gho_`/`ghu_`/`ghp_`…) for a short-lived token at
  `api.github.com/copilot_internal/v2/token` and sends to the
  response's `endpoints.api` (individual/business/enterprise) (the
  token is cached until just before expiry). **Supported plans are
  Pro/Free/Business/Enterprise/EMU** — in Business/Enterprise/EMU,
  `endpoints.api` returns a plan-specific API destination, which is
  resolved automatically through the same path (use the device flow
  when the EMU PAT is restricted). In environments where `v2/token`
  does not respond, there is a fallback that resolves the API
  destination with `copilot_internal/user` and uses the GitHub token
  as-is as a Bearer token (the `@github/copilot` CLI approach). A
  GitHub Copilot subscription is required; note that the endpoint uses
  the same internal API as VS Code's Copilot Chat
- **"Sign in with GitHub" button** (`ai_panel.py`): shown only when
  copilot is selected; obtains a GitHub token through the OAuth device
  flow and saves it to the API key field and the OS credential store.
  The default client_id is VS Code's public OAuth App, so the consent
  screen shows "Visual Studio Code". It can be replaced with your own
  OAuth App via `QGIS_LIVE_GITHUB_CLIENT_ID`
- Mapped Copilot's `GET {api}/models` response (`capabilities.type`/
  `policy.state`/`supports.vision`/`limits.max_context_window_tokens`)
  to the panel's model list (with type and context length)
- When the endpoint is changed from the default, the GitHub token is
  used as-is as a Bearer token without token exchange, so compatible
  proxies such as copilot-api can also be connected
- **Markdown rendering of AI responses** (`ai_panel.py`): assistant
  messages are converted and displayed with
  `QTextDocument.setMarkdown()`, formatting headings, lists, tables and
  code blocks. user/tool/error displays remain escaped text as before
- **Chat history** (`ai_panel.py`): the "New chat" button saves the
  current conversation to the history combo and starts a new one
  (context is reset too). Selecting a past chat from the history combo
  restores the displayed content and the conversation context, and the
  conversation can continue from there. Sessions are kept in memory
  only while QGIS is running (not persisted)
- **Tabbed dock** (`ai_panel.py`): when the panel is added and another
  dock is displayed in the same dock area, it is tabbed with
  `tabifyDockWidget`, overlapping the layer panel etc. as a tab instead
  of splitting vertically (the standard behavior of QGIS plugins)
- **API settings display toggle** (`ai_panel.py`): the "Settings"
  toggle button to the left of "New chat" shows/hides the API settings
  box. The state is saved in QSettings. It opens initially only when the
  API key is unset

## [0.5.0] - 2026-10-18

### Added

- **Generic bridge `_GenericBridge`** (`live_driver.py`): a common
  control surface to which `bridge_call` falls back automatically for
  plugins that do not have `plugin.bridge`. It provides
  `pluginInfo`/`status`/`actions`/`trigger`/`run`/`openDialog`/
  `closeDialog`, and `run`/`trigger` fire asynchronously with
  QTimer.singleShot(0), so command responses are not blocked even when
  the target opens a modal dialog. Third-party plugins (mmqgis etc.)
  can also be operated from the AI without modification outside the
  repo
- `describe_plugins` now adds a metadata-derived self-description via
  the generic adapter to plugins without a bridge (with a
  `generic: true` flag). Every loaded plugin is now discoverable and
  operable in the catalog
- Added `bridge.py` (`QgisLiveBridge`) and wired it to the driver's own
  `plugin.bridge`. `pluginInfo`/`status` self-describe the command
  surface and the running state

## [0.4.0] - 2026-10-18

### Added

- Added the `describe_plugins` command. It enumerates every loaded
  plugin and returns an AI-facing catalog in which plugins having a
  `bridge` aggregate the self-description (id/name/summary/when_to_use/
  invoke/methods/state) of each `pluginInfo()`. A `bridge` flag was also
  added to the plugin information of `status`
- Added `qgis_describe_plugins` to the TOOLS of `mcp_http.py` /
  `mcp_stdio.py` (exposed across REST `/api/tools`, MCP `/mcp` and the
  stdio shim)

## [0.3.0] - 2026-10-18

### Added

- **AI assistant panel** (`ai_panel.py` + `ai_client.py`). A chat-type
  agent dock opened from `Plugins > dsh-qgis-driver > AI assistant`.
  It connects to OpenAI-compatible (`/chat/completions` + function
  calling) and Gemini (`generateContent` + functionDeclarations) and
  runs the same tool set as `mcp_http.TOOLS` in a loop through
  `driver.submit()`. When remote control is OFF it runs on a
  panel-specific internal driver
- API keys are saved in the OS credential store (`credential_store.py`:
  Windows=DPAPI / macOS=Keychain / Linux=Secret Service, falling back
  to a 600-permission file)
- The model field is an editable combo plus a "Fetch" button that
  imports the model list from `GET {base}/models` (grouping by type +
  price display)

## [0.2.0] - 2026-10-18

### Added

- Public-facing hardening. Added the three connection surfaces HTTP
  REST `/api/*`, MCP Streamable HTTP `/mcp` and the bundled stdio shim
  (`mcp_stdio.py`), unified into the same dispatch as the file JSONL
- Session token authentication is now mandatory on all channels
  (live_dir/token and registry JSON both under user-only ACL). Exposure
  is controlled with the `QGIS_LIVE_API_KEY` / `QGIS_LIVE_TOOLS` env
  variables
- Added hub commands: `status` / `open_plugin` / `reload_plugin` /
  `bridge_call` + `plugin_id` forwarding (returning results to the
  caller by injecting `reply`)

## [0.1.0] - 2026-10-18

### Added

- Initial release. As a control-only plugin without WebEngine, it
  provides `pyeval` / `screenshot` via the
  `WEBENGINE_LIVE_DIR/qgis-<pid>/<plugin_id>/` commands.jsonl/
  results.jsonl files
