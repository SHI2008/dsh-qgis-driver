#!/usr/bin/env node
// Build the two release artifacts into dist/.
//
//   qgis-plugin  -> dist/dsh_qgis_driver-<plugin version>.zip
//                   (installable in QGIS: Plugins > Install from ZIP)
//   dsh-tools    -> dist/dsh-qgis-driver-<bundle version>.tgz
//                   (a DSH bundle; unpack and add it to the profile)
//
// Versions come from qgis-plugin/metadata.txt and dsh-tools/package.json, so
// `scripts/bump.mjs` stays the only place they are written.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const stage = join(dist, '.stage');

const SKIP_DIRS = new Set(['__pycache__', 'node_modules', '.pytest_cache', '.mypy_cache']);
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

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      copyTree(from, to);
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
copyTree(join(root, 'dsh-tools'), join(stage, 'bundle', 'dsh-tools'));

// The bundle patch refers to @local/dsh-qgis-driver by name; keep package.json
// and cordis.patch.yml as they are so a local install behaves like this repo.
const pluginZip = join(dist, `dsh_qgis_driver-${pluginVersion}.zip`);
const bundleTgz = join(dist, `dsh-qgis-driver-${bundleVersion}.tgz`);
archive(pluginZip, join(stage, 'plugin'), ['dsh_qgis_driver']);
archive(bundleTgz, join(stage, 'bundle'), ['dsh-tools']);

// A short manifest: what is inside, and the hash of each archive.
const lines = [];
for (const [file, label] of [[pluginZip, 'QGIS plugin'], [bundleTgz, 'DSH bundle']]) {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  lines.push(`${hash}  ${basename(file)}  (${label})`);
}
const pluginFiles = walk(join(stage, 'plugin', 'dsh_qgis_driver')).length;
const bundleFiles = walk(join(stage, 'bundle', 'dsh-tools')).length;
lines.push('', `plugin ${pluginVersion}: ${pluginFiles} files`, `bundle ${bundleVersion}: ${bundleFiles} files`);
writeFileSync(join(dist, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
rmSync(stage, { recursive: true, force: true });
