# dsh-qgis-driver (`dsh_qgis_driver`)

> **Attribution.** 本插件的 QGIS 侧（`qgis-plugin/dsh_qgis_driver`）基于原作者
> [yamamoto-ryuzo](https://github.com/yamamoto-ryuzo) 的
> [QGIS Live Harness](https://github.com/yamamoto-ryuzo/qgis_live_harness) 开发
> （上游基线 v0.16.2），遵循 GPL-3.0 许可。
>
> The QGIS side of this plugin is developed from
> [QGIS Live Harness](https://github.com/yamamoto-ryuzo/qgis_live_harness) by
> [yamamoto-ryuzo](https://github.com/yamamoto-ryuzo) (upstream baseline
> v0.16.2), and is released under the GPL-3.0 license.
>
> This repository is maintained independently; changes here are not intended to
> be merged upstream. Copyright in the original work remains with its author.
> See `LICENSE` and `NOTICE` at the repository root.

## What it is

A headless execution service inside QGIS: it turns the running process into a
local control surface that an agent drives. No dock, no menu, no dialog. Enable
the plugin and it starts; disable it and it stops.

- **One channel, one machine.** A file-JSONL channel plus a `127.0.0.1` REST
  server, both token-authenticated with a per-session token written to a
  user-only registry file. There is no remote mode and no stable API key.
- **Commands:** `pyeval` (arbitrary Python on the GUI thread, optional
  `timeout`), `pyeval_group` + `task_status` / `task_cancel` (worker pools),
  `screenshot`, `write_lock` (instance write lease), `audit` (read back the
  audit log) and `status`.
- **Two hardening properties the client relies on:** a hard timeout interrupts a
  runaway `pyeval` instead of freezing QGIS, and a single write lease keeps two
  agents from silently overwriting each other's edits.

`pyeval` executes arbitrary Python inside QGIS — the trust boundary is the local
user account.

## Install

Drop `dsh_qgis_driver` into your QGIS profile's `python/plugins` directory and
enable it in *Plugins → Manage and Install Plugins*. The client finds it through
`~/.qgis-live`.

## Layout

| file | role |
| --- | --- |
| `__init__.py` | plugin entry: start the driver, publish the registry file |
| `live_driver.py` | command loop, task registry, write lease, audit log |
| `http_api.py` | local REST surface over the same command types |
| `profile_store.py` | shared profile-directory resolution |
| `layer_org.py`, `scale_style.py` | layer organization / scale styling services |

## License

GPL-3.0, inherited from the upstream project.
