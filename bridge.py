"""AI-facing bridge for geo_driver itself.

The driver's own features are already callable from every route through the
LiveDriver command surface (pyeval/status/bridge_call etc.), so this module only
provides the self-description for the describe_plugins catalog and a runtime
status report.
"""

import json
import os

_PLUGIN_ID = "geo_driver"

_COMMANDS = [
    {"name": "pyeval", "signature": "pyeval(code)",
     "description": "Run arbitrary Python inside the QGIS process (access to iface, "
                    "QgsProject, etc.)"},
    {"name": "eval", "signature": "eval(code)",
     "description": "Run JavaScript inside a WebEngine plugin page (view required)"},
    {"name": "status", "signature": "status()",
     "description": "List the driver, loaded plugins, and bridge availability"},
    {"name": "describe_plugins", "signature": "describe_plugins()",
     "description": "AI-usable capability catalog of all plugins (aggregated pluginInfo)"},
    {"name": "bridge_call", "signature": "bridge_call(plugin_id, method, args)",
     "description": "Call a plugin's bridge method directly (a generic adapter answers for "
                    "plugins without a bridge)"},
    {"name": "open_plugin", "signature": "open_plugin(plugin_id)",
     "description": "Load a plugin and open it via run()"},
    {"name": "reload_plugin", "signature": "reload_plugin(plugin_id)",
     "description": "Reload a plugin (with a junction install, code changes apply "
                    "immediately)"},
    {"name": "screenshot", "signature": "screenshot(target, path)",
     "description": "Capture a PNG of the map canvas, main window, or dock"},
]


class GeoDriverBridge:
    """Self-description bridge for QGIS Live Driver.

    Methods return JSON strings (same contract as other plugins' bridges).
    """

    def __init__(self, plugin):
        self._plugin = plugin

    @staticmethod
    def _ok(payload=None):
        obj = {"ok": True}
        if payload:
            obj.update(payload)
        return json.dumps(obj, ensure_ascii=False)

    def pluginInfo(self):
        """Standard self-description for the describe_plugins catalog."""
        return self._ok({
            "id": _PLUGIN_ID,
            "name": "QGIS Live Driver",
            "summary": "Remote-control hub inside the QGIS process. Exposes "
                       "pyeval/status/bridge_call/describe_plugins and friends over file JSONL, "
                       "REST. The layer_org service standardizes grouping and naming of "
                       "imported layers; the scale_style service suggests and applies standard "
                       "line widths by scale (real-world metres / scale-band rules).",
            "when_to_use": [
                "Inspect or manipulate QGIS internals directly (iface, QgsProject, "
                "features, layers)",
                "Call another plugin's features through bridge_call",
                "Take screenshots of the map canvas or windows",
                "Load or reload plugins",
                "Group and rename imported layers by rule",
                "Set layer line widths to standard values for the current scale",
                "Set line widths in real-world metres and keep them tied to zoom",
                "Build rule-based renderers whose line width changes by scale band",
            ],
            "invoke": {"type": "command",
                       "note": "Use the driver's command surface (REST tools such as qgis_pyeval) instead "
                               "of bridge_call",
                       "commands": _COMMANDS},
            "methods": [
                {"name": "pluginInfo", "signature": "pluginInfo()",
                 "description": "Return this self-description"},
                {"name": "status", "signature": "status()",
                 "description": "Driver runtime status (live_dir/http_port/pid)"},
                {"name": "deployMode", "signature": "deployMode()",
                 "description": "Return the deploy mode (dev/use) and each plugin's install form "
                                "(junction/dir); read-only"},
                {"name": "layerOrgProfiles",
                 "signature": "layerOrgProfiles()",
                 "description": "Layer-organization profiles and the active one "
                                "(~/.qgis-live/layer_org/*.json + bundled)"},
                {"name": "layerOrgRules",
                 "signature": "layerOrgRules(profile=None)",
                 "description": "Return a profile's rule list (default: active)"},
                {"name": "setLayerOrgProfile",
                 "signature": "setLayerOrgProfile(name)",
                 "description": "Switch the active profile (persisted in QSettings)"},
                {"name": "organizeLayers",
                 "signature": "organizeLayers(profile=None, dry=False)",
                 "description": "Reorganize all layers by rule (dry=True previews)"},
                {"name": "placeLayer",
                 "signature": "placeLayer(layer_id=None, ctx=None)",
                 "description": "Place a single layer by rule (default: active layer)"},
                {"name": "scaleStyleProfiles",
                 "signature": "scaleStyleProfiles()",
                 "description": "Return the line-width profiles and the active one "
                                "(~/.qgis-live/scale_style/*.json + bundled)"},
                {"name": "scaleStyleTable",
                 "signature": "scaleStyleTable(profile=None)",
                 "description": "Return a profile's scale-band / category line-width table (default: "
                                "active)"},
                {"name": "setScaleStyleProfile",
                 "signature": "setScaleStyleProfile(name)",
                 "description": "Switch the active line-width profile (persisted in QSettings)"},
                {"name": "suggestScaleWidth",
                 "signature": "suggestScaleWidth(layer_id=None, "
                              "category=None, scale=None, profile=None)",
                 "description": "Suggest a standard line width from the layer/category and scale. If "
                                "scale is omitted, the current canvas scale is used; if category is "
                                "omitted it is inferred from the layer name (road/boundary/river, etc.). "
                                "Returns width_mm (paper width) and real_width_m (real-world width)."},
                {"name": "applyScaleWidth",
                 "signature": "applyScaleWidth(layer_id=None, category=None,"
                              " scale=None, mode='mm', profile=None,"
                              " dry=False)",
                 "description": "Apply a standard line width to a layer. mode='mm' fixes a paper width "
                                "for the current scale; 'meters' sets a real-world width (m) tied to "
                                "zoom; 'rules' generates a rule-based renderer whose width changes per "
                                "scale band (delegated to applyRules when geo_legend is loaded). dry=True "
                                "returns the plan only."},
                {"name": "openAiPanel",
                 "signature": "openAiPanel()",
                 "description": "Open the AI assistant panel (dock)"},
                {"name": "openConnInfo",
                 "signature": "openConnInfo()",
                 "description": "Open the connection info dialog (REST endpoints)"},
                {"name": "openDeployMode",
                 "signature": "openDeployMode()",
                 "description": "Open the Deploy Mode dialog (switching is done in the dialog UI)"},
                {"name": "listDevPlugins",
                 "signature": "listDevPlugins()",
                 "description": "Return hot-reload targets (ids of in-development plugins installed as "
                                "junctions)"},
                {"name": "hotReload",
                 "signature": "hotReload(plugin_ids=None)",
                 "description": "Immediately reload in-development plugins (sys.modules cleanup + "
                                "reloadPlugin; default: all targets)"},
                {"name": "remoteControl",
                 "signature": "remoteControl(enabled=None)",
                 "description": "Get/set whether remote control (file JSONL / HTTP surface) is enabled"},
                {"name": "auditLog",
                 "signature": "auditLog(n=50, filter=None)",
                 "description": "Return the latest n audit-log entries (~/.qgis-live/audit-*.jsonl), "
                                "newest first. filter is a field-match dict or a substring"},
                {"name": "auditSettings",
                 "signature": "auditSettings(enabled=None, max_bytes=None,"
                              " max_files=None)",
                 "description": "Get/set audit-log enablement and size/generation limits (persisted in "
                                "QSettings)"},
            ],
        })

    @staticmethod
    def _err(msg):
        return json.dumps({"ok": False, "error": str(msg)},
                          ensure_ascii=False)

    def status(self):
        """Return the driver runtime status."""
        d = self._plugin.driver
        org = getattr(self._plugin, "layer_org", None)
        return self._ok({
            "id": _PLUGIN_ID,
            "pid": os.getpid(),
            "remote_enabled": d is not None,
            "live_dir": getattr(d, "dir", None),
            "http_port": getattr(d, "http_port", None),
            "commands": [c["name"] for c in _COMMANDS],
            "layer_org": (org.active_profile_name()
                          if org is not None else None),
            "scale_style": (
                self._styler().active_profile_name()
                if self._styler() is not None else None),
        })

    def deployMode(self):
        """Return the deploy mode (dev/use) and each plugin's install form (read-only).

        Switching is a human operation, so only reading is exposed (switching
        happens in the Deploy Mode menu dialog, or via
        npm run deploy / deploy:use / deploy:install).
        """
        try:
            from .mode_switch import deploy_state
            own = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "__init__.py")
            return self._ok(deploy_state(own))
        except Exception as e:
            return self._err(f"deployMode failed: {e}")

    # ---- Layer organization (layer_org) ----

    def _org(self):
        return getattr(self._plugin, "layer_org", None)

    def layerOrgProfiles(self):
        """Return the available layer-organization profiles and the active one."""
        from . import layer_org as lo
        org = self._org()
        return self._ok({
            "profiles": lo.list_profiles(),
            "active": (org.active_profile_name()
                       if org is not None else None),
        })

    def layerOrgRules(self, profile=None):
        """Return a profile's rule list (default: active)."""
        org = self._org()
        if org is None:
            return self._err("layer_org not available")
        desc = org.describe(profile)
        if desc is None:
            return self._err(
                f"profile not found or disabled: "
                f"{profile or org.active_profile_name()}")
        return self._ok(desc)

    def setLayerOrgProfile(self, name):
        """Switch the active organization profile (persisted in QSettings)."""
        org = self._org()
        if org is None:
            return self._err("layer_org not available")
        return json.dumps(org.set_active_profile(name),
                          ensure_ascii=False)

    def organizeLayers(self, profile=None, dry=False):
        """Re-place every layer in the project according to the profile's rules.

        dry=True returns only the planned results without moving anything (preview).
        """
        org = self._org()
        if org is None:
            return self._err("layer_org not available")
        rep = org.organize_project(profile_name=profile,
                                   dry=bool(dry))
        return self._ok(rep)

    def placeLayer(self, layer_id=None, ctx=None):
        """Place a single layer according to the organization rules.

        layer_id defaults to the active layer. ctx is a dict such as
        {"plugin_id","dataset","resource","format","url"}.
        """
        org = self._org()
        if org is None:
            return self._err("layer_org not available")
        from qgis.core import QgsProject
        from qgis.utils import iface
        layer = None
        if layer_id:
            layer = QgsProject.instance().mapLayer(str(layer_id))
        if layer is None:
            layer = iface.activeLayer() if iface is not None else None
        if layer is None:
            return self._err("no layer (pass layer_id or activate one)")
        rep = org.place_all([(layer, dict(ctx or {}))])
        return self._ok(rep)

    # ---- Standard line width (scale_style) ----

    def _styler(self):
        return getattr(self._plugin, "scale_style", None)

    def scaleStyleProfiles(self):
        """Return the available standard line-width profiles and the active one."""
        from . import scale_style as ss
        styler = self._styler()
        return self._ok({
            "profiles": ss.list_profiles(),
            "active": (styler.active_profile_name()
                       if styler is not None else None),
        })

    def scaleStyleTable(self, profile=None):
        """Return a profile's scale-band / category line-width table."""
        styler = self._styler()
        if styler is None:
            return self._err("scale_style not available")
        desc = styler.describe(profile)
        if desc is None:
            return self._err(
                f"profile not found or disabled: "
                f"{profile or styler.active_profile_name()}")
        return self._ok(desc)

    def setScaleStyleProfile(self, name):
        """Switch the active line-width profile (persisted in QSettings)."""
        styler = self._styler()
        if styler is None:
            return self._err("scale_style not available")
        return json.dumps(styler.set_active_profile(name),
                          ensure_ascii=False)

    def suggestScaleWidth(self, layer_id=None, category=None, scale=None,
                          profile=None):
        """Suggest a standard line width from the layer/category and scale.

        scale defaults to the current canvas scale; category defaults to an
        inference from the layer name; layer defaults to the active layer.
        """
        styler = self._styler()
        if styler is None:
            return self._err("scale_style not available")
        layer = None
        if layer_id is not None or category is None:
            layer = styler._find_layer(layer_id)
            if layer is None:
                return self._err(
                    "layer not found (pass layer_id or activate one)")
        return self._ok(
            styler.suggest(layer=layer, category=category,
                           scale=scale, profile_name=profile))

    def applyScaleWidth(self, layer_id=None, category=None, scale=None,
                        mode="mm", profile=None, dry=False):
        """Apply a standard line width to the layer's renderer.

        mode:
          "mm"     — fix a paper width (mm) for the current scale
          "meters" — set a real-world width (m) and keep it tied to zoom
          "rules"  — generate a rule renderer whose width switches per scale band
        dry=True returns only the plan without applying it.
        """
        styler = self._styler()
        if styler is None:
            return self._err("scale_style not available")
        layer = styler._find_layer(layer_id)
        if layer is None:
            return self._err(
                "layer not found (pass layer_id or activate one)")
        rep = styler.apply(layer, mode=mode, category=category,
                           scale=scale, profile_name=profile,
                           dry=bool(dry))
        if rep.get("ok"):
            return self._ok(rep)
        return self._err(rep)

    # ---- Driver's own UI/operation ----

    def openAiPanel(self):
        """Open the AI assistant panel."""
        self._plugin._open_ai_panel()
        panel = getattr(self._plugin, "_ai_panel", None)
        return self._ok({"opened": panel is not None,
                         "visible": bool(panel is not None
                                         and panel.isVisible())})

    def openConnInfo(self):
        """Open the connection info dialog."""
        self._plugin._open_conn_info()
        return self._ok({"opened": True})

    def openDeployMode(self):
        """Open the Deploy Mode dialog (switching is UI-only)."""
        from qgis.PyQt.QtCore import QTimer
        QTimer.singleShot(0, self._plugin._open_mode_dialog)
        return self._ok({"launched": True})

    def listDevPlugins(self):
        """Return the hot-reload targets (ids of plugins installed in dev mode)."""
        try:
            from .hot_reload import dev_plugin_ids
            own = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "__init__.py")
            return self._ok({"plugin_ids": dev_plugin_ids(own)})
        except Exception as e:
            return self._err(f"dev_plugin_ids failed: {e}")

    def hotReload(self, plugin_ids=None):
        """Reload in-development plugins (default: all targets, driver last).

        Only junction installs (repo-preferred) are targeted. This is a fuller
        reload than the reload_plugin command because it also cleans sys.modules.
        """
        try:
            from .hot_reload import dev_plugin_ids, reload_plugins
            own = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "__init__.py")
            ids = plugin_ids or dev_plugin_ids(own)
            if isinstance(ids, str):
                ids = [ids]
            reload_plugins(list(ids), notify=None)
            return self._ok({"reloaded": list(ids)})
        except Exception as e:
            return self._err(f"hotReload failed: {e}")

    def remoteControl(self, enabled=None):
        """Get/set whether remote control is enabled.

        enabled=True starts the file JSONL/HTTP surface, False stops it.
        No confirmation dialog is shown when enabling (the caller decides).
        Note: setting False means remote commands will no longer arrive.
        """
        p = self._plugin
        if enabled is not None:
            if enabled and p.driver is None:
                p._set_setting(True)
                p._start(p._default_live_base())
                if p.driver is None:
                    p._set_setting(False)
            elif not enabled and p.driver is not None:
                p._set_setting(False)
                p._stop()
            try:
                p._sync_action()
            except Exception:  # nosec B110  # acceptable by design
                pass
        d = p.driver
        return self._ok({"enabled": d is not None,
                         "live_dir": getattr(d, "dir", None),
                         "http_port": getattr(d, "http_port", None)})

    # ---- Audit log ----

    def auditLog(self, n=50, filter=None):
        """Return the most recent n audit-log entries, newest first.

        Reads ~/.qgis-live/audit-*.jsonl (daily + generations split by size cap).
        filter is a field-match dict such as
        {"type":"pyeval","plugin_id":"x","ok":false}, or a substring matched
        against type/method/plugin_id/origin. Secrets in args are already
        masked when recorded.
        """
        try:
            from .live_driver import _audit_recent
            entries = _audit_recent(max(int(n or 50), 1), filter)
            return self._ok({"count": len(entries), "entries": entries})
        except Exception as e:
            return self._err(f"auditLog failed: {e}")

    def auditSettings(self, enabled=None, max_bytes=None, max_files=None):
        """Get/change the audit-log settings (persisted in QSettings).

        enabled = recording on/off, max_bytes = size cap for one file (rotates
        to a timestamped generation when exceeded), max_files = retained
        generation count.
        """
        try:
            from .live_driver import _audit_base_dir, _audit_conf
            if enabled is not None or max_bytes is not None \
                    or max_files is not None:
                from qgis.PyQt.QtCore import QSettings
                s = QSettings()
                if enabled is not None:
                    s.setValue("geo_driver/audit/enabled", bool(enabled))
                if max_bytes is not None:
                    s.setValue("geo_driver/audit/max_bytes",
                               int(max_bytes))
                if max_files is not None:
                    s.setValue("geo_driver/audit/max_files",
                               int(max_files))
            on, mb, mf = _audit_conf()
            return self._ok({"enabled": on, "max_bytes": mb,
                             "max_files": mf, "dir": _audit_base_dir()})
        except Exception as e:
            return self._err(f"auditSettings failed: {e}")
