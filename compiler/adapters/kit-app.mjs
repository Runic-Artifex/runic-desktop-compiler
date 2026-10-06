// A SvelteKit app as the collector sees it (compiler/adapters/kit.mjs): the
// generated modules (virtual files under `<app>/.svelte-kit/runic/`), the
// Vite plugin that provides them and Kit's aliases, the app.html
// attributes, and what the Svelte adapter checks in the app's code.
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Diagnostic } from '../collect.mjs';
import {
  at,
  componentProps,
  KIT_VERSION,
  kitFail,
  manifestOf,
  readAppHtml,
  readSvelteConfig,
  routeModule,
  serverModule,
} from './kit.mjs';
import { checkGeneration, OUTPUT_DIR, preprocessed } from '../generate.mjs';
import { generate } from './kit-generate.mjs';

const RUNTIME_DIR = fileURLToPath(new URL('../../frontend/adapters/kit/', import.meta.url));
/** The router's modules (frontend/adapters/kit/), compiled into every app. */
const RUNTIME_FILES = [
  'client.ts',
  'url.ts',
  'load.ts',
  'page.svelte.ts',
  'kit.ts',
  'navigation.ts',
  'environment.ts',
  'state.ts',
];
/** `$app/*` modules and what provides them. */
const APP_MODULES = {
  '$app/state': 'state.ts',
  '$app/navigation': 'navigation.ts',
  '$app/environment': 'environment.ts',
};

/** A path from the generated directory to a file, as an import specifier. */
function importFrom(fromDir, file) {
  let r = path.relative(fromDir, file).split(path.sep).join('/');
  if (!r.startsWith('.')) r = './' + r;
  return r;
}

export async function kitApp(root, config, compiler) {
  if (config.kit !== true) kitFail('E_CONFIG', 'runic.json kit must be true', at('runic.json'));
  if (config.entry !== undefined || config.alias !== undefined)
    kitFail(
      'E_CONFIG',
      'A SvelteKit app has no runic.json entry or alias (Kit gives both)',
      at('runic.json'),
    );
  if (config.framework !== 'svelte')
    kitFail('E_CONFIG', 'A SvelteKit app needs "framework": "svelte"', at('runic.json'));
  const options = readSvelteConfig(root, config);
  const html = readAppHtml(root);
  const { manifest, dir: kitDir } = await manifestOf(root, options);
  const relOf = f => path.relative(root, path.resolve(root, f)).split(path.sep).join('/');
  const generated = path.join(root, '.svelte-kit', 'runic');

  // Hooks and server code.
  for (const [name, file] of Object.entries(manifest.hooks))
    if (file && name !== 'client')
      kitFail(
        'E_KIT_HOOKS',
        `${name === 'server' ? 'Server hooks' : 'Universal hooks (reroute, transport)'} are unsupported`,
        at(relOf(file)),
      );
  for (const ext of ['.js', '.ts'])
    if (existsSync(path.join(root, 'src', 'service-worker' + ext)))
      kitFail('E_KIT_HOOKS', 'Service workers are unsupported', at('src/service-worker' + ext));
  // Server code and generated inputs (compiler/generate.mjs): server loads
  // and prerendered endpoints were evaluated by `runic generate` into data
  // tables; builds check the record and read them, and never run them.
  const endpoints = manifest.routes.filter(r => r.endpoint);
  const serverNodes = manifest.nodes.filter(n => n.server);
  let server = { nodes: {}, fetch: {}, routes: [] };
  if (config.generate?.length || endpoints.length || serverNodes.length) {
    checkGeneration(root, config, true);
    server = JSON.parse(readFileSync(path.join(root, OUTPUT_DIR, 'server.json'), 'utf8'));
  }
  for (const route of endpoints) {
    const fetched = Object.keys(server.fetch).some(url => route.pattern.test(url.split('?')[0]));
    if (!fetched)
      kitFail(
        'E_KIT_SERVER',
        `The endpoint ${route.id} is not prerendered data of any load (generation fetched none of its URLs): the native app has no server`,
        at(relOf(route.endpoint.file)),
      );
  }
  const serverLoads = new Map();
  for (const node of serverNodes) {
    const rel = relOf(node.server);
    if (!serverModule(root, rel).load) continue;
    const table = server.nodes[rel];
    if (!table)
      kitFail(
        'E_KIT_SERVER',
        'This server load was not evaluated at generation (its routes are not prerendered): the native app has no server',
        at(rel),
      );
    serverLoads.set(node, { rel, ...table });
  }

  // Nodes: components (Kit's default layout and error page as generated
  // copies), universal loads, declared props.
  const fallbackDir = path.join(kitDir, 'src/runtime/components/svelte-5');
  const virtual = new Map();
  const nodes = manifest.nodes.map((node, index) => {
    if (!node.component)
      kitFail(
        'E_KIT_ROUTES',
        'A route module without a component is unsupported',
        at(relOf(node.universal ?? 'src/routes')),
      );
    let component = path.resolve(root, node.component);
    let props;
    if (component.startsWith(fallbackDir + path.sep)) {
      // `<svelte:options runes={true} />` is the compiled mode already.
      const text = readFileSync(component, 'utf8').replace(
        /<svelte:options runes=\{true\} \/>\s*/,
        '',
      );
      component = path.join(generated, 'components', path.basename(component));
      virtual.set(component, text);
      props = path.basename(component) === 'layout.svelte' ? new Set(['children']) : new Set();
    } else props = componentProps(compiler, root, relOf(component));
    const universal = node.universal ? relOf(node.universal) : undefined;
    return {
      index,
      component,
      componentImport: importFrom(generated, component),
      universal,
      universalImport: universal && importFrom(generated, path.join(root, universal)),
      ...(universal
        ? (({ load, data }) => ({ load, data }))(routeModule(root, universal))
        : { load: false, data: false }),
      props,
      // A server load: its data table (generation) and what its load read.
      ...(serverLoads.has(node)
        ? {
            server: {
              rel: serverLoads.get(node).rel,
              import: importFrom(generated, path.join(root, serverLoads.get(node).rel)),
              uses: serverLoads.get(node).uses,
              table: serverLoads.get(node).table,
            },
          }
        : {}),
    };
  });

  // Routes with a page, in Kit's order, as client.js parses them.
  const routes = manifest.routes
    .filter(r => r.page)
    .map((r, index) => {
      const layouts = [0, ...r.page.layouts.slice(1)];
      const errors = [1, ...r.page.errors.slice(1)];
      const n = Math.max(layouts.length, errors.length);
      layouts.length = errors.length = n;
      return {
        index,
        id: r.id,
        pattern: r.pattern,
        params: r.params,
        layouts,
        errors,
        leaf: r.page.leaf,
      };
    });
  const paramNames = [];
  for (const r of routes)
    for (const p of r.params) if (!paramNames.includes(p.name)) paramNames.push(p.name);
  const matchers = Object.entries(manifest.matchers).map(([name, file]) => ({
    name,
    import: importFrom(generated, path.resolve(root, file)),
  }));

  // The composition: each branch's component sequence is a path in a
  // trie; a level whose component is unchanged keeps its instance.
  const trie = [];
  const keys = new Map();
  const place = (parent, node, leaf) => {
    const key = `${parent}:${node}:${leaf}`;
    if (!keys.has(key)) {
      keys.set(key, trie.length);
      trie.push({
        id: trie.length,
        parent,
        node,
        leaf,
        depth: parent < 0 ? 0 : trie[parent].depth + 1,
        children: [],
      });
      if (parent >= 0) trie[parent].children.push(trie.length - 1);
    }
    return keys.get(key);
  };
  const pathOf = ids => {
    let t = -1;
    return ids.map((n, i) => (t = place(t, n, i === ids.length - 1)));
  };
  const variants = [];
  for (const r of routes) {
    const loaders = [...r.layouts, r.leaf];
    const present = loaders.map((n, i) => ({ n, i })).filter(x => x.n !== undefined);
    variants.push({ kind: 'route', route: r, loaders, trie: pathOf(present.map(x => x.n)) });
    for (let i = 1; i < loaders.length; i++) {
      if (loaders[i] === undefined) continue;
      // load_nearest_error_page: the nearest error page above level i,
      // attached after the last level present at or before its own.
      let k = i - 1;
      while (r.errors[k] === undefined) k--;
      let j = k;
      while (loaders[j] === undefined) j--;
      const kept = present.filter(x => x.i <= j);
      variants.push({
        kind: 'error',
        route: r,
        level: i,
        idx: j + 1,
        errorNode: r.errors[k],
        loaders,
        kept,
        trie: pathOf([...kept.map(x => x.n), r.errors[k]]),
      });
    }
  }
  const rootError = { trie: pathOf([0, 1]) };
  const maxDepth = Math.max(...trie.map(t => t.depth)) + 1;

  // `./$types` of each route directory with a page or a layout.
  const routesDir = path.join(root, 'src', 'routes');
  const typeDirs = new Map();
  for (const r of manifest.routes) {
    const dir = r.id === '/' ? '' : r.id.slice(1);
    const info = {};
    if (r.leaf?.component) info.page = manifest.nodes.indexOf(r.leaf);
    if (r.layout?.component && !r.layout.component.includes('/svelte-5/'))
      info.layout = manifest.nodes.indexOf(r.layout);
    if (info.page !== undefined || info.layout !== undefined) typeDirs.set(dir, info);
  }

  const files = generate({
    version: KIT_VERSION,
    hash: options.routerType === 'hash',
    html,
    nodes,
    routes,
    paramNames,
    matchers,
    hooksClient: manifest.hooks.client
      ? importFrom(generated, path.resolve(root, manifest.hooks.client))
      : undefined,
    trie,
    variants,
    rootError,
    maxDepth,
    typeDirs,
    fetchTable: server.fetch,
  });
  for (const [name, text] of files) virtual.set(path.join(generated, name), text);
  for (const name of RUNTIME_FILES)
    virtual.set(path.join(generated, name), readFileSync(path.join(RUNTIME_DIR, name), 'utf8'));

  const aliases = { $lib: 'src/lib', ...options.aliases };
  const typesDir = path.join(generated, 'types');
  const typeFile = dir => path.join(typesDir, dir, '$types.ts');
  /** Where `specifier` imported from `importer` leads among the generated modules. */
  const resolveVirtual = (specifier, importer) => {
    if (virtual.has(specifier)) return specifier;
    if (APP_MODULES[specifier]) return path.join(generated, APP_MODULES[specifier]);
    if (specifier === '@sveltejs/kit') return path.join(generated, 'kit.ts');
    if (/^\$app\//.test(specifier) || /^\$env\//.test(specifier) || specifier === '$service-worker')
      return {
        error: `${specifier} is unsupported (supported: ${Object.keys(APP_MODULES).join(', ')}, @sveltejs/kit)`,
      };
    if (!importer) return undefined;
    if (specifier === './$types' || specifier === './$types.js') {
      const from = path.dirname(importer);
      if (from === routesDir || from.startsWith(routesDir + path.sep)) {
        const dir = path.relative(routesDir, from).split(path.sep).join('/');
        if (virtual.has(typeFile(dir))) return typeFile(dir);
      }
    }
    if (specifier.startsWith('.') && importer.startsWith(generated + path.sep)) {
      const target = path.resolve(path.dirname(importer), specifier);
      if (virtual.has(target)) return target;
    }
    return undefined;
  };

  /** Extensions the preprocess generation steps compile (`.md`). */
  const preprocessExtensions = options.extensions.filter(e => e !== '.svelte');
  const preprocessedId = id => {
    const file = id?.split('?')[0];
    return file &&
      file.startsWith(root + path.sep) &&
      preprocessExtensions.some(e => file.endsWith(e)) &&
      existsSync(file)
      ? file + '.svelte'
      : undefined;
  };
  const failure = { diagnostic: undefined };
  const plugin = {
    name: 'runic-sveltekit',
    enforce: 'pre',
    async resolveId(specifier, importer) {
      const v = resolveVirtual(specifier, importer?.split('?')[0]);
      if (typeof v === 'string') return v;
      if (v?.error) {
        // Located at the import in the source file (Vite wraps errors thrown
        // here, so the collector rethrows the recorded diagnostic).
        const file = importer?.split('?')[0];
        let source;
        if (file && existsSync(file)) {
          const lines = readFileSync(file, 'utf8').split('\n');
          const line = lines.findIndex(
            l => /\bfrom\s*['"]|\bimport\s*['"(]/.test(l) && l.includes(specifier),
          );
          source = at(
            path.relative(root, file),
            line + 1 || 1,
            line < 0 ? 1 : lines[line].indexOf(specifier),
          );
        }
        failure.diagnostic ??= new Diagnostic('E_KIT_IMPORT', v.error, source);
        throw new Error(v.error);
      }
      for (const [find, target] of Object.entries(aliases)) {
        const base = find.replace(/\/\*$/, '');
        if (specifier === base || specifier.startsWith(base + '/')) {
          const replaced =
            path.join(root, target.replace(/\/\*$/, '')) + specifier.slice(base.length);
          const r = await this.resolve(replaced, importer, { skipSelf: true });
          return preprocessedId(r?.id) ?? r ?? replaced;
        }
      }
      // A preprocessed file (`.md`): its recorded Svelte source, as a
      // component module beside it (relative imports keep their meaning).
      if (preprocessExtensions.length && !specifier.startsWith('\0')) {
        const r = await this.resolve(specifier, importer, { skipSelf: true });
        return preprocessedId(r?.id);
      }
      return undefined;
    },
    load(id) {
      const file = id.split('?')[0];
      if (preprocessExtensions.some(e => file.endsWith(e + '.svelte'))) {
        const source = file.slice(0, -'.svelte'.length);
        const generated = preprocessed(root, config, relOf(source));
        if (!generated)
          kitFail(
            'E_GENERATED',
            `${relOf(source)} has no preprocessed output (runic.json generate)`,
            at(relOf(source)),
          );
        return readFileSync(generated.path, 'utf8');
      }
      return virtual.get(file);
    },
  };

  return {
    version: KIT_VERSION,
    entry: path.join(generated, 'entry.ts'),
    plugin,
    /** The diagnostic the plugin raised, if any. */
    failure: () => failure.diagnostic,
    html,
    generated,
    hash: options.routerType === 'hash',
    /** Universal route modules (+page.ts/+layout.ts) and the route components. */
    routeModules: new Set(nodes.filter(n => n.universal).map(n => path.join(root, n.universal))),
    routeComponents: new Set(nodes.map(n => n.component)),
    /** The generated TypeScript modules (`$types` and others imported for types only are not collected). */
    typeFiles: new Map([...virtual].filter(([f]) => f.endsWith('.ts'))),
    /** Resolution of the `$types` modules' imports for the type checker. */
    resolveType: (specifier, from) => {
      const v = resolveVirtual(specifier, from);
      if (typeof v === 'string') return v;
      if (from.startsWith(typesDir + path.sep) && specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(from), specifier);
        if (virtual.has(target)) return target;
      }
      // Kit's aliases in modules imported for types only (server modules,
      // whose data types the generated app module reads): the file the alias
      // names, a script module with a declaration file beside it by the
      // declarations (as TypeScript resolves it).
      for (const [find, target] of Object.entries(aliases)) {
        const base = find.replace(/\/\*$/, '');
        if (specifier !== base && !specifier.startsWith(base + '/')) continue;
        const p = path.join(root, target.replace(/\/\*$/, '')) + specifier.slice(base.length);
        for (const c of [
          p.replace(/\.m?js$/, '.d.ts'),
          p.replace(/\.js$/, '.ts'),
          p,
          p + '.ts',
          path.join(p, 'index.ts'),
        ])
          if (existsSync(c) && !statSync(c).isDirectory()) return c;
      }
      return undefined;
    },
    notes: options.notes,
    /** The strings of the build-time data (`{@html}` may show them, frontend/html-fragments.ts). */
    htmlStrings: tableStrings(server),
  };
}

/** The string values of the server data tables and the endpoint responses (JSON bodies parsed). */
function tableStrings(server) {
  const out = new Set();
  const walk = v => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const node of Object.values(server.nodes)) for (const row of node.table) walk(row.data);
  for (const r of Object.values(server.fetch)) {
    let body = r.body;
    try {
      if (/json/.test(r.type)) body = JSON.parse(r.body);
    } catch {}
    walk(body);
  }
  return [...out].sort();
}
