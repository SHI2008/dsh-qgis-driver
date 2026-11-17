# -*- coding: utf-8 -*-
"""Headless QGIS runtime for the dsh-qgis-driver bundle (no window, no GUI).

Started by ``start-qgis-headless.cmd``. It boots a ``QgsApplication`` without a
GUI, makes the Processing framework usable, loads the ``dsh_qgis_driver``
plugin from the QGIS profile plugin directory and hands control to Qt's event
loop so the plugin's live driver (file channel + REST) serves tool calls.

Only the tools that genuinely need a GUI (map canvas: set_extent /
zoom_to_layer / screenshot, or WebEngine) require the GUI launcher instead.
"""

import os
import sys
import traceback

PLUGIN_DIR = os.environ.get("QGIS_LIVE_PLUGIN_DIR", "")
if PLUGIN_DIR and PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from qgis.core import QgsApplication  # noqa: E402

app = QgsApplication([], False)
app.initQgis()

# Without the GUI the Processing plugin is not auto-loaded; put the bundled
# plugin directory on sys.path and initialise the framework so that
# `processing.run(...)` works in-process too.
try:
    import qgis  # noqa: F401

    _plugin_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(qgis.__file__))), "plugins")
    if os.path.isdir(_plugin_dir) and _plugin_dir not in sys.path:
        sys.path.insert(0, _plugin_dir)
    from processing.core.Processing import Processing

    Processing.initialize()
    print("[dsh-qgis-driver] processing initialized:", Processing.initialized())
except Exception:  # nosec B110 - Processing is optional
    traceback.print_exc()

pkg = os.environ.get("QGIS_LIVE_PLUGIN_PKG", "dsh_qgis_driver")
base = os.environ.get("WEBENGINE_LIVE_DIR") or os.path.join(
    os.path.expanduser("~"), ".qgis-live", "run")

try:
    mod = __import__(pkg)
    plugin = mod.classFactory(None)
    plugin._start(base)
except Exception:
    traceback.print_exc()
    sys.exit(3)

app.exec()
