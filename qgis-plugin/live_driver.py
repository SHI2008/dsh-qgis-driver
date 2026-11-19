"""The execution service side of dsh-qgis-driver: QGIS driven over files.

Start QGIS with this plugin enabled and it publishes a live dir
(~/.qgis-live/qgis-<pid>/dsh_qgis_driver) that the DSH bundle finds. There is no
view, no dock and no menu: everything below is the control surface.

Command format (one JSON object per line):
  {"id": 1, "type": "pyeval", "code": "prj.crs().authid()", "token": "...",
   "timeout": 120}          <- seconds; omit for the 10 s default
  {"id": 2, "type": "pyeval_group", "tasks": [{"name": "a", "code": "..."}],
   "max_workers": 4, "token": "..."}
  {"id": 3, "type": "task_status", "task_id": "...", "token": "..."}
  {"id": 4, "type": "task_cancel", "task_ids": ["..."], "token": "..."}
  {"id": 5, "type": "screenshot", "path": "C:/.../shot.png", "token": "..."}
  {"id": 6, "type": "write_lock", "op": "acquire", "owner": "agent",
   "ttl": 120, "token": "..."}
  {"id": 7, "type": "audit", "op": "tail", "limit": 20, "token": "..."}
  {"id": 8, "type": "status", "token": "..."}

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
import io
import itertools
import json
import os
import queue
import re
import secrets
import threading
import time
import tokenize
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
_LOCAL_TYPES = {"status", "pyeval", "pyeval_async", "pyeval_group", "task_status",
                "task_cancel", "screenshot", "write_lock", "audit"}

# Advisory instance-wide write lease. Two agents driving one QGIS instance do not
# crash each other (everything runs on the main thread), they silently overwrite
# each other's work, which is worse. Readers never take the gate; writers do.
DEFAULT_WRITE_TTL = 300.0

# Budget for one synchronous pyeval. The old 10s sat *below* the transport
# window, so a legitimate 12-second call was reported as "QGIS died" and a
# heavy Processing run could never finish on this path. 60s covers ordinary
# project work while still ending a `while True:`; heavy algorithms get more
# through the bundle's per-action budget, and anything longer belongs in a
# background shard.
DEFAULT_EVAL_TIMEOUT = 60.0


class MainThreadTimeout(BaseException):
    """Raised inside the main thread when a pyeval call overruns its budget.

    Deliberately a BaseException so `except Exception:` in the evaluated snippet
    does not swallow the interrupt.
    """


def _run_with_deadline(fn, seconds):
    """Run fn() here, but interrupt it when it overruns *seconds*.

    Python cannot stop a thread from outside, so a timer thread asks CPython to
    raise MainThreadTimeout in this one (ctypes). This is the only way to keep a
    runaway snippet from wedging the QGIS main thread for good.
    """
    if not seconds or seconds <= 0:
        return fn()
    import ctypes

    tid = threading.get_ident()

    def _fire():
        ctypes.pythonapi.PyThreadState_SetAsyncExc(
            ctypes.c_ulong(tid), ctypes.py_object(MainThreadTimeout))

    timer = threading.Timer(seconds, _fire)
    timer.daemon = True
    timer.start()
    try:
        return fn()
    finally:
        timer.cancel()


def _eval_timeout():
    """Seconds allowed for one pyeval (QGIS_LIVE_EVAL_TIMEOUT overrides)."""
    try:
        value = float(os.environ.get("QGIS_LIVE_EVAL_TIMEOUT", ""))
        if value > 0:
            return value
    except Exception:  # nosec B110  # a bad env value falls back to the default
        pass
    return DEFAULT_EVAL_TIMEOUT


class WriteGate:
    """Instance-level advisory write lock (one writer at a time, self-expiring).

    Held by whoever is about to change the project; released when the tool call
    returns. A lease expires on its own so a crashed agent cannot lock the
    instance forever.
    """

    def __init__(self, ttl=DEFAULT_WRITE_TTL):
        self._lock = threading.Lock()
        self._owner = None
        self._since = 0.0
        self._ttl = float(ttl)
        self._reason = ""

    def _snapshot(self):
        return {"held": bool(self._owner), "owner": self._owner,
                "held_ms": int((time.monotonic() - self._since) * 1000)
                if self._owner else 0,
                "ttl_s": int(self._ttl), "reason": self._reason}

    def _drop_if_expired(self):
        if self._owner and (time.monotonic() - self._since) > self._ttl:
            self._owner = None
            self._reason = ""

    def status(self):
        with self._lock:
            self._drop_if_expired()
            return self._snapshot()

    def acquire(self, owner, reason="", ttl=None):
        with self._lock:
            self._drop_if_expired()
            if ttl:
                try:
                    self._ttl = max(5.0, float(ttl))
                except Exception:  # nosec B110  # keep the previous ttl
                    pass
            if self._owner and self._owner != owner:
                return {"ok": False, "busy": True, **self._snapshot()}
            self._owner = owner or "unknown"
            self._since = time.monotonic()
            self._reason = reason or ""
            return {"ok": True, "busy": False, **self._snapshot()}

    def release(self, owner=None):
        with self._lock:
            if self._owner and owner and owner != self._owner:
                return {"ok": False, "error": f"held by {self._owner}",
                        **self._snapshot()}
            was = self._owner
            self._owner = None
            self._reason = ""
            return {"ok": True, "released": was}


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
    """Where the audit log lives."""
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


def _audit_files():
    """Audit logs newest first: today's file, then the rotated generations."""
    base = _audit_base_dir()
    try:
        names = [n for n in os.listdir(base) if n.startswith("audit-") and n.endswith(".jsonl")]
    except OSError:
        return []
    paths = [os.path.join(base, n) for n in names]
    paths.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return paths


def _audit_read(op="tail", limit=20):
    """Read the audit log back so an agent can see what happened instead of guessing.

    op=tail    newest `limit` records
    op=error   only failures, newest first
    op=slow    slowest `limit` records
    """
    limit = max(1, min(int(limit or 20), 200))
    paths = _audit_files()
    if not paths:
        return {"file": None, "count": 0, "entries": [], "files": 0,
                "note": "no audit log yet: it is written to the plugin registry dir on the first call"}
    path = paths[0]
    records = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    records.append(rec)
    except OSError as exc:
        return {"file": path, "count": 0, "entries": [], "files": len(paths),
                "error": "cannot read the audit log: {0}".format(exc)}
    if op == "error":
        records = [r for r in records if not r.get("ok", True)]
    elif op == "slow":
        records = sorted(records, key=lambda r: float(r.get("ms") or 0), reverse=True)
    else:
        records = records[-limit:]
    if op in ("error", "slow"):
        records = records[:limit]
    keep = ("ts", "type", "method", "ms", "ok", "error", "origin", "id", "args")
    entries = []
    for r in records:
        rec = {k: r[k] for k in keep if k in r}
        # a whole pyeval payload would drown the log view; the opening chars say
        # which call it was, and the error stays complete.
        if isinstance(rec.get("args"), str) and len(rec["args"]) > 160:
            rec["args"] = rec["args"][:160] + "…"
        entries.append(rec)
    return {"file": os.path.basename(path), "count": len(entries),
            "entries": entries, "files": len(paths)}


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
    """Return up to n entries from audit-*.jsonl, newest first."""
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


# Spinning up a second QApplication inside a running QGIS is the one mistake that
# takes the whole instance down: the singleton is replaced, the event loop this
# driver polls from is orphaned, and every later call fails with "no QGIS". Refuse
# it with an explanation instead of letting one bad call cost the whole session.
_INSTANCE_KILLERS = re.compile(r"\b(initQgis|QgsApplication)\s*\(", re.I)


def _strip_strings(code):
    """Drop STRING/COMMENT tokens so a mention in text cannot trip the guard."""
    try:
        parts = []
        for tok in tokenize.generate_tokens(io.StringIO(code).readline):
            if tok.type in (tokenize.STRING, tokenize.COMMENT):
                continue
            parts.append(tok.string)
        return " ".join(parts)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return code


def _refuse_instance_killer(code):
    """Explain why `code` must not run, or return None when it is fine.

    The driver already lives inside a running QGIS, so bootstrapping another one
    is never needed; it only destroys the instance the caller is talking to.
    """
    if not isinstance(code, str):
        return None
    if not _INSTANCE_KILLERS.search(_strip_strings(code)):
        return None
    return (
        "refused: this code calls initQgis()/QgsApplication() inside a running "
        "QGIS, which replaces the application singleton and kills the instance "
        "for every later call. The driver already runs inside QGIS, so those "
        "calls are never needed: use `prj`, `iface`, `QgsProject.instance()` or "
        "the Qgs* classes directly. Background shards cannot touch QGIS objects "
        "at all - use execute_qgis_sync or a structured qgis_* tool. Do not "
        "write a .py file and start a second QGIS either: this plugin is the "
        "only supported path."
    )


class Heartbeat(threading.Thread):
    """Publish liveness from a plain thread, so a busy GUI thread still looks alive.

    Every command runs inside the driver's QTimer slot on the GUI thread, so while
    one long call runs the timer cannot tick: from the outside, "working hard" and
    "process is hung" looked identical, and the client called both "QGIS died".
    This thread touches no Qt object, keeps ticking while the GUI thread is blocked,
    and names the command that is holding it.
    """

    def __init__(self, live_dir, busy_provider, stats):
        super().__init__(name="dsh-qgis-heartbeat", daemon=True)
        self.path = os.path.join(live_dir, "heartbeat.json")
        # A provider, not the dict itself: `_busy` is rebound per command, so a
        # captured reference would report the empty dict forever.
        self._busy_provider = busy_provider
        self._stats = stats
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            self.beat()
            self._stop.wait(1.0)

    def beat(self):
        try:
            busy = dict(self._busy_provider() or {})
        except Exception:  # nosec B110  # liveness must never raise
            busy = {}
        payload = {
            "pid": os.getpid(),
            "ts": round(time.time(), 3),
            "busy": busy or None,
            "since": busy.get("since") if busy else None,
            "calls": self._stats.get("calls", 0),
            "errors": self._stats.get("errors", 0),
        }
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            os.replace(tmp, self.path)
        except Exception:  # nosec B110  # liveness must never break a call
            pass

    def stop(self):
        self._stop.set()


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
        # Seed the names every snippet expects. `prj` in particular used to come
        # only from the client's prelude, so a raw /api/cmd call (or any client
        # that forgot it) failed with `NameError: prj` before doing any work.
        try:
            from qgis.core import QgsProject, QgsApplication
            self._ns.update({"QgsProject": QgsProject,
                             "QgsApplication": QgsApplication,
                             "prj": QgsProject.instance()})
        except Exception:  # nosec B110  # acceptable by design
            pass
        # Non-file command input (injected from other threads such as the HTTP server).
        # iface/QgsProject must not be touched off the GUI thread, so
        # execution always happens inside this driver's _poll (GUI thread)
        self._queue = queue.Queue()
        self.tasks = TaskRegistry()
        # in-memory counters for `status` (the audit jsonl is the durable copy)
        self.stats = {"calls": 0, "errors": 0, "last_error": None}
        self.gate = WriteGate()
        # command currently running on the GUI thread (read by the heartbeat thread)
        self._busy = {}
        self._beat_t0 = time.time()
        os.makedirs(live_dir, exist_ok=True)
        try:
            with open(os.path.join(live_dir, "token"), "w",
                      encoding="ascii") as f:
                f.write(self.token)
        except Exception:  # nosec B110  # acceptable by design
            pass

        self.heartbeat = Heartbeat(live_dir, lambda: self._busy, self.stats)
        self.heartbeat.start()

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
        try:
            self.heartbeat.stop()
        except Exception:  # nosec B110  # stopping must not raise
            pass
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
        self._busy = {
            "id": cmd.get("id"),
            "type": str(cmd.get("type") or "cmd"),
            "since": round(time.time(), 3),
        }

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
        finally:
            self._busy = {}

    def _audit(self, cmd, obj, ms):
        """Record the dispatch result in the audit jsonl (failures do not block the call).

        The counters live in memory so `status` can say "3 errors so far, last one
        was X" without re-reading the file.
        """
        ok = isinstance(obj, dict) and "error" not in obj
        self.stats["calls"] = int(self.stats.get("calls") or 0) + 1
        if not ok:
            self.stats["errors"] = int(self.stats.get("errors") or 0) + 1
            err = obj.get("error") if isinstance(obj, dict) else None
            self.stats["last_error"] = str(err)[:300] if err else None
        try:
            _audit_record(__package__, cmd, obj, ms)
        except Exception:  # nosec B110  # an audit failure must not stop the control surface
            pass

    def _dispatch(self, cmd, reply):
        cid = cmd.get("id") or f"auto-{next(_AUTO_IDS)}"
        ctype = cmd.get("type", "eval")
        if ctype == "pyeval":
            self._pyeval(cid, cmd.get("code", ""), reply, cmd.get("timeout"))
            return
        if ctype == "pyeval_async":
            self._pyeval_async(cid, cmd.get("code", ""), reply)
            return
        if ctype == "pyeval_group":
            self._pyeval_group(cid, cmd, reply)
            return
        if ctype == "write_lock":
            self._write_lock(cid, cmd, reply)
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
        if ctype == "audit":
            self._audit_tail(cid, cmd, reply)
            return
        if ctype == "status":
            reply({"id": cid, "result": self._status()})
            return
        reply({
            "id": cid,
            "error": f"unknown command type \"{ctype}\" — this plugin only serves "
            f"{', '.join(sorted(_LOCAL_TYPES))}",
        })

    def _audit_tail(self, cid, cmd, reply):
        """Return recent audit records (tail | error | slow)."""
        try:
            reply({"id": cid, "result": _audit_read(cmd.get("op") or "tail", cmd.get("limit") or 20)})
        except Exception:
            reply({"id": cid, "error": traceback.format_exc()})

    def _status(self):
        """Liveness of this instance: pid, live dir, port, counters, current work."""
        busy = dict(self._busy or {})
        if busy.get("type") == "status":
            # the status call itself is the running command: not worth reporting
            busy = {}
        now = time.time()
        return {
            "pid": os.getpid(),
            "plugin": __package__,
            "live_dir": self.dir,
            "host": self.http_host,
            "http_port": self.http_port,
            "view": self.view is not None,
            "calls": self.stats.get("calls", 0),
            "errors": self.stats.get("errors", 0),
            "last_error": self.stats.get("last_error"),
            "busy": busy or None,
            "busy_s": round(now - busy["since"], 1) if busy.get("since") else 0.0,
            "uptime_s": round(now - getattr(self, "_beat_t0", now), 1),
        }

    @staticmethod
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

    def _pyeval(self, cid, code, reply=None, timeout=None):
        """Run Python inside the QGIS process.

        If it compiles as an expression, eval it and return the result. For statements
        exec them and return the value of `result` in the namespace (None if unset).
        Runs synchronously, so long code blocks the event loop.
        When forwarded with a plugin_id, it runs in that plugin driver's
        namespace (view etc.).
        """
        reply = reply or self._reply
        explain = _refuse_instance_killer(code)
        if explain:
            reply({"id": cid, "error": explain})
            return
        self._ns.pop("result", None)
        # A caller may ask for a longer budget for one heavy call (layout export, long
        # analysis). Clamped so a bad value can never hang the instance.
        budget = _eval_timeout()
        try:
            asked = float(timeout)
        except (TypeError, ValueError):
            asked = 0.0
        if asked > 0:
            budget = max(1.0, min(asked, 600.0))

        def _run():
            try:
                code_obj = compile(code, "<pyeval>", "eval")
            except SyntaxError:
                code_obj = compile(code, "<pyeval>", "exec")
            out = eval(code_obj, self._ns)  # nosec B307  # arbitrary Python execution is intended
            if out is None:
                out = self._ns.pop("result", None)
            return out

        try:
            res = _run_with_deadline(_run, budget)
            reply({"id": cid, "result": _to_jsonable(res)})
        except MainThreadTimeout:
            self._ns.pop("result", None)
            reply({"id": cid, "error":
                   f"pyeval stopped: it ran longer than {budget:g}s (hard timeout) "
                   "and was interrupted, so the QGIS instance stays usable. "
                   "Split the work into submit_qgis_async tasks[] shards, or import the "
                   "same script and call it through execute_qgis_sync in smaller steps."})
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

    def _write_lock(self, cid, cmd, reply):
        """Acquire/release/inspect the instance write lease (op=acquire|release|status)."""
        try:
            op = (cmd.get("op") or "status").strip().lower()
            owner = cmd.get("owner") or "unknown"
            if op == "acquire":
                out = self.gate.acquire(owner, cmd.get("reason") or "",
                                        cmd.get("ttl"))
            elif op == "release":
                out = self.gate.release(owner)
            elif op == "status":
                out = {"ok": True, **self.gate.status()}
            else:
                reply({"id": cid, "error":
                       f"unknown write_lock op: {op} (acquire|release|status)"})
                return
            reply({"id": cid, "result": out})
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
        explain = _refuse_instance_killer(code)
        if explain:
            self.tasks.finish(task_id, error=explain)
            return
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
