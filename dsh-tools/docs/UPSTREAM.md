# What this bundle copied from the harness's own tools

The harness ships tools that already solve "a model with little or no thinking
budget has to get it right the first time". Where one of those problems was the
same, this bundle copies their answer instead of inventing another one.

| Problem | The harness's answer | What this bundle does now |
| --- | --- | --- |
| A big result eats the context | `read`/`bash` return a bounded window, say how much there was, and give a way to continue (`offset`/`limit`, `spillPath`) | `asText()` keeps the first 60 000 characters, writes the whole result to `<temp>/dsh-qgis-driver/result_*.txt` and names that file in the note |
| Polling a job must not lose it | `job_output` keeps the consuming cursor untouched, so a second read still sees the output | reading a task is a snapshot: `check_qgis_task` can poll the same id twice; finished tasks are dropped after 30 minutes, abandoned running ones after an hour |
| Waiting for a job | `job_output {wait:true, timeout_ms}` blocks until the job settles | `check_qgis_task {wait:true, timeout_ms}` polls until every id is `done`/`error`/`cancelled` or the budget passes, and returns `{timed_out, waited_ms, tasks[]}` |
| A bad argument should fail locally, with a sentence that names the field | `ToolArgsError(['file_path must be a non-empty string'])` | `checkRequired` / `preflightBatch` / `guardExecute` throw `missing parameter "path"`, `unknown parameter "layer_name" — did you mean "layer"?`, `nothing was changed — item 2: …` |
| The first call must not need a manual | `bash` only requires `command`; everything else has a default and says so first in its description | `qgis_layer export` needs only `layer`, `qgis_layout export` needs only `action`, `add_item kind=map` defaults to 160 mm wide, `kind=legend` to 60 mm |
| A result may carry an image | `read_image` returns `{type:'image', attachment}` — never inline base64 | `inline:true` saves the PNG through the attachment store and returns the same shape |
| An overlay inside the composer must not be clipped | composer controls portal to `document.body` (`createPortal`), because the slot contract says fixed overlays must leave the docked composer | `client.js` measures the trigger and positions the panel `fixed` against the viewport — the client loader offers no `react-dom` external (only `react`), so portaling is not available and measuring achieves the same |
| A settings page needs a title | `PluginsSettingsSection` renders its own `<h2>` heading and one intro paragraph; the shell adds none | `SettingsPanel` opens with `h('h2', …)` and the existing connection sentence as the intro (`tests/pure.mjs` #48) |
| Job outcome vocabulary | `completed | killed | failed`, with `exit code: N` / `signal: X` in `detail` | every task carries `outcome` (`completed | failed | cancelled | running | queued`) beside its internal `status`; the traceback or cancel reason stays in `error` (`taskOutcome()`, `tests/pure.mjs` #49) |

Two things deliberately differ:

- **Every call is one shape: `action` + a few names.** `bash` can be one tool
  because "run a command" is one job. Driving QGIS is a dozen jobs, so the
  bundle keeps `action` and compresses the arguments per action instead.
- **Writes are serialised.** The harness's tools are stateless; this one holds a
  live QGIS instance, so mutating calls take an instance lease that expires on
  its own.

## Where to look upstream

Unpack `D:/shichencai/HARNESS/resources/app.asar` (header is 16 bytes, then a
JSON directory whose entries carry `offset`/`size`; `base = 16 + headerSize`)
and read:

- `dsh/node_modules/@deepseek-ai/dsh-tool-bash/src/{index,background,render}.ts`
  — description order, local validation, job registry, bounded output.
- `dsh/node_modules/@deepseek-ai/dsh-tool-fs/src/{read,read-image,write,edit,error}.ts`
  — pagination, attachment images, the `<path>/<type>/<content>` envelope.
- `dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/src/client/contract/slots.ts`
  — the slot kinds (`list` vs `single`), `scope`, and the composer overlay rule.
- `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` — `iconOf()`, which
  is why a deleted `icon.svg` keeps producing `ENOENT` until the process restarts.
