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
    QgsCoordinateReferenceSystem, QgsCoordinateTransform, QgsFeatureRequest, QgsFeature,
    QgsGeometry, QgsField, QgsPrintLayout, QgsLayoutItem, QgsLayoutItemMap, QgsLayoutItemMapGrid,
    QgsLayoutItemLabel, QgsLayoutItemLegend, QgsLayoutItemScaleBar, QgsLayoutItemPicture,
    QgsLayoutItemShape, QgsLayoutPoint, QgsLayoutSize, QgsUnitTypes, QgsLayoutExporter,
    QgsFillSymbol, QgsLineSymbol, QgsMarkerSymbol, QgsSingleSymbolRenderer, QgsPalLayerSettings,
    QgsTextFormat, QgsVectorLayerSimpleLabeling, QgsTextBufferSettings, QgsLegendStyle,
    QgsCategorizedSymbolRenderer, QgsGraduatedSymbolRenderer, QgsRendererRange, QgsRuleBasedRenderer,
    QgsRendererCategory, QgsRectangle, QgsMapSettings, QgsMapRendererCustomPainterJob, QgsPointXY, Qgis)
from qgis.PyQt.QtGui import QColor, QFont, QImage, QPainter
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
        if e.isEmpty():
            continue
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
def _publish(src, ext):
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
result = [{'id': l.id(), 'name': l.name(),
           'type': 'Vector' if l.type() == 0 else 'Raster',
           'crs': l.crs().authid() or l.crs().description(),
           'feature_count': l.featureCount() if hasattr(l, 'featureCount') else None} for l in prj.mapLayers().values()]`,
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
fmt = (P.get('format') or os.path.splitext(P['path'])[1].lstrip('.').lower() or 'gpkg')
driver = {'gpkg': 'GPKG', 'geojson': 'GeoJSON', 'shp': 'ESRI Shapefile', 'csv': 'CSV'}.get(fmt)
if not driver:
    raise ValueError('unsupported format: ' + fmt)
path = P['path']
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
result = {'layer': mem.name(), 'features': len(feats), 'label_field': label_field}`

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
  list: `result = [l.name() for l in prj.layoutManager().layouts()]`,
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
        raise ValueError('kind=map requires width')
    m = QgsLayoutItemMap(lay)
    lay.addLayoutItem(m)
    m.attemptMove(QgsLayoutPoint(x, y, MM()))
    fit = P.get('fit_layer')
    target = L(fit) if fit else (layers[0] if layers else None)
    if target is not None:
        e = target.extent()
        if h is None:
            h = float(w) / (e.width() / e.height())
        m.attemptResize(QgsLayoutSize(float(w), float(h), MM()))
        m.setCrs(target.crs())
    else:
        if h is None:
            h = float(w) * 0.6
        m.attemptResize(QgsLayoutSize(float(w), float(h), MM()))
    m.setBackgroundEnabled(True)
    m.setBackgroundColor(QColor(P.get('background') or '#ffffff'))
    if layers:
        m.setLayers(layers)
        m.setKeepLayerSet(True)
    if target is not None:
        m.zoomToExtent(target.extent())
    m.invalidateCache()
    item = m
elif kind == 'legend':
    if w is None:
        raise ValueError('kind=legend requires width')
    lg = QgsLayoutItemLegend(lay)
    base = first_map(lay)
    if base is not None:
        lg.setLinkedMap(base)
    _legend_title = P.get('title') or '图例'
    lg.setAutoUpdateModel(False)
    lay.addLayoutItem(lg)
    lg.attemptMove(QgsLayoutPoint(x, y, MM()))
    root = lg.model().rootGroup()
    for ch in list(root.children()):
        root.removeChildNode(ch)
    for lyr in layers:
        root.addLayer(lyr)
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
        raise ValueError('kind=rect requires width and height')
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
result = {'layout': lay.name(), 'kind': kind, 'rect': rect}`,
  update_item: `
lay = LAYOUT(P['layout'])
items = [it for it in lay.items() if isinstance(it, QgsLayoutItem)]
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
lay = LAYOUT(P['layout_name'])
fmt = (P.get('format') or 'png').lower()
if fmt == 'pdf':
    import tempfile
    if P.get('path'):
        path = P['path']
    else:
        fd, path = tempfile.mkstemp(suffix='.pdf')
        os.close(fd)
        os.remove(path)
    for _it in lay.items():
        try:
            if isinstance(_it, QgsLayoutItemMap):
                _it.invalidateCache()
        except Exception:
            pass
    lay.refresh()
    st = QgsLayoutExporter.PdfExportSettings()
    r = QgsLayoutExporter(lay).exportToPdf(path, st)
    if r != 0 or not os.path.exists(path):
        raise RuntimeError('layout pdf export failed (result %s)' % r)
    fd2, png = tempfile.mkstemp(suffix='.png'); os.close(fd2); os.remove(png)
    st2 = QgsLayoutExporter.ImageExportSettings()
    st2.dpi = int(P.get('dpi') or 300)
    r2 = QgsLayoutExporter(lay).exportToImage(png, st2)
    result = {'format': 'pdf', 'result': r, 'size_bytes': os.path.getsize(path),
              'file_path': path if P.get('path') else _publish(path, 'pdf'),
              'image_path': _publish(png, 'png') if r2 == 0 and os.path.exists(png) else None,
              'hint': 'image_path 是 PNG 预览（用 read_image 看）；file_path 是交付用 PDF'}
else:
    import base64, tempfile
    for _it in lay.items():
        try:
            if isinstance(_it, QgsLayoutItemMap):
                _it.invalidateCache()
        except Exception:
            pass
    lay.refresh()
    st = QgsLayoutExporter.ImageExportSettings()
    st.dpi = int(P.get('dpi') or 300)
    fd, path = tempfile.mkstemp(suffix='.png'); os.close(fd)
    os.remove(path)
    r = QgsLayoutExporter(lay).exportToImage(path, st)
    if r != 0 or not os.path.exists(path):
        raise RuntimeError('layout export failed (result %s)' % r)
    result = {'format': 'png', 'result': r, 'size_bytes': os.path.getsize(path),
              'image_path': _publish(path, 'png'),
              'hint': '使用 read_image 工具查看该图片路径'}`,
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
    for ch in list(root.children()):
        if ch.name() == target:
            root.removeChildNode(ch)
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
ms.setLayers([l for l in prj.layerTreeRoot().layerOrder()])
ms.setDestinationCrs(prj.crs())
_e = _prj_extent()
if _e is None:
    raise RuntimeError('project has no layer extent to render')
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
reg = QgsApplication.processingRegistry()
if reg.algorithms() == [] or True:
    from qgis.analysis import QgsNativeAlgorithms
    try:
        reg.addProvider(QgsNativeAlgorithms())
    except Exception:
        pass
algs = []
for a in reg.algorithms():
    if kw and kw not in a.id().lower() and kw not in a.displayName().lower():
        continue
    algs.append({'id': a.id(), 'name': a.displayName()})
    if len(algs) >= 200:
        break
result = {'count': len(algs), 'algorithms': algs}`,
  help: `
reg = QgsApplication.processingRegistry()
alg = reg.algorithmById(P['algorithm'])
if alg is None:
    raise ValueError('algorithm not found: ' + P['algorithm'])
params = []
for p in alg.parameterDefinitions():
    params.append({'name': p.name(), 'type': p.type(), 'optional': bool(p.flags() & 8),
                   'description': p.description()})
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
# fill missing OUTPUT sinks so the caller does not have to know they exist
for pdef in ad.parameterDefinitions():
    n = pdef.name()
    if n in mapped:
        continue
    try:
        optional = bool(pdef.flags() & 8)
    except Exception:
        optional = False
    if optional:
        continue
    if n.upper().startswith('OUTPUT'):
        mapped[n] = 'memory:'
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
result = {'algorithm': alg, 'outputs': clean, 'added_layers': added}`,
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

export function registerConsolidatedTools(deps) {
  const { registerTool, run, runCmd, stringOutput, asText, jsonSafeString } = deps;
  // ---------------- core (synchronous pyeval + async task channel)
  registerTool({
    name: 'execute_qgis_sync',
    description: 'Run PyQGIS on the QGIS main thread (sync, <3s). Returns last expression or `result`.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
    output: stringOutput,
    async execute(args, exec) {
      return asText(await run(String(args?.code ?? ''), exec?.signal));
    },
  });

  registerTool({
    name: 'submit_qgis_async',
    description: 'Run Python on a worker thread (no QGIS objects). Returns task_id; poll with check_qgis_task.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const target = await deps.resolve();
      return asText(await deps.callRaw('/api/pyeval_async', 'POST', { code: String(args?.code ?? '') }, exec?.signal, target));
    },
  });

  registerTool({
    name: 'check_qgis_task',
    description: 'Poll a task from submit_qgis_async. done/error is evicted after the first read.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const target = await deps.resolve();
      return asText(await deps.callRaw('/api/tasks/' + encodeURIComponent(String(args?.task_id ?? '')), 'GET', null, exec?.signal, target));
    },
  });

  // Batch: one tool call = one pyeval round-trip even for N entries.
  // A per-tool `action` spec decides which array key batches and where a string
  // entry is assigned (e.g. layers: ["A","B"] -> P['layer'] = "A" / "B").
  const BATCH_SPEC = {
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

  function batchItems(args, spec) {
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

  function batchBody(body, spec) {
    const indented = body
      .split('\n')
      .map((line) => (line.length ? '    ' + line : line))
      .join('\n');
    let setItem = '    P.update(_it_)';
    if (spec.assign === 'layout') {
      setItem = "    if isinstance(_it_, str):\n        P['layout'] = _it_\n        P['layout_name'] = _it_\n    else:\n        P.update(_it_)";
    } else if (spec.assign) {
      setItem = "    if isinstance(_it_, str):\n        P['" + spec.assign + "'] = _it_\n    else:\n        P.update(_it_)";
    }
    return `
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
${indented}
    _parts_.append(result)
result = {'count': len(_parts_), 'results': _parts_}
`;
  }

  const call = async (body, args, exec, opts, tool) => {
    // args may be frozen — work on a shallow copy.
    const a = args ? { ...args } : {};
    // `layout` and `layout_name` are used interchangeably by different bodies.
    if (a.layout === undefined && a.layout_name !== undefined) a.layout = a.layout_name;
    if (a.layout_name === undefined && a.layout !== undefined) a.layout_name = a.layout;
    const spec = tool ? BATCH_SPEC[tool + ':' + String(a.action ?? '')] : null;
    const items = spec ? batchItems(a, spec) : null;
    const payload = items ? batchBody(body, spec) : body;
    if (items) a[spec.key] = items;
    const code = PRELUDE.replace('__PARAMS__', JSON.stringify(JSON.stringify(a))) + payload;
    return asText(await run(code, exec?.signal, opts));
  };

  // ---------------- project
  registerTool({
    name: 'qgis_project',
    description: 'Project: info/open/save/save_as/set_crs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'open', 'save', 'save_as', 'set_crs'] },
        path: { type: 'string' },
        crs: { type: 'string' },
        crs_file: { type: 'string', description: 'read CRS WKT from this .prj/.wkt file' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(PROJECT_BODY[args?.action], args, exec, undefined, 'qgis_project'); },
  });

  // ---------------- layer
  registerTool({
    name: 'qgis_layer',
    description: 'Layers: list/info/fields/add/create/remove/visibility/crs/style/symbol/classify/style_multi/style_rule/labels/annotate/reproject/export/export_table. Batch: paths[] for add, layers[] for style/symbol/classify/export.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'info', 'fields', 'add', 'create', 'remove', 'visibility', 'crs', 'style', 'symbol', 'classify', 'style_multi', 'style_rule', 'labels', 'annotate', 'reproject', 'export', 'export_table'] },
        layer: { type: 'string' },
        layers: { type: 'array', items: { type: 'string' }, description: 'style/symbol/classify/export: batch of layer names (one round-trip)' },
        paths: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'add: batch [{path,crs_file,name}]' },
        path: { type: 'string' },
        name: { type: 'string' },
        provider: { type: 'string', enum: ['auto', 'ogr', 'gdal', 'xyz', 'wms'] },
        geometry_type: { type: 'string', enum: ['point', 'line', 'polygon'] },
        crs: { type: 'string' },
        crs_file: { type: 'string', description: 'read CRS WKT from this .prj/.wkt file' },
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
        colors: { type: 'array', items: { type: 'string' }, description: 'palette #rrggbb' },
        size: { type: 'number' },
        buffer_size: { type: 'number', description: 'label halo (mm)' },
        buffer_color: { type: 'string' },
        placement: { type: 'string', enum: ['around_point', 'over_point', 'line', 'horizontal', 'curved'] },
        enabled: { type: 'boolean' },
        target_crs: { type: 'string' },
        output_name: { type: 'string' },
        format: { type: 'string', enum: ['gpkg', 'geojson', 'shp', 'csv', 'json'] },
        inline: { type: 'boolean', description: 'export: also return the rendered map preview inline (costs request size on every later turn)' },
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
    description: 'Features/fields: query/table/select/select_by_location/selected/add/update/delete/field_add/field_calc/field_delete/field_rename. Batch: layers[] for query/select/update/delete, specs[] for field_*.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['query', 'table', 'select', 'select_by_location', 'selected', 'add', 'update', 'delete', 'field_add', 'field_calc', 'field_delete', 'field_rename'] },
        layer: { type: 'string' },
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
    description: 'Layouts: list/create/info/add_item/update_item/legend_edit/align/export/export_atlas. Batch: items[] add_item, updates[] update_item, layouts[]+formats[] export.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'info', 'add_item', 'update_item', 'legend_edit', 'align', 'export', 'export_atlas'] },
        layout: { type: 'string' },
        layout_name: { type: 'string' },
        page_width: { type: 'number' },
        page_height: { type: 'number' },
        index: { type: 'integer' },
        remove: { type: 'boolean' },
        kind: { type: 'string', enum: ['map', 'legend', 'scalebar', 'north_arrow', 'text', 'rect', 'swatch', 'graticule', 'table'] },
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'add_item: batch of item arg objects (one round-trip)' },
        updates: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'update_item: batch [{index,x,y,width,height,remove}]' },
        layouts: { type: 'array', items: { type: 'string' }, description: 'export/export_atlas: batch of layout names' },
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
        fit_layer: { type: 'string', description: 'map extent from this layer' },
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
        format: { type: 'string', enum: ['png', 'pdf'] },
        dpi: { type: 'integer' },
        path: { type: 'string' },
        inline: { type: 'boolean', description: 'export/export_atlas: also return the PNG preview as an inline image the model can see (one attachment per result; costs request size on every later turn)' },
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
    description: 'Processing: list/help/run, zonal_stats, reclassify. Batch: runs[] for run.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'help', 'run', 'zonal_stats', 'reclassify'] },
        keyword: { type: 'string' },
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
    description: 'Map: render/screenshot/set_extent/zoom_to_layer (last two need GUI).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['render', 'screenshot', 'set_extent', 'zoom_to_layer'] },
        width: { type: 'integer' },
        height: { type: 'integer' },
        target: { type: 'string', enum: ['canvas', 'mainwindow'] },
        xmin: { type: 'number' }, ymin: { type: 'number' },
        xmax: { type: 'number' }, ymax: { type: 'number' },
        crs: { type: 'string' },
        crs_file: { type: 'string', description: 'read CRS WKT from this .prj/.wkt file' },
        layer: { type: 'string' },
        inline: { type: 'boolean', description: 'screenshot/render: also return the captured image inline so the model can inspect it (costs request size on every later turn)' },
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
    description: 'Plugin: status/describe/open/reload/bridge/instruction.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'describe', 'open', 'reload', 'bridge', 'instruction'] },
        plugin_id: { type: 'string' },
        method: { type: 'string' },
        args: { type: 'array', items: {} },
        op: { type: 'string', enum: ['list', 'read', 'save', 'delete'] },
        kind: { type: 'string', enum: ['agents', 'skills', 'prompts'] },
        id: { type: 'string' },
        name: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const a = args?.action;
      if (a === 'status') return asText(await runCmd('status', {}, exec?.signal));
      if (a === 'describe') return asText(await runCmd('describe_plugins', {}, exec?.signal));
      if (a === 'open') return asText(await runCmd('open_plugin', { plugin_id: args?.plugin_id || 'dsh_qgis_driver' }, exec?.signal));
      if (a === 'reload') return asText(await runCmd('reload_plugin', { plugin_id: args?.plugin_id || 'dsh_qgis_driver' }, exec?.signal));
      if (a === 'bridge') return asText(await runCmd('bridge_call', { method: args?.method, plugin_id: args?.plugin_id, args: args?.args || [] }, exec?.signal));
      return asText(await runCmd('instruction', {
        op: args?.op || 'list', kind: args?.kind || 'skills',
        id: args?.id, name: args?.name, text: args?.text,
      }, exec?.signal));
    },
  });
}
