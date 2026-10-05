import { build } from 'vite';
import ts from 'typescript';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { frontendTooling } from './adapters/tooling.mjs';
import { cssCheck } from './codegen.mjs';
import { parse as parseHTML } from 'parse5';
import { isSourcePackage } from '../frontend/sources.ts';

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
/** CSS properties that apply only to SVG content (paint, markers, geometry). */
// What Stylo (Blitz's preferences) drops and Chromium applies differently is
// reported; these drops are verified equivalent in Chromium 153
// (docs/research/M6-CSS.md): vendor pseudo-classes and pseudo-elements
// (scrollbar and form-control internals Blitz has no parts for), media
// features Stylo does not know whose Chromium default is false, and vendor
// properties without effect on desktop or next to their standard property.
const EQUIVALENT_DROPPED_RULE =
  /::?-(webkit|moz)-|\((forced-colors|prefers-contrast|prefers-reduced-motion)\b/;
const EQUIVALENT_DROPPED_PROPERTY = new Set([
  '-webkit-text-size-adjust',
  '-webkit-tap-highlight-color',
  '-ms-overflow-style',
  '-webkit-overflow-scrolling',
  '-webkit-text-decoration',
  '-webkit-backdrop-filter',
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

// This plugin sees original application modules before Vite's JSX transform.
// Collection is deliberately independent of the React lowering adapter.
// Modules of packages compiled from source (frontend/sources.ts) are
// collected too, with the package they belong to.
export function collectionPlugin(root, modules, tooling, onDiagnostic) {
  let packageModules = 0;
  return {
    name: 'runic-input-graph',
    enforce: 'pre',
    async transform(code, id) {
      try {
        if (id.includes('?')) return;
        let source;
        if (!id.startsWith(root + path.sep) || id.includes('/node_modules/')) {
          const pkg = await owningPackage(id);
          if (!pkg || !isSourcePackage(pkg.name, pkg.version)) return;
          source = { name: pkg.name, version: pkg.version, dir: pkg.dir };
          if (pkg.sideEffects !== false)
            throw new Diagnostic(
              'E_SOURCE_PACKAGE',
              `${pkg.name}@${pkg.version} does not declare "sideEffects": false; packages compiled from source must, since only the declarations a program reaches are lowered`,
            );
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
        modules.set(id, { id, code, imports, ...(source ? { package: source } : {}) });
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
  let entry, htmlSource, documentAttrs;
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
  let bundled, collectionError;
  try {
    bundled = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        ...(kit ? [kit.plugin] : []),
        collectionPlugin(root, modules, tooling, e => {
          collectionError = new Diagnostic(e.code, e.message, e.source);
        }),
        ...tooling.plugins,
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
  for (const mod of [...modules.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!mod.id.endsWith('.css')) continue;
    const css = postcss.parse(mod.code, { from: mod.id });
    // URL inspection uses a CSS AST; no fetching is available in the native app.
    const jobs = [];
    if (!tooling.tailwind) checkRules(css, path.relative(root, mod.id));
    css.walkDecls(decl => {
      const parsed = valueParser(decl.value);
      parsed.walk(node => {
        if (node.type !== 'function' || node.value !== 'url') return;
        const url = valueParser.stringify(node.nodes).replace(/^['"]|['"]$/g, '');
        if (url.length > 4096 || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url))
          throw new Diagnostic(
            'E_ASSET',
            'CSS resources must be bounded local paths, not remote/data URLs',
            {
              file: path.relative(root, mod.id),
              line: decl.source.start.line,
              column: decl.source.start.column,
            },
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
    if (!tooling.tailwind) checkWithStylo(mod.code, path.relative(root, mod.id));
    cssParts.push(css.toString());
  }
  // Preserve Vite's actual entry cascade, rather than sorting source filenames.
  const emitted = bundled.output.filter(a => a.type === 'asset');
  const styles = emitted.filter(a => a.fileName.endsWith('.css'));
  if (styles.length > 1)
    throw new Diagnostic('E_CSS_ORDER', 'Split/dynamic stylesheet order is outside this contract');
  let orderedCSS = '';
  if (styles.length) {
    const css = postcss.parse(String(styles[0].source));
    // Tailwind CSS generates the stylesheet: its output is what Blitz renders.
    if (tooling.tailwind) {
      const label = 'stylesheet generated by Tailwind CSS';
      checkRules(css, label);
      checkWithStylo(String(styles[0].source), label);
    }
    css.walkDecls(decl => {
      const parsed = valueParser(decl.value);
      parsed.walk(n => {
        if (n.type !== 'function' || n.value !== 'url') return;
        const url = valueParser.stringify(n.nodes).replace(/^['"]|['"]$/g, '');
        const asset = emitted.find(a => '/' + a.fileName === url);
        if (!asset || !asset.fileName.endsWith('.woff2'))
          throw new Diagnostic('E_ASSET', 'Unresolved emitted CSS resource');
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
  return {
    root,
    entry,
    config,
    modules,
    tooling,
    css: orderedCSS,
    assets: uniqueAssets,
    documentAttrs,
    ...(kit ? { kit } : {}),
    manifest,
    hash: hash({ manifest, assets: uniqueAssets, html: hash(htmlSource), config }),
  };
}

/** Report what Stylo drops from the stylesheet `code` (see EQUIVALENT_*). */
function checkWithStylo(code, file) {
  const css = postcss.parse(code);
  const decls = [];
  // Declarations of style rules; at-rule descriptors (@font-face, @property)
  // are checked by the stylesheet parse.
  css.walkDecls(d => {
    if (d.parent?.type === 'rule') decls.push(d);
  });
  const at = (line, column) => ({ file, line, column });
  const result = cssCheck(
    code,
    decls.map(d => [d.prop, d.value]),
  );
  for (const i of result.invalid) {
    const d = decls[i];
    if (EQUIVALENT_DROPPED_PROPERTY.has(d.prop)) continue;
    // Blitz draws no resize grip whatever `resize` says; Chromium's default
    // (`both`) already differs, a gap recorded in docs/BLITZ-GAPS.md.
    if (d.prop === 'resize') continue;
    // A declaration in a rule Stylo drops as a whole is reported with the rule.
    const rule = d.parent?.type === 'rule' ? d.parent.selector : '';
    if (EQUIVALENT_DROPPED_RULE.test(rule)) continue;
    throw new Diagnostic(
      'E_CSS_PROPERTY',
      `Unsupported CSS declaration ${d.prop}: ${d.value}${rule ? ` (in ${rule})` : ''}: Blitz's style engine (Stylo) does not support it`,
      at(d.source.start.line, d.source.start.column),
    );
  }
  const lines = code.split('\n');
  for (const d of result.dropped) {
    if (/Unsupported property declaration/.test(d.message)) continue; // the declarations above
    const text = lines[d.line - 1]?.slice(d.column - 1) ?? '';
    if (EQUIVALENT_DROPPED_RULE.test(text) || EQUIVALENT_DROPPED_RULE.test(d.message)) continue;
    throw new Diagnostic(
      'E_CSS',
      `Unsupported CSS rule: Blitz's style engine (Stylo) drops it (${d.message})`,
      at(d.line, d.column),
    );
  }
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

const COLOR_FUNCTIONS =
  /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|contrast-color)$/i;

/**
 * Whether the argument nodes of a shadow name a colour: a colour function, a
 * hex colour or colour keyword, or a var() whose every possible value does.
 * Stylo has validated the declarations without var(), so a word that is not
 * a number or length is a colour keyword there.
 */
function namesColor(nodes, values, seen = new Set()) {
  return nodes.some(n => {
    if (n.type === 'word')
      return !valueParser.unit(n.value) && n.value.toLowerCase() !== 'currentcolor';
    if (n.type !== 'function') return false;
    if (n.value.toLowerCase() !== 'var') return COLOR_FUNCTIONS.test(n.value);
    const { name, alternatives } = varAlternatives(n, values, seen);
    const inner = new Set([...seen, name]);
    return (
      alternatives.length > 0 &&
      alternatives.every(v => namesColor(valueParser(v).nodes, values, inner))
    );
  });
}

/**
 * Why a `filter` or `backdrop-filter` value is outside what the renderers
 * draws, or undefined: functions other than the CSS filter functions (SVG
 * filter references with url()), and drop-shadow() without its own colour,
 * which Blitz draws black instead of in currentColor. Through each var()
 * every value the stylesheet gives the custom property is checked.
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
      if (
        name === 'drop-shadow' &&
        (!namesColor(n.nodes, values) ||
          possibleKeywords(valueParser.stringify(n.nodes), values).has('currentcolor'))
      )
        return 'drop-shadow() needs its own colour: Blitz draws a shadow without one (currentColor) in black';
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
function checkRules(css, file) {
  css.walkAtRules(rule => {
    if (!['font-face', 'media', 'layer', 'property', 'supports', 'keyframes'].includes(rule.name))
      throw new Diagnostic('E_CSS', `Unsupported CSS @${rule.name}`, {
        file: file,
        line: rule.source.start.line,
        column: rule.source.start.column,
      });
  });
  // Blitz never matches :target (the element a followed fragment link
  // names), which Chromium does (docs/BLITZ-GAPS.md).
  css.walkRules(rule => {
    if (/:target\b(?!-)/.test(rule.selector))
      throw new Diagnostic(
        'E_CSS',
        `Unsupported selector ${rule.selector}: Blitz never matches :target`,
        { file, line: rule.source.start.line, column: rule.source.start.column },
      );
  });
  // SVG children have no boxes in Blitz, so pointer hits land on their
  // <svg> and :hover/:active never match them; Chromium hit-tests the shapes
  // (docs/BLITZ-GAPS.md, hit testing inside SVG). Selectors naming an SVG
  // child element with these states are rejected; a class selector that
  // lands on one cannot be found from the stylesheet.
  css.walkRules(rule => {
    const offending = fullSelectors(rule).find(svgChildState);
    if (offending)
      throw new Diagnostic(
        'E_CSS',
        `Unsupported selector ${rule.selector}: ${offending} gives an SVG child element a pointer state, which Blitz never matches (hit testing ends at the <svg>)`,
        { file, line: rule.source.start.line, column: rule.source.start.column },
      );
  });
  const values = customPropertyValues(css);
  // The DOM is built without wrapper nodes: selectors and ordinary
  // properties are rendered by Blitz/Stylo and checked by conformance.
  css.walkDecls(decl => {
    const unsupported = unsupportedTimeBased(decl, values);
    if (unsupported)
      throw new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration ${decl.prop}: ${unsupported}`,
        {
          file: file,
          line: decl.source.start.line,
          column: decl.source.start.column,
        },
      );
    const filter = /^(backdrop-)?filter$/.test(decl.prop)
      ? unsupportedFilter(decl.value, values)
      : undefined;
    if (filter)
      throw new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration ${decl.prop}: ${filter}`,
        {
          file,
          line: decl.source.start.line,
          column: decl.source.start.column,
        },
      );
    // Blitz transforms text to upper and lower case only (docs/BLITZ-GAPS.md).
    if (decl.prop === 'text-transform' && /capitalize|full-width|full-size-kana/.test(decl.value))
      throw new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration text-transform: ${decl.value}: Blitz lays text out in upper or lower case only (uppercase, lowercase and none are supported)`,
        { file, line: decl.source.start.line, column: decl.source.start.column },
      );
    if (SVG_PAINT_CSS.test(decl.prop) && mayHoldUrl(decl.value, values))
      throw new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration ${decl.prop}: paint servers (url()) are not supported in inline SVG`,
        { file, line: decl.source.start.line, column: decl.source.start.column },
      );
    // Blitz draws an inline <svg> from its subtree's computed SVG painting
    // properties (usvg); the other SVG-only properties would be ignored
    // natively (docs/BLITZ-GAPS.md).
    if (!SVG_PAINT_CSS.test(decl.prop) && SVG_CSS.test(decl.prop))
      throw new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration ${decl.prop}: Blitz draws inline SVG with the painting properties fill, stroke and their fill-*/stroke-* longhands only, so CSS for markers, geometry and other SVG properties is ignored; use presentation attributes`,
        {
          file: file,
          line: decl.source.start.line,
          column: decl.source.start.column,
        },
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
      throw new Diagnostic(
        'E_FONT_FORMAT',
        'Embedded font src requires an explicit format("woff2") or format("woff2-variations") hint for the pinned Blitz loader',
        {
          file: file,
          line: decl.source.start.line,
          column: decl.source.start.column,
        },
      );
  });
}
