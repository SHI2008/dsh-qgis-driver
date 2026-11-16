"""HTTP server built into geo_driver. Standard library only.

Serves a plain REST surface on one port, so AI tools/apps can drive QGIS
with nothing but HTTP POST.

  POST /api/cmd          dispatch the command JSON as-is ({"type":"status"} etc.)
  POST /api/pyeval       {"code": "..."} -> {"result": ...} | {"error": ...}
  POST /api/pyeval_async {"code": "..."} -> {"task_id": "..."} (background task)
  GET  /api/tasks/<id>   {"status": ..., "result"/"error": ...} (poll async task)
  POST /api/eval         {"expression": "...", "plugin_id": "<id>"} (forwarded to a
                         plugin that has a view. Without plugin_id, returns unsupported)
  POST /api/screenshot   {"path": "...?", "plugin_id": "...", "target": "..."}
                         -> PNG binary (Content-Type: image/png)
  GET  /api/tools        tool spec JSON (for function-calling AIs to read)
  GET  /api/status       result of the status command
  GET  /api/health       {"ok": true, "pid": ...}

Execution path: HTTP worker thread -> driver.submit() puts it on the in-memory queue ->
the GUI thread's LiveDriver._poll runs it -> the worker waits and returns the result.
Only the GUI thread ever touches iface/QgsProject.

With plugin_id, eval/pyeval/screenshot/devreload are forwarded to that plugin's
LiveDriver (hub route). open_plugin/reload_plugin/bridge_call/status are
handled by this driver with plugin_id as a command argument.

Binds to 127.0.0.1 only, port 0 (free port picked automatically).
pyeval runs arbitrary code, so remote exposure is not a use case.

Auth (localhost-only operation):
  Every endpoint (other than /api/health) requires a session token match.
  The token is generated at driver start and written only to user-only files
  (live_dir/token and the registry JSON).
  Local clients just read it from there.
  Send it as Authorization: Bearer, X-Api-Key, or api-key.
  Requests whose Host is not loopback, or whose Origin points outside
  loopback, are also rejected (DNS rebinding and browser-based attacks).
  Setting QGIS_LIVE_API_KEY accepts that key as well.
  QGIS_LIVE_TOOLS    comma-separated command kinds to expose (e.g. "status,screenshot").
                     Unset or "*" allows everything.
"""

import hmac
import json
import os
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

TOOLS = [
    {
        "name": "qgis_pyeval",
        "description":
            "Execute arbitrary Python inside the running QGIS process "
            "(GUI thread). Namespace has iface/QgsProject/QgsApplication/"
            "driver. Expressions return their value; statements return "
            "the `result` variable. With plugin_id, runs in that plugin's "
            "driver namespace (its `view` is available).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {"type": "string"},
                "plugin_id": {"type": "string"},
            },
            "required": ["code"],
        },
    },
    {
        "name": "qgis_eval",
        "description":
            "Evaluate a JS expression inside a plugin's QWebEngineView "
            "(routed to the plugin's live driver via plugin_id).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "expression": {"type": "string"},
                "plugin_id": {"type": "string"},
            },
            "required": ["expression", "plugin_id"],
        },
    },
    {
        "name": "qgis_screenshot",
        "description":
            "Capture PNG. Default: this driver's map canvas. With plugin_id "
            "routes to that plugin (its view). target: canvas|mainwindow "
            "(driver) or view|window|canvas|mainwindow (WebEngine plugin). "
            "Returns the image.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "plugin_id": {"type": "string"},
                "target": {"type": "string"},
            },
        },
    },
    {
        "name": "qgis_devreload",
        "description":
            "Re-import a plugin's repo-side bridge/ui (WEBENGINE_DEV_SRC) and "
            "reload its page. Routed via plugin_id.",
        "inputSchema": {
            "type": "object",
            "properties": {"plugin_id": {"type": "string"}},
            "required": ["plugin_id"],
        },
    },
    {
        "name": "qgis_status",
        "description":
            "Driver status: pid, http port, loaded plugins and which have "
            "live drivers / views.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "qgis_open_plugin",
        "description":
            "Load+start a QGIS plugin if needed and call its open_dialog().",
        "inputSchema": {
            "type": "object",
            "properties": {"plugin_id": {"type": "string"}},
            "required": ["plugin_id"],
        },
    },
    {
        "name": "qgis_reload_plugin",
        "description":
            "Hot-reload a QGIS plugin (sys.modules cleanup + reloadPlugin + "
            "open_dialog). No QGIS restart needed.",
        "inputSchema": {
            "type": "object",
            "properties": {"plugin_id": {"type": "string"}},
            "required": ["plugin_id"],
        },
    },
    {
        "name": "qgis_bridge_call",
        "description":
            "Call a plugin's bridge method directly in-process (bypasses "
            "WebChannel, so it works even while the JS renderer is starved). "
            "JSON-string results are parsed. plugin_id optional.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "plugin_id": {"type": "string"},
                "method": {"type": "string"},
                "args": {"type": "array"},
            },
            "required": ["method"],
        },
    },
    {
        "name": "qgis_describe_plugins",
        "description":
            "Catalog of all loaded QGIS plugins and their AI-callable "
            "capabilities. For plugins exposing a `bridge`, aggregates "
            "each bridge's pluginInfo() (summary / when_to_use / methods "
            "with signatures and examples). Call this first to discover "
            "which plugin to use for a task, then invoke it via "
            "qgis_bridge_call.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "qgis_instruction",
        "description":
            "Manage AI instruction files on this machine. kind=agents "
            "(persistent instructions injected into the assistant's "
            "system prompt), skills (on-demand procedural docs), or "
            "prompts (canned prompt text for the panel's suggestion "
            "list). "
            "op=list|read|save|delete. save writes the user file "
            "(~/.qgis-live/<kind>/<name>.md); a same-id user file "
            "shadows the bundled one. delete works on user files only. "
            "Format: first '# ' line = title, next non-empty line = "
            "description, rest = body.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "op": {"type": "string",
                       "enum": ["list", "read", "save", "delete"]},
                "kind": {"type": "string",
                         "enum": ["agents", "skills", "prompts"]},
                "id": {"type": "string",
                       "description": "Target file name (stem); for read/delete"},
                "name": {"type": "string",
                         "description": "File name to save (stem); for save"},
                "text": {"type": "string",
                         "description": "File body (Markdown); for save"},
            },
            "required": ["op", "kind"],
        },
    },
    {
        "name": "qgis_devin_run",
        "description":
            "Start a Devin CLI agent session as a background task on "
            "this machine and return a task_id immediately. Devin "
            "works autonomously in `cwd` (default: user home). Poll "
            "progress with qgis_devin_status, fetch output with "
            "qgis_devin_result, stop with qgis_devin_abort. engine: "
            "'acp' drives `devin acp` over JSON-RPC and shares IDE "
            "sign-in (no `devin auth login` needed); 'print' runs "
            "`devin -p` and requires `devin auth login`; 'auto' "
            "(default) prefers acp when IDE credentials exist. "
            "session_id resumes a Devin session (acp: session/load, "
            "print: -r); the new session id appears in "
            "qgis_devin_status. permission_mode controls how "
            "permission prompts are auto-answered: 'dangerous' "
            "(default) auto-approves everything, other modes "
            "approve once per request. Each run consumes Devin "
            "credits.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string",
                           "description": "Task instruction for Devin"},
                "cwd": {"type": "string",
                        "description": "Working directory "
                                       "(default: user home)"},
                "session_id": {"type": "string",
                               "description": "Resume this Devin "
                                              "session id "
                                              "(acp: session/load, "
                                              "print: -r)"},
                "model": {"type": "string",
                          "description": "Devin model override"},
                "permission_mode": {
                    "type": "string",
                    "enum": ["normal", "accept-edits", "smart",
                             "dangerous"],
                    "description": "Permission auto-answer policy "
                                   "(default: dangerous)"},
                "engine": {
                    "type": "string",
                    "enum": ["auto", "acp", "print"],
                    "description": "'acp'=IDE-shared auth JSON-RPC, "
                                   "'print'=`devin -p` (needs "
                                   "devin auth login), 'auto'=prefer "
                                   "acp (default)"},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "qgis_devin_status",
        "description":
            "Check a Devin task's state (running/exited/failed), "
            "elapsed seconds and recent log output. Omit task_id to "
            "list all Devin tasks of this QGIS process.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
            },
        },
    },
    {
        "name": "qgis_devin_result",
        "description":
            "Fetch a Devin task's captured output (log tail). Call "
            "after qgis_devin_status shows the task exited. tail = "
            "max characters returned (default 20000).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "tail": {"type": "integer"},
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "qgis_devin_abort",
        "description":
            "Kill a running Devin task started via qgis_devin_run.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "qgis_copilot_run",
        "description":
            "Start a GitHub Copilot CLI agent session as a background "
            "task on this machine and return a task_id immediately. "
            "Copilot works autonomously in `cwd` (default: user home). "
            "Poll progress with qgis_copilot_status, fetch output with "
            "qgis_copilot_result, stop with qgis_copilot_abort. engine: "
            "'acp' drives `copilot --acp --stdio` over JSON-RPC; "
            "'print' runs `copilot -p`; 'auto' (default) prefers acp. "
            "Both use the CLI's gh sign-in — no API key needed. "
            "session_id resumes a Copilot session (acp: session/load, "
            "print: -r). permission_mode 'dangerous' (default) sets "
            "COPILOT_ALLOW_ALL=true (auto-approve all tools + trust "
            "cwd); 'accept-edits' passes --allow-all-tools only. Each "
            "run consumes Copilot premium requests.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string",
                           "description": "Task instruction for "
                                          "Copilot"},
                "cwd": {"type": "string",
                        "description": "Working directory "
                                       "(default: user home)"},
                "session_id": {"type": "string",
                               "description": "Resume this Copilot "
                                              "session id "
                                              "(acp: session/load, "
                                              "print: -r)"},
                "model": {"type": "string",
                          "description": "Copilot model override "
                                         "(--model)"},
                "permission_mode": {
                    "type": "string",
                    "enum": ["normal", "accept-edits", "smart",
                             "dangerous"],
                    "description": "Permission auto-answer policy "
                                   "(default: dangerous)"},
                "engine": {
                    "type": "string",
                    "enum": ["auto", "acp", "print"],
                    "description": "'acp'=`copilot --acp --stdio` "
                                   "JSON-RPC, 'print'=`copilot -p`, "
                                   "'auto'=prefer acp (default)"},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "qgis_copilot_status",
        "description":
            "Check a Copilot CLI task's state (running/exited/failed), "
            "elapsed seconds and recent log output. Omit task_id to "
            "list all agent tasks of this QGIS process.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
            },
        },
    },
    {
        "name": "qgis_copilot_result",
        "description":
            "Fetch a Copilot CLI task's captured output (log tail). "
            "Call after qgis_copilot_status shows the task exited. "
            "tail = max characters returned (default 20000).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "tail": {"type": "integer"},
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "qgis_copilot_abort",
        "description":
            "Kill a running Copilot CLI task started via "
            "qgis_copilot_run.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
            },
            "required": ["task_id"],
        },
    },
]

class _Handler(BaseHTTPRequestHandler):
    server_version = "qgis-live/0.3"
    protocol_version = "HTTP/1.1"

    _LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

    def log_message(self, *args):
        pass  # stay quiet: stderr tends to die inside QGIS

    # ---- shared utilities ----

    def _local_req_ok(self):
        """Verify from the headers that the request came from loopback.

        Guards against DNS rebinding and browser-based attacks: a request whose
        Host points outside loopback, or whose Origin points at a non-loopback
        site, is rejected. Local web apps (localhost origin) are allowed.
        """
        host = self.headers.get("Host", "")
        if host:
            h = host.strip()
            if h.startswith("["):
                h = h[1:h.index("]")] if "]" in h else h.strip("[]")
            else:
                h = h.split(":")[0]
            if h.lower() not in self._LOCAL_HOSTS:
                self._json(403, {"error": "forbidden host"})
                return False
        origin = self.headers.get("Origin")
        if origin is not None:
            try:
                oh = urlparse(origin).hostname or ""
            except Exception:
                oh = ""
            if oh.lower() not in self._LOCAL_HOSTS:
                self._json(403, {"error": "forbidden origin"})
                return False
        return True

    def _auth_ok(self):
        """Check the token. At least one valid key is required (none denies all)."""
        keys = self.server.api_keys
        if not keys:
            return False
        auth = self.headers.get("Authorization", "")
        tok = ""
        if auth.lower().startswith("bearer "):
            tok = auth[7:].strip()
        if not tok:
            tok = (self.headers.get("X-Api-Key")
                   or self.headers.get("api-key") or "")
        return bool(tok) and any(
            hmac.compare_digest(tok, k) for k in keys)

    def _gate(self, path):
        """Auth gate. /api/health passes unauthenticated for liveness checks."""
        if not self._local_req_ok():
            return False
        if path == "/api/health" or self._auth_ok():
            return True
        self._json(401, {"error": "unauthorized"})
        return False

    def _allowed(self, ctype):
        """Command-kind filter from QGIS_LIVE_TOOLS. None allows all."""
        allow = self.server.allowed
        return allow is None or ctype in allow

    def _tools(self):
        return [t for t in TOOLS if self._allowed(t["name"][len("qgis_"):])]

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json(self, code, obj, extra_headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _dispatch(self, cmd, timeout=180.0):
        return self.server.driver.submit(cmd, timeout=timeout,
                                         origin="http")

    # ---- REST ----

    def do_GET(self):
        if not self._gate(self.path):
            return
        if self.path == "/api/health":
            self._json(200, {"ok": True, "pid": os.getpid(),
                             "plugin": "geo_driver"})
        elif self.path == "/api/tools":
            self._json(200, {"tools": self._tools()})
        elif self.path == "/api/status":
            if not self._allowed("status"):
                self._json(403, {"error": "type 'status' not allowed"})
                return
            self._json(200, self._dispatch({"type": "status"}))
        elif self.path.startswith("/api/tasks/"):
            task_id = self.path[len("/api/tasks/"):].strip()
            if not task_id:
                self._json(400, {"error": "task_id required"})
                return
            if not self._allowed("task_status"):
                self._json(403, {"error": "type 'task_status' not allowed"})
                return
            rep = self._dispatch({"type": "task_status", "task_id": task_id})
            self._json(200 if "error" not in rep else 500, rep)
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        # drain the body first so an unread one can't break the next keep-alive request
        body = self._read_body()
        if not self._gate(self.path):
            return
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception as e:
            self._json(400, {"error": f"bad json: {e}"})
            return
        if self.path == "/api/cmd":
            # dispatch the command JSON as-is (type/plugin_id etc. remain valid)
            self._api_call(data)
        elif self.path == "/api/pyeval":
            self._api_call({"type": "pyeval", "code": data.get("code", ""),
                            "plugin_id": data.get("plugin_id")})
        elif self.path == "/api/pyeval_async":
            self._api_call({"type": "pyeval_async",
                            "code": data.get("code", "")})
        elif self.path == "/api/eval":
            self._api_call({"type": "eval",
                            "expression": data.get("expression", ""),
                            "plugin_id": data.get("plugin_id")})
        elif self.path == "/api/screenshot":
            self._api_shot(data.get("path"), data.get("plugin_id"),
                           data.get("target"))
        else:
            self._json(404, {"error": "not found"})

    def _api_call(self, cmd):
        if not self._allowed(cmd.get("type", "")):
            self._json(403, {"error":
                             f"type '{cmd.get('type')}' not allowed"})
            return
        # don't send an unset plugin_id (leaving it out keeps "local/default target")
        if cmd.get("plugin_id") is None:
            cmd.pop("plugin_id", None)
        rep = self._dispatch(cmd)
        self._json(200 if "error" not in rep else 500, rep)

    def _api_shot(self, path, plugin_id=None, target=None):
        if not self._allowed("screenshot"):
            self._json(403, {"error": "type 'screenshot' not allowed"})
            return
        if not path:
            path = os.path.join(tempfile.gettempdir(),
                                f"qgis-shot-{uuid.uuid4().hex[:8]}.png")
        cmd = {"type": "screenshot", "path": path}
        if plugin_id:
            cmd["plugin_id"] = plugin_id
        if target:
            cmd["target"] = target
        rep = self._dispatch(cmd)
        if "error" in rep:
            self._json(500, rep)
            return
        try:
            with open(rep["result"], "rb") as f:
                png = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.end_headers()
            self.wfile.write(png)
        except Exception as e:
            self._json(500, {"error": repr(e)})


def start_http(driver, host="127.0.0.1", port=0,
               api_keys=None, allowed=None):
    """Start the HTTP server on a daemon thread and return the actual port.

    api_keys: set of accepted tokens. Required (empty rejects every request).
    allowed: set of permitted command kinds. None allows all.
    """
    httpd = ThreadingHTTPServer((host, port), _Handler)
    httpd.daemon_threads = True
    httpd.driver = driver
    httpd.api_keys = set(api_keys or ())
    httpd.allowed = allowed
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, httpd.server_address[1]
