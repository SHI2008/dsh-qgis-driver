# Scale-linked standard line widths (dsh_qgis_driver scale_style)

Procedure for suggesting a standard, appropriate line width from the layer's use (category) and the display scale, then applying it to the renderer.
use_when: the user asks to decide line widths, line thickness by scale, the "appropriate line width", or scale-dependent styling

## Principles

- Line widths come from a **standard table** of "category (road/river/boundary, etc.) × scale band". Values live in profile JSON; never guess.
- Call via `qgis_bridge_call` → `plugin_id="dsh_qgis_driver"`. There are five methods:
  `scaleStyleProfiles` / `scaleStyleTable` / `setScaleStyleProfile` / `suggestScaleWidth` / `applyScaleWidth`
- "Just show me suggestions" = `suggestScaleWidth` or `applyScaleWidth(dry=True)`; actual apply = `applyScaleWidth`

## Methods

| Method | args | Returns |
|---|---|---|
| `scaleStyleProfiles` | none | Profile list + active. Bundled `default` + user `~/.qgis-live/scale_style/*.json` |
| `scaleStyleTable` | `[profile]` | Full scale-band / category base_mm and real_width_m for the active (or given) profile |
| `setScaleStyleProfile` | `[name]` | Switch the active profile (persisted in QSettings) |
| `suggestScaleWidth` | `[layer_id, category, scale, profile]` | `{category, scale, band, base_mm, factor, width_mm, real_width_m, width_m_equiv}` |
| `applyScaleWidth` | `[layer_id, category, scale, mode, profile, dry]` | Apply result. mode=`mm`/`meters`/`rules`; dry=true returns the plan only |

Defaults when omitted: layer_id=active layer, category=inferred from layer name/geom, scale=current canvas scale.

## Choosing a mode (applyScaleWidth)

| mode | Meaning | Good for |
|---|---|---|
| `mm` | Fix a paper width (mm) suited to the current scale | Layers used at a single scale; quick cleanup |
| `meters` | Draw in real-world metres (RenderMetersInMapUnits). Apparent thickness changes with zoom | Widths where real size matters (road width, river width, buffer representation) |
| `rules` | Generate a rule-based renderer whose width switches per scale band | Standard finish for layers used across a wide scale range; the legend shows band names + widths |

`rules` delegates to geo_legend's `applyRules` when loaded (the result gains `delegated`); when not loaded or on failure it falls back to dsh_qgis_driver's internal implementation. The returned `rules[]` shows each band's `min_scale`/`max_scale`/`width`.

## Recipe

```text
1. First look at the suggestion:
   qgis_bridge_call dsh_qgis_driver suggestScaleWidth [null, null, null]
   → check category/band/width_mm/real_width_m and present them to the user

2. Apply (fixed width):
   qgis_bridge_call dsh_qgis_driver applyScaleWidth [null, null, null, "mm"]

3. Switch to scale-band rules (recommended, standard finish):
   qgis_bridge_call dsh_qgis_driver applyScaleWidth [null, null, null, "rules"]
   → check the legend display with legendSpec (geo_legend)
```

- If category inference is wrong, pass `category` explicitly (e.g. `"road_major"`). The list is `categories[].key` in `scaleStyleTable`
- If the user asks to switch profiles: `scaleStyleProfiles` → `setScaleStyleProfile`
- For user-defined standards, create `~/.qgis-live/scale_style/<name>.json` to override the bundled `default` under the same name or add an alias (write the file with qgis_pyeval)

## Structure of the bundled default profile

```json
{
  "scale_bands": [{"max": 2500, "label": "up to 1:2,500", "factor": 1.5}, ...],
  "categories": [
    {"key": "road_major", "match": {"name_re": "国道|主要|..."},
     "base_mm": 0.55, "real_width_m": 13.0}, ...
  ]
}
```

- `width_mm = base_mm × band factor` (rounded to 0.05–10). The base band (1:5,000–25,000) has factor=1.0
- `match` is `name_re` (layer-name regex) or `geom` (line/polygon). First match wins; `default` is the fallback
- Categories whose `real_width_m` is null (boundaries, contours, etc.) cannot use mode=`meters` → choose `mm` or `rules`

## Notes

- Targets are line/polygon vector layers (with a stroke width). Points/rasters fail with `layer is not a line/polygon vector layer`
- To return to a single symbol after applying rules, use geo_legend `applySingleSymbol`
- A scale-band rule's active range is `min_scale < scale denominator <= max_scale` (QGIS behaviour)
