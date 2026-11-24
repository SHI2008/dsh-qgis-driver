// Replayable checks for the parts of the driver that need no QGIS instance.
//
// These are the fragments that decide whether a model's *first* call works: the
// endpoint mapping, the call-time guards, the required-parameter table, the
// batching rules, the write-lease table and the error text. Each of them broke
// at least once in a way only a live test caught, so pin them here.
//
// Run: ELECTRON_RUN_AS_NODE=1 "…/DeepSeek Harness.exe" dsh-tools/tests/pure.mjs
//   (or plain `node dsh-tools/tests/pure.mjs` where node is installed)
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { internals } from '../index.js'
import { MUTATING, isMutating, checkRequired, batchItems, batchBody, lockOwner, preflightBatch, SCOPES, DANGER_ACTIONS, WRITE_ACTIONS, scopeRefusal, assertScope, requiredScope, taskOutcome, pathAllowed, algorithmAllowed, allowRefusal, pendingShards, parseList, withExtent } from '../tools.js'

const {
  routeToCommand, tidyError, describeFailure, nearestName, guardExecute, asText,
  currentScope, setLiveScope,
  currentQgisRoot, setLiveQgisRoot,
  parseSkillFrontmatter,
} = internals

let checks = 0
let failed = 0

async function ok(name, fn) {
  try {
    await fn()
    checks += 1
    process.stdout.write(`ok ${checks} - ${name}\n`)
  } catch (e) {
    failed += 1
    process.stdout.write(`not ok - ${name}\n  ${String(e && e.message).split('\n')[0]}\n`)
  }
}

async function fails(name, fn, pattern) {
  try {
    await fn()
    failed += 1
    process.stdout.write(`not ok - ${name}\n  expected a rejection\n`)
  } catch (e) {
    const message = String((e && e.message) || e)
    if (pattern.test(message)) {
      checks += 1
      process.stdout.write(`ok ${checks} - ${name}\n`)
    } else {
      failed += 1
      process.stdout.write(`not ok - ${name}\n  got: ${message.split('\n')[0]}\n`)
    }
  }
}

// ---------- transport: what the model asked for -> what the plugin receives
await ok('pyeval endpoint carries the code and its budget', () => {
  assert.deepEqual(routeToCommand('/api/pyeval', { code: '1 + 1' }),
    { type: 'pyeval', code: '1 + 1', timeout: undefined })
  assert.deepEqual(routeToCommand('/api/pyeval', { code: 'x', timeout: 120 }),
    { type: 'pyeval', code: 'x', timeout: 120 })
})
await ok('write_lock endpoint keeps op/owner/ttl', () => {
  const got = routeToCommand('/api/write_lock', { op: 'acquire', owner: 'a', ttl: 120 })
  assert.equal(got.type, 'write_lock')
  assert.equal(got.op, 'acquire')
  assert.equal(got.owner, 'a')
  assert.equal(got.ttl, 120)
})
await ok('task cancel endpoint accepts a batch', () => {
  assert.deepEqual(routeToCommand('/api/task_cancel', { task_ids: ['x'] }),
    { type: 'task_cancel', task_id: undefined, task_ids: ['x'] })
})
await ok('task status endpoint parses the id', () => {
  assert.deepEqual(routeToCommand('/api/tasks/abc123', {}),
    { type: 'task_status', task_id: 'abc123' })
})
await fails('an unknown endpoint is refused instead of sent',
  () => routeToCommand('/api/nope', {}), /unsupported endpoint/)

// ---------- error text: the model has to be able to act on it
await ok('tracebacks collapse to one line with the exception type', () => {
  const tb = 'Traceback (most recent call last):\n  File "<pyeval>", line 3, in <module>\nKeyError: \'path\''
  assert.equal(tidyError(tb),
    "KeyError: 'path' (no such field or object — list it (action=list / action=fields); "
    + 'a new layer starts with no fields)')
})
await ok('a plain message passes through untouched', () => {
  assert.equal(tidyError('layer not found: roads'), 'layer not found: roads')
})
await ok('nearestName suggests the close action', () => {
  assert.equal(nearestName('listt', ['list', 'create', 'export']), 'list')
})
await ok('nearestName keeps quiet for a distant name', () => {
  assert.equal(nearestName('zzzzzzzz', ['list', 'create']), '')
})

// ---------- guards: fail before the round-trip, with a fixable sentence
const fakeDef = (over) => ({
  name: 'qgis_layer',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'export', 'add'] },
      format: { type: 'string', enum: ['geojson', 'gpkg'] },
      path: { type: 'string' },
    },
    required: ['action'],
  },
  execute: async () => 'ok',
  ...over,
})

await ok('a valid call passes through the guard unchanged', async () => {
  assert.equal(await guardExecute(fakeDef())({ action: 'list' }, {}), 'ok')
})
await fails('a missing action names the alternatives',
  () => guardExecute(fakeDef())({}, {}), /action is required/)
await fails('a mistyped action gets a suggestion',
  () => guardExecute(fakeDef())({ action: 'listt' }, {}), /did you mean "list"/)
await fails('a mistyped enum value gets a suggestion',
  () => guardExecute(fakeDef())({ action: 'export', format: 'geojosn' }, {}),
  /invalid format "geojosn" — did you mean "geojson"/)
await fails('a KeyError on a declared parameter is reported as missing',
  () => guardExecute(fakeDef({
    execute: async () => { throw new Error("KeyError: 'path'") },
  }))({ action: 'export' }, {}), /missing required parameter "path"/)

// ---------- required parameters per action
// The smallest call is `action` plus the object it acts on. `path` for an export, the
// layout for an export, the width of a map: all defaulted, so a model that forgets them
// still gets its file (see "make the minimal call" in DETAIL.md).
await fails('qgis_layer export without a layer is caught locally',
  () => checkRequired('qgis_layer', 'export', {}), /missing parameter "layer" or "layers"/)
await ok('one argument is enough for the common actions', () => {
  checkRequired('qgis_layer', 'export', { layer: 'roads' })
  checkRequired('qgis_layer', 'export', { layers: ['roads', 'rivers'] })
  checkRequired('qgis_layout', 'export', { layouts: ['A'] })
  checkRequired('qgis_layout', 'export', { layout: 'A' })
  checkRequired('qgis_layout', 'export', {})
})
await ok('an action with no table is never blocked', () => {
  checkRequired('qgis_layer', 'list', {})
})
// A batch list carries the per-item argument, so requiring it at the top level
// would reject the very form the description advertises.
await ok('a batch list satisfies the per-item requirement', () => {
  checkRequired('qgis_analysis', 'run', { runs: [{ algorithm: 'native:buffer', params: {} }] })
  checkRequired('qgis_layout', 'add_item', { layout_name: 'L', items: [{ kind: 'map' }] })
  checkRequired('qgis_layout', 'update_item', { layout_name: 'L', updates: [{ index: 0 }] })
  // …but without the list the parameter is still required.
  assert.throws(() => checkRequired('qgis_analysis', 'run', {}), /missing parameter "algorithm"/)
  assert.throws(() => checkRequired('qgis_layout', 'add_item', { layout_name: 'L' }), /missing parameter "kind"/)
})

// A batch runs item by item, so a bad item used to leave the earlier ones behind and
// the retry duplicated them. Preflight rejects the batch before anything changes.
await ok('a malformed batch item fails the batch before it changes anything', () => {
  assert.equal(preflightBatch('qgis_layout', 'add_item', [{ kind: 'map', width: 160 }, { kind: 'legend' }]), null)
  assert.match(
    preflightBatch('qgis_layout', 'add_item', [{ kind: 'map', width: 160 }, { kind: 'scalebar', width: 60 }]),
    /item 2: kind=scalebar sizes itself/)
  assert.equal(preflightBatch('qgis_layout', 'add_item', [{ kind: 'map' }]), null)
  assert.match(preflightBatch('qgis_layout', 'add_item', [{ kind: 'rect', width: 10 }]), /kind=rect needs width and height/)
  assert.equal(preflightBatch('qgis_layer', 'export', ['a']), null)
})

// ---------- write lease: which actions serialise
await ok('mutating actions take the lease, reads and exports do not', () => {
  assert.equal(isMutating('qgis_layer', 'add'), true)
  assert.equal(isMutating('qgis_layer', 'style'), true)
  assert.equal(isMutating('qgis_project', 'set_crs'), true)
  assert.equal(isMutating('qgis_layer', 'list'), false)
  assert.equal(isMutating('qgis_layer', 'export'), false)
  assert.equal(isMutating('qgis_map', 'render'), false)
})
await ok('restart is the only plugin action that changes the instance', () => {
  assert.equal(isMutating('qgis_plugin', 'restart', {}), false)
  assert.equal(requiredScope('qgis_plugin', 'restart', {}), 'danger')
  assert.equal(requiredScope('qgis_plugin', 'status', {}), 'read')
  assert.equal(requiredScope('qgis_plugin', 'log', {}), 'read')
})
await ok('the lease owner falls back to dsh outside an agent', () => {
  assert.equal(lockOwner(undefined), 'dsh')
  assert.equal(lockOwner({ agent: { name: 'lead' } }), 'lead')
})
await ok('every mutating entry names an action and an optional predicate', () => {
  for (const [tool, list] of Object.entries(MUTATING)) {
    assert.ok(tool.startsWith('qgis_'), tool)
    for (const entry of list) {
      assert.ok(typeof entry === 'string'
        || (entry.action && typeof entry.when === 'function'), tool)
    }
  }
})

// ---------- batching: one call, N round-trips collapsed
await ok('layer lists expand per layer', () => {
  assert.deepEqual(batchItems({ layers: ['A', 'B'] }, { key: 'layers', assign: 'layer' }),
    ['A', 'B'])
})
await ok('exports write one file per layer when a path is given', () => {
  const out = batchItems({ layers: ['A', 'B'], path: 'C:/tmp/out.geojson' },
    { key: 'layers', assign: 'layer', perPath: true })
  assert.deepEqual(out.map((x) => x.path), ['C:/tmp/out_A.geojson', 'C:/tmp/out_B.geojson'])
})
await ok('layout exports cross layouts with formats', () => {
  const out = batchItems({ layouts: ['A'], formats: ['png', 'pdf'] },
    { key: 'layouts', assign: 'layout', formats: true })
  assert.deepEqual(out, [{ layout: 'A', format: 'png' }, { layout: 'A', format: 'pdf' }])
})
await ok('an empty list means a single call, not zero calls', () => {
  assert.equal(batchItems({ layers: [] }, { key: 'layers', assign: 'layer' }), null)
})
await ok('the batch body clears the batched key per item', () => {
  const body = batchBody('result = 1', { key: 'layers', assign: 'layer' })
  assert.match(body, /_items_ = P\.get\('layers'\) or \[\]/)
  assert.match(body, /P\.pop\('layers', None\)/)
  assert.match(body, /P\['layer'\] = _it_/)
})

// ---------- output + skills
await ok('a feature query says whether it truncated', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.match(src, /'count': len\(rows\), 'limit': _lim, 'truncated': _trunc/)
  assert.match(src, /'total': int\(l\.featureCount\(\)\) if not expr else None, 'rows': rows/)
})

await ok('asText keeps strings and emits compact json', () => {
  assert.equal(asText('plain'), 'plain')
  assert.equal(asText({ a: 1 }), '{"a":1}')
})
await ok('an oversized result is truncated and spills to a file', () => {
  // ops_bash keeps a bounded window and reports where the rest went; one
  // feature query over a big layer would otherwise cost every later request.
  const huge = 'x'.repeat(70000)
  const out = asText(huge)
  assert.ok(out.length < huge.length, 'the result should shrink')
  assert.match(out, /output truncated: 70000 characters total/)
  const file = /the full result is in (.+?) \(/.exec(out)
  assert.ok(file, 'the note should name the spill file')
  assert.equal(fs.readFileSync(file[1], 'utf8').length, 70000)
  assert.equal(asText('short'), 'short')
})
await ok('skill frontmatter only exposes name and description', () => {
  const raw = '---\nname: demo\ndescription: does a thing\n---\n\nbody\n'
  const { meta, body } = parseSkillFrontmatter(raw)
  assert.deepEqual(meta, { name: 'demo', description: 'does a thing' })
  assert.equal(body.trim(), 'body')
  assert.deepEqual(parseSkillFrontmatter('no frontmatter').meta, {})
})


// ---------- versions
await ok('both version numbers are plain semver and the plugin lost its rc- prefix', () => {
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
  const pkg = JSON.parse(fs.readFileSync(new URL('../../dsh-tools/package.json', import.meta.url), 'utf8'))
  const meta = fs.readFileSync(new URL('../../qgis-plugin/metadata.txt', import.meta.url), 'utf8')
  const plugin = (meta.match(/^version=(.*)$/m) || [])[1] || ''
  assert.match(pkg.version, SEMVER)
  assert.match(plugin, SEMVER)
  assert.doesNotMatch(plugin, /^rc-/, 'QGIS reads this as a string, but a leading rc- reads as "release candidate of nothing"')
})

// ---------- transport failures
await ok('every transport failure carries one code and one actionable sentence', () => {
  const kinds = ['timeout', 'dead', 'unreachable', 'aborted', 'auth', 'network', 'busy', 'stalled']
  const messages = new Set()
  for (const kind of kinds) {
    const e = describeFailure(kind, { seconds: '15s', grew: false, base: 'http://127.0.0.1:1',
      waited: 20, busyType: 'pyeval', busyFor: 25 })
    assert.equal(e.code, kind.toUpperCase(), kind)
    assert.ok(e.message.length > 40, `${kind}: too terse to act on`)
    messages.add(e.message)
  }
  assert.equal(messages.size, kinds.length, 'kinds must not collapse into the same text')
})

await ok('a busy instance is never reported as a dead one', () => {
  // The GUI thread runs every command, so a long call blocks the queue. Saying
  // "dead" there is what made the model restart a working instance.
  const e = describeFailure('busy', { waited: 20, busyType: 'qgis_layout export', busyFor: 21 })
  assert.equal(e.code, 'BUSY')
  assert.match(e.message, /not dead/)
  assert.match(e.message, /qgis_layout export/)
  assert.match(e.message, /do not restart/)
  const stalled = describeFailure('stalled', { waited: 9 })
  assert.equal(stalled.code, 'STALLED')
  assert.match(stalled.message, /alive/)
  const timedOut = describeFailure('timeout', { seconds: 15, grew: false })
  assert.match(timedOut.message, /stopped beating/)
})

await ok('a timeout says what to do next, and names the other-client case', () => {
  const quiet = describeFailure('timeout', { seconds: '15s', grew: false })
  assert.match(quiet.message, /15s/)
  assert.match(quiet.message, /qgis_plugin action=status/)
  const busy = describeFailure('timeout', { seconds: '15s', grew: true })
  assert.match(busy.message, /another client/)
  assert.equal(quiet.code, 'TIMEOUT')
})

await ok('a transport failure is never mistaken for a tool bug', () => {
  const e = describeFailure('network', { base: 'http://127.0.0.1:58056' })
  assert.match(e.message, /127\.0\.0\.1:58056/)
  assert.match(e.message, /file channel is the primary path/)
})

// ---- permission scope -------------------------------------------------------
await ok('read scope allows looking and rendering, blocks writing and Python', () => {
  assert.equal(scopeRefusal('read', 'qgis_layer', 'list', {}), null)
  assert.equal(scopeRefusal('read', 'qgis_layer', 'info', {}), null)
  assert.equal(scopeRefusal('read', 'qgis_feature', 'query', {}), null)
  assert.equal(scopeRefusal('read', 'qgis_map', 'render', {}), null)
  assert.equal(scopeRefusal('read', 'qgis_plugin', 'log', { op: 'error' }), null)
  for (const [tool, action, args] of [
    ['qgis_layer', 'style', {}], ['qgis_layer', 'export', {}],
    ['qgis_layout', 'export', {}], ['qgis_feature', 'add', {}],
    ['qgis_analysis', 'run', {}], ['execute_qgis_sync', '', {}],
    ['submit_qgis_async', '', {}], ['qgis_layer', 'remove', {}],
  ]) {
    assert.match(String(scopeRefusal('read', tool, action, args)), /blocked/, `${tool} ${action}`)
  }
})

await ok('write scope is the default: edits pass, destruction and PyQGIS do not', () => {
  for (const [tool, action, args] of [
    ['qgis_layer', 'style', {}], ['qgis_layer', 'add', {}], ['qgis_layer', 'export', {}],
    ['qgis_layout', 'add_item', {}], ['qgis_analysis', 'run', {}], ['qgis_project', 'save', {}],
  ]) assert.equal(scopeRefusal('write', tool, action, args), null, `${tool} ${action}`)
  for (const [tool, action, args] of [
    ['qgis_layer', 'remove', {}], ['qgis_feature', 'delete', {}],
    ['qgis_project', 'open', {}], ['qgis_project', 'save_as', {}],
    ['qgis_plugin', 'restart', {}],
    ['execute_qgis_sync', '', {}], ['submit_qgis_async', '', {}],
  ]) assert.match(String(scopeRefusal('write', tool, action, args)), /blocked/, `${tool} ${action}`)
})

await ok('danger scope allows everything, including the escape hatches', () => {
  for (const [tool, action, args] of [
    ['qgis_layer', 'remove', {}], ['qgis_project', 'open', {}],
    ['qgis_plugin', 'restart', {}], ['execute_qgis_sync', '', {}],
    ['submit_qgis_async', '', {}],
  ]) assert.equal(scopeRefusal('danger', tool, action, args), null, `${tool} ${action}`)
})

await ok('a refusal says how to lift it, and that reads still work', () => {
  const msg = String(scopeRefusal('read', 'qgis_layer', 'style', {}))
  assert.match(msg, /qgis_layer style/)
  assert.match(msg, /current permission scope is "read"/)
  assert.match(msg, /composer scope selector/)
  // The bundle cannot pop a dialog, so the refusal must tell the model to ask.
  assert.match(msg, /ask_user_question/)
  assert.match(msg, /very next call/)
  assert.match(msg, /Reads, renders and the audit log are never blocked/)
  assert.throws(() => assertScope('read', 'qgis_layer', 'style', {}), (e) => e.code === 'SCOPE_DENIED')
})

await ok('the install root is discovered and the setting wins', () => {
  // A manual root must be a real QGIS install (apps/Python312/python.exe); a bogus
  // one is rejected by the config endpoint, and discovery still finds a real one.
  assert.equal(internals.isQgisRoot('C:\\definitely-not-qgis'), false)
  const found = internals.findQgisRoot()
  if (found) {
    assert.equal(internals.isQgisRoot(found), true)
    assert.equal(internals.findQgisRoot(found), found)
  }
})

await ok('the live install root applies without a plugin reload', () => {
  // Saving the path in Settings calls setLiveQgisRoot; the launcher reads
  // currentQgisRoot(). Trimming and de-quoting happen in one place.
  assert.equal(currentQgisRoot(), '')
  assert.equal(setLiveQgisRoot('  "H:\\QGIS" '), 'H:\\QGIS')
  assert.equal(currentQgisRoot(), 'H:\\QGIS')
  assert.equal(setLiveQgisRoot(''), '')
  assert.equal(currentQgisRoot(), '')
})

await ok('the live scope changes without a plugin reload', () => {
  // The pill writes through the config endpoint, which calls setLiveScope; tools
  // read currentScope(). If this ever regresses, switching to "read" would keep
  // letting writes through until the bundle is reloaded.
  assert.equal(currentScope(), 'write')
  assert.equal(setLiveScope('read'), 'read')
  assert.equal(currentScope(), 'read')
  assert.equal(setLiveScope('DANGER'), 'danger')
  assert.equal(setLiveScope('nonsense'), 'write')
  assert.equal(currentScope(), 'write')
})

await ok('the scope names are the three the config accepts', () => {
  assert.deepEqual(SCOPES, ['read', 'write', 'danger'])
  // A destructive action that nobody classified would fall through to "read".
  assert.ok(DANGER_ACTIONS.has('qgis_layer:remove'))
  assert.ok(WRITE_ACTIONS.has('qgis_layer:export'))
})

await ok('update_item needs an index or a uuid, not both-in-name-only', () => {
  // add_item no longer returns a stable index, so a uuid has to be accepted -
  // otherwise the documented flow ("use uuid with action=update_item") is refused
  // by our own guard before it reaches QGIS.
  checkRequired('qgis_layout', 'update_item', { layout: 'L', uuid: '{a-b}' })
  checkRequired('qgis_layout', 'update_item', { layout: 'L', index: 0 })
  assert.throws(() => checkRequired('qgis_layout', 'update_item', { layout: 'L' }),
                /missing parameter \"index\" or \"uuid\"/)
})

// The legend used to empty its model root to show only some layers. That root mirrors the
// project's layer tree, so the "empty" removed the project's layers (found in the field,
// by a probe that then saw an empty project). Keep the destructive call out of the source.
await ok('the legend never edits the live layer-tree root', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.equal(/removeChildNode\(/.test(src), false,
               'editing the live root removes the project layers — filter by the map instead')
  assert.equal(/setLegendFilterByMapEnabled\(True\)/.test(src), true)
})

// The docked composer clips absolutely positioned overlays, and this loader offers no
// react-dom external (only react), so a popover cannot be portaled. Position it fixed
// from the trigger's rectangle instead: same result, no new dependency.
await ok('composer popovers position fixed from the trigger, not inside the clipped row', () => {
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(src, /function useAnchored\(/, 'client.js keeps the measured popover helper')
  assert.match(src, /position: 'fixed', left: pos\.left/, 'popovers are fixed against the viewport')
  assert.match(src, /function popoverStyle\(pos, width, fallback\)/, 'one shared popover style')
})

// A settings section draws its own heading: upstream PluginsSettingsSection renders an
// <h2> plus an intro paragraph, and the shell adds none. Without it this page is a
// stack of rows with no title.
await ok('the settings section has a heading and an intro', () => {
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(src, /h\('h2', \{ style: \{ fontSize: 15, fontWeight: 600/, 'the panel opens with an h2')
  assert.match(src, /连接本机正在运行的 QGIS/, 'and one intro sentence under it')
})

// The harness reports a finished job as completed | killed | failed. Our tasks used
// only done | error | cancelled, which reads as a different vocabulary to a model
// that has seen job_output. Publish the same word next to the internal status.
await ok('a task carries the harness job outcome word', () => {
  const map = { done: 'completed', error: 'failed', cancelled: 'killed', running: 'running', queued: 'queued' }
  for (const [status, outcome] of Object.entries(map)) {
    assert.equal(taskOutcome(status), outcome, `${status} should read as ${outcome}`)
  }
  assert.equal(taskOutcome('weird'), 'weird', 'an unknown status passes through instead of being invented')
  assert.equal(taskOutcome(undefined), 'unknown')
})

// The coarse scope says "may write"; these narrow it to "may write here" and
// "may run these algorithms". Empty means the rule is off, so nothing changes
// for anyone who never sets them.
await ok('the write and algorithm allowlists narrow a call', () => {
  assert.deepEqual(parseList(' D:\\gis\\out; E:\\deliverables\n'), ['D:\\gis\\out', 'E:\\deliverables'])
  assert.equal(pathAllowed('D:\\gis\\out\\a.geojson', 'D:\\gis\\out'), true)
  assert.equal(pathAllowed('D:\\gis\\out2\\a.geojson', 'D:\\gis\\out'), false, 'a sibling prefix is outside')
  assert.equal(pathAllowed('C:\\temp\\a.tif', ''), true, 'no rule, no refusal')

  assert.equal(algorithmAllowed('native:buffer', 'native:*'), true)
  assert.equal(algorithmAllowed('grass:r.watershed', 'native:*'), false)
  assert.equal(algorithmAllowed('grass:r.watershed', 'grass:r.watershed gdal:slope'), true)
  assert.equal(algorithmAllowed('native:buffer', ''), true)

  const paths = allowRefusal('qgis_layer', 'export', { path: 'C:\\temp\\a.gpkg' }, 'D:\\gis\\out', '')
  assert.match(paths, /outside the directories this session may write/)
  const algos = allowRefusal('qgis_analysis', 'run', { algorithm: 'grass:r.watershed' }, '', 'native:*')
  assert.match(algos, /not on this session's allowlist/)
  assert.equal(allowRefusal('qgis_analysis', 'run', { algorithm: 'native:buffer' }, 'D:\\gis', 'native:*'), null)
})

// A failed group must not rerun the shards that already finished: the plan file
// remembers them, and a resume skips exactly those.
await ok('a resumed group skips the shards the plan already finished', () => {
  const plan = { shards: { a: { status: 'completed' }, b: { status: 'failed' }, c: { status: 'queued' } } }
  const tasks = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  const first = pendingShards(tasks, plan, true)
  assert.deepEqual(first.skip, ['a'])
  assert.deepEqual(first.run.map((t) => t.name), ['b', 'c'])
  const noResume = pendingShards(tasks, plan, false)
  assert.deepEqual(noResume.skip, [], 'without resume:true nothing is skipped')
})

// Two agents writing at once used to be an error for whoever lost the race.
await ok('a write waits for the lease instead of failing at once', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.match(src, /QGIS_LIVE_LOCK_WAIT_MS/)
  assert.match(src, /if \(Date\.now\(\) >= deadline\)/, 'the acquire loop has a deadline')
  assert.match(src, /await sleep\(250\)/, 'and retries')
  assert.match(src, /write lease is held|lock_busy/, 'a busy lease is what makes it queue')
  assert.match(src, /lock: _lease/, 'the lease rides inside the command, not two extra round trips')
})

// A project with hundreds of layers answered `qgis_layer list` with every one of
// them, and an array has nowhere to say "there were more". Both list actions now
// return the same bounded shape `qgis_analysis list` uses.
await ok('both list actions report count, total and truncated', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  const bounded = src.match(/'truncated': len\(_all\) > _lim/g) || []
  assert.equal(bounded.length, 2, 'layers and layouts share the bounded shape')
  assert.match(src, /'layers': _all\[:_lim\]/, 'layers are cut to the limit')
  assert.match(src, /'layouts': _all\[:_lim\]/, 'layouts are cut to the limit')
  assert.match(src, /list: max rows to return \(default 200, max 1000\)/, 'the limit is documented')
})

// A no-thinking probe asked for "session status" and reached for
// execute_qgis_sync, which is danger-scoped, instead of qgis_plugin status.
// Hiding a tool behind deferLoading means a model that never saw its
// description cannot pick it; correctness outranks the tokens it saves.
await ok('every tool arrives with its description on the first turn', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.equal((src.match(/deferLoading/g) || []).length, 0, 'no tool is deferred')
  assert.match(src, /name: 'qgis_plugin'/, 'the session tool is registered')
  assert.match(src, /name: 'qgis_map'/, 'the render tool is registered')
})

// The same probe stumbled on the refusal: it said what was blocked but not what
// to call instead. A refusal now names the read-only alternative.
await ok('a blocked PyQGIS call points at the read-only alternative', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.match(src, /For a read-only look at the same session, `qgis_plugin status` needs no scope/)
  assert.match(src, /tool === 'execute_qgis_sync' \|\| tool === 'submit_qgis_async'/)
})

// Names a model reaches for from memory stay accepted, because a rejected alias
// costs a whole round trip: label_field (labels), layout_name/layout (export),
// layer/layers, extent vs xmin..ymax.
await ok('the forgiving aliases survive every trim', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.match(src, /P\.get\('label_field'\)/, 'labels accept label_field')
  assert.match(src, /P\.get\('layout_name'\) or P\.get\('layout'\)/, 'export accepts layout')
  // The schema documents `extent` as the array form of xmin..ymax, so render must
  // actually convert it: it used to be accepted and ignored, framing the project.
  assert.deepEqual(withExtent({ extent: [1, 2, 3, 4] }), { extent: [1, 2, 3, 4], xmin: 1, ymin: 2, xmax: 3, ymax: 4 })
  assert.deepEqual(withExtent({ xmin: 9 }), { xmin: 9 }, 'nothing to convert')
  assert.deepEqual(withExtent({ extent: ['a', 2, 3, 4] }), { extent: ['a', 2, 3, 4] }, 'not numbers: refuse to guess')
})

// A layout map with no extent draws a blank box, and a model cannot tell "no data"
// from "no frame": the item now takes an explicit extent and reports the one it has.
await ok('a layout map takes an extent and reports it', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.match(src, /def _extent_arg\(P\)/, 'one converter for both call shapes')
  assert.match(src, /result\['warning'\] = \('map extent is empty/, 'an empty frame says so')
  assert.match(src, /it\.zoomToExtent\(_rect\)/, 'update_item can move the frame')
  assert.match(src, /map item: \[xmin,ymin,xmax,ymax\] to frame/, 'the parameter is documented')
})

// classify used to build categories from str(value) and fill symbols. A category
// stored as '1.0' never matches the double 1.0, and a fill symbol on a point layer
// paints nothing, so a classified point layer rendered blank while its legend
// listed every class. Both halves are checked here.
await ok('a classified layer keeps the field type and its geometry', () => {
  const src = fs.readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.match(src, /cats = \[QgsRendererCategory\(v, _sym\(i\), k\)/, 'the raw value stays the category')
  assert.match(src, /if gtype == QgsWkbTypes\.PointGeometry:/, 'points get a marker symbol')
  assert.match(src, /QgsMarkerSymbol\.createSimple\(\{'name': 'circle', 'size': '2\.2'/, 'and a size that shows')
})

process.stdout.write(`\n1..${checks}${failed ? ` — ${failed} failed` : ''}\n`)
process.exitCode = failed ? 1 : 0
