// Batch shims must produce Python that actually parses.
//
// Every `layers[]` / `layouts[]` / `runs[]` call is rewritten by batchBody()
// into a loop around the single-action body. That rewrite used to inline the
// body at the loop's indentation, so the body landed inside whatever `if` came
// last (or raised IndentationError outright): the batch form was broken and the
// single form kept working, which is exactly the kind of bug that survives a
// manual smoke test. Here the real registrations are captured with stub
// dependencies, each batch action is executed, and the generated source is
// parsed by a real interpreter when one is available.
//
// Run: ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness.exe" dsh-tools/tests/batch.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

import { registerConsolidatedTools } from '../tools.js'

const specs = []
let code = ''
registerConsolidatedTools({
  registerTool: (spec) => specs.push(spec),
  run: async (src) => {
    code = String(src)
    return '{}'
  },
  runCmd: async () => ({ ok: true }),
  stringOutput: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  asText: (v) => (typeof v === 'string' ? v : JSON.stringify(v)),
  jsonSafeString: (v) => JSON.stringify(v),
  scope: 'danger',
  restartInstance: () => ({ stopped: true }),
})

const tool = (name) => {
  const found = specs.find((s) => s.name === name)
  assert.ok(found, `tool ${name} is not registered`)
  return found
}

const PYTHON = [
  'H:/QGIS/apps/Python312/python.exe',
  'C:/OSGeo4W/apps/Python312/python.exe',
  'python3',
  'python',
].find((p) => {
  if (p.includes('/')) return fs.existsSync(p)
  const probe = spawnSync(p, ['-c', 'pass'], { encoding: 'utf8' })
  return probe.status === 0
})

function parses(src) {
  if (!PYTHON) return null
  const file = 'C:/Users/Dell/AppData/Local/Temp/_batch_check.py'
  fs.writeFileSync(file, `${PRELUDE()}\n${src}`, 'utf8')
  const res = spawnSync(PYTHON, ['-c', `import ast,sys; ast.parse(open(r'${file}',encoding='utf-8').read())`], {
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(String(res.stderr || '').split('\n').slice(-3).join(' '))
  return true
}

// The shim is prepended by the transport at run time; only names that the
// shim itself defines are needed to parse the batch scaffolding.
function PRELUDE() {
  return [
    'import json, os, shutil, tempfile, time, secrets, base64',
    'class QgsVectorLayer: pass',
    'prj = None',
    "P = json.loads('{}')",
    'def L(*a, **k): pass',
    'def _publish(*a, **k): pass',
  ].join('\n')
}

const cases = [
  ['qgis_layer', 'add', { paths: [{ path: 'a.gpkg' }, { path: 'b.gpkg' }] }],
  ['qgis_layer', 'export', { layers: ['a', 'b'], path: 'out/x.geojson' }],
  ['qgis_layer', 'style', { layers: ['a', 'b'], color: '#ff0000' }],
  ['qgis_layer', 'symbol', { layers: ['a', 'b'], size: 3 }],
  ['qgis_layer', 'classify', { layers: ['a', 'b'], field: 'f' }],
  ['qgis_feature', 'query', { layers: ['a', 'b'], limit: 5 }],
  ['qgis_feature', 'select', { layers: ['a', 'b'], expression: '1=1' }],
  ['qgis_feature', 'select_by_location', { layers: ['a'], source_layer: 'b', predicate: 'intersects' }],
  ['qgis_feature', 'update', { layers: ['a', 'b'], values: { f: 1 }, confirm: true }],
  ['qgis_feature', 'delete', { layers: ['a', 'b'], expression: '1=1', confirm: true }],
  ['qgis_layout', 'add_item', { layout_name: 'L1', items: [{ kind: 'map', width: 100 }, { kind: 'legend' }] }],
  ['qgis_layout', 'update_item', { layout_name: 'L1', updates: [{ index: 0, x: 10 }, { index: 1, remove: true }] }],
  ['qgis_layout', 'export', { layouts: ['L1', 'L2'], formats: ['png', 'pdf'] }],
  ['qgis_layout', 'export_atlas', { layouts: ['L1'], formats: ['png'] }],
  ['qgis_analysis', 'run', { runs: [{ algorithm: 'native:buffer', params: {} }, { algorithm: 'native:clip', params: {} }] }],
]

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

for (const [name, action, args] of cases) {
  let src = ''
  try {
    // eslint-disable-next-line no-await-in-loop
    await tool(name).execute({ action, ...args }, { agent: undefined })
    src = code
  } catch (e) {
    failed += 1
    process.stdout.write(`not ok - ${name} ${action} builds a shim\n  ${String(e && e.message).split('\n')[0]}\n`)
    continue
  }
  ok(`${name} ${action}: batch shim wraps the body in a function`, () => {
    assert.match(src, /\ndef _one_\(\):/, 'the body must live in its own function')
    assert.match(src, /_parts_\.append\(_one_\(\)\)/, 'the loop must call the function')
    assert.match(src, /result = \{'count'/, 'the loop must collect the results')
  })
  ok(`${name} ${action}: batch shim parses`, () => {
    const parsed = parses(src)
    if (parsed === null) return // no interpreter: the structural checks above still ran
    assert.equal(parsed, true)
  })
}

if (!PYTHON) {
  process.stdout.write('note: no Python interpreter found, parse checks were skipped\n')
}

process.stdout.write(`\n1..${checks}${failed ? ` — ${failed} failed` : ''}\n`)
process.exitCode = failed ? 1 : 0
