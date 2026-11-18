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
// Liveness probe. Node maps signal 0 to OpenProcess on Windows, which is safe.
// NEVER port this to Python as os.kill(pid, 0): on Windows 0 == CTRL_C_EVENT, so it
// sends Ctrl+C to the target and silently kills QGIS (no crash dump, no WER event).
// Use psutil.pid_exists(), tasklist, or Get-Process -Id for Python/PowerShell checks.
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
    if (reg.pid && !pidAlive(reg.pid)) {
      try { fs.unlinkSync(p) } catch { /* ignore */ }
      continue
    }
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
    if (reg.pid && !pidAlive(reg.pid)) {
      try { fs.unlinkSync(p) } catch { /* ignore */ }
      continue
    }
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

/** Read the last `maxBytes` of a file and test whether `needle` is present. */
function tailIncludes(file, needle, maxBytes) {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    if (len <= 0) return false
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, len, start) } finally { fs.closeSync(fd) }
    return buf.toString('utf8').includes(needle)
  } catch {
    return false
  }
}

/** Map a REST route + JSON body onto the plugin's command object. */
function routeToCommand(route, body) {
  if (route === '/api/pyeval') return { type: 'pyeval', code: body?.code }
  if (route === '/api/pyeval_async') return { type: 'pyeval_async', code: body?.code }
  if (route === '/api/pyeval_group') {
    return { type: 'pyeval_group', tasks: body?.tasks || [], max_workers: body?.max_workers }
  }
  if (route === '/api/cmd') return { ...(body || {}) }
  if (route === '/api/task_cancel') {
    return { type: 'task_cancel', task_id: body?.task_id, task_ids: body?.task_ids || [] }
  }
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
  if (target.pid && !pidAlive(target.pid)) {
    try { badLiveDirs.add(liveDir) } catch { /* ignore */ }
    throw new Error('QGIS instance is not running (restart QGIS)')
  }
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

  // Windows shared-mode append can lose a write racing the plugin's read: verify the id
  // landed, retry once, then fail fast instead of a 15s dead-wait.
  if (!tailIncludes(cmdPath, id, 8192)) {
    fs.appendFileSync(cmdPath, JSON.stringify({ ...cmd, id, token }) + String.fromCharCode(10), 'utf8')
    if (!tailIncludes(cmdPath, id, 8192)) {
      throw new Error('file channel: command did not reach commands.jsonl (QGIS dead or write denied)')
    }
  }
  const timeoutMs = Number(process.env.QGIS_LIVE_FILE_TIMEOUT_MS) || FILE_CHANNEL_TIMEOUT_MS
  const resultsSizeAtStart = (() => { try { return fs.statSync(resPath).size } catch { return 0 } })()
  const deadline = Date.now() + timeoutMs
  let lastLiveness = Date.now()
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('file channel: aborted')
    await delay(FILE_POLL_INTERVAL_MS)
    // Fail fast if the process died mid-command (avoids a full 15s silent wait).
    if (target.pid && Date.now() - lastLiveness >= 1000) {
      lastLiveness = Date.now()
      if (!pidAlive(target.pid)) {
        badLiveDirs.add(liveDir)
        throw new Error('QGIS instance exited mid-command (auto-retry on a live instance)')
      }
    }
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

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Output schema of one inline image, copied from the harness `read_image` tool:
 * a tool result may only carry an image as a durable attachment reference, so
 * this shape (minus `attachmentId` branding) is what `render` hands the model.
 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
    },
  },
}

/**
 * Output declaration for tools that can inline one preview image. The canonical
 * value is `{ text, note?, image? }`: `text` keeps the tool's ordinary JSON
 * result byte-for-byte, `note` explains why an opt-in inline was skipped, and
 * `image` is the attachment reference the harness turns into an image block.
 */
const inlineOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string' },
      note: { type: 'string' },
      image: IMAGE_VALUE_SCHEMA,
    },
  },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: value && value.text !== undefined ? String(value.text) : '' }]
    if (value && value.note) blocks.push({ type: 'text', text: String(value.note) })
    if (value && value.image) blocks.push({ type: 'image', attachment: value.image })
    return blocks
  },
}

/** Image file extension a tool result may name as its visual preview. */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i

/** First preview-image path found anywhere in a parsed tool result (batch results nest them). */
function findImagePath(value, depth = 0) {
  if (depth > 6) return undefined
  if (typeof value === 'string') return IMAGE_EXT_RE.test(value.trim()) ? value.trim() : undefined
  if (value === null || typeof value !== 'object') return undefined
  if (!Array.isArray(value) && typeof value.image_path === 'string' && IMAGE_EXT_RE.test(value.image_path)) {
    return value.image_path
  }
  const items = Array.isArray(value) ? value : Object.values(value)
  for (const item of items) {
    const hit = findImagePath(item, depth + 1)
    if (hit) return hit
  }
  return undefined
}

/**
 * Locate the preview image a tool result names. Results are JSON text, except
 * `qgis_map action=screenshot`, which returns a bare absolute PNG path.
 */
function findImagePathInText(text) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return undefined
  try {
    const parsed = JSON.parse(t)
    if (typeof parsed === 'string') return IMAGE_EXT_RE.test(parsed) ? parsed : undefined
    return findImagePath(parsed)
  } catch {
    return IMAGE_EXT_RE.test(t) ? t : undefined
  }
}

/** Strip branding and keep exactly the fields `IMAGE_VALUE_SCHEMA` admits. */
function imageValueFromRef(ref) {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : {
      originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height },
    }),
  }
}

/**
 * Check whether the calling route declares image input. Mirrors the harness
 * `read_image` gate: the exact routed provider/model must list `image`, because
 * an image block on a text-only request fails the whole provider call instead of
 * degrading to text.
 * @returns `{ ok: true }`, or `{ ok: false, why }` naming the reason.
 */
async function imageRouteCheck(ctx, exec) {
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    const llm = ctx.get('llm')
    if (!provider || !model || !llm) return { ok: false, why: 'the current model route could not be resolved' }
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    const modalities = info?.inputModalities
    if (!Array.isArray(modalities) || !modalities.includes('image')) {
      return { ok: false, why: `model "${model}" does not declare image input` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, why: `image capability check failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Wrap a tool so an opt-in `inline: true` argument additionally commits the PNG
 * preview named by the result's `image_path` to the attachment store and returns
 * an image block beside the unchanged JSON text. Everything else (including every
 * inline failure) degrades to the plain text result plus one explanatory note, so
 * image transport can never fail a QGIS call.
 */
function withInlineImages(ctx, def) {
  const impl = def.execute
  return {
    ...def,
    output: inlineOutput,
    async execute(args, exec) {
      const text = asText(await impl(args, exec))
      if (args?.inline !== true) return { text }
      const imagePath = findImagePathInText(text)
      if (!imagePath) return { text, note: 'inline=true had no effect: this result carries no image_path' }
      const route = await imageRouteCheck(ctx, exec)
      if (!route.ok) return { text, note: `inline skipped: ${route.why}; the preview is still at ${imagePath} (read_image can show it)` }
      const attachments = ctx.get('attachments')
      if (!attachments) return { text, note: `inline skipped: no attachment service is mounted; the preview is at ${imagePath}` }
      try {
        const data = await fs.promises.readFile(imagePath)
        const mediaType = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg'
          : /\.webp$/i.test(imagePath) ? 'image/webp'
            : /\.gif$/i.test(imagePath) ? 'image/gif' : 'image/png'
        const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType, name: path.basename(imagePath) })
        return { text, image: imageValueFromRef(ref) }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        return { text, note: `inline failed: ${detail}; the preview is at ${imagePath}` }
      }
    },
  }
}

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


  /** Run one PyQGIS snippet synchronously (main thread) and unwrap its `result`. */
  async function runQgisSync(code, signal, opts) {
    const target = await resolveTarget(opts)
    return callQgis('/api/pyeval', 'POST', { code }, signal, target)
  }

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
    const base = def.inlineImages === true ? withInlineImages(ctx, def) : def
    const spec = { ...base, output: base.output || stringOutput }
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
