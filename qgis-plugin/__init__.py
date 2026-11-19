# SPDX-License-Identifier: GPL-3.0-or-later
# Based on QGIS Live Harness by yamamoto-ryuzo (GPL-3.0); modified.
"""dsh_qgis_driver — QGIS as an execution service for DSH.

There is no menu, no dock and no settings dialog. Enable the plugin (or start
QGIS from the DSH bundle) and it publishes a live dir plus a loopback token in
~/.qgis-live/; everything after that is driven through live_driver.py and
http_api.py. Disable the plugin in the QGIS plugin manager to stop the service.
"""

import json
import os
import tempfile
import time
import traceback

from .profile_store import registry_dir


def _log(msg):
    log = os.environ.get(
        "WEBENGINE_LOG_PATH",
        os.path.join(tempfile.gettempdir(), "plugin_load.log"),
    )
    try:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a", encoding="utf-8") as f:
            f.write(str(msg) + "\n")
    except Exception:  # nosec B110  # acceptable by design
        pass


def _http_allowed():
    """Return the exposed command kinds from QGIS_LIVE_TOOLS (None = allow all)."""
    raw = os.environ.get("QGIS_LIVE_TOOLS", "").strip()
    if raw and raw != "*":
        return {t.strip().lower().removeprefix("qgis_")
                for t in raw.split(",") if t.strip()}
    return None


def _restrict_file(path):
    """Restrict a file containing a token etc. to the current user (best-effort)."""
    try:
        if os.name == "nt":
            import shutil
            import subprocess  # nosec B404  # needed to run icacls
            user = os.environ.get("USERNAME") or ""
            exe = shutil.which("icacls") or os.path.join(
                os.environ.get("SystemRoot", r"C:\Windows"),
                "System32", "icacls.exe")
            if user:
                subprocess.run(  # nosec B603  # fixed args + USERNAME only
                    [exe, path, "/inheritance:r",
                     "/grant:r", f"{user}:F"],
                    capture_output=True, timeout=10)
        else:
            os.chmod(path, 0o600)
    except Exception:  # nosec B110  # acceptable by design
        pass


class DshQgisDriverPlugin:
    """Starts the driver and the loopback HTTP surface as soon as QGIS loads it."""

    def __init__(self, iface):
        self.iface = iface
        self.driver = None
        self._http = None
        self._reg_path = None

    def initGui(self):
        self._start()

    def unload(self):
        self._stop()

    def _start(self, base=None):
        # `base` lets a launcher (scripts/qgis-headless.py) put the command
        # channel somewhere other than ~/.qgis-live/run; the registry entry
        # below is always written to registry_dir(), which is where the client
        # looks for it.
        root = base or os.path.join(registry_dir(), "run")
        live_dir = os.path.join(root, f"qgis-{os.getpid()}", __package__)
        try:
            from .live_driver import LiveDriver
            self.driver = LiveDriver(live_dir, iface=self.iface)
        except Exception:
            _log("dsh_qgis_driver LiveDriver failed:\n"
                 + traceback.format_exc())
            return

        # Loopback only: the sole client is the DSH bundle on this machine, and
        # the per-session token written below is the whole auth story.
        host = "127.0.0.1"
        port = None
        try:
            from .http_api import start_http
            self._http, port = start_http(
                self.driver, port=0, token=self.driver.token,
                allowed=_http_allowed())
            self.driver.http_port = port
            self.driver.http_host = host
        except Exception:
            _log("dsh_qgis_driver HTTP failed:\n" + traceback.format_exc())

        try:
            os.makedirs(registry_dir(), exist_ok=True)
            self._reg_path = os.path.join(
                registry_dir(), f"{os.getpid()}-{__package__}.json")
            with open(self._reg_path, "w", encoding="utf-8") as f:
                json.dump({
                    "pid": os.getpid(),
                    "plugin_id": __package__,
                    "live_dir": live_dir,
                    "host": host,
                    "http_port": port,
                    "token": self.driver.token,
                    "gui": self.iface is not None,
                    "http_tools": (sorted(_http_allowed())
                                   if _http_allowed() else "all"),
                    "started": time.time(),
                }, f)
            # Contains the token, so restrict to the current user
            _restrict_file(self._reg_path)
            _restrict_file(os.path.join(live_dir, "token"))
        except Exception:
            _log("dsh_qgis_driver registry write failed:\n"
                 + traceback.format_exc())

    def _stop(self):
        if self._http is not None:
            try:
                self._http.shutdown()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._http = None
        if self.driver is not None:
            try:
                self.driver.stop()
            except Exception:  # nosec B110  # acceptable by design
                pass
            self.driver = None
        if self._reg_path is not None:
            try:
                os.remove(self._reg_path)
            except Exception:  # nosec B110  # acceptable by design
                pass
            self._reg_path = None


def classFactory(iface):  # noqa: N802 - QGIS entry point name
    return DshQgisDriverPlugin(iface)
