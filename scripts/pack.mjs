#!/usr/bin/env node
// Build the two release artifacts into dist/.
//
//   qgis-plugin  -> dist/dsh_qgis_driver-<plugin version>.zip
//                   (installable in QGIS: Plugins > Install from ZIP)
//   dsh-tools    -> dist/dsh-qgis-driver-<bundle version>.tgz
//                   (an npm-layout tarball the plugin manager installs)
//
// Versions come from qgis-plugin/metadata.txt and dsh-tools/package.json, so
// `scripts/bump.mjs` stays the only place they are written.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const stage = join(dist, '.stage');

const SKIP_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache']);
// The bundle imports schemastery at module scope and DSH does not provide it, so
// the vendored copy in dsh-tools/node_modules has to ship with the tarball. The
// plugin side has no dependencies, so it never keeps one.
const KEEP_DIRS = new Set(['node_modules']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
// dotfiles are dev config (.flake8, .bandit, .gitignore, ...) - not for users
const SKIP_DOTFILES = true;
const SKIP_EXT = ['.pyc', '.pyo', '.log', '.tmp', '.zip', '.tgz'];

function readVersion(file, re) {
  const m = readFileSync(file, 'utf8').match(re);
  if (!m) throw new Error(`no version in ${file}`);
  return m[1];
}

const pluginVersion = readVersion(join(root, 'qgis-plugin', 'metadata.txt'), /^version\s*=\s*(\S+)/m);
const bundleVersion = JSON.parse(readFileSync(join(root, 'dsh-tools', 'package.json'), 'utf8')).version;

function copyTree(src, dst, keepDeps = false) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      const kept = KEEP_DIRS.has(name);
      if (SKIP_DIRS.has(name) || (kept && !keepDeps)) continue;
      copyTree(from, to, keepDeps);
      continue;
    }
    if (SKIP_FILES.has(name)) continue;
    if (SKIP_DOTFILES && name.startsWith('.')) continue;
    if (SKIP_EXT.some((e) => name.toLowerCase().endsWith(e))) continue;
    cpSync(from, to);
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function archive(outFile, cwd, entries) {
  rmSync(outFile, { force: true });
  const r = spawnSync('tar', ['-a', '-c', '-f', outFile, ...entries], { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`tar failed for ${basename(outFile)}: ${r.stderr || r.error}`);
  }
  const bytes = statSync(outFile).size;
  console.log(`${relative(root, outFile)}  ${(bytes / 1024).toFixed(0)} KB`);
  return bytes;
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'plugin'), { recursive: true });
copyTree(join(root, 'qgis-plugin'), join(stage, 'plugin', 'dsh_qgis_driver'));

copyTree(join(root, 'dsh-tools'), join(stage, 'package'), true);

// The bundle ships as a real npm package. The plugin manager installs a
// tarball only when the archive is laid out the way `npm pack` lays one out - a
// single `package/` root holding package.json - and lists it by the keywords it
// declares, so the release copy carries a publishable name instead of the
// repository's `@local/` link name. The repo keeps its dev name: nothing here
// rewrites dsh-tools/package.json.
const devManifest = JSON.parse(readFileSync(join(root, 'dsh-tools', 'package.json'), 'utf8'));
const releaseManifest = {
  name: 'dsh-qgis-driver',
  version: devManifest.version,
  description:
    'Drive QGIS from DeepSeek Harness: layers, symbology, print layouts and Processing through ten qgis_* tools. AI Assisted. Recommended together with the QGIS plugin dsh_qgis_driver.',
  keywords: ['dsh-plugin', 'dsh', 'deepseek-harness', 'qgis', 'gis', 'pyqgis', 'layout', 'map', 'processing'],
  license: devManifest.license,
  author: devManifest.author,
  type: devManifest.type,
  main: './index.js',
  // The bundle page shows this icon; a package-root manifest may name one file
  // next to itself, and the tarball root is `package/`, so the path is flat here.
  icon: './icon.png',
  exports: devManifest.exports,
  files: devManifest.files,
  repository: {
    type: 'git',
    url: 'git+https://github.com/SHI2008/dsh-qgis-driver.git',
    directory: 'dsh-tools',
  },
  homepage: 'https://github.com/SHI2008/dsh-qgis-driver#readme',
  bugs: { url: 'https://github.com/SHI2008/dsh-qgis-driver/issues' },
  dsh: devManifest.dsh,
};
writeFileSync(join(stage, 'package', 'package.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`);
// The patch names the package it belongs to, so it follows the release name.
writeFileSync(
  join(stage, 'package', 'cordis.patch.yml'),
  "- insert:\n    - id: dsh-qgis-driver\n      name: 'dsh-qgis-driver'\n      config: {}\n",
);

// The plugin repository runs these checks on upload and rejects the whole
// version on any finding - a file the linter cannot see is a version that never
// reaches a user - so run the same ones before the zip is built. The linter is
// a developer tool: missing it is a notice, a finding is a failure.
function checkPlugin(dir) {
  const python = process.env.PYTHON || 'python';
  const files = readdirSync(dir).filter((f) => f.endsWith('.py')).sort();
  const lint = spawnSync(python, ['-m', 'pyflakes', ...files], { cwd: dir, encoding: 'utf8' });
  const said = `${lint.stdout || ''}${lint.stderr || ''}`.trim();
  if (/No module named pyflakes/i.test(said)) {
    console.warn('warning: pyflakes is not installed - `python -m pip install pyflakes` to lint like the plugin repository does');
  } else if (lint.status !== 0) {
    throw new Error(`pyflakes rejected ${files.length} files:\n${said}`);
  } else if (said) {
    throw new Error(`pyflakes reported findings:\n${said}`);
  }

  const meta = new Map();
  for (const line of readFileSync(join(dir, 'metadata.txt'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/);
    if (m) meta.set(m[1], m[2].trim());
  }
  const required = ['name', 'description', 'about', 'version', 'qgisMinimumVersion', 'author', 'email', 'license'];
  const missing = required.filter((k) => !meta.get(k));
  if (missing.length) throw new Error(`metadata.txt is missing ${missing.join(', ')}`);
  if (!/\bqgisMaximumVersion\b/.test(readFileSync(join(dir, 'metadata.txt'), 'utf8'))) {
    throw new Error('metadata.txt needs qgisMaximumVersion - QGIS 4 decides compatibility by it alone');
  }
  if (meta.has('supportsQt6')) {
    throw new Error('metadata.txt still carries supportsQt6, which the repository rejects as deprecated');
  }
  if (meta.get('description').length > 200 || /\n/.test(meta.get('description'))) {
    throw new Error('metadata.txt description must be one short line: the plugin list renders it inline');
  }
  for (const key of ['icon', 'tags']) {
    if (!meta.get(key)) throw new Error(`metadata.txt needs ${key}`);
  }
  if (!existsSync(join(dir, meta.get('icon')))) throw new Error(`metadata.txt names icon=${meta.get('icon')} but the file is not in the package`);
  console.log(`plugin checks passed: ${files.length} python files, metadata ${meta.get('version')}`);
}

// The bundle side gets the same treatment: a name that is used and never
// declared (or a key written twice) only shows up when that branch runs, so the
// check happens before the tarball exists.
function checkBundle() {
  const lint = join(root, 'scripts', 'lint-js.mjs');
  const run = spawnSync(process.execPath, [lint], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const said = `${run.stdout || ''}${run.stderr || ''}`.trim();
  if (run.status !== 0) throw new Error(`lint-js rejected the bundle:\n${said}`);
  console.log(`bundle checks passed: ${said.split('\n').pop()}`);
}

const pluginZip = join(dist, `dsh_qgis_driver-${pluginVersion}.zip`);
const bundleTgz = join(dist, `dsh-qgis-driver-${bundleVersion}.tgz`);
// Rebuilding an archive rewrites every entry's timestamp, so a bundle that did
// not change still gets a new hash. When only one side changed, build only that
// side: `--only=plugin` / `--only=bundle` keeps the published artefact intact.
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'both';
if (only !== 'bundle') {
  checkPlugin(join(stage, 'plugin', 'dsh_qgis_driver'));
  archive(pluginZip, join(stage, 'plugin'), ['dsh_qgis_driver']);
}
if (only !== 'plugin') {
  checkBundle();
  archive(bundleTgz, stage, ['package']);
}

// A short manifest: what is inside, and the hash of each archive.
const lines = [];
const wanted = [[pluginZip, 'QGIS plugin'], [bundleTgz, 'DSH bundle']].filter(([file]) => existsSync(file));
for (const [file, label] of wanted) {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  lines.push(`${hash}  ${basename(file)}  (${label})`);
}
const pluginFiles = walk(join(stage, 'plugin', 'dsh_qgis_driver')).length;
const bundleFiles = walk(join(stage, 'package')).length;
lines.push('', `plugin ${pluginVersion}: ${pluginFiles} files`, `bundle ${bundleVersion}: ${bundleFiles} files`);
writeFileSync(join(dist, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
rmSync(stage, { recursive: true, force: true });
