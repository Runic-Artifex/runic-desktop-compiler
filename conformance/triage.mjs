#!/usr/bin/env node
// Blocker census of the north star's component examples: for every
// shadcn-svelte example (docs/src/lib/registry/examples/*.svelte at the
// commit conformance/corpus/north-star.json pins), generate a Vite host app
// (the bits-* fixtures' shape) and run the analyze path (collect + lower +
// backend validation, no native build), recording the first diagnostic.
//
//   node conformance/triage.mjs [example ...] [--out DIR] [--jobs N] [--keep-lib]
//
// Scope: the top-level examples only. examples/create/ (about 527 files that
// the site's /preview/[item] route serves) is out of scope for this census.
//
// An example counts as the shadcn-svelte CLI installs it (docs/ROADMAP.md,
// decisions, 2026-10-12): the corpus's own pinned icon transform
// (packages/cli/src/utils/transformers/transform-icons.ts, run as is through
// Node's type stripping, iconLibrary 'lucide', the docs default without a
// provider) rewrites IconPlaceholder to @lucide/svelte imports in the host
// copies of the reached .svelte files, so icon-placeholder, icon-loader and
// registry/icons drop out of the closure. Only the icon transform applies: the
// hosts keep the corpus's $lib layout, so the CLI's import aliasing is moot.
// The corpus sources stay byte-identical (checked against git before and
// after the run); each result records the transformed files' sha256.
//
// Hosts are written to <out>/hosts/<example>/ and the census to
// <out>/census.json, the worker logs to <out>/logs/<example>.log. `$lib` holds
// copies (reflinked where the filesystem allows) of the corpus docs/src/lib
// files the example reaches, made inside each host because the collector
// accepts only aliases inside the application and Vite resolves symlinks to
// their real path. The theme is fixtures/bits-dialog-svelte/src/app.css
// without its fixture-specific `@source not inline(...)` exclusions,
// generated into each host. A host is removed after its analysis unless
// --keep-lib is given.
//
// Statuses: lowered; rejected (a compiler diagnostic: the blocker); and,
// not counted as rejections, harnessError (the host or toolchain failed:
// a closure miss, the icon transform, E_BUILD*, E_SVELTE_COMPILE, whose cause
// in a generated host is not attributed, a worker without a result) and
// internalError (E_INTERNAL, including crashes, and E_BACKEND, the backend
// failing without a structured diagnostic).
//
// No cargo runs: the collector and the backend validation use the existing
// runic-codegen binary (.cache/codegen-target, RUNIC_CODEGEN_TARGET_DIR), which
// must be newer than its crates' sources; workers see a `cargo` that does
// nothing, so the compiler's incremental rebuild of the binary is skipped.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  existsSync,
  copyFileSync,
  globSync,
  chmodSync,
} from 'node:fs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'artifacts/triage-2026-10-12' },
    jobs: { type: 'string', default: '4' },
    timeout: { type: 'string', default: '600' },
    'keep-lib': { type: 'boolean' },
    one: { type: 'string' },
  },
});

const strip = s => String(s).replace(/\u001b\[[0-9;]*m/g, '');

// Worker: analyze one host in this process, print one JSON line.
if (values.one) {
  const { collect, Diagnostic } = await import('../compiler/collect.mjs');
  const { lower } = await import('../compiler/frontend.mjs');
  let result;
  try {
    const graph = await collect(values.one);
    await lower(graph);
    result = { status: 'lowered' };
  } catch (e) {
    result =
      e instanceof Diagnostic
        ? { status: 'rejected', code: e.code, message: strip(e.message), source: e.source ?? null }
        : {
            status: 'rejected',
            code: 'E_INTERNAL',
            crash: true,
            message: strip(e?.message ?? e),
            source: null,
            stack: strip(e?.stack ?? '')
              .split('\n')
              .slice(0, 8)
              .join('\n'),
          };
  }
  process.stdout.write('\nTRIAGE ' + JSON.stringify(result) + '\n');
  process.exit(0);
}

const out = path.resolve(repo, values.out);
if (!out.startsWith(path.join(repo, 'artifacts') + path.sep))
  throw new Error('--out must be under artifacts/');
const manifest = JSON.parse(
  readFileSync(path.join(repo, 'conformance/corpus/north-star.json'), 'utf8'),
);
const source = manifest.sources.find(s => s.name === 'shadcn-svelte');
const checkout = path.join(repo, '.cache/corpus', source.name);
const git = (...args) => spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
const head = git('rev-parse', 'HEAD');
if (head.status !== 0 || head.stdout.trim() !== source.commit)
  throw new Error(
    `${checkout} is not at ${source.commit}; run node conformance/corpus/fetch.mjs ${source.name}`,
  );
const corpusStatus = () => git('status', '--porcelain', '--untracked-files=all').stdout;
if (corpusStatus())
  throw new Error(`${checkout} has local changes; run node conformance/corpus/fetch.mjs`);
const docs = path.join(checkout, source.target);
const lib = path.join(docs, 'src/lib');
const examplesDir = path.join(lib, 'registry/examples');
const fixture = path.join(repo, 'fixtures/bits-dialog-svelte');

// The backend binary must be current: the census never builds it.
const codegenTarget = path.resolve(
  process.env.RUNIC_CODEGEN_TARGET_DIR ?? path.join(repo, '.cache/codegen-target'),
);
const binary = path.join(codegenTarget, 'debug', 'runic-codegen');
if (!existsSync(binary))
  throw new Error(`${binary} is missing; the census does not run cargo (build it separately)`);
const builtAt = statSync(binary).mtimeMs;
const newer = [];
const walk = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (statSync(p).mtimeMs > builtAt) newer.push(path.relative(repo, p));
  }
};
for (const c of ['runic-ir', 'runic-codegen', 'runic-js', 'runic-css'])
  walk(path.join(repo, 'crates', c));
if (newer.length)
  throw new Error(`runic-codegen is older than ${newer.slice(0, 5).join(', ')}; rebuild it first`);
const stubDir = path.join(out, 'bin');
mkdirSync(stubDir, { recursive: true });
writeFileSync(
  path.join(stubDir, 'cargo'),
  '#!/bin/sh\necho "triage: cargo $* suppressed (existing runic-codegen used)" >&2\nexit 0\n',
);
chmodSync(path.join(stubDir, 'cargo'), 0o755);
const logDir = path.join(out, 'logs');
mkdirSync(logDir, { recursive: true });

// The CLI's icon transform at the pinned commit. Its runtime import graph is
// these files (index.js and acorn are type-only imports). They are imported
// from the corpus checkout, which is clean at the pinned commit; were they
// absent there, they are read from the commit's objects (what fetch.mjs
// fetched) into <out>/cli, leaving the cached corpus untouched.
const cliFiles = [
  'packages/cli/src/utils/transformers/transform-icons.ts',
  'packages/cli/src/icons/libraries.ts',
  'packages/cli/src/utils/utils.ts',
  'packages/cli/src/utils/errors.ts',
  'packages/cli/package.json',
];
let cliRoot = checkout;
if (!cliFiles.every(f => existsSync(path.join(checkout, f)))) {
  cliRoot = path.join(out, 'cli');
  for (const f of cliFiles) {
    const blob = spawnSync('git', ['show', `${source.commit}:${f}`], { cwd: checkout });
    if (blob.status !== 0)
      throw new Error(`${f} is not in ${source.commit}; run node conformance/corpus/fetch.mjs`);
    mkdirSync(path.dirname(path.join(cliRoot, f)), { recursive: true });
    writeFileSync(path.join(cliRoot, f), blob.stdout);
  }
}
const cliDir = path.join(cliRoot, 'packages/cli');
const cliManifest = JSON.parse(readFileSync(path.join(cliDir, 'package.json'), 'utf8'));
const cliRanges = {
  ...cliManifest.peerDependencies,
  ...cliManifest.devDependencies,
  ...cliManifest.dependencies,
};
/** Whether `version` satisfies a caret `range` (the form the CLI pins). */
const caret = (version, range) => {
  const [a, b, c] = range.replace(/^\^/, '').split('.').map(Number);
  const [x, y, z] = version.split('-')[0].split('.').map(Number);
  if (x !== a || (a === 0 && y !== b)) return false;
  return y > b || (y === b && z >= c);
};
// The CLI's runtime packages, resolved from the repository's node_modules
// (a nested copy where the top-level one is outside the CLI's range). zod is
// only called by utils.ts's isUrl, which the transform never reaches.
const cliDeps = {};
for (const pkg of ['magic-string', 'estree-walker', 'svelte']) {
  const found = [
    `node_modules/${pkg}/package.json`,
    ...globSync(`node_modules/*/node_modules/${pkg}/package.json`, { cwd: repo }),
    ...globSync(`node_modules/@*/*/node_modules/${pkg}/package.json`, { cwd: repo }),
  ]
    .map(f => ({ dir: path.dirname(path.join(repo, f)), f: path.join(repo, f) }))
    .filter(({ f }) => existsSync(f))
    .map(({ dir, f }) => ({ dir, version: JSON.parse(readFileSync(f, 'utf8')).version }))
    .find(({ version }) => caret(version, cliRanges[pkg]));
  if (!found) throw new Error(`no ${pkg} in node_modules satisfies the CLI's ${cliRanges[pkg]}`);
  const parent = found.dir.slice(0, found.dir.lastIndexOf(`${path.sep}node_modules${path.sep}`));
  cliDeps[pkg] = {
    range: cliRanges[pkg],
    version: found.version,
    path: path.relative(repo, found.dir),
    parentURL: pathToFileURL(path.join(parent, 'triage-resolve.js')).href,
  };
}
const zodStub =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const z = new Proxy({}, { get() { throw new Error("triage: zod is not available to the CLI transform"); } });',
  );
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL?.startsWith('file:') && fileURLToPath(context.parentURL);
    if (!parent || !parent.startsWith(cliDir + path.sep)) return next(specifier, context);
    // The CLI's sources import their TypeScript siblings by .js names.
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const ts = path.resolve(path.dirname(parent), specifier.replace(/\.js$/, '.ts'));
      if (existsSync(ts)) return next(pathToFileURL(ts).href, context);
    }
    if (specifier === 'zod') return { url: zodStub, shortCircuit: true };
    const pkg = specifier.split('/')[0];
    if (cliDeps[pkg]) return next(specifier, { ...context, parentURL: cliDeps[pkg].parentURL });
    return next(specifier, context);
  },
});
const iconTransformFile = path.join(cliDir, 'src/utils/transformers/transform-icons.ts');
const { transformIcons } = await import(pathToFileURL(iconTransformFile).href);
const iconLibrary = 'lucide';

const all = readdirSync(examplesDir)
  .filter(f => f.endsWith('.svelte'))
  .map(f => f.slice(0, -'.svelte'.length))
  .sort();
const selected = positionals.length ? positionals : all;
for (const name of selected)
  if (!all.includes(name)) throw new Error(`No example ${name}.svelte in ${examplesDir}`);

const sha = data => createHash('sha256').update(data).digest('hex');
const shaFile = file => sha(readFileSync(file));

// The host theme: the bits-dialog fixture's, without the exclusions that keep
// utilities out of that fixture's generation, otherwise unchanged.
const fixtureTheme = readFileSync(path.join(fixture, 'src/app.css'), 'utf8');
const exclusion = /^@source not inline\([^)]*\);\n/gm;
const removedFromTheme = fixtureTheme.match(exclusion) ?? [];
const theme = fixtureTheme.replace(exclusion, '');
if (!removedFromTheme.length || theme.includes('@source not'))
  throw new Error('fixtures/bits-dialog-svelte/src/app.css: the @source exclusions changed shape');
const font = path.join(fixture, 'assets/DejaVuSans.woff2');

/** Write the host shell (everything but src/lib) for `name`. */
function host(name) {
  const dir = path.join(out, 'hosts', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(
    path.join(dir, 'runic.json'),
    JSON.stringify(
      {
        framework: 'svelte',
        entry: 'main.js',
        title: `Runic triage ${name}`,
        tailwind: true,
        alias: { $lib: 'src/lib' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(path.join(dir, 'main.js'), readFileSync(path.join(fixture, 'main.js')));
  writeFileSync(path.join(dir, 'index.html'), readFileSync(path.join(fixture, 'index.html')));
  writeFileSync(
    path.join(dir, 'src/App.svelte'),
    `<script lang="ts">\n  import Example from '$lib/registry/examples/${name}.svelte';\n</script>\n\n` +
      `<div class="flex flex-col gap-6 bg-background p-4 font-sans text-foreground">\n` +
      `  <div id="demo" class="flex justify-center p-12"><Example /></div>\n</div>\n`,
  );
  writeFileSync(path.join(dir, 'src/app.css'), theme);
  copyFileSync(font, path.join(dir, 'assets/DejaVuSans.woff2'));
  return dir;
}

/** The CLI's icon transform of a corpus .svelte file (cached per file). */
const transformed = new Map();
function installed(file) {
  let p = transformed.get(file);
  if (!p) {
    const content = readFileSync(file, 'utf8');
    p = transformIcons({
      content,
      filePath: path.relative(checkout, file),
      config: { iconLibrary },
    }).then(r => ({
      content: r.content ?? content,
      changed: (r.content ?? content) !== content,
      devDependencies: r.devDependencies ?? [],
    }));
    transformed.set(file, p);
  }
  return p;
}

/**
 * The $lib files `entry` reaches, as installed, through static imports and
 * exports (types included), side-effect imports and dynamic imports (template
 * literals are expanded as Vite expands them, each substitution matching
 * within one path segment), as the fixtures vendor them: only the reached
 * files are present, so Tailwind's source detection sees what the example
 * uses.
 */
async function closure(entry) {
  const seen = new Set();
  const missing = [];
  const pending = [entry];
  const candidates = p => {
    const c = [p];
    if (/\.js$/.test(p)) c.push(p.replace(/\.js$/, '.ts'));
    c.push(p + '.ts', p + '.js', p + '.svelte', path.join(p, 'index.ts'), path.join(p, 'index.js'));
    return c;
  };
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(svelte|ts|js|mjs)$/.test(file)) continue;
    const text = file.endsWith('.svelte')
      ? (await installed(file)).content
      : readFileSync(file, 'utf8');
    const specs = [];
    for (const re of [
      /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*['"]([^'"]+)['"]/g,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    ])
      for (const m of text.matchAll(re)) specs.push({ spec: m[1] });
    for (const m of text.matchAll(/\bimport\(\s*`([^`]+)`\s*\)/g))
      specs.push({ spec: m[1], glob: true });
    for (let { spec, glob } of specs) {
      spec = spec.split('?')[0];
      let base;
      if (spec === '$lib' || spec.startsWith('$lib/')) base = path.join(lib, spec.slice(4));
      else if (spec.startsWith('.')) base = path.resolve(path.dirname(file), spec);
      else continue;
      if (glob) {
        const pattern = path.relative(lib, base).replace(/\$\{[^}]*\}/g, '*');
        for (const f of globSync(pattern, { cwd: lib })) pending.push(path.join(lib, f));
        continue;
      }
      const found = candidates(base).find(c => existsSync(c) && statSync(c).isFile());
      if (found) pending.push(found);
      else missing.push({ from: path.relative(lib, file), spec });
    }
  }
  return { files: [...seen].filter(f => f.startsWith(lib + path.sep)), missing };
}

/**
 * Copy the reached $lib files (reflinked where possible) into the host and
 * write the transformed content over the host copies the transform changed.
 */
async function copyLib(dir, name) {
  const target = path.join(dir, 'src/lib');
  mkdirSync(target, { recursive: true });
  const { files, missing } = await closure(path.join(examplesDir, name + '.svelte'));
  const rel = files.map(f => path.relative(lib, f)).sort();
  const r = spawnSync('cp', ['--parents', '-p', '--reflink=auto', ...rel, target], {
    cwd: lib,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`cp failed: ${r.stderr}`);
  const changed = [];
  const devDependencies = new Set();
  let svelteFiles = 0;
  for (const f of rel) {
    const copy = path.join(target, f);
    if (f.endsWith('.svelte')) {
      svelteFiles++;
      const t = await installed(path.join(lib, f));
      t.devDependencies.forEach(d => devDependencies.add(d));
      if (t.changed) {
        writeFileSync(copy, t.content);
        if (shaFile(copy) !== sha(t.content)) throw new Error(`host copy of ${f} differs`);
        changed.push({ file: path.posix.join(source.target, 'src/lib', f), sha256: sha(t.content) });
        continue;
      }
    }
    if (shaFile(path.join(lib, f)) !== shaFile(copy))
      throw new Error(`copied ${f} differs from the corpus`);
  }
  return {
    files: rel.length,
    missing,
    iconTransform: {
      applied: true,
      iconLibrary,
      svelteFiles,
      transformed: changed,
      devDependencies: [...devDependencies].sort(),
    },
  };
}

/**
 * The status of a worker result: a compiler diagnostic is a rejection unless
 * it reports the host, the toolchain or the compiler itself failing.
 */
function classify(r, copied) {
  if (r.status !== 'rejected') return r;
  if (r.code === 'E_INTERNAL' || r.code === 'E_BACKEND') {
    r.status = 'internalError';
    r.reason = r.crash ? 'compiler crashed' : `${r.code}: ${r.message.split('\n')[0]}`;
  } else if (r.code.startsWith('E_BUILD')) {
    r.status = 'harnessError';
    r.reason = `toolchain: ${r.message.split('\n')[0]}`;
  } else if (r.code === 'E_SVELTE_COMPILE') {
    // Vite's build of the generated host failed; the cause (host setup,
    // plugin, or source) is not attributed, so it is no compiler rejection.
    r.status = 'harnessError';
    r.reason = `host build failed (cause not attributed): ${r.message.split('\n')[0]}`;
  } else if (r.code === 'E_RESOLVE') {
    // An unresolved $lib or relative import is the host's closure missing
    // a file, not a compiler blocker.
    const spec = /Cannot resolve (\S+)/.exec(r.message)?.[1] ?? '';
    if (spec.startsWith('$lib') || spec.startsWith('.')) {
      r.status = 'harnessError';
      r.reason = `host closure missed ${spec} (misses: ${JSON.stringify(copied.missing)})`;
    }
  }
  return r;
}

function run(name) {
  return new Promise(async resolve => {
    const started = Date.now();
    let dir, copied;
    const done = r => {
      if (dir && !values['keep-lib']) rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    try {
      dir = host(name);
      copied = await copyLib(dir, name);
    } catch (e) {
      done({
        example: name,
        status: 'harnessError',
        reason: 'host: ' + strip(e?.message ?? e),
        ms: Date.now() - started,
      });
      return;
    }
    const base = {
      example: name,
      libFiles: copied.files,
      closureMisses: copied.missing,
      iconTransform: copied.iconTransform,
    };
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--one', dir], {
      cwd: repo,
      env: { ...process.env, PATH: stubDir + path.delimiter + process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), Number(values.timeout) * 1000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      writeFileSync(
        path.join(logDir, name + '.log'),
        stdout + (stderr ? '\n--- stderr\n' + stderr : ''),
      );
      const line = stdout.split('\n').findLast(l => l.startsWith('TRIAGE '));
      const ms = Date.now() - started;
      if (!line) {
        done({
          ...base,
          status: 'harnessError',
          reason: signal
            ? `worker killed (${signal}; timeout ${values.timeout}s)`
            : `worker exited ${status} without a result: ${strip(stderr).slice(-400)}`,
          ms,
        });
        return;
      }
      const r = classify({ ...base, ...JSON.parse(line.slice('TRIAGE '.length)) }, copied);
      r.ms = ms;
      done(r);
    });
  });
}

/** Path of a diagnostic's file in the corpus (docs/…) when it is a $lib file. */
function corpusFile(file) {
  if (!file) return null;
  if (file.startsWith('src/lib/')) return path.posix.join(source.target, file);
  return file;
}

/**
 * The cluster key: the code plus the construct that distinguishes the
 * blocker (the unresolved package, the rejected element or type, …), from
 * the message with literal positions removed.
 */
export function construct(r) {
  const m = r.message ?? '';
  const file = r.source?.file ?? '';
  if (r.code === 'E_RESOLVE') {
    const spec = /Cannot resolve (\S+)/.exec(m)?.[1] ?? '?';
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    // IconPlaceholder's loader imports `$lib/registry/icons/__<library>__/${icon}.ts`
    // dynamically; with the CLI's icon transform applied it is not reached.
    if (file.startsWith('src/lib/registry/icons/'))
      return 'IconPlaceholder dynamic icon import (icon packages not installed)';
    return `package ${pkg}`;
  }
  const head = m
    .split('\n')[0]
    .replace(/\s+at\s+\S+:\d+:\d+/g, '')
    .replace(/@\d+\.\d+\.\d+/g, '')
    .slice(0, 120);
  // Stylesheet declarations and elements name their construct; the line in
  // the generated stylesheet varies with the example's utilities.
  if (r.code.startsWith('E_CSS') || /is outside the supported elements/.test(m)) return head;
  // Other messages are generic (any/unknown, overloads, unions, classes):
  // the source position is the construct.
  const where = file.includes('/node_modules/')
    ? file.slice(file.lastIndexOf('/node_modules/') + '/node_modules/'.length)
    : file.startsWith('node_modules/')
      ? file.slice('node_modules/'.length)
      : (corpusFile(file) ?? '?');
  return `${head} @ ${where}:${r.source?.line ?? '?'}`;
}

const queue = [...selected];
const results = [];
const jobs = Math.max(1, Math.min(4, Number(values.jobs)));
let finished = 0;
const t0 = Date.now();
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (queue.length) {
      const name = queue.shift();
      const r = await run(name);
      if (r.source) r.corpusLocation = { ...r.source, file: corpusFile(r.source.file) };
      if (r.status === 'rejected') r.cluster = `${r.code}:${construct(r)}`;
      results.push(r);
      finished++;
      console.log(
        `[${finished}/${selected.length}] ${name} ${r.status}${r.code ? ' ' + r.code : ''}${
          r.reason ? ' ' + r.reason : ''
        }${r.closureMisses?.length ? ` closure misses ${JSON.stringify(r.closureMisses)}` : ''} (${r.ms} ms)`,
      );
    }
  }),
);
results.sort((a, b) => a.example.localeCompare(b.example));
if (!values['keep-lib']) {
  rmSync(path.join(out, 'hosts'), { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
}
if (cliRoot !== checkout) rmSync(cliRoot, { recursive: true, force: true });
const corpusAfter = corpusStatus();
if (corpusAfter) throw new Error(`the census changed the corpus checkout:\n${corpusAfter}`);

const clusters = {};
for (const r of results.filter(r => r.status === 'rejected')) {
  const c = (clusters[r.cluster] ??= {
    key: r.cluster,
    code: r.code,
    count: 0,
    examples: [],
    sampleMessage: r.message,
    sampleLocation: r.corpusLocation ?? null,
  });
  c.count++;
  c.examples.push(r.example);
}
const errors = {};
for (const r of results.filter(r => r.status === 'harnessError' || r.status === 'internalError')) {
  const key = `${r.status}:${r.code ?? '-'}:${(r.reason ?? '').slice(0, 160)}`;
  const c = (errors[key] ??= { key, status: r.status, code: r.code ?? null, count: 0, examples: [] });
  c.count++;
  c.examples.push(r.example);
}
const misses = {};
for (const r of results)
  for (const m of r.closureMisses ?? []) {
    const k = `${m.from} -> ${m.spec}`;
    (misses[k] ??= { ...m, examples: [] }).examples.push(r.example);
  }
const census = {
  generated: 'node conformance/triage.mjs',
  corpus: {
    name: source.name,
    commit: source.commit,
    examples: path.relative(checkout, examplesDir),
    outOfScope: 'examples/create/ (served by /preview/[item])',
    unmodified: 'git status of the checkout is clean before and after the run',
  },
  host: {
    shape: 'fixtures/bits-dialog-svelte (runic.json with tailwind and $lib alias, main.js, index.html, assets/DejaVuSans.woff2); src/App.svelte mounts the example',
    theme: {
      from: 'fixtures/bits-dialog-svelte/src/app.css',
      removed: removedFromTheme.map(l => l.trim()),
      sha256: sha(theme),
    },
    lib: 'the $lib files the example reaches as installed (static, type-only, side-effect and dynamic imports, template imports expanded), copied (reflinked) from the corpus docs/src/lib into each host, byte-identical (sha256-checked) except the .svelte files the icon transform changed; removed after analysis unless --keep-lib',
    iconTransform: {
      source:
        path.relative(repo, iconTransformFile) +
        (cliRoot === checkout ? '' : ` (read from ${source.commit}, then removed)`),
      sha256: shaFile(iconTransformFile),
      iconLibrary,
      packages: Object.fromEntries(
        Object.entries(cliDeps).map(([k, v]) => [k, `${v.version} (${v.path}; CLI ${v.range})`]),
      ),
      zod: 'stubbed (only utils.ts isUrl uses it, which the transform does not call)',
    },
  },
  codegenBinary: { path: path.relative(repo, binary), mtime: new Date(builtAt).toISOString() },
  totals: {
    examples: results.length,
    lowered: results.filter(r => r.status === 'lowered').length,
    rejected: results.filter(r => r.status === 'rejected').length,
    harnessError: results.filter(r => r.status === 'harnessError').length,
    internalError: results.filter(r => r.status === 'internalError').length,
    withClosureMisses: results.filter(r => r.closureMisses?.length).length,
    withTransformedFiles: results.filter(r => r.iconTransform?.transformed.length).length,
  },
  seconds: Math.round((Date.now() - t0) / 1000),
  clusters: Object.values(clusters).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  errors: Object.values(errors).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  closureMisses: Object.values(misses),
  results: results.map(({ stack, crash, ...r }) => ({
    ...r,
    ...(crash ? { crash } : {}),
    ...(stack ? { stack } : {}),
  })),
};
writeFileSync(path.join(out, 'census.json'), JSON.stringify(census, null, 2) + '\n');
console.log(JSON.stringify(census.totals));
for (const c of census.clusters) console.log(`${String(c.count).padStart(4)}  ${c.key}`);
for (const c of census.errors) console.log(`${String(c.count).padStart(4)}  ${c.key}`);
