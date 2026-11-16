> **Core driver for QGIS Live Harness** — [QGIS Live Harness](https://yamamoto-ryuzo.github.io/qgis_live_harness/) · [Plugin list](https://yamamoto-ryuzo.github.io/qgis_live_harness/plugins.html) · [Documentation](https://github.com/yamamoto-ryuzo/qgis_live_harness/tree/master/qgis-plugin/geo_driver/docs) · [Repository](https://github.com/yamamoto-ryuzo/qgis_live_harness)

# QGIS Live Driver (`geo_driver`)

> **Fork notice:** This repository is an independent fork of
> [yamamoto-ryuzo/qgis_live_harness](https://github.com/yamamoto-ryuzo/qgis_live_harness)
> (`qgis-plugin/geo_driver`, upstream v0.16.2). It is maintained separately
> from the upstream project, and changes here are not intended to be merged
> upstream. The original author and GPL-3.0 licensing are preserved.

**📖 Documentation: [docs/index.html](docs/index.html)**
(installation, usage, and specification details)

## Overview

A UI-less, control-only plugin that lets clients — on the **same PC** or a
**remote machine** — remotely operate a running QGIS process. It exposes QGIS
internals (`iface`, `QgsProject`, map canvas) as automation primitives
over file-JSONL and REST (`/api/*`).

## Features

- `pyeval` / `eval` / `screenshot` / `devreload` / `bridge_call` /
  `describe_plugins` primitives for remote control of all managed plugins
- Embedded HTTP server (`/api/*` REST)
- Built-in AI assistant panel (OpenAI-compatible / Anthropic / Gemini /
  Azure OpenAI / GitHub Copilot / ACP agents) with tool-loop execution
- Hot reload of managed plugins, GeoSuite shared toolbar (mode badge),
  layer_org layer-organization service, Deploy Mode switching

## Remote access (cross-machine)

By default the HTTP server binds to `127.0.0.1` (localhost only). To accept
connections from another machine, set these environment variables before QGIS
starts (or in the QGIS launch environment), then enable Remote Control:

| Variable | Meaning | Default |
| --- | --- | --- |
| `QGIS_LIVE_HOST` | Bind address; `0.0.0.0` = all interfaces | `127.0.0.1` |
| `QGIS_LIVE_PORT` | Fixed TCP port; `0` = auto-assign | `0` |
| `QGIS_LIVE_API_KEY` | Stable **Key** for remote clients (in addition to the per-session token) | *(unset)* |

A remote client connects to `http://<host>:<port>/api/*` with
`Authorization: Bearer <QGIS_LIVE_API_KEY>` (the "port + Key" form). When
`QGIS_LIVE_HOST` is a non-loopback address, the plugin also drops the
localhost Host/Origin guard. The effective host/port and token are written to
the registry file `~/.qgis-live/<pid>-geo_driver.json`.

> The per-session token (in the registry) still works for the local machine;
> `QGIS_LIVE_API_KEY` is the stable key to share with the second machine.

## Links

- Documentation: [docs/index.html](docs/index.html)
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- License: GPL-3.0 ([LICENSE](LICENSE))

## Disclaimer

This software was created and tested on a personal PC.
No liability is accepted for any damages arising from its use.

<p align="center">
  <a href="https://giphy.com/explore/free-gif" target="_blank">
    <img src="https://github.com/yamamoto-ryuzo/QGIS_portable_3x/raw/master/imgs/giphy.gif" width="500" title="avvio QGIS">
  </a>
</p>
