"""Store API keys in the OS credential store (stdlib only, no Qt dependency).

Backends (in priority order):
  - Windows: DPAPI (CryptProtectData/CRYPTPROTECT_UI_FORBIDDEN).
    The same mechanism as browser-saved passwords, so the ciphertext can only
    be decrypted while "this user is logged in on this machine".
    The encrypted blob itself is kept base64-encoded in
    ~/.qgis-live/ai-secrets.json
  - macOS: `security` CLI -> login keychain
  - Linux: Secret Service via `secret-tool` (libsecret) when available
    (GNOME Keyring / KWallet).
    Otherwise ~/.qgis-live/ai-secrets.json is used as a chmod 600
    plain-text file (the same level as Chrome's basic storage).

No path here protects against a process running with the same user's
privileges (the same trust boundary as browser password storage). It differs
from plain QSettings storage in that other users, or mere file/registry
exfiltration, cannot decrypt it.

ai_panel uses only set_secret/get_secret/delete_secret/backend_label. On
failure these return None/False and the caller decides whether to fall back
to plain QSettings.
"""

import base64
import json
import os
import shutil
import subprocess  # nosec B404  # needed to run icacls/security/secret-tool
import sys

try:
    from qgis.PyQt.QtCore import QCoreApplication, QT_TRANSLATE_NOOP
except ImportError:
    QCoreApplication = None

    def QT_TRANSLATE_NOOP(ctx, src):  # noqa: N802
        return src


_LBL_DPAPI = QT_TRANSLATE_NOOP(
    "dsh_qgis_driver",
    "Windows DPAPI (encrypted under the user account, "
    "same mechanism as browser password storage)")
_LBL_KEYCHAIN = QT_TRANSLATE_NOOP("dsh_qgis_driver", "macOS Keychain")
_LBL_FILE = QT_TRANSLATE_NOOP(
    "dsh_qgis_driver",
    "~/.qgis-live/ai-secrets.json (mode 600, plain text; "
    "no keyring available)")

_SERVICE = "qgis-live-driver"


def _secrets_path():
    d = os.environ.get(
        "QGIS_LIVE_REGISTRY",
        os.path.join(os.path.expanduser("~"), ".qgis-live"))
    return os.path.join(d, "ai-secrets.json")


def _restrict_file(path):
    try:
        if os.name == "nt":
            user = os.environ.get("USERNAME") or ""
            exe = shutil.which("icacls") or os.path.join(
                os.environ.get("SystemRoot", r"C:\Windows"),
                "System32", "icacls.exe")
            if user:
                subprocess.run(  # nosec B603  # fixed args plus USERNAME only
                    [exe, path, "/inheritance:r",
                     "/grant:r", f"{user}:F"],
                    capture_output=True, timeout=10)
        else:
            os.chmod(path, 0o600)
    except Exception:  # nosec B110  # acceptable by design
        pass


def _load_file():
    try:
        with open(_secrets_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_file(data):
    path = _secrets_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)
    _restrict_file(path)


# ---- Windows DPAPI ----

def _dpapi_crypt(data, protect):
    """CryptProtectData/CryptUnprotectData. None on failure."""
    import ctypes
    from ctypes import wintypes

    class _BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _BLOB(len(data),
                    ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = _BLOB()
    crypt32 = ctypes.windll.crypt32
    fn = crypt32.CryptProtectData if protect \
        else crypt32.CryptUnprotectData
    # CRYPTPROTECT_UI_FORBIDDEN=0x1: do not show a UI prompt
    if not fn(ctypes.byref(blob_in), None, None, None, None,
              0x1, ctypes.byref(blob_out)):
        return None
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _dpapi_set(name, secret):
    blob = _dpapi_crypt(secret.encode("utf-8"), protect=True)
    if blob is None:
        return False
    data = _load_file()
    data[name] = {"v": "dpapi",
                  "data": base64.b64encode(blob).decode("ascii")}
    _save_file(data)
    return True


def _dpapi_get(name):
    ent = (_load_file().get(name) or {})
    if ent.get("v") != "dpapi":
        return None
    try:
        raw = _dpapi_crypt(base64.b64decode(ent["data"]), protect=False)
    except Exception:
        return None
    return raw.decode("utf-8") if raw is not None else None


# ---- macOS keychain (security CLI) ----

def _security(*args, stdin=None):
    exe = shutil.which("security")
    if not exe:
        return 1, ""
    try:
        r = subprocess.run([exe, *args],  # nosec B603  # fixed flags only
                           input=stdin, capture_output=True,
                           timeout=15)
        return r.returncode, r.stdout.decode("utf-8", "replace")
    except Exception:
        return 1, ""


def _keychain_set(name, secret):
    rc, _ = _security("add-generic-password", "-U",
                      "-s", _SERVICE, "-a", name, "-w", secret)
    return rc == 0


def _keychain_get(name):
    rc, out = _security("find-generic-password",
                        "-s", _SERVICE, "-a", name, "-w")
    return out.rstrip("\n") if rc == 0 else None


# ---- Linux Secret Service (secret-tool) ----

def _secret_tool(*args, stdin=None):
    exe = shutil.which("secret-tool")
    if not exe:
        return 1, ""
    try:
        r = subprocess.run([exe, *args],  # nosec B603  # fixed flags only
                           input=stdin, capture_output=True,
                           timeout=15)
        return r.returncode, r.stdout.decode("utf-8", "replace")
    except Exception:
        return 1, ""


def _ss_set(name, secret):
    rc, _ = _secret_tool("store",
                         "--label=dsh-qgis-driver API key",
                         "service", _SERVICE, "account", name,
                         stdin=secret.encode("utf-8"))
    return rc == 0


def _ss_get(name):
    rc, out = _secret_tool("lookup",
                           "service", _SERVICE, "account", name)
    return out.rstrip("\n") if rc == 0 else None


# ---- file (plain-text fallback, chmod 600) ----

def _file_set(name, secret):
    data = _load_file()
    data[name] = {"v": "plain",
                  "data": base64.b64encode(
                      secret.encode("utf-8")).decode("ascii")}
    _save_file(data)
    return True


def _file_get(name):
    ent = (_load_file().get(name) or {})
    try:
        return base64.b64decode(ent["data"]).decode("utf-8")
    except Exception:
        return None


# ---- public API ----

def backend():
    """Return the id of the backend in use."""
    if sys.platform == "win32":
        return "dpapi"
    if sys.platform == "darwin" and shutil.which("security"):
        return "keychain"
    if sys.platform.startswith("linux") and shutil.which("secret-tool"):
        return "secret-tool"
    return "file"


def backend_label():
    """Backend description for UI display."""
    src = {
        "dpapi": _LBL_DPAPI,
        "keychain": _LBL_KEYCHAIN,
        "secret-tool": "Secret Service (GNOME Keyring / KWallet)",
        "file": _LBL_FILE,
    }[backend()]
    if QCoreApplication is not None:
        return QCoreApplication.translate("dsh_qgis_driver", src)
    return src


def set_secret(name, secret):
    """Store a secret. True on success."""
    if not secret:
        return delete_secret(name)
    try:
        b = backend()
        if b == "dpapi":
            return _dpapi_set(name, secret)
        if b == "keychain":
            return _keychain_set(name, secret)
        if b == "secret-tool":
            return _ss_set(name, secret)
        return _file_set(name, secret)
    except Exception:
        return False


def get_secret(name):
    """Return the stored secret, or None when absent."""
    try:
        b = backend()
        if b == "dpapi":
            return _dpapi_get(name)
        if b == "keychain":
            return _keychain_get(name)
        if b == "secret-tool":
            return _ss_get(name)
        return _file_get(name)
    except Exception:
        return None


def delete_secret(name):
    """Delete the stored secret. Idempotent: succeeds even when absent."""
    try:
        if get_secret(name) is None:
            return True
        b = backend()
        if b == "keychain":
            rc, _ = _security("delete-generic-password",
                              "-s", _SERVICE, "-a", name)
            return rc == 0
        if b == "secret-tool":
            rc, _ = _secret_tool("clear",
                                 "service", _SERVICE, "account", name)
            return rc == 0
        data = _load_file()
        if name in data:
            data.pop(name)
            _save_file(data)
        return True
    except Exception:
        return False
