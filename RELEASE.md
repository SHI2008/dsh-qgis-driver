# Releasing dsh-qgis-driver

Two artifacts ship from this repo. Both versions are written by
`scripts/bump.mjs`, so that is the only place to change them:

```bash
ELECTRON_RUN_AS_NODE=1 "/d/shichencai/HARNESS/DeepSeek Harness.exe" scripts/bump.mjs 0.1.59-rc 0.18.2
ELECTRON_RUN_AS_NODE=1 "/d/shichencai/HARNESS/DeepSeek Harness.exe" scripts/pack.mjs   # writes dist/
```

`node` is not on PATH in the DSH sandbox; use the harness binary:

```bash
ELECTRON_RUN_AS_NODE=1 "/d/shichencai/HARNESS/DeepSeek Harness.exe" scripts/pack.mjs
```

## What gets built

| Artifact | Goes to | Install |
| --- | --- | --- |
| `dist/dsh_qgis_driver-<plugin>.zip` | QGIS users | Plugins → Manage and Install → Install from ZIP |
| `dist/dsh-qgis-driver-<bundle>.tgz` | DSH users | unpack, then link or add it to the profile as a bundle |
| `dist/SHA256SUMS.txt` | whoever downloads the above | `sha256sum -c` |

The zip contains a single `dsh_qgis_driver/` folder with no dotfiles; the
tarball contains the whole `dsh-tools/` bundle (code, skills, tests, docs).

## Before packing

1. `ELECTRON_RUN_AS_NODE=1 … dsh-tools/tests/pure.mjs` (39 checks),
   `… tests/docdrift.mjs` (13), `… tests/batch.mjs` (30) — all green.
2. `… tests/live.mjs` against a running instance (16 checks; skips with exit 0
   when no instance is up).
3. Reload the bundle in DSH and run one real workflow (a render plus a layout
   export) so the shipped code is the code that was tested.
4. `cp qgis-plugin/*.py qgis-plugin/metadata.txt` into the profile copy at
   `%APPDATA%\QGIS\QGIS4\profiles\default\python\plugins\dsh_qgis_driver`
   if you want the GUI QGIS install to match the repo.

5. Check attribution and licences before publishing:
   `LICENSE` (GPL-3.0) and `NOTICE` exist at the repo root, every
   `qgis-plugin/*.py` starts with the SPDX + attribution header,
   `qgis-plugin/README.md` still carries the bilingual attribution block, and
   `metadata.txt` credits the upstream project in `about`.

## What changed in 0.18.0 / 0.1.56-rc

* The QGIS side is a service only: no AI panel, no dock, no settings dialog,
  no bridge to other plugins, no docs site. `qgis-plugin/` went from 11043 to
  2385 Python lines. Disabling the plugin is how you stop the service.
* `qgis_plugin` keeps `status`, `lock`, `log`, `restart`; `describe`, `open`,
  `reload`, `bridge` and `instruction` are gone.
* Exam-run fixes: `execute_qgis_sync` really injects `prj`/`P`, heavy layout
  and analysis calls get a 120 s budget, async shards refuse `initQgis()`,
  legends follow the project, map items inherit the project layers, one export
  call can emit several formats, and `extent`/`uuid` were added where the exam
  run expected them.
