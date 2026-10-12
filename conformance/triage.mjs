#!/usr/bin/env node
// Blocker census of the north star's component examples: for every
// shadcn-svelte example (docs/src/lib/registry/examples/*.svelte at the
// commit conformance/corpus/north-star.json pins), generate a Vite host app
// (the bits-* fixtures' shape) and run the analyze path (collect + lower +
// backend validation, no native build), recording the first diagnostic.
//
//   node conformance/triage.mjs [example ...] [--out DIR] [--jobs N] [--keep-lib]
//                               [--dynamic-values]
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
// their real path. A host is removed after its analysis unless --keep-lib is
// given.
//
// Each host shows the example as the site does. The site has no isolated
// route for the top-level examples (/view/[name] serves blocks,
// /preview/[item] examples/create/): a docs page shows each through
// ComponentPreview, which the site's mdsx preprocessor (docs/svelte.config.js,
// inject-component-preview) gives the example as `component`, under the
// layouts of its route. The host reproduces that, from the corpus's files
// (every one recorded with its sha256 in census.json, host.siteView):
//
// - the stylesheet: docs/src/app.css with what it imports:
//   registry/styles/style-vega.css (in the host's $lib),
//   shadcn-svelte/tailwind.css (the site's workspace package; its
//   dist/tailwind.css is the copy of packages/cli/src/tailwind.css its
//   tsdown.config.ts makes), @fontsource-variable/geist and geist-mono (the
//   repository's packages at the site's lockfile versions, integrity checked
//   against docs' pnpm-lock.yaml: Geist Variable and Geist Mono Variable as
//   local WOFF2 files, `format("woff2-variations")`), tw-animate-css and
//   tailwindcss (the repository's, at the site's lockfile versions). The
//   packages the stylesheet imports are copied into the host's node_modules/,
//   so the font files are inside the application (the collector's asset
//   rule). Every byte of app.css is the site's. Rules the compiler would
//   reject that no element of a host can match (the code-block rules for
//   the attributes rehype-pretty-code writes on the docs' highlighted code,
//   `[data-line]`, …; the `step` utility) are left out by the compiler on
//   proof (docs/CONTRACT.md, rules no element can match) and listed with
//   each result (skippedRules; census.skippedRules says why);
// - <html lang> and <body>'s attributes from docs/src/app.html (classes
//   `theme-blue style-vega … font-sans text-foreground antialiased`) and its
//   `<div style="display: contents">` container;
// - the example's ancestors in a docs page, each start tag copied verbatim
//   from its template: the (app) layout's Tooltip.Provider, the (layout)
//   layout's page box, <main> and Tooltip.Provider, the docs layout's
//   container and content box, the docs page's columns, the mdsx blueprint's
//   `.mdsx` wrapper, and ComponentPreview with the attributes of the
//   example's <ComponentPreview> in docs/content (its component's own page
//   first), plus `hideCode` and `id="demo"` (the region the render census
//   compares). The two Tooltip.Provider ancestors are kept where the example
//   reaches the tooltip (the result's `tooltipProviders`): elsewhere they
//   render only their children and set a context nothing reads, and their
//   state does not lower in a program without a tooltip.
//
// Left out, each with its reason (host.siteView.omitted): the ancestors'
// other children (site header and footer, the docs sidebar and table of
// contents, hidden below the lg and xl breakpoints, the page's title and
// other markdown), ComponentPreview's code panel, the root layout's
// TailwindIndicator (dev only), app.html's head scripts, the docs layout's
// Sidebar.Provider (svelte/reactivity's MediaQuery does not lower; its
// wrapper draws nothing), the (app) layout's ModeWatcher, Toaster and user
// config context and the (layout) layout's menu colour sync.
//
// With --dynamic-values, every host sets runic.json
// `"dynamicValues": true` (the opt-in dynamic value tier for untyped code,
// docs/design/M6-DYNAMIC-VALUES.md); the census records it.
//
// SvelteKit's `$app/*` modules (combobox-responsive imports
// `$app/environment`, and so does sveltekit-superforms for form-demo) exist
// only in a Kit app, as in the site. An example whose lib files import one,
// or whose plain host's build fails to resolve one a package imports, gets
// (or is rerun in) a Kit host instead
// (fixtures/kit-routes-svelte's svelte.config.js and its app.html with the
// site's <html> and <body> attributes, a root layout importing the
// stylesheet, the site's view as src/routes/+page.svelte, `$lib` from Kit),
// where the collector provides them (compiler/adapters/kit-app.mjs);
// the result records `kitHost`. A Kit app lowers its route tree, so where an
// example has several blockers the first one reported can differ from a
// plain host's.
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
  realpathSync,
} from 'node:fs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'artifacts/triage-2026-10-12' },
    jobs: { type: 'string', default: '4' },
    timeout: { type: 'string', default: '600' },
    'keep-lib': { type: 'boolean' },
    'dynamic-values': { type: 'boolean' },
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
    // Pinning images is the explicit networked step (`runic images`), never
    // part of the census: the URLs a lowered example needs are recorded.
    const { imageUrls = [], skippedRules = [] } = await lower(graph, { images: false });
    const urls = [...new Set(imageUrls.map(u => u.url))].sort();
    result = {
      status: 'lowered',
      ...(urls.length ? { imageUrls: urls } : {}),
      // Rules the compiler left out because no element can match them.
      ...(skippedRules.length ? { skippedRules } : {}),
    };
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
const kitFixture = path.join(repo, 'fixtures/kit-routes-svelte');

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
// (Its real path: Node resolves modules by it, also where .cache/corpus is a
// link to the main tree's, as in a worktree.)
const cliDir = realpathSync(path.join(cliRoot, 'packages/cli'));
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

// --- The site's example view (see the header) ---

/** Every corpus file the hosts are made from, with its sha256 (census.json). */
const siteFiles = {};
const siteText = rel => {
  const bytes = readFileSync(path.join(checkout, rel));
  siteFiles[rel] = sha(bytes);
  return bytes.toString('utf8');
};
/**
 * The start tag of the element `needle` locates in `text` (the needle occurs
 * once; the tag is read verbatim up to its `>`, outside quotes and braces).
 */
function startTag(text, needle, file) {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0)
    throw new Error(`${file}: expected one ${JSON.stringify(needle)}`);
  return tagAt(text, text.lastIndexOf('<', at), file);
}
/** The start tag at `start` in `text`, verbatim. */
function tagAt(text, start, file) {
  let quote = null;
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) quote = c === quote ? null : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && !depth) {
      const tag = text.slice(start, i + 1);
      return { tag, name: /^<([\w.:-]+)/.exec(tag)[1] };
    }
  }
  throw new Error(`${file}: unterminated tag at ${start}`);
}
const attributesOf = tag =>
  tag
    .replace(/^<[\w.:-]+/, '')
    .replace(/\/?>$/, '')
    .trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// The stylesheet and what it imports.
const siteCss = path.posix.join(source.target, 'src/app.css');
const siteCssText = siteText(siteCss);
const cssImports = [...siteCssText.matchAll(/^@import "([^"]+)"/gm)].map(m => m[1]);
const expectedImports = [
  'tailwindcss',
  'tw-animate-css',
  'shadcn-svelte/tailwind.css',
  './lib/registry/styles/style-vega.css',
  '@fontsource-variable/geist/index.css',
  '@fontsource-variable/geist-mono/index.css',
];
if (cssImports.join() !== expectedImports.join())
  throw new Error(`${siteCss} imports ${cssImports.join(', ')}; the hosts expect ${expectedImports}`);
const vegaFile = path.join(lib, 'registry/styles/style-vega.css');
siteText(path.relative(checkout, vegaFile));
// The host's stylesheet is the site's, byte for byte.
const hostCss = siteCssText;

// The versions docs/ locks (pnpm-lock.yaml, importer `docs`) and, for the
// packages the hosts copy, their integrity.
const lockText = siteText('pnpm-lock.yaml');
const docsImporter = /\n {2}docs:\n([\s\S]*?)\n {2}\S/.exec(lockText)?.[1] ?? '';
const lockedVersion = pkg => {
  const key = pkg.startsWith('@') ? `'${pkg}'` : pkg;
  const m = new RegExp(
    `\\n {6}${escapeRe(key)}:\\n {8}specifier: \\S+\\n {8}version: ([^\\s(]+)`,
  ).exec('\n' + docsImporter);
  if (!m) throw new Error(`pnpm-lock.yaml: docs does not lock ${pkg}`);
  return m[1];
};
const lockedIntegrity = (pkg, version) => {
  const m = new RegExp(
    `\\n {2}'?${escapeRe(pkg)}@${escapeRe(version)}'?:\\n {4}resolution: \\{integrity: (\\S+)\\}`,
  ).exec(lockText);
  if (!m) throw new Error(`pnpm-lock.yaml: no resolution for ${pkg}@${version}`);
  return m[1];
};
const repoLock = JSON.parse(readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
/** A package of the repository's node_modules, at the version docs/ locks. */
function sitePackage(pkg, { integrity = false } = {}) {
  const version = lockedVersion(pkg);
  const dir = path.join(repo, 'node_modules', pkg);
  const installed = existsSync(path.join(dir, 'package.json'))
    ? JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version
    : null;
  if (installed !== version)
    throw new Error(
      `node_modules/${pkg} is ${installed ?? 'missing'}; the site locks ${version} (npm ci)`,
    );
  const entry = { version, dir };
  if (integrity) {
    entry.integrity = lockedIntegrity(pkg, version);
    const npm = repoLock.packages?.[`node_modules/${pkg}`];
    if (npm?.version !== version || npm?.integrity !== entry.integrity)
      throw new Error(`package-lock.json: ${pkg} is not ${version} with the site's integrity`);
  }
  return entry;
}
const resolvedPackages = Object.fromEntries(
  ['tailwindcss', 'tw-animate-css'].map(p => [p, `${sitePackage(p).version} (node_modules)`]),
);
/**
 * The files the hosts copy into their node_modules/ (the stylesheet's other
 * package imports), destination -> source. shadcn-svelte is the site's
 * workspace package (packages/cli); its build copies src/tailwind.css to
 * dist/tailwind.css, the file its exports name.
 */
const hostPackages = {};
const packageRecord = {};
{
  const cli = 'packages/cli';
  const manifest = JSON.parse(siteText(`${cli}/package.json`));
  if (
    manifest.name !== 'shadcn-svelte' ||
    manifest.exports?.['./tailwind.css']?.style !== './dist/tailwind.css' ||
    !siteText(`${cli}/tsdown.config.ts`).includes(
      'copyFileSync("src/tailwind.css", "dist/tailwind.css")',
    )
  )
    throw new Error(`${cli}: shadcn-svelte/tailwind.css is no longer a copy of src/tailwind.css`);
  siteText(`${cli}/src/tailwind.css`);
  hostPackages['shadcn-svelte/package.json'] = path.join(checkout, cli, 'package.json');
  hostPackages['shadcn-svelte/dist/tailwind.css'] = path.join(checkout, cli, 'src/tailwind.css');
  packageRecord['shadcn-svelte'] = {
    version: `${manifest.version} (workspace:*)`,
    files: {
      'package.json': `${cli}/package.json`,
      'dist/tailwind.css': `${cli}/src/tailwind.css`,
    },
  };
  for (const pkg of ['@fontsource-variable/geist', '@fontsource-variable/geist-mono']) {
    const p = sitePackage(pkg, { integrity: true });
    const files = [
      'package.json',
      'index.css',
      ...readdirSync(path.join(p.dir, 'files'))
        .sort()
        .map(f => `files/${f}`),
    ];
    const index = readFileSync(path.join(p.dir, 'index.css'), 'utf8');
    for (const m of index.matchAll(/url\(\.\/([^)]+)\)/g))
      if (!files.includes(m[1])) throw new Error(`${pkg}/index.css loads ${m[1]}, which is absent`);
    packageRecord[pkg] = { version: p.version, integrity: p.integrity, files: {} };
    for (const f of files) {
      hostPackages[`${pkg}/${f}`] = path.join(p.dir, f);
      packageRecord[pkg].files[f] = shaFile(path.join(p.dir, f));
    }
  }
}

// <html> and <body> from app.html.
const appHtmlFile = path.posix.join(source.target, 'src/app.html');
const appHtml = siteText(appHtmlFile);
const htmlAttributes = attributesOf(startTag(appHtml, '<html', appHtmlFile).tag);
const bodyAttributes = attributesOf(startTag(appHtml, '<body', appHtmlFile).tag);
const container = startTag(appHtml, '<div style="display: contents">', appHtmlFile).tag;

// The example's ancestors in a docs page, outermost first.
const routes = path.posix.join(source.target, 'src/routes/(app)');
const docsPage = `${routes}/(layout)/docs/[...slug]/+page.svelte`;
const ancestorSpec = [
  [`${routes}/+layout.svelte`, '<Tooltip.Provider>'],
  [`${routes}/(layout)/+layout.svelte`, '<div class="relative z-10 flex min-h-svh'],
  [`${routes}/(layout)/+layout.svelte`, '<main'],
  [`${routes}/(layout)/+layout.svelte`, '<Tooltip.Provider>'],
  [`${routes}/(layout)/docs/+layout.svelte`, '<div class="container-wrapper'],
  [`${routes}/(layout)/docs/+layout.svelte`, '<div class="h-full w-full">'],
  [docsPage, 'data-slot="docs"'],
  [docsPage, '<div class="flex min-w-0 flex-1 flex-col">'],
  [docsPage, 'class="mx-auto flex w-full max-w-[40rem]'],
  [docsPage, '<div class="w-full flex-1 pb-16'],
  [path.posix.join(source.target, 'src/lib/components/mdsx/blueprint.svelte'), '<div class="mdsx">'],
];
const ancestors = ancestorSpec.map(([file, needle]) => ({
  file,
  ...startTag(siteText(file), needle, file),
}));
// The imports of the ancestors' components, as their templates write them.
const siteImports = [
  [`${routes}/+layout.svelte`, 'import * as Tooltip from "$lib/registry/ui/tooltip/index.js";'],
];
for (const [file, line] of siteImports)
  if (!siteText(file).includes(line)) throw new Error(`${file} no longer has ${line}`);
const previewImport = 'import ComponentPreview from "$lib/components/component-preview.svelte";';
const previewFile = path.join(lib, 'components/component-preview.svelte');
siteText(path.relative(checkout, previewFile));
siteText(path.relative(checkout, path.join(lib, 'components/component-preview-tabs.svelte')));
// The site's mdsx preprocessing of a <ComponentPreview name="…"> (the
// inject-component-preview preprocessor of docs/svelte.config.js).
const svelteConfig = path.posix.join(source.target, 'svelte.config.js');
const svelteConfigText = siteText(svelteConfig);
for (const s of [
  'const camelize = (/** @type {string} */ s) => s.replace(/-./g, (w) => w[1].toUpperCase());',
  'const prop = ` component={${identifier}}`;',
  'importStatement = `import ${identifier} from "$lib/registry/examples/${name}.svelte";`;',
])
  if (!svelteConfigText.includes(s))
    throw new Error(`${svelteConfig}: the ComponentPreview injection changed (${s})`);
const camelize = s => s.replace(/-./g, w => w[1].toUpperCase());

/**
 * The <ComponentPreview> of each example in docs/content, verbatim; where it
 * appears on several pages, its component's own page (content/components/
 * first, then the page whose name is the longest prefix of the example's).
 */
const previews = new Map();
{
  const content = path.join(docs, 'content');
  const found = [];
  for (const f of globSync('**/*.md', { cwd: content }).sort()) {
    const text = readFileSync(path.join(content, f), 'utf8');
    for (const m of text.matchAll(/<ComponentPreview\b/g)) {
      const { tag } = tagAt(text, m.index, f);
      const name = /\sname="([^"]*)"/.exec(tag)?.[1];
      if (!name || /\stype="block"/.test(tag)) continue;
      const page = path.basename(f, '.md');
      found.push({
        name,
        tag,
        file: path.posix.join(source.target, 'content', f),
        line: text.slice(0, m.index).split('\n').length,
        rank: [
          f.startsWith('components/') ? 0 : 1,
          name === page || name.startsWith(page + '-') ? -page.length : 0,
        ],
      });
    }
  }
  found.sort(
    (a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.file.localeCompare(b.file),
  );
  for (const p of found) if (!previews.has(p.name)) previews.set(p.name, p);
}

/**
 * The example in the site's view: App.svelte (plain host) or the page (Kit
 * host). The Tooltip.Provider ancestors only where the example reaches the
 * tooltip (`tooltip`, readsTooltip).
 */
function siteView(name, { kit, tooltip }) {
  const id = camelize(name);
  const preview = previews.get(name);
  const tag = preview?.tag ?? `<ComponentPreview name="${name}">`;
  if (/[{}]/.test(tag)) throw new Error(`${name}: <ComponentPreview> with an expression: ${tag}`);
  const attrs = attributesOf(tag);
  const element =
    `<ComponentPreview component={${id}} ${attrs}` +
    (/(^|\s)hideCode(\s|$)/.test(attrs) ? '' : ' hideCode') +
    ' id="demo" />';
  const kept = ancestors.filter(a => tooltip || a.name !== 'Tooltip.Provider');
  const chain = kit ? kept : [{ tag: container, name: 'div' }, ...kept];
  const indent = i => '\t'.repeat(i);
  const markup = [
    ...chain.map(
      (a, i) =>
        indent(i) +
        a.tag
          .split('\n')
          .map((l, j) => (j ? indent(i) + l.replace(/^\s*/, /^\s*>$/.test(l) ? '' : '\t') : l))
          .join('\n'),
    ),
    indent(chain.length) + element,
    ...chain.map((a, i) => `${indent(i)}</${a.name}>`).reverse(),
  ].join('\n');
  const script = [
    ...(tooltip ? siteImports.map(([, line]) => line) : []),
    previewImport,
    `import ${id} from "$lib/registry/examples/${name}.svelte";`,
  ];
  return {
    text: `<script lang="ts">\n${script.map(l => '\t' + l).join('\n')}\n</script>\n\n${markup}\n`,
    preview: preview ? { from: `${preview.file}:${preview.line}`, tag } : { inDocs: false, tag },
  };
}
// The $lib files the host's own markup reaches: the ancestors' components,
// ComponentPreview and the stylesheet's style-vega.css.
const tooltipIndex = path.join(lib, 'registry/ui/tooltip/index.ts');
const siteLibEntries = tooltip => [...(tooltip ? [tooltipIndex] : []), previewFile, vegaFile];
for (const f of siteLibEntries(true)) if (!existsSync(f)) throw new Error(`${f} is missing`);
/**
 * Whether the example's own files reach the tooltip (registry/ui/tooltip or
 * bits-ui's Tooltip), the only readers of the Tooltip.Provider context
 * (bits-ui's tooltip module; the registry's other users, sidebar-menu-button
 * and sidebar-provider, go through registry/ui/tooltip).
 */
async function readsTooltip(name) {
  const { files } = await closure([path.join(examplesDir, name + '.svelte')]);
  const dir = path.dirname(tooltipIndex) + path.sep;
  for (const f of files) {
    if (f.startsWith(dir)) return true;
    const text = f.endsWith('.svelte') ? (await installed(f)).content : readFileSync(f, 'utf8');
    if (/\bimport\s*\{[^}]*\bTooltip\b[^}]*\}\s*from\s*["']bits-ui["']/.test(text)) return true;
  }
  return false;
}

/** What the hosts leave out of the site's view, and why (census.json). */
const siteOmitted = [
  {
    what: "the ancestors' other children: SiteHeader, SiteFooter, DocsSidebar, the table of contents, the page's title, description, links and other markdown",
    why: 'they are not the example; DocsSidebar and the table of contents are hidden below the lg and xl breakpoints (the census viewport is 800 px wide)',
  },
  {
    what: "ComponentPreview's code panel (the hosts pass hideCode)",
    why: "it holds the example's highlighted source (mdsx and shiki at the site's build), not the example",
  },
  {
    what: "the root layout's TailwindIndicator",
    why: 'it renders in dev only ($app/environment); the site is a production build',
  },
  {
    what: "app.html's head: the user config cookie script and the analytics scripts",
    why: 'the cookie script does nothing without the scn_user_config cookie, which the census does not set; the analytics scripts are remote and draw nothing',
  },
  {
    what: "the (app) layout's ModeWatcher (mode-watcher, defaultMode system) and its `d` key handler",
    why: "mode-watcher does not lower (E_DEPENDENCY: it does not declare sideEffects false; example census); in Chromium's default light scheme it sets color-scheme: light on <html>, the default rendering",
  },
  {
    what: "the (app) layout's Toaster (registry/ui/sonner, svelte-sonner)",
    why: 'svelte-sonner does not lower (E_TYPE_UNSUPPORTED in dist/toast-state.svelte.js; example census); without a toast it renders an empty notification section',
  },
  {
    what: "the two Tooltip.Provider ancestors (the (app) and (layout) layouts'), for an example none of whose files reaches the tooltip (registry/ui/tooltip or bits-ui's Tooltip; the host's tooltipProviders is false)",
    why: "a Tooltip.Provider renders only its children and sets a context only bits-ui's tooltip reads (it also listens for window scrolls that close an open tooltip); in a program without a tooltip its state does not lower (E_TYPE_UNSUPPORTED at bits-ui/dist/bits/tooltip/tooltip.svelte.js:16: the trigger registry's untyped `new Map()`, whose entries only the tooltip's own code sets), while an example that reaches the tooltip keeps both providers",
  },
  {
    what: 'the docs layout\'s Sidebar.Provider (registry/ui/sidebar): its wrapper <div data-slot="sidebar-wrapper">, a full-width flex row whose one rendered child is the full-width "h-full w-full" div, its Tooltip.Provider (delayDuration 0) and its keyboard shortcut',
    why: "it does not lower (E_CAPABILITY: svelte/reactivity's MediaQuery, through registry/hooks/is-mobile.svelte.ts); the wrapper draws no background or border and its child keeps its place, the tooltip provider acts on hover only, and the census presses no key",
  },
  {
    what: "the (app) layout's UserConfigContext",
    why: 'no example reads it',
  },
  {
    what: "the (layout) layout's syncMenuColor (lib/features/design-system/menu-color.ts)",
    why: 'a MutationObserver that removes cn-menu-translucent from menus as they open; the census opens none',
  },
];

/** runic.json's opt-in dynamic value tier, with --dynamic-values. */
const dynamicValues = values['dynamic-values'] ? { dynamicValues: true } : {};

/** Copy the stylesheet's packages into the host's node_modules/. */
function copyPackages(dir) {
  for (const [to, from] of Object.entries(hostPackages)) {
    const target = path.join(dir, 'node_modules', to);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(from, target);
  }
}

/** Write the host shell (everything but src/lib) for `name`. */
function host(name, tooltip) {
  const dir = path.join(out, 'hosts', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'runic.json'),
    JSON.stringify(
      {
        framework: 'svelte',
        entry: 'main.js',
        title: `Runic triage ${name}`,
        tailwind: true,
        alias: { $lib: 'src/lib' },
        ...dynamicValues,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(path.join(dir, 'main.js'), readFileSync(path.join(fixture, 'main.js')));
  writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><html ${htmlAttributes}><head></head><body ${bodyAttributes}><div id="root"></div><script type="module" src="/main.js"></script></body></html>\n`,
  );
  const view = siteView(name, { kit: false, tooltip });
  writeFileSync(path.join(dir, 'src/App.svelte'), view.text);
  writeFileSync(path.join(dir, 'src/app.css'), hostCss);
  copyPackages(dir);
  return { dir, preview: view.preview };
}

/**
 * Turn the host shell into a SvelteKit app (fixtures/kit-routes-svelte's
 * svelte.config.js and app.html, with the site's <html> and <body>
 * attributes), for an example whose files import `$app/*`: those modules
 * exist only in a Kit app, where the collector provides them
 * (compiler/adapters/kit-app.mjs), as they do in the site. The root layout
 * imports the stylesheet, as the site's does, and the page holds the site's
 * view (app.html gives its container); Kit gives `$lib`.
 */
function kitHost(dir, name, tooltip) {
  for (const f of ['main.js', 'index.html', 'src/App.svelte']) rmSync(path.join(dir, f));
  writeFileSync(
    path.join(dir, 'runic.json'),
    JSON.stringify(
      {
        framework: 'svelte',
        kit: true,
        title: `Runic triage ${name}`,
        tailwind: true,
        ...dynamicValues,
      },
      null,
      2,
    ) + '\n',
  );
  copyFileSync(path.join(kitFixture, 'svelte.config.js'), path.join(dir, 'svelte.config.js'));
  const kitHtml = readFileSync(path.join(kitFixture, 'src/app.html'), 'utf8');
  const kitFile = 'fixtures/kit-routes-svelte/src/app.html';
  writeFileSync(
    path.join(dir, 'src/app.html'),
    kitHtml
      .replace(startTag(kitHtml, '<html', kitFile).tag, `<html ${htmlAttributes}>`)
      .replace(startTag(kitHtml, '<body', kitFile).tag, `<body ${bodyAttributes}>`),
  );
  mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
  writeFileSync(
    path.join(dir, 'src/routes/+layout.svelte'),
    `<script lang="ts">\n  import '../app.css';\n  import type { Snippet } from 'svelte';\n\n` +
      `  let { children }: { children: Snippet } = $props();\n</script>\n\n{@render children()}\n`,
  );
  writeFileSync(path.join(dir, 'src/routes/+page.svelte'), siteView(name, { kit: true, tooltip }).text);
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
 * The $lib files `entries` reach, as installed, through static imports and
 * exports (types included), side-effect imports and dynamic imports (template
 * literals are expanded as Vite expands them, each substitution matching
 * within one path segment), as the fixtures vendor them: only the reached
 * files are present, so Tailwind's source detection sees what the example
 * and the site's view use.
 */
async function closure(entries) {
  const seen = new Set();
  const missing = [];
  const pending = [...entries];
  // SvelteKit's `$app/*` modules the reached files import (Kit hosts).
  const app = new Set();
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
      else {
        if (spec.startsWith('$app/')) app.add(spec);
        continue;
      }
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
  return {
    files: [...seen].filter(f => f.startsWith(lib + path.sep)),
    missing,
    app: [...app].sort(),
  };
}

/**
 * Copy the reached $lib files (reflinked where possible) into the host and
 * write the transformed content over the host copies the transform changed.
 */
async function copyLib(dir, name, tooltip) {
  const target = path.join(dir, 'src/lib');
  mkdirSync(target, { recursive: true });
  const closed = await closure([path.join(examplesDir, name + '.svelte'), ...siteLibEntries(tooltip)]);
  const { files, missing } = closed;
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
    app: closed.app,
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

/**
 * The `$app/*` module a plain host's build could not resolve: one a package
 * imports (sveltekit-superforms), which the lib closure does not scan.
 */
const appImportOf = r =>
  r.status === 'harnessError' && r.code === 'E_SVELTE_COMPILE'
    ? /failed to resolve import "(\$app\/[^"]+)" from "([^"]+)"/.exec(r.message)
    : null;

/** Triage one example; a package importing `$app/*` reruns it in a Kit host. */
async function run(name) {
  const r = await runIn(name, []);
  const app = appImportOf(r);
  if (!app) return r;
  return runIn(name, [`${app[1]} (${path.relative(repo, app[2])})`]);
}

function runIn(name, packageApp) {
  return new Promise(async resolve => {
    const started = Date.now();
    let dir, copied, preview, tooltip;
    const done = r => {
      if (dir && !values['keep-lib']) rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    try {
      tooltip = await readsTooltip(name);
      ({ dir, preview } = host(name, tooltip));
      copied = await copyLib(dir, name, tooltip);
      copied.app.push(...packageApp);
      if (copied.app.length) kitHost(dir, name, tooltip);
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
      ...(copied.app.length ? { kitHost: { app: copied.app } } : {}),
      preview,
      tooltipProviders: tooltip,
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
    .replace(/@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/g, '')
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
// The rules left out (results' skippedRules), by selector: where, the
// rejections they would have been (one per rejected declaration), why no
// element can match them, in which examples.
const skippedRules = {};
for (const r of results)
  for (const k of r.skippedRules ?? []) {
    const e = (skippedRules[k.selector] ??= {
      file: k.file,
      line: k.line,
      code: k.code,
      messages: [],
      reasons: [],
      examples: [],
    });
    if (!e.messages.includes(k.message)) e.messages.push(k.message);
    if (!e.reasons.includes(k.reason)) e.reasons.push(k.reason);
    if (!e.examples.includes(r.example)) e.examples.push(r.example);
  }
const census = {
  generated: 'node conformance/triage.mjs',
  ...(values['dynamic-values'] ? { dynamicValues: true } : {}),
  corpus: {
    name: source.name,
    commit: source.commit,
    examples: path.relative(checkout, examplesDir),
    outOfScope: 'examples/create/ (served by /preview/[item])',
    unmodified: 'git status of the checkout is clean before and after the run',
  },
  host: {
    shape:
      "the site's example view: runic.json (tailwind, $lib alias), the fixtures' main.js, index.html with app.html's <html> and <body> attributes, src/app.css (the site's stylesheet), src/App.svelte (app.html's container, the example's ancestors in a docs page and its ComponentPreview with hideCode and id=\"demo\"), node_modules/ with the stylesheet's copied packages",
    kitShape:
      "for examples whose files or packages import $app/* (results with kitHost): a SvelteKit app with fixtures/kit-routes-svelte/svelte.config.js and src/app.html (the site's <html> and <body> attributes), runic.json kit and tailwind, src/routes/+layout.svelte importing the stylesheet, src/routes/+page.svelte holding the site's view; Kit gives $lib",
    siteView: {
      stylesheet: {
        from: siteCss,
        sha256: sha(hostCss),
        unchanged:
          "byte-identical to the site's; rules the compiler would reject that no element of a host can match are left out by the compiler (each result's skippedRules, census.skippedRules)",
      },
      body: bodyAttributes,
      html: htmlAttributes,
      ancestors: ancestors.map(a => ({ file: a.file, tag: a.tag })),
      tooltipProviders:
        "the Tooltip.Provider ancestors are kept where the example's files reach the tooltip (each result's tooltipProviders); see omitted",
      preview: previewImport,
      packages: packageRecord,
      resolved: resolvedPackages,
      omitted: siteOmitted,
      files: Object.fromEntries(Object.entries(siteFiles).sort(([x], [y]) => x.localeCompare(y))),
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
    withSkippedRules: results.filter(r => r.skippedRules?.length).length,
  },
  seconds: Math.round((Date.now() - t0) / 1000),
  clusters: Object.values(clusters).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  errors: Object.values(errors).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  closureMisses: Object.values(misses),
  skippedRules,
  results: results.map(({ stack, crash, skippedRules, ...r }) => ({
    ...r,
    ...(skippedRules ? { skippedRules: [...new Set(skippedRules.map(k => k.selector))] } : {}),
    ...(crash ? { crash } : {}),
    ...(stack ? { stack } : {}),
  })),
};
writeFileSync(path.join(out, 'census.json'), JSON.stringify(census, null, 2) + '\n');
console.log(JSON.stringify(census.totals));
for (const c of census.clusters) console.log(`${String(c.count).padStart(4)}  ${c.key}`);
for (const c of census.errors) console.log(`${String(c.count).padStart(4)}  ${c.key}`);
