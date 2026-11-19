"""HTTP server built into dsh_qgis_driver. Standard library only.

Serves a plain REST surface on one port, so AI tools/apps can drive QGIS
with nothing but HTTP POST.

  POST /api/cmd          dispatch the command JSON as-is ({"type":"status"} etc.)
  POST /api/pyeval       {"code": "..."} -> {"result": ...} | {"error": ...}
  POST /api/pyeval_async {"code": "..."} -> {"task_id": "..."} (background task)
  GET  /api/tasks/<id>   {"status": ..., "result"/"error": ...} (poll async task)
  POST /api/task_cancel  {"task_id": "..."} or {"task_ids": [...]} -> cancel queued
                         shards (running ones only record the request)
  POST /api/pyeval_group {"tasks": [{"name","code"}], "max_workers": 4}
  POST /api/screenshot   {"path": "...?", "target": "..."}
                         -> PNG binary (Content-Type: image/png)
  GET  /api/tools        tool spec JSON (for function-calling AIs to read)
  GET  /api/status       result of the status command
  GET  /api/health       {"ok": true, "pid": ...}

Execution path: HTTP worker thread -> driver.submit() puts it on the in-memory queue ->
the GUI thread's LiveDriver._poll runs it -> the worker waits and returns the result.
Only the GUI thread ever touches iface/QgsProject.

Binds to 127.0.0.1 on a free port. This surface is local-only by design: the
client is the DSH bundle running on the same machine. There is no remote
mode, no bind-address setting and no stable API key to share.

Auth:
  Every endpoint (other than /api/health) requires the per-session token.
  The token is generated at driver start and written only to user-only files
  (live_dir/token and the registry JSON); local clients read it from there.
  Send it as Authorization: Bearer, X-Api-Key, or api-key.
  Requests whose Host is not loopback, or whose Origin points outside
  loopback, are rejected (DNS rebinding and browser attacks).
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
            "the `result` variable.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {"type": "string"},
            },
            "required": ["code"],
        },
    },
    {
        "name": "qgis_screenshot",
        "description":
            "Capture PNG of the live map canvas. "
            "target: canvas|mainwindow. Returns the image.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "target": {"type": "string"},
            },
        },
    },
    {
        "name": "qgis_status",
        "description":
            "Driver status: pid, http port, loaded plugins and which have "
            "live drivers / views.",
        "inputSchema": {"type": "object", "properties": {}},
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
        """Check the per-session token (an empty token denies every request)."""
        keys = self.server.tokens
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
                             "plugin": "dsh_qgis_driver"})
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
            # dispatch the command JSON as-is
            self._api_call(data)
        elif self.path == "/api/pyeval":
            self._api_call({"type": "pyeval", "code": data.get("code", ""),
                            "timeout": data.get("timeout")})
        elif self.path == "/api/pyeval_async":
            self._api_call({"type": "pyeval_async",
                            "code": data.get("code", "")})
        elif self.path == "/api/pyeval_group":
            self._api_call({"type": "pyeval_group",
                            "tasks": data.get("tasks") or [],
                            "max_workers": data.get("max_workers")})
        elif self.path == "/api/task_cancel":
            self._api_call({"type": "task_cancel",
                            "task_id": data.get("task_id"),
                            "task_ids": data.get("task_ids") or []})
        elif self.path == "/api/screenshot":
            self._api_shot(data.get("path"), data.get("target"))
        else:
            self._json(404, {"error": "not found"})

    def _api_call(self, cmd):
        if not self._allowed(cmd.get("type", "")):
            self._json(403, {"error":
                             f"type '{cmd.get('type')}' not allowed"})
            return
        rep = self._dispatch(cmd)
        self._json(200 if "error" not in rep else 500, rep)

    def _api_shot(self, path, target=None):
        if not self._allowed("screenshot"):
            self._json(403, {"error": "type 'screenshot' not allowed"})
            return
        if not path:
            path = os.path.join(tempfile.gettempdir(),
                                f"qgis-shot-{uuid.uuid4().hex[:8]}.png")
        cmd = {"type": "screenshot", "path": path}
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


def start_http(driver, port=0, token=None, allowed=None):
    """Start the loopback HTTP server on a daemon thread; returns (httpd, port).

    token: the per-session token every request must present. An empty token
        denies every request.
    allowed: set of permitted command kinds. None allows all.
    """
    httpd = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    httpd.daemon_threads = True
    httpd.driver = driver
    httpd.tokens = {token} if token else set()
    httpd.allowed = allowed
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, httpd.server_address[1]
