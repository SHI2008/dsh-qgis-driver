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
import z from 'schemastery'
import { registerConsolidatedTools } from './tools.js'

export const name = 'dsh-qgis-driver'
export const inject = ['tools']

/** Remote connection settings rendered as a form in DSH Settings. */
export const Config = z.object({
  host: z.string().default(''),
  port: z.number().default(0),
  key: z.string().default(''),
  dock: z.boolean().default(false),
  headless: z.boolean().default(true),
})

const REGISTRY_DIR = path.join(os.homedir(), '.qgis-live')

/**
 * Set to true as soon as any QGIS tool runs. The client status badge is hidden
 * by default and appears on its own after the first tool call (or when the
 * `dock` setting is turned on).
 */
let toolUsed = false
const HEALTH_TIMEOUT_MS = 2000

/** Resolve the remote target from `config` (cordis.patch.yml) or env vars. */
function resolveRemoteTarget(config) {
  const host = config?.host || process.env.QGIS_LIVE_REMOTE_HOST || ''
  const portRaw = config?.port ?? process.env.QGIS_LIVE_REMOTE_PORT
  const key = config?.key || process.env.QGIS_LIVE_REMOTE_KEY || ''
  if (!host && !portRaw) return null
  if (!host || !portRaw) {
    throw new Error('remote QGIS: host and port required (QGIS_LIVE_REMOTE_HOST/PORT or config)')
  }
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`remote QGIS: invalid port ${portRaw}`)
  }
  if (!key) {
    throw new Error('remote QGIS: Key required (QGIS_LIVE_REMOTE_KEY or config.key)')
  }
  return { base: `http://${host}:${port}`, token: key }
}

/** Whether a PID is alive (used to skip stale registry files). */
function pidAlive(pid) {
  if (!pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

/** Newest registry entries (mtime desc, at most 3). */
function registryCandidates(startedAt = 0) {
  let names
  try {
    names = fs.readdirSync(REGISTRY_DIR)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('-dsh_qgis_driver.json'))
    .map((n) => path.join(REGISTRY_DIR, n))
    .map((p) => {
      try { return { p, mtime: fs.statSync(p).mtimeMs } } catch { return null }
    })
    .filter((c) => c && c.mtime >= startedAt - 2000)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3)
}

/**
 * Find a live QGIS instance and return its FILE channel
 * (`<live_dir>/commands.jsonl` + `results.jsonl`).
 *
 * Local calls prefer this channel: no HTTP port, no Bearer header, and it works
 * whenever the plugin wrote its registry. Stale registry files (dead PID) are
 * skipped.
 */
/** live dirs that already timed out — skipped until the process restarts. */
const badLiveDirs = new Set()

function findLocalLiveDir(startedAt = 0, requireGui = false) {
  for (const { p } of registryCandidates(startedAt)) {
    let reg
    try { reg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { continue }
    if (reg.pid && !pidAlive(reg.pid)) continue
    if (requireGui && reg.gui !== true) continue
    const liveDir = reg.live_dir
    if (!liveDir) continue
    if (badLiveDirs.has(liveDir)) continue
    let token = ''
    try { token = fs.readFileSync(path.join(liveDir, 'token'), 'utf8').trim() } catch { token = '' }
    if (!token && typeof reg.token === 'string') token = reg.token
    if (!token) continue
    try {
      fs.accessSync(liveDir, fs.constants.R_OK | fs.constants.W_OK)
    } catch {
      continue
    }
    return {
      channel: 'file',
      liveDir,
      token,
      host: reg.host || '127.0.0.1',
      port: reg.http_port || 0,
      pid: reg.pid,
      gui: reg.gui === true,
    }
  }
  return null
}

/** Find a live QGIS instance reachable over HTTP (fallback path). */
async function findActiveQgis(startedAt = 0, requireGui = false) {
  for (const { p } of registryCandidates(startedAt)) {
    let reg
    try { reg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { continue }
    if (requireGui && reg.gui !== true) continue
    const host = reg.host || '127.0.0.1'
    const port = reg.http_port
    const token = reg.token
    if (!port || !token) continue
    try {
      const resp = await fetch(`http://${host}:${port}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      if (resp.status === 200) {
        return {
          channel: 'http',
          base: `http://${host}:${port}`,
          token,
          host,
          port,
          gui: reg.gui === true,
          liveDir: reg.live_dir || '',
        }
      }
      if (resp.status === 401) {
        throw new Error('QGIS auth failed: token does not match the running instance')
      }
    } catch (e) {
      // 401 is a hard failure; timeout/refused/other → try the next candidate.
      if (e instanceof Error && e.message.includes('凭证已过期')) throw e
      continue
    }
  }
  throw new Error('no active QGIS instance (start QGIS with the plugin enabled, or set QGIS_LIVE_REMOTE_HOST/PORT/KEY)')
}

const DEFAULT_AUTOSTART_TIMEOUT_MS = 90000

/** Candidate QGIS installation roots (first hit wins). */
function findQgisRoot() {
  const cands = []
  if (process.env.QGIS_ROOT) cands.push(process.env.QGIS_ROOT)
  if (process.env.QGIS_BIN) cands.push(path.dirname(path.dirname(process.env.QGIS_BIN)))
  if (process.env.QGIS_PREFIX_PATH) {
    // <root>/apps/qgis → <root>
    const p = process.env.QGIS_PREFIX_PATH.replace(/[\\/]+$/, '')
    cands.push(path.dirname(path.dirname(p)))
  }
  cands.push('H:\\QGIS')
  for (const base of [process.env.ProgramFiles, 'C:\\Program Files', 'C:\\Program Files (x86)']) {
    if (!base) continue
    try {
      for (const d of fs.readdirSync(base)) {
        if (/^QGIS/i.test(d)) cands.push(path.join(base, d))
      }
    } catch {
      /* ignore */
    }
  }
  for (const root of cands) {
    try {
      if (root && fs.existsSync(path.join(root, 'apps', 'Python312', 'python.exe'))) return root
    } catch {
      /* ignore */
    }
  }
  return null
}

/** Environment for a QGIS runtime, mirroring bin/python-qgis.bat + etc/ini/*.bat. */
function qgisEnv(root) {
  const env = { ...process.env }
  const sys = [process.env.windir || 'C:\\Windows']
  env.OSGEO4W_ROOT = root
  env.PATH = [
    path.join(root, 'bin'),
    path.join(root, 'apps', 'Python312', 'Scripts'),
    path.join(root, 'apps', 'Python312'),
    path.join(root, 'apps', 'qgis', 'bin'),
    path.join(root, 'apps', 'qt6', 'bin'),
    path.join(sys[0], 'system32'),
    sys[0],
    process.env.PATH || '',
  ].join(';')
  env.PYTHONHOME = path.join(root, 'apps', 'Python312')
  env.PYTHONPATH = path.join(root, 'apps', 'qgis', 'python')
  env.PYTHONUTF8 = '1'
  env.PYTHONEXECUTABLE = path.join(root, 'bin', 'python3.exe')
  env.QGIS_PREFIX_PATH = path.join(root, 'apps', 'qgis').replace(/\\/g, '/')
  env.QT_PLUGIN_PATH = [
    path.join(root, 'apps', 'qgis', 'qtplugins'),
    path.join(root, 'apps', 'qt6', 'plugins'),
  ].join(';')
  env.QT_QPA_PLATFORM_PLUGIN_PATH = path.join(root, 'apps', 'qt6', 'plugins', 'platforms')
  env.GDAL_DATA = path.join(root, 'apps', 'gdal', 'share', 'gdal')
  env.GDAL_DRIVER_PATH = path.join(root, 'apps', 'gdal', 'lib', 'gdalplugins')
  env.PROJ_DATA = path.join(root, 'share', 'proj')
  env.CURL_CA_BUNDLE = path.join(root, 'bin', 'curl-ca-bundle.crt')
  env.SSL_CERT_FILE = path.join(root, 'bin', 'curl-ca-bundle.crt')
  env.SSL_CERT_DIR = path.join(root, 'apps', 'openssl', 'certs')
  env.GDAL_FILENAME_IS_UTF8 = 'YES'
  env.VSI_CACHE = 'TRUE'
  env.VSI_CACHE_SIZE = '1000000'
  if (!env.WEBENGINE_LIVE_DIR) {
    env.WEBENGINE_LIVE_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'qgis-live-autostart')
  }
  if (!env.QGIS_LIVE_PORT) env.QGIS_LIVE_PORT = '0'
  return env
}

/** Bundle repo root (parent of dsh-tools/). */
function bundleRepoRoot() {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
}

/**
 * Copy `qgis-plugin/` into the QGIS profile plugin dir and enable it in
 * QGIS4.ini — needed only for the GUI launcher (the headless one imports the
 * package straight from the repo).
 */
function ensureProfilePlugin(root) {
  const src = path.join(bundleRepoRoot(), 'qgis-plugin')
  if (!fs.existsSync(path.join(src, 'metadata.txt'))) return
  if (process.env.QGIS_LIVE_AUTOSTART_SYNC === '0') return
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const profile = path.join(appData, 'QGIS', 'QGIS4', 'profiles', 'default')
  const dst = path.join(profile, 'python', 'plugins', 'dsh_qgis_driver')
  try {
    fs.rmSync(dst, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    fs.cpSync(src, dst, { recursive: true, filter: (p) => !/[\\/](\.git|__pycache__)([\\/]|$)/.test(p) })
  } catch {
    /* the GUI launcher still works when a previous copy is present */
  }
  // QGIS 4 keeps enable-state in the profile INI, not the registry.
  const ini = path.join(profile, 'QGIS', 'QGIS4.ini')
  try {
    let text = fs.existsSync(ini) ? fs.readFileSync(ini, 'utf8') : ''
    if (!/^\s*dsh_qgis_driver\s*=/m.test(text)) {
      if (/\[PythonPlugins\]/i.test(text)) {
        text = text.replace(/\[PythonPlugins\]([^\r\n]*)/i, (m0, tail) => `[PythonPlugins]${tail}\r\ndsh_qgis_driver=true`)
      } else {
        text += '\r\n[PythonPlugins]\r\ndsh_qgis_driver=true\r\n'
      }
      fs.writeFileSync(ini, text, 'utf8')
    }
  } catch {
    /* ignore */
  }
}

/** Spawn QGIS itself (no cmd.exe / batch wrapper). */
function autostartLogPath(tag) {
  const dir = path.join(os.tmpdir(), 'dsh-qgis-driver')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) { /* ignore */ }
  return path.join(dir, `qgis-${tag}.log`)
}

function launchBuiltin(mode) {
  const root = findQgisRoot()
  if (!root) {
    throw new Error('QGIS not found: set QGIS_ROOT (or install under H:\\QGIS / Program Files)')
  }
  const env = qgisEnv(root)
  if (mode === 'headless') {
    const py = path.join(root, 'apps', 'Python312', 'python.exe')
    const script = path.join(bundleRepoRoot(), 'dsh-tools', 'scripts', 'qgis-headless.py')
    env.QGIS_LIVE_PLUGIN_ROOT = bundleRepoRoot()
    const logPath = autostartLogPath('headless')
    let out = 'ignore'
    try {
      out = fs.openSync(logPath, 'a')
    } catch (e) {
      out = 'ignore'
    }
    const child = spawn(py, ['-u', script], {
      env: { ...env, PYTHONUNBUFFERED: '1' },
      detached: true,
      stdio: out === 'ignore' ? 'ignore' : ['ignore', out, out],
      windowsHide: true,
    })
    child.unref()
    return
  }
  ensureProfilePlugin(root)
  const bin = path.join(root, 'bin', 'qgis-bin.exe')
  let out = 'ignore'
  try {
    out = fs.openSync(autostartLogPath('gui'), 'a')
  } catch (e) {
    out = 'ignore'
  }
  const child = spawn(bin, [], {
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
}

/**
 * Autostart plan: an explicit `config.autostart.command` (or
 * QGIS_LIVE_AUTOSTART_CMD) wins; otherwise the built-in PyQGIS launcher runs —
 * headless by default, GUI when the call needs a map canvas.
 */
function resolveAutostart(config, gui = false) {
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
  if (envCommand) {
    return { command: envCommand, timeoutMs: DEFAULT_AUTOSTART_TIMEOUT_MS, env: {} }
  }
  const wantHeadless = !gui && config?.headless !== false
  return { builtin: wantHeadless ? 'headless' : 'gui', timeoutMs: 120000, gui: !wantHeadless }
}

/** Launch QGIS (built-in launcher or a custom command), then wait for a fresh registry. */
async function autostartQgis(auto, requireGui = false) {
  const startedAt = Date.now()
  if (auto.builtin) {
    try {
      launchBuiltin(auto.builtin)
    } catch (e) {
      throw new Error(`QGIS autostart failed: ${e && e.message ? e.message : e}`)
    }
  } else {
    try {
      // args array (no shell string) avoids cmd.exe quote mangling.
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', auto.command], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...auto.env },
        windowsHide: true,
      })
      child.unref()
    } catch (e) {
      throw new Error(`QGIS autostart failed (${auto.command}): ${e.message}`)
    }
  }
  const deadline = Date.now() + auto.timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const local = findLocalLiveDir(startedAt, requireGui)
    if (local) return local
    try {
      return await findActiveQgis(startedAt, requireGui)
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(
    `QGIS started (${auto.builtin || auto.command}) but no instance in ${Math.round(auto.timeoutMs / 1000)}s` +
    `${lastError ? `: ${lastError.message}` : ''}`)
}

const FILE_CHANNEL_TIMEOUT_MS = 15000
const FILE_POLL_INTERVAL_MS = 50

/** Per-live-dir read cursor for the JSONL results file. */
const fileStates = new Map()
/** Serializes file-channel calls so ids/tokens never interleave on one line. */
let fileChain = Promise.resolve()

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Map a REST route + JSON body onto the plugin's command object. */
function routeToCommand(route, body) {
  if (route === '/api/pyeval') return { type: 'pyeval', code: body?.code }
  if (route === '/api/pyeval_async') return { type: 'pyeval_async', code: body?.code }
  if (route === '/api/cmd') return { ...(body || {}) }
  const m = /^\/api\/tasks\/([^/]+)$/.exec(route || '')
  if (m) return { type: 'task_status', task_id: decodeURIComponent(m[1]) }
  throw new Error(`file channel: unsupported endpoint ${route}`)
}

/**
 * Run one command through the plugin's file channel
 * (`<live_dir>/commands.jsonl` → `<live_dir>/results.jsonl`).
 *
 * Appends one JSON line with a fresh id, then tails the results file from a
 * stored byte offset and resolves the line whose `id` matches.
 */
function invokeFile(cmd, signal, target) {
  const run = () => invokeFileOnce(cmd, signal, target)
  const p = fileChain.then(run, run)
  fileChain = p.catch(() => {})
  return p
}

async function invokeFileOnce(cmd, signal, target) {
  const liveDir = target.liveDir
  if (!liveDir) throw new Error('file channel: live_dir missing in registry')
  let token = target.token
  if (!token) {
    try { token = fs.readFileSync(path.join(liveDir, 'token'), 'utf8').trim() } catch { token = '' }
  }
  if (!token) throw new Error('file channel: token file missing')

  const cmdPath = path.join(liveDir, 'commands.jsonl')
  const resPath = path.join(liveDir, 'results.jsonl')
  let state = fileStates.get(liveDir)
  if (!state) {
    state = { offset: 0, buffer: '', ready: false }
    fileStates.set(liveDir, state)
  }
  if (!state.ready) {
    try { state.offset = fs.statSync(resPath).size } catch { state.offset = 0 }
    state.buffer = ''
    state.ready = true
  }
  const size = (() => { try { return fs.statSync(resPath).size } catch { return 0 } })()
  if (size < state.offset) {
    state.offset = 0
    state.buffer = ''
  }

  const id = `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  fs.appendFileSync(cmdPath, JSON.stringify({ ...cmd, id, token }) + '\n', 'utf8')

  const timeoutMs = Number(process.env.QGIS_LIVE_FILE_TIMEOUT_MS) || FILE_CHANNEL_TIMEOUT_MS
  const resultsSizeAtStart = (() => { try { return fs.statSync(resPath).size } catch { return 0 } })()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('file channel: aborted')
    await delay(FILE_POLL_INTERVAL_MS)
    let chunk = ''
    try {
      const now = fs.statSync(resPath).size
      if (now > state.offset) {
        const len = now - state.offset
        const buf = Buffer.alloc(len)
        const fd = fs.openSync(resPath, 'r')
        try {
          fs.readSync(fd, buf, 0, len, state.offset)
        } finally {
          fs.closeSync(fd)
        }
        chunk = buf.toString('utf8')
        state.offset = now
      }
    } catch {
      continue
    }
    if (!chunk) continue
    const text = state.buffer + chunk
    const end = text.lastIndexOf('\n')
    if (end < 0) {
      state.buffer = text
      continue
    }
    state.buffer = text.slice(end + 1)
    for (const raw of text.slice(0, end).split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (!obj || obj.id !== id) continue
      if (obj.error) {
        throw new Error(tidyError(typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error)))
      }
      return obj.result
    }
  }
  badLiveDirs.add(liveDir)
  const grew = (() => { try { return fs.statSync(resPath).size - resultsSizeAtStart } catch { return -1 } })()
  throw new Error(
    `file channel timeout ${Math.round(timeoutMs / 1000)}s (id=${id})` +
    (grew > 0
      ? ' — results.jsonl grew but no matching reply (another client?)'
      : ' — QGIS did not read the command (dead process, plugin disabled, or stale live_dir)'))
}

/** Turn a Python traceback into one actionable line. */
function tidyError(input) {
  let message = typeof input === 'string' ? input : String(input == null ? '' : input)
  if (!/Traceback \(most recent call last\)/.test(message)) return message
  const lines = message.split(/\r?\n/)
  let exc = ''
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) { exc = lines[i].trim(); break }
  }
  let frame = ''
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*File "/.test(lines[i])) { frame = lines[i].trim().replace(/^File "([^"]+)", line (\d+).*$/, '$1:$2'); break }
  }
  const m = exc.match(/^([A-Za-z_][\w.]*):\s*([\s\S]*)$/)
  const type = m ? m[1] : ''
  const body = m ? m[2].trim() : exc
  const hints = {
    KeyError: 'object not found — use the matching list action',
    IndexError: 'index out of range — check action=info',
    NameError: 'missing parameter',
    AttributeError: 'API differs on QGIS 4 — see DETAIL.md',
    TypeError: 'argument type mismatch (numbers as numbers, booleans as true/false)',
    ValueError: 'invalid value — check the enum/range',
    ImportError: 'module unavailable',
    ModuleNotFoundError: 'module unavailable',
    QgsNotSupportedException: 'needs a GUI session',
    QgsProcessingException: 'incomplete algorithm parameters — try action=help',
  }
  const patterns = [
    [/layer not found|no layer named/i, 'use qgis_layer action=list'],
    [/layout not found|no layout named/i, 'use qgis_layout action=list'],
    [/field .*not found|field not found/i, 'use qgis_layer action=fields'],
    [/no map canvas|requires a gui/i, 'needs GUI session'],
    [/permission denied|access is denied/i, 'file locked or no permission'],
    [/no such file|file not found|not exist/i, 'check path'],
    [/no value specified for parameter/i, 'use qgis_analysis action=help'],
    [/could not load source layer/i, 'check layer name'],
    [/processing plugin has not been loaded/i, 'restart QGIS'],
  ]
  let hint = ''
  for (const [re, text] of patterns) {
    if (re.test(body) || re.test(exc)) { hint = text; break }
  }
  if (!hint) hint = hints[type] || ''
  const head = type ? `${type}: ${body}` : exc
  let out = type ? `${type}: ${body}` : body
  if (hint) out += ` (${hint})`
  if (out.length > 160) out = out.slice(0, 156) + '...'
  return out
}

/** Call one endpoint and unwrap { result } / { error } over the target channel. */
async function callQgis(route, method, body, signal, target) {
  if (target && target.channel === 'file') {
    const cmd = routeToCommand(route, body)
    try {
      return await invokeFile(cmd, signal, target)
    } catch (e) {
      if (!/文件通道超时/.test(String(e && e.message))) throw e
      // The instance we picked did not answer; try the next live one once.
      let next = null
      try { next = findLocalLiveDir() } catch { next = null }
      if (next && next.liveDir !== target.liveDir) return invokeFile(cmd, signal, next)
      throw e
    }
  }
  const resp = await fetch(`${target.base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await resp.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: text || `HTTP ${resp.status}` } }
  if (resp.status === 401) throw new Error('QGIS auth failed: Key/token mismatch')
  if (data.error) {
    throw new Error(tidyError(typeof data.error === 'string' ? data.error : JSON.stringify(data.error)))
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
  async function resolveTarget(opts = {}) {
    if (remote) {
      try {
        const resp = await fetch(`${remote.base}/api/health`, {
          headers: { Authorization: `Bearer ${remote.token}` },
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        })
        if (resp.status === 401) throw new Error('QGIS auth failed: Key mismatch')
        if (resp.status !== 200) throw new Error(`远程 QGIS 不可用：${remote.base}/api/health → HTTP ${resp.status}`)
      } catch (e) {
        if (e instanceof Error && e.message.includes('凭证')) throw e
        if (e instanceof Error && e.name === 'TimeoutError') throw new Error(`无法连接远程 QGIS：${remote.base}（超时）`)
        throw new Error(`无法连接远程 QGIS：${remote.base}（${e.message}）`)
      }
      return remote
    }
    // Local: prefer the plugin's file channel (no port, no auth header).
    const requireGui = !!(opts && opts.gui)
    const local = findLocalLiveDir(0, requireGui)
    if (local) return local
    try {
      return await findActiveQgis(0, requireGui)
    } catch (localError) {
      const auto = resolveAutostart(config, requireGui)
      if (!auto) throw localError
      return await autostartQgis(auto, requireGui)
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
  // The legacy single-purpose tools are kept in this file for reference but are
  // no longer registered: `tools.js` registers the consolidated surface.
  const LEGACY_ENABLED = new Set()
  /** Legacy registration site: intentionally inert now that tools.js owns the surface. */
  const legacyRegister = () => null
  function registerTool(def) {
    if (!LEGACY_ENABLED.has(def.name)) return
    const spec = { ...def, output: stringOutput }
    const run = spec.execute
    spec.execute = async (args, exec) => {
      toolUsed = true
      return run(args, exec)
    }
    disposers.push(legacyRegister(spec))
  }

  /** Run one PyQGIS snippet synchronously (main thread) and unwrap its `result`. */
  async function runQgisSync(code, signal, opts) {
    const target = await resolveTarget(opts)
    return callQgis('/api/pyeval', 'POST', { code }, signal, target)
  }

  // ---- Generic PyQGIS tools ----

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
    name: 'qgis_list_algorithms',
    deferLoading: true,
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

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
    name: 'qgis_export_atlas',
    deferLoading: true,
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

  disposers.push(legacyRegister({
    name: 'qgis_create_layout',
    deferLoading: true,
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

  disposers.push(legacyRegister({
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

  registerTool({
    name: 'qgis_layout_add_item',
    description:
      '向打印版面添加一个版面要素（地图框 / 图例 / 比例尺 / 指北针 / 文本 / 矩形色块），位置与尺寸用毫米，' +
      '原点在页面左上角。地图框可按已有图层的范围自动适配长宽比。创建版面用 qgis_create_layout，导出用 qgis_export_layout。' +
      'kind 取值：map、legend、scalebar、north_arrow、text、rect。',
    parameters: {
      type: 'object',
      properties: {
        layout: { type: 'string', description: '目标版面名称（必填）。' },
        kind: {
          type: 'string',
          enum: ['map', 'legend', 'scalebar', 'north_arrow', 'text', 'rect'],
          description: '版面要素类型（必填）。',
        },
        x: { type: 'number', description: '左上角 X（mm）。' },
        y: { type: 'number', description: '左上角 Y（mm）。' },
        width: { type: 'number', description: '宽度（mm）。map 为地图框宽；legend 为图例宽；rect 为矩形宽。' },
        height: { type: 'number', description: '高度（mm）。map 省略时按 fit_layer 范围的长宽比自动算。' },
        fit_layer: {
          type: 'string',
          description: 'map 专用：按该图层的范围与长宽比设置地图框（并作为默认显示的图层）。',
        },
        layers: {
          type: 'array',
          items: { type: 'string' },
          description: 'map：要显示的图层名列表（默认只有 fit_layer）；legend：只保留这些图层的图例条目。',
        },
        text: { type: 'string', description: 'kind=text 时的文本内容，支持 \\n 换行。' },
        size: { type: 'number', description: 'text 字号（pt，默认 10）；north_arrow 尺寸（mm，默认 10）。' },
        bold: { type: 'boolean', description: 'text 是否加粗。' },
        color: { type: 'string', description: 'text 字色（#rrggbb，默认 #1a1a1a）；rect 填充色（默认 #ffffff）。' },
        title: { type: 'string', description: 'legend 标题（默认“图例”）。' },
        segments: { type: 'number', description: 'scalebar 分段数（默认 2）。' },
        units_per_segment: { type: 'number', description: 'scalebar 每段长度（默认 50）。' },
        unit: { type: 'string', description: 'scalebar 单位：km 或 m（默认 km）。' },
        family: { type: 'string', description: 'text 字体（默认 Microsoft YaHei）。' },
        outline_color: { type: 'string', description: 'rect 边框色（默认无边框）。' },
        outline_width: { type: 'number', description: 'rect 边框宽度（mm，默认 0.3）。' },
      },
      required: ['layout', 'kind', 'x', 'y'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const P = {
        layout: String(args?.layout ?? ''),
        kind: String(args?.kind ?? ''),
        x: Number(args?.x ?? 0),
        y: Number(args?.y ?? 0),
        width: args?.width == null ? null : Number(args.width),
        height: args?.height == null ? null : Number(args.height),
        fit_layer: args?.fit_layer == null ? null : String(args.fit_layer),
        layers: Array.isArray(args?.layers) ? args.layers.map(String) : null,
        text: args?.text == null ? null : String(args.text),
        size: args?.size == null ? null : Number(args.size),
        bold: args?.bold === true,
        color: args?.color == null ? null : String(args.color),
        title: args?.title == null ? null : String(args.title),
        segments: args?.segments == null ? null : Number(args.segments),
        units_per_segment: args?.units_per_segment == null ? null : Number(args.units_per_segment),
        unit: args?.unit == null ? null : String(args.unit),
        family: args?.family == null ? null : String(args.family),
        outline_color: args?.outline_color == null ? null : String(args.outline_color),
        outline_width: args?.outline_width == null ? null : Number(args.outline_width),
      }
      const code = [
        'import json',
        `P = json.loads(${JSON.stringify(JSON.stringify(P))})`,
        'from qgis.core import (QgsProject, QgsLayoutItemMap, QgsLayoutItemLegend, QgsLayoutItemScaleBar,',
        '    QgsLayoutItemPicture, QgsLayoutItemLabel, QgsLayoutItemShape, QgsLayoutPoint, QgsLayoutSize,',
        '    QgsUnitTypes, QgsRectangle, QgsFillSymbol, QgsLegendStyle)',
        'from qgis.PyQt.QtGui import QColor, QFont',
        'MM = QgsUnitTypes.LayoutMillimeters',
        'lm = QgsProject.instance().layoutManager()',
        "lay = lm.layoutByName(P['layout'])",
        'if lay is None:',
        "    raise ValueError('layout not found: ' + P['layout'])",
        'kind = P[\'kind\']',
        'proj = QgsProject.instance()',
        'def find_layer(name):',
        '    ls = proj.mapLayersByName(name)',
        '    if not ls:',
        "        raise ValueError('layer not found: ' + name)",
        '    return ls[0]',
        'def first_map():',
        '    for it in lay.items():',
        '        if isinstance(it, QgsLayoutItemMap):',
        '            return it',
        '    return None',
        'item = None',
        'if kind == \'map\':',
        '    if P[\'width\'] is None:',
        "        raise ValueError('kind=map 需要 width')",
        '    w = float(P[\'width\'])',
        '    h = P[\'height\']',
        '    ext = None',
        '    fit = None',
        "    if P['fit_layer']:",
        "        fit = find_layer(P['fit_layer'])",
        '        e = fit.extent()',
        '        ext = QgsRectangle(e.xMinimum(), e.yMinimum(), e.xMaximum(), e.yMaximum())',
        '        if h is None:',
        '            h = w / (e.width() / e.height())',
        '    if h is None:',
        "        raise ValueError('kind=map 需要 height 或 fit_layer')",
        '    m = QgsLayoutItemMap(lay)',
        '    lay.addLayoutItem(m)',
        '    m.attemptMove(QgsLayoutPoint(float(P[\'x\']), float(P[\'y\']), MM))',
        '    m.attemptResize(QgsLayoutSize(w, float(h), MM))',
        "    names = P['layers'] or ([P['fit_layer']] if P['fit_layer'] else [])",
        '    ls = [find_layer(n) for n in names]',
        '    if ls:',
        '        m.setLayers(ls)',
        '        m.setKeepLayerSet(True)',
        '        m.setCrs(ls[0].crs())',
        '    if ext is not None:',
        '        m.zoomToExtent(ext)',
        '    m.invalidateCache()',
        '    item = m',
        "elif kind == 'legend':",
        '    lg_auto_off = True',
        "    if P['width'] is None:",
        "        raise ValueError('kind=legend 需要 width')",
        '    base = first_map()',
        '    lg = QgsLayoutItemLegend(lay)',
        '    if base is not None:',
        '        lg.setLinkedMap(base)',
        "    lg.setTitle(P['title'] if P['title'] else '图例')",
        '    lay.addLayoutItem(lg)',
        '    lg.attemptMove(QgsLayoutPoint(float(P[\'x\']), float(P[\'y\']), MM))',
        '    lg.attemptResize(QgsLayoutSize(float(P[\'width\']), float(P[\'height\'] or 30), MM))',
        '    lg.setAutoUpdateModel(False)',
        '    root = lg.model().rootGroup()',
        '    for ch in list(root.children()):',
        '        root.removeChildNode(ch)',
        "    for nm in (P['layers'] or []):",
        '        lss = QgsProject.instance().mapLayersByName(nm)',
        '        if lss:',
        '            root.addLayer(lss[0])',
        '    lg.setStyleFont(QgsLegendStyle.Style.Title, QFont(P[\'family\'] or \'Microsoft YaHei\', 10))',
        '    lg.setStyleFont(QgsLegendStyle.Style.Subgroup, QFont(P[\'family\'] or \'Microsoft YaHei\', 8))',
        '    lg.setStyleFont(QgsLegendStyle.Style.SymbolLabel, QFont(P[\'family\'] or \'Microsoft YaHei\', 8))',
        '    lg.updateLegend()',
        '    item = lg',
        "elif kind == 'scalebar':",
        '    sb = QgsLayoutItemScaleBar(lay)',
        '    base = first_map()',
        '    if base is not None:',
        '        sb.setLinkedMap(base)',
        "    sb.setStyle('Single Box')",
        "    sb.setUnits(QgsUnitTypes.DistanceKilometers if (P['unit'] or 'km') == 'km' else QgsUnitTypes.DistanceMeters)",
        "    sb.setUnitLabel(P['unit'] or 'km')",
        "    sb.setNumberOfSegments(int(P['segments'] or 2))",
        "    sb.setUnitsPerSegment(float(P['units_per_segment'] or 50))",
        '    sb.setFont(QFont(P[\'family\'] or \'Microsoft YaHei\', 8))',
        '    lay.addLayoutItem(sb)',
        '    sb.attemptMove(QgsLayoutPoint(float(P[\'x\']), float(P[\'y\']), MM))',
        '    item = sb',
        "elif kind == 'north_arrow':",
        '    na = QgsLayoutItemPicture(lay)',
        "    na.setPicturePath(':/images/north_arrows/layout_default_north_arrow.svg')",
        '    sz = float(P[\'size\'] or 10)',
        '    lay.addLayoutItem(na)',
        '    na.attemptMove(QgsLayoutPoint(float(P[\'x\']), float(P[\'y\']), MM))',
        '    na.attemptResize(QgsLayoutSize(sz, sz, MM))',
        '    item = na',
        "elif kind == 'text':",
        "    if not P['text']:",
        "        raise ValueError('kind=text 需要 text')",
        '    t = QgsLayoutItemLabel(lay)',
        "    t.setText(P['text'])",
        "    f = QFont(P['family'] or 'Microsoft YaHei', int(P['size'] or 10))",
        "    f.setBold(bool(P['bold']))",
        '    t.setFont(f)',
        "    t.setFontColor(QColor(P['color'] or '#1a1a1a'))",
        '    t.adjustSizeToText()',
        '    lay.addLayoutItem(t)',
        '    t.attemptMove(QgsLayoutPoint(float(P[\'x\']), float(P[\'y\']), MM))',
        '    item = t',
        "elif kind == 'rect':",
        "    if P['width'] is None or P['height'] is None:",
        "        raise ValueError('kind=rect 需要 width 和 height')",
        '    r = QgsLayoutItemShape(lay)',
        '    r.setShapeType(QgsLayoutItemShape.Shape.Rectangle)',
        "    props = {'color': P['color'] or '#ffffff'}",
        "    if P['outline_color']:",
        "        props['outline_color'] = P['outline_color']",
        "        props['outline_width'] = str(P['outline_width'] or 0.3)",
        '    else:',
        "        props['outline_style'] = 'no'",
        '    r.setSymbol(QgsFillSymbol.createSimple(props))',
        '    lay.addLayoutItem(r)',
        '    r.attemptMove(QgsLayoutPoint(float(P[\'x\']), float(P[\'y\']), MM))',
        '    r.attemptResize(QgsLayoutSize(float(P[\'width\']), float(P[\'height\']), MM))',
        '    item = r',
        'else:',
        "    raise ValueError('unknown kind: ' + kind)",
        'lay.refresh()',
        'def rect_of(it):',
        '    p = it.positionWithUnits(); s = it.sizeWithUnits()',
        '    return [round(p.x(), 1), round(p.y(), 1), round(s.width(), 1), round(s.height(), 1)]',
        "result = {'layout': lay.name(), 'kind': kind,",
        "          'rect': rect_of(item) if item is not None else None}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_layout_info',
    deferLoading: true,
    description:
      '列出一个打印版面的页面尺寸与全部版面要素（类型、位置、尺寸），用于在排版时确认坐标与已有元素。' +
      '不传 layout 时列出项目中所有版面名称。',
    parameters: {
      type: 'object',
      properties: {
        layout: { type: 'string', description: '版面名称；省略则返回所有版面名。' },
      },
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = args?.layout == null ? '' : String(args.layout)
      const code = [
        'import json',
        `NAME = json.loads(${JSON.stringify(JSON.stringify(name))})`,
        'from qgis.core import (QgsProject, QgsLayoutItemMap, QgsLayoutItemLegend, QgsLayoutItemScaleBar,',
        '    QgsLayoutItemPicture, QgsLayoutItemLabel, QgsLayoutItemShape, QgsLayoutItem, QgsUnitTypes)',
        'lm = QgsProject.instance().layoutManager()',
        "if not NAME:",
        "    result = {'layouts': [l.name() for l in lm.layouts()]}",
        'else:',
        '    lay = lm.layoutByName(NAME)',
        '    if lay is None:',
        "        raise ValueError('layout not found: ' + NAME)",
        '    pg = lay.pageCollection().pages()[0]',
        '    items = []',
        '    def rect_of(it):',
        '        p = it.positionWithUnits(); s = it.sizeWithUnits()',
        '        return [round(p.x(), 1), round(p.y(), 1), round(s.width(), 1), round(s.height(), 1)]',
        '    for it in lay.items():',
        '        if not isinstance(it, QgsLayoutItem):',
        '            continue',
        '        kind = type(it).__name__',
        "        d = {'index': len(items), 'uuid': it.uuid(), 'kind': kind, 'rect': rect_of(it)}",
        '        if isinstance(it, QgsLayoutItemMap):',
        "            d['layers'] = [l.name() for l in it.layers()]",
        '        if isinstance(it, QgsLayoutItemLabel):',
        "            d['text'] = it.text()[:60]",
        '        items.append(d)',
        "    result = {'layout': lay.name(), 'page': [round(pg.pageSize().width(), 1), round(pg.pageSize().height(), 1)], 'items': items}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_layout_update_item',
    deferLoading: true,
    description:
      '修改或删除版面里已有的要素：按 index（来自 qgis_layout_info 的 items[index]）定位，' +
      '可改位置/尺寸（毫米），或传 remove=true 删除。用于排版微调，避免重建整个版面。',
    parameters: {
      type: 'object',
      properties: {
        layout: { type: 'string', description: '版面名称（必填）。' },
        index: { type: 'integer', description: '要素序号（qgis_layout_info 返回的 index，必填）。' },
        x: { type: 'number', description: '新的左上角 X（mm，可选）。' },
        y: { type: 'number', description: '新的左上角 Y（mm，可选）。' },
        width: { type: 'number', description: '新的宽度（mm，可选）。' },
        height: { type: 'number', description: '新的高度（mm，可选）。' },
        remove: { type: 'boolean', description: '传 true 删除该要素。' },
      },
      required: ['layout', 'index'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const pyNum = (v) => (typeof v === 'number' && isFinite(v) ? String(v) : 'None')
      const layout = String(args?.layout ?? '').trim()
      const index = Number(args?.index)
      if (!layout) throw new Error('参数 layout 不能为空')
      if (!Number.isInteger(index) || index < 0) throw new Error('参数 index 必须是非负整数')
      const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)
      const code = [
        'import json',
        `NAME = json.loads(${JSON.stringify(JSON.stringify(layout))})`,
        `IDX = ${index}`,
        `X = ${pyNum(args?.x)}; Y = ${pyNum(args?.y)}`,
        `W = ${pyNum(args?.width)}; H = ${pyNum(args?.height)}`,
        `RM = ${args?.remove ? 'True' : 'False'}`,
        'from qgis.core import QgsProject, QgsLayoutItem, QgsLayoutPoint, QgsLayoutSize, QgsUnitTypes',
        'lm = QgsProject.instance().layoutManager()',
        'lay = lm.layoutByName(NAME)',
        'if lay is None:',
        "    raise ValueError('layout not found: ' + NAME)",
        'items = [it for it in lay.items() if isinstance(it, QgsLayoutItem)]',
        'if IDX >= len(items):',
        "    raise IndexError('item index out of range: %d >= %d' % (IDX, len(items)))",
        'it = items[IDX]',
        'if RM:',
        '    lay.removeLayoutItem(it)',
        "    result = {'removed': IDX, 'items': len([x for x in lay.items() if isinstance(x, QgsLayoutItem)])}",
        'else:',
        '    p = it.positionWithUnits(); s = it.sizeWithUnits()',
        '    nx = p.x() if X is None else float(X)',
        '    ny = p.y() if Y is None else float(Y)',
        '    nw = s.width() if W is None else float(W)',
        '    nh = s.height() if H is None else float(H)',
        '    it.attemptMove(QgsLayoutPoint(nx, ny, QgsUnitTypes.LayoutMillimeters))',
        '    it.attemptResize(QgsLayoutSize(nw, nh, QgsUnitTypes.LayoutMillimeters))',
        '    lay.refresh()',
        "    result = {'index': IDX, 'kind': type(it).__name__, 'rect': [round(nx,1), round(ny,1), round(nw,1), round(nh,1)]}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_layer_info',
    description:
      '读取一个图层的元数据：矢量图层返回几何类型、要素数、字段列表、坐标系与范围；' +
      '栅格图层返回波段数、行列数、像元大小、坐标系、范围与首波段统计（最小/最大/均值）。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层名称（必填）。' },
      },
      required: ['layer'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = String(args?.layer ?? '').trim()
      if (!name) throw new Error('参数 layer 不能为空')
      const code = [
        'import json',
        `NAME = json.loads(${JSON.stringify(JSON.stringify(name))})`,
        'from qgis.core import QgsProject, QgsRasterLayer, QgsVectorLayer, QgsWkbTypes',
        'ls = QgsProject.instance().mapLayersByName(NAME)',
        'if not ls:',
        "    raise ValueError('layer not found: ' + NAME)",
        'lyr = ls[0]',
        'e = lyr.extent()',
        "base = {'name': lyr.name(), 'valid': lyr.isValid(),",
        "        'crs': lyr.crs().authid() or lyr.crs().description(),",
        "        'extent': [round(e.xMinimum(), 1), round(e.yMinimum(), 1), round(e.xMaximum(), 1), round(e.yMaximum(), 1)]}",
        'if isinstance(lyr, QgsVectorLayer):',
        "    base['type'] = 'vector'",
        "    base['geometry'] = QgsWkbTypes.displayString(lyr.wkbType())",
        "    base['feature_count'] = lyr.featureCount()",
        "    base['fields'] = [{'name': f.name(), 'type': f.typeName()} for f in lyr.fields()]",
        'else:',
        "    base['type'] = 'raster'",
        "    base['width'] = lyr.width()",
        "    base['height'] = lyr.height()",
        "    base['bands'] = lyr.bandCount()",
        '    base[\'cell_size\'] = [round(lyr.rasterUnitsPerPixelX(), 3), round(lyr.rasterUnitsPerPixelY(), 3)]',
        '    st = lyr.dataProvider().bandStatistics(1)',
        "    base['band1'] = {'min': round(st.minimumValue, 3), 'max': round(st.maximumValue, 3), 'mean': round(st.mean, 3)}",
        'result = base',
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_set_layer_crs',
    deferLoading: true,
    description:
      '给图层指定坐标系（QGIS 里图层 CRS 为空会导致该图层在任何版面/画布里都不渲染）。' +
      'crs 可传 EPSG 代码（如 EPSG:4326）、proj 字符串，或整段 WKT。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层名称（必填）。' },
        crs: { type: 'string', description: '目标坐标系：EPSG:xxxx / proj 字符串 / WKT（必填）。' },
        set_project: { type: 'boolean', description: '同时设为工程坐标系（默认 false）。' },
      },
      required: ['layer', 'crs'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const name = String(args?.layer ?? '').trim()
      const crs = String(args?.crs ?? '').trim()
      if (!name || !crs) throw new Error('参数 layer 与 crs 不能为空')
      const code = [
        'import json',
        `P = json.loads(${JSON.stringify(JSON.stringify({ layer: name, crs, set_project: args?.set_project === true }))})`,
        'from qgis.core import QgsProject, QgsCoordinateReferenceSystem',
        'ls = QgsProject.instance().mapLayersByName(P[\'layer\'])',
        'if not ls:',
        "    raise ValueError('layer not found: ' + P['layer'])",
        'lyr = ls[0]',
        "s = P['crs']",
        "c = QgsCoordinateReferenceSystem()",
        "if s.upper().startswith('EPSG:'):",
        '    c = QgsCoordinateReferenceSystem(int(s.split(\':\')[1]))',
        "elif s.startswith('PROJCS') or s.startswith('GEOGCS') or s.startswith('PROJCRS') or s.startswith('GEOGCRS'):",
        '    c = QgsCoordinateReferenceSystem(); c.createFromWkt(s)',
        'else:',
        '    c = QgsCoordinateReferenceSystem(s)',
        'if not c.isValid():',
        "    raise ValueError('invalid crs: ' + s[:80])",
        'lyr.setCrs(c)',
        'lyr.triggerRepaint()',
        "if P['set_project']:",
        '    QgsProject.instance().setCrs(c)',
        "result = {'layer': lyr.name(), 'crs': c.authid() or c.description(), 'project_crs': (QgsProject.instance().crs().authid() or QgsProject.instance().crs().description())}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_set_labels',
    deferLoading: true,
    description:
      '给矢量图层开启标注：指定字段、字号、字色、描边（buffer）与放置方式。用于专题制图里的地名/站名标注。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层名称（必填）。' },
        field: { type: 'string', description: '用作标注的属性字段（必填）。' },
        size: { type: 'number', description: '字号 pt（默认 8）。' },
        color: { type: 'string', description: '字色 #rrggbb（默认 #000000）。' },
        buffer_size: { type: 'number', description: '描边宽度 mm（默认 0，0 表示不加描边）。' },
        buffer_color: { type: 'string', description: '描边颜色（默认 #ffffff）。' },
        placement: {
          type: 'string',
          enum: ['around_point', 'over_point', 'line', 'horizontal', 'curved'],
          description: '放置方式（默认 around_point）。',
        },
        enabled: { type: 'boolean', description: '传 false 可关闭标注（默认 true）。' },
      },
      required: ['layer', 'field'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const P = {
        layer: String(args?.layer ?? '').trim(),
        field: String(args?.field ?? '').trim(),
        size: args?.size == null ? 8 : Number(args.size),
        color: args?.color == null ? '#000000' : String(args.color),
        buffer_size: args?.buffer_size == null ? 0 : Number(args.buffer_size),
        buffer_color: args?.buffer_color == null ? '#ffffff' : String(args.buffer_color),
        placement: args?.placement == null ? 'around_point' : String(args.placement),
        enabled: args?.enabled !== false,
      }
      if (!P.layer || !P.field) throw new Error('参数 layer 与 field 不能为空')
      const code = [
        'import json',
        `P = json.loads(${JSON.stringify(JSON.stringify(P))})`,
        'from qgis.core import (QgsProject, QgsPalLayerSettings, QgsTextFormat, QgsTextBufferSettings,',
        '    QgsVectorLayerSimpleLabeling)',
        'from qgis.PyQt.QtGui import QColor, QFont',
        'ls = QgsProject.instance().mapLayersByName(P[\'layer\'])',
        'if not ls:',
        "    raise ValueError('layer not found: ' + P['layer'])",
        'lyr = ls[0]',
        "if not P['enabled']:",
        '    lyr.setLabeling(None)',
        '    lyr.setLabelsEnabled(False)',
        '    lyr.triggerRepaint()',
        "    result = {'layer': lyr.name(), 'labels': False}",
        'else:',
        '    ps = QgsPalLayerSettings()',
        "    ps.fieldName = P['field']",
        "    ps.placement = {'around_point': QgsPalLayerSettings.Placement.AroundPoint,",
        "                   'over_point': QgsPalLayerSettings.Placement.OverPoint,",
        "                   'line': QgsPalLayerSettings.Placement.Line,",
        "                   'horizontal': QgsPalLayerSettings.Placement.Horizontal,",
        "                   'curved': QgsPalLayerSettings.Placement.Curved}[P['placement']]",
        "    tf = QgsTextFormat()",
        "    tf.setFont(QFont('Microsoft YaHei')); tf.setSize(int(P['size']))",
        "    tf.setColor(QColor(P['color']))",
        "    if P['buffer_size']:",
        '        b = QgsTextBufferSettings(); b.setEnabled(True)',
        "        b.setSize(float(P['buffer_size'])); b.setColor(QColor(P['buffer_color']))",
        '        tf.setBuffer(b)',
        '    ps.setFormat(tf)',
        '    lyr.setLabeling(QgsVectorLayerSimpleLabeling(ps))',
        '    lyr.setLabelsEnabled(True)',
        '    lyr.triggerRepaint()',
        "    result = {'layer': lyr.name(), 'labels': True, 'field': P['field'], 'placement': P['placement']}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_select_by_location',
    deferLoading: true,
    description:
      '空间关系选择：按 source_layer 的几何与当前图层做空间谓词筛选，结果写入选择集。' +
      'predicate 支持 intersects / within / contains / touches / overlaps / crosses / disjoint；可选距离缓冲（米，限于投影坐标系）。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '要被选择的图层（必填）。' },
        source_layer: { type: 'string', description: '用作筛选依据的图层（必填）。' },
        predicate: {
          type: 'string',
          enum: ['intersects', 'within', 'contains', 'touches', 'overlaps', 'crosses', 'disjoint'],
          description: '空间谓词（默认 intersects）。',
        },
        distance: { type: 'number', description: '可选：依据几何先做缓冲的距离（图层单位，投影坐标下即米）。' },
        mode: { type: 'string', enum: ['new', 'add', 'remove'], description: '选择集模式（默认 new）。' },
      },
      required: ['layer', 'source_layer'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const P = {
        layer: String(args?.layer ?? '').trim(),
        source_layer: String(args?.source_layer ?? '').trim(),
        predicate: args?.predicate == null ? 'intersects' : String(args.predicate),
        distance: args?.distance == null ? null : Number(args.distance),
        mode: args?.mode == null ? 'new' : String(args.mode),
      }
      if (!P.layer || !P.source_layer) throw new Error('参数 layer 与 source_layer 不能为空')
      const code = [
        'import json',
        `P = json.loads(${JSON.stringify(JSON.stringify(P))})`,
        'from qgis.core import QgsProject, QgsFeatureRequest',
        'proj = QgsProject.instance()',
        'def L(n):',
        '    ls = proj.mapLayersByName(n)',
        '    if not ls:',
        "        raise ValueError('layer not found: ' + n)",
        '    return ls[0]',
        "target = L(P['layer']); src = L(P['source_layer'])",
        'geoms = []',
        'for f in src.getFeatures():',
        '    g = f.geometry()',
        '    if g.isEmpty():',
        '        continue',
        "    if P['distance']:",
        "        g = g.buffer(float(P['distance']), 8)",
        '    geoms.append(g)',
        "pred = P['predicate']",
        'def hit(g):',
        '    for sg in geoms:',
        "        if pred == 'intersects' and g.intersects(sg): return True",
        "        if pred == 'within' and g.within(sg): return True",
        "        if pred == 'contains' and g.contains(sg): return True",
        "        if pred == 'touches' and g.touches(sg): return True",
        "        if pred == 'overlaps' and g.overlaps(sg): return True",
        "        if pred == 'crosses' and g.crosses(sg): return True",
        "        if pred == 'disjoint' and g.disjoint(sg): return True",
        '    return False',
        'ids = set()',
        'for f in target.getFeatures():',
        '    g = f.geometry()',
        '    if g.isEmpty():',
        '        continue',
        '    if hit(g):',
        '        ids.add(f.id())',
        'sel = QgsFeatureRequest().setFilterFids(list(ids)) if ids else QgsFeatureRequest().setFilterFids([])',
        "mode = P['mode']",
        "if mode == 'add':",
        '    target.selectByIds(list(ids))',
        "elif mode == 'remove':",
        '    cur = set(target.selectedFeatureIds()) - ids',
        '    target.selectByIds(list(cur))',
        'else:',
        '    target.selectByIds(list(ids))',
        "result = {'layer': target.name(), 'predicate': pred, 'count': len(ids),",
        "          'mode': mode, 'selected_total': len(target.selectedFeatureIds())}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })

  registerTool({
    name: 'qgis_edit_fields',
    deferLoading: true,
    description:
      '字段编辑：action=add 新增字段；action=calculate 用表达式计算并写入（如 "pop / 1000"）；' +
      'action=delete 删除字段；action=rename 重命名字段。矢量图层专用。',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '图层名称（必填）。' },
        action: { type: 'string', enum: ['add', 'calculate', 'delete', 'rename'], description: '操作类型（必填）。' },
        field: { type: 'string', description: '字段名（必填）：add/calculate 用目标字段名，delete/rename 用现有字段名。' },
        field_type: { type: 'string', enum: ['string', 'integer', 'double', 'date', 'datetime'], description: 'add 时字段类型（默认 double）。' },
        expression: { type: 'string', description: 'calculate 时的 QGIS 表达式（必填）。' },
        new_name: { type: 'string', description: 'rename 时的新字段名（必填）。' },
      },
      required: ['layer', 'action', 'field'],
    },
    output: stringOutput,
    async execute(args, exec) {
      const P = {
        layer: String(args?.layer ?? '').trim(),
        action: String(args?.action ?? '').trim(),
        field: String(args?.field ?? '').trim(),
        field_type: args?.field_type == null ? 'double' : String(args.field_type),
        expression: args?.expression == null ? '' : String(args.expression),
        new_name: args?.new_name == null ? '' : String(args.new_name),
      }
      if (!P.layer || !P.action || !P.field) throw new Error('参数 layer / action / field 均为必填')
      const code = [
        'import json',
        `P = json.loads(${JSON.stringify(JSON.stringify(P))})`,
        'from qgis.core import (QgsProject, QgsField, QgsExpression, QgsExpressionContext,',
        '    QgsExpressionContextUtils, QgsFeatureRequest)',
        'from qgis.PyQt.QtCore import QVariant',
        'proj = QgsProject.instance()',
        'ls = proj.mapLayersByName(P[\'layer\'])',
        'if not ls:',
        "    raise ValueError('layer not found: ' + P['layer'])",
        'lyr = ls[0]',
        'dp = lyr.dataProvider()',
        "act = P['action']",
        "idx = lyr.fields().indexOf(P['field'])",
        "if act == 'add':",
        "    if idx >= 0:",
        "        raise ValueError('field already exists: ' + P['field'])",
        "    tname = {'string': QVariant.String, 'integer': QVariant.Int, 'double': QVariant.Double,",
        "             'date': QVariant.Date, 'datetime': QVariant.DateTime}[P['field_type']]",
        "    dp.addAttributes([QgsField(P['field'], tname)])",
        '    lyr.updateFields()',
        "elif act == 'calculate':",
        "    if idx < 0:",
        "        raise ValueError('field not found: ' + P['field'])",
        "    expr = QgsExpression(P['expression'])",
        '    if expr.hasParserError():',
        "        raise ValueError('invalid expression: ' + expr.parserErrorString())",
        "    ctx = QgsExpressionContext()",
        '    ctx.appendScopes(QgsExpressionContextUtils.globalProjectLayerScopes(lyr))',
        '    updates = {}',
        '    n = 0',
        '    for f in lyr.getFeatures():',
        '        ctx.setFeature(f)',
        '        v = expr.evaluate(ctx)',
        '        updates[f.id()] = {idx: v}',
        '        n += 1',
        '    dp.changeAttributeValues(updates)',
        "    lyr.triggerRepaint()",
        "    result = {'layer': lyr.name(), 'action': act, 'updated': n}",
        "elif act == 'delete':",
        "    if idx < 0:",
        "        raise ValueError('field not found: ' + P['field'])",
        '    dp.deleteAttributes([idx])',
        '    lyr.updateFields()',
        "elif act == 'rename':",
        "    if idx < 0:",
        "        raise ValueError('field not found: ' + P['field'])",
        "    if not P['new_name']:",
        "        raise ValueError('rename 需要 new_name')",
        "    dp.renameAttributes({idx: P['new_name']})",
        '    lyr.updateFields()',
        'else:',
        "    raise ValueError('unknown action: ' + act)",
        "result = {'layer': lyr.name(), 'action': act, 'field': P['field'], 'fields': [f.name() for f in lyr.fields()]}",
      ].join('\n')
      return asText(await runQgisSync(code, exec?.signal))
    },
  })


  // ---- P0 daily-workflow tools ----

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
    name: 'qgis_algorithm_help',
    deferLoading: true,
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

  disposers.push(legacyRegister({
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

  disposers.push(legacyRegister({
    name: 'qgis_export_layer',
    deferLoading: true,
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

  disposers.push(legacyRegister({
    name: 'qgis_set_extent',
    deferLoading: true,
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
      return asText(await runQgisSync(code, exec?.signal, { gui: true }))
    },
  }))

  disposers.push(legacyRegister({
    name: 'qgis_zoom_to_layer',
    deferLoading: true,
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
      return asText(await runQgisSync(code, exec?.signal, { gui: true }))
    },
  }))

  disposers.push(legacyRegister({
    name: 'qgis_screenshot',
    deferLoading: true,
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
      const result = await runQgisSync(code, exec?.signal, { gui: true })
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
      deferLoading: true,
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
    deferLoading: true,
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

  // ---- Client GUI: connection-status endpoint (read by the composer dock widget) ----

  /** Probe QGIS liveness WITHOUT autostarting (passive status check). */
  async function probeStatus() {
    const status = {
      dock: !!config?.dock,
      reveal: toolUsed,
      connected: false,
      channel: null,
      target: null,
      host: null,
      error: null,
      detail: null,
      headless: config?.headless !== false,
      gui: null,
      canLaunch: !!resolveAutostart(config),
    }
    if (remote) {
      status.target = 'remote'
      status.channel = 'http'
      status.host = remote.base.replace(/^http:\/\//, '')
      try {
        const resp = await fetch(`${remote.base}/api/health`, {
          headers: { Authorization: `Bearer ${remote.token}` },
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        })
        status.connected = resp.status === 200
        if (!status.connected) {
          status.error = resp.status === 401 ? '凭证已失效' : '远程不可达'
          status.detail = `远程 QGIS ${remote.base} → HTTP ${resp.status}`
        }
      } catch (e) {
        status.error = '远程不可达'
        status.detail = `远程 QGIS 不可用：${e && e.message ? e.message : e}`
      }
      return status
    }
    status.target = 'local'
    const local = findLocalLiveDir()
    if (local) {
      status.connected = true
      status.channel = 'file'
      status.host = local.host
      status.gui = !!local.gui
      status.detail = `文件通道：${local.liveDir}（${local.gui ? 'GUI' : '无头'}）`
      return status
    }
    status.channel = 'http'
    try {
      const t = await findActiveQgis()
      status.connected = true
      status.host = t.base.replace(/^http:\/\//, '')
      status.gui = !!t.gui
      status.detail = `HTTP 通道：${t.base}（${t.gui ? 'GUI' : '无头'}）`
    } catch (e) {
      status.error = '未检测到 QGIS'
      status.detail = e && e.message ? e.message : String(e)
    }
    return status
  }

  // Register a browser-readable status route (same-origin fetch from the client).
  // Optional + non-fatal: if `connection` is unavailable, the tools still work.
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (connection && connection.fetch && typeof connection.fetch.register === 'function') {
    try {
      const unregister = connection.fetch.register({
        path: '/api/dsh-qgis-driver/status',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const status = await probeStatus()
          return new Response(JSON.stringify(status), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      })
      if (typeof unregister === 'function') disposers.push(() => { unregister() })
    } catch (e) {
      // Non-fatal: the composer widget simply reports "not connected".
    }
  }

  // ---- Client GUI: config endpoint (read/write host/port/key/dock from Settings) ----
  // The client's Settings section has no config service, so it reads/writes through
  // this same-origin route. GET returns the current (resolved) config; POST persists
  // via configEditor.edit (which restarts the plugin so `apply` re-resolves remote).
  const configEditor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
  const configEntry = (ctx && ctx.fiber && ctx.fiber.entry) ? ctx.fiber.entry : undefined
  if (connection && connection.fetch && typeof connection.fetch.register === 'function') {
    try {
      const unregisterCfg = connection.fetch.register({
        path: '/api/dsh-qgis-driver/config',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const current = {
            host: (config && typeof config.host === 'string') ? config.host : '',
            port: (config && Number.isInteger(config.port)) ? config.port : 0,
            key: (config && typeof config.key === 'string') ? config.key : '',
            dock: !!config?.dock,
            headless: config?.headless !== false,
          }
          if (request.method !== 'POST') {
            return new Response(JSON.stringify(current), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          if (!configEditor || !configEntry) {
            return new Response(JSON.stringify({ ok: false, error: '配置编辑器不可用' }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            })
          }
          let body = {}
          try { body = await request.json() } catch { /* keep defaults */ }
          const host = (typeof body.host === 'string') ? body.host : current.host
          const rawPort = Number(body.port)
          const port = (Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535) ? rawPort : current.port
          const key = (typeof body.key === 'string') ? body.key : current.key
          const dock = (typeof body.dock === 'boolean') ? body.dock : current.dock
          const headless = (typeof body.headless === 'boolean') ? body.headless : current.headless
          try {
            await configEditor.edit(configEntry, (prev) => ({ ...(prev || {}), host, port, key, dock, headless }))
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          } catch (e) {
            return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          }
        },
      })
      if (typeof unregisterCfg === 'function') disposers.push(() => { unregisterCfg() })
    } catch (e) {
      // Non-fatal: the Settings section simply reports "config unavailable".
    }
  }

  // ---- Client GUI: launch endpoint (click the red badge to start QGIS) ----
  // POST starts the autostart command in the background; the widget keeps polling
  // `/status` until it turns green.
  let launching = false
  if (connection && connection.fetch && typeof connection.fetch.register === 'function') {
    try {
      const unregisterLaunch = connection.fetch.register({
        path: '/api/dsh-qgis-driver/launch',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          const now = findLocalLiveDir()
          if (now) {
            return new Response(JSON.stringify({ started: false, connected: true }), {
              status: 200, headers: { 'content-type': 'application/json' },
            })
          }
          if (launching) {
            return new Response(JSON.stringify({ started: true, connected: false, pending: true }), {
              status: 200, headers: { 'content-type': 'application/json' },
            })
          }
          const auto = resolveAutostart(config)
          if (!auto) {
            return new Response(JSON.stringify({
              started: false,
              error: '未配置自动启动（config.autostart.command 或 QGIS_LIVE_AUTOSTART_CMD）',
            }), { status: 400, headers: { 'content-type': 'application/json' } })
          }
          launching = true
          autostartQgis(auto).catch(() => {}).finally(() => { launching = false })
          return new Response(JSON.stringify({ started: true, connected: false, pending: true }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        },
      })
      if (typeof unregisterLaunch === 'function') disposers.push(() => { unregisterLaunch() })
    } catch (e) {
      // Non-fatal: the widget falls back to reporting the connection only.
    }
  }

  const registerLive = (def) => {
    const spec = { ...def, output: stringOutput }
    const impl = spec.execute
    spec.execute = async (args, exec) => {
      toolUsed = true
      return impl(args, exec)
    }
    disposers.push(ctx.tools.register(spec))
  }

  registerConsolidatedTools({
    registerTool: registerLive,
    run: runQgisSync,
    runCmd: (type, args, signal) => runQgisCmd(type, args || {}, signal),
    callRaw: callQgis,
    resolve: resolveTarget,
    stringOutput,
    asText,
  })

  return () => { for (const d of disposers) if (typeof d === 'function') d() }
}
