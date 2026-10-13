import { build } from 'vite';
import ts from 'typescript';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { readFile, realpath } from 'node:fs/promises';
import { globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { frontendTooling } from './adapters/tooling.mjs';
import { cssCheck, unmatched } from './codegen.mjs';
import { parse as parseHTML } from 'parse5';
import { isSourcePackage } from '../frontend/sources.ts';
import { imageSourceInput } from './images.mjs';

export const hash = value =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
export class Diagnostic extends Error {
  constructor(code, message, source) {
    super(message);
    this.name = 'Diagnostic';
    this.code = code;
    this.source = source;
  }
  toJSON() {
    return { code: this.code, message: this.message, source: this.source };
  }
}
export function location(node, root) {
  const file = node.getSourceFile();
  const pos = file.getLineAndCharacterOfPosition(node.getStart(file));
  return {
    file: path.relative(root, file.fileName),
    line: pos.line + 1,
    column: pos.character + 1,
  };
}
export function fail(node, root, code, message) {
  throw new Diagnostic(code, message, location(node, root));
}
const mime = { '.woff2': 'font/woff2' };

/**
 * Records the chunks a dynamic `import()` splits off with stylesheets of
 * their own (`E_CSS_ORDER`): their entry module and its dynamic importers.
 */
function splitStylesPlugin(out) {
  return {
    name: 'runic-split-styles',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle))
        if (
          chunk.type === 'chunk' &&
          chunk.isDynamicEntry &&
          chunk.viteMetadata?.importedCss.size
        ) {
          const facade = chunk.facadeModuleId;
          out.push({
            facade,
            importers: [...(this.getModuleInfo(facade)?.dynamicImporters ?? [])],
          });
        }
    },
  };
}

/**
 * The `import()` that splits a styled module off the entry's stylesheet:
 * the first (by path) such module, located at a string-literal `import()`
 * of it (not a `typeof import()` type) in an importer, else at the module.
 */
async function splitStyleSource(root, splits) {
  const clean = id => id.replace(/[?#].*$/, '');
  const [split] = splits.sort((a, b) => clean(a.facade).localeCompare(clean(b.facade)));
  if (!split) return null;
  const target = clean(split.facade);
  const what = `${path.relative(root, target)} (loaded by a dynamic import())`;
  for (const importer of split.importers.map(clean).sort()) {
    const code = await readFile(importer, 'utf8').catch(() => null);
    if (code == null) continue;
    for (const m of code.matchAll(/(?<!\btypeof\s+)\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      if (!m[2].startsWith('.') || path.resolve(path.dirname(importer), m[2]) !== target) continue;
      const before = code.slice(0, m.index).split('\n');
      return {
        what,
        source: {
          file: path.relative(root, importer),
          line: before.length,
          column: before.at(-1).length + 1,
        },
      };
    }
  }
  return { what, source: { file: path.relative(root, target), line: 1, column: 1 } };
}
/** CSS properties that apply only to SVG content (paint, markers, geometry). */
// What Stylo (Blitz's preferences) drops and Chromium applies differently is
// reported; these drops are verified equivalent in Chromium 153
// (docs/research/M6-CSS.md): vendor pseudo-classes and pseudo-elements
// (scrollbar and form-control internals Blitz has no parts for), and vendor
// properties without effect on desktop or next to their standard property.
// (`prefers-reduced-motion`, `prefers-contrast` and `forced-colors` are
// evaluated by the Stylo fork; see preferenceGuards.)
const EQUIVALENT_DROPPED_RULE = /::?-(webkit|moz)-/;
// Stylo parses `-webkit-line-clamp`, `-webkit-box-orient` and `display:
// -webkit-box` as Chromium 153 does, and Blitz lays out the line clamp roots
// they make as Chromium does and reports the rest when it constructs their
// boxes (a legacy flexible box, a clamp root that is a button) or lays them
// out. Properties Stylo applies and Chromium does not parse are reported:
// `-moz-box-orient` (`-webkit-box-orient`'s Gecko name) would make a clamp
// root of a box Chromium lays out as a legacy flexible box.
const CHROMIUM_IGNORED = new Set(['-moz-box-orient']);
const EQUIVALENT_DROPPED_PROPERTY = new Set([
  '-webkit-text-size-adjust',
  '-webkit-tap-highlight-color',
  '-ms-overflow-style',
  '-webkit-overflow-scrolling',
  '-webkit-text-decoration',
  '-webkit-backdrop-filter',
]);
// The controls `field-sizing: content` sizes in Chromium 153 that Blitz does
// not size as it does (see checkWithStylo).
const FIELD_SIZING_UNSUPPORTED =
  'select, input[type=search i], input[type=number i], input[type=password i], input[type=file i]';
// Font smoothing values asking for what the renderers always do: grayscale
// antialiasing. Both of Blitz's renderers fill glyph outlines as paths with
// one coverage value per pixel and have no subpixel (LCD) path (vello_cpu
// through glifo `renderer.rs` `fill_path`, `vello_common` strip alphas; vello
// `fine.wgsl` `area`); Chromium 153 on Linux draws the same pixels with and
// without them (docs/research/M6-CSS.md). Other values (`auto`,
// `subpixel-antialiased`, `none`) ask for something else and stay reported.
const EQUIVALENT_DROPPED_VALUE = new Map([
  ['-webkit-font-smoothing', 'antialiased'],
  ['-moz-osx-font-smoothing', 'grayscale'],
]);
// The CSS filter functions both renderers draw in `filter` and
// `backdrop-filter` (docs/research/M6-CPU-RENDERER.md, GPU section).
const FILTER_FUNCTIONS = new Set([
  'blur',
  'brightness',
  'contrast',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
  'drop-shadow',
]);

// The SVG painting properties Stylo computes (servo mode) and the Blitz fork
// draws inline SVG with: each SVG element is serialised for usvg with its
// computed values (docs/BLITZ-GAPS.md, fixed in the fork). Paint servers
// (`url()`) stay unsupported: the gradient and pattern elements they would
// reference are rejected (E_SVG).
const SVG_PAINT_CSS =
  /^(fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|stroke-dashoffset)$/;
// The other SVG-only properties: markers, geometry and those Stylo's servo
// mode does not compute.
const SVG_CSS =
  /^(fill|stroke|marker)(-|$)|^(clip-rule|paint-order|vector-effect|shape-rendering|stop-color|stop-opacity|flood-color|flood-opacity|lighting-color|color-interpolation|color-interpolation-filters|color-rendering|text-anchor|dominant-baseline|alignment-baseline|baseline-shift|mask-type|d|cx|cy|r|rx|ry|x|y)$/;

/** The package name and subpath of a bare specifier (`@scope/pkg/sub` → `@scope/pkg`, `./sub`). */
export function bareSpecifier(specifier) {
  if (/^(\.|\/|[a-z][a-z0-9+.-]*:|\0|#|\$)/i.test(specifier)) return undefined;
  const parts = specifier.split('/');
  const n = specifier.startsWith('@') ? 2 : 1;
  if (parts.length < n || parts.slice(0, n).some(p => !p)) return undefined;
  const rest = parts.slice(n).join('/');
  return { name: parts.slice(0, n).join('/'), subpath: rest ? './' + rest : '.' };
}

/**
 * The package a bare import resolved into (mapping packs, docs/design/M6-LIBRARIES.md):
 * the nearest directory above the resolved file whose package.json carries
 * the specifier's package name, with that file's exact version.
 */
async function packageOf(specifier, resolved) {
  const bare = bareSpecifier(specifier);
  if (!bare || !path.isAbsolute(resolved)) return undefined;
  for (let dir = path.dirname(resolved); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    let info;
    try {
      info = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (info.name === bare.name)
      return {
        name: bare.name,
        version: String(info.version),
        dir,
        subpath: bare.subpath,
        // Compiled from source (frontend/sources.ts) rather than by a pack.
        ...(isSourcePackage(bare.name, String(info.version)) ? { source: true } : {}),
      };
  }
  return undefined;
}

/**
 * Imports and re-exports of types only, which TypeScript erases (`import
 * type`, or named lists whose every name is `type`): they load no module,
 * and their specifiers may name type-only package exports (`svelte/elements`).
 */
function typeOnly(stmt) {
  if (ts.isImportDeclaration(stmt)) {
    const clause = stmt.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const named = clause.namedBindings;
    return (
      !clause.name &&
      !!named &&
      ts.isNamedImports(named) &&
      named.elements.length > 0 &&
      named.elements.every(e => e.isTypeOnly)
    );
  }
  if (stmt.isTypeOnly) return true;
  const clause = stmt.exportClause;
  return (
    !!clause &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every(e => e.isTypeOnly)
  );
}

/**
 * The package a file in `node_modules` belongs to (the directory after the
 * last `node_modules`, scoped names included): its name, version, directory
 * and whether it declares itself free of module side effects.
 */
const packageInfos = new Map();
async function owningPackage(file) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const i = file.lastIndexOf(marker);
  if (i < 0) return undefined;
  const parts = file.slice(i + marker.length).split(path.sep);
  const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const dir = file.slice(0, i + marker.length) + name.split('/').join(path.sep);
  if (!packageInfos.has(dir)) {
    let info;
    try {
      info = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      info = undefined;
    }
    packageInfos.set(
      dir,
      info?.name === name
        ? { name, version: String(info.version), dir, sideEffects: info.sideEffects }
        : undefined,
    );
  }
  return packageInfos.get(dir);
}

/**
 * The `import.meta.glob(patterns, options)` calls of a module, with the files
 * each matches as Vite 8.3.2's `transformGlobImport` finds them (absolute
 * patterns from the root, relative ones from the module's directory,
 * `node_modules` ignored, sorted) and the module id each resolves to. The
 * patterns and options must be literals, as Vite requires.
 */
async function globCalls(ctx, root, id, code) {
  const sf = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls = [];
  const visit = n => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'glob' &&
      ts.isMetaProperty(n.expression.expression)
    )
      calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const out = [];
  for (const call of calls) {
    const fail = message => {
      throw new Diagnostic('E_GLOB', message, location(call, root));
    };
    const [first, options] = call.arguments;
    const patterns = !first
      ? []
      : ts.isStringLiteralLike(first)
        ? [first.text]
        : ts.isArrayLiteralExpression(first) && first.elements.every(ts.isStringLiteralLike)
          ? first.elements.map(e => e.text)
          : fail('import.meta.glob takes literal patterns');
    if (!patterns.length || patterns.some(p => p.startsWith('!')))
      fail(
        'import.meta.glob takes one or more literal patterns (negative patterns are unsupported)',
      );
    const opts = {};
    if (options) {
      if (!ts.isObjectLiteralExpression(options))
        fail('import.meta.glob options must be a literal object');
      for (const p of options.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name))
          fail('import.meta.glob options must be literal properties');
        const v = p.initializer;
        const value =
          v.kind === ts.SyntaxKind.TrueKeyword
            ? true
            : v.kind === ts.SyntaxKind.FalseKeyword
              ? false
              : ts.isStringLiteralLike(v)
                ? v.text
                : fail('import.meta.glob options must be literals');
        if (!['eager', 'import', 'query'].includes(p.name.text))
          fail(
            `The import.meta.glob option ${p.name.text} is unsupported (eager, import and query are)`,
          );
        opts[p.name.text] = value;
      }
    }
    const dir = path.dirname(id);
    const matched = new Set();
    for (const pattern of patterns) {
      if (!pattern.startsWith('/') && !pattern.startsWith('./') && !pattern.startsWith('../'))
        fail('import.meta.glob patterns start with /, ./ or ../ (aliases are unsupported)');
      const cwd = pattern.startsWith('/') ? root : dir;
      const rel = pattern.startsWith('/') ? pattern.slice(1) : pattern;
      for (const f of globSync(rel, { cwd, exclude: f => f === 'node_modules' }))
        matched.add(path.resolve(cwd, f));
    }
    const files = [...matched].filter(f => f !== id && statSync(f).isFile()).sort();
    const entries = [];
    for (const file of files) {
      const posix = p => p.split(path.sep).join('/');
      const key = patterns.every(p => p.startsWith('/'))
        ? '/' + posix(path.relative(root, file))
        : (r => (r.startsWith('.') ? r : './' + r))(posix(path.relative(dir, file)));
      const resolved = opts.query ? undefined : await ctx.resolve(file, id);
      entries.push({ key, file, ...(resolved ? { id: resolved.id.split('?')[0] } : {}) });
    }
    out.push({ start: call.getStart(sf), end: call.end, options: opts, entries });
  }
  return out;
}

// This plugin sees original application modules before Vite's JSX transform.
// Collection is deliberately independent of the React lowering adapter.
// Modules of packages compiled from source (frontend/sources.ts) are
// collected too, with the package they belong to.
export function collectionPlugin(root, modules, tooling, onDiagnostic, componentStyles) {
  let packageModules = 0;
  const checkAuthoredStyles = (code, id) => {
    // Framework tooling identifies original style text and its source. Check
    // before scoping/minification removes selectors or changes positions.
    // Padding retains inline blocks' component line and column numbers.
    for (const style of tooling.authoredStyles?.(code, id) ?? []) {
      const original = code.slice(0, style.offset).replace(/[^\r\n]/g, ' ') + style.code;
      const owner = style.owner ?? id;
      const css = postcss.parse(original, { from: owner });
      const label = path.relative(root, owner);
      if (tooling.tailwind) checkValiditySelectors(css, label);
      else checkRules(css, label);
    }
  };
  return {
    name: 'runic-input-graph',
    enforce: 'pre',
    async transform(code, id) {
      try {
        if (id.includes('?')) {
          // External component styles can arrive as query modules. Tooling
          // identifies their authored source without relabeling it as an SFC.
          checkAuthoredStyles(code, id);
          // A component's own stylesheet (Svelte `<style>`), checked with the
          // CSS modules below.
          const owner = tooling.componentStyle?.(id);
          if (owner) componentStyles?.set(id, { code, owner });
          return;
        }
        let source;
        if (!id.startsWith(root + path.sep) || id.includes('/node_modules/')) {
          const pkg = await owningPackage(id);
          if (!pkg || !isSourcePackage(pkg.name, pkg.version)) return;
          // Its `sideEffects` decides which of its modules a bundle evaluates
          // (frontend/module-effects.ts checks the others' top-level code).
          source = {
            name: pkg.name,
            version: pkg.version,
            dir: pkg.dir,
            ...(pkg.sideEffects === false ? { sideEffects: false } : {}),
          };
        }
        if (
          !['.js', '.jsx', '.ts', '.tsx', '.css', ...(tooling.extensions ?? [])].includes(
            path.extname(id),
          )
        )
          return;
        if (source) {
          if (code.length > 1048576 || (packageModules >= 2048 && !modules.has(id)))
            throw new Diagnostic(
              'E_RESOURCE',
              'Packages compiled from source exceed 2048 modules or 1 MiB per module',
            );
          if (!modules.has(id)) packageModules++;
        } else if (
          code.length > 1048576 ||
          (modules.size - packageModules >= 256 && !modules.has(id))
        )
          throw new Diagnostic(
            'E_RESOURCE',
            'Application graph exceeds 256 modules or 1 MiB per source module',
          );
        const imports = [];
        if (path.extname(id) !== '.css') {
          checkAuthoredStyles(code, id);
          for (const script of tooling.scripts?.(code, id) ?? [{ code, offset: 0 }]) {
            const original = code.slice(0, script.offset).replace(/[^\n]/g, ' ') + script.code;
            const ast = ts.createSourceFile(
              id,
              original,
              ts.ScriptTarget.Latest,
              true,
              ts.ScriptKind.TSX,
            );
            for (const stmt of ast.statements) {
              if (
                ts.isImportDeclaration(stmt) ||
                (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier)
              ) {
                const specifier = stmt.moduleSpecifier.text;
                // Types only: recorded where Vite resolves them (the type
                // checker follows the edge), skipped where it cannot.
                if (typeOnly(stmt)) {
                  let resolved = null;
                  try {
                    resolved = await this.resolve(specifier, id);
                  } catch {
                    resolved = null;
                  }
                  if (resolved && path.isAbsolute(resolved.id.split('?')[0])) {
                    const file = resolved.id.split('?')[0];
                    const pkg = await packageOf(specifier, file);
                    imports.push({
                      specifier,
                      resolved: file,
                      typeOnly: true,
                      ...(pkg ? { package: pkg } : {}),
                    });
                  }
                  continue;
                }
                const resolved = await this.resolve(specifier, id);
                if (!resolved)
                  throw new Diagnostic(
                    'E_RESOLVE',
                    `Cannot resolve ${specifier}`,
                    location(stmt, root),
                  );
                const file = resolved.id.split('?')[0];
                const pkg = await packageOf(specifier, file);
                imports.push({ specifier, resolved: file, ...(pkg ? { package: pkg } : {}) });
              }
            }
          }
        }
        // `import.meta.glob(…)` in an app module: its matched files, as Vite
        // expands them (the frontend lowers the call to a table of modules).
        const globs =
          !source && /import\.meta\.glob\b/.test(code) && /\.(ts|js|mjs)$/.test(id)
            ? await globCalls(this, root, id, code)
            : [];
        modules.set(id, {
          id,
          code,
          imports,
          ...(globs.length ? { globs } : {}),
          ...(source ? { package: source } : {}),
        });
      } catch (e) {
        if (e instanceof Diagnostic) onDiagnostic?.(e);
        throw e;
      }
    },
  };
}

export async function collect(app) {
  const root = await realpath(app);
  const config = JSON.parse(await readFile(path.join(root, 'runic.json'), 'utf8'));
  if (config.renderer !== undefined && !['cpu', 'gpu'].includes(config.renderer))
    throw new Diagnostic('E_CONFIG', 'runic.json renderer must be "cpu" or "gpu"', {
      file: 'runic.json',
      line: 1,
      column: 1,
    });
  const tooling = await frontendTooling(root, config);
  // A SvelteKit app (compiler/adapters/kit.mjs): its entry, HTML template
  // and modules are generated from the route manifest.
  const kit =
    config.kit !== undefined
      ? await (await import('./adapters/kit-app.mjs')).kitApp(root, config, tooling.compiler)
      : undefined;
  let entry, htmlSource, documentAttrs, bodyAttrs;
  if (kit) {
    entry = kit.entry;
    htmlSource = await readFile(path.join(root, 'src', 'app.html'), 'utf8');
    documentAttrs = kit.html.documentAttrs;
  } else {
    entry = path.resolve(root, config.entry);
    if (!entry.startsWith(root + path.sep))
      throw new Diagnostic('E_ENTRY', 'Entry must be inside the application');
    htmlSource = await readFile(path.join(root, 'index.html'), 'utf8');
    const document = parseHTML(htmlSource, { sourceCodeLocationInfo: true });
    const htmlNodes = [];
    const visit = n => {
      htmlNodes.push(n);
      (n.childNodes ?? []).forEach(visit);
    };
    visit(document);
    const scripts = htmlNodes.filter(n => n.tagName === 'script');
    const htmlAttr = (n, name) => n.attrs?.find(a => a.name === name)?.value;
    if (
      scripts.length !== 1 ||
      htmlAttr(scripts[0], 'type') !== 'module' ||
      htmlAttr(scripts[0], 'src') !== '/' + config.entry ||
      scripts[0].childNodes.some(n => n.value?.trim())
    )
      throw new Diagnostic(
        'E_HTML',
        'index.html must load exactly the configured module entry; inline/extra scripts are unsupported',
      );
    // The document element's attributes (lang, dir, class, data-*).
    const htmlElement = htmlNodes.find(n => n.tagName === 'html');
    documentAttrs = Object.fromEntries((htmlElement?.attrs ?? []).map(a => [a.name, a.value]));
    const body = htmlNodes.find(n => n.tagName === 'body');
    // <body>'s attributes (class, data-*): the document starts with them.
    bodyAttrs = Object.fromEntries((body.attrs ?? []).map(a => [a.name, a.value]));
    const content = body.childNodes.filter(n => n.nodeName !== '#text' || n.value.trim());
    if (
      content.length !== 2 ||
      content[0].tagName !== 'div' ||
      htmlAttr(content[0], 'id') !== 'root' ||
      content[0].attrs.length !== 1 ||
      content[0].childNodes.length ||
      content[1] !== scripts[0]
    )
      throw new Diagnostic(
        'E_HTML',
        'Body must contain an empty div#root followed by the module script',
      );
    if (
      htmlNodes.some(
        n =>
          ['style', 'link', 'iframe', 'base'].includes(n.tagName) ||
          n.attrs?.some(a => a.name.startsWith('on')),
      )
    )
      throw new Diagnostic(
        'E_HTML',
        'HTML styles, resource links, base URLs and event attributes require an adapter',
      );
  }
  const modules = new Map();
  const componentStyles = new Map();
  let bundled, collectionError;
  const splitStyles = [];
  try {
    bundled = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        ...(kit ? [kit.plugin] : []),
        collectionPlugin(
          root,
          modules,
          tooling,
          e => {
            collectionError = new Diagnostic(e.code, e.message, e.source);
          },
          componentStyles,
        ),
        ...tooling.plugins,
        splitStylesPlugin(splitStyles),
      ],
      build: {
        write: false,
        minify: false,
        assetsInlineLimit: 0,
        ...(kit ? { rollupOptions: { input: entry } } : {}),
      },
      esbuild: { jsx: 'transform' },
    });
  } catch (e) {
    if (kit?.failure()) throw kit.failure();
    if (collectionError) throw collectionError;
    if (e instanceof Diagnostic || tooling.name !== 'svelte') throw e;
    throw new Diagnostic('E_SVELTE_COMPILE', e.message, {
      file: path.relative(root, e.id ?? entry),
      line: e.loc?.line ?? e.start?.line ?? 1,
      column: (e.loc?.column ?? e.start?.column ?? 0) + 1,
    });
  }
  if (!modules.has(entry))
    throw new Diagnostic('E_ENTRY', 'runic.json entry must be loaded by index.html');
  const assets = [];
  const cssParts = [];
  // Guards of declarations Stylo drops (checkWithStylo).
  const moduleGuards = [];
  // Rejections of style rules, decided by lowering (skipUnmatchedRules).
  const pending = [];
  for (const mod of [...modules.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!mod.id.endsWith('.css')) continue;
    const css = postcss.parse(mod.code, { from: mod.id });
    // URL inspection uses a CSS AST; no fetching is available in the native app.
    const jobs = [];
    if (!tooling.tailwind) checkRules(css, path.relative(root, mod.id), pending);
    css.walkDecls(decl => {
      const parsed = valueParser(decl.value);
      parsed.walk(node => {
        if (node.type !== 'function' || node.value !== 'url') return;
        const url = valueParser.stringify(node.nodes).replace(/^['"]|['"]$/g, '');
        if (url.length > 4096 || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url))
          reject(
            pending,
            new Diagnostic(
              'E_ASSET',
              'CSS resources must be bounded local paths, not remote/data URLs',
              {
                file: path.relative(root, mod.id),
                line: decl.source.start.line,
                column: decl.source.start.column,
              },
            ),
          );
        jobs.push(
          (async () => {
            const assetPath = await realpath(path.resolve(path.dirname(mod.id), url));
            if (!assetPath.startsWith(root + path.sep))
              throw new Diagnostic('E_ASSET', 'Only assets inside the application are accepted');
            const type = mime[path.extname(assetPath)];
            if (!type)
              throw new Diagnostic(
                'E_ASSET',
                `Unsupported asset type ${path.extname(assetPath)}; supported: woff2 fonts`,
              );
            const bytes = await readFile(assetPath);
            if (bytes.length > 1024 * 1024)
              throw new Diagnostic('E_ASSET', 'Asset exceeds 1 MiB limit');
            assets.push({
              path: path.relative(root, assetPath),
              sha256: hash(bytes),
              bytes: bytes.length,
              mime: type,
            });
            node.nodes = [
              {
                type: 'string',
                quote: '"',
                value: `data:${type};base64,${bytes.toString('base64')}`,
              },
            ];
          })(),
        );
      });
      jobs.push(
        Promise.all(jobs.slice()).then(() => {
          decl.value = parsed.toString();
        }),
      );
    });
    await Promise.all(jobs);
    if (!tooling.tailwind)
      moduleGuards.push(...checkWithStylo(mod.code, path.relative(root, mod.id), pending));
    cssParts.push(css.toString());
  }
  // Component styles join the emitted stylesheet (checked whole with
  // Tailwind CSS); their resources are resolved there.
  if (!tooling.tailwind)
    for (const [, style] of [...componentStyles].sort(([a], [b]) => a.localeCompare(b))) {
      const label = path.relative(root, style.owner);
      checkRules(postcss.parse(style.code, { from: style.owner }), label, pending);
      moduleGuards.push(...checkWithStylo(style.code, label, pending));
    }
  // Preserve Vite's actual entry cascade, rather than sorting source filenames.
  const emitted = bundled.output.filter(a => a.type === 'asset');
  const styles = emitted.filter(a => a.fileName.endsWith('.css'));
  if (styles.length > 1) {
    const split = await splitStyleSource(root, splitStyles);
    throw new Diagnostic(
      'E_CSS_ORDER',
      'Split/dynamic stylesheet order is outside this contract' +
        (split ? `: ${split.what} has styles of its own, emitted as a separate stylesheet` : ''),
      split?.source,
    );
  }
  let orderedCSS = '';
  let styleGuards = moduleGuards;
  if (styles.length) {
    const css = postcss.parse(String(styles[0].source));
    // Tailwind CSS generates the stylesheet: its output is what Blitz renders.
    if (tooling.tailwind) {
      const label = 'stylesheet generated by Tailwind CSS';
      checkRules(css, label, pending);
      styleGuards = [...styleGuards, ...checkWithStylo(String(styles[0].source), label, pending)];
    }
    // Resources the stylesheet's own imports bring in (a package's
    // @font-face, `@import "@fontsource-variable/geist/index.css"`, which
    // Tailwind CSS inlines) reach only the emitted stylesheet: each is
    // recorded from the one source file Vite emitted it from, under the
    // module rules above (inside the application, at most 1 MiB, WOFF2).
    const fromEmitted = new Map();
    for (const asset of emitted.filter(a => a.fileName.endsWith('.woff2'))) {
      const sources = asset.originalFileNames ?? [];
      if (sources.length !== 1) continue;
      let file;
      try {
        file = await realpath(path.resolve(root, sources[0]));
      } catch {
        continue;
      }
      if (!file.startsWith(root + path.sep) || path.extname(file) !== '.woff2') continue;
      const bytes = await readFile(file);
      if (!bytes.equals(Buffer.from(asset.source))) continue;
      fromEmitted.set(asset.fileName, {
        path: path.relative(root, file),
        sha256: hash(bytes),
        bytes: bytes.length,
        mime: 'font/woff2',
      });
    }
    css.walkDecls(decl => {
      const parsed = valueParser(decl.value);
      parsed.walk(n => {
        if (n.type !== 'function' || n.value !== 'url') return;
        const url = valueParser.stringify(n.nodes).replace(/^['"]|['"]$/g, '');
        const asset = emitted.find(a => '/' + a.fileName === url);
        if (!asset || !asset.fileName.endsWith('.woff2'))
          throw new Diagnostic('E_ASSET', 'Unresolved emitted CSS resource');
        if (Buffer.from(asset.source).length > 1024 * 1024)
          throw new Diagnostic('E_ASSET', 'Asset exceeds 1 MiB limit');
        const record = fromEmitted.get(asset.fileName);
        if (!record && !assets.some(a => a.sha256 === hash(Buffer.from(asset.source))))
          throw new Diagnostic(
            'E_ASSET',
            `Emitted CSS resource ${asset.fileName} does not come from one file inside the application`,
          );
        if (record) assets.push(record);
        n.nodes = [
          {
            type: 'string',
            quote: '"',
            value: 'data:font/woff2;base64,' + Buffer.from(asset.source).toString('base64'),
          },
        ];
      });
      decl.value = parsed.toString();
    });
    orderedCSS = css.toString();
  }
  const manifest = [...modules.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(m => ({
      path: path.relative(root, m.id),
      sha256: hash(m.code),
      imports: m.imports.map(i => ({
        specifier: i.specifier,
        resolved: i.resolved.startsWith(root)
          ? path.relative(root, i.resolved)
          : `package:${i.specifier}`,
      })),
    }));
  const uniqueAssets = [...new Map(assets.map(a => [a.path, a])).values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  // The pinned image record and its files (compiler/images.mjs).
  const images = await imageSourceInput(root);
  return {
    root,
    entry,
    config,
    modules,
    tooling,
    css: orderedCSS,
    ...(styleGuards.length ? { styleGuards } : {}),
    ...(pending.length ? { pendingRules: pending } : {}),
    assets: uniqueAssets,
    documentAttrs,
    ...(bodyAttrs && Object.keys(bodyAttrs).length ? { bodyAttrs } : {}),
    ...(kit ? { kit } : {}),
    manifest,
    hash: hash({
      manifest,
      assets: uniqueAssets,
      html: hash(htmlSource),
      config,
      ...(images ? { images } : {}),
    }),
  };
}

/**
 * Report what Stylo drops from the stylesheet `code` (see EQUIVALENT_*). A
 * declaration Stylo drops from a style rule whose selectors can be matched
 * against elements (no pseudo-elements) is not rejected here: it gives a
 * guard, `{ selector, unless?, when?, message }`, which the app reports as
 * unsupported once the selector matches an element (a library's variant the
 * page may never use) that `unless` does not match: the later rules of the
 * same block, of at least the rule's specificity (Stylo's), that set the
 * property (`overriding`), so the declaration never applies there. Scroll
 * margins only affect an element scrolled into view (the runtime's focus
 * never scrolls; Blitz has no scroll snapping): their guards wait for that
 * (`when: "scroll-target"`). Scroll paddings only affect scrolling a target
 * into view inside their scroll container: their guards wait for that
 * (`when: "scroll-container:<axis>:<px>"`, the padding in pixels where the
 * stylesheet gives a length, which the runtime compares with the target's
 * position). Returns the guards.
 */
function checkWithStylo(code, file, pending) {
  const guards = [];
  const css = postcss.parse(code);
  const decls = [];
  // Declarations of style rules; at-rule descriptors (@font-face, @property)
  // are checked by the stylesheet parse.
  css.walkDecls(d => {
    if (d.parent?.type === 'rule') decls.push(d);
  });
  const rules = [];
  css.walkRules(r => {
    rules.push(r);
  });
  const at = (line, column) => ({ file, line, column });
  const result = cssCheck(
    code,
    decls.map(d => [d.prop, d.value]),
    rules.map(r => fullSelectors(r).join(', ')),
  );
  const invalid = new Set(result.invalid.map(i => decls[i]));
  const customValues = customPropertyValues(css);
  // (A rem is 16px unless the stylesheet sizes the root's font.)
  let rootFont = false;
  css.walkDecls('font-size', d => {
    if (d.parent?.type === 'rule' && /(^|,)\s*(html|:root)\s*(,|$)/.test(d.parent.selector))
      rootFont = true;
  });
  const specificity = new Map(rules.map((r, i) => [r, result.specificity?.[i] ?? null]));
  /** The selectors of the rules overriding `d` (see above), joined; undefined without any. */
  const overriding = d => {
    const rule = d.parent;
    const own = specificity.get(rule);
    if (d.important || !own?.length) return undefined;
    const max = Math.max(...own);
    const later = rules
      .slice(rules.indexOf(rule) + 1)
      .filter(
        r =>
          r.parent === rule.parent &&
          specificity.get(r)?.every(x => x >= max) &&
          r.nodes.some(x => x.type === 'decl' && x.prop === d.prop && !invalid.has(x)),
      );
    return later.length ? later.map(r => fullSelectors(r).join(', ')).join(', ') : undefined;
  };
  // Blitz breaks lines as Chromium 153 does for `text-wrap-style: auto`,
  // `stable` (greedy in both), `balance` and `pretty` (Blink's score line
  // breaker, in the Blitz and Parley forks), except in a text area, whose text
  // Chromium breaks so too and Blitz's text editor does not: balance and pretty
  // are reported where a text area matches the rule or is inside an element
  // that does (the property is inherited).
  const textWrap = (d, keyword) =>
    /^text-wrap(-style)?$/.test(d.prop) && possibleKeywords(d.value, customValues).has(keyword);
  const reported = decls.filter(d => invalid.has(d) || CHROMIUM_IGNORED.has(d.prop));
  const scored = d => !invalid.has(d) && (textWrap(d, 'balance') || textWrap(d, 'pretty'));
  for (const d of decls.filter(scored)) {
    const verb = textWrap(d, 'balance') ? 'balance' : 'lay out text-wrap: pretty in';
    const selectors = d.parent?.type === 'rule' ? fullSelectors(d.parent) : [];
    const rule = selectors.join(', ');
    if (selectors.some(x => /::placeholder\b/i.test(x)))
      throw new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration ${d.prop}: ${d.value} (in ${d.parent.selector}): Blitz does not ${verb} the text of a text area`,
        at(d.source.start.line, d.source.start.column),
      );
    if (
      !selectors.length ||
      selectors.some(x => /::|:(before|after|first-line|first-letter)\b/i.test(x))
    )
      continue;
    guards.push({
      selector: selectors.flatMap(s => [`${s}:is(textarea)`, `${s} textarea`]).join(', '),
      message: `the CSS declaration ${d.prop}: ${d.value} (${file}, line ${d.source.start.line}) applies to a text area through ${rule}, and Blitz does not ${verb} the text of a text area`,
    });
  }
  // Blitz sizes text areas and text, email, tel and url inputs by their
  // content as Chromium 153 does (`field-sizing: content`, in the Stylo and
  // Blitz forks); the other controls it applies to in Chromium are reported
  // where the rule matches one: a select, a search input (Chromium sizes its
  // cancel button in), a number input (its spin button), a password input
  // (Blitz's masking is not verified against Chromium's) and a file input.
  // The property is not inherited, except through `inherit`. It does not
  // apply to pseudo-elements.
  for (const d of decls.filter(
    d =>
      !invalid.has(d) &&
      d.prop === 'field-sizing' &&
      ['content', 'inherit'].some(k => possibleKeywords(d.value, customValues).has(k)),
  )) {
    const selectors = d.parent?.type === 'rule' ? fullSelectors(d.parent) : [];
    if (
      !selectors.length ||
      selectors.some(x => /::|:(before|after|first-line|first-letter)\b/i.test(x))
    )
      continue;
    const unless = overriding(d);
    guards.push({
      selector: selectors.map(s => `${s}:is(${FIELD_SIZING_UNSUPPORTED})`).join(', '),
      ...(unless ? { unless } : {}),
      message: `the CSS declaration ${d.prop}: ${d.value} (${file}, line ${d.source.start.line}) applies to a select, search, number, password or file input through ${selectors.join(', ')}, and Blitz does not size that control by its content as Chromium does`,
    });
  }
  // Blitz paints no text shadows (blitz-paint never reads `text-shadow`), so
  // a shadow is reported where its rule matches an element (pseudo-elements:
  // their element); in keyframes it is rejected.
  for (const d of decls.filter(
    d =>
      !invalid.has(d) &&
      d.prop.toLowerCase() === 'text-shadow' &&
      !EQUIVALENT_DROPPED_RULE.test(d.parent.selector) &&
      !/^(none|initial|inherit|unset|revert|revert-layer)$/i.test(d.value.trim()),
  )) {
    const message = `Blitz does not paint text shadows (text-shadow: ${d.value}, ${file}, line ${d.source.start.line})`;
    if (!styleRuleOf(d)) {
      defer(
        pending,
        d,
        new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration text-shadow: ${d.value}: Blitz does not paint text shadows`,
          at(d.source.start.line, d.source.start.column),
        ),
      );
      continue;
    }
    const unless = overriding(d);
    guards.push({
      selector: withoutPseudoElements(fullSelectors(d.parent)),
      ...(unless ? { unless } : {}),
      message: `${message} applies to an element matching ${d.parent.selector}`,
    });
  }
  // Blitz lays out no multi-column layout (column boxes): `columns`,
  // `column-count` and `column-width` other than `auto` are reported where
  // their rule matches an element, rejected in keyframes. The other column
  // properties take effect only in a multi-column container.
  for (const d of decls.filter(
    d =>
      !invalid.has(d) &&
      MULTICOL.test(d.prop) &&
      !EQUIVALENT_DROPPED_RULE.test(d.parent.selector) &&
      !NO_MULTICOL.test(d.value.trim()),
  )) {
    if (!styleRuleOf(d)) {
      defer(
        pending,
        d,
        new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration ${d.prop}: ${d.value}: Blitz does not lay out multi-column layout`,
          at(d.source.start.line, d.source.start.column),
        ),
      );
      continue;
    }
    const unless = overriding(d);
    guards.push({
      selector: withoutPseudoElements(fullSelectors(d.parent)),
      ...(unless ? { unless } : {}),
      message: `Blitz does not lay out multi-column layout (${d.prop}: ${d.value}, ${file}, line ${d.source.start.line}) applies to an element matching ${d.parent.selector}`,
    });
  }
  guards.push(...preferenceGuards(css, file));
  for (const d of reported) {
    const unsupported = invalid.has(d)
      ? "Blitz's style engine (Stylo) does not support"
      : "Chromium ignores and Blitz's style engine (Stylo) applies";
    if (EQUIVALENT_DROPPED_PROPERTY.has(d.prop)) continue;
    if (EQUIVALENT_DROPPED_VALUE.get(d.prop) === d.value.trim().toLowerCase()) continue;
    if (invalid.has(d) && (chromiumDropsValue(d.prop, d.value) || overriddenInRule(d, invalid)))
      continue;
    // Blitz draws no resize grip whatever `resize` says; Chromium's default
    // (`both`) already differs, a gap recorded in docs/BLITZ-GAPS.md.
    if (d.prop === 'resize') continue;
    // A declaration in a rule Stylo drops as a whole is reported with the rule.
    const rule = d.parent?.type === 'rule' ? d.parent.selector : '';
    if (EQUIVALENT_DROPPED_RULE.test(rule)) continue;
    const selectors = d.parent?.type === 'rule' ? fullSelectors(d.parent) : [];
    if (
      selectors.length &&
      !selectors.some(x => /::|:(before|after|first-line|first-letter)\b/i.test(x))
    ) {
      const unless = overriding(d);
      guards.push({
        selector: selectors.join(', '),
        ...(unless ? { unless } : {}),
        ...(/^scroll-margin(-|$)/.test(d.prop) ? { when: 'scroll-target' } : {}),
        ...(/^scroll-padding(-|$)/.test(d.prop)
          ? {
              when: `scroll-container:${scrollPaddingAxis(d.prop)}:${rootFont ? '' : (lengthPx(d.value, customValues) ?? '')}`,
            }
          : {}),
        message: `the CSS declaration ${d.prop}: ${d.value} (${file}, line ${d.source.start.line}), which ${unsupported}, applies to an element matching ${rule}`,
      });
      continue;
    }
    defer(
      pending,
      d,
      new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration ${d.prop}: ${d.value}${rule ? ` (in ${rule})` : ''}: ${invalid.has(d) ? "Blitz's style engine (Stylo) does not support it" : "Chromium ignores it and Blitz's style engine (Stylo) applies it"}`,
        at(d.source.start.line, d.source.start.column),
      ),
    );
  }
  const lines = code.split('\n');
  for (const d of result.dropped) {
    if (/Unsupported property declaration/.test(d.message)) continue; // the declarations above
    const text = lines[d.line - 1]?.slice(d.column - 1) ?? '';
    if (EQUIVALENT_DROPPED_RULE.test(text) || EQUIVALENT_DROPPED_RULE.test(d.message)) continue;
    reject(
      pending,
      new Diagnostic(
        'E_CSS',
        `Unsupported CSS rule: Blitz's style engine (Stylo) drops it (${d.message})`,
        at(d.line, d.column),
      ),
    );
  }
  return guards;
}

// Multi-column layout (runic_css::inline mirrors these): the properties
// that make a multi-column container, and their values that do not.
const MULTICOL = /^(columns|column-count|column-width)$/i;
const NO_MULTICOL = /^(auto(\s+auto)?|initial|unset|revert|revert-layer)$/i;

/** Selectors joined, each without its pseudo-elements (`*` for one that had only those). */
function withoutPseudoElements(selectors) {
  return selectors
    .map(
      s =>
        s
          .replace(/::[-\w]+(\((?:[^()]|\([^()]*\))*\))?/g, '')
          .replace(/:(before|after|first-line|first-letter)\b/gi, '')
          .trim() || '*',
    )
    .join(', ');
}

// The media features whose value Chromium 153 on Linux takes from the
// desktop: `prefers-reduced-motion` (GTK's gtk-enable-animations,
// ui/gfx/animation/animation_linux.cc) and `prefers-contrast` (`more` for a
// GTK theme whose name contains "high" and "contrast",
// ui/gtk/os_settings_provider_gtk.cc). `forced-colors` is not one of them:
// Chromium on Linux never forces colors, and Stylo evaluates it as `none`.
const DESKTOP_MEDIA_FEATURE = /\b(prefers-reduced-motion|prefers-contrast)\b/i;

/**
 * Guards of the rules whose media queries test a desktop preference
 * (DESKTOP_MEDIA_FEATURE). The Stylo fork evaluates them as Chromium does
 * without the preference set, as the harness's Chromium runs, and probes
 * set them as their actions emulate; a native app cannot read the desktop's
 * setting, so it reports such a rule once it matches an element (`when:
 * "native"`). Rules of other kinds inside the query (keyframes, font faces)
 * are reported at once (`:root`).
 */
function preferenceGuards(css, file) {
  const guards = [];
  css.walkAtRules(/^media$/i, at => {
    const feature = DESKTOP_MEDIA_FEATURE.exec(at.params)?.[1].toLowerCase();
    if (!feature) return;
    const selectors = new Set();
    let anywhere = false;
    let outer = at.parent;
    while (outer && outer.type === 'atrule') outer = outer.parent;
    if (outer?.type === 'rule' && styleRuleOf(outer))
      selectors.add(withoutPseudoElements(fullSelectors(outer)));
    at.walk(n => {
      if (n.type === 'rule' && styleRuleOf(n)) {
        // Rules Stylo drops for vendor parts Blitz lacks apply in neither
        // engine (EQUIVALENT_DROPPED_RULE).
        if (!EQUIVALENT_DROPPED_RULE.test(n.selector))
          selectors.add(withoutPseudoElements(fullSelectors(n)));
      } else if (n.type === 'atrule' && !/^(media|supports|layer|container)$/i.test(n.name))
        anywhere = true;
    });
    if (anywhere) selectors.add(':root');
    const message = `the CSS rule @media ${at.params} (${file}, line ${at.source.start.line}) depends on the desktop's ${feature} setting, which the runtime cannot read`;
    for (const selector of selectors)
      guards.push({ selector, when: 'native', message: `${message}, and applies to ${selector}` });
  });
  return guards;
}

// The properties Chromium 153 parses in a declaration block, measured
// (crates/runic-css/src/chromium-properties.txt, shared with the inline
// style checks of runic_css::inline).
const CHROMIUM_PROPERTIES = new Set(
  readFileSync(new URL('../crates/runic-css/src/chromium-properties.txt', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean),
);

/**
 * Whether Chromium 153 drops every declaration of the property `prop`: one
 * it does not parse (every `-moz-`, `-o-` and `-ms-` property among them).
 * A declaration both engines drop is equivalent.
 */
function chromiumDrops(prop) {
  return !prop.startsWith('--') && !CHROMIUM_PROPERTIES.has(prop.toLowerCase());
}

// What Chromium 153 accepts as a value of one identifier where Stylo drops
// it, measured (crates/runic-css/src/chromium-keywords.txt, as
// runic_css::inline::chromium_drops_value reads it): property -> [flags,
// keywords].
const CHROMIUM_KEYWORDS = new Map(
  readFileSync(new URL('../crates/runic-css/src/chromium-keywords.txt', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, flags = '', keywords = ''] = line.split('\t');
      return [name, [flags, new Set(keywords.split(' ').filter(Boolean))]];
    }),
);

/**
 * Whether Chromium 153 drops the declaration `prop: value` too where Stylo
 * drops it: proven only for a value of one identifier Chromium does not accept
 * for the property (runic_css::inline::chromium_drops_value).
 */
function chromiumDropsValue(prop, value) {
  const name = prop.toLowerCase();
  if (chromiumDrops(name)) return true;
  const v = value.trim();
  if (name.startsWith('--') || !/^-?(?:[a-z_\u0080-\uffff]|-)[-\w\u0080-\uffff]*$/i.test(v))
    return false;
  const entry = CHROMIUM_KEYWORDS.get(name);
  return !entry || (!entry[0].includes('c') && !entry[1].has(v.toLowerCase()));
}

// `-webkit-` properties Chromium 153 keeps apart from their standard
// property (measured: both are computed properties); every other `-webkit-X`
// it parses aliases X.
const WEBKIT_DISTINCT = new Set([
  'box-decoration-break',
  'line-break',
  'ruby-position',
  'text-orientation',
  'writing-mode',
]);
// Legacy logical `-webkit-` aliases, as Chromium 153 expands them (measured).
const WEBKIT_LOGICAL = new Map(
  ['margin', 'padding', 'border'].flatMap(box =>
    [
      ['start', 'inline-start'],
      ['end', 'inline-end'],
      ['before', 'block-start'],
      ['after', 'block-end'],
    ].flatMap(([old, side]) =>
      (box === 'border' ? ['', '-color', '-style', '-width'] : ['']).map(part => [
        `-webkit-${box}-${old}${part}`,
        `${box}-${side}${part}`,
      ]),
    ),
  ),
);

/**
 * Whether the declaration `d`, which Stylo drops, is overridden in Chromium
 * by a later declaration of its own rule that Stylo parses: one of the same
 * property (`position: -webkit-sticky` before `position: sticky`), or of the
 * standard property a vendor property names (`-o-object-fit` before
 * `object-fit`), at least as important. Chromium drops the vendor form or
 * aliases it to that property, so the later declaration wins in both.
 */
function overriddenInRule(d, invalid) {
  const prop = d.prop.toLowerCase();
  const standard =
    WEBKIT_LOGICAL.get(prop) ??
    (/^-webkit-/.test(prop) && !WEBKIT_DISTINCT.has(prop.slice(8))
      ? prop.slice(8)
      : /^-(moz|o|ms)-/.test(prop)
        ? prop.replace(/^-(moz|o|ms)-/, '')
        : prop);
  const siblings = d.parent?.nodes ?? [];
  return siblings
    .slice(siblings.indexOf(d) + 1)
    .some(
      e =>
        e.type === 'decl' &&
        !invalid.has(e) &&
        [prop, standard].includes(e.prop.toLowerCase()) &&
        (e.important || !d.important),
    );
}

/** The axis a scroll padding property pads: `block`, `inline` or `both`. */
function scrollPaddingAxis(prop) {
  if (/-(block|top|bottom)(-|$)/.test(prop)) return 'block';
  if (/-(inline|left|right)(-|$)/.test(prop)) return 'inline';
  return 'both';
}

/**
 * A length value in pixels (rem as 16px): a number of px or rem, a custom
 * property the stylesheet declares once with one, or `calc()` of one times
 * a number (Tailwind's `calc(var(--spacing) * 2)`). Undefined otherwise.
 */
function lengthPx(value, values, depth = 0) {
  if (depth > 8) return undefined;
  const v = value.trim();
  let m = /^(-?[\d.]+)(px|rem)$/.exec(v);
  if (m) return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  if (v === '0') return 0;
  m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (m) {
    const declared = values.get(m[1]) ?? [];
    return declared.length === 1 ? lengthPx(declared[0], values, depth + 1) : undefined;
  }
  m = /^calc\(\s*(.+?)\s*\*\s*(-?[\d.]+)\s*\)$/.exec(v);
  if (m) {
    const inner = lengthPx(m[1], values, depth + 1);
    return inner === undefined ? undefined : inner * Number(m[2]);
  }
  return undefined;
}

/** The values each custom property is declared with in a stylesheet, and its `@property` initial value. */
function customPropertyValues(css) {
  const values = new Map();
  const add = (name, value) => values.set(name, [...(values.get(name) ?? []), value]);
  css.walkDecls(d => {
    if (d.prop.startsWith('--')) add(d.prop, d.value);
  });
  css.walkAtRules('property', rule =>
    rule.walkDecls('initial-value', d => add(rule.params.trim(), d.value)),
  );
  return values;
}

/**
 * The keywords a declaration value can hold: its own, and through each
 * `var()` its fallback and every value the stylesheet gives the custom
 * property (a superset: any element may match any of them).
 */
function possibleKeywords(value, values, seen = new Set()) {
  const words = new Set();
  const walk = nodes => {
    for (const n of nodes) {
      if (n.type === 'word') words.add(n.value.toLowerCase());
      else if (n.type === 'function' && n.value === 'var') {
        const comma = n.nodes.findIndex(x => x.type === 'div' && x.value === ',');
        if (comma >= 0) walk(n.nodes.slice(comma + 1));
        const name = n.nodes[0]?.value;
        if (name && !seen.has(name)) {
          seen.add(name);
          for (const v of values.get(name) ?? [])
            for (const w of possibleKeywords(v, values, seen)) words.add(w);
        }
      } else if (n.nodes) walk(n.nodes);
    }
  };
  walk(valueParser(value).nodes);
  return words;
}

/** Whether a declaration value can hold a `url()`, also through each `var()` (as possibleKeywords). */
function mayHoldUrl(value, values, seen = new Set()) {
  const walk = nodes =>
    nodes.some(n => {
      if (n.type !== 'function') return false;
      const name = n.value.toLowerCase();
      if (name === 'url') return true;
      if (name !== 'var') return walk(n.nodes);
      const { name: property, alternatives } = varAlternatives(n, values, seen);
      seen.add(property);
      return alternatives.some(v => mayHoldUrl(v, values, seen));
    });
  return /\burl\(/i.test(value) || walk(valueParser(value).nodes);
}

/**
 * The values a `var()` node can stand for: its fallback and every value the
 * stylesheet gives the custom property (a superset, as for possibleKeywords).
 * Names in `seen` are not expanded again.
 */
function varAlternatives(node, values, seen) {
  const comma = node.nodes.findIndex(x => x.type === 'div' && x.value === ',');
  const alternatives = comma >= 0 ? [valueParser.stringify(node.nodes.slice(comma + 1))] : [];
  const name = node.nodes[0]?.value;
  if (name && !seen.has(name)) alternatives.push(...(values.get(name) ?? []));
  return { name, alternatives };
}

/**
 * Why a `filter` or `backdrop-filter` value is outside what the renderers
 * draws, or undefined: functions other than the CSS filter functions (SVG
 * filter references with url()). Through each var() every value the
 * stylesheet gives the custom property is checked.
 */
function unsupportedFilter(value, values) {
  const visit = (nodes, seen) => {
    for (const n of nodes) {
      if (n.type !== 'function') continue;
      const name = n.value.toLowerCase();
      if (name === 'var') {
        const { name: property, alternatives } = varAlternatives(n, values, seen);
        const inner = new Set([...seen, property]);
        for (const v of alternatives) {
          const problem = visit(valueParser(v).nodes, inner);
          if (problem) return problem;
        }
        continue;
      }
      if (!FILTER_FUNCTIONS.has(name))
        return `${name}() is not a CSS filter function the renderers draw (SVG filter references are not supported)`;
    }
    return undefined;
  };
  return visit(valueParser(value).nodes, new Set());
}

const SCROLL_DRIVEN =
  /^(animation-timeline|animation-range(-start|-end)?|scroll-timeline(-name|-axis)?|view-timeline(-name|-axis|-inset)?|timeline-scope)$/;

/**
 * Why a time-based declaration is outside what the runtime reproduces
 * (docs/design/M6-LIBRARIES.md#animations), or undefined. Animations and
 * transitions run on Stylo's engine in Blitz; these parts of it differ
 * from Chromium or are missing.
 */
function unsupportedTimeBased(decl, values) {
  if (SCROLL_DRIVEN.test(decl.prop))
    return 'scroll-driven animations (animation and scroll timelines) are not supported';
  if (decl.prop === 'animation' || decl.prop === 'animation-fill-mode') {
    const words = possibleKeywords(decl.value, values);
    if (words.has('forwards') || words.has('both'))
      return "animation-fill-mode forwards and both are not supported: Blitz's style engine (Stylo) discards a finished animation when its element is next restyled, so the filled values would not stay as in Chromium";
  }
  if (
    (decl.prop === 'transition' || decl.prop === 'transition-behavior') &&
    possibleKeywords(decl.value, values).has('allow-discrete')
  )
    return 'transition-behavior: allow-discrete (discrete transitions, display transitions with @starting-style) is not supported';
  return undefined;
}

/** Split `text` at `separator` characters outside parentheses, brackets and escapes. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && separator.test(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

/** A rule's selectors with the selectors of the rules it is nested in substituted for `&`. */
function fullSelectors(rule) {
  let parent = rule.parent;
  while (parent && parent.type === 'atrule') parent = parent.parent;
  const own = splitTopLevel(rule.selector, /,/);
  if (!parent || parent.type !== 'rule') return own;
  return fullSelectors(parent).flatMap(outer =>
    own.map(s => (s.includes('&') ? s.replaceAll('&', `:is(${outer})`) : `${outer} ${s}`)),
  );
}

/**
 * The style rule whose elements `node` (a rule or a declaration) applies to,
 * or undefined: at-rule descriptors (@font-face, @property), declarations
 * of nested at-rules and keyframes apply to no selector of their own.
 */
function styleRuleOf(node) {
  const rule = node.type === 'rule' ? node : node.parent;
  if (rule?.type !== 'rule') return undefined;
  for (let p = rule.parent; p; p = p.parent)
    if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return undefined;
  return rule;
}

/**
 * Reject `node` with `diagnostic`, unless it belongs to a style rule and
 * `pending` collects such rejections: lowering decides them once the
 * program's elements are known (skipUnmatchedRules), as a rule no element
 * can match has no effect.
 */
function defer(pending, node, diagnostic) {
  const rule = pending && styleRuleOf(node);
  if (!rule) throw diagnostic;
  pending.push({
    selectors: fullSelectors(rule),
    ...(node.type === 'decl' ? { declaration: [node.prop, node.value] } : {}),
    diagnostic,
    lines: [rule.source?.start?.line, rule.source?.end?.line],
  });
}

/**
 * Reject with `diagnostic` now, or with the rejection deferred for the same
 * style rule (one an earlier check found there), which takes precedence as
 * it did before rejections were deferred.
 */
function reject(pending, diagnostic) {
  const at = diagnostic.source;
  const same =
    at &&
    pending?.find(
      p => p.diagnostic.source?.file === at.file && p.lines[0] <= at.line && at.line <= p.lines[1],
    );
  throw same ? same.diagnostic : diagnostic;
}

/** A selector list compared as text: its selectors with whitespace collapsed. */
const selectorKey = selectors => selectors.map(s => s.replace(/\s+/g, ' ').trim()).join(', ');

/**
 * Decide the rejections collection deferred (`graph.pendingRules`) for the
 * lowered program `ir` (docs/CONTRACT.md, rules no element can match): a
 * rejection stands unless no element of the program can ever match its
 * rule's selectors (runic_ir::facts, runic_css::unmatched) and the shipped
 * stylesheet holds the rule (with the rejected declaration), in which case
 * every rule of those selectors is left out of `ir.styles.css`, so that
 * Stylo never meets them. A style guard reports the program unsupported if
 * an element matches one after all. Throws the first rejection that stands;
 * returns `{ skipped, facts, open }`: the rules left out with the rejection
 * each carried and why no element can match, and the facts' sizes and open
 * parts.
 */
export function skipUnmatchedRules(pending, ir) {
  const lists = [...new Set(pending.map(p => selectorKey(p.selectors)))];
  const { results, facts, open } = unmatched(ir, lists);
  const reasons = new Map(lists.map((l, i) => [l, results[i]]));
  const css = postcss.parse(ir.styles.css);
  const shipped = new Map();
  css.walkRules(rule => {
    if (!styleRuleOf(rule)) return;
    const key = selectorKey(fullSelectors(rule));
    shipped.set(key, [...(shipped.get(key) ?? []), rule]);
  });
  const text = v => v.replace(/\s+/g, ' ').trim();
  const removed = new Map();
  const skipped = [];
  for (const p of pending) {
    const key = selectorKey(p.selectors);
    const reason = reasons.get(key);
    const rules = shipped.get(key) ?? [];
    const holds = p.declaration
      ? rules.some(r =>
          r.nodes.some(
            d =>
              d.type === 'decl' &&
              d.prop === p.declaration[0] &&
              text(d.value) === text(p.declaration[1]),
          ),
        )
      : rules.length > 0;
    if (!reason || !holds) throw p.diagnostic;
    for (const r of rules) removed.set(r, { key, reason, source: p.diagnostic.source });
    skipped.push({
      selector: key,
      ...p.diagnostic.source,
      code: p.diagnostic.code,
      message: p.diagnostic.message,
      reason,
    });
  }
  const keys = new Set([...removed.values()].map(r => r.key));
  // Guards of declarations in the rules left out never apply.
  ir.styles.guards = (ir.styles.guards ?? []).filter(
    g => !keys.has(selectorKey(splitTopLevel(g.selector, /,/))),
  );
  const guarded = new Set();
  for (const [rule, { key, reason, source }] of removed) {
    rule.remove();
    if (guarded.has(key)) continue;
    guarded.add(key);
    // The rule's elements without pseudo-elements: the safety net.
    const selector = withoutPseudoElements(splitTopLevel(key, /,/));
    const at = source ? ` (${source.file}, line ${source.line})` : '';
    ir.styles.guards.push({
      selector,
      message: `the CSS rule ${key}${at}, left out of the stylesheet because no element of the program can match it (${reason}), applies to an element`,
    });
  }
  if (!ir.styles.guards.length) delete ir.styles.guards;
  ir.styles.css = css.toString();
  return { skipped, facts, open };
}

const UNSUPPORTED_VALIDITY_STATES = new Set([
  'valid',
  'invalid',
  'user-valid',
  'user-invalid',
  'in-range',
  'out-of-range',
]);

/** Read pseudo-class identifiers, including CSS escapes, outside attribute strings. */
function unsupportedValiditySelector(selector) {
  const escape = /\\(?:[\da-f]{1,6}(?:\r\n|[\t\n\f\r ])?|[^\n\r\f])/iy;
  const identifier = /(?:[-\w\u0080-\uFFFF]|\\(?:[\da-f]{1,6}(?:\r\n|[\t\n\f\r ])?|[^\n\r\f]))+/iy;
  let quote,
    brackets = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '\\') {
      escape.lastIndex = i;
      const match = escape.exec(selector);
      if (match) i = escape.lastIndex - 1;
    } else if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '/' && selector[i + 1] === '*') {
      const end = selector.indexOf('*/', i + 2);
      i = end === -1 ? selector.length : end + 1;
    } else if (c === '[') brackets++;
    else if (c === ']') brackets--;
    else if (c === ':' && brackets === 0) {
      if (selector[i + 1] === ':') {
        i++;
        continue;
      }
      identifier.lastIndex = i + 1;
      const match = identifier.exec(selector);
      if (!match) continue;
      const name = match[0]
        .replace(/\\([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\n\r\f])/gi, (_, hex, literal) => {
          const point = hex && parseInt(hex, 16);
          return hex
            ? String.fromCodePoint(
                point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
                  ? point
                  : 0xfffd,
              )
            : literal;
        })
        .toLowerCase();
      if (UNSUPPORTED_VALIDITY_STATES.has(name)) return name;
      i = identifier.lastIndex - 1;
    }
  }
}

// The SVG children the frontends accept (docs/CONTRACT.md, inline SVG).
const SVG_CHILDREN = new Set([
  'g',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
]);

/**
 * The compound of a complex selector that names an SVG child element type
 * (also inside `:is()`/`:where()`) and a `:hover` or `:active` state, or undefined.
 */
function svgChildState(selector) {
  const plain = selector.replace(/\\./g, '_');
  for (const compound of splitTopLevel(plain, /[\s>+~]/)) {
    if (!/:(hover|active)\b(?!-)/i.test(compound)) continue;
    const types = [compound.match(/^(?:[\w-]*\|)?([a-z][\w-]*)/i)?.[1]];
    for (const m of compound.matchAll(/:(?:is|where)\(([^()]*)\)/gi))
      for (const s of splitTopLevel(m[1], /,/))
        types.push(
          splitTopLevel(s, /[\s>+~]/)
            .at(-1)
            ?.match(/^(?:[\w-]*\|)?([a-z][\w-]*)/i)?.[1],
        );
    if (types.some(t => t && SVG_CHILDREN.has(t.toLowerCase()))) return compound;
  }
  return undefined;
}

/**
 * The CSS contract (docs/CONTRACT.md) for one stylesheet: supported at-rules,
 * the time-based properties the runtime reproduces, no SVG-only properties,
 * and font sources Blitz loads. `file` labels the diagnostics.
 */
function checkRules(css, file, pending) {
  const at = rule => ({ file, line: rule.source.start.line, column: rule.source.start.column });
  css.walkAtRules(rule => {
    // `@charset "UTF-8"` changes nothing for a stylesheet read as UTF-8, as
    // the collector and Chromium read it; another encoding would.
    if (rule.name === 'charset') {
      if (/^"utf-8"$/i.test(rule.params.trim())) return;
      throw new Diagnostic(
        'E_CSS',
        `Unsupported CSS @charset ${rule.params}: stylesheets are read as UTF-8`,
        at(rule),
      );
    }
    if (
      !['font-face', 'media', 'layer', 'property', 'supports', 'keyframes', 'container'].includes(
        rule.name,
      )
    )
      throw new Diagnostic('E_CSS', `Unsupported CSS @${rule.name}`, at(rule));
    // Size queries are evaluated against the container's last layout (the
    // Blitz fork); style and scroll-state queries are not.
    if (rule.name === 'container' && /\b(style|scroll-state)\s*\(/i.test(rule.params))
      throw new Diagnostic(
        'E_CSS',
        `Unsupported container query @container ${rule.params}: only size queries are supported`,
        at(rule),
      );
  });
  // Query containers are size containers; scroll-state containers are not
  // supported.
  css.walkDecls(/^container(-type)?$/, decl => {
    if (/\bscroll-state\b/i.test(decl.value))
      return defer(
        pending,
        decl,
        new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration ${decl.prop}: ${decl.value}`,
          {
            file,
            line: decl.source.start.line,
            column: decl.source.start.column,
          },
        ),
      );
  });
  // Blitz never matches :target (the element a followed fragment link
  // names), which Chromium does (docs/BLITZ-GAPS.md).
  css.walkRules(rule => {
    if (/:target\b(?!-)/.test(rule.selector))
      return defer(
        pending,
        rule,
        new Diagnostic(
          'E_CSS',
          `Unsupported selector ${rule.selector}: Blitz never matches :target`,
          { file, line: rule.source.start.line, column: rule.source.start.column },
        ),
      );
  });
  // Form constraint validity and user-validity states are not maintained,
  // including when native submission validation is disabled by novalidate.
  checkValiditySelectors(css, file, pending);
  // SVG children have no boxes in Blitz, so pointer hits land on their
  // <svg> and :hover/:active never match them; Chromium hit-tests the shapes
  // (docs/BLITZ-GAPS.md, hit testing inside SVG). Selectors naming an SVG
  // child element with these states are rejected; a class selector that
  // lands on one cannot be found from the stylesheet.
  css.walkRules(rule => {
    const offending = fullSelectors(rule).find(svgChildState);
    if (offending)
      return defer(
        pending,
        rule,
        new Diagnostic(
          'E_CSS',
          `Unsupported selector ${rule.selector}: ${offending} gives an SVG child element a pointer state, which Blitz never matches (hit testing ends at the <svg>)`,
          { file, line: rule.source.start.line, column: rule.source.start.column },
        ),
      );
  });
  const values = customPropertyValues(css);
  // The DOM is built without wrapper nodes: selectors and ordinary
  // properties are rendered by Blitz/Stylo and checked by conformance.
  css.walkDecls(decl => {
    const unsupported = unsupportedTimeBased(decl, values);
    if (unsupported)
      return defer(
        pending,
        decl,
        new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration ${decl.prop}: ${unsupported}`,
          {
            file: file,
            line: decl.source.start.line,
            column: decl.source.start.column,
          },
        ),
      );
    const filter = /^(backdrop-)?filter$/.test(decl.prop)
      ? unsupportedFilter(decl.value, values)
      : undefined;
    if (filter)
      return defer(
        pending,
        decl,
        new Diagnostic('E_CSS_PROPERTY', `Unsupported CSS declaration ${decl.prop}: ${filter}`, {
          file,
          line: decl.source.start.line,
          column: decl.source.start.column,
        }),
      );
    // `position: sticky` is laid out, painted and hit-tested as in Chromium 153
    // by the Blitz fork, which reports the one form it keeps in flow (a sticky
    // ordinary inline box) when it lays one out (docs/CONTRACT.md).
    // Blitz generates the strings of `content` only (docs/BLITZ-GAPS.md).
    if (
      decl.prop === 'content' &&
      /(^|[\s,])(open-quote|close-quote|no-open-quote|no-close-quote)\b|\b(counters?|attr|url|image-set|linear-gradient)\(/i.test(
        decl.value,
      )
    )
      return defer(
        pending,
        decl,
        new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration content: ${decl.value}: Blitz generates strings only (quotes, counters, attr() and images are not supported)`,
          { file, line: decl.source.start.line, column: decl.source.start.column },
        ),
      );
    // Blitz transforms the case of text only (docs/BLITZ-GAPS.md).
    if (decl.prop === 'text-transform' && /full-width|full-size-kana/.test(decl.value))
      return defer(
        pending,
        decl,
        new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration text-transform: ${decl.value}: Blitz transforms the case of text only (none, capitalize, uppercase and lowercase are supported)`,
          { file, line: decl.source.start.line, column: decl.source.start.column },
        ),
      );
    if (SVG_PAINT_CSS.test(decl.prop) && mayHoldUrl(decl.value, values))
      return defer(
        pending,
        decl,
        new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration ${decl.prop}: paint servers (url()) are not supported in inline SVG`,
          { file, line: decl.source.start.line, column: decl.source.start.column },
        ),
      );
    // Blitz draws an inline <svg> from its subtree's computed SVG painting
    // properties (usvg); the other SVG-only properties would be ignored
    // natively (docs/BLITZ-GAPS.md).
    if (!SVG_PAINT_CSS.test(decl.prop) && SVG_CSS.test(decl.prop))
      return defer(
        pending,
        decl,
        new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration ${decl.prop}: Blitz draws inline SVG with the painting properties fill, stroke and their fill-*/stroke-* longhands only, so CSS for markers, geometry and other SVG properties is ignored; use presentation attributes`,
          {
            file: file,
            line: decl.source.start.line,
            column: decl.source.start.column,
          },
        ),
      );
    const parsed = valueParser(decl.value);
    if (
      decl.prop === 'src' &&
      !parsed.nodes.some(
        n =>
          n.type === 'function' &&
          n.value === 'format' &&
          ['woff2', 'woff2-variations'].includes(
            valueParser.stringify(n.nodes).replace(/^['"]|['"]$/g, ''),
          ),
      )
    )
      return defer(
        pending,
        decl,
        new Diagnostic(
          'E_FONT_FORMAT',
          'Embedded font src requires an explicit format("woff2") or format("woff2-variations") hint for the pinned Blitz loader',
          {
            file: file,
            line: decl.source.start.line,
            column: decl.source.start.column,
          },
        ),
      );
  });
}

function checkValiditySelectors(css, file, pending) {
  css.walkRules(rule => {
    const state = unsupportedValiditySelector(rule.selector);
    if (state)
      return defer(
        pending,
        rule,
        new Diagnostic(
          'E_CSS',
          `Unsupported selector ${rule.selector}: the runtime does not maintain :${state}`,
          { file, line: rule.source.start.line, column: rule.source.start.column },
        ),
      );
  });
}
