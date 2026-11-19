// The docs must not drift away from the code.
//
// Three places describe the same surface: the tool definitions in tools.js, the
// action table in skills/qgis-driver/SKILL.md, and the prose in docs/DETAIL.md.
// Only the first one is authoritative. This test reads the real registrations
// (with stub dependencies, no QGIS needed) and fails when a table, a required
// parameter or a write-lock entry no longer matches them.
//
// Run: ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness.exe" dsh-tools/tests/docdrift.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { registerConsolidatedTools, REQUIRED_ARGS, MUTATING } from '../tools.js'

const skillPath = new URL('../skills/qgis-driver/SKILL.md', import.meta.url)
const skill = fs.readFileSync(skillPath, 'utf8')

// ---- capture the real tool definitions without a live instance
const specs = []
registerConsolidatedTools({
  registerTool: (spec) => specs.push(spec),
  run: async () => '',
  runCmd: async () => '',
  stringOutput: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  asText: (v) => (typeof v === 'string' ? v : JSON.stringify(v)),
  jsonSafeString: (v) => JSON.stringify(v),
})

const actionsOf = (spec) => {
  const p = spec.parameters && spec.parameters.properties && spec.parameters.properties.action
  return (p && p.enum) || []
}

let checks = 0
let failed = 0

function ok(name, fn) {
  try {
    fn()
    checks += 1
    process.stdout.write(`ok ${checks} - ${name}\n`)
  } catch (e) {
    failed += 1
    process.stdout.write(`not ok - ${name}\n  ${String(e && e.message).split('\n')[0]}\n`)
  }
}

// ---- parse the action table from SKILL.md
// | `qgis_layer` | list / info / … |
const table = new Map()
for (const line of skill.split(/\r?\n/)) {
  if (!line.startsWith('| `')) continue
  const cells = line.split('|').map((c) => c.trim())
  const nameCell = cells[1] || ''
  if ((nameCell.match(/`/g) || []).length !== 2) continue // multi-tool row: prose, skip
  const tool = nameCell.replace(/`/g, '')
  const actions = (cells[2] || '').split('/').map((a) => a.trim()).filter(Boolean)
  if (actions.length) table.set(tool, new Set(actions))
}

ok('the SKILL.md action table lists the enumerable tools', () => {
  assert.ok(table.size >= 7, `parsed only ${table.size} rows`)
  assert.ok(table.has('qgis_layer'))
})

for (const spec of specs) {
  const actions = actionsOf(spec)
  if (!actions.length) continue
  ok(`${spec.name}: the action table matches the schema enum`, () => {
    const documented = table.get(spec.name)
    assert.ok(documented, `${spec.name} is missing from the SKILL.md action table`)
    const missing = actions.filter((a) => !documented.has(a))
    const extra = [...documented].filter((a) => !actions.includes(a))
    assert.deepEqual(missing, [], `not documented: ${missing.join(', ')}`)
    assert.deepEqual(extra, [], `documented but not in the schema: ${extra.join(', ')}`)
  })
}

ok('every required-parameter entry names a real action', () => {
  const byTool = new Map(specs.map((s) => [s.name, actionsOf(s)]))
  for (const key of Object.keys(REQUIRED_ARGS)) {
    const [tool, action] = key.split(':')
    const actions = byTool.get(tool)
    assert.ok(actions, `REQUIRED_ARGS mentions unknown tool ${tool}`)
    assert.ok(actions.includes(action), `REQUIRED_ARGS mentions unknown action ${tool} ${action}`)
  }
})

ok('every write-lease entry names a real action', () => {
  const byTool = new Map(specs.map((s) => [s.name, actionsOf(s)]))
  for (const [tool, entries] of Object.entries(MUTATING)) {
    const actions = byTool.get(tool)
    assert.ok(actions, `MUTATING mentions unknown tool ${tool}`)
    for (const entry of entries) {
      const action = typeof entry === 'string' ? entry : entry.action
      assert.ok(actions.includes(action), `MUTATING mentions unknown action ${tool} ${action}`)
    }
  }
})

ok('the tool table names every tool the bundle registers', () => {
  const documented = new Set([...table.keys()])
  const enumerated = specs.filter((s) => actionsOf(s).length).map((s) => s.name)
  for (const name of enumerated) assert.ok(documented.has(name), `${name} missing from the table`)
})

process.stdout.write(`\n1..${checks}${failed ? ` — ${failed} failed` : ''}\n`)
process.exitCode = failed ? 1 : 0
