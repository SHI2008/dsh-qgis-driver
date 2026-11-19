---
name: pyqgis-reference
description: "Use when writing raw PyQGIS inside the qgis-driver bundle (execute_qgis_sync) — loading vector/raster layers, features and fields, geometry ops, QgsExpression, CRS transforms, processing.run, map rendering and print-layout export on QGIS 4.2, plus the QGIS 3 → 4 API renames that break first attempts. Self-contained: no external skill needed."
---

# PyQGIS reference (QGIS 4.2, live application)

Everything here runs **inside an already initialised QGIS** — the driver owns the
`QgsApplication`, so never call `QgsApplication.initQgis()` / `exitQgis()`, and never
`Processing.initialize()` again (headless start did it).

What the driver pre-injects into every `execute_qgis_sync` / `submit_qgis_async` body:

| name | value |
|---|---|
| `prj` | `QgsProject.instance()` — the live project |
| `P` | the tool arguments as a dict |
| `_prj_extent()` | combined extent of all layers (`None` when empty) |
| `result` | assign it: the last expression or `result` is what the tool returns |

## Reading raster pixels without guessing the dtype

`QgsRasterBlock.data()` hands back raw bytes — decoding them with the wrong dtype is the
classic way to read `3.4e38` (the float32 "no data" bit pattern). Go through GDAL, or ask
the provider for its declared type first:

```python
rl = prj.mapLayersByName('dem')[0]
prov = rl.dataProvider()
blk = prov.block(1, rl.extent(), rl.width(), rl.height())
import numpy as np
arr = np.frombuffer(blk.data(), dtype=np.float32).reshape(blk.height(), blk.width())
arr[arr == blk.noDataValue()] = np.nan
result = {'dtype': str(arr.dtype), 'min': float(np.nanmin(arr)), 'max': float(np.nanmax(arr))}
```

Safer for anything bigger than a screen: let GDAL read it
`gdal.Open(path).ReadAsArray()` (float32 by default), or run the arithmetic as a
Processing algorithm so no array crosses the tool boundary at all.

## Do not shell out to a second QGIS

Writing a `.py` file and running it with the QGIS interpreter starts a **second**
`QgsApplication`: it fights this instance over the same files, cannot see `prj`, and the
driver never learns what happened. Everything belongs in `execute_qgis_sync` (main thread,
short) or `submit_qgis_async tasks[]` (worker threads, pure Python).

Prefer the structured tools (`qgis_layer`, `qgis_feature`, `qgis_layout`, …) — they resolve
names, validate parameters and return JSON. Use raw PyQGIS for what they do not cover.

## Vector layers

```python
vl = QgsVectorLayer(r"H:\data\roads.shp", "roads", "ogr")      # provider from the URI
prj.addMapLayer(vl)                                            # add to the project tree
vl.isValid(), vl.featureCount(), vl.wkbType(), vl.crs().authid()
[vl.fields().at(i).name() for i in range(vl.fields().count())]
```

Memory layer (no file on disk):

```python
vl = QgsVectorLayer("Point?crs=EPSG:4326&field=id:integer&field=name:string(50)", "pts", "memory")
```

Add a field / a feature:

```python
from qgis.PyQt.QtCore import QVariant
vl.dataProvider().addAttributes([QgsField("area", QVariant.Double)])
vl.updateFields()
f = QgsFeature(vl.fields())
f.setGeometry(QgsGeometry.fromPointXY(QgsPointXY(10, 45)))
f.setAttributes([1, "a", 12.5])
ok = vl.dataProvider().addFeatures([f])[0]
vl.updateExtents()
```

Read / filter / update:

```python
for f in vl.getFeatures(QgsFeatureRequest().setFilterExpression("class = 'A'").setLimit(10)):
    f["name"], f.geometry().asWkt()
vl.selectByExpression("area > 100")
vl.startEditing(); vl.changeAttributeValue(fid, idx, value); vl.commitChanges()
```

Providers: `ogr` (shp/geojson/gpkg), `gdal` (raster), `postgres`, `wms`, `wfs`,
`delimitedtext` (CSV), `spatialite`, `memory`, `virtual`. Choose by URI string, not by setter.

## Raster layers

```python
rl = QgsRasterLayer(r"H:\data\dem.tif", "dem")     # provider gdal inferred
rl.isValid(), rl.width(), rl.height(), rl.bandCount()
stats = rl.dataProvider().bandStatistics(1, QgsRasterBandStats.Min | QgsRasterBandStats.Max)
stats.minimumValue, stats.maximumValue
```

## Geometry

```python
g = QgsGeometry.fromWkt("POLYGON((0 0,1 0,1 1,0 1,0 0))")
p = QgsGeometry.fromPointXY(QgsPointXY(10, 45))
g.buffer(50, 8)          # distance in layer units, 8 segments per quarter
g.intersection(other); g.union(other); g.difference(other)
g.intersects(other); g.contains(other); g.distance(other)
g.area(); g.length(); g.centroid().asPoint(); g.boundingBox()
g.asWkt(); g.asJson()
g.transform(trs)         # in place
g.makeValid()            # repair self-intersections (returns a new geometry)
```

`QgsPointXY` is 2D, `QgsPoint` carries Z/M. Geometry snapping/precision: `g.snapGeometries`.

## CRS and transforms

```python
src = QgsCoordinateReferenceSystem("EPSG:4490")
dst = QgsCoordinateReferenceSystem("EPSG:3857")
trs = QgsCoordinateTransform(src, dst, prj)      # project supplies the transform context
pt = trs.transform(QgsPointXY(116.4, 39.9))      # point
g.transform(trs)                                 # geometry, in place
prj.setCrs(dst); prj.transformContext()
```

Never build a `QgsCoordinateTransform` without `prj` — the 2-arg form misses datum-shift grids.

## Expressions

```python
e = QgsExpression("$area / 10000")
ctx = QgsExpressionContext()
ctx.appendScopes(QgsExpressionContextUtils.globalProjectLayerScopes(vl))
for f in vl.getFeatures():
    ctx.setFeature(f)
    e.evaluate(ctx)
e.hasParserError(), e.parserErrorString()
```

Use the same string in `QgsFeatureRequest().setFilterExpression(...)` and in
`qgis_feature action=query expression="..."`.

## Processing

```python
import processing   # module, not qgis.processing

processing.run("native:buffer", {
    "INPUT": vl,                 # layer object or path
    "DISTANCE": 50,
    "SEGMENTS": 8,
    "DISSOLVE": False,
    "OUTPUT": "memory:buffered", # or a path ending in .gpkg/.shp/.tif
})["OUTPUT"]
```

`native:*` = vector, `gdal:*` = raster, `qgis:*` = core. Discover with
`qgis_analysis action=list keyword="clip"` / `action=help algorithm="native:buffer"` — that is
cheaper and more reliable than guessing parameter names. Long runs belong in
`submit_qgis_async` (threads) or the `qgis-batch-parallel` skill, never in a 30-second sync call.

## Rendering a map image

```python
from qgis.core import QgsMapSettings, QgsMapRendererSequentialJob
from qgis.PyQt.QtCore import QSize

ms = QgsMapSettings()
ms.setLayers([vl]); ms.setDestinationCrs(prj.crs())
ms.setExtent(vl.extent()); ms.setOutputSize(QSize(1600, 1200))
job = QgsMapRendererSequentialJob(ms); job.start(); job.waitForFinished()
job.renderedImage().save(r"C:\Temp\map.png")
```

Prefer `qgis_map action=render` — it handles the empty/single-point extent case for you.

## Print layouts (PDF / PNG)

```python
lay = QgsPrintLayout(prj)
lay.setName("A3")
lay.initializeDefaults()          # page setup — required before exporting
prj.addLayout(lay)                # keeps it alive across calls

m = QgsLayoutItemMap(lay)
m.setRect(QgsLayoutPoint(15, 20, QgsUnitTypes.LayoutMillimeters),
          QgsLayoutSize(180, 120, QgsUnitTypes.LayoutMillimeters))
m.setLayers([vl]); m.setExtent(vl.extent())
lay.addLayoutItem(m)

ex = QgsLayoutExporter(lay)
ex.exportToPdf(r"C:\Temp\out.pdf", QgsLayoutExporter.PdfExportSettings())
ex.exportToImage(r"C:\Temp\out.png", QgsLayoutExporter.ImageExportSettings())
```

Prefer `qgis_layout create/add_item/export` — it does `initializeDefaults()`, `addLayout` and the
legend/scalebar wiring for you, and returns `image_path` for inspection.

## QGIS 3 → 4 renames that break first attempts

These were observed as real failures; the right column is what QGIS 4.2 accepts.

| wrong | right |
|---|---|
| `QgsLayoutExporter(...).exportToImage` on a layout without page → `IndexError: list index out of range` | call `initializeDefaults()` + `prj.addLayout(lay)` first, or use `qgis_layout export` |
| `textFormat.setBufferEnabled(True)` | `buf = QgsTextBufferSettings(); buf.setEnabled(True); textFormat.setBuffer(buf)` |
| `legend.model().setLegendFilterByMapEnabled(...)` | `setLegendFilterByMap(True)` |
| `raster.setProviderKey("gdal")` / `setProviderType` | provider comes from the URI: `QgsRasterLayer(path, name, "gdal")` |
| `layer.setItemVisibilityChecked(False)` | `prj.layerTreeRoot().findLayer(layer.id()).setItemVisibilityChecked(False)` |
| `QgsSingleSymbolRenderer(QgsSimpleLineSymbolLayer())` | pass a symbol: `QgsLineSymbol()` / `QgsMarkerSymbol()` / `QgsFillSymbol()` |
| `renderer.symbol` (categorized/graduated) | `renderer.symbols()` or `renderer.updateSymbols(sym)` |
| `Qt.CompositionMode_SourceOver` | `QPainter.CompositionMode_SourceOver` |
| reused `lay` after a reload → `wrapped C/C++ object ... has been deleted` | the object was garbage collected: keep it on `prj`, rebuild instead of reusing the handle |
| `QgsRampColorRamp` import | `QgsGradientColorRamp` / `QgsRandomColorRamp` |

## Errors you should translate, not retry

- `AttributeError: 'QgsXxx' object has no attribute 'symbol'` — see the table; do not re-run blind.
- `IndexError: list index out of range` from a layout/legend call — an item list is empty; inspect
  with `qgis_layout action=info`.
- `RuntimeError: wrapped C/C++ object ... has been deleted` — rebuild the object, never patch it.
- `Could not load source layer ... no value specified for parameter` — a Processing input is
  missing; `qgis_analysis action=help algorithm="..."` lists the exact keys.

## Not available in this driver

- `iface` / `qgis.utils.iface` is `None` in the headless instance: canvas actions
  (`qgis_map screenshot|set_extent|zoom_to_layer`) need the GUI instance.
- `qgis._3d` and `qgis.server` are out of scope.
- No `pip install` into the QGIS interpreter; use what the distribution ships.
