# SPDX-License-Identifier: GPL-3.0-or-later
# Based on QGIS Live Harness by yamamoto-ryuzo (GPL-3.0); modified.
"""Shared JSON profile store (bundled defaults + user overrides).

`layer_org` and `scale_style` both keep named JSON profiles the same way: a
bundled set next to this module (``<kind>/``) and a user set under
``~/.qgis-live/<kind>/``, where a user file overrides a bundled one with the
same stem. This module is the single implementation of that layout; each
feature module owns only what is specific to its profile contents.
"""

import json
import os

DEFAULT_PROFILE = "default"


def registry_dir():
    """Root of the runtime registry (``QGIS_LIVE_REGISTRY`` overrides it)."""
    return os.environ.get(
        "QGIS_LIVE_REGISTRY",
        os.path.join(os.path.expanduser("~"), ".qgis-live"))


class ProfileStore:
    """Named JSON profiles for one feature area (``kind`` = directory name)."""

    def __init__(self, kind):
        self.kind = kind

    @property
    def setting_key(self):
        return f"dsh_qgis_driver/{self.kind}/profile"

    @property
    def user_dir(self):
        return os.path.join(registry_dir(), self.kind)

    @property
    def bundled_dir(self):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), self.kind)

    def list(self):
        """Available profiles. [{id,name,description,builtin,path}].

        Scans bundled then user; a same stem is overridden by the user side.
        """
        out = {}
        for d, builtin in ((self.bundled_dir, True), (self.user_dir, False)):
            if not os.path.isdir(d):
                continue
            for f in sorted(os.listdir(d)):
                if not f.lower().endswith(".json"):
                    continue
                stem = f[:-5]
                if not builtin or stem not in out:
                    p = os.path.join(d, f)
                    name, desc = stem, ""
                    try:
                        with open(p, "r", encoding="utf-8") as fh:
                            meta = json.load(fh)
                        name = meta.get("name") or stem
                        desc = meta.get("description") or ""
                    except Exception:  # nosec B110  # acceptable by design
                        pass
                    out[stem] = {"id": stem, "name": name, "description": desc,
                                 "path": p, "builtin": builtin}
        return [out[k] for k in sorted(out)]

    def load(self, name):
        """Profile id -> (dict, path). (None, None) when not found."""
        for p in self.list():
            if p["id"] == name:
                try:
                    with open(p["path"], "r", encoding="utf-8") as f:
                        prof = json.load(f)
                except Exception:
                    return None, None
                prof["_path"] = p["path"]
                prof["_dir"] = os.path.dirname(p["path"])
                prof["id"] = name
                return prof, p["path"]
        return None, None

    def active_name(self):
        """Name of the active profile (falls back to ``default``)."""
        try:
            from qgis.PyQt.QtCore import QSettings
            v = QSettings().value(self.setting_key, DEFAULT_PROFILE)
            return str(v or DEFAULT_PROFILE)
        except Exception:
            return DEFAULT_PROFILE

    def set_active(self, name):
        """Switch the active profile by id."""
        prof, _ = self.load(str(name or ""))
        if prof is None:
            return {"ok": False,
                    "error": f"profile not found: {name}",
                    "profiles": [p["id"] for p in self.list()]}
        try:
            from qgis.PyQt.QtCore import QSettings
            QSettings().setValue(self.setting_key, str(name))
        except Exception:  # nosec B110  # acceptable by design
            pass
        return {"ok": True, "active": str(name)}

    def profile(self, name=None):
        """Return the profile dict (omitted = active). None if disabled/missing."""
        prof, _ = self.load(name or self.active_name())
        if prof is None or prof.get("enabled") is False:
            return None
        return prof
