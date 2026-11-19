// Live regression checks against a running QGIS instance (HTTP API).
//
// The pure suite covers argument handling; this covers the behaviours that only
// a real process can show: the instance write lease, the main-thread hard
// timeout, and the background task lifecycle. It never writes a project file and
// never leaves a lease behind.
//
// Run: ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness.exe" dsh-tools/tests/live.mjs
// Skips (exit 0) when no instance is registered.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function findInstance() {
  const dir = path.join(os.homedir(), '.qgis-live')
  let names = []
  try { names = fs.readdirSync(dir) } catch { return null }
  const entries = names
    .filter((n) => n.endsWith('-dsh_qgis_driver.json'))
    .map((n) => {
      const file = path.join(dir, n)
      try { return { ...JSON.parse(fs.readFileSync(file, 'utf8')), file } } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => (b.started || 0) - (a.started || 0))
  return entries[0] || null
}

const instance = findInstance()
if (!instance) {
  process.stdout.write('no registered QGIS instance — skipped\n')
  process.exit(0)
}

const base = `http://${instance.host}:${instance.http_port}`
const headers = { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` }

async function cmd(body) {
  const res = await fetch(`${base}/api/cmd`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

let checks = 0
let failed = 0
function report(name, good, detail) {
  if (good) { checks += 1; process.stdout.write(`ok ${checks} - ${name}\n`) }
  else { failed += 1; process.stdout.write(`not ok - ${name}${detail ? `\n  ${detail}` : ''}\n`) }
}

const inst = await cmd({ type: 'status', token: instance.token })
report('instance answers status', inst.status === 200 && !!inst.body.result,
  JSON.stringify(inst.body).slice(0, 200))

// ---------- write lease
const owner = 'live-probe'
await cmd({ type: 'write_lock', op: 'release', owner, token: instance.token })
const free = await cmd({ type: 'write_lock', op: 'status', token: instance.token })
report('lease starts free', free.body.result && free.body.result.held === false,
  JSON.stringify(free.body).slice(0, 200))

const taken = await cmd({ type: 'write_lock', op: 'acquire', owner, reason: 'smoke', ttl: 30, token: instance.token })
report('acquire succeeds', taken.body.result && taken.body.result.ok === true,
  JSON.stringify(taken.body).slice(0, 200))

const blocked = await cmd({ type: 'write_lock', op: 'acquire', owner: 'someone-else', ttl: 30, token: instance.token })
report('a second writer is refused with the holder name',
  blocked.body.result && blocked.body.result.ok === false && blocked.body.result.owner === owner,
  JSON.stringify(blocked.body).slice(0, 200))

const wrongRelease = await cmd({ type: 'write_lock', op: 'release', owner: 'someone-else', token: instance.token })
report('only the holder can release',
  wrongRelease.body.result && wrongRelease.body.result.ok === false,
  JSON.stringify(wrongRelease.body).slice(0, 200))

const released = await cmd({ type: 'write_lock', op: 'release', owner, token: instance.token })
report('the holder releases', released.body.result && released.body.result.ok === true,
  JSON.stringify(released.body).slice(0, 200))

// ---------- main-thread hard timeout
// A runaway *loop* is the case that used to freeze the instance forever; a call
// blocked inside a C function (sleep, network) can only be stopped once it
// returns, so the loop is what this check pins.
const budget = Number(process.env.QGIS_LIVE_EVAL_TIMEOUT || 10)
const startedAt = Date.now()
const slow = await cmd({
  type: 'pyeval',
  code: `import time\ndeadline = time.time() + 120\nwhile time.time() < deadline:\n    pass\nresult = 'finished'`,
  token: instance.token,
})
const elapsed = (Date.now() - startedAt) / 1000
const text = JSON.stringify(slow.body)
report('a runaway loop is interrupted, not left running',
  /hard timeout/.test(text), text.slice(0, 240))
report(`the interruption lands near the budget (${budget}s, took ${elapsed.toFixed(1)}s)`,
  elapsed < budget + 3, `took ${elapsed.toFixed(1)}s`)

const alive = await cmd({ type: 'status', token: instance.token })
report('the instance survives the interruption', alive.status === 200 && !!alive.body.result,
  JSON.stringify(alive.body).slice(0, 160))

// ---------- background task lifecycle
const queued = await cmd({
  type: 'pyeval_group', max_workers: 1,
  tasks: [
    { name: 's1', code: 'import time\ntime.sleep(3)\nresult = "s1"' },
    { name: 's2', code: 'result = "s2"' },
  ],
  token: instance.token,
})
const tasks = (queued.body.result && queued.body.result.tasks) || []
report('a group returns one task id per shard', tasks.length === 2,
  JSON.stringify(queued.body).slice(0, 200))

if (tasks.length === 2) {
  const cancel = await cmd({
    type: 'task_cancel', task_ids: [tasks[1].task_id], token: instance.token,
  })
  const cancelled = (cancel.body.result && cancel.body.result.results) || []
  report('a queued shard cancels before it starts',
    cancelled.length === 1 && cancelled[0].cancelled === true,
    JSON.stringify(cancel.body).slice(0, 240))

  const poll = await cmd({ type: 'task_status', task_id: tasks[0].task_id, token: instance.token })
  report('the running shard keeps its own status',
    !!poll.body.result, JSON.stringify(poll.body).slice(0, 200))
}


// ---------- observability: the audit log is readable through the control surface
const audit = await cmd({ type: 'audit', op: 'tail', limit: 3, token: instance.token })
const auditResult = audit.body.result || {}
report('the audit log can be read back',
  Array.isArray(auditResult.entries) && auditResult.entries.length > 0
  && typeof auditResult.file === 'string',
  JSON.stringify(audit.body).slice(0, 240))

const errorsOnly = await cmd({ type: 'audit', op: 'error', limit: 5, token: instance.token })
const errEntries = (errorsOnly.body.result && errorsOnly.body.result.entries) || []
report('op=error returns only failures',
  errEntries.every((e) => e.ok === false),
  JSON.stringify(errEntries.slice(0, 1)).slice(0, 200))

const slowAudit = await cmd({ type: 'audit', op: 'slow', limit: 3, token: instance.token })
const slowEntries = (slowAudit.body.result && slowAudit.body.result.entries) || []
const sorted = slowEntries.every((e, i) => i === 0
  || Number(slowEntries[i - 1].ms || 0) >= Number(e.ms || 0))
report('op=slow sorts by duration', sorted, JSON.stringify(slowEntries.map((e) => e.ms)))

const status2 = await cmd({ type: 'status', token: instance.token })
report('status carries the call counters',
  Number.isInteger(status2.body.result && status2.body.result.calls)
  && 'last_error' in (status2.body.result || {}),
  JSON.stringify(status2.body.result).slice(0, 200))

process.stdout.write(`\n1..${checks}${failed ? ` — ${failed} failed` : ''}\n`)
process.exitCode = failed ? 1 : 0
