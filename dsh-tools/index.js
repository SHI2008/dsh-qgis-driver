// dsh-qgis-driver — DSH Host bundle.
// Exposes a running QGIS (dsh_qgis_driver plugin) as three DSH tools over its REST API.
//
// Two connection modes:
//   1. Local discovery — newest ~/.qgis-live/<pid>-dsh_qgis_driver.json registry entry,
//      health-probed for liveness (uses the registry's host + Bearer session token).
//   2. Remote target — host + port + Key from cordis.patch.yml `config:` or the env
//      vars QGIS_LIVE_REMOTE_HOST / QGIS_LIVE_REMOTE_PORT / QGIS_LIVE_REMOTE_KEY
//      (the Key is the remote QGIS's QGIS_LIVE_API_KEY).
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
      const target = await resolveTarget()
      const result = await callQgis('/api/pyeval', 'POST', { code }, exec?.signal, target)
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

  return () => { for (const d of disposers) d() }
}
