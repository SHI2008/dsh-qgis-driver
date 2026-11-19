// Chaos checks: the instance must survive the four ways a call can go wrong.
//
// The exam run showed the real cost of a wedged instance: one bad call turned
// every later call red. These checks pin the guarantee that a bad call stays one
// bad call — the pid must not change, and the next normal call must work.
//
// Run: ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness.exe" dsh-tools/tests/chaos.mjs
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

let failures = 0
let n = 0
function ok(cond, label, extra = '') {
  n += 1
  if (cond) process.stdout.write(`ok ${n} - ${label}\n`)
  else {
    failures += 1
    process.stdout.write(`not ok ${n} - ${label}${extra ? ` — ${extra}` : ''}\n`)
  }
}

async function cmd(body, timeoutMs = 60000) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/api/cmd`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal,
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = { raw: text } }
    return { status: res.status, data }
  } catch (e) {
    return { status: 0, data: { error: String(e && e.message || e) } }
  } finally {
    clearTimeout(timer)
  }
}

async function pid() {
  const r = await cmd({ type: 'status' })
  return r.data && r.data.result ? r.data.result.pid : null
}

const startPid = await pid()
ok(typeof startPid === 'number', 'instance reports a pid', String(startPid))

// 1. A long main-thread call is interrupted, not left running.
const slow = await cmd({
  type: 'pyeval', timeout: 2,
  code: 'import time\nt = time.time()\nwhile time.time() - t < 30: pass\nresult = "finished"',
}, 90000)
const slowError = String((slow.data && slow.data.error) || '')
ok(/hard timeout|stopped|longer than/i.test(slowError), 'a runaway call is interrupted', slowError.slice(0, 120))

// 2. The instance survives it — same pid, still answering.
ok(await pid() === startPid, 'the instance keeps its pid after a hard timeout')

// 3. Bootstrapping a second QGIS is refused instead of killing the instance.
const boot = await cmd({ type: 'pyeval', code: 'from qgis.core import QgsApplication\nq = QgsApplication([], False)\nq.initQgis()\nresult = 1' })
const bootError = String((boot.data && boot.data.error) || '')
ok(/refused|initQgis/i.test(bootError), 'initQgis() in a sync call is refused', bootError.slice(0, 120))
ok(await pid() === startPid, 'the instance keeps its pid after a refused bootstrap')

// 4. The same code through the async path is refused too (it would be worse there:
//    the singleton gets replaced from a worker thread while the GUI thread polls).
const task = await cmd({ type: 'pyeval_async', code: 'from qgis.core import QgsApplication\nQgsApplication([], False).initQgis()' })
const taskId = task.data && task.data.result && (task.data.result.task_id || task.data.result)
ok(typeof taskId === 'string' && taskId.length > 8, 'async bootstrap is accepted as a task', String(taskId))
let taskError = ''
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 250))
  const st = await cmd({ type: 'task_status', task_id: taskId })
  const v = st.data && st.data.result
  if (v && v.status && v.status !== 'running') { taskError = String(v.error || ''); break }
}
ok(/refused/i.test(taskError), 'the async bootstrap task fails with an explanation', taskError.slice(0, 120))
ok(await pid() === startPid, 'the instance keeps its pid after a refused async bootstrap')

// 5. Every refusal above leaves the instance fully usable.
const alive = await cmd({ type: 'pyeval', code: 'result = "still here"' })
ok((alive.data && alive.data.result) === 'still here', 'a normal call still works afterwards',
  JSON.stringify(alive.data).slice(0, 120))

// 6. The namespace a snippet expects is seeded by the instance itself, so a
//    client that forgets the prelude still gets `prj` instead of NameError.
const missing = await cmd({ type: 'pyeval', code: 'prj.mapLayersByName("nope")[0]' })
const missingError = String((missing.data && missing.data.error) || '')
ok(/IndexError|list index out of range/i.test(missingError),
  'a missing object is an IndexError, not NameError: prj', missingError.slice(-120))
ok(await pid() === startPid, 'the instance keeps its pid after a normal error')

process.stdout.write(`1..${n}\n`)
if (failures) {
  process.stdout.write(`# ${failures} check(s) failed\n`)
  process.exit(1)
}
