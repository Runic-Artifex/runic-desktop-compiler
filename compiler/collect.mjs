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
// Computed by Stylo but not used by Blitz's CPU renderer (docs/BLITZ-GAPS.md).
const IGNORED_PROPERTY = new Map([
  ['filter', 'the CPU renderer draws no CSS filters'],
  ['backdrop-filter', 'the CPU renderer draws no backdrop filters'],
]);

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
      return { name: bare.name, version: String(info.version), dir, subpath: bare.subpath };
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

// This plugin sees original application modules before Vite's JSX transform.
// Collection is deliberately independent of the React lowering adapter.
export function collectionPlugin(root, modules, tooling, onDiagnostic) {
  return {
    name: 'runic-input-graph',
    enforce: 'pre',
    async transform(code, id) {
      try {
        if (!id.startsWith(root + path.sep) || id.includes('/node_modules/') || id.includes('?'))
          return;
        if (
          !['.js', '.jsx', '.ts', '.tsx', '.css', ...(tooling.extensions ?? [])].includes(
            path.extname(id),
          )
        )
          return;
        if (code.length > 1048576 || (modules.size >= 256 && !modules.has(id)))
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
        modules.set(id, { id, code, imports });
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
  const entry = path.resolve(root, config.entry);
  if (!entry.startsWith(root + path.sep))
    throw new Diagnostic('E_ENTRY', 'Entry must be inside the application');
  const htmlSource = await readFile(path.join(root, 'index.html'), 'utf8');
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
  const documentAttrs = Object.fromEntries((htmlElement?.attrs ?? []).map(a => [a.name, a.value]));
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
  const tooling = await frontendTooling(root, config);
  const modules = new Map();
  let bundled, collectionError;
  try {
    bundled = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        collectionPlugin(root, modules, tooling, e => {
          collectionError = new Diagnostic(e.code, e.message, e.source);
        }),
        ...tooling.plugins,
      ],
      build: { write: false, minify: false, assetsInlineLimit: 0 },
      esbuild: { jsx: 'transform' },
    });
  } catch (e) {
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
  for (const d of decls) {
    const ignored = IGNORED_PROPERTY.get(d.prop);
    if (ignored)
      throw new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration ${d.prop}: ${ignored}`,
        at(d.source.start.line, d.source.start.column),
      );
  }
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
    // Blitz renders an inline <svg> from its subtree's attributes (usvg), so
    // these SVG-only properties would be ignored natively (docs/BLITZ-GAPS.md).
    if (SVG_CSS.test(decl.prop))
      throw new Diagnostic(
        'E_CSS_PROPERTY',
        `Unsupported CSS declaration ${decl.prop}: Blitz renders inline SVG from its attributes, so CSS for SVG paint and geometry is ignored; use presentation attributes`,
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
