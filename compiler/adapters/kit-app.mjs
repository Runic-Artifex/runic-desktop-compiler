// A SvelteKit app as the collector sees it (compiler/adapters/kit.mjs): the
// generated modules (virtual files under `<app>/.svelte-kit/runic/`), the
// Vite plugin that provides them and Kit's aliases, the app.html
// attributes, and what the Svelte adapter checks in the app's code.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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
} from './kit.mjs';
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
  const options = readSvelteConfig(root);
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
  for (const route of manifest.routes)
    if (route.endpoint)
      kitFail(
        'E_KIT_SERVER',
        `Endpoints (+server) are unsupported in this step (${route.id})`,
        at(relOf(route.endpoint.file)),
      );
  for (const node of manifest.nodes)
    if (node.server)
      kitFail(
        'E_KIT_SERVER',
        'Server load functions (+page.server, +layout.server) are unsupported in this step (build-time server data is a later step)',
        at(relOf(node.server)),
      );

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
      load: universal ? routeModule(root, universal).load : false,
      props,
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

  const plugin = {
    name: 'runic-sveltekit',
    enforce: 'pre',
    async resolveId(specifier, importer) {
      const v = resolveVirtual(specifier, importer?.split('?')[0]);
      if (typeof v === 'string') return v;
      if (v?.error)
        throw new Diagnostic(
          'E_KIT_IMPORT',
          v.error,
          importer ? at(path.relative(root, importer)) : undefined,
        );
      for (const [find, target] of Object.entries(aliases)) {
        const base = find.replace(/\/\*$/, '');
        if (specifier === base || specifier.startsWith(base + '/')) {
          const replaced =
            path.join(root, target.replace(/\/\*$/, '')) + specifier.slice(base.length);
          const r = await this.resolve(replaced, importer, { skipSelf: true });
          return r ?? replaced;
        }
      }
      return undefined;
    },
    load(id) {
      return virtual.get(id.split('?')[0]);
    },
  };

  return {
    version: KIT_VERSION,
    entry: path.join(generated, 'entry.ts'),
    plugin,
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
      return undefined;
    },
    notes: options.notes,
  };
}
