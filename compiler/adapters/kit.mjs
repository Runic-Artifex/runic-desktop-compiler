// SvelteKit apps (docs/design/M6-SVELTEKIT.md): collection without running
// the app's Vite or Svelte config. runic.json declares the app (`"kit":
// true`); its svelte.config.js is read statically (literal options only);
// the route manifest is built by the app's own pinned Kit
// (`create_manifest_data`); and the app is compiled as an ordinary Svelte
// program: a generated root composes the routes' layouts and pages, and
// Kit's client router, ported to the compiled language
// (frontend/adapters/kit/), runs natively.
//
// Generated modules live under `<app>/.svelte-kit/runic/` as virtual files
// (nothing is written to the app): the router (copied from
// frontend/adapters/kit/), the app module (routes, loads, data), the
// reactive tree the root reads, the root components, the entry, `$app/*`
// and `@sveltejs/kit`, and each route directory's `$types`.
import ts from 'typescript';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parse as parseHTML } from 'parse5';
import { Diagnostic } from '../collect.mjs';
import { KIT_PINS } from './kit-pins.mjs';

/** The checked SvelteKit version (the shadcn-svelte site's lockfile pin). */
export const KIT_VERSION = '2.70.1';

export const at = (file, line = 1, column = 1) => ({ file, line, column });
export const kitFail = (code, message, source = at('svelte.config.js')) => {
  throw new Diagnostic(code, message, source);
};

/** Line and column of `pos` in `text`. */
function position(text, pos) {
  const before = text.slice(0, pos).split('\n');
  return { line: before.length, column: before.at(-1).length + 1 };
}

// --- svelte.config.js, read statically ---

/** A literal value of a config property (strings, booleans, numbers, objects, arrays). */
function literal(node, file, text) {
  const where = () => {
    const p = position(text, node.getStart());
    return at(file, p.line, p.column);
  };
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(e => literal(e, file, text));
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (
        !ts.isPropertyAssignment(p) ||
        !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))
      )
        kitFail('E_KIT_CONFIG', 'svelte.config.js options must be literal properties', where());
      out[p.name.text] = { node: p.initializer };
    }
    return out;
  }
  return kitFail(
    'E_KIT_CONFIG',
    'svelte.config.js options read by the compiler must be literals (the config is not run)',
    where(),
  );
}

/**
 * The options of svelte.config.js that matter to the compiled app, read
 * from its syntax: `kit.router.type`, `kit.alias`; options that only
 * configure the build (`adapter`, `prerender`, `appDir`, `version.name`,
 * `outDir`, …) are skipped; others are rejected.
 */
export function readSvelteConfig(root, runic = {}) {
  // Preprocessors run only in a declared generation step (runic.json
  // `generate`, compiler/generate.mjs), whose outputs builds read; the
  // extensions they compile are the preprocessed files' (`.md`).
  const preprocessSteps = (runic.generate ?? []).filter(s => s?.preprocess !== undefined);
  const file = path.join(root, 'svelte.config.js');
  if (!existsSync(file))
    kitFail(
      'E_KIT_CONFIG',
      'A SvelteKit app needs svelte.config.js (Kit 2.70: its options are there)',
      at('svelte.config.js'),
    );
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const where = n => {
    const p = position(text, n.getStart(sf));
    return at('svelte.config.js', p.line, p.column);
  };
  let exported;
  const consts = new Map();
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) exported = stmt.expression;
  }
  if (exported && ts.isIdentifier(exported)) exported = consts.get(exported.text);
  while (
    exported &&
    (ts.isParenthesizedExpression(exported) ||
      ts.isSatisfiesExpression(exported) ||
      ts.isAsExpression(exported))
  )
    exported = exported.expression;
  if (!exported || !ts.isObjectLiteralExpression(exported))
    kitFail(
      'E_KIT_CONFIG',
      'svelte.config.js must export a config object literal (directly or through a const)',
      at('svelte.config.js'),
    );
  const config = literal(exported, 'svelte.config.js', text);
  const value = entry => literal(entry.node, 'svelte.config.js', text);
  const out = {
    routerType: 'pathname',
    aliases: {},
    bundleStrategy: 'split',
    notes: [],
    extensions: ['.svelte'],
  };
  for (const [key, entry] of Object.entries(config)) {
    if (key === 'kit') continue;
    if (key === 'preprocess' && preprocessSteps.length) {
      // Not read here: `runic generate` runs it (the step's record is checked).
      out.notes.push(
        `preprocess runs in the generation step ${preprocessSteps.map(s => s.name).join(', ')}`,
      );
      continue;
    }
    if (key === 'extensions' && preprocessSteps.length) {
      const ext = value(entry);
      if (
        !Array.isArray(ext) ||
        !ext.includes('.svelte') ||
        ext.some(
          e =>
            typeof e !== 'string' ||
            !/^\.[a-z]+$/.test(e) ||
            (e !== '.svelte' && !preprocessSteps.some(s => s.preprocess.endsWith('*' + e))),
        )
      )
        kitFail(
          'E_KIT_CONFIG',
          'Svelte extensions other than .svelte must be the files of a preprocess generation step (runic.json generate, "preprocess": "…/*.md")',
          where(entry.node),
        );
      out.extensions = ext;
      continue;
    }
    if (key === 'compilerOptions') {
      const opts = value(entry);
      for (const [k, v] of Object.entries(opts))
        if (k !== 'runes' || literal(v.node, 'svelte.config.js', text) !== true)
          kitFail(
            'E_KIT_CONFIG',
            `compilerOptions.${k} is unsupported (runes mode is the compiled one)`,
            where(v.node),
          );
      continue;
    }
    if (key === 'extensions') {
      const ext = value(entry);
      if (JSON.stringify(ext) !== '[".svelte"]')
        kitFail(
          'E_KIT_CONFIG',
          'Svelte extensions other than .svelte are unsupported',
          where(entry.node),
        );
      continue;
    }
    kitFail(
      'E_KIT_CONFIG',
      `svelte.config.js ${key} is unsupported (${key === 'preprocess' ? 'preprocessors run as declared build steps, a later step' : 'the compiler reads kit options only'})`,
      where(entry.node),
    );
  }
  const kit = config.kit ? value(config.kit) : {};
  // Options that configure the build or a server only: no meaning natively.
  const BUILD_ONLY = new Set([
    'adapter',
    'prerender',
    'appDir',
    'outDir',
    'typescript',
    'csp',
    'csrf',
    'env',
    'inlineStyleThreshold',
    'serviceWorker',
  ]);
  for (const [key, entry] of Object.entries(kit)) {
    if (BUILD_ONLY.has(key)) {
      out.notes.push(`kit.${key} configures the build only`);
      continue;
    }
    if (key === 'router') {
      const router = value(entry);
      for (const [k, v] of Object.entries(router)) {
        const lit = literal(v.node, 'svelte.config.js', text);
        if (k === 'type' && (lit === 'hash' || lit === 'pathname')) out.routerType = lit;
        else if (k === 'resolution' && lit === 'client') continue;
        else
          kitFail(
            'E_KIT_CONFIG',
            `kit.router.${k} ${JSON.stringify(lit)} is unsupported (type: 'hash' | 'pathname', resolution: 'client')`,
            where(v.node),
          );
      }
      continue;
    }
    if (key === 'alias') {
      for (const [k, v] of Object.entries(value(entry))) {
        const target = literal(v.node, 'svelte.config.js', text);
        if (typeof target !== 'string')
          kitFail('E_KIT_CONFIG', `kit.alias ${k} must be a path`, where(v.node));
        out.aliases[k] = target;
      }
      continue;
    }
    if (key === 'output') {
      for (const [k, v] of Object.entries(value(entry))) {
        const lit = literal(v.node, 'svelte.config.js', text);
        if (k === 'bundleStrategy' && (lit === 'single' || lit === 'inline'))
          out.bundleStrategy = lit;
        else if (k === 'preloadStrategy') continue;
        else
          kitFail(
            'E_KIT_CONFIG',
            `kit.output.${k} ${JSON.stringify(lit)} is unsupported: route modules must be bundled with the app (bundleStrategy 'single' or 'inline'), as the native app has them`,
            where(v.node),
          );
      }
      continue;
    }
    if (key === 'version') {
      for (const [k, v] of Object.entries(value(entry))) {
        const lit = literal(v.node, 'svelte.config.js', text);
        if (k === 'name') continue;
        if (k === 'pollInterval' && lit === 0) continue;
        kitFail(
          'E_KIT_CONFIG',
          `kit.version.${k} is unsupported (version polling fetches version.json)`,
          where(v.node),
        );
      }
      continue;
    }
    kitFail('E_KIT_CONFIG', `kit.${key} is unsupported`, where(entry.node));
  }
  if (out.bundleStrategy === 'split')
    kitFail(
      'E_KIT_CONFIG',
      "SvelteKit apps need kit.output.bundleStrategy 'single' or 'inline': with the default 'split', route modules load over the network, which the native app does not do",
      config.kit ? where(config.kit.node) : at('svelte.config.js'),
    );
  return out;
}

// --- app.html ---

/**
 * `src/app.html`: the `<html>` and `<body>` attributes and the container
 * (`<div …>%sveltekit.body%</div>`). Head content other than `meta`
 * charset/viewport and `%sveltekit.head%` is rejected, as are scripts and
 * placeholders other than head and body.
 */
export function readAppHtml(root) {
  const file = path.join(root, 'src', 'app.html');
  const rel = 'src/app.html';
  if (!existsSync(file)) kitFail('E_KIT_HTML', 'A SvelteKit app needs src/app.html', at(rel));
  const text = readFileSync(file, 'utf8');
  // Text in <head> would start the body: the head placeholder parses as a comment.
  const doc = parseHTML(text.replace('%sveltekit.head%', '<!--%sveltekit.head%-->'), {
    sourceCodeLocationInfo: true,
  });
  const loc = n =>
    at(rel, n.sourceCodeLocation?.startLine ?? 1, n.sourceCodeLocation?.startCol ?? 1);
  const attrs = n => Object.fromEntries((n.attrs ?? []).map(a => [a.name, a.value]));
  const nodes = [];
  const visit = n => {
    nodes.push(n);
    (n.childNodes ?? []).forEach(visit);
  };
  visit(doc);
  const html = nodes.find(n => n.tagName === 'html');
  const head = nodes.find(n => n.tagName === 'head');
  const body = nodes.find(n => n.tagName === 'body');
  for (const n of nodes) {
    for (const a of n.attrs ?? []) {
      if (/%sveltekit\./.test(a.value))
        kitFail(
          'E_KIT_HTML',
          `app.html placeholder in the ${a.name} attribute is unsupported`,
          loc(n),
        );
      if (a.name.startsWith('on'))
        kitFail('E_KIT_HTML', 'Event attributes in app.html are unsupported', loc(n));
    }
    if (['script', 'style', 'link', 'base', 'iframe', 'title'].includes(n.tagName))
      kitFail(
        'E_KIT_HTML',
        n.tagName === 'script'
          ? 'Scripts in app.html are unsupported (bridge scripts are M8)'
          : n.tagName === 'title'
            ? 'A <title> in app.html is unsupported (set it with <svelte:head>)'
            : `<${n.tagName}> in app.html is unsupported`,
        loc(n),
      );
  }
  for (const n of head?.childNodes ?? []) {
    if (n.nodeName === '#text' && /^\s*(%sveltekit\.head%)?\s*$/.test(n.value)) continue;
    if (n.nodeName === '#comment') continue;
    if (n.tagName === 'meta') {
      const a = attrs(n);
      if ('charset' in a || a.name === 'viewport') continue;
    }
    kitFail(
      'E_KIT_HTML',
      `${n.tagName ? `<${n.tagName}>` : 'This content'} in app.html's head is unsupported (meta charset and viewport and %sveltekit.head% are supported)`,
      loc(n),
    );
  }
  const content = (body?.childNodes ?? []).filter(
    n => n.nodeName !== '#comment' && !(n.nodeName === '#text' && !n.value.trim()),
  );
  const container = content[0];
  if (
    content.length !== 1 ||
    container.tagName !== 'div' ||
    container.childNodes.length !== 1 ||
    container.childNodes[0].nodeName !== '#text' ||
    container.childNodes[0].value.trim() !== '%sveltekit.body%'
  )
    kitFail(
      'E_KIT_HTML',
      'app.html\'s body must hold one <div> holding only %sveltekit.body% (as Kit\'s template: <div style="display: contents">%sveltekit.body%</div>)',
      loc(body ?? doc),
    );
  const bodyAttrs = attrs(body);
  const containerAttrs = attrs(container);
  for (const [where, a, n] of [
    ['body', bodyAttrs, body],
    ['container', containerAttrs, container],
  ])
    for (const [name, v] of Object.entries(a))
      if (/^data-sveltekit-preload-(data|code)$/.test(name) && !['off', 'false'].includes(v))
        kitFail(
          'E_KIT_PRELOAD',
          `${name}="${v}" on the ${where} preloads routes (loads run on hover or tap), which is not supported yet; use "off" or "false"`,
          loc(n),
        );
  return { documentAttrs: attrs(html), bodyAttrs, containerAttrs };
}

// --- Kit's own code: the route manifest ---

/** The Kit package of the app (resolved from the app), checked and pinned. */
function kitPackage(root) {
  const require = createRequire(path.join(root, 'runic.json'));
  let pkgFile;
  try {
    pkgFile = require.resolve('@sveltejs/kit/package.json');
  } catch {
    kitFail(
      'E_FRONTEND_VERSION',
      'runic.json declares a SvelteKit app, but @sveltejs/kit is not installed',
      at('runic.json'),
    );
  }
  const info = JSON.parse(readFileSync(pkgFile, 'utf8'));
  if (info.version !== KIT_VERSION)
    kitFail(
      'E_FRONTEND_VERSION',
      `Unsupported SvelteKit version ${info.version}; checked version: ${KIT_VERSION}`,
      at('runic.json'),
    );
  const dir = path.dirname(pkgFile);
  // Every Kit file the manifest code loads must be the published one.
  for (const [file, sha256] of Object.entries(KIT_PINS)) {
    let actual;
    try {
      actual = createHash('sha256')
        .update(readFileSync(path.join(dir, file)))
        .digest('hex');
    } catch {
      kitFail(
        'E_FRONTEND_VERSION',
        `@sveltejs/kit@${KIT_VERSION} has no ${file}`,
        at('runic.json'),
      );
    }
    if (actual !== sha256)
      kitFail(
        'E_FRONTEND_VERSION',
        `@sveltejs/kit@${KIT_VERSION} differs from the published package (${file} has SHA-256 ${actual})`,
        at('runic.json'),
      );
  }
  return dir;
}

/** The relative imports of Kit's manifest code, from its entry files (for the pins). */
export function kitManifestFiles(dir) {
  const files = new Set();
  const visit = rel => {
    if (files.has(rel)) return;
    // Type declarations only (`types.js` beside `types.d.ts`).
    if (
      !existsSync(path.join(dir, rel)) &&
      existsSync(path.join(dir, rel.replace(/\.js$/, '.d.ts')))
    )
      return;
    files.add(rel);
    const text = readFileSync(path.join(dir, rel), 'utf8');
    for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g))
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  };
  visit('src/core/sync/create_manifest_data/index.js');
  visit('src/core/config/index.js');
  // Kit's default root layout and error page, compiled with the app.
  files.add('src/runtime/components/svelte-5/layout.svelte');
  files.add('src/runtime/components/svelte-5/error.svelte');
  return [...files].sort();
}

/** Kit's route manifest of the app (`create_manifest_data`), with Kit's config defaults. */
export async function manifestOf(root, options) {
  const dir = kitPackage(root);
  const load = rel => import(pathToFileURL(path.join(dir, rel)).href);
  const { process_config } = await load('src/core/config/index.js');
  const { default: create_manifest_data } = await load(
    'src/core/sync/create_manifest_data/index.js',
  );
  const config = process_config({ kit: { router: { type: options.routerType } } }, { cwd: root });
  let manifest;
  try {
    manifest = create_manifest_data({
      config,
      cwd: root,
      fallback: path.join(dir, 'src/runtime/components/svelte-5'),
    });
  } catch (e) {
    kitFail('E_KIT_ROUTES', `SvelteKit rejects the routes: ${e.message}`, at('src/routes'));
  }
  return { manifest, config, dir };
}

// --- Analysis of route modules ---

/** The exports of a universal route module (`+page.ts`/`+layout.ts`), checked. */
export function routeModule(root, rel) {
  const file = path.join(root, rel);
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const where = n => {
    const p = position(text, n.getStart(sf));
    return at(rel, p.line, p.column);
  };
  let load = false;
  // Whether the load returns data: a `return` with a value (or an
  // expression body other than a call of error() or redirect()); loads
  // that only throw or return nothing give no data (Kit: data null).
  let data = false;
  const returnsData = fn => {
    if (!fn) return false;
    while (
      ts.isParenthesizedExpression(fn) ||
      ts.isSatisfiesExpression(fn) ||
      ts.isAsExpression(fn)
    )
      fn = fn.expression;
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)))
      return true;
    if (fn.body && !ts.isBlock(fn.body)) {
      const e = fn.body;
      return !(
        ts.isCallExpression(e) &&
        ts.isIdentifier(e.expression) &&
        ['error', 'redirect'].includes(e.expression.text)
      );
    }
    let found = false;
    const visit = n => {
      if (found || (n !== fn && ts.isFunctionLike(n))) return;
      if (ts.isReturnStatement(n) && n.expression) found = true;
      ts.forEachChild(n, visit);
    };
    visit(fn);
    return found;
  };
  for (const stmt of sf.statements) {
    const exported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(stmt) && exported) {
      if (stmt.name?.text !== 'load')
        kitFail(
          'E_KIT_LOAD',
          `Route modules export load and page options only (${stmt.name?.text})`,
          where(stmt),
        );
      load = true;
      data = returnsData(stmt);
    } else if (ts.isVariableStatement(stmt) && exported) {
      for (const d of stmt.declarationList.declarations) {
        const name = ts.isIdentifier(d.name) ? d.name.text : '';
        if (name === 'load') {
          if (d.type)
            kitFail(
              'E_KIT_LOAD',
              'Annotate load with `satisfies` (export const load = (async (event) => {…}) satisfies PageLoad) or type its parameter: with a `: PageLoad` annotation the data type is lost (Kit generates proxy modules for it)',
              where(d.type),
            );
          load = true;
          data = returnsData(d.initializer);
        } else if (
          name === 'ssr' &&
          d.initializer &&
          [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(d.initializer.kind)
        ) {
          // Server rendering only: the app is a client-rendered SPA.
        } else if (
          name === 'prerender' &&
          [ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.TrueKeyword].includes(d.initializer?.kind)
        ) {
          // false is the default; true makes generation evaluate the route
          // (its server data and the endpoints its loads fetch), and the
          // native app renders it on the client as any other route.
        } else
          kitFail(
            'E_KIT_LOAD',
            `The page option ${name} is unsupported (ssr, and prerender true or false, are)`,
            where(d),
          );
      }
    } else if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt))
      kitFail(
        'E_KIT_LOAD',
        'Route modules declare their exports (export function load, export const …)',
        where(stmt),
      );
  }
  return { load, data, text };
}

/**
 * The exports of a server route module (`+page.server.ts`/`+layout.server.ts`),
 * which only generation runs: `load`, the page options `prerender` and
 * `ssr`, and `entries`. Form actions and other exports need a server.
 */
export function serverModule(root, rel) {
  const file = path.join(root, rel);
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const where = n => {
    const p = position(text, n.getStart(sf));
    return at(rel, p.line, p.column);
  };
  const ALLOWED = new Set(['load', 'prerender', 'entries', 'ssr']);
  let load = false;
  for (const stmt of sf.statements) {
    const exported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) {
      if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt))
        kitFail(
          'E_KIT_SERVER',
          'Server route modules declare their exports (export function load, export const …)',
          where(stmt),
        );
      continue;
    }
    const names = ts.isFunctionDeclaration(stmt)
      ? [stmt.name?.text]
      : ts.isVariableStatement(stmt)
        ? stmt.declarationList.declarations.map(d => (ts.isIdentifier(d.name) ? d.name.text : ''))
        : ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)
          ? []
          : [''];
    for (const name of names) {
      if (name === 'actions')
        kitFail(
          'E_KIT_SERVER',
          'Form actions need a server (the native app has none)',
          where(stmt),
        );
      if (!ALLOWED.has(name))
        kitFail(
          'E_KIT_SERVER',
          `The server route module export ${name || '(unnamed)'} is unsupported (load, prerender, ssr and entries are)`,
          where(stmt),
        );
      if (name === 'load') load = true;
    }
  }
  return { load };
}

/** Whether a component declares props by name, and which. */
export function componentProps(compiler, root, rel) {
  const text = readFileSync(path.join(root, rel), 'utf8');
  let ast;
  try {
    ast = compiler.parse(text, { filename: rel, modern: true });
  } catch (e) {
    throw new Diagnostic(
      'E_PARSE',
      e.message,
      at(rel, e.start?.line ?? 1, (e.start?.column ?? 0) + 1),
    );
  }
  const declared = new Set();
  if (!ast.instance) return declared;
  const script = text.slice(ast.instance.content.start, ast.instance.content.end);
  const sf = ts.createSourceFile(rel + '.ts', script, ts.ScriptTarget.Latest, true);
  const where = n => {
    const p = position(text, ast.instance.content.start + n.getStart(sf));
    return at(rel, p.line, p.column);
  };
  for (const stmt of sf.statements)
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer;
        if (
          !init ||
          !ts.isCallExpression(init) ||
          !ts.isIdentifier(init.expression) ||
          init.expression.text !== '$props'
        )
          continue;
        if (!ts.isObjectBindingPattern(d.name))
          kitFail(
            'E_KIT_COMPONENT',
            'Route components destructure $props() (let { data, children } = $props())',
            where(d),
          );
        for (const el of d.name.elements) {
          if (el.dotDotDotToken)
            kitFail(
              'E_KIT_COMPONENT',
              'Rest props in route components are unsupported (Kit passes data, params and form)',
              where(el),
            );
          const key = (el.propertyName ?? el.name).text;
          if (key === 'form')
            kitFail(
              'E_KIT_COMPONENT',
              'The form prop is unsupported (form actions need a server)',
              where(el),
            );
          declared.add(key);
        }
      }
  return declared;
}
