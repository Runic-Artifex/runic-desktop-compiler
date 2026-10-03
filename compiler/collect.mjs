import { build } from 'vite';
import ts from 'typescript';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { frontendTooling } from './adapters/tooling.mjs';
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
                const resolved = await this.resolve(specifier, id);
                if (!resolved)
                  throw new Diagnostic(
                    'E_RESOLVE',
                    `Cannot resolve ${specifier}`,
                    location(stmt, root),
                  );
                imports.push({ specifier, resolved: resolved.id.split('?')[0] });
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
    css.walkAtRules(rule => {
      if (!['font-face', 'media'].includes(rule.name))
        throw new Diagnostic('E_CSS', `Unsupported CSS @${rule.name}`, {
          file: path.relative(root, mod.id),
          line: rule.source.start.line,
          column: rule.source.start.column,
        });
    });
    css.walkRules(rule => {
      if (/:empty|:nth|:first-child|:last-child|:only-child|\+|~/.test(rule.selector))
        throw new Diagnostic(
          'E_CSS_SELECTOR',
          'Structural selectors are outside the wrapper-node compatibility contract',
        );
    });
    css.walkDecls(decl => {
      const allowed = new Set([
        'font-family',
        'src',
        'font-weight',
        'box-sizing',
        'margin',
        'background',
        'color',
        'font-size',
        'padding',
        'max-width',
        'border',
        'border-radius',
        'line-height',
        'display',
        'width',
        'flex-wrap',
        'gap',
        'border-color',
      ]);
      if (!allowed.has(decl.prop) || decl.important)
        throw new Diagnostic(
          'E_CSS_PROPERTY',
          `Unsupported CSS declaration ${decl.prop}; animations and external behavior are outside the contract`,
          {
            file: path.relative(root, mod.id),
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
            valueParser.stringify(n.nodes).replace(/^['"]|['"]$/g, '') === 'woff2',
        )
      )
        throw new Diagnostic(
          'E_FONT_FORMAT',
          'Embedded font src requires an explicit format("woff2") hint for the pinned Blitz loader',
          {
            file: path.relative(root, mod.id),
            line: decl.source.start.line,
            column: decl.source.start.column,
          },
        );
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
    manifest,
    hash: hash({ manifest, assets: uniqueAssets, html: hash(htmlSource), config }),
  };
}
