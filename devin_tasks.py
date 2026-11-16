"""Run Devin CLI (devin.exe) sessions asynchronously inside the QGIS process.

Backend for the qgis_devin_* tools. Two engines:

- "acp" (default): drives `devin acp` over JSON-RPC (stdio).
  Shares IDE credentials (windsurf_api_key in credentials.toml), so
  `devin auth login` is not needed. Existing sessions can be resumed via
  session/load. Same transport path as the dispatcher (C:/devin/agent/acp-runner.mjs).
- "print": launches `devin -p` (non-interactive mode) and mirrors stdout to the log.
  Requires a CLI login via `devin auth login`.

engine="auto" picks acp when IDE credentials exist, otherwise print.

The task registry lives in process memory, so tracking info is lost when QGIS
restarts (note that the processes themselves may remain as orphans).
Stdlib-only so it can be tested with pytest without a real QGIS; iface etc.
are never touched.
"""

import itertools
import json
import os
import re
import shutil
import subprocess  # nosec B404  # needed to launch devin.exe
import threading
import time
import uuid

# Same default install location as the dispatcher (C:/devin/agent)
_DEFAULT_EXE = os.path.expandvars(
    r"%LOCALAPPDATA%\Programs\Devin\resources\app\extensions"
    r"\windsurf\devin\bin\devin.exe")
_CREDENTIALS = os.path.expandvars(r"%APPDATA%\devin\credentials.toml")

_PERMISSION_MODES = ("normal", "accept-edits", "smart", "dangerous")
_ENGINES = ("auto", "acp", "print")
_AGENTS = ("devin", "copilot")

_TASKS = {}
_LOCK = threading.Lock()
_MAX_TASKS = 32
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class TaskError(Exception):
    """User-facing error that can be returned to the tool as-is."""


def find_exe(exe=None):
    """Resolve the path of devin.exe. None if it cannot be found.

    Resolution order: argument > QGIS_LIVE_DEVIN_EXE > devin on PATH > default
    install location.
    """
    for c in (exe, os.environ.get("QGIS_LIVE_DEVIN_EXE"),
              shutil.which("devin"), _DEFAULT_EXE):
        if c and os.path.isfile(c):
            return c
    return None


def _ide_api_key():
    """Return windsurf_api_key for sharing IDE auth. None if not found.

    Resolution order: QGIS_LIVE_WINDSURF_API_KEY > WINDSURF_API_KEY >
    credentials.toml. The value is never written to the log.
    """
    for k in ("QGIS_LIVE_WINDSURF_API_KEY", "WINDSURF_API_KEY"):
        v = os.environ.get(k)
        if v:
            return v
    try:
        with open(_CREDENTIALS, encoding="utf-8") as f:
            m = re.search(r"windsurf_api_key\s*=\s*['\"]([^'\"]+)",
                          f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def _copilot_exe_spec():
    """Return an argv prefix that can spawn the copilot CLI directly. None if absent.

    npm's .cmd shim cannot be spawned directly and going through cmd /c makes
    argument quoting fragile, so try a real exe/winget shim first, then
    node + npm-loader.js. QGIS child processes may lack the npm dir on PATH,
    so default install locations (the usual npm global dir etc.) are also
    candidates.
    """
    npm_dir = os.path.expandvars(r"%APPDATA%\npm")
    cands = [shutil.which("copilot"),
             os.path.join(npm_dir, "copilot.cmd"),
             os.path.join(npm_dir, "copilot")]
    for w in cands:
        if not w or not os.path.isfile(w):
            continue
        if w.lower().endswith(".exe"):
            return [w]
        loader = os.path.join(
            os.path.dirname(w), "node_modules", "@github",
            "copilot", "npm-loader.js")
        for node in (shutil.which("node"),
                     r"C:\Program Files\nodejs\node.exe"):
            if node and os.path.isfile(node) and \
                    os.path.isfile(loader):
                return [node, loader]
    shim = os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Links\copilot.exe")
    if os.path.isfile(shim):
        return [shim]
    return None


def _build_copilot_argv(prompt, session_id=None, model=None,
                        permission_mode="dangerous"):
    """Command line for `copilot -p` non-interactive execution.

    Permissions: permission_mode="dangerous" makes run() set
    COPILOT_ALLOW_ALL=true (allow all tools automatically + trust the working
    dir, equivalent to devin's --respect-workspace-trust false). "accept-edits"
    maps to --allow-all-tools (tools are allowed but the dir is not trusted).
    Otherwise no extra flags (non-interactive mode denies unapproved tools).
    Resume with -r <session_id>.
    """
    spec = _copilot_exe_spec()
    if spec is None:
        raise TaskError(
            "copilot CLI not found (install @github/copilot or "
            "set QGIS_LIVE_DEVIN_EXE-style path via exe arg)")
    argv = spec + ["-s", "-p", prompt]
    if permission_mode not in (None, "", "dangerous", "accept-edits"):
        raise TaskError(
            f"copilot permission_mode supports "
            f"('dangerous', 'accept-edits', 'normal'): "
            f"{permission_mode!r}")
    if permission_mode == "accept-edits":
        argv += ["--allow-all-tools"]
    if model:
        argv += ["--model", model]
    if session_id:
        argv += ["-r", session_id]
    return argv


def _resolve_engine(engine, agent="devin"):
    """Resolve engine="auto"|"acp"|"print" to a concrete engine name."""
    if engine in (None, "", "auto"):
        if agent == "copilot":
            return "acp"  # no IDE auth needed, so always prefer acp
        return "acp" if _ide_api_key() else "print"
    if engine not in ("acp", "print"):
        raise TaskError(f"engine must be one of {_ENGINES}: {engine!r}")
    return engine


def _build_argv(exe, prompt_file, session_id=None, model=None,
                permission_mode="dangerous"):
    """Command line for `devin -p` non-interactive execution.

    --respect-workspace-trust false: -p cannot show an interactive prompt, so
    this keeps it from exiting immediately in an untrusted dir. --prompt-file
    passes long prompts without hitting the command-line length limit.
    """
    argv = [exe, "-p", "--respect-workspace-trust", "false"]
    if permission_mode:
        if permission_mode not in _PERMISSION_MODES:
            raise TaskError(
                f"permission_mode must be one of "
                f"{_PERMISSION_MODES}: {permission_mode!r}")
        argv += ["--permission-mode", permission_mode]
    if model:
        argv += ["--model", model]
    if session_id:
        argv += ["-r", session_id]
    argv += ["--prompt-file", prompt_file]
    return argv


def _prune_locked():
    """When the registry cap is exceeded, drop finished old tasks first."""
    if len(_TASKS) <= _MAX_TASKS:
        return
    done = sorted((t for t in _TASKS.values() if t["proc"].poll() is not None),
                  key=lambda t: t["started"])
    for t in done[: len(_TASKS) - _MAX_TASKS]:
        _close(t)
        del _TASKS[t["id"]]


def _close(t):
    for k in ("logf", "errf"):
        f = t.get(k)
        if f is not None:
            try:
                f.close()
            except Exception:  # nosec B110  # acceptable by design
                pass


def run(prompt, cwd=None, session_id=None, model=None,
        permission_mode="dangerous", exe=None, live_dir=None,
        engine="auto", agent="devin"):
    """Start an agent CLI session asynchronously and return task info.

    @param exe: executable path. A list/tuple is used as argv verbatim
        (for tests; no CLI args are appended)
    @param engine: "auto"|"acp"|"print". auto picks whichever is available
    @param agent: "devin" or "copilot" (GitHub Copilot CLI)
    @returns {"task_id", "pid", "cwd", "log", "engine"}
    """
    prompt = prompt or ""
    if not prompt.strip():
        raise TaskError("prompt is required")
    if agent not in _AGENTS:
        raise TaskError(f"agent must be one of {_AGENTS}: {agent!r}")
    cwd = os.path.abspath(os.path.expanduser(cwd or "~"))
    if not os.path.isdir(cwd):
        raise TaskError(f"cwd is not a directory: {cwd}")

    log_dir = os.path.join(live_dir or os.path.expanduser("~"), agent)
    os.makedirs(log_dir, exist_ok=True)
    task_id = f"{agent}-{uuid.uuid4().hex[:8]}"
    prompt_file = os.path.join(log_dir, f"prompt-{task_id}.txt")
    log = os.path.join(log_dir, f"{task_id}.log")
    with open(prompt_file, "w", encoding="utf-8") as f:
        f.write(prompt)

    if isinstance(exe, (list, tuple)):
        argv = list(exe)
        eng = engine if engine in ("acp", "print") else "print"
    elif agent == "copilot":
        eng = _resolve_engine(engine, agent)
        if eng == "acp":
            argv = _copilot_argv()
        else:
            argv = _build_copilot_argv(
                prompt, session_id=session_id, model=model,
                permission_mode=permission_mode)
    else:
        exe = find_exe(exe)
        if exe is None:
            raise TaskError(
                "devin.exe not found (set QGIS_LIVE_DEVIN_EXE or "
                "install Devin CLI)")
        eng = _resolve_engine(engine)
        argv = ([exe, "acp"] if eng == "acp"
                else _build_argv(exe, prompt_file, session_id=session_id,
                                 model=model,
                                 permission_mode=permission_mode))

    if eng == "acp" and agent == "devin" and not _ide_api_key():
        raise TaskError(
            "engine 'acp' requires IDE credentials "
            "(windsurf_api_key in %APPDATA%/devin/credentials.toml or "
            "WINDSURF_API_KEY); use engine='print' with `devin auth "
            "login` instead")

    env = None
    if agent == "copilot" and permission_mode == "dangerous":
        # COPILOT_ALLOW_ALL=true approves every tool automatically and also
        # trusts the working dir (equivalent to devin --respect-workspace-trust false)
        env = dict(os.environ, COPILOT_ALLOW_ALL="true")

    try:
        # acp: the worker thread writes the session log alone, hence
        # buffering=0. stderr (the CLI trace log) goes to a separate file
        # (separate append handles on one file have lost writes on contention).
        logf = open(log, "ab", buffering=0 if eng == "acp" else -1)
        errf = open(log[:-4] + ".stderr.log", "ab") \
            if eng == "acp" else None
        try:
            if eng == "acp":
                # JSON-RPC travels over stdin/stdout, so use pipes.
                # stderr goes to a separate file (mixing it into stdout breaks RPC)
                proc = subprocess.Popen(  # nosec B603
                    argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=errf, cwd=cwd, env=env,
                    creationflags=_NO_WINDOW)
            else:
                proc = subprocess.Popen(  # nosec B603
                    argv, stdout=logf, stderr=subprocess.STDOUT,
                    cwd=cwd, env=env, creationflags=_NO_WINDOW)
        except Exception:
            logf.close()
            if errf is not None:
                errf.close()
            raise
    except OSError as e:
        raise TaskError(f"failed to start {agent} cli: {e}")

    t = {"id": task_id, "pid": proc.pid, "argv": argv, "cwd": cwd,
         "prompt": prompt[:500], "prompt_full": prompt, "log": log,
         "stderr_log": (errf.name if errf is not None else None),
         "prompt_file": prompt_file, "started": time.time(),
         "proc": proc, "logf": logf, "errf": errf,
         "session_id": session_id,
         "engine": eng, "agent": agent, "model": model,
         "acp_engine": agent,
         "permission_mode": permission_mode or "dangerous",
         "dangerous": permission_mode == "dangerous", "done": False}
    with _LOCK:
        _TASKS[task_id] = t
        _prune_locked()
    if eng == "acp":
        w = threading.Thread(target=_acp_drive, args=(t,), daemon=True,
                             name=f"acp-{task_id}")
        t["worker"] = w
        w.start()
    return {"task_id": task_id, "pid": proc.pid, "cwd": cwd,
            "log": log, "engine": eng}


def _get(task_id):
    t = _TASKS.get(task_id or "")
    if t is None:
        raise TaskError(f"task not found: {task_id}")
    return t


def _summary(t):
    code = t["proc"].poll()
    return {
        "task_id": t["id"], "pid": t["pid"],
        "state": "running" if code is None and not t.get("done")
                 else ("exited" if code == 0 or t.get("done")
                       else "failed"),
        "exit_code": code,
        "cwd": t["cwd"], "prompt": t["prompt"],
        "session_id": t["session_id"], "engine": t["engine"],
        "agent": t.get("agent", "devin"),
        "elapsed_sec": round(time.time() - t["started"], 1),
        "log": t["log"], "stderr_log": t.get("stderr_log"),
    }


def _tail(path, chars):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > chars:
                f.seek(-chars, os.SEEK_END)
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def status(task_id=None, tail=2000):
    """Return task status. With task_id omitted, returns all tasks."""
    if not task_id:
        with _LOCK:
            return {"tasks": [_summary(t) for t in _TASKS.values()]}
    t = _get(task_id)
    out = _summary(t)
    out["log_tail"] = _tail(t["log"], max(0, int(tail)))
    if out["state"] != "running":
        _close(t)
    return out


def result(task_id, tail=20000):
    """Return the task output (tail of the log)."""
    t = _get(task_id)
    out = _summary(t)
    out["output"] = _tail(t["log"], max(0, int(tail)))
    if out["state"] != "running":
        _close(t)
    return out


def abort(task_id):
    """Kill a running task."""
    t = _get(task_id)
    t["proc"].kill()
    out = _summary(t)
    out["aborted"] = True
    return out


# ---- ACP (Agent Client Protocol) engine ----
# `devin.exe acp` speaks line-delimited JSON-RPC over stdio. One thread sends
# initialize→authenticate→session/new (or load)→session/prompt in order, and
# keeps formatting session/update notifications and auto-answering
# session/request_permission while awaiting responses.
# (Same procedure as the dispatcher's acp-runner.mjs)

def _pick_permission_option(options, dangerous):
    """Pick the response optionId from the request_permission options.

    dangerous: always prefer allow-style (allow_always first). Otherwise prefer
    allow_once-style (one-time approval) and fall back to the first option when
    no allow-style option exists.
    """
    opts = options or []

    def _oid(o):
        return str(o.get("optionId") or o.get("id") or "")

    def _find(*words):
        for o in opts:
            oid, kind = _oid(o), str(o.get("kind") or "")
            if any(w in oid or w == kind for w in words):
                return oid
        return None

    if dangerous:
        hit = _find("allow_always") or _find("allow")
        if hit:
            return hit
    hit = _find("allow_once") or _find("allow")
    if hit:
        return hit
    return _oid(opts[0]) if opts else "allow_once"


def _acp_handle(msg, t, send, out):
    """Handle agent→client notifications/requests."""
    method = msg.get("method")
    if method == "session/update":
        u = (msg.get("params") or {}).get("update") or {}
        kind = u.get("sessionUpdate")
        if kind == "agent_message_chunk":
            text = ((u.get("content") or {}).get("text") or "")
            if text:
                out(text, raw=True)
        elif kind == "tool_call":
            args = json.dumps(u.get("rawInput") or u.get("input")
                              or "", ensure_ascii=False)[:160]
            out(f"\n[tool ->] {u.get('title') or u.get('toolName') or 'tool'}"
                f" {args}")
        elif kind == "tool_call_update" and u.get("status") == "failed":
            out(f"[tool x] {u.get('title') or ''}")
        elif kind == "plan":
            out("[plan] "
                + json.dumps(u.get("entries") or "",
                             ensure_ascii=False)[:300])
        # agent_thought_chunk, config_option_update etc. are omitted
    elif msg.get("id") is not None:
        # Request: permission queries are answered automatically by policy;
        # unknown methods get method not found (so the peer never hangs on no reply)
        if method == "session/request_permission":
            oid = _pick_permission_option(
                (msg.get("params") or {}).get("options"),
                t["dangerous"])
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {
                "outcome": {"outcome": "selected", "optionId": oid}}})
            out(f"\n[permission ->] {oid}")
        else:
            send({"jsonrpc": "2.0", "id": msg["id"],
                  "error": {"code": -32601,
                            "message": f"unsupported: {method}"}})


def _acp_drive(t):
    """Drive an ACP session on a worker thread.

    This thread alone writes the session log (t["logf"]) (child stderr goes to
    a separate file). When the prompt completes (or fails) it sets t["done"]
    and terminates the process, leaving state determination to _summary.
    """
    proc = t["proc"]
    seq = itertools.count(1)
    logf = t["logf"]

    def out(s, raw=False):
        data = s.encode("utf-8", "replace")
        logf.write(data if raw else data + b"\n")

    def send(msg):
        proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
        proc.stdin.flush()

    def rpc(method, params):
        mid = next(seq)
        send({"jsonrpc": "2.0", "id": mid,
              "method": method, "params": params})
        while True:
            line = proc.stdout.readline()
            if not line:
                raise TaskError(f"{method}: acp process exited")
            try:
                msg = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                out("[acp] " + line.decode("utf-8", "replace").rstrip())
                continue
            if "method" in msg:
                _acp_handle(msg, t, send, out)
                continue
            if msg.get("id") != mid:
                continue  # delayed response for another id (normally never happens)
            if "error" in msg:
                raise TaskError(
                    f"{method}: {json.dumps(msg['error'])[:400]}")
            return msg.get("result") or {}

    try:
        init = rpc("initialize", {
            "protocolVersion": 1,
            "clientInfo": {"name": "qgis-live-driver", "version": "1.0.0"},
            # fs/terminal true delegates execution to the client.
            # Keep them false so the agent-side tools handle it
            "clientCapabilities": {
                "fs": {"readTextFile": False, "writeTextFile": False},
                "terminal": False}})
        caps = init.get("agentCapabilities") or {}
        if t.get("acp_engine") == "copilot":
            # Auth is delegated to the CLI's own gh login. Only when authMethods
            # are advertised, try the first method best-effort (it may involve
            # terminal auth), so ignore failures and proceed to session/new
            m = (init.get("authMethods") or [{}])[0]
            if m.get("id"):
                try:
                    rpc("authenticate", {"methodId": m["id"]})
                except TaskError as e:
                    out(f"[auth skipped] {e}")
        else:
            rpc("authenticate", {"methodId": "devin-browser",
                                 "_meta": {"api_key": _ide_api_key()}})
        sid = t["session_id"]
        if sid and caps.get("loadSession"):
            try:
                rpc("session/load", {"sessionId": sid, "cwd": t["cwd"],
                                     "mcpServers": []})
                out(f"[session resumed] {sid}")
            except TaskError as e:
                out(f"[acp] session/load failed ({e}) -> new session")
                sid = None
        if not sid:
            s = rpc("session/new", {"cwd": t["cwd"], "mcpServers": []})
            sid = s.get("sessionId")
            t["session_id"] = sid
            out(f"[session started] {sid}")
        # permission_mode → ACP mode. ACP mode IDs are
        # accept-edits/smart/ask/plan/bypass. Mapping dangerous to bypass
        # means request_permission never arrives at all
        mode = {"dangerous": "bypass", "smart": "smart",
                "accept-edits": "accept-edits"}.get(t["permission_mode"])
        if mode:
            try:
                rpc("session/set_mode",
                    {"sessionId": sid, "modeId": mode})
                out(f"[mode] {mode}")
            except TaskError as e:
                out(f"[mode failed] {mode}: {e}")
        if t["model"]:
            try:
                rpc("session/set_config_option",
                    {"sessionId": sid, "configId": "model",
                     "value": t["model"]})
                out(f"[option] model -> {t['model']}")
            except TaskError as e:
                out(f"[option failed] model: {e}")
        res = rpc("session/prompt", {
            "sessionId": sid,
            "prompt": [{"type": "text", "text": t["prompt_full"]}]})
        out(f"\n[done] {json.dumps(res or {}, ensure_ascii=False)}")
        t["done"] = True
    except Exception as e:  # process-side failures also land here
        try:
            out(f"\n[fatal] {e}")
        except OSError:
            pass
        t["error"] = str(e)
    finally:
        # Notify session/close best-effort (do not await the response) so the
        # session is not left in devin's session list, then shut the process down
        try:
            if t["done"] and t["session_id"]:
                send({"jsonrpc": "2.0", "method": "session/close",
                      "params": {"sessionId": t["session_id"]}})
        except Exception:  # nosec B110  # acceptable by design
            pass
        try:
            proc.terminate()
        except OSError:
            pass
        _close(t)


def _copilot_argv():
    """argv for `copilot --acp --stdio` (equivalent to dispatcher copilotSpawnSpec).

    Use a directly spawnable spec when available; otherwise resolve it through
    cmd (safe here because no args are involved).
    """
    spec = _copilot_exe_spec()
    if spec is not None:
        return spec + ["--acp", "--stdio"]
    if os.name == "nt":
        return ["cmd.exe", "/d", "/s", "/c", "copilot --acp --stdio"]
    return ["copilot", "--acp", "--stdio"]


class AcpSession:
    """Long-lived session for `devin acp` / `copilot --acp --stdio`
    (for the chat provider).

    Unlike _acp_drive (one-shot tasks), prompt() can send session/prompt to the
    same session repeatedly. The reader thread multiplexes responses,
    notifications and agent-initiated requests, so the sender can simply wait
    for its response.

    @param mode: ACP mode ID (bypass/smart/accept-edits etc.).
        Use _ACP_MODES to map from permission_mode
    @param on_update: callback invoked for each session/update
        (runs on the reader thread, so avoid heavy work)
    """

    _ACP_MODES = {"dangerous": "bypass", "smart": "smart",
                  "accept-edits": "accept-edits"}

    def __init__(self, cwd, exe=None, mode="bypass",
                 on_update=None, session_id=None, model=None,
                 engine="devin"):
        self.cwd = cwd
        self.on_update = on_update
        self.session_id = None
        self.modes = None
        self.config_options = None
        self._proc = None
        self._pending = {}
        self._seq = itertools.count(1)
        self._wlock = threading.Lock()
        self._closed = False
        if isinstance(exe, (list, tuple)):
            argv = list(exe)  # for tests: use argv as-is
        elif engine == "copilot":
            argv = ([exe, "--acp", "--stdio"] if exe
                    else _copilot_argv())
        else:
            exe = find_exe(exe)
            if exe is None:
                raise TaskError(
                    "devin.exe not found (set QGIS_LIVE_DEVIN_EXE or "
                    "install Devin CLI)")
            argv = [exe, "acp"]
        if engine == "devin" and not _ide_api_key():
            raise TaskError(
                "ACP requires IDE credentials (windsurf_api_key)")
        # devin acp watches the process in WINDSURF_EXT_HOST_PID as its
        # "parent" and exits itself when that process dies. If QGIS was launched
        # from an IDE terminal it may inherit a stale pid from a restarted IDE,
        # which kills acp right after session creation, so point it at the real
        # parent (this QGIS process) instead
        env = dict(os.environ)
        if env.get("WINDSURF_EXT_HOST_PID"):
            env["WINDSURF_EXT_HOST_PID"] = str(os.getpid())
        try:
            self._proc = subprocess.Popen(  # nosec B603
                argv, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, cwd=cwd, env=env,
                creationflags=_NO_WINDOW)
        except OSError as e:
            raise TaskError(f"failed to start devin acp: {e}")
        self._reader = threading.Thread(
            target=self._read_loop, daemon=True, name="acp-reader")
        self._reader.start()
        try:
            init = self.rpc("initialize", {
                "protocolVersion": 1,
                "clientInfo": {"name": "qgis-live-driver",
                               "version": "1.0.0"},
                "clientCapabilities": {
                    "fs": {"readTextFile": False,
                           "writeTextFile": False},
                    "terminal": False}}, timeout=60.0)
            caps = init.get("agentCapabilities") or {}
            if engine == "devin":
                self.rpc("authenticate", {
                    "methodId": "devin-browser",
                    "_meta": {"api_key": _ide_api_key()}}, timeout=60.0)
            else:
                # copilot: auth is delegated to the CLI's gh login. Try the
                # first advertised authMethod, but copilot-login may involve
                # terminal auth, so ignore failures/timeouts and proceed to
                # session/new (with gh already logged in, no auth is needed)
                m = (init.get("authMethods") or [{}])[0]
                if m.get("id"):
                    try:
                        self.rpc("authenticate", {"methodId": m["id"]},
                                 timeout=15.0)
                    except TaskError:
                        pass
            if session_id and caps.get("loadSession"):
                try:
                    s = self.rpc("session/load", {
                        "sessionId": session_id, "cwd": cwd,
                        "mcpServers": []}, timeout=60.0)
                    self.session_id = session_id
                except TaskError:
                    session_id = None
            if not self.session_id:
                s = self.rpc("session/new", {
                    "cwd": cwd, "mcpServers": []}, timeout=60.0)
                self.session_id = s.get("sessionId")
            self.modes = (s or {}).get("modes")
            self.config_options = (s or {}).get("configOptions")
            if mode:
                try:
                    self.rpc("session/set_mode", {
                        "sessionId": self.session_id,
                        "modeId": mode}, timeout=15.0)
                except TaskError:
                    pass
            if model:
                try:
                    self.rpc("session/set_config_option", {
                        "sessionId": self.session_id,
                        "configId": "model", "value": model},
                        timeout=15.0)
                except TaskError:
                    pass
        except Exception:
            self.close()
            raise

    def _send(self, msg):
        with self._wlock:
            self._proc.stdin.write(
                (json.dumps(msg) + "\n").encode("utf-8"))
            self._proc.stdin.flush()

    def rpc(self, method, params=None, timeout=None):
        """Send a JSON-RPC request and wait for the result. timeout=None waits forever."""
        if self._closed:
            raise TaskError("acp session is closed")
        mid = next(self._seq)
        ev = threading.Event()
        box = {}
        self._pending[mid] = (ev, box)
        try:
            self._send({"jsonrpc": "2.0", "id": mid, "method": method,
                        "params": params or {}})
        except (OSError, ValueError) as e:
            self._pending.pop(mid, None)
            raise TaskError(f"{method}: send failed: {e}")
        if not ev.wait(timeout):
            self._pending.pop(mid, None)
            raise TaskError(f"{method}: timeout")
        if "error" in box:
            raise TaskError(
                f"{method}: {json.dumps(box['error'])[:400]}")
        if "eof" in box:
            raise TaskError(f"{method}: acp process exited")
        return box.get("result") or {}

    def _read_loop(self):
        try:
            for raw in self._proc.stdout:
                try:
                    msg = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if "method" in msg:
                    self._handle_agent(msg)
                    continue
                mid = msg.get("id")
                ent = self._pending.pop(mid, None)
                if ent is not None:
                    ev, box = ent
                    if "error" in msg:
                        box["error"] = msg["error"]
                    else:
                        box["result"] = msg.get("result")
                    ev.set()
        finally:
            # Process exited: release every pending rpc
            for mid, (ev, box) in list(self._pending.items()):
                box["eof"] = True
                ev.set()
            self._pending.clear()

    def _handle_agent(self, msg):
        method = msg.get("method")
        if msg.get("id") is not None:
            # agent→client request
            if method == "session/request_permission":
                oid = _pick_permission_option(
                    (msg.get("params") or {}).get("options"),
                    True)
                self._respond(msg["id"], {
                    "outcome": {"outcome": "selected",
                                "optionId": oid}})
            else:
                self._respond(msg["id"], err={
                    "code": -32601,
                    "message": f"unsupported: {method}"})
        elif method == "session/update":
            u = (msg.get("params") or {}).get("update") or {}
            if self.on_update:
                try:
                    self.on_update(u)
                except Exception:  # nosec B110  # acceptable by design
                    pass

    def _respond(self, mid, result=None, err=None):
        rep = {"jsonrpc": "2.0", "id": mid}
        if err is not None:
            rep["error"] = err
        else:
            rep["result"] = result
        try:
            self._send(rep)
        except (OSError, ValueError):
            pass

    def prompt(self, blocks):
        """Send session/prompt and wait until the turn finishes.

        @param blocks: [{"type":"text","text":...},
                        {"type":"image","data":b64,"mimeType":...}]
        @returns result of session/prompt (stopReason/usage etc.)
        """
        return self.rpc("session/prompt", {
            "sessionId": self.session_id, "prompt": blocks})

    def cancel(self):
        """Abort the running turn (session/cancel notification)."""
        try:
            self._send({"jsonrpc": "2.0", "method": "session/cancel",
                        "params": {"sessionId": self.session_id}})
        except (OSError, ValueError):
            pass

    def close(self):
        """Notify session/close best-effort and shut the process down."""
        if self._closed:
            return
        self._closed = True
        try:
            if self.session_id:
                self._send({"jsonrpc": "2.0", "method": "session/close",
                            "params": {"sessionId": self.session_id}})
        except (OSError, ValueError):
            pass
        try:
            self._proc.terminate()
        except OSError:
            pass
