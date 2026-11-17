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
// Tools: 3 generic PyQGIS tools (execute_qgis_sync / submit_qgis_async /
// check_qgis_task), 6 read/analysis tools (list_layers / list_layouts /
// list_algorithms / run_processing / export_layout / render_map), 8 P0 daily-workflow
// tools (layer_fields / query_features / algorithm_help / add_layer / export_layer /
// set_extent / zoom_to_layer / screenshot) and 13 P1/P2 tools (selection, feature
// CRUD, layer visibility/remove, project info/save/CRS, layout items, style, plugin
// status). P1/P2 tools marked `deferLoading: true` only load their description when
// the model needs them, keeping the first-turn prompt small.
//
// Optional autostart: when no local QGIS instance is found, the bundle can launch one
// from `config.autostart.command` (cordis.patch.yml) or QGIS_LIVE_AUTOSTART_CMD, then
// poll the registry until the plugin reports ready.
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
async function findActiveQgis(startedAt = 0) {
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
    .filter((c) => c && c.mtime >= startedAt - 2000)
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

const DEFAULT_AUTOSTART_TIMEOUT_MS = 90000
const DEFAULT_AUTOSTART_SCRIPT = fileURLToPath(new URL('./scripts/start-qgis.cmd', import.meta.url))

/** Autostart config: `config.autostart` ({command, timeoutMs, env}) or QGIS_LIVE_AUTOSTART_CMD. */
function resolveAutostart(config) {
  const a = config?.autostart
  if (a === false) return null
  if (a && typeof a === 'object' && typeof a.command === 'string' && a.command.trim()) {
    const timeoutMs = Number(a.timeoutMs)
    return {
      command: a.command.trim(),
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_AUTOSTART_TIMEOUT_MS,
      env: a.env && typeof a.env === 'object' ? a.env : {},
    }
  }
  const envCommand = String(process.env.QGIS_LIVE_AUTOSTART_CMD || '').trim()
  if (envCommand) return { command: envCommand, timeoutMs: DEFAULT_AUTOSTART_TIMEOUT_MS, env: {} }
  // Ship-with-the-bundle launcher: present → autostart is on by default.
  try {
    if (fs.existsSync(DEFAULT_AUTOSTART_SCRIPT)) {
      return { command: `"${DEFAULT_AUTOSTART_SCRIPT}"`, timeoutMs: 120000, env: {} }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Launch the start command detached, then wait for a fresh registry entry. */
async function autostartQgis(auto) {
  const startedAt = Date.now()
  try {
    const child = spawn(auto.command, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...auto.env },
      windowsHide: false,
    })
    child.unref()
  } catch (e) {
    throw new Error(`QGIS 自动启动失败（${auto.command}）：${e.message}`)
  }
  const deadline = Date.now() + auto.timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try {
      return await findActiveQgis(startedAt)
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(
    `已执行自动启动命令，但 ${Math.round(auto.timeoutMs / 1000)} 秒内没有检测到 QGIS dsh_qgis_driver 实例` +
    `（命令：${auto.command}）。${lastError ? `最后错误：${lastError.message}` : ''}`)
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

/** Python helper: resolve a layer by id or name (raises ValueError when missing). */
const PY_FIND_LAYER = [
  'from qgis.core import QgsProject',
  'def _dsh_layer(name):',
  '    p = QgsProject.instance()',
  '    if name in p.mapLayers():',
  '        return p.mapLayer(name)',
  '    for lid, lay in p.mapLayers().items():',
  '        if lay.name() == name:',
  '            return lay',
  "    raise ValueError('layer not found: ' + str(name))",
]

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
    try {
      return await findActiveQgis()
    } catch (localError) {
      const auto = resolveAutostart(config)
      if (!auto) throw localError
      return await autostartQgis(auto)
    }
  }

  /** Read a required string argument. */
  function needStr(args, key) {
    const v = args?.[key]
    if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 不能为空`)
    return v.trim()
  }

  /** Parse an integer argument with bounds and a default. */
  function clampInt(value, dflt, min, max) {
    const n = Number(value)
    if (!Number.isFinite(n) || !Number.isInteger(n)) return dflt
    return Math.min(max, Math.max(min, n))
  }

  /** Register one tool with the standard string output schema. */
  function registerTool(def) {
    disposers.push(ctx.tools.register({ ...def, output: stringOutput }))
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
    name: 'qgis_export_atlas',
    description:
      '将指定打印布局的图集(atlas)导出为多页 PDF 或单页 PNG 图片。' +
      '要求该布局已在 QGIS 中启用了 atlas 并设置了覆盖图层。PDF 为多页合订文件；' +
      'PNG 只导出当前(第一)页，图集建议用 pdf。PNG 会写入本地临时文件并返回路径（用 read_image 查看）；' +
      'PDF 返回文件路径。返回结果包含页数 pages。',
    parameters: {
      type: 'object',
      properties: {
        layout_name: {
          type: 'string',
          description: '打印布局名称（用 qgis_list_layouts 查询，需已启用 atlas）。',
        },
        format: {
          type: 'string',
          enum: ['pdf', 'png'],
          description: '导出格式，默认 pdf。图集推荐 pdf（多页合订）。',
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
      const fmt = args?.format === 'png' ? 'png' : 'pdf'
      const dpi = Number.isInteger(args?.dpi) && args.dpi > 0 ? args.dpi : 300
      const code = [
        'import base64, tempfile, os',
        'from qgis.core import QgsProject, QgsLayoutExporter',
        'lm = QgsProject.instance().layoutManager()',
        `lay = lm.layoutByName(${JSON.stringify(name)})`,
        'if lay is None:',
        `    raise ValueError('layout not found: ' + ${JSON.stringify(name)})`,
        'atlas = lay.atlas()',
        'if not atlas.enabled():',
        "    raise ValueError('layout atlas is not enabled (enable it in QGIS: Layout > Atlas Settings)')",
        'atlas.updateFeatures()',
        'n_pages = atlas.count()',
        `stem = 'dsh_qgis_' + ''.join(c if c.isalnum() else '_' for c in ${JSON.stringify(name)})`,
        `if ${JSON.stringify(fmt)} == 'pdf':`,
        "    p = os.path.join(tempfile.gettempdir(), stem + '.pdf')",
        '    r = QgsLayoutExporter(lay).exportToPdf(p, QgsLayoutExporter.PdfExportSettings())',
        'else:',
        "    p = os.path.join(tempfile.gettempdir(), stem + '.png')",
        `    s = QgsLayoutExporter.ImageExportSettings(); s.dpi = ${dpi}`,
        '    r = QgsLayoutExporter(lay).exportToImage(p, s)',
        'if int(r) != int(QgsLayoutExporter.Success):',
        "    raise RuntimeError('atlas export failed: ' + str(r))",
        "with open(p, 'rb') as f:",
        `    result = {'format': ${JSON.stringify(fmt)}, 'file_base64': base64.b64encode(f.read()).decode(), 'size_bytes': os.path.getsize(p), 'pages': n_pages}`,
      ].join('\n')
      const result = await runQgisSync(code, exec?.signal)
      if (!result || typeof result.file_base64 !== 'string') return asText(result)
      const ext = result.format === 'pdf' ? 'pdf' : 'png'
      const filePath = writeTempFile(result.file_base64, ext)
      if (ext === 'png') {
        return asText({
          image_path: filePath,
          pages: result.pages,
          size_bytes: result.size_bytes,
          hint: '使用 read_image 工具查看该图片路径',
        })
      }
      return asText({ file_path: filePath, pages: result.pages, size_bytes: result.size_bytes })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_create_layout',
    description:
      '在当前 QGIS 项目中新建一个空白打印布局。创建后可回到 QGIS GUI 向其中添加地图、图例、比例尺等元素，' +
      '再用 qgis_export_layout / qgis_export_atlas 导出。布局名必须唯一。',
    parameters: {
      type: 'object',
      properties: {
        layout_name: {
          type: 'string',
          description: '新打印布局的名称（必填，不能与现有布局重名）。',
        },
      },
      required: ['layout_name'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = typeof args?.layout_name === 'string' ? args.layout_name.trim() : ''
      if (!name) throw new Error('参数 layout_name 不能为空')
      const code = [
        'from qgis.core import QgsProject, QgsPrintLayout',
        'lm = QgsProject.instance().layoutManager()',
        `if lm.layoutByName(${JSON.stringify(name)}) is not None:`,
        `    raise ValueError('layout already exists: ' + ${JSON.stringify(name)})`,
        `lay = QgsPrintLayout(QgsProject.instance()); lay.setName(${JSON.stringify(name)})`,
        'lay.initializeDefaults()',
        'lm.addLayout(lay)',
        "result = {'name': lay.name(), 'layouts': [l.name() for l in lm.layouts()]}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
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

  // ---- P0 daily-workflow tools ----

  disposers.push(ctx.tools.register({
    name: 'qgis_layer_fields',
    description:
      '列出指定图层的字段（名称、类型、别名）。写表达式、修改属性、字段计算前先用它确认字段名。' +
      'layer 可传图层 id 或图层名称。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或图层名称。' },
      },
      required: ['layer'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = typeof args?.layer === 'string' ? args.layer.trim() : ''
      if (!name) throw new Error('参数 layer 不能为空')
      const code = [
        ...PY_FIND_LAYER,
        `lyr = _dsh_layer(${JSON.stringify(name)})`,
        'fields = []',
        'for f in lyr.fields():',
        "    fields.append({'name': f.name(), 'type': f.typeName(), 'alias': f.alias()})",
        "result = {'layer': lyr.name(), 'fields': fields}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_query_features',
    description:
      '按属性表达式查询图层要素，返回结构化行（默认 20 行、最多 200 行）。' +
      'expression 为 QGIS 表达式（如 "pop" > 1000），留空表示全部要素；' +
      'fields 限定返回字段（留空返回全部，几何默认不返回）。只是读取，不修改数据。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        expression: { type: 'string', description: 'QGIS 属性过滤表达式，留空 = 全部要素。' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: '只返回这些字段（留空 = 全部字段）。',
        },
        limit: { type: 'integer', description: '最多返回行数，默认 20，上限 200。' },
        include_geometry: { type: 'boolean', description: '是否返回 WKT 几何，默认 false。' },
      },
      required: ['layer'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = typeof args?.layer === 'string' ? args.layer.trim() : ''
      if (!name) throw new Error('参数 layer 不能为空')
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 20
      const fields = Array.isArray(args?.fields) ? args.fields.filter((f) => typeof f === 'string') : []
      const expr = typeof args?.expression === 'string' ? args.expression : ''
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import QgsFeatureRequest',
        `lyr = _dsh_layer(${JSON.stringify(name)})`,
        `expr = ${JSON.stringify(expr)}`,
        `wanted = ${JSON.stringify(fields)}`,
        `limit = ${limit}`,
        `want_geom = ${args?.include_geometry === true ? 'True' : 'False'}`,
        'req = QgsFeatureRequest()',
        'if expr:',
        '    req.setFilterExpression(expr)',
        'req.setLimit(limit + 1)',
        'names = [f.name() for f in lyr.fields()]',
        'if wanted:',
        '    names = [n for n in names if n in set(wanted)]',
        'rows = []',
        'truncated = False',
        'for feat in lyr.getFeatures(req):',
        '    if len(rows) >= limit:',
        '        truncated = True',
        '        break',
        '    row = {}',
        '    for n in names:',
        '        v = feat[n]',
        '        row[n] = v if isinstance(v, (str, int, float, bool)) or v is None else str(v)',
        '    if want_geom:',
        '        g = feat.geometry()',
        "        row['__geometry_wkt__'] = g.asWkt() if g is not None and not g.isEmpty() else None",
        '    rows.append(row)',
        "result = {'layer': lyr.name(), 'count': len(rows), 'truncated': truncated, 'rows': rows}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_algorithm_help',
    description:
      '查看一个处理算法的参数定义（参数名、说明、类型、是否可选）。' +
      '调用 qgis_run_processing 前先用它确认参数名，避免盲猜导致失败。',
    parameters: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', description: '算法 id，如 native:buffer。' },
      },
      required: ['algorithm'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const alg = typeof args?.algorithm === 'string' ? args.algorithm.trim() : ''
      if (!alg) throw new Error('参数 algorithm 不能为空')
      const code = [
        'from qgis.core import QgsApplication, QgsProcessingParameterDefinition',
        'from qgis.analysis import QgsNativeAlgorithms',
        `alg_id = ${JSON.stringify(alg)}`,
        'reg = QgsApplication.instance().processingRegistry()',
        'if not reg.algorithms():',
        '    reg.addProvider(QgsNativeAlgorithms(reg))',
        'alg = reg.algorithmById(alg_id)',
        'if alg is None:',
        "    raise ValueError('algorithm not found: ' + alg_id)",
        'flag_optional = getattr(QgsProcessingParameterDefinition, "FlagOptional", 0)',
        'params = []',
        'for p in alg.parameterDefinitions():',
        '    try:',
        '        optional = bool(p.flags() & int(flag_optional))',
        '    except Exception:',
        '        optional = None',
        "    params.append({'name': p.name(), 'description': p.description(),",
        "                   'type': type(p).__name__, 'optional': optional})",
        "result = {'id': alg.id(), 'name': alg.displayName(), 'parameters': params}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_add_layer',
    description:
      '把一个数据源加载为图层并加入当前工程。path 为本地文件（GeoPackage/Shapefile/GeoJSON/GeoTIFF 等）' +
      '或服务 URI（provider 为 xyz/wms 时）；provider 默认 auto（先矢量后栅格）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径或服务 URI。' },
        name: { type: 'string', description: '图层名称，默认取文件名。' },
        provider: {
          type: 'string',
          enum: ['auto', 'ogr', 'gdal', 'xyz', 'wms'],
          description: '数据提供者，默认 auto。',
        },
      },
      required: ['path'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const p = typeof args?.path === 'string' ? args.path.trim() : ''
      if (!p) throw new Error('参数 path 不能为空')
      const nm = typeof args?.name === 'string' ? args.name : ''
      const prov = typeof args?.provider === 'string' && args.provider ? args.provider : 'auto'
      const code = [
        'import os',
        'from qgis.core import QgsProject, QgsVectorLayer, QgsRasterLayer',
        `path = ${JSON.stringify(p)}`,
        `name = ${JSON.stringify(nm)}`,
        `prov = ${JSON.stringify(prov)}`,
        "lname = name or os.path.splitext(os.path.basename(path.split('|')[0]))[0] or 'layer'",
        'layer = None',
        "if prov in ('', 'auto'):",
        "    for pv, cls in (('ogr', QgsVectorLayer), ('gdal', QgsRasterLayer)):",
        '        cand = cls(path, lname, pv)',
        '        if cand.isValid():',
        '            layer = cand',
        '            break',
        'else:',
        "    cls = QgsRasterLayer if prov in ('gdal', 'xyz', 'wms') else QgsVectorLayer",
        '    cand = cls(path, lname, prov)',
        '    if cand.isValid():',
        '        layer = cand',
        'if layer is None:',
        "    raise ValueError('cannot load layer: ' + path)",
        'QgsProject.instance().addMapLayer(layer)',
        "t = getattr(layer.type(), 'name', str(layer.type()))",
        "info = {'id': layer.id(), 'name': layer.name(), 'type': t,",
        "        'crs': layer.crs().authid() if layer.crs().isValid() else None}",
        "if hasattr(layer, 'featureCount'):",
        '    try:',
        "        info['feature_count'] = layer.featureCount()",
        '    except Exception:',
        '        pass',
        'result = info',
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_export_layer',
    description:
      '把矢量图层导出为文件（GPKG/GeoJSON/Shapefile/CSV）。path 为输出绝对路径，' +
      'format 留空时按扩展名推断。只支持矢量图层（栅格请用 qgis_run_processing/gdal）。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        path: { type: 'string', description: '输出文件绝对路径。' },
        format: {
          type: 'string',
          enum: ['gpkg', 'geojson', 'shp', 'csv'],
          description: '输出格式，留空按扩展名推断。',
        },
      },
      required: ['layer', 'path'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = typeof args?.layer === 'string' ? args.layer.trim() : ''
      const out = typeof args?.path === 'string' ? args.path.trim() : ''
      if (!name) throw new Error('参数 layer 不能为空')
      if (!out) throw new Error('参数 path 不能为空')
      const fmt = typeof args?.format === 'string' ? args.format : ''
      const code = [
        ...PY_FIND_LAYER,
        'import os',
        'from qgis.core import QgsProject, QgsVectorLayer, QgsVectorFileWriter',
        `lyr = _dsh_layer(${JSON.stringify(name)})`,
        `out = ${JSON.stringify(out)}`,
        `fmt = ${JSON.stringify(fmt)}`,
        'if not isinstance(lyr, QgsVectorLayer):',
        "    raise ValueError('only vector layers are supported (use qgis_run_processing for raster export)')",
        "drivers = {'gpkg': 'GPKG', 'geojson': 'GeoJSON', 'shp': 'ESRI Shapefile', 'csv': 'CSV'}",
        "fmt = fmt or os.path.splitext(out)[1].lstrip('.').lower()",
        'drv = drivers.get(fmt)',
        'if not drv:',
        "    raise ValueError('unsupported format: ' + str(fmt))",
        'opts = QgsVectorFileWriter.SaveVectorOptions()',
        'opts.driverName = drv',
        "opts.fileEncoding = 'UTF-8'",
        'ret = QgsVectorFileWriter.writeAsVectorFormatV3(',
        '    lyr, out, QgsProject.instance().transformContext(), opts)',
        'err = ret[0]',
        'msg = ret[1]',
        'if int(err) != 0:',
        "    raise RuntimeError('export failed: ' + str(msg))",
        "result = {'layer': lyr.name(), 'path': out, 'format': fmt,",
        "          'size_bytes': os.path.getsize(out)}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_set_extent',
    description:
      '把 QGIS 地图画布范围设置为给定矩形（可指定坐标系，自动重投影到画布 CRS）。' +
      '仅限 QGIS GUI 会话（需要地图画布）。',
    parameters: {
      type: 'object',
      properties: {
        xmin: { type: 'number', description: '最小 X。' },
        ymin: { type: 'number', description: '最小 Y。' },
        xmax: { type: 'number', description: '最大 X。' },
        ymax: { type: 'number', description: '最大 Y。' },
        crs: { type: 'string', description: '矩形所用坐标系（如 EPSG:4326），留空按画布 CRS。' },
      },
      required: ['xmin', 'ymin', 'xmax', 'ymax'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const nums = ['xmin', 'ymin', 'xmax', 'ymax'].map((k) => Number(args?.[k]))
      if (nums.some((v) => !Number.isFinite(v))) throw new Error('xmin/ymin/xmax/ymax 必须是数字')
      const [xmin, ymin, xmax, ymax] = nums
      if (xmin >= xmax || ymin >= ymax) throw new Error('范围无效：要求 xmin < xmax 且 ymin < ymax')
      const crs = typeof args?.crs === 'string' ? args.crs : ''
      const code = [
        'from qgis.core import QgsRectangle, QgsProject, QgsCoordinateReferenceSystem, QgsCoordinateTransform',
        `rect = QgsRectangle(${xmin}, ${ymin}, ${xmax}, ${ymax})`,
        'canvas = iface.mapCanvas() if iface is not None else None',
        'if canvas is None:',
        "    raise RuntimeError('no map canvas：该工具需要在 QGIS GUI 会话中使用')",
        `src = ${JSON.stringify(crs)}`,
        'dst = canvas.mapSettings().destinationCrs()',
        'if src and dst.isValid():',
        '    sc = QgsCoordinateReferenceSystem(src)',
        '    if sc.isValid() and sc != dst:',
        '        tr = QgsCoordinateTransform(sc, dst, QgsProject.instance())',
        '        rect = tr.transformBoundingBox(rect)',
        'canvas.setExtent(rect)',
        'canvas.refresh()',
        "result = {'extent': [rect.xMinimum(), rect.yMinimum(), rect.xMaximum(), rect.yMaximum()],",
        "          'crs': dst.authid() if dst.isValid() else None}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_zoom_to_layer',
    description:
      '把地图画布缩放到指定图层的范围（自动重投影到画布 CRS）。仅限 QGIS GUI 会话。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
      },
      required: ['layer'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = typeof args?.layer === 'string' ? args.layer.trim() : ''
      if (!name) throw new Error('参数 layer 不能为空')
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import QgsProject, QgsCoordinateTransform',
        `lyr = _dsh_layer(${JSON.stringify(name)})`,
        'canvas = iface.mapCanvas() if iface is not None else None',
        'if canvas is None:',
        "    raise RuntimeError('no map canvas：该工具需要在 QGIS GUI 会话中使用')",
        'dst = canvas.mapSettings().destinationCrs()',
        'ext = lyr.extent()',
        'if lyr.crs().isValid() and dst.isValid() and lyr.crs() != dst:',
        '    tr = QgsCoordinateTransform(lyr.crs(), dst, QgsProject.instance())',
        '    ext = tr.transformBoundingBox(ext)',
        'canvas.setExtent(ext)',
        'canvas.refresh()',
        "result = {'layer': lyr.name(),",
        "          'extent': [ext.xMinimum(), ext.yMinimum(), ext.xMaximum(), ext.yMaximum()],",
        "          'crs': dst.authid() if dst.isValid() else None}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'qgis_screenshot',
    description:
      '截取 QGIS 当前地图画布或主窗口，返回本地 PNG 文件路径（用 read_image 查看）。' +
      'target=canvas 为地图画布，target=mainwindow 为整个 QGIS 主窗口。仅限 QGIS GUI 会话。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['canvas', 'mainwindow'],
          description: '截图目标，默认 canvas。',
        },
      },
    },
    output: stringOutput,
    async execute(args, exec) {
      const target = args?.target === 'mainwindow' ? 'mainwindow' : 'canvas'
      const code = [
        'import base64',
        'from qgis.PyQt.QtCore import QBuffer, QIODevice',
        'def _dsh_png_b64(obj):',
        '    buf = QBuffer(); buf.open(QIODevice.OpenModeFlag.WriteOnly)',
        "    ok = obj.save(buf, 'PNG')",
        '    if not ok:',
        "        raise RuntimeError('PNG encode failed')",
        '    data = bytes(buf.data()); buf.close()',
        '    return base64.b64encode(data).decode(), len(data)',
        `target = ${JSON.stringify(target)}`,
        "if target == 'mainwindow':",
        '    if iface is None:',
        "        raise RuntimeError('no iface：该工具需要在 QGIS GUI 会话中使用')",
        '    pm = iface.mainWindow().grab()',
        '    b64, n = _dsh_png_b64(pm)',
        '    w, h = pm.width(), pm.height()',
        'else:',
        '    canvas = iface.mapCanvas() if iface is not None else None',
        '    if canvas is None:',
        "        raise RuntimeError('no map canvas：该工具需要在 QGIS GUI 会话中使用')",
        '    img = canvas.grab().toImage()',
        '    b64, n = _dsh_png_b64(img)',
        '    w, h = img.width(), img.height()',
        "result = {'image_base64': b64, 'width': w, 'height': h, 'target': target, 'size_bytes': n}",
      ].join('\n')
      const result = await runQgisSync(code, exec?.signal)
      if (!result || typeof result.image_base64 !== 'string') return asText(result)
      return asText({
        image_path: writeTempFile(result.image_base64, 'png'),
        width: result.width,
        height: result.height,
        target: result.target,
        size_bytes: result.size_bytes,
        hint: '使用 read_image 工具查看该图片路径',
      })
    },
  }))


  // ------------------------------------------------------------------
  // P1: selection / feature CRUD / layer ops / project / layouts
  // ------------------------------------------------------------------

  registerTool({
    name: 'qgis_select_features',
    description:
      '在图层中按属性表达式选中要素（mode：replace 替换、add 追加、remove 排除），返回选中数量。' +
      '只改变选择状态，不修改数据；expression 留空表示全部要素。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        expression: { type: 'string', description: 'QGIS 属性表达式，留空 = 全部要素。' },
        mode: { type: 'string', enum: ['replace', 'add', 'remove'], description: '选择模式，默认 replace。' },
      },
      required: ['layer'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const expr = typeof args?.expression === 'string' ? args.expression : ''
      const mode = ['add', 'remove'].includes(args?.mode) ? args.mode : 'replace'
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import QgsVectorLayer',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `expr = ${JSON.stringify(expr)}`,
        `mode = ${JSON.stringify(mode)}`,
        'sb = getattr(QgsVectorLayer, "SelectBehavior", None)',
        'if sb is not None:',
        '    behavior = {"replace": sb.SetSelection, "add": sb.AddToSelection, "remove": sb.RemoveFromSelection}[mode]',
        'else:',
        '    behavior = {"replace": QgsVectorLayer.SetSelection, "add": QgsVectorLayer.AddToSelection, "remove": QgsVectorLayer.RemoveFromSelection}[mode]',
        'if expr:',
        '    lyr.selectByExpression(expr, behavior)',
        'elif mode == "remove":',
        '    lyr.removeSelection()',
        'else:',
        '    lyr.selectAll()',
        "result = {'layer': lyr.name(), 'selected': lyr.selectedFeatureCount(), 'mode': mode}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_selected_features',
    description:
      '返回图层当前选中要素的行（fid + 属性，默认 20 行、上限 200）。先用 qgis_select_features 选中。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        limit: { type: 'integer', description: '最多返回行数，默认 20，上限 200。' },
      },
      required: ['layer'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const limit = clampInt(args?.limit, 20, 1, 200)
      const code = [
        ...PY_FIND_LAYER,
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `limit = ${limit}`,
        'names = [f.name() for f in lyr.fields()]',
        'rows = []',
        'for f in lyr.selectedFeatures():',
        '    if len(rows) >= limit:',
        '        break',
        '    rows.append({' + '"fid": f.id(), **{n: (None if f[n] is None else str(f[n])) for n in names}})',
        "result = {'layer': lyr.name(), 'selected': lyr.selectedFeatureCount(), 'fields': names, 'rows': rows}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_add_feature',
    deferLoading: true,
    description:
      '向可编辑图层新增一个要素：values 为 {字段名: 值}，可选 geometry_wkt 指定几何（WKT）。' +
      '会临时进入编辑模式并提交；失败时返回原因。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        values: { type: 'object', description: '字段名到值的映射。', additionalProperties: true },
        geometry_wkt: { type: 'string', description: '可选 WKT 几何，例如 POINT(116 39)。' },
      },
      required: ['layer', 'values'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const wkt = typeof args?.geometry_wkt === 'string' ? args.geometry_wkt : ''
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import QgsFeature, QgsGeometry',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        'import json',
        `vals = ${pyJson(args?.values)}`,
        `wkt = ${JSON.stringify(wkt)}`,
        'if not lyr.isEditable() and not lyr.startEditing():',
        "    raise RuntimeError('cannot start editing: ' + lyr.name())",
        'f = QgsFeature(lyr.fields())',
        'if wkt:',
        '    g = QgsGeometry.fromWkt(wkt)',
        '    if g is None or g.isEmpty():',
        "        raise ValueError('invalid geometry_wkt')",
        '    f.setGeometry(g)',
        'for k, v in vals.items():',
        '    i = lyr.fields().indexFromName(k)',
        '    if i < 0:',
        "        raise ValueError('unknown field: ' + str(k))",
        '    f.setAttribute(i, v)',
        'ok = lyr.addFeature(f)',
        'if not lyr.commitChanges():',
        "    raise RuntimeError('commitChanges failed: ' + str(lyr.commitErrors()))",
        "result = {'added': bool(ok), 'feature_id': f.id(), 'count': lyr.featureCount(), 'layer': lyr.name()}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_update_features',
    deferLoading: true,
    description:
      '按表达式批量修改要素属性：values 为 {字段名: 新值}。confirmation 必须为 true 才会执行；' +
      '单次最多 5000 个要素。返回修改数量。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        expression: { type: 'string', description: '要修改的要素表达式（必填）。' },
        values: { type: 'object', description: '字段名到新值的映射。', additionalProperties: true },
        confirm: { type: 'boolean', description: '必须为 true，确认执行写操作。' },
        limit: { type: 'integer', description: '最多修改数量，默认 1000，上限 5000。' },
      },
      required: ['layer', 'expression', 'values', 'confirm'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const expr = needStr(args, 'expression')
      if (args?.confirm !== true) throw new Error('写操作需要 confirm=true')
      const limit = clampInt(args?.limit, 1000, 1, 5000)
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import QgsFeatureRequest',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `expr = ${JSON.stringify(expr)}`,
        'import json',
        `vals = ${pyJson(args?.values)}`,
        `limit = ${limit}`,
        'req = QgsFeatureRequest().setFilterExpression(expr)',
        'ids = [f.id() for f in lyr.getFeatures(req)]',
        'if len(ids) > limit:',
        "    raise RuntimeError('matched ' + str(len(ids)) + ' features > limit ' + str(limit) + '; refine the expression')",
        'fields = lyr.fields()',
        'for k in vals:',
        '    if fields.indexFromName(k) < 0:',
        "        raise ValueError('unknown field: ' + str(k))",
        'if not lyr.isEditable() and not lyr.startEditing():',
        "    raise RuntimeError('cannot start editing: ' + lyr.name())",
        'for fid in ids:',
        '    for k, v in vals.items():',
        '        lyr.changeAttributeValue(fid, fields.indexFromName(k), v)',
        'if not lyr.commitChanges():',
        "    raise RuntimeError('commitChanges failed: ' + str(lyr.commitErrors()))",
        "result = {'updated': len(ids), 'layer': lyr.name(), 'count': lyr.featureCount()}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_delete_features',
    deferLoading: true,
    description:
      '按表达式删除要素。confirm 必须为 true；单次最多 5000 个。返回删除数量。删除不可撤销。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        expression: { type: 'string', description: '要删除的要素表达式（必填）。' },
        confirm: { type: 'boolean', description: '必须为 true，确认执行删除。' },
        limit: { type: 'integer', description: '最多删除数量，默认 1000，上限 5000。' },
      },
      required: ['layer', 'expression', 'confirm'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const expr = needStr(args, 'expression')
      if (args?.confirm !== true) throw new Error('删除操作需要 confirm=true')
      const limit = clampInt(args?.limit, 1000, 1, 5000)
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import QgsFeatureRequest',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `expr = ${JSON.stringify(expr)}`,
        `limit = ${limit}`,
        'req = QgsFeatureRequest().setFilterExpression(expr)',
        'ids = [f.id() for f in lyr.getFeatures(req)]',
        'if len(ids) > limit:',
        "    raise RuntimeError('matched ' + str(len(ids)) + ' features > limit ' + str(limit) + '; refine the expression')",
        'if not lyr.isEditable() and not lyr.startEditing():',
        "    raise RuntimeError('cannot start editing: ' + lyr.name())",
        'ok = lyr.deleteFeatures(ids)',
        'if not lyr.commitChanges():',
        "    raise RuntimeError('commitChanges failed: ' + str(lyr.commitErrors()))",
        "result = {'deleted': len(ids), 'ok': bool(ok), 'layer': lyr.name(), 'count': lyr.featureCount()}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_set_layer_visibility',
    description: '设置图层在图层树中的可见性（true/false）。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        visible: { type: 'boolean', description: '是否可见。' },
      },
      required: ['layer', 'visible'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const visible = args?.visible !== false
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import QgsProject',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `visible = ${visible ? 'True' : 'False'}`,
        'node = QgsProject.instance().layerTreeRoot().findLayer(lyr.id())',
        'if node is not None:',
        '    node.setItemVisibilityChecked(visible)',
        'lyr.triggerRepaint()',
        "result = {'layer': lyr.name(), 'visible': visible, 'tree_node_found': node is not None}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_remove_layer',
    deferLoading: true,
    description: '从当前工程移除一个图层（不删除源文件）。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
      },
      required: ['layer'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import QgsProject',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        'lid = lyr.id()',
        'lname = lyr.name()',
        'QgsProject.instance().removeMapLayer(lid)',
        "result = {'removed': lid, 'name': lname, 'remaining': len(QgsProject.instance().mapLayers())}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_project_info',
    description:
      '返回当前工程概况：文件路径、标题、坐标系、范围、图层列表（id/名称/类型）、打印布局、QGIS 版本。',
    parameters: { type: 'object', properties: {} },
    async execute(_args, exec) {
      const code = [
        'from qgis.core import Qgis, QgsProject',
        'p = QgsProject.instance()',
        'mgr = p.layoutManager()',
        'layouts = [l.name() for l in mgr.printLayouts()] if mgr is not None else []',
        'ext = p.extent() if hasattr(p, "extent") else None',
        'result = {',
        "    'file': p.fileName() or None,",
        "    'title': p.title() or '',",
        "    'crs': p.crs().authid(),",
        "    'crs_description': p.crs().description(),",
        "    'extent': [ext.xMinimum(), ext.yMinimum(), ext.xMaximum(), ext.yMaximum()] if ext is not None and not ext.isNull() else None,",
        "    'layer_count': len(p.mapLayers()),",
        "    'layers': [{'id': lid, 'name': lay.name(), 'type': str(getattr(lay.type(), 'name', ''))} for lid, lay in list(p.mapLayers().items())[:100]],",
        "    'layouts': layouts,",
        "    'qgis_version': Qgis.QGIS_VERSION,",
        '}',
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_save_project',
    deferLoading: true,
    description: '保存当前工程；path 留空则保存到已有工程文件，未保存过的工程必须提供 path。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可选的工程输出路径（.qgs/.qgz）。' },
      },
    },
    async execute(args, exec) {
      const pathArg = typeof args?.path === 'string' ? args.path : ''
      const code = [
        'from qgis.core import QgsProject',
        'p = QgsProject.instance()',
        `target = ${JSON.stringify(pathArg)} or p.fileName()`,
        'if not target:',
        "    raise ValueError('当前工程未保存过，请传 path 指定输出路径')",
        'ok = p.write(target)',
        "result = {'saved': bool(ok), 'file': target}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_layout_items',
    deferLoading: true,
    description: '列出某个打印布局里的所有条目（id/类型/uuid），用于检查布局结构。',
    parameters: {
      type: 'object',
      properties: {
        layout_name: { type: 'string', description: '打印布局名称。' },
      },
      required: ['layout_name'],
    },
    async execute(args, exec) {
      const name = needStr(args, 'layout_name')
      const code = [
        'from qgis.core import QgsProject',
        `name = ${JSON.stringify(name)}`,
        'mgr = QgsProject.instance().layoutManager()',
        'lyt = None',
        'for l in mgr.printLayouts():',
        '    if l.name() == name:',
        '        lyt = l',
        '        break',
        'if lyt is None:',
        "    raise ValueError('layout not found: ' + name)",
        'from qgis.core import QgsLayoutItem',
        'items = []',
        'for it in lyt.items():',
        '    if not isinstance(it, QgsLayoutItem):',
        '        continue',
        '    items.append({"id": it.id(), "type": it.__class__.__name__, "uuid": str(getattr(it, "uuid", lambda: "")())})',
        "result = {'layout': name, 'count': len(items), 'items': items[:100]}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_set_project_crs',
    deferLoading: true,
    description: '设置当前工程的坐标系（例如 EPSG:3857）。只改工程 CRS，不重投影已有图层数据。',
    parameters: {
      type: 'object',
      properties: {
        crs: { type: 'string', description: '目标坐标系，如 EPSG:3857 或 urn:ogc:def:crs:EPSG::3857。' },
      },
      required: ['crs'],
    },
    async execute(args, exec) {
      const crs = needStr(args, 'crs')
      const code = [
        'from qgis.core import QgsCoordinateReferenceSystem, QgsProject',
        `crs = QgsCoordinateReferenceSystem(${JSON.stringify(crs)})`,
        'if not crs.isValid():',
        "    raise ValueError('invalid CRS: ' + str(crs))",
        'QgsProject.instance().setCrs(crs)',
        "result = {'crs': crs.authid(), 'description': crs.description()}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_set_layer_style',
    deferLoading: true,
    description:
      '设置图层的基础样式：color 为十六进制颜色（如 #e6194b），opacity 为 0-1 不透明度。' +
      '只对符号化渲染器生效（分类/分级渲染器请先用 run_processing 或 pyeval 调整）。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称（仅矢量图层）。' },
        color: { type: 'string', description: '可选，十六进制颜色，如 #3366cc。' },
        opacity: { type: 'number', description: '可选，不透明度 0-1。' },
      },
      required: ['layer'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const color = typeof args?.color === 'string' ? args.color : ''
      const opacity = typeof args?.opacity === 'number' ? args.opacity : null
      if (!color && opacity === null) throw new Error('color 和 opacity 至少给一个')
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.PyQt.QtGui import QColor',
        'from qgis.core import QgsRenderContext',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `color = ${JSON.stringify(color)}`,
        `opacity = ${opacity === null ? 'None' : String(opacity)}`,
        'changed = []',
        'if color:',
        '    r = lyr.renderer()',
        '    if hasattr(r, "symbol") and callable(getattr(r, "symbol", None)):',
        '        syms = [r.symbol()]',
        '    elif hasattr(r, "symbols"):',
        '        syms = r.symbols(QgsRenderContext())',
        '    else:',
        '        syms = []',
        '    if not syms:',
        "        raise RuntimeError('该图层渲染器无法统一着色: ' + r.__class__.__name__)",
        '    for s_ in syms:',
        '        s_.setColor(QColor(color))',
        "    changed.append('color')",
        'if opacity is not None:',
        '    o = float(opacity)',
        '    if o < 0 or o > 1:',
        "        raise ValueError('opacity 必须在 0-1 之间')",
        '    lyr.setOpacity(o)',
        "    changed.append('opacity')",
        'lyr.triggerRepaint()',
        "result = {'layer': lyr.name(), 'changed': changed, 'opacity': lyr.opacity(), 'color': color or None}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_plugin_status',
    deferLoading: true,
    description: '诊断用：返回 QGIS 版本与 dsh_qgis_driver 插件是否已加载及其版本。',
    parameters: { type: 'object', properties: {} },
    async execute(_args, exec) {
      const code = [
        'import sys',
        'from qgis.core import Qgis',
        'res = {"qgis_version": Qgis.QGIS_VERSION, "qgis_release": getattr(Qgis, "QGIS_RELEASE_NAME", "")}',
        'module_loaded = "dsh_qgis_driver" in sys.modules',
        'res["plugin_module_loaded"] = module_loaded',
        'try:',
        '    import qgis.utils as qu',
        '    pl = qu.plugins.get("dsh_qgis_driver")',
        '    res["plugin_loaded"] = pl is not None',
        '    res["plugin_active"] = res["plugin_loaded"] or module_loaded',
        '    if pl is not None:',
        '        meta = getattr(pl, "metadata", lambda: {})()',
        '        res["plugin_version"] = meta.get("version") if isinstance(meta, dict) else None',
        'except Exception as e:',
        '    res["plugin_error"] = str(e)',
        'result = res',
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })


  /** Run a plugin REST command via POST /api/cmd (dispatch type + args as-is). */
  async function runQgisCmd(type, args, signal) {
    const target = await resolveTarget()
    const payload = { type }
    if (args && typeof args === 'object') {
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) payload[k] = v
      }
    }
    return callQgis('/api/cmd', 'POST', payload, signal, target)
  }

  /** Register a thin DSH tool that maps 1:1 to a plugin REST command. */
  function cmdTool(name, type, description, parameters, opts = {}) {
    registerTool({
      name,
      description,
      parameters,
      ...opts,
      async execute(args, exec) {
        return asText(await runQgisCmd(type, args, exec?.signal))
      },
    })
  }

  // ------------------------------------------------------------------
  // Plugin REST tools (1:1 mapping to dsh_qgis_driver's /api/cmd types)
  // ------------------------------------------------------------------

  cmdTool(
    'qgis_status',
    'status',
    '诊断用：返回 QGIS 进程、HTTP 端口、已加载插件及其 live driver/view 状态。',
    { type: 'object', properties: {} },
  )

  cmdTool(
    'qgis_describe_plugins',
    'describe_plugins',
    '列出所有已加载的 QGIS 插件及其 AI 可调用能力（bridge 的 pluginInfo 汇总）。' +
      '先调用它发现该用哪个插件，再用 qgis_bridge_call 调用。',
    { type: 'object', properties: {} },
  )

  cmdTool(
    'qgis_open_plugin',
    'open_plugin',
    '按需加载并启动一个 QGIS 插件，并调用其 open_dialog()（若有）。',
    {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: '插件 id（如 "dsh_qgis_driver"）。' },
      },
      required: ['plugin_id'],
    },
  )

  cmdTool(
    'qgis_reload_plugin',
    'reload_plugin',
    '热重载一个 QGIS 插件（清理 sys.modules + reloadPlugin + open_dialog），无需重启 QGIS。',
    {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: '要重载的插件 id。' },
      },
      required: ['plugin_id'],
    },
  )

  cmdTool(
    'qgis_bridge_call',
    'bridge_call',
    '进程内直接调用某个插件的 bridge 方法（绕过 WebChannel，渲染器卡死时也有效）。' +
      'JSON 字符串结果会被解析。',
    {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'bridge 方法名。' },
        plugin_id: { type: 'string', description: '可选，目标插件 id。' },
        args: { type: 'array', items: {}, description: '位置参数（或含 kwargs 的列表）。' },
      },
      required: ['method'],
    },
  )

  cmdTool(
    'qgis_instruction',
    'instruction',
    '管理本机的 AI 指令文件。kind=agents（持久注入 system prompt）/ skills（按需过程文档）/ prompts（面板建议词）。' +
      'op=list|read|save|delete；save 写用户文件（~/.qgis-live/<kind>/<name>.md）。',
    {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'read', 'save', 'delete'], description: '操作类型。' },
        kind: { type: 'string', enum: ['agents', 'skills', 'prompts'], description: '指令类别。' },
        id: { type: 'string', description: '目标文件名（stem）；read/delete 用。' },
        name: { type: 'string', description: '保存的文件名（stem）；save 用。' },
        text: { type: 'string', description: '文件正文（Markdown）；save 用。' },
      },
      required: ['op', 'kind'],
    },
  )

  cmdTool(
    'qgis_eval',
    'eval',
    '在某个插件的 QWebEngineView 里执行 JS 表达式（经 plugin_id 路由到该插件的 live driver）。' +
      '本驱动无 WebEngine view，需指向带 view 的插件。',
    {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JS 表达式。' },
        plugin_id: { type: 'string', description: '目标 WebEngine 插件 id。' },
      },
      required: ['expression', 'plugin_id'],
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_devreload',
    'devreload',
    '重载插件的 repo 侧 bridge/ui（WEBENGINE_DEV_SRC）并刷新其页面，经 plugin_id 路由。',
    {
      type: 'object',
      properties: {
        plugin_id: { type: 'string', description: '目标 WebEngine 插件 id。' },
      },
      required: ['plugin_id'],
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_devin_run',
    'devin_run',
    '在本机启动一个 Devin CLI 代理会话作为后台任务，立即返回 task_id。' +
      '用 qgis_devin_status 轮询、qgis_devin_result 取输出、qgis_devin_abort 停止。' +
      'engine: acp（共享 IDE 登录）/ print（需 devin auth login）/ auto；permission_mode 默认 dangerous。每次运行消耗 Devin 额度。',
    {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '给 Devin 的任务指令。' },
        cwd: { type: 'string', description: '工作目录（默认用户主目录）。' },
        session_id: { type: 'string', description: '恢复某个会话 id。' },
        model: { type: 'string', description: '模型覆盖。' },
        permission_mode: { type: 'string', enum: ['normal', 'accept-edits', 'smart', 'dangerous'], description: '权限应答策略。' },
        engine: { type: 'string', enum: ['auto', 'acp', 'print'], description: 'acp/print/auto。' },
      },
      required: ['prompt'],
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_devin_status',
    'devin_status',
    '查询 Devin 任务状态（running/exited/failed）、耗时与最近日志。省略 task_id 列出全部。',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id，省略则列出全部 Devin 任务。' },
      },
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_devin_result',
    'devin_result',
    '取 Devin 任务的捕获输出（日志尾部）。tail 为最大返回字符数，默认 20000。',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id。' },
        tail: { type: 'integer', description: '最大返回字符数，默认 20000。' },
      },
      required: ['task_id'],
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_devin_abort',
    'devin_abort',
    '终止一个由 qgis_devin_run 启动的 Devin 任务。',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id。' },
      },
      required: ['task_id'],
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_copilot_run',
    'copilot_run',
    '在本机启动一个 GitHub Copilot CLI 代理会话作为后台任务，立即返回 task_id。' +
      '用 qgis_copilot_status 轮询、qgis_copilot_result 取输出、qgis_copilot_abort 停止。' +
      'engine: acp（JSON-RPC）/ print（copilot -p）/ auto；permission_mode 默认 dangerous。每次运行消耗 Copilot 高级请求。',
    {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '给 Copilot 的任务指令。' },
        cwd: { type: 'string', description: '工作目录（默认用户主目录）。' },
        session_id: { type: 'string', description: '恢复某个会话 id。' },
        model: { type: 'string', description: '模型覆盖。' },
        permission_mode: { type: 'string', enum: ['normal', 'accept-edits', 'smart', 'dangerous'], description: '权限应答策略。' },
        engine: { type: 'string', enum: ['auto', 'acp', 'print'], description: 'acp/print/auto。' },
      },
      required: ['prompt'],
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_copilot_status',
    'copilot_status',
    '查询 Copilot 任务状态、耗时与最近日志。省略 task_id 列出全部。',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id，省略则列出全部 Copilot 任务。' },
      },
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_copilot_result',
    'copilot_result',
    '取 Copilot 任务的捕获输出（日志尾部）。tail 为最大返回字符数，默认 20000。',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id。' },
        tail: { type: 'integer', description: '最大返回字符数，默认 20000。' },
      },
      required: ['task_id'],
    },
    { deferLoading: true },
  )

  cmdTool(
    'qgis_copilot_abort',
    'copilot_abort',
    '终止一个由 qgis_copilot_run 启动的 Copilot 任务。',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id。' },
      },
      required: ['task_id'],
    },
    { deferLoading: true },
  )

  // ------------------------------------------------------------------
  // P2: undo/redo, layer classification/symbolization, layer reprojection
  // ------------------------------------------------------------------

  registerTool({
    name: 'qgis_undo',
    deferLoading: true,
    description:
      '撤销指定图层编辑会话中最近一次未提交的编辑（需图层处于编辑状态）。' +
      '对已提交（commitChanges）的改动无效——QGIS 的撤销栈只保留当前编辑会话内的操作。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
      },
      required: ['layer'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const code = [
        ...PY_FIND_LAYER,
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        'us = lyr.undoStack()',
        'if not us.canUndo():',
        "    result = {'layer': lyr.name(), 'undone': False, 'note': 'nothing to undo (not editing or no uncommitted edits)', 'undo_index': us.index(), 'undo_count': us.count()}",
        'else:',
        '    us.undo()',
        "    result = {'layer': lyr.name(), 'undone': True, 'undo_index': us.index(), 'undo_count': us.count()}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_redo',
    deferLoading: true,
    description:
      '重做指定图层编辑会话中最近一次被撤销的编辑。要求图层处于编辑状态且撤销栈中有可重做项。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
      },
      required: ['layer'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const code = [
        ...PY_FIND_LAYER,
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        'us = lyr.undoStack()',
        'if not us.canRedo():',
        "    result = {'layer': lyr.name(), 'redone': False, 'note': 'nothing to redo', 'undo_index': us.index(), 'undo_count': us.count()}",
        'else:',
        '    us.redo()',
        "    result = {'layer': lyr.name(), 'redone': True, 'undo_index': us.index(), 'undo_count': us.count()}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_classify_layer',
    deferLoading: true,
    description:
      '给矢量图层套用分类或分级符号化渲染器：mode=categorized 按字段唯一值分类，' +
      'mode=graduated 按数值字段等间距分级（classes 级）。可选 colors 数组按顺序着色（hex，如 ["#e6194b","#3cb44b"]）；' +
      'graduated 用 colors[0]→colors[-1] 做渐变，缺省红→蓝渐变。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称（仅矢量图层）。' },
        field: { type: 'string', description: '分类/分级依据字段。' },
        mode: { type: 'string', enum: ['categorized', 'graduated'], description: '默认 categorized。' },
        classes: { type: 'integer', description: 'graduated 分级数，默认 5。' },
        colors: { type: 'array', items: { type: 'string' }, description: '可选颜色列表（hex）。' },
      },
      required: ['layer', 'field'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const field = needStr(args, 'field')
      const mode = args?.mode === 'graduated' ? 'graduated' : 'categorized'
      const classes = clampInt(args?.classes, 5, 2, 20)
      const colors = Array.isArray(args?.colors) ? args.colors.filter((c) => typeof c === 'string') : []
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import (QgsCategorizedSymbolRenderer, QgsGraduatedSymbolRenderer,',
        '                        QgsSymbol, QgsGradientColorRamp)',
        'from qgis.PyQt.QtGui import QColor',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `field = ${JSON.stringify(field)}`,
        `mode = ${JSON.stringify(mode)}`,
        `classes = ${classes}`,
        `colors = ${JSON.stringify(colors)}`,
        'if field not in [f.name() for f in lyr.fields()]:',
        "    raise ValueError('unknown field: ' + field)",
        "if mode == 'graduated':",
        '    r = QgsGraduatedSymbolRenderer(field)',
        '    if len(colors) >= 2:',
        '        r.setSourceColorRamp(QgsGradientColorRamp(QColor(colors[0]), QColor(colors[-1])))',
        '    else:',
        "        r.setSourceColorRamp(QgsGradientColorRamp(QColor('red'), QColor('blue')))",
        '    r.updateClasses(lyr, QgsGraduatedSymbolRenderer.Mode.EqualInterval, classes)',
        '    lyr.setRenderer(r)',
        "    result = {'layer': lyr.name(), 'mode': 'graduated', 'field': field, 'classes': len(r.ranges())}",
        'else:',
        '    sym = QgsSymbol.defaultSymbol(lyr.geometryType())',
        '    vals = sorted({f[field] for f in lyr.getFeatures()})',
        '    cats = QgsCategorizedSymbolRenderer.createCategories(vals, sym, lyr, field)',
        '    if colors:',
        '        for i, c in enumerate(cats):',
        '            if i < len(colors):',
        '                try:',
        '                    s_ = c.symbol().clone()',
        '                    s_.setColor(QColor(colors[i]))',
        '                    c.setSymbol(s_)',
        '                except Exception:',
        '                    pass',
        '    renderer = QgsCategorizedSymbolRenderer(field, cats)',
        '    lyr.setRenderer(renderer)',
        "    result = {'layer': lyr.name(), 'mode': 'categorized', 'field': field, 'categories': len(renderer.categories())}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_reproject_layer',
    deferLoading: true,
    description:
      '把矢量图层的数据重投影到目标坐标系，生成一个新的内存图层（字段与属性保留，几何坐标转换）并加入当前工程。' +
      '源图层不会被修改。target_crs 如 EPSG:3857。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '源图层 id 或名称（仅矢量图层）。' },
        target_crs: { type: 'string', description: '目标坐标系，如 EPSG:3857。' },
        output_name: { type: 'string', description: '新图层名称，默认 "<源名>_reprojected"。' },
      },
      required: ['layer', 'target_crs'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const targetCrs = needStr(args, 'target_crs')
      const outName = typeof args?.output_name === 'string' && args.output_name.trim()
        ? args.output_name.trim()
        : ''
      const code = [
        ...PY_FIND_LAYER,
        'from qgis.core import (QgsVectorLayer, QgsFeature, QgsGeometry, QgsWkbTypes,',
        '                        QgsCoordinateReferenceSystem, QgsCoordinateTransform, QgsProject)',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `dst = QgsCoordinateReferenceSystem(${JSON.stringify(targetCrs)})`,
        'if not dst.isValid():',
        "    raise ValueError('invalid target_crs: ' + " + JSON.stringify(targetCrs) + ")",
        'if lyr.crs().isValid() and lyr.crs() == dst:',
        "    result = {'layer': lyr.name(), 'crs': dst.authid(), 'feature_count': lyr.featureCount(), 'note': 'already in target CRS', 'copied': False}",
        'else:',
        '    wkt = QgsWkbTypes.displayString(lyr.wkbType())',
        `    oname = ${JSON.stringify(outName)} or (lyr.name() + '_reprojected')`,
        "    out = QgsVectorLayer(f'{wkt}?crs={dst.authid()}', oname, 'memory')",
        '    outp = out.dataProvider()',
        '    outp.addAttributes(lyr.fields())',
        '    out.updateFields()',
        '    xf = QgsCoordinateTransform(lyr.crs(), dst, QgsProject.instance())',
        '    feats = []',
        '    for f in lyr.getFeatures():',
        '        nf = QgsFeature(out.fields())',
        '        g = QgsGeometry(f.geometry()) if f.geometry() is not None else None',
        '        if g is not None and not g.isEmpty():',
        '            g.transform(xf)',
        '        nf.setGeometry(g)',
        '        for k in range(len(lyr.fields())):',
        '            nf.setAttribute(k, f.attribute(k))',
        '        feats.append(nf)',
        '    outp.addFeatures(feats)',
        '    out.updateExtents()',
        '    QgsProject.instance().addMapLayer(out)',
        "    result = {'layer': out.name(), 'source_layer': lyr.name(), 'source_crs': lyr.crs().authid() if lyr.crs().isValid() else None,",
        "              'crs': out.crs().authid(), 'feature_count': out.featureCount(), 'copied': True}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  // ------------------------------------------------------------------
  // Data-surface gaps: memory layer, full attribute table, open project
  // ------------------------------------------------------------------

  registerTool({
    name: 'qgis_create_memory_layer',
    deferLoading: true,
    description:
      '新建一个空的内存矢量图层并加入当前工程。geometry_type: point|line|polygon（默认 point）；' +
      'crs 默认 EPSG:4326；fields 为 [{name, type}]，type 支持 string|integer|double|date 等内存 provider 类型。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '图层名称。' },
        geometry_type: { type: 'string', enum: ['point', 'line', 'polygon'], description: '几何类型，默认 point。' },
        crs: { type: 'string', description: '坐标系，默认 EPSG:4326。' },
        fields: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '字段列表 [{name, type}]。',
        },
      },
      required: ['name'],
    },
    async execute(args, exec) {
      const name = needStr(args, 'name')
      const gmap = { point: 'Point', line: 'LineString', polygon: 'Polygon' }
      const g = gmap[args?.geometry_type] || 'Point'
      const crs = typeof args?.crs === 'string' && args.crs.trim() ? args.crs.trim() : 'EPSG:4326'
      const fields = Array.isArray(args?.fields) ? args.fields : []
      const code = [
        'from qgis.core import QgsVectorLayer, QgsProject',
        `name = ${JSON.stringify(name)}`,
        `g = ${JSON.stringify(g)}`,
        `crs = ${JSON.stringify(crs)}`,
        'import json',
        `fields = ${pyJson(fields)}`,
        `uri = f'{g}?crs={crs}'`,
        'for f in fields:',
        '    n = f.get("name", "")',
        '    t = f.get("type", "string")',
        '    if n:',
        "        uri += f'&field={n}:{t}'",
        'lyr = QgsVectorLayer(uri, name, "memory")',
        'if not lyr.isValid():',
        "    raise RuntimeError('failed to create memory layer: ' + uri)",
        'QgsProject.instance().addMapLayer(lyr)',
        "result = {'id': lyr.id(), 'name': lyr.name(), 'geometry': g, 'crs': lyr.crs().authid() if lyr.crs().isValid() else None,",
        "          'fields': [f.name() for f in lyr.fields()]}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_export_table',
    description:
      '导出图层的完整属性表（不含几何）。format=csv|json（默认 csv）。给定 path 则写文件并返回路径+行数；' +
      '未给 path 时返回内联数据（json 上限 10000 行，带 truncated 标记）。适合一次性取全部属性。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层 id 或名称。' },
        format: { type: 'string', enum: ['csv', 'json'], description: '默认 csv。' },
        path: { type: 'string', description: '可选输出文件绝对路径。' },
      },
      required: ['layer'],
    },
    async execute(args, exec) {
      const layer = needStr(args, 'layer')
      const fmt = args?.format === 'json' ? 'json' : 'csv'
      const outPath = typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : ''
      const code = [
        ...PY_FIND_LAYER,
        'import csv, json',
        `lyr = _dsh_layer(${JSON.stringify(layer)})`,
        `fmt = ${JSON.stringify(fmt)}`,
        `out_path = ${JSON.stringify(outPath)}`,
        'names = [f.name() for f in lyr.fields()]',
        'if fmt == "json":',
        '    rows = []',
        '    for f in lyr.getFeatures():',
        '        r = {}',
        '        for n in names:',
        '            v = f[n]',
        '            r[n] = v if isinstance(v, (str, int, float, bool)) or v is None else str(v)',
        '        rows.append(r)',
        '    if out_path:',
        "        with open(out_path, 'w', encoding='utf-8') as fh:",
        '            json.dump(rows, fh, ensure_ascii=False, indent=2)',
        "        result = {'path': out_path, 'rows': len(rows), 'columns': names}",
        '    else:',
        '        truncated = len(rows) > 10000',
        "        result = {'rows': len(rows), 'columns': names, 'truncated': truncated, 'data': rows[:10000]}",
        'else:',
        '    if out_path:',
        "        with open(out_path, 'w', newline='', encoding='utf-8-sig') as fh:",
        '            w = csv.DictWriter(fh, fieldnames=names)',
        '            w.writeheader()',
        '            for f in lyr.getFeatures():',
        '                w.writerow({n: f[n] for n in names})',
        "        result = {'path': out_path, 'columns': names}",
        '    else:',
        '        import io',
        '        buf = io.StringIO()',
        '        w = csv.DictWriter(buf, fieldnames=names)',
        '        w.writeheader()',
        '        nrows = 0',
        '        for f in lyr.getFeatures():',
        '            w.writerow({n: f[n] for n in names})',
        '            nrows += 1',
        "        result = {'rows': nrows, 'columns': names, 'csv': buf.getvalue()}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_open_project',
    deferLoading: true,
    description: '打开一个 QGIS 工程文件（.qgs/.qgz），替换当前工程。返回打开后的图层数。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工程文件绝对路径。' },
      },
      required: ['path'],
    },
    async execute(args, exec) {
      const p = needStr(args, 'path')
      const code = [
        'from qgis.core import QgsProject',
        `p = ${JSON.stringify(p)}`,
        'ok = QgsProject.instance().read(p)',
        "result = {'opened': bool(ok), 'file': p, 'layer_count': len(QgsProject.instance().mapLayers()),",
        "          'crs': QgsProject.instance().crs().authid() if QgsProject.instance().crs().isValid() else None}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  return () => { for (const d of disposers) d() }
}
