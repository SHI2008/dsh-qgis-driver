// dsh-qgis-driver — DSH Host bundle.
// Exposes a running QGIS (dsh_qgis_driver plugin) as DSH tools over its REST API.
//
// Two connection modes:
//   1. Local discovery — newest ~/.qgis-live/<pid>-dsh_qgis_driver.json registry entry,
//      health-probed for liveness (uses the registry's host + Bearer session token).
//   2. Remote target — host + port + Key from cordis.patch.yml `config:` or the env
//      vars QGIS_LIVE_REMOTE_HOST / QGIS_LIVE_REMOTE_PORT / QGIS_LIVE_REMOTE_KEY
//      (the Key is the remote QGIS's QGIS_LIVE_API_KEY).
//
// Tools: execute_qgis_sync / submit_qgis_async / check_qgis_task (generic PyQGIS),
// plus dedicated GIS tools: qgis_list_layers / qgis_list_layouts / qgis_list_algorithms /
// qgis_run_processing / qgis_export_layout / qgis_render_map (image-returning).
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-qgis-driver'
export const inject = ['tools']

const REGISTRY_DIR = path.join(os.homedir(), '.qgis-live')
const HEALTH_TIMEOUT_MS = 2000

/** Resolve the remote target from `config` (cordis.patch.yml) or env vars. */
function resolveRemoteTarget(config) {
  const host = config?.host || process.env.QGIS_LIVE_REMOTE_HOST || ''
  const portRaw = config?.port ?? process.env.QGIS_LIVE_REMOTE_PORT
  const key = config?.key || process.env.QGIS_LIVE_REMOTE_KEY || ''
  if (!host && !portRaw) return null
  if (!host || !portRaw) {
    throw new Error('远程 QGIS 配置不完整：host 和 port 必须同时提供（QGIS_LIVE_REMOTE_HOST/PORT 或 config）')
  }
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`远程 QGIS 端口无效：${portRaw}`)
  }
  if (!key) {
    throw new Error('已配置远程 QGIS (host/port) 但缺少 Key（QGIS_LIVE_REMOTE_KEY 或 config.key）')
  }
  return { base: `http://${host}:${port}`, token: key }
}

/** Find a live QGIS instance: newest registry files first, health-probed. */
async function findActiveQgis() {
  let names
  try {
    names = fs.readdirSync(REGISTRY_DIR)
  } catch {
    throw new Error('未找到活跃的 dsh-qgis-driver 实例：~/.qgis-live 目录不存在')
  }
  const candidates = names
    .filter((n) => n.endsWith('-dsh_qgis_driver.json'))
    .map((n) => path.join(REGISTRY_DIR, n))
    .map((p) => {
      try { return { p, mtime: fs.statSync(p).mtimeMs } } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3)

  for (const { p } of candidates) {
    let reg
    try { reg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { continue }
    const host = reg.host || '127.0.0.1'
    const port = reg.http_port
    const token = reg.token
    if (!port || !token) continue
    try {
      const resp = await fetch(`http://${host}:${port}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      if (resp.status === 200) return { base: `http://${host}:${port}`, token }
      if (resp.status === 401) {
        throw new Error('QGIS 凭证已过期或无效（注册 token 与运行实例不一致）')
      }
    } catch (e) {
      // 401 is a hard failure; timeout/refused/other → try the next candidate.
      if (e instanceof Error && e.message.includes('凭证已过期')) throw e
      continue
    }
  }
  throw new Error(
    '未找到活跃的 dsh-qgis-driver 实例（请确认 QGIS 正在运行且 dsh_qgis_driver 插件已启动，' +
    '或配置远程连接 QGIS_LIVE_REMOTE_HOST/PORT/KEY）')
}

/** Call one REST endpoint and unwrap { result } / { error }. */
async function callQgis(route, method, body, signal, target) {
  const resp = await fetch(`${target.base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await resp.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: text || `HTTP ${resp.status}` } }
  if (resp.status === 401) throw new Error('QGIS 凭证已过期或无效（Key/token 不匹配）')
  if (data.error) {
    throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error))
  }
  return data.result
}

/** Normalize an arbitrary result value to text for the model. */
function asText(value) {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

/** Write base64 bytes to a fresh temp file and return its absolute path. */
function writeTempFile(base64, ext) {
  const dir = path.join(os.tmpdir(), 'dsh-qgis-driver')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `qgis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}

/** Embed a JS value as a Python dict/list via json.loads of a JSON string literal. */
function pyJson(value) {
  return `json.loads(${JSON.stringify(JSON.stringify(value === undefined ? {} : value))})`
}

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

export function apply(ctx, config = {}) {
  const disposers = []
  const remote = resolveRemoteTarget(config)

  /** Resolve the connection target (health-checked remote, or local discovery). */
  async function resolveTarget() {
    if (remote) {
      try {
        const resp = await fetch(`${remote.base}/api/health`, {
          headers: { Authorization: `Bearer ${remote.token}` },
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        })
        if (resp.status === 401) throw new Error('QGIS 凭证已过期或无效（Key 不匹配）')
        if (resp.status !== 200) throw new Error(`远程 QGIS 不可用：${remote.base}/api/health → HTTP ${resp.status}`)
      } catch (e) {
        if (e instanceof Error && e.message.includes('凭证')) throw e
        if (e instanceof Error && e.name === 'TimeoutError') throw new Error(`无法连接远程 QGIS：${remote.base}（超时）`)
        throw new Error(`无法连接远程 QGIS：${remote.base}（${e.message}）`)
      }
      return remote
    }
    return findActiveQgis()
  }

  /** Run one PyQGIS snippet synchronously (main thread) and unwrap its `result`. */
  async function runQgisSync(code, signal) {
    const target = await resolveTarget()
    return callQgis('/api/pyeval', 'POST', { code }, signal, target)
  }

  // ---- Generic PyQGIS tools ----

  disposers.push(ctx.tools.register({
    name: 'execute_qgis_sync',
    description:
      '在 QGIS 主线程同步执行一段轻量 Python 代码，可访问 iface、QgsProject 等完整 PyQGIS 对象。' +
      '严禁提交耗时超过 3 秒的代码，否则 QGIS 界面会永久冻结。' +
      '适合查询当前项目、图层、选中要素、表达式求值等快速操作。',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要在 QGIS 主线程执行的 Python 代码（同步，必须 < 3 秒）。将结果赋给 result 变量。',
        },
      },
      required: ['code'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const code = typeof args?.code === 'string' ? args.code : ''
      if (!code.trim()) throw new Error('参数 code 不能为空')
      const result = await runQgisSync(code, exec?.signal)
      return asText(result)
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'submit_qgis_async',
    description:
      '在 QGIS 后台线程异步执行一段 Python 代码，立即返回 task_id，不阻塞 QGIS 界面。' +
      '异步任务运行在纯 Python 环境，无法访问 iface/QgsProject 等 QGIS 对象。' +
      '适合耗时操作；用 check_qgis_task 轮询结果。',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要在 QGIS 后台线程执行的 Python 代码（纯 Python，无 QGIS 对象）。',
        },
      },
      required: ['code'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const code = typeof args?.code === 'string' ? args.code : ''
      if (!code.trim()) throw new Error('参数 code 不能为空')
      const target = await resolveTarget()
      const result = await callQgis('/api/pyeval_async', 'POST', { code }, exec?.signal, target)
      return asText(result)
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'check_qgis_task',
    description:
      '查询一个 QGIS 异步后台任务的执行状态。任务完成后返回结果并从缓存中移除（只能读取一次）；' +
      '尚未完成时返回 status=running。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'submit_qgis_async 返回的任务 ID。',
        },
      },
      required: ['task_id'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const taskId = typeof args?.task_id === 'string' ? args.task_id : ''
      if (!taskId.trim()) throw new Error('参数 task_id 不能为空')
      const target = await resolveTarget()
      const result = await callQgis(`/api/tasks/${encodeURIComponent(taskId)}`, 'GET', undefined, exec?.signal, target)
      return asText(result)
    },
  }))

  // ---- Dedicated GIS tools ----

  disposers.push(ctx.tools.register({
    name: 'qgis_list_layers',
    description:
      '列出当前 QGIS 项目中的所有图层（id、名称、类型、坐标系、要素数、几何类型）。' +
      '用于了解项目结构后再决定下一步操作。',
    parameters: { type: 'object', properties: {} },
    output: stringOutput,
    async execute(_args, exec) {
      const code = [
        'from qgis.core import QgsProject',
        'layers = []',
        'for lid, lyr in QgsProject.instance().mapLayers().items():',
        '    t = lyr.type().name if hasattr(lyr.type(), "name") else str(lyr.type())',
        "    info = {'id': lid, 'name': lyr.name(), 'type': t,",
        "            'crs': lyr.crs().authid() if lyr.crs().isValid() else None}",
        "    if hasattr(lyr, 'featureCount'):",
        "        try: info['feature_count'] = lyr.featureCount()",
        '        except Exception: pass',
        "    if hasattr(lyr, 'geometryType'):",
        '        try:',
        '            g = lyr.geometryType()',
        "            info['geometry_type'] = g.name if hasattr(g, 'name') else str(g)",
        '        except Exception: pass',
        '    layers.append(info)',
        'result = layers',
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_list_layouts',
    description: '列出当前 QGIS 项目中的所有打印布局名称。配合 qgis_export_layout 导出布局。',
    parameters: { type: 'object', properties: {} },
    output: stringOutput,
    async execute(_args, exec) {
      const code = [
        'from qgis.core import QgsProject',
        'result = [lay.name() for lay in QgsProject.instance().layoutManager().layouts()]',
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_list_algorithms',
    description:
      '列出 QGIS 处理框架中可用的空间分析算法（可按关键字过滤 id 或显示名）。' +
      '用于发现可用的算法 id，然后交给 qgis_run_processing 执行。最多返回 200 条。',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '可选关键字，按算法 id 或显示名过滤（如 "buffer"、"clip"）。',
        },
      },
    },
    output: stringOutput,
    async execute(args, exec) {
      const kw = typeof args?.keyword === 'string' ? args.keyword : ''
      const code = [
        'from qgis.core import QgsApplication',
        'from qgis.analysis import QgsNativeAlgorithms',
        'reg = QgsApplication.instance().processingRegistry()',
        'if not reg.algorithms():',
        '    reg.addProvider(QgsNativeAlgorithms(reg))',
        `kw = ${JSON.stringify(kw.toLowerCase())}`,
        'algs = []',
        'for a in reg.algorithms():',
        "    if kw and kw not in a.id().lower() and kw not in a.displayName().lower():",
        '        continue',
        "    algs.append({'id': a.id(), 'name': a.displayName(), 'provider': a.provider().id()})",
        'result = algs[:200]',
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_run_processing',
    description:
      '运行一个 QGIS 处理框架算法（空间分析）。algorithm 为算法 id（如 "native:buffer"、"native:clip"），' +
      'params 为 JSON 对象，键为参数名、值为参数值（图层输入可用图层名或 id）。' +
      '需要 QGIS 已加载处理插件（GUI 默认启用）。输出会被转换为 JSON 安全形式（文件路径 / 图层 source）。',
    parameters: {
      type: 'object',
      properties: {
        algorithm: {
          type: 'string',
          description: '算法 id，如 native:buffer、native:clip、native:intersection。',
        },
        params: {
          type: 'object',
          description: '算法参数对象，键为参数名（INPUT/DISTANCE/OUTPUT 等）。',
          additionalProperties: true,
        },
      },
      required: ['algorithm'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const alg = typeof args?.algorithm === 'string' ? args.algorithm.trim() : ''
      if (!alg) throw new Error('参数 algorithm 不能为空')
      const code = [
        'import json',
        'from qgis import processing',
        `params = ${pyJson(args?.params)}`,
        `out = processing.run(${JSON.stringify(alg)}, params or {})`,
        'safe = {}',
        'for k, v in out.items():',
        '    if isinstance(v, str) or isinstance(v, (int, float, bool)) or v is None:',
        '        safe[k] = v',
        '    elif isinstance(v, dict):',
        '        safe[k] = v',
        '    elif hasattr(v, "source") and callable(v.source):',
        '        try:',
        "            safe[k] = {'type': type(v).__name__, 'source': v.source(), 'name': v.name()}",
        '        except Exception:',
        '            safe[k] = type(v).__name__',
        '    else:',
        '        safe[k] = str(v)',
        'result = safe',
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_export_layout',
    description:
      '将指定打印布局导出为 PNG 图片或 PDF 文件。PNG 会以 base64 返回，本工具解码后写入本地临时文件并返回图片路径' +
      '（用 read_image 工具查看该路径）；PDF 同样写入本地临时文件并返回文件路径。跨机时文件会自动回传。',
    parameters: {
      type: 'object',
      properties: {
        layout_name: {
          type: 'string',
          description: '打印布局名称（用 qgis_list_layouts 查询）。',
        },
        format: {
          type: 'string',
          enum: ['png', 'pdf'],
          description: '导出格式，默认 png。',
        },
        dpi: {
          type: 'integer',
          description: 'PNG 导出分辨率 DPI，默认 300。',
        },
      },
      required: ['layout_name'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = typeof args?.layout_name === 'string' ? args.layout_name : ''
      if (!name.trim()) throw new Error('参数 layout_name 不能为空')
      const fmt = args?.format === 'pdf' ? 'pdf' : 'png'
      const dpi = Number.isInteger(args?.dpi) && args.dpi > 0 ? args.dpi : 300
      const code = [
        'import base64, tempfile, os',
        'from qgis.core import QgsProject, QgsLayoutExporter',
        'lm = QgsProject.instance().layoutManager()',
        `lay = lm.layoutByName(${JSON.stringify(name)})`,
        'if lay is None:',
        `    raise ValueError('layout not found: ' + ${JSON.stringify(name)})`,
        `stem = 'dsh_qgis_' + ''.join(c if c.isalnum() else '_' for c in ${JSON.stringify(name)})`,
        `if ${JSON.stringify(fmt)} == 'pdf':`,
        "    p = os.path.join(tempfile.gettempdir(), stem + '.pdf')",
        '    r = QgsLayoutExporter(lay).exportToPdf(p, QgsLayoutExporter.PdfExportSettings())',
        'else:',
        "    p = os.path.join(tempfile.gettempdir(), stem + '.png')",
        `    s = QgsLayoutExporter.ImageExportSettings(); s.dpi = ${dpi}`,
        '    r = QgsLayoutExporter(lay).exportToImage(p, s)',
        'if r != QgsLayoutExporter.Success:',
        "    raise RuntimeError('layout export failed: ' + str(r))",
        "with open(p, 'rb') as f:",
        `    result = {'format': ${JSON.stringify(fmt)}, 'file_base64': base64.b64encode(f.read()).decode(), 'size_bytes': os.path.getsize(p)}`,
      ].join('\n')
      const result = await runQgisSync(code, exec?.signal)
      if (!result || typeof result.file_base64 !== 'string') return asText(result)
      const ext = result.format === 'pdf' ? 'pdf' : 'png'
      const filePath = writeTempFile(result.file_base64, ext)
      if (ext === 'png') {
        return asText({
          image_path: filePath,
          size_bytes: result.size_bytes,
          hint: '使用 read_image 工具查看该图片路径',
        })
      }
      return asText({ file_path: filePath, size_bytes: result.size_bytes })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_render_map',
    description:
      '将当前 QGIS 项目地图画布（全部图层、项目范围）离屏渲染为 PNG 图片，' +
      '解码后写入本地临时文件并返回图片路径（用 read_image 工具查看）。跨机时图片会自动回传。' +
      '用于给多模态模型返回地图图像进行视觉验证。',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'integer', description: '渲染宽度像素，默认 800。' },
        height: { type: 'integer', description: '渲染高度像素，默认 600。' },
      },
    },
    output: stringOutput,
    async execute(args, exec) {
      const w = Number.isInteger(args?.width) && args.width > 0 ? args.width : 800
      const h = Number.isInteger(args?.height) && args.height > 0 ? args.height : 600
      const code = [
        'import base64, tempfile, os',
        'from qgis.core import QgsProject, QgsMapSettings, QgsMapRendererCustomPainterJob',
        'from qgis.PyQt.QtCore import QSize',
        'from qgis.PyQt.QtGui import QImage, QPainter, QColor',
        'layers = [l for l in QgsProject.instance().mapLayers().values()]',
        'if not layers:',
        "    raise ValueError('no layers in the current project to render')",
        'ms = QgsMapSettings(); ms.setLayers(layers)',
        'crs = QgsProject.instance().crs()',
        'if crs.isValid(): ms.setDestinationCrs(crs)',
        'ext = None',
        'for l in layers:',
        '    e = l.extent()',
        '    ext = e if ext is None else (ext.combineExtentWith(e) or ext)',
        'if ext is None or ext.isEmpty():',
        "    raise ValueError('empty map extent')",
        `ms.setExtent(ext); ms.setOutputSize(QSize(${w}, ${h}))`,
        `img = QImage(QSize(${w}, ${h}), QImage.Format.Format_ARGB32); img.fill(QColor('white'))`,
        'p = QPainter(img); job = QgsMapRendererCustomPainterJob(ms, p); job.renderSynchronously(); p.end()',
        "out = os.path.join(tempfile.gettempdir(), 'dsh_qgis_map.png')",
        "img.save(out, 'PNG')",
        "with open(out, 'rb') as f:",
        `    result = {'image_base64': base64.b64encode(f.read()).decode(), 'width': ${w}, 'height': ${h}}`,
      ].join('\n')
      const result = await runQgisSync(code, exec?.signal)
      if (!result || typeof result.image_base64 !== 'string') return asText(result)
      return asText({
        image_path: writeTempFile(result.image_base64, 'png'),
        width: result.width,
        height: result.height,
        hint: '使用 read_image 工具查看该图片路径',
      })
    },
  }))

  return () => { for (const d of disposers) d() }
}
