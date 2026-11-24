// dsh-qgis-driver — DSH Host bundle.
// Exposes a running QGIS (dsh_qgis_driver plugin) as DSH tools over its REST API.
//
// One connection mode: the newest live instance on this machine, found through its
// ~/.qgis-live/<pid>-dsh_qgis_driver.json registry entry. Tools talk to it over the
// plugin's file channel (commands.jsonl/results.jsonl), falling back to its local
// HTTP port + Bearer session token.
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
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import { registerConsolidatedTools } from './tools.js'

export const name = 'dsh-qgis-driver'
export const inject = ['tools']

/** Permission scope names, widest last. `read` never touches the project or the disk. */
export const SCOPE_NAMES = ['read', 'write', 'danger']

/** Settings rendered as a form in DSH Settings (connection is always local). */
export const Config = z.object({
  dock: z.boolean().default(false),
  headless: z.boolean().default(true),
  // schemastery has no enum(); the value is validated by effectiveScope().
  scope: z.string().default('write'),
  // QGIS installation root (the folder holding apps/Python312/python.exe). Empty
  // means "find it": env vars, registry, Program Files, then a bounded sweep of
  // drive roots. Set it when QGIS lives somewhere those do not look.
  qgisRoot: z.string().default(''),
  // Semicolon-separated directories a write may land in; empty means anywhere.
  // The coarse scope says "may write"; these say "may write here".
  allowPaths: z.string().default(''),
  // Space- or comma-separated algorithm ids, `*` as a suffix wildcard
  // (`native:*`, `grass:r.watershed`); empty means any algorithm.
  allowAlgorithms: z.string().default(''),
})

/**
 * The scope the tools actually run under: QGIS_LIVE_SCOPE (tests/CI) wins over the
 * stored setting. The user flips the setting from the composer or from Settings.
 */
export function effectiveScope(config) {
  const env = String(process.env.QGIS_LIVE_SCOPE || '').trim().toLowerCase()
  if (SCOPE_NAMES.includes(env)) return env
  const stored = config && config.scope
  return SCOPE_NAMES.includes(stored) ? stored : 'write'
}

/**
 * The scope in force *right now*. Tools read this through a getter instead of
 * capturing config at registration time: turning the pill down to `read` must
 * take effect on the next call, not after a plugin reload. Reloading is what the
 * old behaviour effectively demanded, and nobody does that mid-conversation.
 */
let liveScope = 'write'

/** Current permission scope (read by every tool and by the status/config endpoints). */
export function currentScope() {
  return liveScope
}

/** Set the live scope; returns the value actually in force. */
export function setLiveScope(value) {
  const wanted = String(value || '').trim().toLowerCase()
  liveScope = SCOPE_NAMES.includes(wanted) ? wanted : 'write'
  return liveScope
}

/**
 * Live QGIS install root (empty = discover it). Same reasoning as `liveScope`:
 * saving the path in Settings must apply to the next autostart without a reload.
 */
let liveQgisRoot = ''

/** The install root the launcher would use right now, or '' when it auto-detects. */
export function currentQgisRoot() {
  return liveQgisRoot
}

/** Set the live install root; returns the trimmed value actually in force. */
export function setLiveQgisRoot(value) {
  liveQgisRoot = String(value || '').trim().replace(/^"|"$/g, '')
  return liveQgisRoot
}

/** Writable directories, as the operator typed them (empty = anywhere). */
export function effectiveAllowPaths(config) {
  const env = String(process.env.QGIS_LIVE_ALLOW_PATHS || '').trim()
  if (env) return env
  return String((config && config.allowPaths) || '').trim()
}

/** Algorithm filter, as the operator typed it (empty = any algorithm). */
export function effectiveAllowAlgorithms(config) {
  const env = String(process.env.QGIS_LIVE_ALLOW_ALGORITHMS || '').trim()
  if (env) return env
  return String((config && config.allowAlgorithms) || '').trim()
}

let liveAllowPaths = ''
let liveAllowAlgorithms = ''

export function currentAllowPaths() { return liveAllowPaths }
export function currentAllowAlgorithms() { return liveAllowAlgorithms }
export function setLiveAllowPaths(value) { liveAllowPaths = String(value || '').trim(); return liveAllowPaths }
export function setLiveAllowAlgorithms(value) { liveAllowAlgorithms = String(value || '').trim(); return liveAllowAlgorithms }

const REGISTRY_DIR = path.join(os.homedir(), '.qgis-live')

/**
 * Set to true as soon as any QGIS tool runs. The client status badge is hidden
 * by default and appears on its own after the first tool call (or when the
 * `dock` setting is turned on).
 */
let toolUsed = false
const HEALTH_TIMEOUT_MS = 2000

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

/**
 * Stop the registered instance and delete its registry file. The next tool call
 * autostarts a fresh process. This is the escape hatch for a wedged main thread:
 * a Python thread cannot be killed from inside, but the process can be ended.
 */
function restartInstance() {
  const local = findLocalLiveDir(0, false)
  let pid = local && local.pid
  let gui = !!(local && local.gui)
  let regPath = ''
  for (const { p } of registryCandidates(0)) {
    let reg
    try { reg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { continue }
    if (pid ? reg.pid === pid : !!reg.pid) {
      pid = reg.pid
      regPath = p
      gui = reg.gui === true
      break
    }
  }
  if (!pid) {
    throw new Error('restart: no QGIS instance is registered, so there is nothing to stop — the next tool call starts one.')
  }
  let stopped = false
  let note = ''
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, encoding: 'utf8' })
      stopped = r.status === 0
      if (!stopped) note = String(`${r.stderr || r.stdout || ''}`.trim()).slice(0, 200)
    } catch (e) {
      note = e && e.message ? e.message : String(e)
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
      stopped = true
    } catch (e) {
      note = e && e.message ? e.message : String(e)
    }
  }
  if (regPath) {
    try { fs.unlinkSync(regPath) } catch { /* the PID check skips it anyway */ }
  }
  return {
    pid,
    stopped,
    gui,
    note: note || undefined,
    next: 'the next tool call starts a fresh instance (a few seconds); unsaved project edits are lost',
  }
}

/** Find a live QGIS instance reachable over HTTP (fallback path). */async function findActiveQgis(startedAt = 0, requireGui = false) {
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
  throw new Error('no active QGIS instance (start QGIS with the dsh_qgis_driver plugin enabled)')
}

const DEFAULT_AUTOSTART_TIMEOUT_MS = 90000

/** True when `root` looks like a QGIS installation (the bundle needs its Python). */
function isQgisRoot(root) {
  try {
    return !!root && fs.existsSync(path.join(root, 'apps', 'Python312', 'python.exe'))
  } catch {
    return false
  }
}

/** Run one `reg query`; returns '' when the key or value does not exist. */
function regQuery(args) {
  try {
    const r = spawnSync('reg', args, { encoding: 'utf8', timeout: 4000, windowsHide: true })
    return r && r.status === 0 && r.stdout ? r.stdout : ''
  } catch {
    return ''
  }
}

let registryRootsCache = null

/**
 * Install roots the Windows registry knows about (best effort, once per process).
 *
 * Two shapes exist in the wild: the OSGeo4W installer writes `InstallRoot`, and a
 * QGIS build that registers an App Path gives the launcher itself. A plain QGIS
 * MSI usually leaves `InstallLocation` empty, so that key is not worth scanning —
 * when it does carry a path, `DisplayIcon`/`InstallLocation` are read here too.
 */
function registryQgisRoots() {
  if (registryRootsCache) return registryRootsCache
  const roots = []
  const push = (value) => {
    const v = String(value || '').trim().replace(/^"|"$/g, '')
    if (v) roots.push(v)
  }
  if (process.platform === 'win32') {
    for (const key of [
      'HKLM\\SOFTWARE\\OSGeo4W',
      'HKLM\\SOFTWARE\\WOW6432Node\\OSGeo4W',
      'HKCU\\SOFTWARE\\OSGeo4W',
    ]) {
      const m = /^\s*InstallRoot\s+REG_[A-Z_]+\s+(.+)$/m.exec(regQuery(['query', key]))
      if (m) push(m[1])
    }
    for (const exe of ['qgis.exe', 'qgis-ltr.exe', 'qgis-bin.exe']) {
      const out = regQuery([
        'query',
        `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
        '/ve',
      ])
      const m = /^\s+\(Default\)\s+REG_[A-Z_]+\s+(.+)$/m.exec(out)
      // <root>/bin/qgis-bin.exe → <root>
      if (m) push(path.dirname(path.dirname(m[1].trim().replace(/^"|"$/g, ''))))
    }
  }
  registryRootsCache = roots
  return roots
}

let driveRootsCache = null

/**
 * `<drive>:\\QGIS*` folders, e.g. an MSI installed to `E:\\QGIS 4.2.3`. A plain QGIS
 * MSI usually leaves its uninstall entry without a path, so the disk is the last
 * honest source. Each probe is capped, and the sweep stops at the first usable
 * root (or after ~3 s), so a dead network drive cannot hang a launch.
 */
function driveQgisRoots() {
  if (driveRootsCache) return driveRootsCache
  const roots = []
  if (process.platform === 'win32') {
    const started = Date.now()
    outer: for (let code = 67; code <= 90; code += 1) {
      if (Date.now() - started > 3000) break
      const drive = `${String.fromCharCode(code)}:\\`
      let out = ''
      try {
        const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'dir', '/b', '/ad', drive], {
          encoding: 'utf8', timeout: 1200, windowsHide: true,
        })
        out = r && r.status === 0 && r.stdout ? r.stdout : ''
      } catch {
        out = ''
      }
      for (const line of out.split(/\r?\n/)) {
        const name = line.trim()
        if (!/^QGIS/i.test(name)) continue
        const root = path.join(drive, name)
        roots.push(root)
        if (isQgisRoot(root)) break outer
      }
    }
  }
  driveRootsCache = roots
  return roots
}

/** Candidate QGIS installation roots (first hit wins). */
function findQgisRoot(manual) {
  const cands = []
  const want = String(manual || '').trim().replace(/^"|"$/g, '')
  if (want) cands.push(want)
  if (process.env.QGIS_ROOT) cands.push(process.env.QGIS_ROOT)
  if (process.env.QGIS_BIN) cands.push(path.dirname(path.dirname(process.env.QGIS_BIN)))
  if (process.env.QGIS_PREFIX_PATH) {
    // <root>/apps/qgis → <root>
    const p = process.env.QGIS_PREFIX_PATH.replace(/[\\/]+$/, '')
    cands.push(path.dirname(path.dirname(p)))
  }
  // The bundle only knows the Windows layout (apps/Python312/python.exe …). Elsewhere
  // we discover a running instance instead of guessing install paths.
  if (process.platform !== 'win32') {
    return cands.find((r) => {
      try {
        return r && fs.existsSync(r)
      } catch {
        return false
      }
    }) || null
  }
  cands.push(...registryQgisRoots())
  for (const base of [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env['ProgramFiles(x86)'],
  ]) {
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
    if (isQgisRoot(root)) return root
  }
  for (const root of driveQgisRoots()) {
    if (isQgisRoot(root)) return root
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

function launchBuiltin(mode, manualRoot) {
  const root = findQgisRoot(manualRoot)
  if (!root) {
    if (process.platform !== 'win32') {
      throw new Error(
        'QGIS not found: the built-in launcher is Windows-only. Start QGIS on this machine with the ' +
        'dsh_qgis_driver plugin enabled — the driver finds it through ~/.qgis-live — or set ' +
        'QGIS_LIVE_AUTOSTART_CMD to your own launch command.')
    }
    throw new Error(
      'QGIS not found: set the install root in this plugin\'s settings (QGIS install root — the folder ' +
      `that holds apps\\Python312\\python.exe), or QGIS_ROOT.` +
      (manualRoot ? ` Checked "${manualRoot}".` : ''))
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
  return {
    builtin: wantHeadless ? 'headless' : 'gui',
    timeoutMs: 120000,
    gui: !wantHeadless,
    qgisRoot: currentQgisRoot(),
  }
}

/** Launch QGIS (built-in launcher or a custom command), then wait for a fresh registry. */
async function autostartQgis(auto, requireGui = false) {
  const startedAt = Date.now()
  if (auto.builtin) {
    try {
      launchBuiltin(auto.builtin, auto.qgisRoot)
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
/**
 * Absolute ceiling for one file-channel call. The soft timeout above only
 * applies while the instance looks dead; a live instance working through a long
 * call may take this long before we stop waiting.
 */
const HARD_CAP_MS = 180000
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
  if (route === '/api/pyeval') return { type: 'pyeval', code: body?.code, timeout: body?.timeout }
  if (route === '/api/pyeval_async') return { type: 'pyeval_async', code: body?.code }
  if (route === '/api/pyeval_group') {
    return { type: 'pyeval_group', tasks: body?.tasks || [], max_workers: body?.max_workers }
  }
  if (route === '/api/cmd') return { ...(body || {}) }
  if (route === '/api/write_lock') {
    return { type: 'write_lock', op: body?.op || 'status', owner: body?.owner,
      reason: body?.reason, ttl: body?.ttl }
  }
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
function invokeFile(cmd, signal, target, timeoutMs) {
  const run = () => invokeFileOnce(cmd, signal, target, timeoutMs)
  const p = fileChain.then(run, run)
  fileChain = p.catch(() => {})
  return p
}

async function invokeFileOnce(cmd, signal, target, timeoutMsOverride) {
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
      throw describeFailure('unreachable')
    }
  }
  const timeoutMs = timeoutMsOverride || Number(process.env.QGIS_LIVE_FILE_TIMEOUT_MS) || FILE_CHANNEL_TIMEOUT_MS
  // The timeout above is a soft one: while the instance keeps beating we keep
  // waiting, because a long processing run blocks the GUI thread and used to be
  // reported as "QGIS died". The hard cap still ends a genuinely wedged call.
  const hardCapMs = Number(process.env.QGIS_LIVE_HARD_TIMEOUT_MS) || HARD_CAP_MS
  const startedAt = Date.now()
  const resultsSizeAtStart = (() => { try { return fs.statSync(resPath).size } catch { return 0 } })()
  let deadline = startedAt + timeoutMs
  let lastLiveness = Date.now()
  let beat = null
  while (Date.now() < deadline) {
    if (signal?.aborted) throw describeFailure('aborted')
    await delay(FILE_POLL_INTERVAL_MS)
    // Fail fast if the process died mid-command (avoids a full 15s silent wait).
    if (target.pid && Date.now() - lastLiveness >= 1000) {
      lastLiveness = Date.now()
      if (!pidAlive(target.pid)) {
        badLiveDirs.add(liveDir)
        throw describeFailure('dead')
      }
      // Alive and beating: extend the soft deadline instead of declaring death.
      beat = readHeartbeat(liveDir)
      if (beat && beat.ageMs < 5000) {
        const extended = Date.now() + 3000
        deadline = Math.min(Math.max(deadline, extended), startedAt + hardCapMs)
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
  const note = readHeartbeat(liveDir)
  const waited = Math.round((Date.now() - startedAt) / 1000)
  if (note && note.ageMs < 5000 && note.busy) {
    // Still working: say what it is doing, not that it is gone.
    throw describeFailure('busy', {
      waited,
      busyType: note.busy.type,
      busyId: note.busy.id === id ? null : note.busy.id,
      busyFor: Math.round(Date.now() / 1000 - (note.busy.since || note.ts)),
    })
  }
  if (note && note.ageMs < 5000) {
    throw describeFailure('stalled', { waited })
  }
  throw describeFailure('timeout', { seconds: waited, grew: grew > 0 })
}

/**
 * Read the driver's heartbeat. A plain worker thread writes it, so it keeps
 * ticking while the GUI thread is busy — that is what separates "working on a
 * long call" from "dead".
 */
function readHeartbeat(liveDir) {
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(liveDir, 'heartbeat.json'), 'utf8'))
    if (!hb || typeof hb.ts !== 'number') return null
    return { ...hb, ageMs: Math.max(0, Date.now() - hb.ts * 1000) }
  } catch {
    return null
  }
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
    KeyError: 'no such field or object — list it (action=list / action=fields); a new layer starts with no fields',
    IndexError: 'index out of range — check action=info',
    NameError: 'a name is undefined — typo, or a variable from an earlier call (calls do not share state)',
    AttributeError: 'API differs on QGIS 4 — see DETAIL.md',
    TypeError: 'argument type mismatch (numbers as numbers, booleans as true/false)',
    ValueError: 'bad value — the message names what was expected',
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
  // 400, not 160: our own validation messages carry the fix ("... drop them") and a
  // truncated message made a model retry the same wrong call.
  if (out.length > 400) out = out.slice(0, 396) + '...'
  return out
}

/** Edit distance, only used to suggest a nearby action name. */
function editDistance(a, b) {
  const s = String(a ?? ''); const t = String(b ?? '')
  const prev = new Array(t.length + 1)
  for (let j = 0; j <= t.length; j += 1) prev[j] = j
  for (let i = 1; i <= s.length; i += 1) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= t.length; j += 1) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (s[i - 1] === t[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[t.length]
}

/** Closest candidate within a small distance, or '' when nothing is close enough. */
function nearestName(value, names) {
  let best = ''
  let bestScore = Infinity
  for (const name of names) {
    const score = editDistance(value, name)
    if (score < bestScore) { bestScore = score; best = name }
  }
  const limit = Math.max(2, Math.floor(String(value ?? '').length / 2))
  return bestScore <= limit ? best : ''
}

/**
 * One failure vocabulary for both channels.
 *
 * The same thing (QGIS did not answer) used to read four different ways
 * depending on where it broke, so a model could not tell "retry" from "the
 * instance is gone". Every transport failure now carries a code plus a sentence
 * that says what happened and what to do next.
 */
function describeFailure(kind, detail = {}) {
  const seconds = detail.seconds ? `${detail.seconds}s` : 'the timeout'
  const text = {
    timeout: `no reply from QGIS within ${seconds} — the command was written but never answered, and the instance stopped beating. `
      + (detail.grew
        ? 'results.jsonl grew but no reply carried this id, so another client may be reading the same file. '
        : 'The process is probably gone or the plugin is disabled. ')
      + 'Run qgis_plugin action=status; a dead instance is restarted by the next call.',
    busy: `QGIS is still working, it is not dead: it has been busy for ${detail.busyFor || detail.waited}s `
      + `with ${detail.busyType || 'a call'}${detail.busyId ? ` (${detail.busyId})` : ''}, `
      + `so this call waited ${detail.waited}s and is still queued. `
      + 'Wait for that call to finish, then retry; do not restart the instance — '
      + 'that would throw away the work and the project state. Long jobs belong in submit_qgis_async.',
    stalled: `QGIS is alive but its GUI thread has not ticked for ${detail.waited}s — a Qt call is blocking it, `
      + 'which is not the same as dead. Retry once; if it repeats, qgis_plugin action=restart is the way out.',
    dead: 'the QGIS process exited while running this call — the next call starts a fresh instance, '
      + 'and anything unsaved in that project is gone.',
    unreachable: 'the command never reached commands.jsonl: nothing is reading that registry directory '
      + '(dead process, plugin disabled, or a stale live_dir). Run qgis_plugin action=status.',
    aborted: 'the call was cancelled before QGIS replied — nothing ran to completion, so re-run the tool if you still need the result.',
    auth: 'the instance rejected the session token (Key mismatch). This token belongs to the plugin, '
      + 'not to a setting you can pass; restart the QGIS process so it issues a new one.',
    network: `the instance's local port refused the connection${detail.base ? ` (${detail.base})` : ''}. `
      + 'The file channel is the primary path and usually still works; if it also fails, restart QGIS.',
  }[kind] || String(detail.message || kind)
  const error = new Error(text)
  error.code = String(kind).toUpperCase()
  return error
}

/** Rewrite a failure into something a model can act on without guessing. */
function explainFailure(def, action, error) {
  const raw = error && error.message ? error.message : String(error == null ? '' : error)
  const label = action ? `${def.name} ${action}` : def.name
  if (raw.startsWith(`${def.name} `) || raw.startsWith(`${def.name}:`)) return raw
  const props = def && def.parameters && def.parameters.properties ? def.parameters.properties : {}
  // A KeyError on a declared parameter means the call was incomplete, not that
  // an object is missing — say so instead of "object not found".
  const key = raw.match(/^KeyError:\s*['"]([^'"]+)['"]/)
  if (key && Object.prototype.hasOwnProperty.call(props, key[1])) {
    return `${label}: missing required parameter "${key[1]}" — pass it (or the matching batch list); see the tool description`
  }
  const body = raw.replace(/\n+/g, ' ').trim()
  return body ? `${label}: ${body}` : `${label} failed`
}

/** Reject an unknown action up front and label every failure with tool+action. */
function guardExecute(def) {
  const actions = (def.parameters && def.parameters.properties
    && def.parameters.properties.action && def.parameters.properties.action.enum) || []
  const inner = def.execute
  return async (args, exec) => {
    const action = args && args.action
    if (actions.length) {
      if (action == null || action === '') {
        throw new Error(`${def.name}: action is required — one of ${actions.join(', ')}`)
      }
      if (!actions.includes(action)) {
        const near = nearestName(action, actions)
        throw new Error(`${def.name}: unknown action "${action}"`
          + (near ? ` — did you mean "${near}"? valid actions: ${actions.join(', ')}`
            : `; valid actions: ${actions.join(', ')}`))
      }
    }
    const props = (def.parameters && def.parameters.properties) || {}
    const known = Object.keys(props)
    // The host hands us a frozen object, so normalize into a copy. A model without a reasoning
    // budget passes "layers": "roads" and "params": "{...}" as readily as the typed form; the
    // intent is unambiguous, so coerce instead of failing.
    const norm = { ...(args || {}) }
    const unknown = []
    for (const [key, value] of Object.entries(norm)) {
      if (!known.includes(key)) { unknown.push(key); continue }
      const schema = props[key] || {}
      if (schema.type === 'array' && value != null && !Array.isArray(value)) {
        norm[key] = [value]
      } else if (schema.type === 'object' && typeof value === 'string') {
        try { norm[key] = JSON.parse(value) } catch { /* leave it; the tool body reports */ }
      }
    }
    if (unknown.length) {
      const key = unknown[0]
      const near = nearestName(key, known)
      throw new Error(`${def.name}: unknown parameter "${key}"`
        + (near ? ` — did you mean "${near}"?` : '')
        + `; this tool takes: ${known.join(', ')}`)
    }
    for (const [key, schema] of Object.entries(props)) {
      if (key === 'action' || !schema || norm[key] == null) continue
      const allowed = Array.isArray(schema.enum) ? schema.enum
        : (schema.type === 'array' && schema.items && Array.isArray(schema.items.enum) ? schema.items.enum : null)
      if (!allowed) continue
      const values = Array.isArray(norm[key]) ? norm[key] : [norm[key]]
      for (const value of values) {
        if (typeof value !== 'string' || allowed.includes(value)) continue
        const near = nearestName(value, allowed)
        throw new Error(`${def.name} ${action}: invalid ${key} "${value}"`
          + (near ? ` — did you mean "${near}"?` : `; valid: ${allowed.join(', ')}`))
      }
    }
    try {
      return await inner(norm, exec)
    } catch (e) {
      throw new Error(explainFailure(def, action, e))
    }
  }
}

/** Call one endpoint and unwrap { result } / { error } over the target channel. */
async function callQgis(route, method, body, signal, target, timeoutMs) {
  if (target && target.channel === 'file') {
    const cmd = routeToCommand(route, body)
    try {
      return await invokeFile(cmd, signal, target, timeoutMs)
    } catch (e) {
      const code = e && e.code
      if (code !== 'TIMEOUT' && code !== 'DEAD' && code !== 'UNREACHABLE') throw e
      // The instance we picked did not answer; try the next live one once.
      let next = null
      try { next = findLocalLiveDir() } catch { next = null }
      if (next && next.liveDir !== target.liveDir) return invokeFile(cmd, signal, next, timeoutMs)
      throw e
    }
  }
  let resp
  try {
    resp = await fetch(`${target.base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (e) {
    if (signal?.aborted) throw describeFailure('aborted')
    throw describeFailure('network', { base: target.base })
  }
  const text = await resp.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: text || `HTTP ${resp.status}` } }
  if (resp.status === 401) throw describeFailure('auth')
  if (data.error) {
    throw new Error(tidyError(typeof data.error === 'string' ? data.error : JSON.stringify(data.error)))
  }
  return data.result
}

/** Normalize an arbitrary result value to text for the model. */
function asText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return clampResult(text)
}

/**
 * Truncate an oversized result and keep the whole thing on disk.
 *
 * Why: one `qgis_feature query` over a big layer can return megabytes, which the
 * model pays for on every later request. ops_bash solves the same problem by
 * keeping a bounded window and reporting the spill path, so do the same: the
 * head stays readable, the file keeps the rest, and the note says where.
 */
const MAX_RESULT_CHARS = Math.max(4000, Number(process.env.QGIS_LIVE_MAX_RESULT_CHARS) || 60000)

function clampResult(text) {
  if (typeof text !== 'string' || text.length <= MAX_RESULT_CHARS) return text
  let note
  try {
    const dir = path.join(os.tmpdir(), 'dsh-qgis-driver')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `result_${Date.now()}_${Math.random().toString(16).slice(2, 8)}.txt`)
    fs.writeFileSync(file, text, 'utf8')
    note = `\n… output truncated: ${text.length} characters total, the first ${MAX_RESULT_CHARS} are shown; `
      + `the full result is in ${file} (read it with the read tool, or narrow the call with limit/fields).`
  } catch (e) {
    note = `\n… output truncated: ${text.length} characters total, the first ${MAX_RESULT_CHARS} are shown.`
  }
  return text.slice(0, MAX_RESULT_CHARS) + note
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

/** Read the frontmatter of a bundled SKILL.md (name/description only). */
function parseSkillFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const meta = {}
  if (!match) return { meta, body: raw }
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: raw.slice(match[0].length) }
}

/** Every `skills/<name>/SKILL.md` shipped with this bundle, sorted by name. */
function loadBundledSkills() {
  let root
  try {
    root = fileURLToPath(new URL('./skills/', import.meta.url))
  } catch (e) {
    return []
  }
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (e) {
    return []
  }
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'SKILL.md')
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
      continue
    }
    const { meta, body } = parseSkillFrontmatter(raw)
    if (!body.trim()) continue
    skills.push({
      name: meta.name || entry.name,
      description: meta.description || '',
      file,
      resourceBase: { kind: 'directory', path: path.dirname(file).replaceAll('\\', '/') },
      content: body,
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Publish the bundle's own skill documents to the harness skill catalog.
 *
 * Without this the files under `skills/` ship but are invisible: an agent
 * would never load `qgis-driver` or `pyqgis-reference` and the knowledge in
 * them would be dead weight. Soft dependency — a harness without a skill
 * registry simply keeps its tools.
 */
function registerSkillProvider(ctx, disposers) {
  const registry = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!registry || typeof registry.registerProvider !== 'function') return
  const skills = loadBundledSkills()
  if (!skills.length) return
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const invocation = { modelInvocable: true, userInvocable: true }
  const provider = {
    name: 'qgis-driver',
    list: () => Promise.resolve(skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      invocation: { ...invocation },
      source: 'qgis-driver',
      provider: 'qgis-driver',
      rank: 600,
      locator: skill.file,
      path: skill.file,
      resourceBase: skill.resourceBase,
    }))),
    async get(candidate) {
      const skill = byName.get(candidate && candidate.name)
      if (!skill) throw new Error(`qgis-driver: unknown skill "${candidate && candidate.name}"`)
      return {
        name: skill.name,
        description: skill.description,
        invocation: { ...invocation },
        source: 'qgis-driver',
        provider: 'qgis-driver',
        resourceBase: skill.resourceBase,
        path: skill.file,
        content: skill.content,
      }
    },
  }
  const dispose = registry.registerProvider(() => provider)
  if (typeof dispose === 'function') disposers.push(dispose)
}

// Exported for the regression suite (dsh-tools/tests): these are the pieces that
// turn a model's arguments into a plugin command, and they are pure.
export const internals = {
  routeToCommand,
  tidyError,
  describeFailure,
  editDistance,
  nearestName,
  explainFailure,
  guardExecute,
  asText,
  parseSkillFrontmatter,
  loadBundledSkills,
  effectiveScope,
  currentScope,
  setLiveScope,
  restartInstance,
  findQgisRoot,
  isQgisRoot,
  registryQgisRoots,
  driveQgisRoots,
  currentQgisRoot,
  setLiveQgisRoot,
}

export function apply(ctx, config = {}) {
  const disposers = []
  // Seed the live scope from the stored setting; the config endpoint re-seeds it
  // whenever the user moves the pill, without waiting for a plugin reload.
  setLiveScope(effectiveScope(config))
  // Same for the install root: the launcher reads it through currentQgisRoot().
  setLiveQgisRoot(config?.qgisRoot)
  // Narrowing rules are live for the same reason the scope is: the operator may
  // tighten them mid-conversation and the next call must already obey them.
  setLiveAllowPaths(effectiveAllowPaths(config))
  setLiveAllowAlgorithms(effectiveAllowAlgorithms(config))

  /** Resolve the connection target: the local instance (file channel first). */
  async function resolveTarget(opts = {}) {
    // Prefer the plugin's file channel (no port, no auth header).
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
    // A heavy action may ask for a longer main-thread budget (layout export, long analysis);
    // the file channel then has to wait a little longer than that budget, not less.
    const budget = Number(opts && opts.budget) > 0 ? Number(opts.budget) : undefined
    const timeoutMs = budget ? budget * 1000 + 8000 : undefined
    return callQgis('/api/pyeval', 'POST', { code, timeout: budget }, signal, target, timeoutMs)
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
      scope: currentScope(),
      connected: false,
      channel: null,
      target: null,
      host: null,
      error: null,
      detail: null,
      headless: config?.headless !== false,
      gui: null,
      canLaunch: !!resolveAutostart(config),
      target: 'local',
    }
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
  // via configEditor.edit (which restarts the plugin so `apply` re-reads config).
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
            dock: !!config?.dock,
            headless: config?.headless !== false,
            scope: currentScope(),
            scopes: SCOPE_NAMES,
            qgisRoot: currentQgisRoot(),
            allowPaths: currentAllowPaths(),
            allowAlgorithms: currentAllowAlgorithms(),
            // What the launcher would use right now; null when nothing was found.
            detectedRoot: findQgisRoot(currentQgisRoot()),
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
          const dock = (typeof body.dock === 'boolean') ? body.dock : current.dock
          const headless = (typeof body.headless === 'boolean') ? body.headless : current.headless
          let scope = current.scope
          if (typeof body.scope === 'string') {
            const wanted = body.scope.trim().toLowerCase()
            if (!SCOPE_NAMES.includes(wanted)) {
              return new Response(JSON.stringify({ ok: false, error: `unknown scope "${body.scope}" (${SCOPE_NAMES.join('|')})` }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
              })
            }
            scope = wanted
          }
          const previous = currentScope()
          const previousRoot = currentQgisRoot()
          const previousPaths = currentAllowPaths()
          const previousAlgorithms = currentAllowAlgorithms()
          const allowPaths = (typeof body.allowPaths === 'string')
            ? body.allowPaths.trim() : previousPaths
          const allowAlgorithms = (typeof body.allowAlgorithms === 'string')
            ? body.allowAlgorithms.trim() : previousAlgorithms
          let qgisRoot = previousRoot
          if (typeof body.qgisRoot === 'string') {
            qgisRoot = body.qgisRoot.trim().replace(/^"|"$/g, '')
            if (qgisRoot && !isQgisRoot(qgisRoot)) {
              return new Response(JSON.stringify({
                ok: false,
                error: `that folder does not look like a QGIS installation: ${qgisRoot} ` +
                  `(expected ${path.join(qgisRoot, 'apps', 'Python312', 'python.exe')})`,
                detectedRoot: findQgisRoot(),
              }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
              })
            }
          }
          setLiveScope(scope)
          setLiveQgisRoot(qgisRoot)
          setLiveAllowPaths(allowPaths)
          setLiveAllowAlgorithms(allowAlgorithms)
          try {
            await configEditor.edit(configEntry, (prev) => ({
              ...(prev || {}), dock, headless, scope, qgisRoot, allowPaths, allowAlgorithms,
            }))
            return new Response(JSON.stringify({ ok: true, detectedRoot: findQgisRoot(qgisRoot) }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          } catch (e) {
            setLiveScope(previous)
            setLiveQgisRoot(previousRoot)
            setLiveAllowPaths(previousPaths)
            setLiveAllowAlgorithms(previousAlgorithms)
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
    const guarded = { ...def, execute: guardExecute(def) }
    const base = guarded.inlineImages === true ? withInlineImages(ctx, guarded) : guarded
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
    restartInstance,
    scope: currentScope,
    allowPaths: currentAllowPaths,
    allowAlgorithms: currentAllowAlgorithms,
    stringOutput,
    asText,
  })

  registerSkillProvider(ctx, disposers)

  return () => { for (const d of disposers) if (typeof d === 'function') d() }
}
