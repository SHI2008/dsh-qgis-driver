// Consolidated QGIS tool surface.
//
// Ten tools replace the previous ~54 single-purpose registrations. Each tool
// takes an `action` discriminator plus the parameters that action needs, so a
// model sees one description per object instead of one per operation.
//
// Everything runs through the same transports as before: `run` executes a
// PyQGIS snippet on the QGIS main thread (file channel or REST), `runCmd`
// dispatches a JSON command through /api/cmd.

const PRELUDE = `
import json, os, shutil, tempfile, time, secrets, base64
from qgis.core import (QgsProject, QgsVectorLayer, QgsRasterLayer, QgsWkbTypes,
    QgsSingleBandPseudoColorRenderer, QgsSingleBandGrayRenderer, QgsMultiBandColorRenderer,
    QgsColorRampShader, QgsRasterShader, QgsRasterBandStats, QgsContrastEnhancement,
    QgsCoordinateReferenceSystem, QgsCoordinateTransform, QgsFeatureRequest, QgsFeature,
    QgsGeometry, QgsField, QgsPrintLayout, QgsLayoutItem, QgsLayoutItemMap, QgsLayoutItemMapGrid,
    QgsLayoutItemLabel, QgsLayoutItemLegend, QgsLayoutItemScaleBar, QgsLayoutItemPicture,
    QgsLayoutItemShape, QgsLayoutPoint, QgsLayoutSize, QgsUnitTypes, QgsLayoutExporter,
    QgsFillSymbol, QgsLineSymbol, QgsMarkerSymbol, QgsSingleSymbolRenderer, QgsPalLayerSettings,
    QgsTextFormat, QgsVectorLayerSimpleLabeling, QgsTextBufferSettings, QgsLegendStyle,
    QgsCategorizedSymbolRenderer, QgsGraduatedSymbolRenderer, QgsRendererRange, QgsRuleBasedRenderer,
    QgsRendererCategory, QgsRectangle, QgsMapSettings, QgsMapRendererCustomPainterJob, QgsPointXY, Qgis,
    QgsLayerTreeGroup)
from qgis.PyQt.QtGui import QColor, QFont, QFontDatabase, QImage, QPainter
from qgis.PyQt.QtCore import QSize, Qt
prj = QgsProject.instance()
P = json.loads(__PARAMS__)
def _prj_extent():
    ext = None
    for lyr in prj.mapLayers().values():
        try:
            e = lyr.extent()
        except Exception:
            continue
        if e is None or e.xMinimum() != e.xMinimum():
            continue
        if e.width() <= 0 and e.height() <= 0:
            # A single point (or a vertical/horizontal line) has a zero-area
            # extent; pad it so the map still renders something visible.
            pad = 0.01 if prj.crs().isGeographic() else 100.0
            e = QgsRectangle(e.xMinimum() - pad, e.yMinimum() - pad,
                             e.xMaximum() + pad, e.yMaximum() + pad)
        if ext is None:
            ext = QgsRectangle(e)
        else:
            ext.combineExtentWith(e)
    return None if ext is None or ext.isEmpty() else ext
def io_open(path):
    return open(path, 'r', encoding='utf-8', errors='ignore')
_OUT = os.path.join(tempfile.gettempdir(), 'dsh-qgis-driver')
try:
    os.makedirs(_OUT, exist_ok=True)
except Exception:
    pass
def _font_count():
    # 0 means the Qt font database is empty: every glyph draws as a box, and the
    # exporter still reports success, so the artifact looks fine until you open it.
    try:
        return len(QFontDatabase.families())
    except Exception:
        return -1


def _publish(src, ext):
    if _font_count() == 0:
        raise RuntimeError('this QGIS process loaded no fonts (QFontDatabase has 0 families),'
                           ' so every label would come out as a black box. QGIS runs on the GUI'
                           ' platform here; a second QGIS started with QT_QPA_PLATFORM=offscreen'
                           ' has no fonts - set QT_QPA_FONTDIR instead, or render through this driver.')
    name = 'qgis_%d_%s.%s' % (int(time.time() * 1000), secrets.token_hex(4), ext)
    dst = os.path.join(_OUT, name)
    shutil.copyfile(src, dst)
    return dst

def _names(items, n=8):
    names = []
    for it in items[:n]:
        try:
            names.append(it.name())
        except Exception:
            pass
    return ', '.join(names) + (' ...' if len(items) > n else '')

def L(name):
    ls = prj.mapLayersByName(name)
    if ls:
        return ls[0]
    found = prj.mapLayer(str(name))
    if found is not None:
        return found
    raise ValueError('layer not found: %s (have: %s)' % (name, _names(list(prj.mapLayers().values()))))

def MM():
    return QgsUnitTypes.LayoutMillimeters

def LAYOUT(name):
    lay = prj.layoutManager().layoutByName(name)
    if lay is None:
        raise ValueError('layout not found: %s (have: %s)' % (name, _names(list(prj.layoutManager().layouts()))))
    return lay

def rect_of(it):
    p = it.positionWithUnits(); s = it.sizeWithUnits()
    return [round(p.x(), 1), round(p.y(), 1), round(s.width(), 1), round(s.height(), 1)]

def first_map(lay):
    maps = [it for it in lay.items() if isinstance(it, QgsLayoutItemMap)]
    return maps[0] if maps else None

def color(hex_value, default):
    return QColor(hex_value or default)
`;

const PROJECT_BODY = {
  info: `
pg = prj
result = {
    'file': prj.fileName(),
    'title': prj.title(),
    'crs': prj.crs().authid() or prj.crs().description(),
    'extent': (lambda e: [round(e.xMinimum(), 1), round(e.yMinimum(), 1),
                          round(e.xMaximum(), 1), round(e.yMaximum(), 1)] if e is not None else None)(_prj_extent()),
    'layers': [{'id': l.id(), 'name': l.name(), 'type': 'Vector' if l.type() == 0 else 'Raster'} for l in prj.mapLayers().values()],
    'layouts': [l.name() for l in prj.layoutManager().layouts()],
    'qgis': Qgis.QGIS_VERSION,
}`,
  open: `
r = prj.read(P['path'])
result = {'opened': bool(r), 'layers': len(prj.mapLayers()), 'file': prj.fileName()}`,
  save: `
path = P.get('path') or prj.fileName()
if not path:
    raise ValueError('project not saved yet: pass path')
result = {'saved': bool(prj.write(path)), 'file': path}`,
  set_crs: `
crs = QgsCoordinateReferenceSystem(P['crs'])
if not crs.isValid():
    raise ValueError('invalid crs: ' + str(P.get('crs')))
prj.setCrs(crs)
result = {'crs': crs.authid() or crs.description()}`,
  save_as: `
path = P.get('path')
if not path:
    raise ValueError('path is required for save_as')
ok = prj.write(path)
result = {'saved': bool(ok), 'path': path, 'layers': len(prj.mapLayers())}`,

};

const LAYER_BODY = {
  list: `
_all = [{'id': l.id(), 'name': l.name(),
         'type': 'Vector' if l.type() == 0 else 'Raster',
         'crs': l.crs().authid() or l.crs().description(),
         'feature_count': l.featureCount() if hasattr(l, 'featureCount') else None} for l in prj.mapLayers().values()]
_lim = max(1, min(int(P.get('limit') or 200), 1000))
result = {'count': min(len(_all), _lim), 'total': len(_all), 'truncated': len(_all) > _lim, 'layers': _all[:_lim]}`,
  info: `
l = L(P['layer'])
d = {'name': l.name(), 'valid': l.isValid(), 'crs': l.crs().authid() or l.crs().description(),
     'extent': [round(v, 1) for v in (l.extent().xMinimum(), l.extent().yMinimum(),
                                      l.extent().xMaximum(), l.extent().yMaximum())]}
if isinstance(l, QgsVectorLayer):
    d.update({'type': 'vector', 'geometry': QgsWkbTypes.displayString(l.wkbType()),
              'feature_count': l.featureCount(),
              'fields': [{'name': f.name(), 'type': f.typeName()} for f in l.fields()]})
else:
    d.update({'type': 'raster', 'bands': l.bandCount(), 'width': l.width(), 'height': l.height(),
              'cell_size': [round(l.rasterUnitsPerPixelX(), 6), round(l.rasterUnitsPerPixelY(), 6)]})
    st = l.dataProvider().bandStatistics(1)
    d['band1_stats'] = {'min': round(st.minimumValue, 3), 'max': round(st.maximumValue, 3),
                        'mean': round(st.mean, 3)}
result = d`,
  fields: `
l = L(P['layer'])
result = [{'name': f.name(), 'type': f.typeName(), 'alias': f.alias()} for f in l.fields()]`,
  add: `
# Suppress the "unknown CRS" prompt: a modal dialog would block the QGIS event
# loop (the live driver polls from a timer) and hang every later tool call.
try:
    from qgis.core import QgsSettings
    _s = QgsSettings()
    _s.setValue('/Projections/defaultBehaviour', 'useProject')
    if not _s.value('/Projections/layerDefaultCrs'):
        _s.setValue('/Projections/layerDefaultCrs', 'EPSG:4326')
except Exception:
    pass
path = P['path']
prov = P.get('provider') or 'auto'
name = P.get('name') or os.path.splitext(os.path.basename(path))[0]
candidates = [prov] if prov != 'auto' else ['ogr', 'gdal']
l = None
for c in candidates:
    cand = QgsVectorLayer(path, name, c) if c == 'ogr' else QgsRasterLayer(path, name, c)
    if cand.isValid():
        l = cand
        break
if l is None:
    raise ValueError('cannot load: ' + path)
_cf = P.get('crs_file')
if _cf and os.path.isfile(_cf):
    _c = QgsCoordinateReferenceSystem()
    with io_open(_cf) as _fh:
        _wkt = _fh.read()
    _c.createFromWkt(_wkt)
    if _c.isValid():
        l.setCrs(_c)
        if P.get('set_project'):
            prj.setCrs(_c)
prj.addMapLayer(l)
result = {'id': l.id(), 'name': l.name(), 'type': 'Vector' if isinstance(l, QgsVectorLayer) else 'Raster',
          'crs': l.crs().authid() or l.crs().description(),
          'feature_count': l.featureCount() if isinstance(l, QgsVectorLayer) else None}`,
  create: `
gt = (P.get('geometry_type') or 'point').lower()
uri_geom = {'point': 'Point', 'line': 'LineString', 'polygon': 'Polygon'}.get(gt, 'Point')
crs = P.get('crs') or 'EPSG:4326'
fields = P.get('fields') or []
uri = uri_geom + '?crs=' + crs
for f in fields:
    uri += '&field=' + str(f['name']) + ':' + str(f.get('type') or 'string')
l = QgsVectorLayer(uri, P['name'], 'memory')
if not l.isValid():
    raise ValueError('cannot create memory layer')
prj.addMapLayer(l)
result = {'id': l.id(), 'name': l.name(), 'uri': uri, 'fields': [f.name() for f in l.fields()]}`,
  remove: `
l = L(P['layer'])
prj.removeMapLayer(l.id())
result = {'removed': P['layer'], 'layers': len(prj.mapLayers())}`,
  visibility: `
l = L(P['layer'])
node = prj.layerTreeRoot().findLayer(l.id())
if node is not None:
    node.setItemVisibilityChecked(bool(P.get('visible', True)))
result = {'layer': l.name(), 'visible': bool(P.get('visible', True))}`,
  crs: `
l = L(P['layer'])
crs = QgsCoordinateReferenceSystem(P['crs'])
if not crs.isValid():
    raise ValueError('invalid crs: ' + str(P.get('crs')))
l.setCrs(crs)
if P.get('set_project'):
    prj.setCrs(crs)
result = {'layer': l.name(), 'crs': crs.authid() or crs.description(),
          'project_crs': prj.crs().authid() or prj.crs().description()}`,
  style: `
l = L(P['layer'])
if not isinstance(l, QgsVectorLayer):
    raise ValueError('only vector layers are supported')
sym = None
try:
    _rd = l.renderer()
    if _rd is not None:
        sym = _rd.symbol().clone()
except Exception:
    sym = None
if sym is None:
    sym = QgsMarkerSymbol() if l.geometryType() == 0 else (
        QgsLineSymbol() if l.geometryType() == 1 else QgsFillSymbol())
changed = []
c = P.get('color')
if c:
    for sl in sym.symbolLayers():
        sl.setColor(QColor(c))
    changed.append('color')
op = P.get('opacity')
if op is not None:
    sym.setOpacity(float(op)); changed.append('opacity')
l.setRenderer(QgsSingleSymbolRenderer(sym))
l.triggerRepaint()
result = {'layer': l.name(), 'changed': changed, 'color': c, 'opacity': sym.opacity()}`,
  classify: `
l = L(P['layer'])
field = P['field']
mode = P.get('mode') or 'categorized'
colors = P.get('colors') or []
def col(i, default):
    return QColor(colors[i] if i < len(colors) else default)
if mode == 'categorized':
    values = sorted({str(f[field]) for f in l.getFeatures() if f[field] is not None})
    cats = []
    for i, v in enumerate(values):
        sym = QgsMarkerSymbol.createSimple({'name': 'circle', 'size': '2.2',
                                           'color': col(i, '#e6194b').name()})
        cats.append(QgsRendererCategory(v, sym, v))
    l.setRenderer(QgsCategorizedSymbolRenderer(field, cats))
    result = {'layer': l.name(), 'mode': mode, 'classes': len(cats), 'values': values}
else:
    n = int(P.get('classes') or 5)
    lo = float(l.minimumValue(l.fields().indexOf(field)))
    hi = float(l.maximumValue(l.fields().indexOf(field)))
    step = (hi - lo) / n if hi > lo else 1.0
    ranges = []
    start = col(0, '#eef4e4')
    endc = col(n - 1, '#3f6634')
    for i in range(n):
        a, b = lo + step * i, lo + step * (i + 1)
        t = i / max(n - 1, 1)
        c = QColor(int(start.red() + (endc.red() - start.red()) * t),
                   int(start.green() + (endc.green() - start.green()) * t),
                   int(start.blue() + (endc.blue() - start.blue()) * t))
        sym = QgsFillSymbol.createSimple({'color': c.name()})
        ranges.append(QgsRendererRange(a, b, sym, '%.0f–%.0f' % (a, b)))
    l.setRenderer(QgsGraduatedSymbolRenderer(field, ranges))
    result = {'layer': l.name(), 'mode': mode, 'classes': n, 'min': round(lo, 1), 'max': round(hi, 1)}`,
  labels: `
l = L(P['layer'])
if P.get('enabled') is False:
    l.setLabelsEnabled(False)
    result = {'layer': l.name(), 'labels': False}
else:
    ps = QgsPalLayerSettings()
    ps.fieldName = P['field']
    tf = QgsTextFormat()
    tf.setFont(QFont(P.get('family') or 'Microsoft YaHei', int(P.get('size') or 8)))
    tf.setSize(float(P.get('size') or 8))
    tf.setColor(QColor(P.get('color') or '#000000'))
    b = float(P.get('buffer_size') or 0)
    if b > 0:
        buf = QgsTextBufferSettings()
        buf.setEnabled(True); buf.setSize(b); buf.setColor(QColor(P.get('buffer_color') or '#ffffff'))
        tf.setBuffer(buf)
    ps.setFormat(tf)
    placement = {'around_point': QgsPalLayerSettings.AroundPoint,
                 'over_point': QgsPalLayerSettings.OverPoint,
                 'line': QgsPalLayerSettings.Line,
                 'horizontal': QgsPalLayerSettings.Horizontal,
                 'curved': QgsPalLayerSettings.Curved}.get(P.get('placement') or 'around_point')
    ps.placement = placement
    l.setLabeling(QgsVectorLayerSimpleLabeling(ps))
    l.setLabelsEnabled(True)
    l.triggerRepaint()
    result = {'layer': l.name(), 'labels': True, 'field': P['field']}`,
  reproject: `
src = L(P['layer'])
dst = QgsCoordinateReferenceSystem(P['target_crs'])
if not dst.isValid():
    raise ValueError('invalid crs: ' + str(P.get('target_crs')))
name = P.get('output_name') or (src.name() + '_reprojected')
wkt = QgsWkbTypes.displayString(src.wkbType())
ml = QgsVectorLayer('%s?crs=%s' % (wkt.split(' ')[0] if wkt else 'Point', dst.authid()), name, 'memory')
ml.dataProvider().addAttributes(list(src.fields()))
ml.updateFields()
xf = QgsCoordinateTransform(src.crs(), dst, prj)
feats = []
for f in src.getFeatures():
    g = QgsGeometry(f.geometry())
    g.transform(xf)
    nf = QgsFeature(ml.fields())
    nf.setGeometry(g)
    nf.setAttributes(f.attributes())
    feats.append(nf)
ml.dataProvider().addFeatures(feats)
ml.updateExtents()
prj.addMapLayer(ml)
result = {'name': name, 'crs': dst.authid(), 'feature_count': ml.featureCount()}`,
  export: `
l = L(P['layer'])
if not isinstance(l, QgsVectorLayer):
    raise ValueError('only vector layers can be exported')
from qgis.core import QgsVectorFileWriter
fmt = (P.get('format') or os.path.splitext(P.get('path') or '')[1].lstrip('.').lower() or 'geojson')
driver = {'gpkg': 'GPKG', 'geojson': 'GeoJSON', 'shp': 'ESRI Shapefile', 'csv': 'CSV'}.get(fmt)
if not driver:
    raise ValueError('unsupported format: ' + fmt)
path = P.get('path')
if not path:
    # No path means "just give me a file": the layer name is unique enough, and a call
    # that forgot the path should not fail when the answer is obvious.
    _ext = {'gpkg': '.gpkg', 'geojson': '.geojson', 'shp': '.shp', 'csv': '.csv'}[fmt]
    _dir = os.path.join(os.environ.get('TEMP') or tempfile.gettempdir(), 'dsh-qgis-driver')
    if not os.path.isdir(_dir):
        os.makedirs(_dir, exist_ok=True)
    path = os.path.join(_dir, str(l.name()) + _ext)
if os.path.exists(path):
    os.remove(path)
opts = QgsVectorFileWriter.SaveVectorOptions()
opts.driverName = driver
opts.fileEncoding = 'UTF-8'
ret = QgsVectorFileWriter.writeAsVectorFormatV3(l, path, prj.transformContext(), opts)
if int(ret[0]) != 0:
    raise ValueError('write failed: ' + str(ret))
result = {'path': path, 'file_path': path, 'format': fmt, 'bytes': os.path.getsize(path)}`,
  export_table: `
l = L(P['layer'])
fields = [f.name() for f in l.fields()]
rows = [[f[n] for n in fields] for f in l.getFeatures()]
fmt = P.get('format') or 'csv'
path = P.get('path')
if path:
    if fmt == 'json':
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump({'fields': fields, 'rows': rows}, fh, ensure_ascii=False)
    else:
        import csv
        with open(path, 'w', encoding='utf-8-sig', newline='') as fh:
            w = csv.writer(fh); w.writerow(fields); w.writerows(rows)
    result = {'path': path, 'file_path': path, 'rows': len(rows), 'columns': fields}
elif fmt == 'json':
    result = {'fields': fields, 'rows': rows[:10000], 'truncated': len(rows) > 10000}
else:
    result = {'fields': fields, 'rows': len(rows), 'hint': '未指定 path，csv 需要写入文件'}`,
  style_multi: `
lyr = L(P['layer'])
fld = P.get('field')
if not fld or lyr.fields().indexOf(fld) < 0:
    raise ValueError('field not found: ' + str(fld))
vals = []
for f in lyr.getFeatures():
    v = f[fld]
    if v not in vals:
        vals.append(v)
    if len(vals) >= 60:
        break
gt = lyr.geometryType()
palette = P.get('colors') or ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#2980b9', '#8e44ad', '#16a085', '#d35400']
def _sym(i, v):
    hexc = palette[i % len(palette)]
    if gt == 0:
        return QgsMarkerSymbol.createSimple({'name': 'circle', 'size': str(P.get('size') or 3),
                                             'color': hexc, 'outline_color': '#ffffff', 'outline_width': '0.3'})
    if gt == 1:
        return QgsLineSymbol.createSimple({'color': hexc, 'width': str(P.get('width') or 0.6)})
    return QgsFillSymbol.createSimple({'color': hexc, 'outline_color': P.get('outline_color') or '#555555',
                                       'outline_width': '0.2'})
cats = [QgsRendererCategory(v, _sym(i, v), str(v)) for i, v in enumerate(vals)]
lyr.setRenderer(QgsCategorizedSymbolRenderer(fld, cats))
lyr.triggerRepaint()
result = {'layer': lyr.name(), 'field': fld, 'classes': len(cats), 'values': [str(v) for v in vals[:30]]}`,
  style_rule: `
lyr = L(P['layer'])
rules = P.get('rules') or []
if not rules:
    raise ValueError('rules is required: [{expression, label, color, width, size}]')
gt = lyr.geometryType()
def _sym(r):
    hexc = r.get('color') or '#c0392b'
    if gt == 0:
        return QgsMarkerSymbol.createSimple({'name': 'circle', 'size': str(r.get('size') or 3), 'color': hexc,
                                             'outline_color': '#ffffff', 'outline_width': '0.3'})
    if gt == 1:
        return QgsLineSymbol.createSimple({'color': hexc, 'width': str(r.get('width') or 0.6)})
    return QgsFillSymbol.createSimple({'color': hexc, 'outline_color': r.get('outline_color') or '#555555',
                                       'outline_width': '0.2'})
root_rule = QgsRuleBasedRenderer.Rule(None)
for r in rules:
    root_rule.appendChild(QgsRuleBasedRenderer.Rule(_sym(r), 0, 0, r.get('expression') or 'TRUE', r.get('label') or ''))
lyr.setRenderer(QgsRuleBasedRenderer(root_rule))
lyr.triggerRepaint()
result = {'layer': lyr.name(), 'rules': len(rules), 'labels': [r.get('label') or r.get('expression') for r in rules]}`,
  symbol: `
lyr = L(P['layer'])
rd = lyr.renderer()
if rd is None or not hasattr(rd, 'symbol'):
    raise ValueError('layer has no single symbol renderer')
sym = rd.symbol().clone()
def tune(sl):
    try:
        if P.get('size') is not None:
            sl.setSize(float(P['size']))
    except Exception:
        pass
    try:
        if P.get('width') is not None:
            sl.setWidth(float(P['width']))
    except Exception:
        pass
    try:
        if P.get('color'):
            sl.setColor(QColor(P['color']))
    except Exception:
        pass
    try:
        if P.get('outline_color'):
            sl.setStrokeColor(QColor(P['outline_color']))
    except Exception:
        pass
    try:
        if P.get('outline_width') is not None:
            sl.setStrokeWidth(float(P['outline_width']))
    except Exception:
        pass
    try:
        sub = sl.subSymbol()
    except Exception:
        sub = None
    if sub is not None:
        tune(sub)
for sl in sym.symbolLayers():
    tune(sl)
lyr.setRenderer(QgsSingleSymbolRenderer(sym))
lyr.triggerRepaint()
result = {'layer': lyr.name(), 'size': P.get('size'), 'width': P.get('width'), 'color': P.get('color'),
          'outline_color': P.get('outline_color'), 'outline_width': P.get('outline_width')}`,
  annotate: `
src = L(P['layer'])
fld = P.get('field')
label_field = P.get('label_field') or fld or (src.fields()[0].name() if src.fields() else '')
mem = QgsVectorLayer('Point?crs=' + (src.crs().toWkt() if src.crs().isValid() else 'EPSG:4326') + '&field=text:string(120)',
                     (P.get('name') or (src.name() + '_annotation')), 'memory')
prov = mem.dataProvider()
feats = []
for f in src.getFeatures():
    g = f.geometry()
    if g is None or g.isEmpty():
        continue
    c = g.centroid()
    nf = QgsFeature(); nf.setGeometry(c)
    nf.setAttributes([str(f[label_field]) if label_field else ''])
    feats.append(nf)
prov.addFeatures(feats)
mem.updateExtents()
prj.addMapLayer(mem)
ps = QgsPalLayerSettings(); ps.fieldName = 'text'
tf = QgsTextFormat(); tf.setFont(QFont(P.get('family') or 'Microsoft YaHei')); tf.setSize(int(P.get('size') or 8))
buf = QgsTextBufferSettings(); buf.setEnabled(True); buf.setSize(0.8); buf.setColor(QColor('white')); tf.setBuffer(buf)
ps.setFormat(tf)
mem.setLabeling(QgsVectorLayerSimpleLabeling(ps)); mem.setLabelsEnabled(True); mem.triggerRepaint()
result = {'layer': mem.name(), 'features': len(feats), 'label_field': label_field}`,
  raster_style: `
_name = P.get('layer') or P.get('name')
rl = None
for _l in prj.mapLayers().values():
    if isinstance(_l, QgsRasterLayer) and _l.name() == _name:
        rl = _l
        break
if rl is None:
    raise ValueError('raster not found: ' + str(_name) + ' (list first)')
mode = (P.get('mode') or 'pseudocolor').lower()
prov = rl.dataProvider()
if prov is None:
    raise RuntimeError('raster has no data provider')
band = int(P.get('band') or 1)
info = {'layer': rl.name(), 'mode': mode}
if mode == 'rgb':
    bands = [int(b) for b in (P.get('bands') or [])]
    if len(bands) != 3:
        raise ValueError('mode=rgb needs bands: [red, green, blue]')
    renderer = QgsMultiBandColorRenderer(prov, bands[0], bands[1], bands[2])
    info['bands'] = bands
elif mode == 'gray':
    renderer = QgsSingleBandGrayRenderer(prov, band)
    ce = QgsContrastEnhancement(prov.dataType(band))
    ce.setContrastEnhancementAlgorithm(QgsContrastEnhancement.StretchToMinimumMaximum)
    renderer.setContrastEnhancement(ce)
    info['band'] = band
else:
    stats = prov.bandStatistics(band, QgsRasterBandStats.Min | QgsRasterBandStats.Max)
    lo, hi = float(stats.minimumValue), float(stats.maximumValue)
    if not hi > lo:
        raise ValueError('band %d has no value range (min %s, max %s) - pick another band'
                         % (band, lo, hi))
    classes = max(2, min(int(P.get('classes') or 5), 32))
    colors = P.get('colors') or ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c']
    items = []
    for i in range(classes):
        f = float(i) / float(classes - 1)
        items.append(QgsColorRampShader.ColorRampItem(lo + (hi - lo) * f,
                                                      QColor(colors[i % len(colors)]),
                                                      ('%.6g' % (lo + (hi - lo) * f))))
    ramp = QgsColorRampShader()
    ramp.setColorRampType(QgsColorRampShader.Interpolated)
    ramp.setColorRampItemList(items)
    shader = QgsRasterShader()
    shader.setRasterShaderFunction(ramp)
    renderer = QgsSingleBandPseudoColorRenderer(prov, band, shader)
    renderer.setClassificationMin(lo)
    renderer.setClassificationMax(hi)
    info.update({'band': band, 'classes': classes, 'min': round(lo, 6), 'max': round(hi, 6),
                 'colors': colors})
rl.setRenderer(renderer)
rl.triggerRepaint()
info['renderer'] = rl.renderer().type()
result = info`

};

const FEATURE_BODY = {
  query: `
l = L(P['layer'])
expr = P.get('expression') or ''
req = QgsFeatureRequest()
if expr:
    req.setFilterExpression(expr)
req.setLimit(int(P.get('limit') or 20))
fields = P.get('fields') or [f.name() for f in l.fields()]
rows = []
for f in l.getFeatures(req):
    d = {k: f[k] for k in fields}
    if P.get('include_geometry'):
        d['__wkt__'] = f.geometry().asWkt()
    rows.append(d)
result = {'layer': l.name(), 'count': len(rows), 'rows': rows}`,
  select: `
l = L(P['layer'])
mode = P.get('mode') or 'replace'
expr = P.get('expression') or ''
fids = [f.id() for f in l.getFeatures(QgsFeatureRequest().setFilterExpression(expr) if expr else QgsFeatureRequest())]
if mode == 'replace':
    l.selectByIds(fids)
elif mode == 'add':
    cur = set(l.selectedFeatureIds()); l.selectByIds(list(cur | set(fids)))
else:
    cur = set(l.selectedFeatureIds()); l.selectByIds(list(cur - set(fids)))
result = {'layer': l.name(), 'mode': mode, 'count': len(fids), 'selected_total': len(l.selectedFeatureIds())}`,
  select_by_location: `
l = L(P['layer']); src = L(P['source_layer'])
pred = (P.get('predicate') or 'intersects').lower()
dist = float(P.get('distance') or 0)
geoms = []
for f in src.getFeatures():
    g = f.geometry()
    if dist > 0:
        g = g.buffer(dist, 8)
    if not g.isEmpty():
        geoms.append(g)
mode = P.get('mode') or 'new'
hit = []
for f in l.getFeatures():
    g = f.geometry()
    if g.isEmpty():
        continue
    ok = False
    for sg in geoms:
        if pred == 'intersects':
            ok = g.intersects(sg)
        elif pred == 'within':
            ok = g.within(sg)
        elif pred == 'contains':
            ok = g.contains(sg)
        elif pred == 'touches':
            ok = g.touches(sg)
        elif pred == 'overlaps':
            ok = g.overlaps(sg)
        elif pred == 'crosses':
            ok = g.crosses(sg)
        else:
            ok = g.disjoint(sg)
        if ok:
            break
    if ok:
        hit.append(f.id())
if mode == 'new':
    l.selectByIds(hit)
elif mode == 'add':
    l.selectByIds(list(set(l.selectedFeatureIds()) | set(hit)))
else:
    l.selectByIds(list(set(l.selectedFeatureIds()) - set(hit)))
result = {'layer': l.name(), 'predicate': pred, 'count': len(hit), 'mode': mode,
          'selected_total': len(l.selectedFeatureIds())}`,
  selected: `
l = L(P['layer'])
ids = l.selectedFeatureIds()[: int(P.get('limit') or 20)]
rows = []
for f in l.getFeatures(QgsFeatureRequest().setFilterFids(ids)):
    rows.append({'fid': f.id(), **{k: f[k] for k in [fl.name() for fl in l.fields()]}})
result = {'layer': l.name(), 'count': len(rows), 'rows': rows}`,
  add: `
l = L(P['layer'])
if not isinstance(l, QgsVectorLayer):
    raise ValueError('only vector layers are supported')
f = QgsFeature(l.fields())
values = P.get('values') or {}
_have = [fl.name() for fl in l.fields()]
_missing = [k for k in values if k not in _have]
if _missing:
    raise ValueError(
        'the layer has no field(s) %s (it has: %s). Add them first with '
        'qgis_feature action=field_add {field: "%s", field_type: "string"}, '
        'or drop them from values.' % (
            ', '.join(repr(m) for m in _missing),
            ', '.join(_have) or 'none', _missing[0]))
for k, v in values.items():
    f[k] = v
if P.get('geometry_wkt'):
    f.setGeometry(QgsGeometry.fromWkt(P['geometry_wkt']))
l.startEditing()
ok = l.addFeature(f)
l.commitChanges()
result = {'layer': l.name(), 'added': bool(ok), 'feature_count': l.featureCount()}`,
  update: `
l = L(P['layer'])
if not P.get('confirm'):
    raise ValueError('confirm=true required for update')
expr = P.get('expression') or ''
values = P.get('values') or {}
limit = int(P.get('limit') or 1000)
req = QgsFeatureRequest().setLimit(limit)
if expr:
    req.setFilterExpression(expr)
idx = {k: l.fields().indexOf(k) for k in values}
_missing = [k for k, i in idx.items() if i < 0]
if _missing:
    raise ValueError(
        'the layer has no field(s) %s (it has: %s) - nothing was changed.' % (
            ', '.join(repr(m) for m in _missing),
            ', '.join(fl.name() for fl in l.fields()) or 'none'))
l.startEditing()
n = 0
for f in l.getFeatures(req):
    for k, i in idx.items():
        l.changeAttributeValue(f.id(), i, values[k])
    n += 1
l.commitChanges()
result = {'layer': l.name(), 'updated': n}`,
  delete: `
l = L(P['layer'])
if not P.get('confirm'):
    raise ValueError('confirm=true required for delete')
expr = P.get('expression') or ''
limit = int(P.get('limit') or 1000)
req = QgsFeatureRequest().setLimit(limit)
if expr:
    req.setFilterExpression(expr)
fids = [f.id() for f in l.getFeatures(req)]
l.startEditing()
for fid in fids:
    l.deleteFeature(fid)
l.commitChanges()
result = {'layer': l.name(), 'deleted': len(fids), 'feature_count': l.featureCount()}`,
  field_add: `
l = L(P['layer'])
from qgis.PyQt.QtCore import QVariant as _QV
tnames = {'string': 'String', 'integer': 'Int', 'double': 'Double', 'date': 'Date', 'datetime': 'DateTime'}
tname = (P.get('field_type') or 'double')
ftype = getattr(_QV, tnames.get(tname, 'Double'), _QV.Double)
l.startEditing()
l.dataProvider().addAttributes([QgsField(P['field'], ftype, tname)])
l.updateFields()
l.commitChanges()
result = {'layer': l.name(), 'field': l.fields()[-1].name(), 'added': True}`,
  field_calc: `
l = L(P['layer'])
if not P.get('expression'):
    raise ValueError('expression required')
idx = l.fields().indexOf(P['field'])
if idx < 0:
    raise ValueError('field not found: ' + P['field'])
from qgis.core import QgsExpression, QgsExpressionContext, QgsExpressionContextUtils
l.startEditing()
n = 0
for f in l.getFeatures():
    ctx = QgsExpressionContext()
    ctx.appendScopes(QgsExpressionContextUtils.globalProjectLayerScopes(l))
    ctx.setFeature(f)
    val = QgsExpression(P['expression']).evaluate(ctx)
    l.changeAttributeValue(f.id(), idx, val)
    n += 1
l.commitChanges()
result = {'layer': l.name(), 'field': P['field'], 'updated': n}`,
  field_delete: `
l = L(P['layer'])
idx = l.fields().indexOf(P['field'])
if idx < 0:
    raise ValueError('field not found: ' + P['field'])
l.startEditing()
l.dataProvider().deleteAttributes([idx])
l.updateFields()
l.commitChanges()
result = {'layer': l.name(), 'field': P['field'], 'removed': True}`,
  field_rename: `
l = L(P['layer'])
if not P.get('new_name'):
    raise ValueError('new_name required')
idx = l.fields().indexOf(P['field'])
if idx < 0:
    raise ValueError('field not found: ' + P['field'])
l.startEditing()
l.renameAttribute(idx, P['new_name'])
l.commitChanges()
result = {'layer': l.name(), 'from': P['field'], 'to': P['new_name']}`,
  table: `
lyr = L(P['layer'])
fields = P.get('fields') or [f.name() for f in lyr.fields()]
sort_by = P.get('sort_by')
order = (P.get('order') or 'asc').lower()
limit = int(P.get('limit') or 200)
offset = int(P.get('offset') or 0)
req = QgsFeatureRequest()
rows = []
for f in lyr.getFeatures(req):
    rows.append([f[n] for n in fields])
if sort_by:
    if sort_by not in fields:
        raise ValueError('sort_by not in fields: ' + str(sort_by))
    idx = fields.index(sort_by)
    rows.sort(key=lambda r: (r[idx] is None, r[idx]), reverse=(order == 'desc'))
total = len(rows)
page = rows[offset:offset + limit]
result = {'layer': lyr.name(), 'fields': fields, 'total': total, 'offset': offset,
          'returned': len(page), 'rows': page, 'truncated': offset + limit < total}`,

};

const LAYOUT_BODY = {
  list: `
_all = [l.name() for l in prj.layoutManager().layouts()]
_lim = max(1, min(int(P.get('limit') or 200), 1000))
result = {'count': min(len(_all), _lim), 'total': len(_all), 'truncated': len(_all) > _lim, 'layouts': _all[:_lim]}`,
  create: `
name = P['layout_name']
lm = prj.layoutManager()
if lm.layoutByName(name) is not None:
    raise ValueError('layout already exists: ' + name)
lay = QgsPrintLayout(prj); lay.setName(name); lay.initializeDefaults()
if P.get('page_width') and P.get('page_height'):
    pg = lay.pageCollection().pages()[0]
    pg.setPageSize(QgsLayoutSize(float(P['page_width']), float(P['page_height']), MM()))
lm.addLayout(lay)
_bg = P.get('background')
if _bg:
    _pg = lay.pageCollection().pages()[0]
    _s = QgsLayoutItemShape(lay); _s.setShapeType(QgsLayoutItemShape.Rectangle)
    _s.setSymbol(QgsFillSymbol.createSimple({'color': _bg, 'outline_color': _bg, 'outline_width': '0'}))
    lay.addLayoutItem(_s); _s.setZValue(-1000)
    _s.attemptMove(QgsLayoutPoint(0, 0, MM()))
    _s.attemptResize(QgsLayoutSize(_pg.pageSize().width(), _pg.pageSize().height(), MM()))
result = {'name': lay.name(), 'layouts': [l.name() for l in lm.layouts()]}`,
  info: `
lay = LAYOUT(P['layout'])
pg = lay.pageCollection().pages()[0]
items = []
for it in lay.items():
    if not isinstance(it, QgsLayoutItem):
        continue
    d = {'index': len(items), 'uuid': it.uuid(), 'kind': type(it).__name__, 'rect': rect_of(it)}
    if isinstance(it, QgsLayoutItemMap):
        d['layers'] = [l.name() for l in it.layers()]
    if isinstance(it, QgsLayoutItemLabel):
        d['text'] = it.text()[:60]
    items.append(d)
result = {'layout': lay.name(),
          'page': [round(pg.pageSize().width(), 1), round(pg.pageSize().height(), 1)],
          'items': items}`,
  add_item: `
lay = LAYOUT(P['layout'])
kind = P['kind']
x = float(P.get('x') or 0); y = float(P.get('y') or 0)
w = P.get('width'); h = P.get('height')
z = P.get('z')
layers = [L(n) for n in (P.get('layers') or [])]
item = None
if kind == 'map':
    if w is None:
        # 160 mm is the A4 landscape default that leaves room for a legend; refusing
        # the call taught a model nothing and cost a round trip.
        w = 160.0
    m = QgsLayoutItemMap(lay)
    lay.addLayoutItem(m)
    m.attemptMove(QgsLayoutPoint(x, y, MM()))
    fit = P.get('fit_layer')
    target = L(fit) if fit else (layers[0] if layers else None)
    if target is not None:
        e = target.extent()
        if e.width() <= 0 and e.height() <= 0:
            # A single point has a zero-area extent: pad it or the map renders blank.
            pad = 0.01 if target.crs().isGeographic() else 100.0
            e = QgsRectangle(e.xMinimum() - pad, e.yMinimum() - pad,
                             e.xMaximum() + pad, e.yMaximum() + pad)
        if h is None:
            h = float(w) / (e.width() / e.height())
        _page = lay.pageCollection().pages()[0].pageSize()
        _maxh = _page.height() - y - 5
        if _maxh > 5 and float(h) > _maxh:
            w = float(w) * _maxh / float(h)
            h = _maxh
        m.attemptResize(QgsLayoutSize(float(w), float(h), MM()))
        m.setCrs(target.crs())
    else:
        if h is None:
            h = float(w) * 0.6
        m.attemptResize(QgsLayoutSize(float(w), float(h), MM()))
    m.setBackgroundEnabled(True)
    m.setBackgroundColor(QColor(P.get('background') or '#ffffff'))
    if not layers:
        # fit_layer names the subject of the map: drawing every layer of the project on top of
        # it buries the subject and makes the legend list unrelated layers.
        layers = [target] if target is not None else [l for l in prj.mapLayers().values() if l.isValid()]
    if layers:
        m.setLayers(layers)
        m.setKeepLayerSet(True)
    if target is not None:
        m.zoomToExtent(e)
    m.invalidateCache()
    item = m
elif kind == 'legend':
    if w is None:
        # 60 mm fits beside a map on A4; refusing the call taught nothing.
        w = 60.0
    lg = QgsLayoutItemLegend(lay)
    base = first_map(lay)
    if base is not None:
        lg.setLinkedMap(base)
    _legend_title = P.get('title') or '图例'
    lay.addLayoutItem(lg)
    lg.attemptMove(QgsLayoutPoint(x, y, MM()))
    # Never edit this root: it mirrors the project's layer tree, so removing nodes from it
    # removes the layers from the project. Let the link to the map do the filtering instead.
    if base is not None:
        lg.setLegendFilterByMapEnabled(True)
    root = lg.model().rootGroup()
    fam = P.get('family') or 'Microsoft YaHei'
    lg.setStyleFont(QgsLegendStyle.Style.Title, QFont(fam, 10))
    lg.setStyleFont(QgsLegendStyle.Style.Subgroup, QFont(fam, 8))
    lg.setStyleFont(QgsLegendStyle.Style.SymbolLabel, QFont(fam, 8))
    lg.updateLegend()
    lg.setTitle(_legend_title)
    if h is None:
        rows = 0
        for ch in root.children():
            rows += 1
            try:
                lyr = ch.layer()
            except Exception:
                lyr = None
            if lyr is None:
                continue
            rd = lyr.renderer()
            for attr in ('categories', 'ranges'):
                try:
                    items = getattr(rd, attr)()
                    if items:
                        rows += len(items)
                except Exception:
                    pass
            try:
                if hasattr(rd, 'rootRule'):
                    rows += len(rd.rootRule().children())
            except Exception:
                pass
        h = 9 + 5.2 * max(rows, 2)
    lg.attemptResize(QgsLayoutSize(float(w), float(h), MM()))
    item = lg
elif kind == 'scalebar':
    if w is not None or h is not None:
        raise ValueError('kind=scalebar sizes itself from the linked map map_scale and '
                         'segments/units_per_segment; width/height are not applied, so drop them')
    sb = QgsLayoutItemScaleBar(lay)
    base = first_map(lay)
    if base is not None:
        sb.setLinkedMap(base)
    sb.setStyle('Single Box')
    sb.setUnits(QgsUnitTypes.DistanceKilometers if (P.get('unit') or 'km') == 'km' else QgsUnitTypes.DistanceMeters)
    sb.setUnitLabel(P.get('unit') or 'km')
    sb.setNumberOfSegments(int(P.get('segments') or 2))
    sb.setUnitsPerSegment(float(P.get('units_per_segment') or 50))
    sb.setFont(QFont(P.get('family') or 'Microsoft YaHei', 8))
    lay.addLayoutItem(sb)
    sb.attemptMove(QgsLayoutPoint(x, y, MM()))
    # A scale bar's width follows the map scale, so a coarse units_per_segment can push it
    # far past the page edge (a 50 km segment over a small extent is metres wide on paper).
    # Shrink it until it fits the page instead of exporting a bar that runs off the sheet.
    _page = lay.pageCollection().pages()[0].pageSize()
    _maxw = float(_page.width()) - x - 5
    for _ in range(12):
        _w = sb.rect().width()
        if _w <= _maxw or _w <= 1:
            break
        _up = sb.unitsPerSegment() * (_maxw / _w)
        if _up <= 0:
            break
        sb.setUnitsPerSegment(max(_up, 0.001))
    # Then snap to a readable 1/2/5 step: a bar labelled "4.378215" is useless on a map.
    _up = sb.unitsPerSegment()
    if _up > 0:
        import math as _m
        _e = _m.floor(_m.log10(_up))
        for _mul in (5.0, 2.0, 1.0):
            _cand = _mul * (10.0 ** _e)
            if _cand <= _up:
                sb.setUnitsPerSegment(_cand)
                break
        else:
            sb.setUnitsPerSegment(10.0 ** _e)
    try:
        sb.setDecimalPlaces(0)
    except Exception:
        pass
    item = sb
elif kind == 'north_arrow':
    na = QgsLayoutItemPicture(lay)
    na.setPicturePath(':/images/north_arrows/layout_default_north_arrow.svg')
    sz = float(P.get('size') or 10)
    lay.addLayoutItem(na)
    na.attemptMove(QgsLayoutPoint(x, y, MM()))
    na.attemptResize(QgsLayoutSize(sz, sz, MM()))
    item = na
elif kind == 'text':
    if not P.get('text'):
        raise ValueError('kind=text requires text')
    t = QgsLayoutItemLabel(lay)
    t.setText(P['text'])
    f = QFont(P.get('family') or 'Microsoft YaHei')
    f.setPointSizeF(float(P.get('size') or 10))
    f.setBold(bool(P.get('bold')))
    t.setFont(f)
    t.setFontColor(QColor(P.get('color') or '#2E2A24'))
    lay.addLayoutItem(t)
    al = str(P.get('align') or 'left').lower()
    if w is not None:
        t.attemptMove(QgsLayoutPoint(x, y, MM()))
        t.attemptResize(QgsLayoutSize(float(w), float(h or 6), MM()))
        t.setHAlign(Qt.AlignmentFlag.AlignRight if al.startswith('r') else (Qt.AlignmentFlag.AlignHCenter if al.startswith('c') else Qt.AlignmentFlag.AlignLeft))
    else:
        t.adjustSizeToText()
        t.attemptMove(QgsLayoutPoint(x, y, MM()))
    item = t
elif kind == 'rect':
    if w is None or h is None:
        raise ValueError('kind=rect requires width and height in mm (e.g. 160 and 100)')
    s = QgsLayoutItemShape(lay)
    s.setShapeType(QgsLayoutItemShape.Rectangle)
    s.setSymbol(QgsFillSymbol.createSimple({'color': P.get('color') or '#ffffff',
                                            'outline_color': P.get('outline_color') or 'transparent',
                                            'outline_width': str(P.get('outline_width') or 0)}))
    lay.addLayoutItem(s)
    s.attemptMove(QgsLayoutPoint(x, y, MM()))
    s.attemptResize(QgsLayoutSize(float(w), float(h), MM()))
    item = s
elif kind == 'swatch':
    shape = str(P.get('shape') or 'circle').lower()
    col = QColor(P.get('color') or '#B04A32')
    sz = float(P.get('size') or 3)
    if shape == 'line':
        s = QgsLayoutItemShape(lay)
        s.setShapeType(QgsLayoutItemShape.Rectangle)
        s.setSymbol(QgsFillSymbol.createSimple({'color': col.name(), 'outline_color': col.name(), 'outline_width': '0'}))
        lay.addLayoutItem(s)
        s.attemptMove(QgsLayoutPoint(x, y, MM()))
        s.attemptResize(QgsLayoutSize(float(P.get('length') or 12), float(P.get('line_width') or 0.5), MM()))
    else:
        s = QgsLayoutItemShape(lay)
        s.setShapeType(QgsLayoutItemShape.Ellipse if shape == 'circle' else QgsLayoutItemShape.Rectangle)
        s.setSymbol(QgsFillSymbol.createSimple({'color': col.name(),
                                                'outline_color': P.get('outline_color') or col.name(),
                                                'outline_width': str(P.get('outline_width') or 0.15)}))
        lay.addLayoutItem(s)
        s.attemptMove(QgsLayoutPoint(x, y, MM()))
        s.attemptResize(QgsLayoutSize(sz, sz, MM()))
    item = s
elif kind == 'graticule':
    maps = [it for it in lay.items() if it.type() == 65639]
    if not maps:
        raise ValueError('graticule requires a map item first')
    m = maps[int(P.get('map') or 0)]
    step = float(P.get('step') or 1)
    col = QColor(P.get('color') or '#A99C83')
    lw = float(P.get('width') or 0.15)
    # Use the map item's own grid: native, stable, and it draws the annotations.
    g = m.grid()
    g.setEnabled(True)
    g.setCrs(QgsCoordinateReferenceSystem('EPSG:4326'))
    g.setIntervalX(step)
    g.setIntervalY(step)
    g.setStyle(QgsLayoutItemMapGrid.Cross)
    g.setCrossLength(4.0)
    g.setFrameStyle(QgsLayoutItemMapGrid.NoFrame)
    try:
        g.setGridLineSymbol(QgsLineSymbol.createSimple({'color': col.name(), 'width': str(lw)}))
    except Exception:
        pass
    g.setAnnotationEnabled(bool(P.get('labels', True)))
    if P.get('labels', True):
        f = QFont(P.get('family') or 'Microsoft YaHei')
        f.setPointSizeF(float(P.get('label_size') or 7))
        g.setAnnotationFont(f)
        g.setAnnotationFontColor(col)
        try:
            g.setAnnotationFormat(QgsLayoutItemMapGrid.DegreeMinute)
        except Exception:
            g.setAnnotationFormat(QgsLayoutItemMapGrid.Degree)
        g.setAnnotationPrecision(0)
        try:
            g.setAnnotationDisplay(QgsLayoutItemMapGrid.ShowAll)
        except Exception:
            pass
    m.invalidateCache()
    lay.refresh()
    item = m
elif kind == 'table':
    rows = P.get('rows') or []
    widths = [float(v) for v in (P.get('widths') or [])]
    rh = float(P.get('row_height') or 5.2)
    fs = float(P.get('size') or 7.4)
    fam = P.get('family') or 'Microsoft YaHei'
    col = QColor(P.get('color') or '#2E2A24')
    al = str(P.get('align') or 'left').lower()
    for ri, row in enumerate(rows):
        cx = x
        for ci, cell in enumerate(row):
            cw = widths[ci] if ci < len(widths) else 20.0
            t = QgsLayoutItemLabel(lay)
            t.setText(str(cell))
            f = QFont(fam)
            f.setPointSizeF(fs)
            f.setBold(bool(P.get('bold')) or (ri == 0 and bool(P.get('header'))))
            t.setFont(f)
            t.setFontColor(col)
            lay.addLayoutItem(t)
            t.attemptMove(QgsLayoutPoint(cx, y + ri * rh, MM()))
            t.attemptResize(QgsLayoutSize(cw, rh, MM()))
            t.setHAlign(Qt.AlignmentFlag.AlignRight if al.startswith('r') else Qt.AlignmentFlag.AlignLeft)
            cx += cw
    item = None
else:
    raise ValueError('unknown kind: ' + str(kind))
if item is not None and z is not None:
    item.setZValue(float(z))
if item is not None:
    rect = rect_of(item)
else:
    rect = [x, y, float(w or sum([float(v) for v in (P.get('widths') or [])])), float(h or 0)]
_all = [it2 for it2 in lay.items() if isinstance(it2, QgsLayoutItem)]
result = {'layout': lay.name(), 'kind': kind,
          'uuid': item.uuid() if item is not None else None,
          'rect': rect,
          'note': 'use uuid with action=update_item; indexes shift as items are added'
                  if item is not None else 'no item was created'}`,
  update_item: `
lay = LAYOUT(P['layout'])
items = [it for it in lay.items() if isinstance(it, QgsLayoutItem)]
_uuid = P.get('uuid')
if _uuid:
    _hit = [n for n, x in enumerate(items) if x.uuid() == _uuid]
    if not _hit:
        raise IndexError('no item with uuid %s - call action=info for the current list' % _uuid)
    i = _hit[0]
else:
    if P.get('index') is None:
        raise ValueError('update_item needs index (from action=info) or uuid (from add_item)')
    i = int(P['index'])
if i < 0 or i >= len(items):
    raise IndexError('item index out of range: %d >= %d' % (i, len(items)))
it = items[i]
if P.get('remove'):
    lay.removeLayoutItem(it)
    result = {'removed': i, 'items': len([x for x in lay.items() if isinstance(x, QgsLayoutItem)])}
else:
    p = it.positionWithUnits(); s = it.sizeWithUnits()
    nx = p.x() if P.get('x') is None else float(P['x'])
    ny = p.y() if P.get('y') is None else float(P['y'])
    nw = s.width() if P.get('width') is None else float(P['width'])
    nh = s.height() if P.get('height') is None else float(P['height'])
    it.attemptMove(QgsLayoutPoint(nx, ny, MM()))
    it.attemptResize(QgsLayoutSize(nw, nh, MM()))
    lay.refresh()
    result = {'index': i, 'kind': type(it).__name__, 'rect': [round(nx, 1), round(ny, 1), round(nw, 1), round(nh, 1)]}`,
  export: `
_layout_name = P.get('layout_name') or P.get('layout')
if not _layout_name:
    # One argument should be enough when the answer is obvious; with several layouts
    # a silent pick would export the wrong one, so the error names them instead.
    _names = [x.name() for x in prj.layoutManager().layouts()]
    if not _names:
        raise ValueError('no print layout in this project yet - create one with action=create layout_name=<name>')
    if len(_names) > 1:
        raise ValueError('this project has %d layouts (%s) - pass layout=<name> or layouts=[...]'
                         % (len(_names), ', '.join(_names)))
    _layout_name = _names[0]
P['layout_name'] = _layout_name
lay = LAYOUT(_layout_name)


def _export_one(_fmt):
    import tempfile
    for _it in lay.items():
        try:
            if isinstance(_it, QgsLayoutItemMap):
                _it.invalidateCache()
        except Exception:
            pass
    lay.refresh()
    if _fmt == 'pdf':
        if P.get('path'):
            path = P['path']
        else:
            fd, path = tempfile.mkstemp(suffix='.pdf')
            os.close(fd)
            os.remove(path)
        st = QgsLayoutExporter.PdfExportSettings()
        r = QgsLayoutExporter(lay).exportToPdf(path, st)
        if r != 0 or not os.path.exists(path):
            raise RuntimeError('layout pdf export failed (result %s)' % r)
        fd2, png = tempfile.mkstemp(suffix='.png'); os.close(fd2); os.remove(png)
        st2 = QgsLayoutExporter.ImageExportSettings()
        st2.dpi = int(P.get('dpi') or 300)
        r2 = QgsLayoutExporter(lay).exportToImage(png, st2)
        return {'format': 'pdf', 'result': r, 'size_bytes': os.path.getsize(path),
                'file_path': path if P.get('path') else _publish(path, 'pdf'),
                'image_path': _publish(png, 'png') if r2 == 0 and os.path.exists(png) else None,
                'hint': 'image_path is a PNG preview (read_image it); file_path is the deliverable PDF'}
    st = QgsLayoutExporter.ImageExportSettings()
    st.dpi = int(P.get('dpi') or 300)
    fd, path = tempfile.mkstemp(suffix='.png'); os.close(fd)
    os.remove(path)
    r = QgsLayoutExporter(lay).exportToImage(path, st)
    if r != 0 or not os.path.exists(path):
        raise RuntimeError('layout export failed (result %s)' % r)
    return {'format': 'png', 'result': r, 'size_bytes': os.path.getsize(path),
            'image_path': _publish(path, 'png'),
            'hint': 'read_image the image_path'}


_fmts = [str(f).lower() for f in (P.get('formats') or []) if str(f).lower() in ('png', 'pdf')]
# A batch item already carries its one format; only the single call loops over formats.
_single = str(P.get('format') or '').lower()
if _single in ('png', 'pdf'):
    _fmts = [_single]
if len(_fmts) > 1:
    _out = []
    for _f in _fmts:
        _out.append(_export_one(_f))
    result = {'count': len(_out), 'results': _out}
else:
    result = _export_one((_fmts or [P.get('format') or 'png'])[0])`,

  export_atlas: `
lay = LAYOUT(P['layout_name'])
atlas = lay.atlas()
if not atlas.enabled():
    raise ValueError('layout atlas is not enabled')
atlas.updateFeatures()
n = atlas.count()
import base64, tempfile
st = QgsLayoutExporter.ImageExportSettings() if (P.get('format') or 'pdf') == 'png' else None
fd, path = tempfile.mkstemp(suffix='.pdf' if st is None else '.png'); os.close(fd)
for _it in lay.items():
    try:
        if isinstance(_it, QgsLayoutItemMap):
            _it.invalidateCache()
    except Exception:
        pass
lay.refresh()
os.remove(path)
if st is None:
    r = QgsLayoutExporter(lay).exportToPdf(path, QgsLayoutExporter.PdfExportSettings())
    fd2, png = tempfile.mkstemp(suffix='.png'); os.close(fd2); os.remove(png)
    st2 = QgsLayoutExporter.ImageExportSettings()
    st2.dpi = int(P.get('dpi') or 200)
    r2 = QgsLayoutExporter(lay).exportToImage(png, st2)
    result = {'format': 'pdf', 'pages': n, 'result': r, 'size_bytes': os.path.getsize(path),
              'file_path': _publish(path, 'pdf'),
              'image_path': _publish(png, 'png') if r2 == 0 and os.path.exists(png) else None,
              'hint': 'image_path 是 PNG 预览（用 read_image 看）；file_path 是交付用 PDF'}
else:
    st.dpi = int(P.get('dpi') or 300)
    r = QgsLayoutExporter(lay).exportToImage(path, st)
    result = {'format': 'png', 'pages': n, 'result': r, 'size_bytes': os.path.getsize(path),
              'image_path': _publish(path, 'png'),
              'hint': '使用 read_image 工具查看该图片路径'}`,
  legend_edit: `
lay = LAYOUT(P['layout'])
lgs = [it for it in lay.items() if isinstance(it, QgsLayoutItemLegend)]
if not lgs:
    raise ValueError('layout has no legend item')
lg = lgs[0]
op = P.get('op') or 'style'
if op == 'style':
    f = QFont(P.get('family') or 'Microsoft YaHei')
    if P.get('size'):
        f.setPointSize(int(P['size']))
    lg.setStyleFont(QgsLegendStyle.Style.Title, f)
    lg.setStyleFont(QgsLegendStyle.Style.Subgroup, f)
    lg.setStyleFont(QgsLegendStyle.Style.SymbolLabel, f)
elif op == 'columns':
    lg.setColumnCount(int(P.get('columns') or 1))
elif op == 'text':
    target = P.get('layer'); txt = P.get('text') or ''
    node = None
    for ch in lg.model().rootGroup().children():
        if ch.name() == target:
            node = ch
            break
    if node is None:
        raise ValueError('legend has no layer named ' + str(target))
    node.setName(txt)
elif op == 'remove':
    target = P.get('layer')
    root = lg.model().rootGroup()
    # Detach before editing: the live root belongs to the project, so removing from it
    # would remove the layer from the project instead of from the legend.
    lg.setAutoUpdateModel(False)
    _kept = QgsLayerTreeGroup()
    for ch in list(root.children()):
        if ch.name() != target:
            _kept.addChildNode(ch.clone())
    lg.model().setRootGroup(_kept)
elif op == 'title':
    lg.setTitle(P.get('title') or '')
else:
    raise ValueError('unknown op: ' + str(op))
lg.setAutoUpdateModel(False)
lg.updateLegend()
lay.refresh()
result = {'layout': lay.name(), 'op': op,
          'items': [ch.name() for ch in lg.model().rootGroup().children()]}`,
  align: `
lay = LAYOUT(P['layout'])
mode = (P.get('align') or 'left').lower()
idxs = P.get('indexes') or []
items = [it for it in lay.items() if isinstance(it, QgsLayoutItem)]
if idxs:
    sel = [items[i] for i in idxs if 0 <= i < len(items)]
else:
    sel = [it for it in items if it.type() not in (65648, 65606)]
if not sel:
    raise ValueError('no items to align')
rects = [(it.positionWithUnits().x(), it.positionWithUnits().y(),
          it.sizeWithUnits().width(), it.sizeWithUnits().height()) for it in sel]
if mode == 'left':
    tgt = min(r[0] for r in rects)
    for it, r in zip(sel, rects):
        it.attemptMove(QgsLayoutPoint(tgt, r[1], MM()))
elif mode == 'right':
    tgt = max(r[0] + r[2] for r in rects)
    for it, r in zip(sel, rects):
        it.attemptMove(QgsLayoutPoint(tgt - r[2], r[1], MM()))
elif mode == 'top':
    tgt = min(r[1] for r in rects)
    for it, r in zip(sel, rects):
        it.attemptMove(QgsLayoutPoint(r[0], tgt, MM()))
elif mode == 'bottom':
    tgt = max(r[1] + r[3] for r in rects)
    for it, r in zip(sel, rects):
        it.attemptMove(QgsLayoutPoint(r[0], tgt - r[3], MM()))
elif mode == 'center_h':
    c = sum(r[1] + r[3] / 2.0 for r in rects) / len(rects)
    for it, r in zip(sel, rects):
        it.attemptMove(QgsLayoutPoint(r[0], c - r[3] / 2.0, MM()))
elif mode == 'center_v':
    c = sum(r[0] + r[2] / 2.0 for r in rects) / len(rects)
    for it, r in zip(sel, rects):
        it.attemptMove(QgsLayoutPoint(c - r[2] / 2.0, r[1], MM()))
elif mode == 'distribute_h':
    sel.sort(key=lambda it: it.positionWithUnits().x())
    if len(sel) > 2:
        x0 = sel[0].positionWithUnits().x(); x1 = sel[-1].positionWithUnits().x()
        step = (x1 - x0) / (len(sel) - 1)
        for i, it in enumerate(sel):
            it.attemptMove(QgsLayoutPoint(x0 + step * i, it.positionWithUnits().y(), MM()))
elif mode == 'distribute_v':
    sel.sort(key=lambda it: it.positionWithUnits().y())
    if len(sel) > 2:
        y0 = sel[0].positionWithUnits().y(); y1 = sel[-1].positionWithUnits().y()
        step = (y1 - y0) / (len(sel) - 1)
        for i, it in enumerate(sel):
            it.attemptMove(QgsLayoutPoint(it.positionWithUnits().x(), y0 + step * i, MM()))
else:
    raise ValueError('unknown align mode: ' + str(mode))
lay.refresh()
result = {'layout': lay.name(), 'mode': mode, 'items': len(sel)}`,
};

const MAP_BODY = {
  render: `
w = int(P.get('width') or 800); h = int(P.get('height') or 600)
import base64, tempfile
ms = QgsMapSettings()
_lay_name = P.get('layer')
_lay = L(_lay_name) if _lay_name else None
ms.setLayers([_lay] if _lay is not None else [l for l in prj.layerTreeRoot().layerOrder()])
ms.setDestinationCrs(prj.crs())
_e = _prj_extent()
if _lay is not None:
    # one named layer: frame it, otherwise the extent of every leftover layer decides the view
    _le = _lay.extent()
    if _le.width() > 0 or _le.height() > 0:
        _e = _le
if _e is None:
    raise RuntimeError('project has no layer extent to render')
if None not in (P.get('xmin'), P.get('ymin'), P.get('xmax'), P.get('ymax')):
    _e = QgsRectangle(float(P['xmin']), float(P['ymin']), float(P['xmax']), float(P['ymax']))
    _crs = QgsCoordinateReferenceSystem(P['crs']) if P.get('crs') else prj.crs()
    if _crs.isValid() and _crs != prj.crs():
        _e = QgsCoordinateTransform(_crs, prj.crs(), prj).transformBoundingBox(_e)
    if _e.width() <= 0 or _e.height() <= 0:
        _pad = 0.01 if prj.crs().isGeographic() else 100.0
        _e = QgsRectangle(_e.xMinimum() - _pad, _e.yMinimum() - _pad,
                          _e.xMaximum() + _pad, _e.yMaximum() + _pad)
ms.setExtent(_e)
ms.setOutputSize(QSize(w, h))
ms.setBackgroundColor(QColor('white'))
img = QImage(QSize(w, h), QImage.Format.Format_ARGB32); img.fill(QColor('white'))
p = QPainter(img)
QgsMapRendererCustomPainterJob(ms, p).renderSynchronously()
p.end()
fd, path = tempfile.mkstemp(suffix='.png'); os.close(fd)
img.save(path, 'PNG')
result = {'width': w, 'height': h, 'size_bytes': os.path.getsize(path),
          'image_path': _publish(path, 'png'),
          'hint': '使用 read_image 工具查看该图片路径'}`,
  set_extent: `
canvas = list(iface.mapCanvases())[0] if iface is not None else None
if canvas is None:
    raise RuntimeError('no map canvas: needs a GUI session')
rect = QgsRectangle(float(P['xmin']), float(P['ymin']), float(P['xmax']), float(P['ymax']))
crs = QgsCoordinateReferenceSystem(P['crs']) if P.get('crs') else canvas.mapSettings().destinationCrs()
xf = QgsCoordinateTransform(crs, canvas.mapSettings().destinationCrs(), prj)
rect = xf.transformBoundingBox(rect)
canvas.setExtent(rect); canvas.refresh()
result = {'extent': [round(v, 1) for v in (rect.xMinimum(), rect.yMinimum(), rect.xMaximum(), rect.yMaximum())]}`,
  zoom_to_layer: `
canvas = list(iface.mapCanvases())[0] if iface is not None else None
if canvas is None:
    raise RuntimeError('no map canvas: needs a GUI session')
l = L(P['layer'])
xf = QgsCoordinateTransform(l.crs(), canvas.mapSettings().destinationCrs(), prj)
canvas.setExtent(xf.transformBoundingBox(l.extent())); canvas.refresh()
result = {'layer': l.name()}`,
  screenshot: `
canvas = list(iface.mapCanvases())[0] if iface is not None else None
target = P.get('target') or 'canvas'
if target == 'mainwindow':
    if iface is None:
        raise RuntimeError('no main window: needs a GUI session')
    shot = iface.mainWindow().grab()
elif canvas is not None:
    shot = canvas.grab()
else:
    raise RuntimeError('no map canvas: needs a GUI session')
import base64, tempfile
fd, path = tempfile.mkstemp(suffix='.png'); os.close(fd)
shot.save(path, 'PNG')
result = {'target': target, 'size_bytes': os.path.getsize(path),
          'image_path': _publish(path, 'png'),
          'hint': '使用 read_image 工具查看该图片路径'}`,
};

const ANALYSIS_BODY = {
  list: `
kw = (P.get('keyword') or '').lower()
want = (P.get('provider') or '').lower()
limit = max(1, min(int(P.get('limit') or 200), 1000))
reg = QgsApplication.processingRegistry()
if reg.algorithms() == [] or True:
    from qgis.analysis import QgsNativeAlgorithms
    try:
        reg.addProvider(QgsNativeAlgorithms())
    except Exception:
        pass
providers = {}
for a in reg.algorithms():
    pid = a.provider().id()
    providers[pid] = providers.get(pid, 0) + 1
if want and want not in providers:
    raise ValueError('unknown provider "' + want + '" - one of ' + ', '.join(sorted(providers)))
algs = []
total = 0
for a in reg.algorithms():
    if want and a.provider().id() != want:
        continue
    if kw and kw not in a.id().lower() and kw not in a.displayName().lower():
        continue
    total += 1
    if len(algs) < limit:
        algs.append({'id': a.id(), 'name': a.displayName()})
result = {'count': len(algs), 'total': total, 'truncated': total > len(algs),
          'providers': providers, 'algorithms': algs}`,
  help: `
reg = QgsApplication.processingRegistry()
alg = reg.algorithmById(P['algorithm'])
if alg is None:
    raise ValueError('algorithm not found: ' + P['algorithm'])
params = []
for p in alg.parameterDefinitions():
    row = {'name': p.name(), 'type': p.type(), 'optional': bool(p.flags() & 8),
           'description': p.description()}
    # Enum parameters are useless without their options: GRASS/GDAL expect the
    # option name or index, and guessing it is what fails a first run.
    try:
        opts = list(p.options() or [])
        if opts:
            row['options'] = opts
    except Exception:
        pass
    try:
        if p.allowMultiple():
            row['multiple'] = True
    except Exception:
        pass
    try:
        d = p.defaultValue()
        if d is not None and d != '':
            row['default'] = d
            # An enum's default is an index; name the option so nobody counts.
            if row.get('options') and isinstance(d, int) and 0 <= d < len(row['options']):
                row['default_option'] = row['options'][d]
    except Exception:
        pass
    try:
        lo, hi = p.minimum(), p.maximum()
        if lo > -1e308:
            row['min'] = lo
        if hi < 1e308:
            row['max'] = hi
    except Exception:
        pass
    params.append(row)
result = {'id': alg.id(), 'name': alg.displayName(), 'parameters': params}`,
  run: `
from qgis import processing
alg = P['algorithm']
params = dict(P.get('params') or {})
reg = QgsApplication.processingRegistry()
ad = reg.algorithmById(alg)
if ad is None:
    from qgis.analysis import QgsNativeAlgorithms
    try:
        reg.addProvider(QgsNativeAlgorithms())
    except Exception:
        pass
    ad = reg.algorithmById(alg)
if ad is None:
    raise ValueError('algorithm not found: ' + alg)
mapped = {}
for k, v in params.items():
    if isinstance(v, str) and prj.mapLayersByName(v):
        mapped[k] = prj.mapLayersByName(v)[0]
    else:
        mapped[k] = v
# A point parameter (gdal:viewshed OBSERVER, for one) is not a layer name: accept
# [x, y] or "x,y" as coordinates instead of letting QGIS reject the string.
for pdef in ad.parameterDefinitions():
    try:
        if pdef.type() != 'point':
            continue
    except Exception:
        continue
    v = mapped.get(pdef.name())
    if isinstance(v, (list, tuple)) and len(v) == 2:
        mapped[pdef.name()] = QgsPointXY(float(v[0]), float(v[1]))
    elif isinstance(v, str) and ',' in v and not prj.mapLayersByName(v):
        try:
            a, b = v.split(',', 1)
            mapped[pdef.name()] = QgsPointXY(float(a), float(b))
        except ValueError:
            pass
# Outputs: a sink the caller left empty stays in memory, and the result says so.
# Guessing a path would either overwrite a file or, worse, look like it wrote one.
_SINK_TYPES = ('sink', 'rasterDestination', 'vectorDestination',
               'fileDestination', 'folderDestination')
_sinks = []
_sink_kind = {}
for pdef in ad.parameterDefinitions():
    try:
        t = pdef.type()
    except Exception:
        continue
    if t in _SINK_TYPES:
        _sinks.append(pdef.name())
        _sink_kind[pdef.name()] = t
_wanted = P.get('output')
_named = [n for n in _sinks if mapped.get(n)]
if _wanted and len(_sinks) > 1 and not _named:
    raise ValueError('this algorithm has %d outputs (%s) so output= is ambiguous - name one in params, e.g. {"%s": "%s"}'
                     % (len(_sinks), ', '.join(_sinks), _sinks[0], _wanted))
_memory_outputs = []
_defaulted = {}
for n in _sinks:
    if mapped.get(n):
        continue
    if _wanted and len(_sinks) == 1:
        mapped[n] = _wanted
        continue
    if _sink_kind.get(n) == 'sink':
        # a vector sink is a real layer in memory, and it is added to the project
        mapped[n] = 'memory:'
        _memory_outputs.append(n)
        continue
    # raster/file sinks do not survive as 'memory:' - give them a file, otherwise
    # the run "succeeds" and the result cannot be reached afterwards
    ext = '.tif' if _sink_kind.get(n) == 'rasterDestination' else ''
    # name the file after the algorithm so the layer the result becomes is guessable
    _short = str(alg).split(':')[-1].replace('-', '_').replace('.', '_')[:24]
    _defaulted[n] = os.path.join(_OUT, '%s_%d_%s%s'
                                 % (_short, int(time.time() * 1000) % 100000, n.lower(), ext))
    mapped[n] = _defaulted[n]
try:
    out = processing.run(alg, mapped)
except Exception as e:
    raise ValueError('%s (incomplete params: try action=help %s)' % (e, alg))
added = []
clean = {}
for k, v in (out or {}).items():
    if hasattr(v, 'source'):
        try:
            prj.addMapLayer(v)
            added.append(v.name())
            clean[k] = v.name()
        except Exception:
            clean[k] = 'layer'
    else:
        txt = v if isinstance(v, str) else str(v)
        clean[k] = txt if len(txt) <= 120 else (txt[:100] + '...')
_written = dict(_defaulted)
# A sink the caller named is just as reachable as one we defaulted — load either,
# otherwise an explicit output=file succeeds and the raster is nowhere in the project.
for _n in _sinks:
    _p = mapped.get(_n)
    if not _p or _p == 'memory:' or not os.path.exists(_p):
        continue
    if _n not in _written:
        _written[_n] = _p
    try:
        _l = QgsRasterLayer(_p, os.path.splitext(os.path.basename(_p))[0])
        if not _l.isValid():
            _l = QgsVectorLayer(_p, os.path.splitext(os.path.basename(_p))[0], 'ogr')
        if _l.isValid():
            prj.addMapLayer(_l)
            added.append(_l.name())
            clean[_n] = _p
    except Exception:
        pass
_unwritten = [k for k, v in (out or {}).items()
              if isinstance(v, str) and v and not v.startswith('memory:') and not os.path.exists(v)]
result = {'algorithm': alg, 'outputs': clean, 'added_layers': added}
if _written:
    result['written_outputs'] = _written
_hints = []
if _memory_outputs:
    result['memory_outputs'] = _memory_outputs
    _hints.append('no path was given for %s, so the result stayed in memory as a project layer'
                  ' (pass params={"%s": "<file>"} or output=<file> to write a file instead)'
                  % (', '.join(_memory_outputs), _memory_outputs[0]))
if _unwritten:
    result['unwritten_outputs'] = _unwritten
    _hints.append('returned success but wrote no file for ' + ', '.join(_unwritten)
                  + ' - pass the OUTPUT_* paths explicitly, or a memory: sink, and check action=help for '
                  + 'required options such as EXTENT_OPT/CREATION_OPTIONS')
if _hints:
    result['hint'] = '; '.join(_hints)`,
  zonal_stats: `
rname = P.get('raster')
rl = None
for l in prj.mapLayers().values():
    if isinstance(l, QgsRasterLayer) and l.name() == rname:
        rl = l
        break
if rl is None:
    raise ValueError('raster not found: ' + str(rname))
vl = L(P['layer'])
from qgis.analysis import QgsZonalStatistics
prefix = P.get('prefix') or 'z_'
stats = Qgis.ZonalStatistic.All
band = int(P.get('band') or 1)
try:
    zs = QgsZonalStatistics(vl, rl, prefix, band, stats)
    res = None
except TypeError:
    zs = QgsZonalStatistics(vl, rl.dataProvider(), rl.crs(), rl.rasterUnitsPerPixelX(),
                            rl.rasterUnitsPerPixelY(), prefix, band, stats)
    res = None
res = zs.calculateStatistics(None)
flds = [f.name() for f in vl.fields() if f.name().startswith(prefix)]
idx = [vl.fields().indexOf(n) for n in flds]
agg = {}
for f in vl.getFeatures():
    for n, i in zip(flds, idx):
        v = f[i]
        if v is None:
            continue
        agg.setdefault(n, []).append(float(v))
summary = {}
for n, vs in agg.items():
    summary[n] = {'count': len(vs), 'min': round(min(vs), 3), 'max': round(max(vs), 3),
                  'mean': round(sum(vs) / len(vs), 3)}
result = {'layer': vl.name(), 'raster': rl.name(), 'status': res, 'fields': flds, 'summary': summary}`,
  reclassify: `
from qgis import processing
rname = P.get('raster')
base = P.get('output') or (rname + '_reclass')
out_path = os.path.join(_OUT, base + '.tif')
params = {'TABLE': P.get('table') or [], 'RANGE_BOUNDARIES': int(P.get('range_boundaries') or 0),
          'NODATA': P.get('nodata') if P.get('nodata') is not None else -9999, 'OUTPUT': out_path}
params = {k: v for k, v in params.items() if v not in (None, [])}
params['INPUT_RASTER'] = rname
processing.run('native:reclassifybytable', params)
layer = QgsRasterLayer(out_path, base)
if not layer.isValid():
    raise ValueError('reclassify produced no raster: ' + out_path)
prj.addMapLayer(layer)
result = {'raster': rname, 'table': params.get('TABLE'), 'added': layer.name(), 'path': out_path}`,
};

// Actions that change what another agent would read back from this instance
// (project state, layouts, layer styling). Reads and exports stay
// unlocked on purpose: parallel rendering is the whole point of the shard API.
// An entry may be a plain action or { action, when(args) } for a sub-op.
export const MUTATING = {
  qgis_project: ['open', 'save', 'save_as', 'set_crs'],
  qgis_layer: ['add', 'create', 'remove', 'visibility', 'crs', 'style', 'symbol',
    'classify', 'style_multi', 'style_rule', 'labels', 'annotate', 'reproject'],
  qgis_feature: ['add', 'update', 'delete', 'field_add', 'field_calc',
    'field_delete', 'field_rename'],
  qgis_layout: ['create', 'add_item', 'update_item', 'legend_edit', 'align'],
}

export const lockOwner = (exec) => {
  const agent = exec && exec.agent
  return (agent && (agent.name || agent.id)) || 'dsh'
}

export function isMutating(tool, action, args) {
  const list = MUTATING[tool]
  if (!list) return false
  return list.some((entry) => (typeof entry === 'string'
    ? entry === action
    : entry.action === action && (!entry.when || entry.when(args))))
}

// ---- Permission scope -------------------------------------------------------
// read   looks and renders, never writes: no project change, no file written,
//        no Python. Export takes a path, so it counts as a write.
// write  the default: edit the project, export, run algorithms. Destructive and
//        out-of-project actions stay out of reach.
// danger everything, including delete, opening/saving arbitrary projects,
//        plugin instructions, and raw PyQGIS.
export const SCOPES = ['read', 'write', 'danger']

export const READ_ONLY_ACTIONS = new Set([
  'qgis_project:info',
  'qgis_layer:list', 'qgis_layer:info', 'qgis_layer:fields',
  'qgis_feature:query', 'qgis_feature:select', 'qgis_feature:select_by_location',
  'qgis_feature:selected', 'qgis_feature:table',
  'qgis_layout:list', 'qgis_layout:info',
  'qgis_analysis:list', 'qgis_analysis:help',
  'qgis_map:render', 'qgis_map:set_extent', 'qgis_map:zoom_to_layer', 'qgis_map:screenshot',
  'qgis_plugin:status', 'qgis_plugin:log', 'qgis_plugin:lock',
])

/** Actions that need the widest scope: destructive, out-of-project, or raw code. */
export const DANGER_ACTIONS = new Set([
  'qgis_project:open', 'qgis_project:save_as',
  'qgis_layer:remove',
  'qgis_feature:delete', 'qgis_feature:field_delete',
  'qgis_plugin:restart',
  'execute_qgis_sync:*', 'submit_qgis_async:*',
])

/** Actions that write files but do not damage the project. */
export const WRITE_ACTIONS = new Set([
  'qgis_layer:export', 'qgis_layer:export_table',
  'qgis_layout:export', 'qgis_layout:export_atlas',
])

/** What the given call needs: 'read' | 'write' | 'danger'. */
export function requiredScope(tool, action, args) {
  const key = `${tool}:${action}`
  if (DANGER_ACTIONS.has(key) || DANGER_ACTIONS.has(`${tool}:*`)) return 'danger'
  if (tool === 'qgis_plugin' && action === 'lock' && args?.op === 'release') return 'write'
  if (tool === 'qgis_plugin' && action === 'lock' && args?.op === 'acquire') return 'write'
  if (READ_ONLY_ACTIONS.has(key)) return 'read'
  if (WRITE_ACTIONS.has(key)) return 'write'
  if (isMutating(tool, action, args)) return 'write'
  return isUnder(key) ? 'write' : 'read'
}

function isUnder(key) {
  // Anything not explicitly listed above still changes something unless it is a
  // `list`/`info`/`help` read; treating it as a write is the safe default.
  const [, action = ''] = key.split(':')
  return !/^(list|info|help|query|table|selected|describe|status|log|render|screenshot)$/.test(action)
}

const SCOPE_RANK = { read: 0, write: 1, danger: 2 }

/** null when the call is allowed, otherwise the message the model reads. */
export function scopeRefusal(scope, tool, action, args) {
  const need = requiredScope(tool, action, args)
  const have = SCOPES.includes(scope) ? scope : 'write'
  if (SCOPE_RANK[need] <= SCOPE_RANK[have]) return null
  const label = action ? `${tool} ${action}` : tool
  const what = need === 'danger'
    ? 'that action can destroy data or run arbitrary Python'
    : 'that action writes to the project or to disk'
  return `${label} is blocked: ${what}, and the current permission scope is "${have}". ` +
    'This bundle cannot open a dialog itself. Tell the user which call is blocked and why, ' +
    `and ask them (ask_user_question) to switch the scope to "${need}" in the composer scope ` +
    'selector or in Settings; the switch takes effect on your very next call, so retry then. ' +
    'Reads, renders and the audit log are never blocked.'
}

export function assertScope(scope, tool, action, args) {
  const message = scopeRefusal(scope, tool, action, args)
  if (message) {
    const err = new Error(message)
    err.code = 'SCOPE_DENIED'
    throw err
  }
}

// Batch: one tool call = one pyeval round-trip even for N entries.
// A per-tool `action` spec decides which array key batches and where a string
// entry is assigned (e.g. layers: ["A","B"] -> P['layer'] = "A" / "B").
export const BATCH_SPEC = {
  'qgis_layer:add': { key: 'paths', assign: 'path' },
  'qgis_layer:export': { key: 'layers', assign: 'layer', perPath: true },
  'qgis_layer:style': { key: 'layers', assign: 'layer' },
  'qgis_layer:symbol': { key: 'layers', assign: 'layer' },
  'qgis_layer:classify': { key: 'layers', assign: 'layer' },
  'qgis_feature:query': { key: 'layers', assign: 'layer' },
  'qgis_feature:select': { key: 'layers', assign: 'layer' },
  'qgis_feature:select_by_location': { key: 'layers', assign: 'layer' },
  'qgis_feature:update': { key: 'layers', assign: 'layer' },
  'qgis_feature:delete': { key: 'layers', assign: 'layer' },
  'qgis_feature:field_add': { key: 'specs' },
  'qgis_feature:field_calc': { key: 'specs' },
  'qgis_feature:field_delete': { key: 'specs' },
  'qgis_feature:field_rename': { key: 'specs' },
  'qgis_analysis:run': { key: 'runs' },
  'qgis_layout:add_item': { key: 'items' },
  'qgis_layout:update_item': { key: 'updates' },
  'qgis_layout:export': { key: 'layouts', assign: 'layout', formats: true },
  'qgis_layout:export_atlas': { key: 'layouts', assign: 'layout', formats: true },
};

// Args an action cannot run without. Checked before the round-trip so a wrong
// first call costs a sentence, not a QGIS call plus a Python KeyError. Each
// entry is a list of alternatives: every group must have one present key.
export const REQUIRED_ARGS = {
  'qgis_project:open': [['path']],
  'qgis_project:save_as': [['path']],
  'qgis_project:set_crs': [['crs', 'crs_file']],
  'qgis_layer:add': [['path', 'paths']],
  'qgis_layer:export': [['layer', 'layers']],
  'qgis_layout:create': [['layout_name', 'layout']],
  'qgis_layout:add_item': [['layout_name', 'layout'], ['kind']],
  'qgis_layout:update_item': [['layout_name', 'layout'], ['index', 'uuid']],
  'qgis_analysis:run': [['algorithm']],
};

// Parameters that a batch list supplies per item, so the top-level argument is
// optional when the list is present (runs=[{algorithm,…}], items=[{kind,…}]).
const PER_ITEM_ARGS = {
  'qgis_analysis:run': ['algorithm'],
  'qgis_layout:add_item': ['kind'],
  'qgis_layout:update_item': ['index', 'uuid'],
};

export function checkRequired(tool, action, a) {
  const key = tool + ':' + action;
  const groups = REQUIRED_ARGS[key];
  if (!groups) return;
  const spec = BATCH_SPEC[key];
  const batching = Boolean(spec && Array.isArray(a?.[spec.key]) && a[spec.key].length > 0);
  const perItem = new Set(batching ? PER_ITEM_ARGS[key] || [] : []);
  const present = (k) => a[k] !== undefined && a[k] !== null && String(a[k]).trim() !== '';
  for (const group of groups) {
    if (group.some(present)) continue;
    if (group.some((k) => perItem.has(k))) continue;
    const names = group.map((k) => `"${k}"`).join(' or ');
    throw new Error(`${tool} ${action}: missing parameter ${names} — pass it (or the matching batch list); see the tool description`);
  }
}

// Shape rules a batch item can violate. A batch runs item by item, so an item that
// fails halfway leaves the earlier ones behind; the model retries and duplicates them.
// These checks run before the round-trip, so a malformed batch changes nothing.
const PREFLIGHT = {
  'qgis_layout:add_item': (item, i) => {
    const it = typeof item === 'string' ? { kind: item } : item || {};
    const kind = String(it.kind ?? '');
    const at = `item ${i + 1}`;
    if (kind === 'scalebar' && (it.width != null || it.height != null)) {
      return `${at}: kind=scalebar sizes itself from the linked map (segments/units_per_segment) — drop width/height`;
    }
    if (kind === 'rect' && (it.width == null || it.height == null)) {
      return `${at}: kind=rect needs width and height in mm (e.g. 160 and 100)`;
    }
    return null;
  },
};

/** First problem in a batch, or null. Exported for tests. */
export function preflightBatch(tool, action, items) {
  const check = PREFLIGHT[tool + ':' + action];
  if (!check || !Array.isArray(items)) return null;
  for (let i = 0; i < items.length; i += 1) {
    const problem = check(items[i], i);
    if (problem) return problem;
  }
  return null;
}

export function batchItems(args, spec) {
  const raw = args?.[spec.key];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (spec.perPath) {
    // several layers into one `path` would overwrite each other -> per-layer file
    const p0 = args?.path;
    if (p0 && raw.length > 1) {
      const m = /^(.*?)(\.[^./\\]+)$/.exec(String(p0));
      const stem = m ? m[1] : String(p0);
      const ext = m ? m[2] : '';
      return raw.map((it) => {
        const name = typeof it === 'string' ? it : it?.layer;
        const safe = String(name ?? 'layer').replace(/[\\/:*?"<>|]/g, '_');
        const path = stem + '_' + safe + ext;
        return typeof it === 'string' ? { layer: it, path } : { ...it, path };
      });
    }
    return raw.slice();
  }
  if (!spec.formats) return raw.slice();
  const fmts = Array.isArray(args?.formats) && args.formats.length ? args.formats : null;
  if (!fmts) return raw.slice();
  const out = [];
  for (const it of raw) {
    for (const f of fmts) {
      out.push(typeof it === 'string' ? { [spec.assign]: it, format: f } : { ...it, format: f });
    }
  }
  return out;
}

export function batchBody(body, spec) {
  // The action body becomes a function so it keeps its own indentation no matter
  // what the loop scaffolding above it looks like. Inlining it directly was the
  // bug: any statement at the loop's 2-space level followed by the body's 4-space
  // lines swallowed the body into the previous `if`, or raised IndentationError.
  const wrapped = body
    .split('\n')
    .map((line) => (line.length ? '  ' + line : line))
    .join('\n');
  let setItem = '  P.update(_it_)';
  if (spec.assign === 'layout') {
    setItem = "  if isinstance(_it_, str):\n    P['layout'] = _it_\n    P['layout_name'] = _it_\n  else:\n    P.update(_it_)";
  } else if (spec.assign) {
    setItem = "  if isinstance(_it_, str):\n    P['" + spec.assign + "'] = _it_\n  else:\n    P.update(_it_)";
  }
  return `
def _one_():
${wrapped}
  return result

_items_ = P.get('${spec.key}') or []
_orig_ = dict(P)
_parts_ = []
for _it_ in _items_:
  P.clear()
  P.update(_orig_)
  P.pop('${spec.key}', None)
${setItem}
  if P.get('layout') is None and P.get('layout_name') is not None:
    P['layout'] = P['layout_name']
  if P.get('layout_name') is None and P.get('layout') is not None:
    P['layout_name'] = P['layout']
  _parts_.append(_one_())
result = {'count': len(_parts_), 'results': _parts_}
`;
}

/** PRELUDE + the call's parameters: every body — and execute_qgis_sync — starts from it. */
const preludeFor = (params) => PRELUDE.replace('__PARAMS__', JSON.stringify(JSON.stringify(params || {})));

/**
 * One word for "how did the job end", shaped like the harness's own job
 * outcomes (`completed | killed | failed`) instead of our internal statuses.
 * @param status - a task's `status` field.
 * @returns the matching outcome word.
 */
export function taskOutcome(status) {
  switch (String(status || '')) {
    case 'done': return 'completed'
    case 'error': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'running': return 'running'
    case 'queued': return 'queued'
    default: return String(status || 'unknown')
  }
}

export function registerConsolidatedTools(deps) {
  const { registerTool, run, runCmd, stringOutput, asText, jsonSafeString, scope, restartInstance } = deps;
  // `scope` is a getter in the live bundle (so the pill applies without a reload)
  // and a plain string in older builds / tests. Accept both.
  const activeScope = () => {
    const raw = typeof scope === 'function' ? scope() : scope;
    return SCOPES.includes(raw) ? raw : 'write';
  };
  // ---------------- core (synchronous pyeval + async task channel)
  registerTool({
    name: 'execute_qgis_sync',
    description: 'Run PyQGIS on the live project (main thread, sync). `code` is the only input; `prj` and `P` (this call\'s arguments) are in scope, set `result` to return a value. A failure comes back as "Type: body (hint)". Prefer the qgis_* tools: QGIS 3 names moved in 4, so rewrite a failed call instead of retrying.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'PyQGIS source; set `result` (or leave an expression last) to return a value' } },
      required: ['code'],
    },
    output: stringOutput,
    async execute(args, exec) {
      assertScope(activeScope(), 'execute_qgis_sync', '', args);
      // The docs promise `prj`, `P` and `_prj_extent()`; without the prelude this call
      // used to fail with `NameError: prj` and push the agent into writing its own .py.
      return asText(await run(preludeFor({}) + String(args?.code ?? ''), exec?.signal));
    },
  });

  registerTool({
    name: 'submit_qgis_async',
    description: 'Run pure Python on a worker thread. `code` for one task, `tasks=[{name,code}]` + `max_workers` (default 4, max 32) for a group; returns ids, poll with check_qgis_task. I/O and per-file work only - no QGIS objects, no `prj`, and poll `dsh_should_stop()` between files. Minutes-long calls belong here, not in execute_qgis_sync.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'single task body (pure Python)' },
        tasks: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'batch [{name, code}] submitted as one worker pool' },
        max_workers: { type: 'integer', description: 'pool size for tasks (default 4, max 32)' },
      },
      required: [],
    },
    output: stringOutput,
    async execute(args, exec) {
      assertScope(activeScope(), 'submit_qgis_async', '', args);
      const shardSource = [args?.code]
        .concat(Array.isArray(args?.tasks) ? args.tasks.map((t) => (t && t.code) || '') : [])
        .filter((c) => typeof c === 'string').join('\n');
      if (/initQgis\s*\(|QgsApplication\s*\(/.test(shardSource)) {
        throw new Error('submit_qgis_async runs worker threads inside the live instance: '
          + 'initQgis()/QgsApplication() there kills the instance and every later call fails with "no QGIS". '
          + 'QGIS objects belong on the main thread - use execute_qgis_sync or a structured qgis_* tool. '
          + 'Do not write a .py file and start a second QGIS either: this driver is the only supported path.');
      }
      const target = await deps.resolve();
      const group = Array.isArray(args?.tasks)
        ? args.tasks.filter((t) => t && typeof t.code === 'string' && t.code.trim())
        : [];
      if (group.length) {
        const workers = Math.max(1, Math.min(Number(args?.max_workers) || 4, 32));
        try {
          return asText(await deps.callRaw('/api/pyeval_group', 'POST', { tasks: group, max_workers: workers }, exec?.signal, target));
        } catch (e) {
          if (!/not found|unsupported endpoint|不支持/i.test(String(e && e.message))) throw e;
          // Older plugin without the group endpoint: submit each shard on its own.
          const started = await Promise.all(group.map(async (t) => {
            const r = await deps.callRaw('/api/pyeval_async', 'POST', { code: String(t.code) }, exec?.signal, target);
            return { name: t.name || '', ...(r && typeof r === 'object' ? r : { result: r }) };
          }));
          return asText({ tasks: started, count: started.length, note: 'plugin has no /api/pyeval_group; submitted individually (no concurrency cap)' });
        }
      }
      const code = String(args?.code ?? '');
      if (!code.trim()) throw new Error('give code or tasks');
      return asText(await deps.callRaw('/api/pyeval_async', 'POST', { code }, exec?.signal, target));
    },
  });

  registerTool({
    name: 'check_qgis_task',
    description: 'Poll or stop background tasks. `task_id` or `task_ids[]`; reads are snapshots, so polling twice is safe. `wait:true` blocks until every id finishes or `timeout_ms` (default 30000, max 180000) passes. Every task carries `outcome` (completed/failed/cancelled/running/queued) next to `status`. `cancel:true` stops instead: queued shards never run, a running one only sees `dsh_should_stop()`.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'batch of task ids' },
        wait: { type: 'boolean', description: 'block until every task is done/error/cancelled (or the timeout passes)' },
        timeout_ms: { type: 'integer', description: 'wait: how long to block (default 30000, max 180000)' },
        cancel: { type: 'boolean', description: 'cancel task_id/task_ids instead of polling' },
      },
      required: [],
    },
    output: stringOutput,
    async execute(args, exec) {
      const target = await deps.resolve();
      const many = Array.isArray(args?.task_ids) ? args.task_ids.filter((t) => typeof t === 'string' && t.trim()) : [];
      if (args?.cancel === true) {
        const ids = many.length ? many : (String(args?.task_id ?? '').trim() ? [String(args.task_id).trim()] : []);
        if (!ids.length) throw new Error('cancel needs task_id or task_ids');
        return asText(await deps.callRaw('/api/task_cancel', 'POST', { task_ids: ids }, exec?.signal, target));
      }
      const readOne = async (id) => {
        try {
          const r = await deps.callRaw('/api/tasks/' + encodeURIComponent(id), 'GET', null, exec?.signal, target);
          const one = r && typeof r === 'object' ? { task_id: id, ...r } : { task_id: id, result: r };
          return { ...one, outcome: taskOutcome(one.status) };
        } catch (e) {
          return { task_id: id, status: 'error', outcome: 'failed', error: e?.message || String(e) };
        }
      };
      const ids = many.length ? many : (String(args?.task_id ?? '').trim() ? [String(args.task_id).trim()] : []);
      if (!ids.length) throw new Error('give task_id or task_ids');
      if (args?.wait === true) {
        // ops_bash waits for a job the same way; a poll loop here keeps the
        // model from burning a round-trip per second of a long shard.
        const budget = Math.max(1000, Math.min(Number(args?.timeout_ms) || 30000, 180000));
        const start = Date.now();
        const terminal = (t) => ['done', 'error', 'cancelled'].includes(String(t?.status));
        let tasks = await Promise.all(ids.map(readOne));
        while (!tasks.every(terminal) && Date.now() - start < budget) {
          if (exec?.signal?.aborted) break;
          await new Promise((r) => setTimeout(r, 400));
          tasks = await Promise.all(ids.map(readOne));
        }
        return asText({
          timed_out: !tasks.every(terminal),
          waited_ms: Date.now() - start,
          count: tasks.length,
          tasks,
        });
      }
      if (many.length) return asText(await Promise.all(many.map(readOne)));
      return asText(await readOne(String(args.task_id).trim()));
    },
  });

  /**
   * Serialise project-changing calls behind the plugin's instance write lease.
   *
   * Why: two agents editing one QGIS do not crash each other, they silently
   * overwrite each other (one renames a layout while the other exports it).
   * A lease expires on its own, so a killed agent cannot lock the instance.
   */
  async function withWriteLock(tool, action, args, exec, fn) {
    if (!tool || !isMutating(tool, action, args)) return fn()
    const owner = lockOwner(exec)
    let got
    try {
      got = await runCmd('write_lock', { op: 'acquire', owner, ttl: 120,
        reason: `${tool} ${action}` }, exec?.signal)
    } catch (e) {
      // An older plugin has no gate; run unlocked instead of failing the call.
      if (/unknown|not found|unsupported|invalid type/i.test(String(e && e.message))) return fn()
      throw e
    }
    if (got && got.ok === false) {
      const held = Math.round((Number(got.held_ms) || 0) / 1000)
      throw new Error(`${tool} ${action}: another agent ("${got.owner}") has been writing to this QGIS instance for ${held}s — wait for it, then retry. Reads are never blocked.`)
    }
    try {
      return await fn()
    } finally {
      try { await runCmd('write_lock', { op: 'release', owner }, exec?.signal) } catch (e) { /* the lease expires on its own */ }
    }
  }

  // Exporting a real layout at 200+ dpi legitimately takes longer than the 10 s main-thread
  // default; without a bigger budget the agent escapes to a hand-written .py and a second
  // QGIS process, which is exactly what we do not want.
  const HEAVY_ACTIONS = new Set(['qgis_layout:export', 'qgis_layout:export_atlas', 'qgis_analysis:run']);
  const call = async (body, args, exec, opts, tool) => {
    // args may be frozen — work on a shallow copy.
    const a = args ? { ...args } : {};
    // `layout` and `layout_name` are used interchangeably by different bodies.
    if (a.layout === undefined && a.layout_name !== undefined) a.layout = a.layout_name;
    if (a.layout_name === undefined && a.layout !== undefined) a.layout_name = a.layout;
    // `extent: [xmin, ymin, xmax, ymax]` is the same box as the four numbers.
    if (Array.isArray(a.extent) && a.extent.length === 4 && a.xmin === undefined) {
      [a.xmin, a.ymin, a.xmax, a.ymax] = a.extent.map(Number);
    }
    // One layout + several formats is a batch too — otherwise the second format is
    // silently dropped (the single-layout body only reads `format`).
    if (tool === 'qgis_layout' && a.action === 'export' && !a.layouts && a.layout
      && Array.isArray(a.formats) && a.formats.length > 1) {
      a.layouts = [a.layout];
      delete a.layout;
      delete a.layout_name;
    }
    // `label_field` is the name `annotate` uses for the same argument.
    if (a.field === undefined && a.label_field !== undefined) a.field = a.label_field;
    if (tool) checkRequired(tool, String(a.action ?? ''), a);
    const scopeChecked = String(a.action ?? '');
    assertScope(activeScope(), tool, scopeChecked, a);
    const spec = tool ? BATCH_SPEC[tool + ':' + String(a.action ?? '')] : null;
    const items = spec ? batchItems(a, spec) : null;
    if (items) {
      const problem = preflightBatch(tool, String(a.action ?? ''), items);
      if (problem) throw new Error(`${tool} ${String(a.action ?? '')}: nothing was changed — ${problem}; fix the items and retry`);
    }
    const payload = items ? batchBody(body, spec) : body;
    if (items) a[spec.key] = items;
    const code = preludeFor(a) + payload;
    const action = String(a.action ?? '');
    const budget = HEAVY_ACTIONS.has(tool + ':' + action) ? 120 : undefined;
    return withWriteLock(tool, action, a, exec,
      async () => asText(await run(code, exec?.signal, budget ? { ...(opts || {}), budget } : opts)));
  };

  // ---------------- project
  registerTool({
    name: 'qgis_project',
    description: 'Project state. `info` needs nothing; `open`/`save_as` need `path`, `set_crs` needs `crs` or `crs_file`. A fresh headless instance is empty, so `info` first.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'open', 'save', 'save_as', 'set_crs'] },
        path: { type: 'string', description: 'open: .qgs/.qgz file; save_as: destination' },
        crs: { type: 'string' },
        crs_file: { type: 'string', description: 'CRS WKT from a .prj/.wkt file' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(PROJECT_BODY[args?.action], args, exec, undefined, 'qgis_project'); },
  });

  // ---------------- layer
  registerTool({
    name: 'qgis_layer',
    description: 'Layers. `list` needs nothing and returns {count,total,truncated,layers} (limit defaults to 200); one layer: `layer`, many: `layers[]` (add: `paths[]`). `export` writes `<temp>/<layer>.geojson` when `path` is omitted, and `raster_style` colours a raster band. A name that does not resolve is an error, not a no-op - list first. inline:true adds the image (costs every later request).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'info', 'fields', 'add', 'create', 'remove', 'visibility', 'crs', 'style', 'symbol', 'classify', 'style_multi', 'style_rule', 'labels', 'annotate', 'reproject', 'raster_style', 'export', 'export_table'] },
        layer: { type: 'string', description: 'single layer name (from action=list)' },
        layers: { type: 'array', items: { type: 'string' }, description: 'batch: one entry per layer' },
        paths: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'add: batch [{path,crs_file,name}]' },
        path: { type: 'string', description: 'add: one file to load. export: optional - omit and the file is written to <temp>/<layer>.geojson' },
        name: { type: 'string' },
        provider: { type: 'string', enum: ['auto', 'ogr', 'gdal', 'xyz', 'wms'] },
        geometry_type: { type: 'string', enum: ['point', 'line', 'polygon'] },
        crs: { type: 'string' },
        crs_file: { type: 'string', description: 'CRS WKT from a .prj/.wkt file' },
        fields: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'create: [{name,type}]' },
        visible: { type: 'boolean' },
        set_project: { type: 'boolean', description: 'also set project CRS' },
        color: { type: 'string' },
        opacity: { type: 'number' },
        field: { type: 'string' },
        mode: { type: 'string', enum: ['categorized', 'graduated'] },
        width: { type: 'number' },
        outline_color: { type: 'string' },
        outline_width: { type: 'number' },
        rules: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'style_rule: [{expression,label,color,width,size}]' },
        label_field: { type: 'string' },
        classes: { type: 'integer' },
        colors: { type: 'array', items: { type: 'string' }, description: 'palette #rrggbb (also raster_style colors)' },
        mode: { type: 'string', enum: ['pseudocolor', 'gray', 'rgb'], description: 'raster_style: pseudocolor (default), gray or rgb' },
        band: { type: 'integer', description: 'raster_style: band for pseudocolor/gray (default 1)' },
        bands: { type: 'array', items: { type: 'integer' }, description: 'raster_style mode=rgb: [red, green, blue] band numbers' },
        size: { type: 'number' },
        buffer_size: { type: 'number', description: 'halo in mm' },
        buffer_color: { type: 'string' },
        placement: { type: 'string', enum: ['around_point', 'over_point', 'line', 'horizontal', 'curved'] },
        enabled: { type: 'boolean' },
        target_crs: { type: 'string' },
        output_name: { type: 'string' },
        format: { type: 'string', enum: ['gpkg', 'geojson', 'shp', 'csv', 'json'], description: 'export: optional - defaults to the path extension, else geojson' },
        inline: { type: 'boolean', description: 'export: also return the image inline (costs every later request)' },
        limit: { type: 'integer', description: 'list: max rows to return (default 200, max 1000); check total and truncated' },
      },
      required: ['action'],
    },
    output: stringOutput,
    inlineImages: true,
    async execute(args, exec) { return call(LAYER_BODY[args?.action], args, exec, undefined, 'qgis_layer'); },
  });

  // ---------------- feature
  registerTool({
    name: 'qgis_feature',
    description: 'Features and fields. One layer: `layer`, many: `layers[]`, batch field changes: `specs[]` ({field,field_type,expression,new_name}). Writes and deletes need `confirm:true`. `query` returns {count,features[]} - ask for `fields` and a `limit`.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['query', 'table', 'select', 'select_by_location', 'selected', 'add', 'update', 'delete', 'field_add', 'field_calc', 'field_delete', 'field_rename'] },
        layer: { type: 'string', description: 'single layer name (from qgis_layer list)' },
        layers: { type: 'array', items: { type: 'string' }, description: 'batch: one entry per layer' },
        expression: { type: 'string' },
        fields: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
        include_geometry: { type: 'boolean' },
        sort_by: { type: 'string' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        offset: { type: 'integer' },
        mode: { type: 'string', enum: ['replace', 'add', 'remove', 'new'] },
        source_layer: { type: 'string' },
        predicate: { type: 'string', enum: ['intersects', 'within', 'contains', 'touches', 'overlaps', 'crosses', 'disjoint'] },
        distance: { type: 'number' },
        values: { type: 'object', additionalProperties: true },
        geometry_wkt: { type: 'string' },
        confirm: { type: 'boolean', description: 'true required for write/delete' },
        field: { type: 'string' },
        field_type: { type: 'string', enum: ['string', 'integer', 'double', 'date', 'datetime'] },
        new_name: { type: 'string' },
        specs: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'field_*: batch [{field,field_type,expression,new_name}]' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(FEATURE_BODY[args?.action], args, exec, undefined, 'qgis_feature'); },
  });

  // ---------------- layout
  registerTool({
    name: 'qgis_layout',
    description: 'Print layouts. `list` returns {count,total,truncated,layouts} (limit defaults to 200). `export` with nothing else exports the only layout to PNG; `create` needs `layout_name`; `add_item` needs `kind` (width defaults: map 160 mm, legend 60 mm); `update_item` takes `index` or `uuid`. Returns {format,file_path,image_path,size_bytes} per file; inline:true adds the PNG.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'info', 'add_item', 'update_item', 'legend_edit', 'align', 'export', 'export_atlas'] },
        layout: { type: 'string', description: 'layout name (from action=list). optional for export: omit when the project has one layout' },
        layout_name: { type: 'string' },
        page_width: { type: 'number' },
        page_height: { type: 'number' },
        index: { type: 'integer', description: 'update_item: index from action=info or add_item; it shifts as items are added, uuid never does' },
        uuid: { type: 'string', description: 'update_item: item uuid from add_item or info — alternative to index' },
        remove: { type: 'boolean' },
        kind: { type: 'string', enum: ['map', 'legend', 'scalebar', 'north_arrow', 'text', 'rect', 'swatch', 'graticule', 'table'] },
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'add_item: batch of item arg objects (one round-trip)' },
        updates: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'update_item: batch [{index,x,y,width,height,remove}]' },
        layouts: { type: 'array', items: { type: 'string' }, description: 'export/export_atlas: optional batch of layout names (one file per layout)' },
        formats: { type: 'array', items: { type: 'string', enum: ['png', 'pdf'] }, description: 'export: batch of formats (x layouts)' },
        background: { type: 'string', description: 'page/map background #rrggbb' },
        z: { type: 'number' },
        map: { type: 'integer', description: 'graticule: map item index' },
        step: { type: 'number', description: 'graticule step in degrees' },
        labels: { type: 'boolean', description: 'graticule degree labels' },
        label_size: { type: 'number' },
        shape: { type: 'string', enum: ['circle', 'line', 'polygon'] },
        length: { type: 'number', description: 'swatch line length' },
        line_width: { type: 'number' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        widths: { type: 'array', items: { type: 'number' } },
        row_height: { type: 'number' },
        header: { type: 'boolean' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        fit_layer: { type: 'string', description: 'extent from this layer, and the only layer drawn when `layers` is omitted' },
        layers: { type: 'array', items: { type: 'string' } },
        text: { type: 'string' },
        size: { type: 'number' },
        bold: { type: 'boolean' },
        color: { type: 'string' },
        outline_color: { type: 'string' },
        outline_width: { type: 'number' },
        title: { type: 'string' },
        op: { type: 'string', enum: ['style', 'columns', 'text', 'remove', 'title'] },
        columns: { type: 'integer' },
        item_text: { type: 'string' },
        align: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center_h', 'center_v', 'distribute_h', 'distribute_v'] },
        indexes: { type: 'array', items: { type: 'integer' }, description: 'item indexes (from action=info)' },
        segments: { type: 'number' },
        units_per_segment: { type: 'number', description: 'km per segment' },
        unit: { type: 'string' },
        family: { type: 'string' },
        format: { type: 'string', enum: ['png', 'pdf'], description: 'export: optional - defaults to png' },
        dpi: { type: 'integer', description: 'export raster resolution (default 96)' },
        path: { type: 'string', description: 'export/export_atlas: optional output file (a temp file is used otherwise)' },
        inline: { type: 'boolean', description: 'export/export_atlas: also return the PNG inline (costs every later request)' },
        limit: { type: 'integer', description: 'list: max rows to return (default 200, max 1000); check total and truncated' },
      },
      required: ['action'],
    },
    output: stringOutput,
    inlineImages: true,
    async execute(args, exec) { return call(LAYOUT_BODY[args?.action], args, exec, undefined, 'qgis_layout'); },
  });

  // ---------------- analysis
  registerTool({
    name: 'qgis_analysis',
    description: 'Processing. `list` needs nothing and reports every provider with its count; `help` needs `algorithm` and shows enum options and defaults; `run` needs `algorithm` + `params` and defaults `output` to a temp file (`runs[]` batches). Minutes-long algorithms belong in submit_qgis_async.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'help', 'run', 'zonal_stats', 'reclassify'] },
        keyword: { type: 'string', description: 'list: substring of the id or display name' },
        provider: { type: 'string', description: 'list: native|grass|gdal|qgis|pdal (see providers in the result)' },
        limit: { type: 'integer', description: 'list: max algorithms to return (default 200, max 1000)' },
        algorithm: { type: 'string' },
        params: { type: 'object', additionalProperties: true, description: 'algorithm params (see action=help)' },
        raster: { type: 'string' },
        band: { type: 'integer' },
        prefix: { type: 'string' },
        table: { type: 'array', items: { type: 'number' } },
        output: { type: 'string' },
        runs: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'run: batch [{algorithm,params}] executed in one call' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(ANALYSIS_BODY[args?.action], args, exec, undefined, 'qgis_analysis'); },
  });

  // ---------------- map (GUI-only canvas ops + offscreen render)
  registerTool({
    name: 'qgis_map',
    deferLoading: true,
    description: 'Map canvas. `render` needs nothing (1024x768) and returns `image_path`; pass `layer` to frame one layer; inline:true also shows it. `screenshot`/`set_extent`/`zoom_to_layer` drive the live window and stop with "needs a GUI session".',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['render', 'screenshot', 'set_extent', 'zoom_to_layer'] },
        width: { type: 'integer' },
        height: { type: 'integer' },
        target: { type: 'string', enum: ['canvas', 'mainwindow'] },
        extent: { type: 'array', items: { type: 'number' }, description: '[xmin,ymin,xmax,ymax] — same as the four numbers below, in `crs`' },
        xmin: { type: 'number' }, ymin: { type: 'number' },
        xmax: { type: 'number' }, ymax: { type: 'number' },
        crs: { type: 'string' },
        crs_file: { type: 'string', description: 'CRS WKT from a .prj/.wkt file' },
        layer: { type: 'string', description: 'render: frame this layer alone (otherwise the extent of every layer decides the view)' },
        inline: { type: 'boolean', description: 'screenshot/render: also return the image inline (costs every later request)' },
      },
      required: ['action'],
    },
    output: stringOutput,
    inlineImages: true,
    async execute(args, exec) {
      if (args?.action === 'screenshot') {
        const target = args?.target || 'canvas'
        const out = await runCmd('screenshot', { target }, exec?.signal)
        const p = typeof out === 'string' ? out : (out && (out.image_path || out.path)) || null
        return JSON.stringify({
          target,
          image_path: p,
          hint: 'image_path 是截取的 PNG；inline:true 时直接内联，否则用 read_image 查看',
        }, null, 2)
      }
      const a = args?.action;
      const gui = a === 'set_extent' || a === 'zoom_to_layer' || a === 'screenshot';
      return call(MAP_BODY[a], args, exec, gui ? { gui: true } : undefined, 'qgis_map');
    },
  });

  // ---------------- plugin / diagnostics
  registerTool({
    name: 'qgis_plugin',
    deferLoading: true,
    description: 'Session control. `status` needs nothing; `log` reads the audit back (op tail/error/slow, `limit`, `date`); `lock` shows or takes the write lease mutating tools take by themselves; `restart` kills the wedged process and the next call starts a fresh one - the only recovery (unsaved edits are lost).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'lock', 'log', 'restart'] },
        op: { type: 'string', description: 'lock: acquire/release/status; log: tail/error/slow',
          enum: ['acquire', 'release', 'status', 'tail', 'error', 'slow'] },
        limit: { type: 'integer', description: 'log: how many records (default 20, max 200)' },
        date: { type: 'string', description: 'log: YYYY-MM-DD (default: the newest file; older rotated days are listed in dates)' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const a = args?.action;
      if (a === 'status') return asText(await runCmd('status', {}, exec?.signal));
      if (a === 'log') {
        return asText(await runCmd('audit', { op: args?.op || 'tail', limit: args?.limit || 20, day: args?.date }, exec?.signal));
      }
      if (a === 'lock') {
        return asText(await runCmd('write_lock', { op: args?.op || 'status', owner: lockOwner(exec), ttl: 120 }, exec?.signal));
      }
      if (a === 'restart') {
        assertScope(activeScope(), 'qgis_plugin', 'restart', args);
        if (typeof restartInstance !== 'function') throw new Error('restart: this bundle build cannot stop the instance');
        return asText(restartInstance());
      }
      return asText(await runCmd('status', {}, exec?.signal));
    },
  });
}
