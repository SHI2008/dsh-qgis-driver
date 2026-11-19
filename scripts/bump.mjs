#!/usr/bin/env node
// Set the two version numbers the project carries, in every place that reads
// them.
//
// Why a script: the bundle version is validated by pnpm (it must parse as
// semver, or the whole profile fails to load), while the QGIS plugin version is
// read by QGIS and by the copy installed under the profile. Editing three
// files by hand is how a stale copy silently kept the old number.
//
// Usage:
//   node scripts/bump.mjs 0.1.50-rc            # bundle only
//   node scripts/bump.mjs 0.1.50-rc 0.16.8     # bundle + plugin (+ profile copy)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'dsh-tools', 'package.json')
const metadataPath = path.join(root, 'qgis-plugin', 'metadata.txt')

function profileMetadataPath() {
  const base = process.env.APPDATA || process.env.XDG_DATA_HOME
  if (!base) return null
  const candidates = [
    path.join(base, 'QGIS', 'QGIS4', 'profiles', 'default', 'python', 'plugins', 'dsh_qgis_driver', 'metadata.txt'),
    path.join(base, 'QGIS', 'QGIS3', 'profiles', 'default', 'python', 'plugins', 'dsh_qgis_driver', 'metadata.txt'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || null
}

function check(version, label) {
  if (!SEMVER.test(version)) {
    console.error(`${label}: "${version}" is not a plain semver (e.g. 0.1.50-rc). pnpm refuses to load a bundle otherwise.`)
    process.exit(2)
  }
}

function setBundleVersion(version) {
  const raw = fs.readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(raw)
  const before = pkg.version
  pkg.version = version
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`dsh-tools/package.json      ${before} -> ${version}`)
}

function setMetadataVersion(file, version) {
  const raw = fs.readFileSync(file, 'utf8')
  const next = raw.replace(/^version=.*$/m, `version=${version}`)
  if (next === raw && !raw.includes(`version=${version}`)) {
    console.error(`${file}: no "version=" line found`)
    process.exit(2)
  }
  fs.writeFileSync(file, next, 'utf8')
  const before = (raw.match(/^version=(.*)$/m) || [])[1] || '?'
  console.log(`${path.relative(root, file) || file}  ${before} -> ${version}`)
}

const [bundle, plugin] = process.argv.slice(2)
if (!bundle) {
  console.error('usage: node scripts/bump.mjs <bundleVersion> [pluginVersion]')
  process.exit(2)
}
check(bundle, 'bundle')
setBundleVersion(bundle)

if (plugin) {
  check(plugin, 'plugin')
  setMetadataVersion(metadataPath, plugin)
  const copy = profileMetadataPath()
  if (copy) setMetadataVersion(copy, plugin)
  else console.log('profile copy: not installed, skipped')
}
