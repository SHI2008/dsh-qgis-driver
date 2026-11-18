# -*- coding: utf-8 -*-
"""Headless QGIS runtime for the dsh-qgis-driver bundle (no window, no GUI).

Started **directly** by the bundle (``index.js`` → ``apps/Python312/python.exe``
with the OSGeo4W environment), never through a ``.cmd`` wrapper.

It boots a ``QgsApplication`` without a GUI, makes the Processing framework
usable, loads the ``dsh_qgis_driver`` plugin straight from the repository
(``QGIS_LIVE_PLUGIN_ROOT``, falling back to the QGIS profile plugin directory)
and hands control to Qt's event loop so the plugin's live driver (file channel +
REST) serves tool calls.

Only the tools that genuinely need a GUI (map canvas: set_extent /
zoom_to_layer / screenshot) require the GUI launcher instead.
"""

import importlib.util
import os
import sys
import traceback

PKG = os.environ.get("QGIS_LIVE_PLUGIN_PKG", "dsh_qgis_driver")
REPO_ROOT = os.environ.get("QGIS_LIVE_PLUGIN_ROOT", "")

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


def _load_from_repo():
    """Import the package straight from <repo>/qgis-plugin as `dsh_qgis_driver`."""
    if not REPO_ROOT:
        return None
    pkg_dir = os.path.join(REPO_ROOT, "qgis-plugin")
    init = os.path.join(pkg_dir, "__init__.py")
    if not os.path.isfile(init):
        return None
    spec = importlib.util.spec_from_file_location(
        PKG, init, submodule_search_locations=[pkg_dir])
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[PKG] = mod
    spec.loader.exec_module(mod)
    return mod


try:
    module = _load_from_repo()
    if module is None:
        module = __import__(PKG)
    plugin = module.classFactory(None)
    plugin._start(os.environ.get("WEBENGINE_LIVE_DIR") or os.path.join(
        os.path.expanduser("~"), ".qgis-live", "run"))
except Exception:
    traceback.print_exc()
    sys.exit(3)

# Keep the event loop alive: a bare QgsApplication.exec() returns as soon as the
# last window closes, which used to make the headless runtime exit mid-session.
from qgis.PyQt.QtCore import QTimer  # noqa: E402

_keepalive = QTimer()
_keepalive.start(1000)
app.exec()
