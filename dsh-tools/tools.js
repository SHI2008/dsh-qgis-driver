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
    QgsGeometry, QgsField, QgsPrintLayout, QgsLayoutItem, QgsLayoutItemMap,
    QgsLayoutItemLabel, QgsLayoutItemLegend, QgsLayoutItemScaleBar, QgsLayoutItemPicture,
    QgsLayoutItemShape, QgsLayoutPoint, QgsLayoutSize, QgsUnitTypes, QgsLayoutExporter,
    QgsFillSymbol, QgsLineSymbol, QgsMarkerSymbol, QgsSingleSymbolRenderer, QgsPalLayerSettings,
    QgsTextFormat, QgsVectorLayerSimpleLabeling, QgsTextBufferSettings, QgsLegendStyle,
    QgsCategorizedSymbolRenderer, QgsGraduatedSymbolRenderer, QgsRendererRange,
    QgsRendererCategory, QgsRectangle, QgsMapSettings, QgsMapRendererCustomPainterJob, Qgis)
from qgis.PyQt.QtGui import QColor, QFont, QImage, QPainter
from qgis.PyQt.QtCore import QSize
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
        ext = QgsRectangle(e) if ext is None else ext.combineExtentWith(e)
    return None if ext is None or ext.isEmpty() else ext
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

def L(name):
    ls = prj.mapLayersByName(name)
    if not ls:
        raise ValueError('layer not found: ' + str(name))
    return ls[0]

def MM():
    return QgsUnitTypes.LayoutMillimeters

def LAYOUT(name):
    lay = prj.layoutManager().layoutByName(name)
    if lay is None:
        raise ValueError('layout not found: ' + str(name))
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
    raise ValueError('工程尚未保存过，请提供 path')
result = {'saved': bool(prj.write(path)), 'file': path}`,
  set_crs: `
crs = QgsCoordinateReferenceSystem(P['crs'])
if not crs.isValid():
    raise ValueError('invalid crs: ' + str(P.get('crs')))
prj.setCrs(crs)
result = {'crs': crs.authid() or crs.description()}`,
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
sym = l.renderer().symbol() if l.renderer() else None
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
result = {'path': path, 'format': fmt, 'bytes': os.path.getsize(path)}`,
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
    result = {'path': path, 'rows': len(rows), 'columns': fields}
elif fmt == 'json':
    result = {'fields': fields, 'rows': rows[:10000], 'truncated': len(rows) > 10000}
else:
    result = {'fields': fields, 'rows': len(rows), 'hint': '未指定 path，csv 需要写入文件'}`,
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
    raise ValueError('必须传 confirm=true 确认写操作')
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
    raise ValueError('必须传 confirm=true 确认删除')
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
types = {'string': 10, 'integer': 2, 'double': 6, 'date': 14, 'datetime': 16}
ftype = types.get(P.get('field_type') or 'double', 6)
l.startEditing()
l.dataProvider().addAttributes([QgsField(P['field'], ftype)])
l.updateFields()
l.commitChanges()
result = {'layer': l.name(), 'field': P['field'], 'fields': [f.name() for f in l.fields()]}`,
  field_calc: `
l = L(P['layer'])
if not P.get('expression'):
    raise ValueError('必须提供 expression')
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
result = {'layer': l.name(), 'fields': [f.name() for f in l.fields()]}`,
  field_rename: `
l = L(P['layer'])
if not P.get('new_name'):
    raise ValueError('必须提供 new_name')
idx = l.fields().indexOf(P['field'])
if idx < 0:
    raise ValueError('field not found: ' + P['field'])
l.startEditing()
l.renameAttribute(idx, P['new_name'])
l.commitChanges()
result = {'layer': l.name(), 'fields': [f.name() for f in l.fields()]}`,
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
layers = [L(n) for n in (P.get('layers') or [])]
if kind == 'map':
    if w is None:
        raise ValueError('kind=map 需要 width')
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
    if layers:
        m.setLayers(layers); m.setKeepLayerSet(True)
    if target is not None:
        m.zoomToExtent(target.extent())
    m.invalidateCache()
    item = m
elif kind == 'legend':
    if w is None:
        raise ValueError('kind=legend 需要 width')
    lg = QgsLayoutItemLegend(lay)
    base = first_map(lay)
    if base is not None:
        lg.setLinkedMap(base)
    lg.setTitle(P.get('title') or '图例')
    lg.setAutoUpdateModel(False)
    lay.addLayoutItem(lg)
    lg.attemptMove(QgsLayoutPoint(x, y, MM()))
    lg.attemptResize(QgsLayoutSize(float(w), float(h or 30), MM()))
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
        raise ValueError('kind=text 需要 text')
    t = QgsLayoutItemLabel(lay)
    t.setText(P['text'])
    f = QFont(P.get('family') or 'Microsoft YaHei', int(P.get('size') or 10))
    f.setBold(bool(P.get('bold')))
    t.setFont(f)
    t.setFontColor(QColor(P.get('color') or '#1a1a1a'))
    t.adjustSizeToText()
    lay.addLayoutItem(t)
    t.attemptMove(QgsLayoutPoint(x, y, MM()))
    item = t
elif kind == 'rect':
    if w is None or h is None:
        raise ValueError('kind=rect 需要 width 与 height')
    s = QgsLayoutItemShape(lay)
    s.setShapeType(QgsLayoutItemShape.Rectangle)
    sym = QgsFillSymbol.createSimple({'color': P.get('color') or '#ffffff',
                                      'outline_color': P.get('outline_color') or 'transparent',
                                      'outline_width': str(P.get('outline_width') or 0)})
    s.setSymbol(sym)
    lay.addLayoutItem(s)
    s.attemptMove(QgsLayoutPoint(x, y, MM()))
    s.attemptResize(QgsLayoutSize(float(w), float(h), MM()))
    item = s
else:
    raise ValueError('unknown kind: ' + str(kind))
result = {'layout': lay.name(), 'kind': kind, 'rect': rect_of(item)}`,
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
    st = QgsLayoutExporter.PdfExportSettings()
    r = QgsLayoutExporter(lay).exportToPdf(P['path'], st) if P.get('path') else None
    result = {'format': 'pdf', 'result': r}
else:
    import base64, tempfile
    st = QgsLayoutExporter.ImageExportSettings()
    st.dpi = int(P.get('dpi') or 300)
    fd, path = tempfile.mkstemp(suffix='.png'); os.close(fd)
    r = QgsLayoutExporter(lay).exportToImage(path, st)
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
if st is None:
    r = QgsLayoutExporter(lay).exportToPdf(path, QgsLayoutExporter.PdfExportSettings())
    result = {'format': 'pdf', 'pages': n, 'result': r, 'size_bytes': os.path.getsize(path),
              'file_path': _publish(path, 'pdf')}
else:
    st.dpi = int(P.get('dpi') or 300)
    r = QgsLayoutExporter(lay).exportToImage(path, st)
    result = {'format': 'png', 'pages': n, 'result': r, 'size_bytes': os.path.getsize(path),
              'image_path': _publish(path, 'png'),
              'hint': '使用 read_image 工具查看该图片路径'}`,
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
    raise RuntimeError('no map canvas: 该操作需要在 QGIS GUI 会话中使用')
rect = QgsRectangle(float(P['xmin']), float(P['ymin']), float(P['xmax']), float(P['ymax']))
crs = QgsCoordinateReferenceSystem(P['crs']) if P.get('crs') else canvas.mapSettings().destinationCrs()
xf = QgsCoordinateTransform(crs, canvas.mapSettings().destinationCrs(), prj)
rect = xf.transformBoundingBox(rect)
canvas.setExtent(rect); canvas.refresh()
result = {'extent': [round(v, 1) for v in (rect.xMinimum(), rect.yMinimum(), rect.xMaximum(), rect.yMaximum())]}`,
  zoom_to_layer: `
canvas = list(iface.mapCanvases())[0] if iface is not None else None
if canvas is None:
    raise RuntimeError('no map canvas: 该操作需要在 QGIS GUI 会话中使用')
l = L(P['layer'])
xf = QgsCoordinateTransform(l.crs(), canvas.mapSettings().destinationCrs(), prj)
canvas.setExtent(xf.transformBoundingBox(l.extent())); canvas.refresh()
result = {'layer': l.name()}`,
  screenshot: `
canvas = list(iface.mapCanvases())[0] if iface is not None else None
target = P.get('target') or 'canvas'
if target == 'mainwindow':
    if iface is None:
        raise RuntimeError('no main window: 需要 QGIS GUI 会话')
    shot = iface.mainWindow().grab()
elif canvas is not None:
    shot = canvas.grab()
else:
    raise RuntimeError('no map canvas: 该操作需要在 QGIS GUI 会话中使用')
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
    from qgis.core import QgsNativeAlgorithms
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
params = P.get('params') or {}
mapped = {}
for k, v in params.items():
    if isinstance(v, str) and prj.mapLayersByName(v):
        mapped[k] = prj.mapLayersByName(v)[0]
    else:
        mapped[k] = v
out = processing.run(alg, mapped)
clean = {}
for k, v in (out or {}).items():
    if hasattr(v, 'source'):
        clean[k] = v.source()
    else:
        clean[k] = v
result = {'algorithm': alg, 'outputs': clean}`,
};

export function registerConsolidatedTools(deps) {
  const { registerTool, run, runCmd, stringOutput, asText, jsonSafeString } = deps;
  // ---------------- core (synchronous pyeval + async task channel)
  registerTool({
    name: 'execute_qgis_sync',
    description:
      '在 QGIS 主线程同步执行 PyQGIS 代码并返回结果（可访问 iface/QgsProject）。' +
      '只用于短任务（<3 秒），否则 QGIS 界面会卡死；耗时任务用 submit_qgis_async。',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python 代码；最后一个表达式或 result 变量会被返回。' } },
      required: ['code'],
    },
    output: stringOutput,
    async execute(args, exec) {
      return asText(await run(String(args?.code ?? ''), exec?.signal));
    },
  });

  registerTool({
    name: 'submit_qgis_async',
    description: '在后台线程异步执行 Python 代码，立即返回 task_id；之后用 check_qgis_task 轮询结果。后台环境不导入 qgis。',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python 代码（不能访问 QGIS 对象）。' } },
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
    description: '查询 submit_qgis_async 的任务状态；done/error 首次读取后即从缓存移除。',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'submit_qgis_async 返回的 task_id。' } },
      required: ['task_id'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const target = await deps.resolve();
      return asText(await deps.callRaw('/api/tasks/' + encodeURIComponent(String(args?.task_id ?? '')), 'GET', null, exec?.signal, target));
    },
  });

  const call = async (body, args, exec) => {
    const code = PRELUDE.replace('__PARAMS__', JSON.stringify(JSON.stringify(args || {}))) + body;
    return asText(await run(code, exec?.signal, args?.action === undefined ? undefined : undefined));
  };

  // ---------------- project
  registerTool({
    name: 'qgis_project',
    description:
      '工程级操作。action=info 返回文件/标题/CRS/范围/图层/版面；open 打开 .qgs/.qgz；' +
      'save 保存（未保存过需 path）；set_crs 设置工程坐标系（不重投影数据）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'open', 'save', 'set_crs'] },
        path: { type: 'string', description: 'open/save 的文件路径。' },
        crs: { type: 'string', description: 'set_crs 的目标坐标系（EPSG:xxxx）。' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(PROJECT_BODY[args?.action], args, exec); },
  });

  // ---------------- layer
  registerTool({
    name: 'qgis_layer',
    description:
      '图层操作（一个入口）。action=list 列出图层；info 元数据（矢量/栅格+波段统计）；fields 字段；' +
      'add 加载数据源（path/provider/name）；create 新建内存图层（geometry_type/crs/fields）；remove 移除；' +
      'visibility 显隐；crs 指定坐标系（CRS 为空会导致图层不渲染，必用）；style 颜色/透明度；' +
      'classify 分类或分级符号化；labels 按字段标注；reproject 重投影为新内存图层；' +
      'export 导出矢量文件（gpkg/geojson/shp/csv）；export_table 导出属性表（csv/json）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'info', 'fields', 'add', 'create', 'remove', 'visibility', 'crs', 'style', 'classify', 'labels', 'reproject', 'export', 'export_table'] },
        layer: { type: 'string', description: '图层名（除 list/add/create 外必填）。' },
        path: { type: 'string', description: 'add/export/export_table 的文件路径。' },
        name: { type: 'string', description: 'add 的图层名；create 的图层名。' },
        provider: { type: 'string', enum: ['auto', 'ogr', 'gdal', 'xyz', 'wms'], description: 'add 的数据源类型，默认 auto。' },
        geometry_type: { type: 'string', enum: ['point', 'line', 'polygon'], description: 'create 的几何类型。' },
        crs: { type: 'string', description: 'create/crs 的坐标系。' },
        fields: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'create 的字段 [{name,type}]。' },
        visible: { type: 'boolean', description: 'visibility 的目标可见性。' },
        set_project: { type: 'boolean', description: 'crs 时同时设为工程坐标系。' },
        color: { type: 'string', description: 'style/classify 的颜色（#rrggbb）。' },
        opacity: { type: 'number', description: 'style 的不透明度 0-1。' },
        field: { type: 'string', description: 'classify/labels 使用的字段。' },
        mode: { type: 'string', enum: ['categorized', 'graduated'], description: 'classify 模式。' },
        classes: { type: 'integer', description: 'classify graduated 级数（默认 5）。' },
        colors: { type: 'array', items: { type: 'string' }, description: 'classify 配色列表。' },
        size: { type: 'number', description: 'labels 字号（pt）。' },
        buffer_size: { type: 'number', description: 'labels 描边宽度（mm）。' },
        buffer_color: { type: 'string', description: 'labels 描边颜色。' },
        placement: { type: 'string', enum: ['around_point', 'over_point', 'line', 'horizontal', 'curved'], description: 'labels 放置方式。' },
        enabled: { type: 'boolean', description: 'labels=false 关闭标注。' },
        target_crs: { type: 'string', description: 'reproject 目标坐标系。' },
        output_name: { type: 'string', description: 'reproject 新图层名。' },
        format: { type: 'string', enum: ['gpkg', 'geojson', 'shp', 'csv', 'json'], description: 'export/export_table 格式。' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(LAYER_BODY[args?.action], args, exec); },
  });

  // ---------------- feature
  registerTool({
    name: 'qgis_feature',
    description:
      '要素与字段操作。action=query 按表达式查询；select 属性选择；select_by_location 空间选择' +
      '（intersects/within/contains/touches/overlaps/crosses/disjoint，可加缓冲距离）；selected 读已选；' +
      'add 新增要素（values/geometry_wkt）；update 批量改属性（需 confirm）；delete 批量删除（需 confirm）；' +
      'field_add / field_calc（expression）/ field_delete / field_rename（new_name）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['query', 'select', 'select_by_location', 'selected', 'add', 'update', 'delete', 'field_add', 'field_calc', 'field_delete', 'field_rename'] },
        layer: { type: 'string', description: '目标图层名（必填）。' },
        expression: { type: 'string', description: 'query/select/update/delete 的过滤表达式；field_calc 的计算表达式。' },
        fields: { type: 'array', items: { type: 'string' }, description: 'query 返回的字段。' },
        limit: { type: 'integer', description: 'query/selected 行数上限，或 update/delete 影响数量上限。' },
        include_geometry: { type: 'boolean', description: 'query 是否返回 WKT。' },
        mode: { type: 'string', enum: ['replace', 'add', 'remove', 'new'], description: 'select/select_by_location 的选择模式。' },
        source_layer: { type: 'string', description: 'select_by_location 的筛选依据图层。' },
        predicate: { type: 'string', enum: ['intersects', 'within', 'contains', 'touches', 'overlaps', 'crosses', 'disjoint'], description: 'select_by_location 谓词。' },
        distance: { type: 'number', description: 'select_by_location 缓冲距离（图层单位）。' },
        values: { type: 'object', description: 'add/update 的字段值映射。', additionalProperties: true },
        geometry_wkt: { type: 'string', description: 'add 的 WKT 几何。' },
        confirm: { type: 'boolean', description: 'update/delete 必须为 true。' },
        field: { type: 'string', description: 'field_add/calc/delete/rename 的字段名。' },
        field_type: { type: 'string', enum: ['string', 'integer', 'double', 'date', 'datetime'], description: 'field_add 的字段类型。' },
        new_name: { type: 'string', description: 'field_rename 的新字段名。' },
      },
      required: ['action', 'layer'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(FEATURE_BODY[args?.action], args, exec); },
  });

  // ---------------- layout
  registerTool({
    name: 'qgis_layout',
    description:
      '打印版面操作。action=list 列出；create 新建（layout_name，可选 page_width/page_height）；' +
      'info 看页面与要素（含 index）；add_item 加要素（kind=map/legend/scalebar/north_arrow/text/rect，' +
      '毫米坐标，map 可用 fit_layer 自动算长宽比）；update_item 移动/缩放/删除（按 index）；' +
      'export 导出 PNG/PDF；export_atlas 导出图集（需布局已启用 atlas）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'info', 'add_item', 'update_item', 'export', 'export_atlas'] },
        layout: { type: 'string', description: '版面名（info/add_item/update_item 必填）。' },
        layout_name: { type: 'string', description: 'create/export/export_atlas 的版面名。' },
        page_width: { type: 'number', description: 'create 的页宽（mm）。' },
        page_height: { type: 'number', description: 'create 的页高（mm）。' },
        index: { type: 'integer', description: 'update_item 的要素序号。' },
        remove: { type: 'boolean', description: 'update_item=true 删除该要素。' },
        kind: { type: 'string', enum: ['map', 'legend', 'scalebar', 'north_arrow', 'text', 'rect'], description: 'add_item 的要素类型。' },
        x: { type: 'number', description: '左上角 X（mm）。' },
        y: { type: 'number', description: '左上角 Y（mm）。' },
        width: { type: 'number', description: '宽（mm）。' },
        height: { type: 'number', description: '高（mm）。' },
        fit_layer: { type: 'string', description: 'map 按该图层范围定比例。' },
        layers: { type: 'array', items: { type: 'string' }, description: 'map 显示图层列表；legend 保留的图层。' },
        text: { type: 'string', description: 'text 内容。' },
        size: { type: 'number', description: 'text 字号 / north_arrow 尺寸。' },
        bold: { type: 'boolean', description: 'text 加粗。' },
        color: { type: 'string', description: 'text 字色 / rect 填充色。' },
        outline_color: { type: 'string', description: 'rect 边框色。' },
        outline_width: { type: 'number', description: 'rect 边框宽度。' },
        title: { type: 'string', description: 'legend 标题。' },
        segments: { type: 'number', description: 'scalebar 段数。' },
        units_per_segment: { type: 'number', description: 'scalebar 每段长度。' },
        unit: { type: 'string', description: 'scalebar 单位（km/m）。' },
        family: { type: 'string', description: '字体（默认 Microsoft YaHei）。' },
        format: { type: 'string', enum: ['png', 'pdf'], description: 'export 格式。' },
        dpi: { type: 'integer', description: 'export 的 DPI（默认 300）。' },
        path: { type: 'string', description: 'export pdf 的输出路径（可选）。' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(LAYOUT_BODY[args?.action], args, exec); },
  });

  // ---------------- analysis
  registerTool({
    name: 'qgis_analysis',
    description:
      '处理框架（空间分析）。action=list 列出算法（可按 keyword 过滤）；help 查算法参数；' +
      'run 执行算法（algorithm + params 对象，图层参数可传图层名）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'help', 'run'] },
        keyword: { type: 'string', description: 'list 的关键字过滤。' },
        algorithm: { type: 'string', description: 'help/run 的算法 id，如 native:buffer。' },
        params: { type: 'object', description: 'run 的算法参数。', additionalProperties: true },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) { return call(ANALYSIS_BODY[args?.action], args, exec); },
  });

  // ---------------- map (GUI-only canvas ops + offscreen render)
  registerTool({
    name: 'qgis_map',
    deferLoading: true,
    description:
      '地图视图与截图。action=render 离屏渲染项目全图返回 PNG；screenshot 截画布/主窗口（需 GUI）；' +
      'set_extent 设画布范围；zoom_to_layer 缩放到图层（需 GUI）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['render', 'screenshot', 'set_extent', 'zoom_to_layer'] },
        width: { type: 'integer', description: 'render 宽度（默认 800）。' },
        height: { type: 'integer', description: 'render 高度（默认 600）。' },
        target: { type: 'string', enum: ['canvas', 'mainwindow'], description: 'screenshot 目标。' },
        xmin: { type: 'number' }, ymin: { type: 'number' },
        xmax: { type: 'number' }, ymax: { type: 'number' },
        crs: { type: 'string', description: 'set_extent 的坐标系。' },
        layer: { type: 'string', description: 'zoom_to_layer 的图层名。' },
      },
      required: ['action'],
    },
    output: stringOutput,
    async execute(args, exec) {
      if (args?.action === 'screenshot') {
        const out = await runCmd('screenshot', { target: args?.target || 'canvas' }, exec?.signal);
        return asText(out);
      }
      return call(MAP_BODY[args?.action], args, exec);
    },
  });

  // ---------------- plugin / diagnostics
  registerTool({
    name: 'qgis_plugin',
    deferLoading: true,
    description:
      '插件与应用诊断。action=status 进程/端口/插件状态；describe 列出可调用插件的 bridge 能力；' +
      'open/reload 按 plugin_id 加载或热重载；bridge 调用插件 bridge 方法（method 可选 args）；' +
      'instruction 管理本地 AI 指令文件（op=list|read|save|delete，kind=agents|skills|prompts）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'describe', 'open', 'reload', 'bridge', 'instruction'] },
        plugin_id: { type: 'string', description: 'open/reload 的插件 id（默认 dsh_qgis_driver）。' },
        method: { type: 'string', description: 'bridge 的方法名。' },
        args: { type: 'array', items: {}, description: 'bridge 的位置参数。' },
        op: { type: 'string', enum: ['list', 'read', 'save', 'delete'], description: 'instruction 操作。' },
        kind: { type: 'string', enum: ['agents', 'skills', 'prompts'], description: 'instruction 类别。' },
        id: { type: 'string', description: 'instruction 的文件名（stem）。' },
        name: { type: 'string', description: 'instruction save 的文件名。' },
        text: { type: 'string', description: 'instruction save 的正文。' },
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
