"""Driver that controls the QGIS process externally through files (standalone version).

A control-surface-only implementation that works in any plugin/QGIS environment
without WebEngine. It has no view, so eval/devreload are unsupported (forwarding
to another plugin that has a view via plugin_id is possible). Instead,
screenshot renders iface.mapCanvas() to PNG.

Active only when the WEBENGINE_LIVE_DIR environment variable is set.
The live dir is WEBENGINE_LIVE_DIR/qgis-<pid>/<plugin_id>/.

Command format (one JSON object per line):
  {"id": 1, "type": "pyeval", "code": "iface.activeLayer().name()",
      "token": "contents of <live_dir>/token"}
  {"id": 2, "type": "screenshot", "path": "C:/.../shot.png",
      "token": "..."}  <- map canvas
  {"id": 3, "type": "status", "token": "..."}
  {"id": 4, "type": "open_plugin", "plugin_id": "<plugin_id>",
   "token": "..."}
  {"id": 5, "type": "reload_plugin", "plugin_id": "<plugin_id>",
   "token": "..."}
  {"id": 6, "type": "bridge_call", "plugin_id": "<plugin_id>",
   "method": "pluginInfo", "args": [], "token": "..."}
  {"id": 7, "type": "describe_plugins", "token": "..."}
      <- AI-usable capability catalog of all plugins (bridge + pluginInfo merged)
  {"id": 8, "type": "devin_run", "prompt": "...",
   "cwd": "C:/repo", "token": "..."}
      <- asynchronous start of the Devin CLI (devin -p). Tracked, fetched and
      aborted with devin_status/devin_result/devin_abort (devin_tasks.py)

Auth: a session token is generated at startup and written to live_dir/token and
the registry JSON (both with user-only ACLs). File-based
commands require a matching token; writes from other users on the same
machine or from unrelated processes are rejected. The HTTP surface uses the
same token for Bearer auth (see http_api.py).

Commands that use plugin_id as a "route" (eval/pyeval/screenshot/
devreload) are forwarded to that plugin's LiveDriver when plugin_id points at
another plugin, and the result returns to the caller's results.jsonl
(so this driver is the unified control point for all plugins).
"""

import concurrent.futures
import datetime
import hmac
import inspect
import itertools
import json
import os
import queue
import re
import secrets
import threading
import time
import traceback

from qgis.PyQt.QtCore import QTimer

from .profile_store import registry_dir

POLL_MS = 200

# Auto-numbering for commands without an id (HTTP /api/* etc.). In the target eval
# cid is the key matched against JS reports, so leaving it None drops all results
_AUTO_IDS = itertools.count(1)

# Live worker pools for pyeval_group. Kept referenced for as long as tasks are
# queued — a collected ThreadPoolExecutor would drop its pending work.
_GROUP_POOLS = []

# task_id -> Future for shards that have not started yet (cancel support).
_GROUP_FUTURES = {}

# Kinds that use plugin_id as their own command argument, not as a route.
# These are always handled by this driver itself.
_LOCAL_TYPES = {"status", "open_plugin", "reload_plugin", "bridge_call",
                "describe_plugins", "instruction", "pyeval_group", "task_cancel"}


def _to_jsonable(v):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, dict):
        return {str(k): _to_jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_to_jsonable(x) for x in v]
    return repr(v)


# ---- Audit log (~/.qgis-live/audit-<date>.jsonl) ----
# Persists every command that goes through _handle (file JSONL/REST/AI panel).
# secrets keys are masked as "***" and the session token is never recorded.
_AUDIT_MASK_KEYS = re.compile(
    r"token|secret|passw|api[-_]?key|authorization|credential", re.I)
_AUDIT_SUMMARY_LIMIT = 800
_AUDIT_ERROR_LIMIT = 300
_AUDIT_DEFAULT_MAX_BYTES = 5 * 1024 * 1024
_AUDIT_DEFAULT_MAX_FILES = 14


def _audit_base_dir():
    """Where the audit log lives (same registry dir as connection info and instructions)."""
    return registry_dir()


def _audit_conf():
    """(enabled, max_bytes, max_files). QSettings dsh_qgis_driver/audit/*."""
    enabled = True
    max_bytes = _AUDIT_DEFAULT_MAX_BYTES
    max_files = _AUDIT_DEFAULT_MAX_FILES
    try:
        from qgis.PyQt.QtCore import QSettings
        s = QSettings()
        enabled = str(s.value("dsh_qgis_driver/audit/enabled", True)).lower() \
            not in ("0", "false", "no")
        max_bytes = int(s.value("dsh_qgis_driver/audit/max_bytes", max_bytes))
        max_files = int(s.value("dsh_qgis_driver/audit/max_files", max_files))
    except Exception:  # nosec B110  # default values where QSettings is unavailable
        pass
    return enabled, max(int(max_bytes), 1024), max(int(max_files), 1)


def _audit_mask(v, key=None):
    if key is not None and _AUDIT_MASK_KEYS.search(str(key)):
        return "***"
    if isinstance(v, dict):
        return {str(k): _audit_mask(x, k) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_audit_mask(x) for x in v]
    return v


def _audit_summary(cmd):
    """Argument summary kept in the log. Internal keys (_*) are dropped, secrets masked."""
    body = {k: _audit_mask(v, k) for k, v in cmd.items()
            if k not in ("id", "type") and not k.startswith("_")}
    try:
        s = json.dumps(body, ensure_ascii=False, default=repr)
    except Exception:  # nosec B110  # fall back to repr when no summary is possible
        s = repr(body)
    if len(s) > _AUDIT_SUMMARY_LIMIT:
        s = s[:_AUDIT_SUMMARY_LIMIT] + "…"
    return s


def _audit_record(driver_pkg, cmd, obj, ms):
    """Append the audit record for one command to audit-<date>.jsonl."""
    enabled, max_bytes, max_files = _audit_conf()
    if not enabled:
        return
    base = _audit_base_dir()
    path = os.path.join(
        base, "audit-{0}.jsonl".format(datetime.date.today().isoformat()))
    ok = "error" not in obj
    rec = {
        "ts": datetime.datetime.now().isoformat(timespec="milliseconds"),
        "id": obj.get("id"),
        "type": cmd.get("type", "eval"),
        "plugin_id": cmd.get("plugin_id"),
        "method": cmd.get("method"),
        "args": _audit_summary(cmd),
        "origin": cmd.get("_origin") or "file",
        "driver": driver_pkg,
        "ok": ok,
        "ms": round(float(ms), 1),
    }
    if not ok:
        rec["error"] = str(obj.get("error"))[:_AUDIT_ERROR_LIMIT]
    line = json.dumps(rec, ensure_ascii=False) + "\n"
    os.makedirs(base, exist_ok=True)
    # When the size limit is exceeded, rotate to a timestamped generation and start new
    if os.path.exists(path) and os.path.getsize(path) > max_bytes:
        stamp = datetime.datetime.now().strftime("%H%M%S")
        try:
            os.replace(path, path[:-6] + "-" + stamp + ".jsonl")
        except OSError:
            pass
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
    # Generation cap: keep only max_files, in descending filename order (newest first)
    names = sorted((n for n in os.listdir(base)
                    if n.startswith("audit-") and n.endswith(".jsonl")),
                   reverse=True)
    for old in names[max_files:]:
        try:
            os.remove(os.path.join(base, old))
        except OSError:
            pass


def _audit_match(rec, filt):
    """Filter for auditLog. dict = field match, str = substring match on key fields."""
    if filt in (None, ""):
        return True
    if isinstance(filt, dict):
        for k, v in filt.items():
            rv = rec.get(k)
            if rv is None or isinstance(rv, bool) or isinstance(v, bool):
                if rv != v:
                    return False
            elif str(v).lower() not in str(rv).lower():
                return False
        return True
    s = str(filt).lower()
    return any(s in str(rec.get(k) or "").lower()
               for k in ("type", "method", "plugin_id", "origin", "id"))


def _audit_recent(n, filt=None):
    """Return up to n entries from audit-*.jsonl, newest first (for the auditLog bridge)."""
    try:
        names = sorted(
            (x for x in os.listdir(_audit_base_dir())
             if x.startswith("audit-") and x.endswith(".jsonl")),
            reverse=True)
    except OSError:
        return []
    out = []
    for name in names:
        try:
            with open(os.path.join(_audit_base_dir(), name),
                      "r", encoding="utf-8") as f:
                lines = f.readlines()
        except OSError:
            continue
        for line in reversed(lines):
            try:
                rec = json.loads(line)
            except Exception:  # nosec B110  # skip corrupt lines
                continue
            if _audit_match(rec, filt):
                out.append(rec)
                if len(out) >= n:
                    return out
    return out


def _loaded_plugins():
    import qgis.utils
    return qgis.utils.plugins


def _plugin_metadata(pid, key):
    """Read a value from the plugin's metadata.txt (None on failure)."""
    try:
        import qgis.utils
        v = qgis.utils.pluginMetadata(pid, key)
        return v if v else None
    except Exception:
        return None


def reload_plugin_now(plugin_id):
    """Clear the sys.modules cache, reloadPlugin, and reopen open_dialog.

    Shared by the reload_plugin command and the menu hot reload (hot_reload.py).
    The caller's code frame stays valid after the reload, so
    plugin_id may be this plugin itself (dsh_qgis_driver).
    """
    import sys
    import qgis.utils
    for k in [k for k in list(sys.modules)
              if k == plugin_id or k.startswith(plugin_id + ".")]:
        sys.modules.pop(k, None)
    if plugin_id in qgis.utils.plugins:
        qgis.utils.reloadPlugin(plugin_id)
    else:
        qgis.utils.loadPlugin(plugin_id)
        qgis.utils.startPlugin(plugin_id)
    p = qgis.utils.plugins.get(plugin_id)
    opened = False
    if (p is not None and hasattr(p, "open_dialog")
            and getattr(p, "open_dialog_on_reload", True)):
        p.open_dialog()
        opened = True
    return {
        "loaded": plugin_id in qgis.utils.plugins,
        "opened": opened,
        "plugins": sorted(qgis.utils.plugins.keys()),
    }


class _GenericBridge:
    """Generic adapter for plugins without a bridge.

    Third-party plugins outside the repo (mmqgis etc.) cannot have their own
    bridge.py, so the driver provides a minimal common control surface.
    Methods return JSON strings like a dedicated bridge.

    - `pluginInfo` / `status` / `actions` / `trigger` / `run` /
      `openDialog` / `closeDialog`
    - `run`/`trigger` fire asynchronously through QTimer.singleShot(0, ...), so a
        command reply is not blocked even when the target opens a modal dialog
    """

    _DLG_ATTRS = ("dialog", "dlg", "dockwidget", "dock_widget", "dock")

    def __init__(self, plugin_id, plugin):
        self._pid = plugin_id
        self._plugin = plugin

    @staticmethod
    def _ok(payload=None):
        obj = {"ok": True, "generic": True}
        if payload:
            obj.update(payload)
        return json.dumps(obj, ensure_ascii=False)

    @staticmethod
    def _err(msg):
        return json.dumps({"ok": False, "generic": True, "error": str(msg)},
                          ensure_ascii=False)

    def _find_dialog(self):
        for a in self._DLG_ATTRS:
            w = getattr(self._plugin, a, None)
            if w is not None and hasattr(w, "show"):
                return w
        return None

    def _actions(self):
        from qgis.PyQt.QtWidgets import QAction
        acts = getattr(self._plugin, "actions", None) or []
        return [a for a in acts if isinstance(a, QAction)]

    # ---------- Methods (return JSON strings) ----------

    def pluginInfo(self):
        """Self-description from metadata plus the generic method list."""
        return self._ok({
            "id": self._pid,
            "name": _plugin_metadata(self._pid, "name") or self._pid,
            "version": _plugin_metadata(self._pid, "version"),
            "summary": _plugin_metadata(self._pid, "description"),
            "when_to_use": [
                "Run this plugin's menu / toolbar actions",
                "Open or close a plugin's dialogs or docks",
                "Do minimal control of a plugin that has no dedicated bridge",
            ],
            "invoke": {"type": "bridge_call", "plugin_id": self._pid,
                       "method": "<method>", "args": []},
            "methods": [
                {"name": "pluginInfo", "signature": "pluginInfo()",
                 "description": "Return the metadata-derived self-description"},
                {"name": "status", "signature": "status()",
                 "description": "Return state such as dialog presence and action count"},
                {"name": "actions", "signature": "actions()",
                 "description": "List the plugin's QActions (index/text/enabled)"},
                {"name": "trigger", "signature": "trigger(action)",
                 "description": "Run an action asynchronously (index/text; returns immediately even if a "
                                "modal dialog opens)"},
                {"name": "run", "signature": "run()",
                 "description": "Run plugin.run() asynchronously (returns immediately even if a modal "
                                "dialog opens)"},
                {"name": "openDialog", "signature": "openDialog()",
                 "description": "Show the widget in the dialog/dlg/dockwidget attribute (falls back to "
                                "async run())"},
                {"name": "closeDialog", "signature": "closeDialog()",
                 "description": "Close the widget in the dialog/dlg/dockwidget attribute"},
            ],
        })

    def status(self):
        """Return the plugin state (dialog present, action count, version)."""
        dlg = self._find_dialog()
        return self._ok({
            "id": self._pid,
            "version": _plugin_metadata(self._pid, "version"),
            "widget": dlg.__class__.__name__ if dlg is not None else None,
            "widgetVisible": bool(dlg is not None and dlg.isVisible()),
            "actions": len(self._actions()),
            "has_run": callable(getattr(self._plugin, "run", None)),
        })

    def actions(self):
        """Return the plugin's QAction list."""
        out = []
        for i, a in enumerate(self._actions()):
            try:
                out.append({"index": i, "text": a.text(),
                            "enabled": a.isEnabled(),
                            "checkable": a.isCheckable()})
            except Exception:
                out.append({"index": i, "text": None})
        return self._ok({"actions": out})

    def trigger(self, action):
        """Run an action asynchronously (by index/text)."""
        acts = self._actions()
        target = None
        if isinstance(action, bool):
            return self._err("invalid action selector")
        if isinstance(action, int):
            if -len(acts) <= action < len(acts):
                target = acts[action]
        else:
            s = str(action or "")
            for a in acts:
                if a.text() == s:
                    target = a
                    break
            if target is None:
                for a in acts:
                    if s and s in a.text():
                        target = a
                        break
        if target is None:
            return self._err(
                f"action not found: {action} "
                f"(have: {[a.text() for a in acts]})")
        QTimer.singleShot(0, target.trigger)
        return self._ok({"triggered": target.text(), "async": True})

    def run(self):
        """Run plugin.run() asynchronously."""
        fn = getattr(self._plugin, "run", None)
        if not callable(fn):
            return self._err("plugin has no run()")
        QTimer.singleShot(0, fn)
        return self._ok({"started": True, "async": True})

    def openDialog(self):
        """Show the widget held in the dialog/dlg/dockwidget attribute."""
        dlg = self._find_dialog()
        if dlg is not None:
            dlg.show()
            try:
                dlg.raise_()
                dlg.activateWindow()
            except Exception:  # nosec B110  # acceptable by design
                pass
            return self._ok({"opened": True,
                             "widget": dlg.__class__.__name__})
        fn = getattr(self._plugin, "run", None)
        if callable(fn):
            QTimer.singleShot(0, fn)
            return self._ok({"opened": True, "via": "run", "async": True})
        return self._err("no dialog/dockwidget attribute and no run()")

    def closeDialog(self):
        """Close the widget held in the dialog/dlg/dockwidget attribute."""
        dlg = self._find_dialog()
        if dlg is None:
            return self._err("no dialog/dockwidget attribute")
        try:
            dlg.close()
        except Exception:
            dlg.hide()
        return self._ok({"closed": True,
                         "widget": dlg.__class__.__name__})


def _find_plugin_driver(plugin_id):
    """Return another plugin's LiveDriver (None if absent)."""
    p = _loaded_plugins().get(plugin_id)
    if p is None:
        return None
    for attr in ("driver", "_live", "live"):
        d = getattr(p, attr, None)
        if d is not None and hasattr(d, "_handle"):
            return d
    return None


class TaskRegistry:
    """Registry of background pyeval tasks for the async channel.

    Pure Python (no QGIS objects). A daemon thread runs the code in a fresh
    namespace and writes the result here; a finished task is popped on its
    first read so it is returned exactly once. Stale running tasks are dropped
    by cleanup() after ttl seconds.
    """

    def __init__(self, ttl=3600.0):
        self._tasks = {}
        self._lock = threading.Lock()
        self._ttl = ttl

    def new(self, name=None, status="running"):
        task_id = secrets.token_hex(12)
        with self._lock:
            self._tasks[task_id] = {
                "task_id": task_id,
                "name": name or "",
                "status": status,
                "result": None,
                "error": None,
                "created": time.monotonic(),
            }
        return task_id

    def set_status(self, task_id, status):
        with self._lock:
            t = self._tasks.get(task_id)
            if t is not None and t["status"] not in ("done", "error", "cancelled"):
                t["status"] = status

    def finish(self, task_id, result=None, error=None):
        with self._lock:
            t = self._tasks.get(task_id)
            if t is not None:
                t["status"] = "error" if error else "done"
                t["result"] = result
                t["error"] = error

    def abort(self, task_id, status="cancelled", reason=None):
        """Cancel a task. Only a task that has not started yet can be stopped.

        A queued task is marked cancelled before a worker ever touches it; a
        running one cannot be interrupted (threads cannot be killed in Python),
        so it only records the request and finishes on its own.
        """
        with self._lock:
            t = self._tasks.get(task_id)
            if t is None:
                return {"task_id": task_id, "cancelled": False, "was": None,
                        "reason": "task not found (already read, or expired)"}
            was = t["status"]
            if was == "queued":
                t["status"] = status
                t["error"] = reason or "cancelled before it started"
                return {"task_id": task_id, "cancelled": True, "was": was,
                        "status": status}
            if was == "running":
                t["cancel_requested"] = True
                return {"task_id": task_id, "cancelled": False, "was": was,
                        "status": was,
                        "reason": "already running: Python cannot stop a thread, "
                                  "it will finish on its own"}
            return {"task_id": task_id, "cancelled": False, "was": was,
                    "status": was, "reason": f"task already {was}"}

    def is_cancelled(self, task_id):
        with self._lock:
            t = self._tasks.get(task_id)
            return t is not None and t["status"] == "cancelled"

    def stop_requested(self, task_id):
        """True when the task should stop: cancelled while queued, or a running one was asked.

        The running branch is cooperative: the snippet has to poll
        ``dsh_should_stop()`` for it to have any effect.
        """
        with self._lock:
            t = self._tasks.get(task_id)
            if t is None:
                return False
            return t["status"] == "cancelled" or bool(t.get("cancel_requested"))

    def get(self, task_id):
        """Return a running task's snapshot, or pop a finished task (one read)."""
        with self._lock:
            t = self._tasks.get(task_id)
            if t is None:
                return None
            if t["status"] in ("done", "error", "cancelled"):
                return self._tasks.pop(task_id)
            return dict(t)

    def cleanup(self):
        now = time.monotonic()
        with self._lock:
            stale = [k for k, v in self._tasks.items()
                     if now - v["created"] > self._ttl
                     and v["status"] in ("running", "queued", "cancelled")]
            for k in stale:
                self._tasks.pop(k, None)


class LiveDriver:
    def __init__(self, live_dir, iface):
        self.iface = iface
        self.view = None  # no WebEngine; clients can check UI presence through ns
        self.dir = live_dir
        self.cmd_path = os.path.join(live_dir, "commands.jsonl")
        self.res_path = os.path.join(live_dir, "results.jsonl")
        self.http_port = None  # set by __init__.py after start_http
        self.http_host = None  # set by __init__.py after start_http
        # Skip to the end so past commands are not re-executed when the driver is rebuilt
        self.offset = os.path.getsize(self.cmd_path) if os.path.exists(self.cmd_path) else 0
        # Auth token shared by all channels. commands.jsonl can be appended by
        # anyone on the same machine, so file-based commands require this
        # match. Clients read it from live_dir/token or the registry
        # JSON (both aim for user-only ACLs)
        self.token = secrets.token_hex(24)
        self._ns = {"iface": iface, "view": None, "driver": self}
        # Pre-import the QGIS APIs frequently used in pyeval (for convenience)
        try:
            from qgis.core import QgsProject, QgsApplication
            self._ns.update({"QgsProject": QgsProject,
                             "QgsApplication": QgsApplication})
        except Exception:  # nosec B110  # acceptable by design
            pass
        # Non-file command input (injected from other threads such as the HTTP server).
        # iface/QgsProject must not be touched off the GUI thread, so
        # execution always happens inside this driver's _poll (GUI thread)
        self._queue = queue.Queue()
        self.tasks = TaskRegistry()
        os.makedirs(live_dir, exist_ok=True)
        try:
            with open(os.path.join(live_dir, "token"), "w",
                      encoding="ascii") as f:
                f.write(self.token)
        except Exception:  # nosec B110  # acceptable by design
            pass

        self.timer = QTimer()
        self.timer.timeout.connect(self._poll)
        self.timer.start(POLL_MS)

    def submit(self, cmd, timeout=180.0, origin=None):
        """Inject a command from another thread, wait for GUI-thread execution, return it.

        @returns {"id":..., "result": v} or {"id":..., "error": e}
        """
        if cmd.get("id") is None:
            cmd["id"] = f"submit-{next(_AUTO_IDS)}"
        cmd.setdefault("_origin", origin or "api")
        box = {}
        done = threading.Event()
        self._queue.put((cmd, box, done))
        if not done.wait(timeout):
            return {"id": cmd.get("id"), "error": f"submit timeout ({timeout}s)"}
        return box.get("reply", {"id": cmd.get("id"), "error": "no reply"})

    def stop(self):
        self.timer.stop()
        # timer.timeout.connect(bound method) holds a reference to self,
        # so the driver and QTimer linger across reloads; also release the C++ side
        self.timer.deleteLater()

    def _poll(self):
        # Handle the in-memory queue (HTTP etc.) first
        while True:
            try:
                cmd, box, done = self._queue.get_nowait()
            except queue.Empty:
                break
            # Complete once reply is called. If _handle returned "async" (eval forwarding etc.),
            # reply is called later asynchronously, so do not done.set() here

            def _reply_once(obj, _box=box, _done=done):
                _box["reply"] = obj
                _done.set()
            try:
                async_pending = self._handle(cmd, reply=_reply_once) == "async"
            except Exception:
                async_pending = False
                box["reply"] = {"id": cmd.get("id"),
                                "error": traceback.format_exc()}
            if not async_pending and not done.is_set():
                done.set()

        if not os.path.exists(self.cmd_path):
            return
        # If the file is recreated, offset may exceed the real size and skip lines, so fix it up
        if os.path.getsize(self.cmd_path) < self.offset:
            self.offset = 0
        with open(self.cmd_path, "r", encoding="utf-8") as f:
            f.seek(self.offset)
            data = f.read()
        # Processing a partial line while the client is writing causes JSONDecodeError
        # and command loss, so only process newline-terminated lines and
        # leave an unfinished tail in place (offset does not advance) for the next poll
        end = data.rfind("\n")
        if end < 0:
            return
        self.offset += end + 1
        for line in data[:end].split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except Exception as e:
                self._reply({"id": None, "error": repr(e)})
                continue
            # File-based commands require the token. submit() (via HTTP) and
            # _forward() (via another driver) are already authenticated by the caller
            cmd["_origin"] = "file"
            if not hmac.compare_digest(str(cmd.get("token") or ""),
                                       self.token):
                self._audit(cmd, {"id": cmd.get("id"),
                                  "error": "unauthorized"}, 0.0)
                self._reply({"id": cmd.get("id"), "error": "unauthorized"})
                continue
            try:
                self._handle(cmd)
            except Exception as e:
                self._reply({"id": None, "error": repr(e)})

    def _handle(self, cmd, reply=None):
        """Entry point for commands. Records the audit log, then hands over to _dispatch.

        With _audit_off set (forwarding from another driver) no audit is recorded
        -- the forwarding driver already recorded it, avoiding duplicates.
        """
        reply = reply or self._reply
        if cmd.get("_audit_off"):
            return self._dispatch(cmd, reply)
        t0 = time.monotonic()

        def _audited(obj, _reply=reply):
            self._audit(cmd, obj, (time.monotonic() - t0) * 1000.0)
            _reply(obj)
        try:
            return self._dispatch(cmd, _audited)
        except Exception:
            self._audit(cmd, {"id": cmd.get("id"),
                              "error": traceback.format_exc()},
                        (time.monotonic() - t0) * 1000.0)
            raise

    def _audit(self, cmd, obj, ms):
        """Record the dispatch result in the audit jsonl (failures do not block the call)."""
        try:
            _audit_record(__package__, cmd, obj, ms)
        except Exception:  # nosec B110  # an audit failure must not stop the control surface
            pass

    def _dispatch(self, cmd, reply):
        cid = cmd.get("id") or f"auto-{next(_AUTO_IDS)}"
        ctype = cmd.get("type", "eval")
        pid = cmd.get("plugin_id")
        # devin_*/copilot_* are always handled by this driver
        # (never forwarded to other plugins)
        if ctype.startswith("devin_") or ctype.startswith("copilot_"):
            self._agent_task(cid, ctype, cmd, reply)
            return
        # Commands whose plugin_id points at another plugin are forwarded to that driver.
        # Results return to this live dir's results.jsonl through the injected reply.
        if pid and pid != __package__ and ctype not in _LOCAL_TYPES:
            return self._forward(cid, pid, cmd, reply)
        if ctype == "pyeval":
            self._pyeval(cid, cmd.get("code", ""), reply)
            return
        if ctype == "pyeval_async":
            self._pyeval_async(cid, cmd.get("code", ""), reply)
            return
        if ctype == "pyeval_group":
            self._pyeval_group(cid, cmd, reply)
            return
        if ctype == "task_status":
            self._task_status(cid, cmd.get("task_id", ""), reply)
            return
        if ctype == "task_cancel":
            self._task_cancel(cid, cmd, reply)
            return
        if ctype == "screenshot":
            self._screenshot(cid, cmd, reply)
            return
        if ctype == "status":
            reply({"id": cid, "result": self._status()})
            return
        if ctype == "open_plugin":
            self._open_plugin(cid, pid, reply)
            return
        if ctype == "reload_plugin":
            self._reload_plugin(cid, pid, reply)
            return
        if ctype == "bridge_call":
            self._bridge_call(cid, cmd, reply)
            return
        if ctype == "describe_plugins":
            self._describe_plugins(cid, reply)
            return
        if ctype == "instruction":
            self._instruction(cid, cmd, reply)
            return
        reply({
            "id": cid,
            "error": f"type={ctype} unsupported: dsh_qgis_driver has no WebEngine view. "
            "pass plugin_id of a WebEngine plugin to route "
            "(eval/devreload/screenshot), or use "
            "pyeval/status/open_plugin/reload_plugin/bridge_call/"
            "describe_plugins/devin_*",
        })

    def _forward(self, cid, pid, cmd, reply):
        """Forward a command to another plugin's driver and return the result to the caller."""
        drv = _find_plugin_driver(pid)
        if drv is None:
            reply({"id": cid, "error":
                   f"plugin '{pid}' has no live driver "
                   f"(loaded: {sorted(_loaded_plugins().keys())})"})
            return
        if "reply" not in inspect.signature(drv._handle).parameters:
            reply({"id": cid, "error":
                   f"plugin '{pid}' driver does not support reply routing; "
                   "redeploy+reload it to update live_driver.py"})
            return
        fwd = {k: v for k, v in cmd.items() if k != "plugin_id"}
        # The forwarding driver records the audit, so suppress it at the destination
        fwd["_audit_off"] = True
        try:
            return drv._handle(fwd, reply=reply)
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _instruction(self, cid, cmd, reply):
        """Instruction (agents/skills) operations. The body of the qgis_instruction tool.

        Pure file I/O with no GUI dependency, but handled through the GUI-thread
        dispatch like other commands (ai_client is in this plugin).
        """
        try:
            from . import ai_client
            op = cmd.get("op") or ""
            kind = cmd.get("kind") or ""
            if kind not in ("agents", "skills", "prompts"):
                reply({"id": cid,
                       "error": "kind must be agents|skills|prompts: "
                                f"{kind!r}"})
                return
            if op == "list":
                reply({"id": cid, "result":
                       ai_client.list_instruction_files(kind)})
            elif op == "read":
                body = ai_client.load_instruction(
                    kind, cmd.get("id") or "")
                if body is None:
                    reply({"id": cid, "error":
                           f"{kind} '{cmd.get('id')}' not found"})
                else:
                    reply({"id": cid, "result": body})
            elif op == "save":
                p = ai_client.save_instruction(
                    kind, cmd.get("name") or "", cmd.get("text") or "")
                reply({"id": cid, "result": f"saved: {p}"})
            elif op == "delete":
                if ai_client.delete_instruction(
                        kind, cmd.get("id") or ""):
                    reply({"id": cid, "result":
                           f"deleted: {kind}/{cmd.get('id')}"})
                else:
                    reply({"id": cid, "error":
                           f"cannot delete {kind} '{cmd.get('id')}' "
                           "(missing or bundled)"})
            else:
                reply({"id": cid,
                       "error": f"op must be list|read|save|delete: {op!r}"})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _agent_task(self, cid, ctype, cmd, reply):
        """Body of the qgis_devin_*/qgis_copilot_* tools.
        Async task management for the agent CLIs (devin -p / copilot -p / acp).

        Startup and status checks do not block (Popen/log reads only), so
        they may be handled through the GUI-thread dispatch like other commands.
        """
        from . import devin_tasks
        try:
            agent, _, op = ctype.partition("_")  # devin_run→(devin,run)
            if op == "run":
                reply({"id": cid, "result": devin_tasks.run(
                    cmd.get("prompt") or "", cwd=cmd.get("cwd"),
                    session_id=cmd.get("session_id"),
                    model=cmd.get("model"),
                    permission_mode=(cmd.get("permission_mode")
                                     or "dangerous"),
                    engine=cmd.get("engine") or "auto",
                    agent=agent,
                    live_dir=self.dir)})
            elif op == "status":
                reply({"id": cid, "result": devin_tasks.status(
                    cmd.get("task_id"))})
            elif op == "result":
                reply({"id": cid, "result": devin_tasks.result(
                    cmd.get("task_id") or "",
                    tail=cmd.get("tail") or 20000)})
            elif op == "abort":
                reply({"id": cid, "result": devin_tasks.abort(
                    cmd.get("task_id") or "")})
            else:
                reply({"id": cid, "error":
                       f"op must be run|status|result|abort: {ctype!r}"})
        except devin_tasks.TaskError as e:
            reply({"id": cid, "error": str(e)})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _status(self):
        """Return the state of the driver itself and all plugins (liveness check/list)."""
        plugs = {}
        try:
            for pid, p in _loaded_plugins().items():
                drv = None
                for a in ("driver", "_live", "live"):
                    d = getattr(p, a, None)
                    if d is not None and hasattr(d, "_handle"):
                        drv = d
                        break
                plugs[pid] = {
                    "driver": drv is not None,
                    "view": bool(drv is not None
                                 and getattr(drv, "view", None) is not None),
                    "bridge": getattr(p, "bridge", None) is not None,
                }
        except Exception:  # nosec B110  # acceptable by design
            pass
        return {
            "pid": os.getpid(),
            "plugin": __package__,
            "live_dir": self.dir,
            "host": self.http_host,
            "http_port": self.http_port,
            "view": self.view is not None,
            "plugins": plugs,
        }

    def _open_plugin(self, cid, pid, reply):
        """Load/start a plugin and open open_dialog if present."""
        if not pid:
            reply({"id": cid, "error": "plugin_id required"})
            return
        try:
            import qgis.utils
            if pid not in qgis.utils.plugins:
                qgis.utils.loadPlugin(pid)
                qgis.utils.startPlugin(pid)
            p = qgis.utils.plugins.get(pid)
            opened = False
            if p is not None and hasattr(p, "open_dialog"):
                p.open_dialog()
                opened = True
            reply({"id": cid, "result": {
                "loaded": pid in qgis.utils.plugins,
                "opened": opened,
                "plugins": sorted(qgis.utils.plugins.keys()),
            }})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _reload_plugin(self, cid, pid, reply):
        """Clear the sys.modules cache, reloadPlugin, and reopen the dialog.

        Reloading this plugin (dsh_qgis_driver) itself is allowed: this driver is
        unloaded and re-created while running, but the caller's code frame stays
        valid, so the result can be written to results.jsonl after the reload.
        """
        if not pid:
            reply({"id": cid, "error": "plugin_id required"})
            return
        try:
            reply({"id": cid, "result": reload_plugin_now(pid)})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    @staticmethod
    def _bridge_args(fn, args):
        """Normalize bridge_call args into (positional args, kwargs).

        Absorb cases where the model passes kwargs:
        - args={"k": v, ...}      (a dict, not a list)
        - args=[{"k": v, ...}]    (a list with a single dict)
        - args=[pos..., {"k": v}] (trailing dict = kwargs for the remaining params)
        Only when the trailing dict's keys fit the unbound parameter names is it
        turned into kwargs; otherwise the dict (a normal dict argument) is passed
        as a positional argument as before.
        """
        if isinstance(args, dict):
            pos, cand = [], dict(args)
        else:
            pos = list(args)
            cand = pos.pop() if pos and isinstance(pos[-1], dict) else None
        if not cand:
            return list(args) if isinstance(args, (list, tuple)) else [], {}
        try:
            params = inspect.signature(fn).parameters
        except (TypeError, ValueError):
            return args, {}
        has_varkw = any(p.kind == inspect.Parameter.VAR_KEYWORD
                        for p in params.values())
        names = [n for n, p in params.items()
                 if p.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD,
                               inspect.Parameter.KEYWORD_ONLY)]
        bound = set(names[:len(pos)])
        if has_varkw or (set(cand) <= set(names) and not set(cand) & bound):
            return pos, cand
        return args, {}

    def _bridge_call(self, cid, cmd, reply):
        """Call a method of a plugin's bridge object directly in-process.

        Unlike JS's BridgeClient.callJson it does not go through WebChannel, so
        bridge methods can be verified even while the renderer is starved.
        Following the convention that bridge methods return JSON strings, parse and
        return them structured when possible. plugin_id defaults to the first bridge plugin.
        """
        pid = cmd.get("plugin_id")
        method = cmd.get("method")
        args = cmd.get("args") or []
        try:
            plugins = _loaded_plugins()
            target = plugins.get(pid) if pid else None
            if target is None:
                target = next(
                    (p for p in plugins.values()
                     if getattr(p, "bridge", None) is not None), None)
            if target is None:
                reply({"id": cid, "error":
                       f"plugin '{pid}' not loaded "
                       f"(loaded: {sorted(plugins.keys())})"})
                return
            # Plugins without a dedicated bridge get a minimal control surface via the adapter
            bridge = getattr(target, "bridge", None)
            if bridge is None:
                gpid = next((k for k, v in plugins.items() if v is target),
                            pid)
                bridge = _GenericBridge(gpid, target)
            fn = getattr(bridge, method, None) if bridge is not None else None
            if not callable(fn):
                reply({"id": cid, "error":
                       f"no bridge method '{method}'. methods: "
                       f"{[m for m in dir(bridge) if not m.startswith('_')] if bridge else 'no bridge'}"})
                return
            b_args, b_kwargs = self._bridge_args(fn, args)
            res = fn(*b_args, **b_kwargs)
            if isinstance(res, str):
                try:
                    res = json.loads(res)
                except Exception:  # nosec B110  # acceptable by design
                    pass
            reply({"id": cid, "result": _to_jsonable(res)})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _describe_plugins(self, cid, reply):
        """Return a catalog of the plugins available to the AI.

        Enumerates all loaded plugins and, for those with a bridge, calls
        pluginInfo() to aggregate the self-description (id/name/summary/when_to_use/
        methods). The entry point through which the AI discovers "which plugin to use
        when and how".
        """
        try:
            out = []
            for pid, p in sorted(_loaded_plugins().items()):
                entry = {"id": pid}
                bridge = getattr(p, "bridge", None)
                entry["bridge"] = bridge is not None
                if bridge is None:
                    # Carry the metadata-derived self-description through the generic adapter
                    # so the AI can also discover and operate plugins without a bridge
                    bridge = _GenericBridge(pid, p)
                    entry["generic"] = True
                if bridge is not None:
                    info = getattr(bridge, "pluginInfo", None)
                    if callable(info):
                        try:
                            res = info()
                            if isinstance(res, str):
                                try:
                                    res = json.loads(res)
                                except Exception:  # nosec B110  # acceptable by design
                                    pass
                            entry["info"] = _to_jsonable(res)
                        except Exception:
                            entry["info_error"] = traceback.format_exc()
                    else:
                        entry["methods"] = sorted(
                            m for m in dir(bridge)
                            if not m.startswith("_")
                            and callable(getattr(bridge, m)))
                out.append(entry)
            reply({"id": cid, "result": {
                "pid": os.getpid(),
                "plugins": out,
            }})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _screenshot(self, cid, cmd, reply):
        """Save the map canvas (default) or the main window as PNG."""
        path = cmd.get("path") or os.path.join(self.dir, f"shot-{cid}.png")
        target = cmd.get("target", "canvas")
        try:
            if target == "canvas":
                canvas = self.iface.mapCanvas() if self.iface is not None else None
                if canvas is None:
                    reply({"id": cid, "error": "no map canvas"})
                    return
                canvas.saveAsImage(path)
            elif target in ("mainwindow", "main"):
                if self.iface is None:
                    reply({"id": cid, "error": "no iface"})
                    return
                self.iface.mainWindow().grab().save(path)
            else:
                reply({"id": cid, "error":
                       f"unknown screenshot target: {target} "
                       "(canvas|mainwindow)"})
                return
            reply({"id": cid, "result": path})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _pyeval(self, cid, code, reply=None):
        """Run Python inside the QGIS process.

        If it compiles as an expression, eval it and return the result. For statements
        exec them and return the value of `result` in the namespace (None if unset).
        Runs synchronously, so long code blocks the event loop.
        When forwarded with a plugin_id, it runs in that plugin driver's
        namespace (view etc.).
        """
        reply = reply or self._reply
        self._ns.pop("result", None)
        try:
            try:
                code_obj = compile(code, "<pyeval>", "eval")
            except SyntaxError:
                code_obj = compile(code, "<pyeval>", "exec")
            res = eval(code_obj, self._ns)  # nosec B307  # arbitrary Python execution is intended
            if res is None:
                res = self._ns.pop("result", None)
            reply({"id": cid, "result": _to_jsonable(res)})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _pyeval_async(self, cid, code, reply):
        """Start a background pyeval task and return its task_id immediately.

        The code runs in a fresh pure-Python namespace (no QGIS objects), so it
        cannot touch iface/QgsProject and never blocks the GUI thread. Poll the
        result with task_status (GET /api/tasks/<id>).
        """
        try:
            task_id = self.submit_pyeval_async(code)
            reply({"id": cid, "result": {"task_id": task_id,
                                         "status": "running"}})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _pyeval_group(self, cid, cmd, reply):
        """Start several background pyeval tasks through one bounded worker pool.

        Unlike pyeval_async (one daemon thread per task, unbounded), every task
        here is queued in a pool of at most max_workers threads, so a long
        processing split over many shards cannot oversubscribe the machine.
        Tasks register immediately as queued and go running as workers pick
        them up; poll each task_id with task_status.
        """
        try:
            started = self.submit_pyeval_group(cmd.get("tasks"), cmd.get("max_workers"))
            reply({"id": cid, "result": {"tasks": started, "count": len(started)}})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _task_cancel(self, cid, cmd, reply):
        """Cancel background tasks: queued shards stop, running ones only note it."""
        try:
            ids = cmd.get("task_ids") or []
            if isinstance(ids, str):
                ids = [ids]
            if not ids and cmd.get("task_id"):
                ids = [cmd["task_id"]]
            if not ids:
                reply({"id": cid, "error": "task_id or task_ids required"})
                return
            results = []
            for tid in ids:
                fut = _GROUP_FUTURES.get(tid)
                if fut is not None:
                    try:
                        fut.cancel()          # stops a shard still waiting in the pool
                    except Exception:
                        pass
                    if fut.cancelled() or fut.done():
                        _GROUP_FUTURES.pop(tid, None)
                results.append(self.tasks.abort(tid))
            reply({"id": cid, "result": {"count": len(results), "results": results}})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _task_status(self, cid, task_id, reply):
        """Return one background task's state (popping a finished task)."""
        try:
            if not task_id:
                reply({"id": cid, "error": "task_id required"})
                return
            self.tasks.cleanup()
            t = self.tasks.get(task_id)
            if t is None:
                reply({"id": cid, "error": f"task not found: {task_id}"})
                return
            reply({"id": cid, "result": t})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def submit_pyeval_async(self, code):
        """Run code in a daemon thread (pure Python) and return its task_id.

        Returns the task_id immediately; the caller polls task_status. The
        async namespace is isolated from the QGIS process (no iface/QgsProject).
        """
        task_id = self.tasks.new()
        threading.Thread(target=self._run_task, args=(task_id, code),
                         daemon=True).start()
        return task_id

    def _run_task(self, task_id, code, tag="<pyeval_async>"):
        """Execute one pure-Python snippet for a registered task and record the outcome.

        The one place that knows how a background task ends: eval in a fresh
        namespace, fall back to `result`, then finish with the JSON-safe value.
        The namespace exposes `dsh_task_id` and `dsh_should_stop()` so a long
        snippet can stop itself once `task_cancel` asked it to.
        """
        local_ns = {}
        global_ns = {
            "dsh_task_id": task_id,
            "dsh_should_stop": lambda: self.tasks.stop_requested(task_id),
        }
        try:
            try:
                code_obj = compile(code, tag, "eval")
            except SyntaxError:
                code_obj = compile(code, tag, "exec")
            res = eval(code_obj, global_ns, local_ns)  # nosec B307  # arbitrary execution is intended
            if res is None:
                res = local_ns.get("result")
            self.tasks.finish(task_id, result=_to_jsonable(res))
        except Exception:
            self.tasks.finish(task_id, error=traceback.format_exc())

    def submit_pyeval_group(self, tasks, max_workers=4):
        """Queue pure-Python shards in one bounded pool; return [{name, task_id}].

        Each shard runs in its own namespace with no QGIS objects, exactly like
        submit_pyeval_async, but at most max_workers of them run at once.
        """
        items = [t for t in (tasks or [])
                 if isinstance(t, dict) and str(t.get("code") or "").strip()]
        if not items:
            raise ValueError("tasks 不能为空（每项 {name, code}）")
        workers = max(1, min(int(max_workers or 4), 32, len(items)))
        started = []
        for it in items:
            name = str(it.get("name") or "")
            started.append({"name": name,
                            "task_id": self.tasks.new(name=name, status="queued")})

        def _run(task_id, code):
            if self.tasks.is_cancelled(task_id):
                return
            self.tasks.set_status(task_id, "running")
            self._run_task(task_id, code, "<pyeval_group>")

        # Prune pools whose work is finished, then keep this one referenced.
        for pool in list(_GROUP_POOLS):
            try:
                if not any(t.is_alive() for t in getattr(pool, "_threads", ())):
                    _GROUP_POOLS.remove(pool)
            except Exception:
                pass
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers,
                                                     thread_name_prefix="pyeval-group")
        _GROUP_POOLS.append(pool)
        for entry, it in zip(started, items):
            fut = pool.submit(_run, entry["task_id"], str(it.get("code")))
            _GROUP_FUTURES[entry["task_id"]] = fut
        pool.shutdown(wait=False)
        return started

    def _reply(self, obj):
        os.makedirs(os.path.dirname(self.res_path), exist_ok=True)
        with open(self.res_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
