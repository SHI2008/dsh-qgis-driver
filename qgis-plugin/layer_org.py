"""Layer organization service (LayerOrganizer).

Provides cross-plugin "display standardization for added layers".
Layers added by geo_import and others are moved into layer tree groups,
renamed and styled according to the rules of a profile JSON.

Placement (same bundled-default + user-override pattern as agents/skills):
  bundled : <plugin>/layer_org/*.json    (read-only defaults)
  user    : ~/.qgis-live/layer_org/*.json (honours QGIS_LIVE_REGISTRY, same name wins)

The active profile is QSettings "dsh_qgis_driver/layer_org/profile"
(stem name, default "default").

Profile JSON schema:
  {
    "name": "default",              // display name (default = file stem)
    "description": "...",           // purpose note
    "root": "Imported Data",        // parent of every group (default = tree root)
    "enabled": true,                // false disables organizing
    "rules": [                      // first match wins; all keys ANDed
      {"match": {"format": ["wms","wmts","xyz"],   // ctx resource format or extension
                 "ext": ["shp","gpkg"],            // layer source extension
                 "provider": ["wms","ogr"],        // layer.providerType()
                 "layer_type": ["vector","raster","mesh","pointcloud"],
                 "geom": ["point","line","polygon","none","unknown"],
                 "plugin": ["geo_import"],         // calling plugin id from ctx
                 "name_re": "regex",               // search layer/resource name
                 "dataset_re": "regex",            // search ctx dataset name
                 "url_re": "regex"},               // search resource URL/layer source
       "group": "Background/Services",  // '/'-separated group path (under root)
       "rename": "{dataset} - {resource}",   // optional. also {name}{format}{ext}{provider}
       "style": "styles/foo.qml",   // optional. .qml relative to profile dir or absolute
       "top": true}                 // optional. insert at group top (default = end)
    ],
    "fallback": "Other"             // group when no rule matches (default = do not move)
  }

Every QGIS operation that assumes the GUI thread is confined to imports inside
methods, so this module itself imports with stdlib only (unit test target).
"""

import json
import os

from .profile_store import DEFAULT_PROFILE, ProfileStore

_PROFILES = ProfileStore("layer_org")
import re

_SETTING_PROFILE = _PROFILES.setting_key
_DEFAULT_PROFILE = DEFAULT_PROFILE


def profiles_dir():
    """Directory for user-defined profiles: ~/.qgis-live/layer_org/."""
    return _PROFILES.user_dir


def _bundled_dir():
    """Directory of the plugin's bundled default profiles."""
    return _PROFILES.bundled_dir


def list_profiles():
    """Available profiles. [{id,name,description,builtin,path}]."""
    return _PROFILES.list()


def load_profile(name):
    """Profile id -> (dict, path). (None, None) when not found."""
    return _PROFILES.load(name)


# ---- layer attribute extraction (QGIS dependencies kept inside functions) ----

_SOURCE_SPLIT_RE = re.compile(r"[|?]")


def _layer_ext(source):
    """Estimate the extension from a layer source string (leading path part only)."""
    if not source:
        return ""
    head = _SOURCE_SPLIT_RE.split(source, 1)[0]
    # URI-parameter forms (url=...) carry no file extension
    if "=" in os.path.basename(head):
        return ""
    ext = os.path.splitext(head)[1]
    return ext.lstrip(".").lower()


def layer_attrs(layer, ctx=None):
    """Build the attribute dict for rule matching from the layer plus context.

    ctx keys (supplied by the caller): plugin_id / dataset / dataset_id /
    resource / resource_id / format / url / file / tags
    """
    ctx = dict(ctx or {})
    attrs = {"ctx": ctx}
    try:
        attrs["name"] = layer.name() or ""
    except Exception:
        attrs["name"] = ""
    try:
        attrs["provider"] = (layer.providerType() or "").lower()
    except Exception:
        attrs["provider"] = ""
    # QgsMapLayerType: 0 vector 1 raster 2 plugin 3 mesh
    #                4 vector_tile 5 pointcloud 6 annotation 7 group 8 3d
    try:
        lt = int(layer.type())
        attrs["layer_type"] = {
            0: "vector", 1: "raster", 2: "plugin", 3: "mesh",
            4: "vector_tile", 5: "pointcloud", 6: "annotation",
            7: "group", 8: "3d",
        }.get(lt, "other")
    except Exception:
        attrs["layer_type"] = "other"
    geom = "none"
    if attrs["layer_type"] == "vector":
        try:
            from qgis.core import QgsWkbTypes
            gt = int(QgsWkbTypes.geometryType(layer.wkbType()))
            geom = {0: "point", 1: "line", 2: "polygon"}.get(gt, "unknown")
        except Exception:
            geom = "unknown"
    attrs["geom"] = geom
    src = ""
    try:
        src = layer.source() or ""
    except Exception:  # nosec B110  # acceptable by design
        pass
    attrs["source"] = src
    ext = _layer_ext(str(ctx.get("file") or "")) \
        or _layer_ext(src)
    attrs["ext"] = ext
    attrs["format"] = str(ctx.get("format") or "").strip().lower() \
        or ext
    attrs["url"] = str(ctx.get("url") or src or "")
    return attrs


def match_rule(rules, attrs):
    """Evaluate the rule array from the top and return the first match.

    All keys of rule["match"] must match (AND). An empty/missing match always matches.
    """
    for i, rule in enumerate(rules or []):
        m = rule.get("match") or {}
        if _match_all(m, attrs):
            return i, rule
    return None, None


def _match_all(m, attrs):
    ctx = attrs.get("ctx") or {}
    for key, want in m.items():
        if key == "format":
            cand = {attrs.get("format", ""), attrs.get("ext", "")}
            if not {str(w).lower() for w in _as_list(want)} & cand:
                return False
        elif key == "ext":
            if attrs.get("ext", "") not in \
                    {str(w).lower().lstrip(".") for w in _as_list(want)}:
                return False
        elif key == "provider":
            if attrs.get("provider", "") not in \
                    {str(w).lower() for w in _as_list(want)}:
                return False
        elif key == "layer_type":
            if attrs.get("layer_type", "") not in \
                    {str(w).lower() for w in _as_list(want)}:
                return False
        elif key == "geom":
            if attrs.get("geom", "") not in \
                    {str(w).lower() for w in _as_list(want)}:
                return False
        elif key == "plugin":
            if str(ctx.get("plugin_id") or "") not in \
                    {str(w) for w in _as_list(want)}:
                return False
        elif key == "name_re":
            text = "\n".join([attrs.get("name", ""),
                              str(ctx.get("resource") or "")])
            if not re.search(str(want), text):
                return False
        elif key == "dataset_re":
            if not re.search(str(want),
                             str(ctx.get("dataset") or "")):
                return False
        elif key == "url_re":
            if not re.search(str(want), attrs.get("url", "")):
                return False
        elif key == "tags":
            tags = {str(t).lower() for t in _as_list(ctx.get("tags") or [])}
            if not {str(w).lower() for w in _as_list(want)} & tags:
                return False
        else:
            return False   # unknown keys fail the match (do not silence config errors)
    return True


def render_template(tpl, attrs):
    """Substitute the {token}s of a rename template with attribute values."""
    ctx = attrs.get("ctx") or {}
    mapping = {
        "name": attrs.get("name", ""),
        "provider": attrs.get("provider", ""),
        "ext": attrs.get("ext", ""),
        "format": attrs.get("format", ""),
        "layer_type": attrs.get("layer_type", ""),
        "geom": attrs.get("geom", ""),
        "plugin": ctx.get("plugin_id") or "",
        "dataset": ctx.get("dataset") or "",
        "resource": ctx.get("resource") or "",
        "url": ctx.get("url") or "",
    }

    def _sub(mo):
        return str(mapping.get(mo.group(1), mo.group(0)))

    return re.sub(r"\{([a-z_]+)\}", _sub, str(tpl)).strip()


class LayerOrganizer:
    """Organize added layers into the layer tree using the profile rules.

    Other plugins call this as plugins['dsh_qgis_driver'].layer_org.place_all().
    When the driver is absent or the profile is disabled, it quietly returns a
    no-op report so the caller can fall back to its previous behavior.
    """

    # ---------- profile resolution ----------

    def active_profile_name(self):
        return _PROFILES.active_name()

    def set_active_profile(self, name):
        return _PROFILES.set_active(str(name or ""))

    def profile(self, name=None):
        """Return the profile dict (omitted = active). None if disabled/missing."""
        return _PROFILES.profile(name)

    # ---------- the organizing itself ----------

    def place_all(self, items, profile_name=None, dry=False):
        """Place items=[(layer, ctx)|layer, ...] by applying the rules.

        @returns {"profile": id, "enabled": bool,
                  "placed": [...], "skipped": [...]}
        """
        prof = self.profile(profile_name)
        entries, skipped = [], []
        pid = (prof or {}).get("id")
        for it in items:
            if isinstance(it, tuple):
                layer, ctx = it
            else:
                layer, ctx = it, {}
            try:
                entries.append(self.place(layer, ctx, prof, dry=dry))
            except Exception as e:
                skipped.append({"error": repr(e)})
        return {"profile": pid, "enabled": prof is not None,
                "placed": entries, "skipped": skipped}

    def place(self, layer, ctx=None, prof=None, dry=False):
        """Place one layer by applying the rules and return its result entry."""
        attrs = layer_attrs(layer, ctx)
        entry = {"layer": attrs.get("name"), "attrs": {
            k: attrs[k] for k in
            ("provider", "layer_type", "geom", "ext", "format")}}
        if prof is None:
            entry["action"] = "disabled"
            return entry
        idx, rule = match_rule(prof.get("rules"), attrs)
        group_path = None
        if rule is not None:
            entry["rule"] = idx
            group_path = rule.get("group")
        elif prof.get("fallback"):
            entry["rule"] = "fallback"
            group_path = prof["fallback"]
        if group_path:
            root = prof.get("root")
            full = f"{root}/{group_path}" if root else group_path
            entry["group"] = full
            if not dry:
                top = bool(rule and rule.get("top"))
                group = self._ensure_group(full)
                self._move_to_group(layer, group, top=top)
                if rule and rule.get("collapsed"):
                    try:
                        group.setExpanded(False)
                    except Exception:  # nosec B110  # acceptable by design
                        pass
        else:
            entry["action"] = "no-match"
            return entry
        if rule and rule.get("rename"):
            new_name = render_template(rule["rename"], attrs)
            if new_name:
                entry["renamed"] = new_name
                if not dry:
                    try:
                        layer.setName(new_name)
                        # keep the already placed tree node in sync
                        self._rename_node(layer, new_name)
                    except Exception:  # nosec B110  # acceptable by design
                        pass
        if rule and rule.get("style"):
            style = rule["style"]
            if not os.path.isabs(style):
                style = os.path.join(prof.get("_dir") or "", style)
            entry["style"] = style
            if not dry:
                try:
                    layer.loadNamedStyle(style)
                    layer.triggerRepaint()
                except Exception:  # nosec B110  # acceptable by design
                    pass
        entry["action"] = "dry" if dry else "placed"
        return entry

    def organize_project(self, profile_name=None, dry=False):
        """Re-organize every layer in the project (idempotent).

        There is no context, so ctx keys such as format/plugin/tags only get
        values derived from the layer.
        """
        from qgis.core import QgsProject
        items = [(ly, {}) for ly in QgsProject.instance().mapLayers().values()]
        return self.place_all(items, profile_name=profile_name, dry=dry)

    def describe(self, name=None):
        """Profile summary for bridge display."""
        prof, path = load_profile(name or self.active_profile_name())
        if prof is None:
            return None
        return {
            "id": prof.get("id"), "name": prof.get("name"),
            "description": prof.get("description"),
            "path": path, "root": prof.get("root"),
            "enabled": prof.get("enabled") is not False,
            "fallback": prof.get("fallback"),
            "rules": [{"match": r.get("match") or {},
                       "group": r.get("group"),
                       "rename": r.get("rename"),
                       "style": r.get("style")}
                      for r in prof.get("rules") or []],
        }

    # ---------- layer tree operations (QGIS-dependent) ----------

    def _ensure_group(self, path):
        """Walk a '/'-separated path, creating groups, and return the leaf."""
        from qgis.core import QgsLayerTree, QgsProject
        parent = QgsProject.instance().layerTreeRoot()
        for part in [p for p in str(path).split("/") if p]:
            nxt = None
            for ch in parent.children():
                if QgsLayerTree.isGroup(ch) and ch.name() == part:
                    nxt = ch
                    break
            if nxt is None:
                nxt = parent.addGroup(part)
            parent = nxt
        return parent

    @staticmethod
    def _move_to_group(layer, group, top=False):
        """Move the layer's tree node into the given group.

        A layer may have several nodes, so clone the original node into the
        group and then remove the original (avoiding ownership problems).
        When there is no node (addToLegend=False, etc.), add it directly.
        """
        from qgis.core import QgsProject
        root = QgsProject.instance().layerTreeRoot()
        node = root.findLayer(layer.id())
        if node is None:
            group.addLayer(layer)
            return
        parent = node.parent()
        if parent is group:
            return
        new_node = node.clone()
        parent.removeChildNode(node)
        group.insertChildNode(0 if top else -1, new_node)

    @staticmethod
    def _rename_node(layer, new_name):
        from qgis.core import QgsLayerTree, QgsProject
        node = QgsProject.instance().layerTreeRoot().findLayer(layer.id())
        if node is not None and QgsLayerTree.isLayer(node):
            try:
                node.setName(new_name)
            except Exception:  # nosec B110  # acceptable by design
                pass
