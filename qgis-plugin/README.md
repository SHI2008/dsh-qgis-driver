> **Core driver for QGIS Live Harness** — [QGIS Live Harness](https://yamamoto-ryuzo.github.io/qgis_live_harness/) · [Plugin list](https://yamamoto-ryuzo.github.io/qgis_live_harness/plugins.html) · [Documentation](https://github.com/yamamoto-ryuzo/qgis_live_harness/tree/master/qgis-plugin/dsh_qgis_driver/docs) · [Repository](https://github.com/yamamoto-ryuzo/qgis_live_harness)

# dsh-qgis-driver (`dsh_qgis_driver`)

> **Fork notice:** This repository is an independent fork of
> [yamamoto-ryuzo/qgis_live_harness](https://github.com/yamamoto-ryuzo/qgis_live_harness)
> (`qgis-plugin/dsh_qgis_driver`, upstream v0.16.2). It is maintained separately
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

## Local only

The HTTP server binds to `127.0.0.1` on a free port. There is no remote mode:
no bind-address variable, no fixed port, and no API key to share. The only
client is the DSH bundle on the same machine, and it reads the per-session
token from the registry file `~/.qgis-live/<pid>-dsh_qgis_driver.json`.

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
