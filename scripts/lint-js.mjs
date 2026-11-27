#!/usr/bin/env node
// Static checks for the bundle side, matching what the QGIS repository runs on
// the plugin: names that are used and never declared, object keys written twice,
// imports nothing reads, statements after a return.
//
//   node scripts/lint-js.mjs [files...]
//
// Parsing needs acorn; it is a devDependency (node_modules is not shipped).
// Without it this prints how to install and exits 0, because a missing dev tool
// is not a defect in the code - the same rule pack.mjs follows for pyflakes.

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let acorn;
try {
  acorn = require('acorn');
} catch {
  console.log('skipped: acorn is not installed - `npm install` (or `npm i -D acorn`) to lint like the repositories do');
  process.exit(0);
}

const DEFAULT_FILES = ['dsh-tools/tools.js', 'dsh-tools/index.js', 'dsh-tools/client.js'];
const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES;

const GLOBAL_NAMES = new Set(Object.getOwnPropertyNames(globalThis));

// Names a module may use without declaring: the language, the host, and the
// handful of things Node exposes per module.
for (const extra of ['require', 'module', 'exports', '__dirname', '__filename', 'arguments']) {
  GLOBAL_NAMES.add(extra);
}
// client.js runs in the renderer, so the DOM is part of its language.
for (const dom of [
  'document', 'window', 'navigator', 'location', 'localStorage', 'sessionStorage',
  'Node', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment', 'Event',
  'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'MutationObserver', 'ResizeObserver',
  'IntersectionObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'DOMParser', 'XMLSerializer', 'Image', 'FileReader', 'Blob', 'FormData',
]) {
  GLOBAL_NAMES.add(dom);
}

const TERMINATORS = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement']);

function lineOf(node) {
  return node.loc ? node.loc.start.line : 0;
}

function collectPattern(node, into) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      into.push(node);
      break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') collectPattern(p.argument, into);
        else collectPattern(p.value, into);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) collectPattern(el, into);
      break;
    case 'AssignmentPattern':
      collectPattern(node.left, into);
      break;
    case 'RestElement':
      collectPattern(node.argument, into);
      break;
    default:
      break;
  }
}

const ALL_SCOPES = [];

class Scope {
  constructor(parent, isFunction = false) {
    this.parent = parent;
    this.isFunction = isFunction;
    this.names = new Map();
    ALL_SCOPES.push(this);
  }

  functionScope() {
    let s = this;
    while (s.parent && !s.isFunction) s = s.parent;
    return s;
  }

  declare(id, kind) {
    const target = kind === 'var' ? this.functionScope() : this;
    if (target.names.has(id.name)) {
      const first = target.names.get(id.name);
      if (first.kind === 'import' || first.kind === 'function') return first;
      if (kind === 'import') return first;
    }
    const entry = { id, kind, used: false };
    target.names.set(id.name, entry);
    return entry;
  }

  lookup(name) {
    let s = this;
    while (s) {
      const hit = s.names.get(name);
      if (hit) return { scope: s, entry: hit };
      s = s.parent;
    }
    return null;
  }
}

function analyse(file) {
  const source = readFileSync(file, 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

  const problems = [];
  const imports = [];
  const exported = new Set();
  const moduleScope = new Scope(null, true);

  function report(node, message) {
    problems.push({ line: lineOf(node), column: node.loc ? node.loc.start.column + 1 : 1, message });
  }

  function visitPattern(node, scope, kind = 'let') {
    const ids = [];
    collectPattern(node, ids);
    for (const id of ids) {
      const entry = scope.declare(id, kind);
      if (kind === 'import') imports.push(entry);
      if (id.type === 'Identifier' && /^[A-Za-z_]/.test(id.name) === false) {
        report(id, `declaration name ${id.name} cannot start like that`);
      }
    }
  }

  function reference(node, scope) {
    const found = scope.lookup(node.name);
    if (found) {
      found.entry.used = true;
      return;
    }
    if (GLOBAL_NAMES.has(node.name)) return;
    report(node, `undefined name '${node.name}'`);
  }

  function visitChildren(node, scope, skip = new Set()) {
    for (const [key, value] of Object.entries(node)) {
      if (skip.has(key) || key === 'loc' || key === 'type') continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, scope);
      } else if (value && typeof value.type === 'string') {
        visit(value, scope);
      }
    }
  }

  function visitFunction(node, scope) {
    const fnScope = new Scope(scope, true);
    // A declaration already owns its name in the enclosing scope; only a named
    // function expression binds its own name inside the body.
    if (node.type === 'FunctionExpression' && node.id) fnScope.declare(node.id, 'function');
    for (const param of node.params) visitPattern(param, fnScope, 'param');
    if (node.body.type === 'BlockStatement') {
      checkBlock(node.body.body, fnScope);
    } else {
      visit(node.body, fnScope);
    }
  }

  function checkBlock(statements, scope) {
    for (const stmt of statements) hoist(stmt, scope);
    let terminated = false;
    for (const stmt of statements) {
      if (terminated && !stmt.type.endsWith('Declaration') && stmt.type !== 'EmptyStatement') {
        report(stmt, 'unreachable: nothing runs after a return, throw, break or continue in this block');
        terminated = false;
      }
      visit(stmt, scope);
      if (TERMINATORS.has(stmt.type)) terminated = true;
    }
  }

  function visit(node, scope) {
    if (!node) return;
    switch (node.type) {
      case 'Program':
        for (const stmt of node.body) {
          if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
            const decl = stmt.declaration;
            if (decl && decl.id && decl.id.name) exported.add(decl.id.name);
            if (decl && decl.type === 'VariableDeclaration') {
              for (const d of decl.declarations) {
                const ids = [];
                collectPattern(d.id, ids);
                for (const id of ids) exported.add(id.name);
              }
            }
            for (const spec of stmt.specifiers || []) {
              if (spec.local && spec.local.name) exported.add(spec.local.name);
            }
          }
        }
        for (const stmt of node.body) {
          if (stmt.type === 'ImportDeclaration') {
            for (const spec of stmt.specifiers) {
              const entry = moduleScope.declare(spec.local, 'import');
              imports.push(entry);
            }
          }
        }
        checkBlock(node.body, moduleScope);
        return;
      case 'ImportDeclaration':
        return;
      case 'ExportNamedDeclaration':
        if (node.declaration) visit(node.declaration, scope);
        for (const spec of node.specifiers) if (spec.local) reference(spec.local, scope);
        return;
      case 'ExportDefaultDeclaration':
        visit(node.declaration, scope);
        return;
      case 'ExportAllDeclaration':
        return;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          visitPattern(decl.id, scope, node.kind);
          if (decl.init) visit(decl.init, scope);
        }
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(node, scope);
        return;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.superClass) visit(node.superClass, scope);
        visit(node.body, new Scope(scope));
        return;
      case 'BlockStatement':
        checkBlock(node.body, new Scope(scope));
        return;
      case 'ForStatement': {
        const s = new Scope(scope);
        if (node.init) visit(node.init, s);
        if (node.test) visit(node.test, s);
        if (node.update) visit(node.update, s);
        visit(node.body, s);
        return;
      }
      case 'ForOfStatement':
      case 'ForInStatement': {
        const s = new Scope(scope);
        if (node.left.type === 'VariableDeclaration') visit(node.left, s);
        else visitPattern(node.left, s, 'let');
        visit(node.right, s);
        visit(node.body, s);
        return;
      }
      case 'CatchClause': {
        const s = new Scope(scope);
        if (node.param) visitPattern(node.param, s, 'param');
        visit(node.body, s);
        return;
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope);
        const s = new Scope(scope);
        for (const c of node.cases) {
          if (c.test) visit(c.test, s);
          for (const stmt of c.consequent) visit(stmt, s);
        }
        return;
      }
      case 'Identifier':
        reference(node, scope);
        return;
      case 'MemberExpression':
        visit(node.object, scope);
        if (node.computed) visit(node.property, scope);
        return;
      case 'Property':
        if (node.computed) visit(node.key, scope);
        visit(node.value, scope);
        return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, scope);
        visit(node.value, scope);
        return;
      case 'ObjectExpression': {
        const seen = new Map();
        for (const prop of node.properties) {
          if (prop.type === 'Property' && !prop.computed && prop.key) {
            const name = prop.key.name ?? prop.key.value;
            if (seen.has(name)) {
              report(prop, `object key '${name}' is written twice; the later one silently wins`);
            } else {
              seen.set(name, prop);
            }
          }
          visit(prop, scope);
        }
        return;
      }
      case 'LabeledStatement':
        visit(node.body, scope);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      case 'MetaProperty':
        return;
      case 'TemplateLiteral':
        for (const expr of node.expressions) visit(expr, scope);
        return;
      case 'TaggedTemplateExpression':
        visit(node.tag, scope);
        visit(node.quasi, scope);
        return;
      default:
        visitChildren(node, scope);
    }
  }

  function hoist(stmt, scope) {
    if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
      if (stmt.declaration) hoist(stmt.declaration, scope);
      return;
    }
    if (stmt.type === 'FunctionDeclaration' && stmt.id) scope.declare(stmt.id, 'function');
    if (stmt.type === 'ClassDeclaration' && stmt.id) scope.declare(stmt.id, 'class');
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        const ids = [];
        collectPattern(decl.id, ids);
        for (const id of ids) scope.declare(id, stmt.kind);
      }
    }
  }

  visit(ast, moduleScope);

  for (const entry of imports) {
    if (!entry.used) {
      report(entry.id, `import '${entry.id.name}' is never used`);
    }
  }
  for (const scope of ALL_SCOPES) {
    for (const [name, entry] of scope.names) {
      if (entry.used || entry.kind === 'import' || entry.kind === 'param') continue;
      if (scope === moduleScope && exported.has(name)) continue;
      const where = scope === moduleScope ? '' : ' inside this function';
      report(entry.id, `'${name}' is declared${where} and never used`);
    }
  }
  ALL_SCOPES.length = 0;
  return problems;
}

let total = 0;
for (const file of files) {
  const path = join(root, file);
  let problems;
  try {
    problems = analyse(path);
  } catch (error) {
    console.error(`${file}: cannot parse - ${error.message}`);
    process.exit(1);
  }
  for (const p of problems) {
    console.log(`${relative(root, path)}:${p.line}:${p.column} ${p.message}`);
  }
  total += problems.length;
}
console.log(total === 0 ? `ok ${files.length} files` : `${total} problem(s) in ${files.length} files`);
process.exit(total === 0 ? 0 : 1);
