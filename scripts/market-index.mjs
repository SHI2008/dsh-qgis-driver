/**
 * Write the plugin-index file the new market reads.
 *
 * The catalogue in awesome-dsh-plugin is one schema (url / name / category /
 * tarball); the "发现" tab of DSH 0.2 reads another one, `format: 1`, and its
 * sources are `npm` or `git` only - a release asset cannot be expressed at all.
 * This repository is already installable from its root (package.json carries
 * `dsh.bundle.patch`), so the index names that root at a pinned commit.
 *
 *   node scripts/market-index.mjs            # pin the current HEAD
 *   node scripts/market-index.mjs --commit=<sha>
 *   node scripts/market-index.mjs --check     # re-read the file and validate it
 *
 * The commit has to exist on the remote, so run this after pushing: a follow-up
 * commit carries the updated file.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'market', 'index.json')
const ICON_LIMIT = 32 * 1024

const TITLE = { en: 'QGIS Driver', zh: 'QGIS 驱动' }
const DESCRIPTION = {
  en: 'Drive a running QGIS 4 from DeepSeek Harness through ten qgis_* tools: project, layers, features, Processing algorithms, print layouts and map rendering, plus async tasks and a raw-PyQGIS escape hatch.',
  zh: '从 DeepSeek Harness 驱动正在运行的 QGIS 4：十个 qgis_* 工具覆盖项目、图层、要素、Processing 算法、地图与版式出图，另有异步任务与直接写 PyQGIS 的逃生口。',
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function iconDataUrl(file) {
  const bytes = readFileSync(file)
  if (bytes.length > ICON_LIMIT) throw new Error(`icon is ${bytes.length} bytes; the index allows ${ICON_LIMIT}`)
  const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
      : 'image/svg+xml'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

function build(commit) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const repository = String(pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
  if (!/^https:\/\//.test(repository)) throw new Error(`repository must be an https URL, got ${repository}`)
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit must be a lowercase 40-hex SHA, got ${commit}`)
  return {
    format: 1,
    title: { en: 'SHI2008 plugins', zh: 'SHI2008 插件' },
    description: {
      en: 'Plugins published by SHI2008.',
      zh: 'SHI2008 发布的插件。',
    },
    plugins: [
      {
        // The market shows `title` and falls back to `name`; the name here is the
        // installable package, which is the repository root.
        name: pkg.name,
        title: TITLE,
        description: DESCRIPTION,
        // Inline and small: a second request to a raw host is the flakiest part of
        // this whole path, and the card is drawn at 32-48 px anyway.
        icon: iconDataUrl(join(root, 'docs', 'market', 'icon.png')),
        author: pkg.author ?? 'SHI2008',
        // The market links here; a #readme fragment is allowed but adds nothing.
        homepage: String(pkg.homepage ?? repository).replace(/#.*$/, ''),
        repository: { url: repository },
        versions: [
          {
            version: pkg.version,
            publishTimestamp: Number(git('log', '-1', '--format=%ct', commit)),
            // The npm package installs prebuilt, which skips the build-approval
            // step a git install needs; --source=git stays for the day the
            // published version lags the repository.
            source: useNpm
              ? { type: 'npm', registry: 'https://registry.npmjs.org' }
              : { type: 'git', url: repository, commit },
          },
        ],
      },
    ],
  }
}

const once = (list) => [...new Set(list)].sort()

/** The rules the Host's index reader enforces, checked on the file we just wrote. */
function check(index) {
  const problems = []
  const note = (where, why) => problems.push(`${where}: ${why}`)
  if (index.format !== 1) note('format', `must be 1, got ${String(index.format)}`)
  if (typeof index.title?.en !== 'string') note('title.en', 'is required')
  if (!Array.isArray(index.plugins) || index.plugins.length === 0) note('plugins', 'must be a non-empty array')
  const names = new Set()
  for (const plugin of index.plugins ?? []) {
    const at = `plugins[${String(plugin?.name ?? '?')}]`
    if (typeof plugin?.name !== 'string' || plugin.name === '') note(at, 'name is required')
    else if (names.has(plugin.name)) note(at, 'name is not unique')
    else names.add(plugin.name)
    if (plugin?.description !== undefined && typeof plugin.description.en !== 'string') note(`${at}.description`, 'needs an en string')
    if (plugin?.icon !== undefined && !plugin.icon.startsWith('data:image/')) note(`${at}.icon`, 'must be a data: image URL or an https URL')
    if (!Array.isArray(plugin?.versions) || plugin.versions.length === 0) note(`${at}.versions`, 'must be a non-empty array')
    const versions = new Set()
    for (const version of plugin?.versions ?? []) {
      const vAt = `${at}.versions[${String(version?.version ?? '?')}]`
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version?.version ?? ''))) note(vAt, 'version must be exact SemVer')
      if (versions.has(version?.version)) note(vAt, 'version is not unique')
      versions.add(version?.version)
      const stamp = version?.publishTimestamp
      if (!Number.isInteger(stamp) || stamp < 0 || stamp >= 1e11) note(vAt, 'publishTimestamp must be integer Unix seconds')
      const source = version?.source ?? {}
      if (source.type === 'git') {
        if (!/^https:\/\//.test(String(source.url ?? ''))) note(vAt, 'git source url must be https')
        if (!/^[0-9a-f]{40}$/.test(String(source.commit ?? ''))) note(vAt, 'git source commit must be a lowercase 40-hex SHA')
      } else if (source.type !== 'npm') {
        note(vAt, 'source.type must be "npm" or "git"')
      }
      if (version?.engines?.dsh !== undefined && !/^[<>=^~*.\d\s|-]+$/.test(String(version.engines.dsh))) note(vAt, 'engines.dsh must be a SemVer range')
    }
  }
  const extra = Object.keys(index).filter((key) => !['format', 'title', 'description', 'plugins'].includes(key))
  for (const key of extra) note(key, 'is not a field this index defines')
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exitCode = 1
    return false
  }
  return true
}

const useNpm = !process.argv.includes('--source=git')
const flag = process.argv.find((arg) => arg.startsWith('--commit='))?.split('=')[1]
if (process.argv.includes('--check')) {
  const index = JSON.parse(readFileSync(out, 'utf8'))
  if (check(index)) {
    const version = index.plugins[0].versions[0]
    const where = version.source.type === 'git' ? version.source.commit.slice(0, 8) : `npm${version.source.registry ? ` ${version.source.registry}` : ''}`
    console.log(`ok ${index.plugins[0].name}@${version.version} ${where}`)
  }
} else {
  const commit = flag ?? git('rev-parse', 'HEAD')
  const index = build(commit)
  if (!check(index)) process.exit(1)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  const bytes = readFileSync(out).length
  console.log(`wrote ${out} (${bytes} bytes) pinned at ${commit.slice(0, 8)} for ${index.plugins[0].name}@${index.plugins[0].versions[0].version}`)
}
