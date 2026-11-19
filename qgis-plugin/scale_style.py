# SPDX-License-Identifier: GPL-3.0-or-later
# Based on QGIS Live Harness by yamamoto-ryuzo (GPL-3.0); modified.
"""Scale-linked standard line width service (ScaleStyler).

Unlike CAD, GIS can tie line width to scale:

- ``mm``       : paper/screen width (mm). Picks the current scale's width from the standard table
- ``meters``   : draw at the feature's real width (m). Apparent thickness changes with zoom
                 (QgsUnitTypes.RenderMetersInMapUnits; real meters, CRS-independent)
- ``rules``    : build a rule-based renderer with a different width per scale band, so the
                 width switches automatically as the scale changes

The standard width table is managed by profile JSON (the same two tiers as layer_org):
  bundled : <plugin>/scale_style/*.json    (read-only defaults)
  user    : ~/.qgis-live/scale_style/*.json (honours QGIS_LIVE_REGISTRY, same name wins)

The active profile is QSettings "dsh_qgis_driver/scale_style/profile"
(stem name, default "default").

Profile JSON schema:
  {
    "name": "default",
    "description": "...",
    "scale_bands": [            // ascending denominators (smaller = finer). first match wins
      {"max": 2500,   "label": "up to 1:2,500",   "factor": 1.5},
      {"max": 25000,  "label": "~1:25,000",       "factor": 1.0},
      {"max": null,   "label": "1:250,000~",      "factor": 0.4}
    ],
    "categories": [             // first match wins. match keys are the same as layer_org
      {"key": "road_major",
       "match": {"name_re": "trunk|primary|motorway", "geom": "line"},
       "base_mm": 0.55,         // paper width in mm at the base band (factor=1.0)
       "real_width_m": 13.0},   // real-world width (m) in meters mode (optional)
      {"key": "default", "match": {}, "base_mm": 0.3}
    ]
  }

Every QGIS operation that assumes the GUI thread is confined to imports inside
methods, so this module itself imports with stdlib only (unit test target).
"""

import json
import os

from .profile_store import DEFAULT_PROFILE, ProfileStore

_PROFILES = ProfileStore("scale_style")

from .layer_org import _match_all, layer_attrs

_SETTING_PROFILE = _PROFILES.setting_key
_DEFAULT_PROFILE = DEFAULT_PROFILE


def profiles_dir():
    """Directory for user-defined profiles: ~/.qgis-live/scale_style/."""
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


def band_for_scale(prof, scale):
    """Return the scale_bands entry for a scale denominator (first match wins).

    band["max"] is the upper bound (exclusive). max=None means "everything above".
    scale=None (unknown) returns the base band with factor=1.0 (the first if none).
    """
    bands = prof.get("scale_bands") or []
    if scale is None:
        for b in bands:
            if b.get("factor") == 1.0:
                return b
        return bands[0] if bands else None
    try:
        s = float(scale)
    except (TypeError, ValueError):
        return band_for_scale(prof, None)
    prev = None
    for b in bands:
        mx = b.get("max")
        if mx is None or s < float(mx):
            return b
        prev = b
    return bands[-1] if bands else prev


def match_category(prof, attrs):
    """Evaluate categories from the top and return the first match."""
    for cat in prof.get("categories") or []:
        if _match_all(cat.get("match") or {}, attrs):
            return cat
    return None


def mm_to_meters(width_mm, scale):
    """Paper mm -> feature real width in m (scale = scale denominator). None if unknown."""
    try:
        return round(float(width_mm) * float(scale) / 1000.0, 3)
    except (TypeError, ValueError):
        return None


def suggested_mm(prof, cat, scale):
    """Return the recommended mm width: category base_mm times the band factor.

    @returns (width_mm, band) - band is the result of band_for_scale().
    """
    band = band_for_scale(prof, scale)
    base = float((cat or {}).get("base_mm") or 0.3)
    factor = float((band or {}).get("factor") or 1.0)
    w = round(base * factor, 2)
    return max(0.05, min(w, 10.0)), band


_UNIT_NAMES = {
    "mm": "RenderMillimeters",
    "pixels": "RenderPixels",
    "px": "RenderPixels",
    "map_units": "RenderMapUnits",
    "meters": "RenderMetersInMapUnits",
    "m": "RenderMetersInMapUnits",
}


def _qgis_unit(name, default="mm"):
    """Unit name -> QgsUnitTypes.RenderUnit."""
    from qgis.core import QgsUnitTypes
    attr = _UNIT_NAMES.get(str(name or default).lower(),
                           _UNIT_NAMES[default])
    # Qt6 (scoped enum) needs RenderUnit.<name>; flat exposure allows direct access
    try:
        return getattr(QgsUnitTypes, attr)
    except AttributeError:
        return getattr(QgsUnitTypes.RenderUnit, attr)


def _set_symbol_width(symbol, width, unit_name="mm"):
    """Set the width on every symbol layer inside the symbol.

    Lines/markers use setWidth+setWidthUnit, fill outlines use
    setStrokeWidth+setStrokeWidthUnit.
    """
    unit = _qgis_unit(unit_name)
    for i in range(symbol.symbolLayerCount()):
        sl = symbol.symbolLayer(i)
        if hasattr(sl, "setWidth"):
            sl.setWidth(float(width))
            if hasattr(sl, "setWidthUnit"):
                sl.setWidthUnit(unit)
        if hasattr(sl, "setStrokeWidth"):
            sl.setStrokeWidth(float(width))
            if hasattr(sl, "setStrokeWidthUnit"):
                sl.setStrokeWidthUnit(unit)


def renderer_symbols(renderer):
    """Enumerate every symbol held by the renderer."""
    from qgis.core import (QgsCategorizedSymbolRenderer,
                           QgsGraduatedSymbolRenderer,
                           QgsRuleBasedRenderer,
                           QgsSingleSymbolRenderer)
    if renderer is None:
        return []
    if isinstance(renderer, QgsSingleSymbolRenderer):
        return [renderer.symbol()]
    if isinstance(renderer, QgsCategorizedSymbolRenderer):
        return [c.symbol() for c in renderer.categories()]
    if isinstance(renderer, QgsGraduatedSymbolRenderer):
        return [r.symbol() for r in renderer.ranges()]
    if isinstance(renderer, QgsRuleBasedRenderer):
        out = []

        def walk(rule):
            if rule.symbol() is not None:
                out.append(rule.symbol())
            for ch in rule.children():
                walk(ch)

        walk(renderer.rootRule())
        return out
    try:
        from qgis.core import QgsRenderContext
        return list(renderer.symbols(QgsRenderContext()))
    except Exception:  # nosec B110  # acceptable by design
        return []


def _symbol_color(symbol):
    try:
        return symbol.color().name()
    except Exception:  # nosec B110  # acceptable by design
        return None


class ScaleStyler:
    """Shared service that derives layer line widths from the standard table plus scale.

    Reachable from other plugins via plugins['dsh_qgis_driver'].scale_style.
    Even with a disabled or missing profile it quietly returns an error dict.
    """

    # ---------- profile resolution ----------

    def active_profile_name(self):
        return _PROFILES.active_name()

    def set_active_profile(self, name):
        return _PROFILES.set_active(str(name or ""))

    def profile(self, name=None):
        return _PROFILES.profile(name)

    def describe(self, name=None):
        """Profile summary used by describe()."""
        prof, path = load_profile(name or self.active_profile_name())
        if prof is None:
            return None
        return {
            "id": prof.get("id"), "name": prof.get("name"),
            "description": prof.get("description"),
            "path": path,
            "enabled": prof.get("enabled") is not False,
            "scale_bands": prof.get("scale_bands") or [],
            "categories": [
                {"key": c.get("key"),
                 "match": c.get("match") or {},
                 "base_mm": c.get("base_mm"),
                 "real_width_m": c.get("real_width_m")}
                for c in prof.get("categories") or []],
        }

    # ---------- recommended value computation ----------

    @staticmethod
    def canvas_scale():
        """Scale denominator of the current map canvas (None when unavailable)."""
        try:
            from qgis.utils import iface
            return iface.mapCanvas().scale()
        except Exception:  # nosec B110  # acceptable by design
            return None

    def categorize(self, layer, ctx=None):
        """Infer the category from the layer name/attributes."""
        prof = self.profile()
        attrs = layer_attrs(layer, ctx)
        cat = match_category(prof or {}, attrs)
        return (cat.get("key") if cat else None), cat

    def suggest(self, layer=None, category=None, scale=None,
                profile_name=None):
        """Return the recommended line width. When scale is omitted, the current canvas scale.

        @returns dict: {category, scale, band, base_mm, factor,
                        width_mm, real_width_m, width_m_equiv}
        """
        prof = self.profile(profile_name)
        if prof is None:
            return {"ok": False,
                    "error": "profile not found or disabled"}
        cat = None
        if category:
            for c in prof.get("categories") or []:
                if c.get("key") == category:
                    cat = c
                    break
            if cat is None:
                return {"ok": False,
                        "error": f"category not found: {category}",
                        "categories": [c.get("key") for c in
                                       prof.get("categories") or []]}
        elif layer is not None:
            cat = match_category(prof, layer_attrs(layer))
        if cat is None:
            cat = next((c for c in prof.get("categories") or []
                        if c.get("key") == "default"), None)
        if cat is None:
            return {"ok": False, "error": "no matching category"}
        s = scale if scale is not None else self.canvas_scale()
        w_mm, band = suggested_mm(prof, cat, s)
        real_m = cat.get("real_width_m")
        if real_m is None:
            real_m = mm_to_meters(w_mm, s)
        return {"ok": True,
                "category": cat.get("key"),
                "scale": s,
                "band": (band or {}).get("label"),
                "base_mm": cat.get("base_mm"),
                "factor": (band or {}).get("factor"),
                "width_mm": w_mm,
                "real_width_m": real_m,
                "width_m_equiv": mm_to_meters(w_mm, s)}

    # ---------- applying (QGIS-dependent) ----------

    @staticmethod
    def _find_layer(sel):
        """Resolve a layer from layer_id / layer name / None (= active)."""
        from qgis.core import QgsProject
        from qgis.utils import iface
        if sel is None:
            return iface.activeLayer()
        proj = QgsProject.instance()
        layer = proj.mapLayer(str(sel))
        if layer is None:
            matches = proj.mapLayersByName(str(sel))
            layer = matches[0] if matches else None
        return layer

    @staticmethod
    def _is_strokable(layer):
        """Whether the layer can take a line width (line, or polygon outline)."""
        from qgis.core import QgsWkbTypes
        try:
            gt = QgsWkbTypes.geometryType(layer.wkbType())
        except Exception:
            return False
        return int(gt) in (
            int(QgsWkbTypes.GeometryType.LineGeometry),
            int(QgsWkbTypes.GeometryType.PolygonGeometry))

    def apply(self, layer, mode="mm", category=None, scale=None,
              profile_name=None, dry=False):
        """Apply the standard line width to the layer's renderer.

        mode:
          "mm"     - fix the recommended mm width for the current scale
          "meters" - set the real-world width (m) (zoom-linked)
          "rules"  - build a scale-band rule renderer (width switches with scale)
        dry=True returns the planned content without applying it.
        """
        mode = str(mode or "mm").lower()
        if mode in ("map_units", "m", "real"):
            mode = "meters"
        if mode not in ("mm", "meters", "rules"):
            return {"ok": False,
                    "error": f"unknown mode: {mode} "
                             "(mm|meters|rules)"}
        if not self._is_strokable(layer):
            return {"ok": False,
                    "error": "layer is not a line/polygon vector layer"}
        ren = layer.renderer() if hasattr(layer, "renderer") else None
        if ren is None:
            return {"ok": False, "error": "layer has no renderer"}

        if mode == "rules":
            return self._apply_rules(layer, category, profile_name, dry)

        sug = self.suggest(layer=layer, category=category,
                           scale=scale, profile_name=profile_name)
        if not sug.get("ok"):
            return sug
        symbols = renderer_symbols(ren)
        if not symbols:
            return {"ok": False, "error": "renderer has no symbols"}
        applied = {"mode": mode, "suggest": sug,
                   "symbols": len(symbols)}
        if mode == "mm":
            applied["width_mm"] = sug["width_mm"]
        else:
            m = sug["real_width_m"]
            if m is None:
                return {"ok": False,
                        "error": "no real width for category; "
                                 "use mode=mm or pass scale"}
            applied["width_m"] = m
        if not dry:
            if mode == "mm":
                for sym in symbols:
                    _set_symbol_width(sym, applied["width_mm"], "mm")
            else:
                for sym in symbols:
                    _set_symbol_width(sym, applied["width_m"], "meters")
            layer.triggerRepaint()
        return {"ok": True, "layer": layer.name(), **applied}

    def _apply_rules(self, layer, category, profile_name, dry):
        """Build and apply the scale-band rule renderer."""
        prof = self.profile(profile_name)
        if prof is None:
            return {"ok": False, "error": "profile not found or disabled"}
        attrs = layer_attrs(layer)
        cat = (next((c for c in prof.get("categories") or []
                     if c.get("key") == category), None)
               if category else match_category(prof, attrs))
        if cat is None:
            cat = next((c for c in prof.get("categories") or []
                        if c.get("key") == "default"), None)
        if cat is None:
            return {"ok": False, "error": "no matching category"}
        base_mm = float(cat.get("base_mm") or 0.3)
        bands = prof.get("scale_bands") or []
        if not bands:
            return {"ok": False, "error": "profile has no scale_bands"}

        # inherit the color of the current symbol
        color = None
        syms = renderer_symbols(layer.renderer())
        if syms:
            color = _symbol_color(syms[0])

        specs, prev = [], 0
        for b in bands:
            mx = b.get("max")
            w = round(base_mm * float(b.get("factor") or 1.0), 2)
            w = max(0.05, min(w, 10.0))
            label = f"{b.get('label') or ('1:' + str(mx))} ({w:g}mm)"
            # a band's active range is min_scale < scale denominator <= max_scale
            # (min_scale = detail-side exclusive lower, max_scale = overview upper)
            specs.append({"label": label,
                          "min_scale": int(prev) if prev else 0,
                          "max_scale": int(mx) if mx else 0,
                          "width": w,
                          "color": color})
            prev = mx
        if dry:
            return {"ok": True, "mode": "rules", "dry": True,
                    "category": cat.get("key"), "rules": specs}

        # One path only: this plugin builds the rule renderer itself. It used to
        # hand off to another plugin's bridge when that happened to be loaded,
        # which meant the same profile produced different legends depending on
        # what else was installed.
        return self._apply_rules_local(layer, specs, cat)

    def _apply_rules_local(self, layer, specs, cat):
        """Rule renderer construction, independent of any other plugin."""
        from qgis.core import QgsRuleBasedRenderer, QgsWkbTypes
        gt = QgsWkbTypes.geometryType(layer.wkbType())
        sym_cls = {
            int(QgsWkbTypes.GeometryType.PointGeometry):
                __import__("qgis.core", fromlist=["QgsMarkerSymbol"])
                .QgsMarkerSymbol,
            int(QgsWkbTypes.GeometryType.LineGeometry):
                __import__("qgis.core", fromlist=["QgsLineSymbol"])
                .QgsLineSymbol,
        }.get(int(gt))
        if sym_cls is None:
            from qgis.core import QgsFillSymbol
            sym_cls = QgsFillSymbol
        from qgis.PyQt.QtGui import QColor
        root = QgsRuleBasedRenderer.Rule(None)
        for spec in specs:
            sym = sym_cls.createSimple({})
            if spec.get("color"):
                sym.setColor(QColor(str(spec["color"])))
            _set_symbol_width(sym, spec["width"], "mm")
            # Rule ctor: (symbol, maximumScale, minimumScale, filterExp,
            #             label). active range is min<scale<=max
            root.appendChild(QgsRuleBasedRenderer.Rule(
                sym, int(spec.get("max_scale") or 0),
                int(spec.get("min_scale") or 0), "",
                str(spec.get("label") or "")))
        layer.setRenderer(QgsRuleBasedRenderer(root))
        layer.triggerRepaint()
        return {"ok": True, "mode": "rules",
                "category": cat.get("key"),
                "delegated": None, "rules": specs}
