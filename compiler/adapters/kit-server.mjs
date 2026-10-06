// The server phase of `runic generate` for a SvelteKit app
// (docs/design/M6-SVELTEKIT.md, phase 2): the app's server loads and
// prerendered endpoints evaluated in Node, as Kit's prerender evaluates
// them, into the data tables the native app reads.
//
// For every page route that is prerendered, once per entry (`entries()` of
// its page modules, or the route itself without parameters):
//  - each level's server load (`+layout.server`, `+page.server`) runs with
//    Kit's request event (no cookies: prerendering has none); what it reads
//    (params, url, route, parent) is recorded, as Kit records it;
//  - each level's universal load runs as in Kit's server rendering, with
//    `browser` false, only for the URLs it fetches (Kit's crawl);
//  - a fetch of a same-origin endpoint calls the prerendered endpoint's
//    handler; its response is recorded by URL.
// Endpoints' own `entries()` add their URLs. The modules run through the
// compiler's Vite (the app's aliases; never the app's vite.config), and a
// markdown page runs as its recorded preprocessed source.
//
//   node compiler/adapters/kit-server.mjs <app> <out.json>
// On a diagnostic, the last line of stdout is its JSON.
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Diagnostic } from '../collect.mjs';
import { at, manifestOf, readSvelteConfig } from './kit.mjs';
import { preprocessed } from '../generate.mjs';

const [root, out] = process.argv.slice(2);
const runic = JSON.parse(readFileSync(path.join(root, 'runic.json'), 'utf8'));
const rel = f => path.relative(root, path.resolve(root, f)).split(path.sep).join('/');
const fail = (code, message, file) => {
  throw new Diagnostic(code, message, at(file ? rel(file) : 'src/routes'));
};
const ORIGIN = 'http://sveltekit-prerender';

async function main() {
  const options = readSvelteConfig(root, runic);
  const { manifest, dir: kitDir } = await manifestOf(root, options);
  const routing = await import(pathToFileURL(path.join(kitDir, 'src/utils/routing.js')).href);
  const require = createRequire(path.join(root, 'runic.json'));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { svelte } = await import(
    pathToFileURL(require.resolve('@sveltejs/vite-plugin-svelte')).href
  );

  const aliases = { $lib: 'src/lib', ...options.aliases };
  // `$app/environment` as Kit's server rendering has it while prerendering.
  const APP = {
    '$app/environment':
      'export const browser = false; export const dev = false; export const building = true; export const version = "";',
  };
  const plugin = {
    name: 'runic-kit-server',
    enforce: 'pre',
    async resolveId(specifier, importer) {
      if (APP[specifier]) return '\0' + specifier;
      if (/^\$app\//.test(specifier) || /^\$env\//.test(specifier))
        throw new Error(`${specifier} is unsupported in server code at generation`);
      for (const [find, target] of Object.entries(aliases)) {
        const base = find.replace(/\/\*$/, '');
        if (specifier === base || specifier.startsWith(base + '/')) {
          const replaced =
            path.join(root, target.replace(/\/\*$/, '')) + specifier.slice(base.length);
          return (await this.resolve(replaced, importer, { skipSelf: true })) ?? replaced;
        }
      }
      // A preprocessed file (markdown) runs as its recorded Svelte source.
      const r = await this.resolve(specifier, importer, { skipSelf: true });
      const file = r?.id?.split('?')[0];
      if (
        file &&
        file.startsWith(root + path.sep) &&
        options.extensions.some(e => e !== '.svelte' && file.endsWith(e))
      )
        return file + '.svelte';
      return undefined;
    },
    load(id) {
      if (id.startsWith('\0$app/')) return APP[id.slice(1)];
      if (
        id.endsWith('.svelte') &&
        options.extensions.some(e => e !== '.svelte' && id.endsWith(e + '.svelte'))
      ) {
        const source = id.slice(0, -'.svelte'.length);
        const generated = preprocessed(root, runic, rel(source));
        if (!generated)
          throw new Error(`${rel(source)} has no preprocessed output: run its generation step`);
        return readFileSync(generated.path, 'utf8');
      }
      return undefined;
    },
  };
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'runic-kit-server-'));
  const server = await createServer({
    root,
    configFile: false,
    // Vite's dependency cache stays out of the app (Tailwind would scan it).
    cacheDir,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    plugins: [plugin, svelte({ configFile: false, compilerOptions: { runes: true, dev: false } })],
  });
  const load = async file => server.ssrLoadModule(path.resolve(root, file));
  const modules = new Map();
  const moduleOf = async file => {
    if (!file) return undefined;
    if (!modules.has(file)) {
      try {
        modules.set(file, await load(file));
      } catch (e) {
        if (e instanceof Diagnostic) throw e;
        fail('E_KIT_SERVER', `${rel(file)} cannot be evaluated at generation: ${e.message}`, file);
      }
    }
    return modules.get(file);
  };
  const matchers = {};
  for (const [name, file] of Object.entries(manifest.matchers))
    matchers[name] = (await moduleOf(file)).match;

  const fetchTable = {};
  const nodeTables = new Map();
  const routesOut = [];

  // Endpoints by route, for fetches.
  const endpoints = manifest.routes.filter(r => r.endpoint);
  async function endpointResponse(url, from) {
    const route = endpoints.find(r => r.pattern.test(url.pathname));
    if (!route)
      fail(
        'E_KIT_FETCH',
        `A load fetches ${url.pathname}, which is not an endpoint of the app (only prerendered endpoints become build-time data)`,
        from,
      );
    const match = route.pattern.exec(url.pathname);
    const params = routing.exec(match, route.params, matchers);
    if (!params)
      fail('E_KIT_FETCH', `${url.pathname} does not match ${route.id}'s parameters`, from);
    const mod = await moduleOf(route.endpoint.file);
    if (mod.prerender !== true)
      fail(
        'E_KIT_SERVER',
        `The endpoint ${route.id} is fetched by a load but not prerendered (export const prerender = true): the native app has no server`,
        route.endpoint.file,
      );
    const handler = mod.GET ?? mod.fallback;
    if (!handler)
      fail('E_KIT_SERVER', `The endpoint ${route.id} has no GET handler`, route.endpoint.file);
    const request = new Request(url);
    const response = await handler(requestEvent(url, params, route.id, request));
    const body = await response.text();
    return { status: response.status, type: response.headers.get('content-type') ?? '', body };
  }
  function requestEvent(url, params, id, request) {
    return {
      params,
      url,
      route: { id },
      request,
      locals: {},
      platform: undefined,
      isDataRequest: false,
      isSubRequest: false,
      cookies: {
        get: () => undefined,
        getAll: () => [],
        set() {
          throw new Error('Cookies cannot be set while prerendering');
        },
        delete() {
          throw new Error('Cookies cannot be set while prerendering');
        },
        serialize() {
          throw new Error('Cookies cannot be set while prerendering');
        },
      },
      fetch: recordingFetch(url, id),
      getClientAddress() {
        throw new Error('No client address while prerendering');
      },
      setHeaders() {},
      depends() {},
      untrack: fn => fn(),
    };
  }
  function recordingFetch(base, from) {
    return async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, base);
      if (url.origin !== ORIGIN)
        fail(
          'E_KIT_FETCH',
          `A load fetches ${url.href}: only same-origin endpoints are build-time data (the native app makes no network requests)`,
          from,
        );
      if ((init?.method ?? 'GET') !== 'GET')
        fail(
          'E_KIT_FETCH',
          `A load fetches ${url.pathname} with ${init.method}: only GET requests of prerendered endpoints are supported`,
          from,
        );
      const key = url.pathname + url.search;
      if (!fetchTable[key]) fetchTable[key] = await endpointResponse(url, from);
      const r = fetchTable[key];
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.type } });
    };
  }

  /** A value Kit could serialise that the data tables hold: JSON values only. */
  function checkData(value, file, where = 'data') {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0))
        fail(
          'E_KIT_SERVER',
          `Server data ${where} is ${value}: only JSON values are supported as build-time data`,
          file,
        );
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => checkData(v, file, `${where}[${i}]`));
      return;
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined)
          fail(
            'E_KIT_SERVER',
            `Server data ${where}.${k} is undefined: only JSON values are supported as build-time data`,
            file,
          );
        checkData(v, file, `${where}.${k}`);
      }
      return;
    }
    fail(
      'E_KIT_SERVER',
      `Server data ${where} is not a plain JSON value (${Object.prototype.toString.call(value)})`,
      file,
    );
  }

  /** A trackable event's url, params and route (Kit's make_trackable), recording `uses`. */
  function tracked(url, params, id, uses) {
    const urlProxy = new Proxy(url, {
      get(target, key) {
        if (key === 'searchParams')
          return new Proxy(target.searchParams, {
            get(sp, k) {
              const v = sp[k];
              if (['get', 'getAll', 'has'].includes(k))
                return name => (uses.search_params.add(name), v.call(sp, name));
              uses.url = true;
              return typeof v === 'function' ? v.bind(sp) : v;
            },
          });
        if (key === 'hash') throw new Error('Cannot access event.url.hash on the server');
        uses.url = true;
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const paramsProxy = new Proxy(params, {
      get(target, key) {
        if (typeof key === 'string') uses.params.add(key);
        return target[key];
      },
    });
    const route = {
      get id() {
        uses.route = true;
        return id;
      },
    };
    return { url: urlProxy, params: paramsProxy, route };
  }

  for (const route of manifest.routes.filter(r => r.page)) {
    const nodeIndices = [...route.page.layouts, route.page.leaf];
    const nodes = nodeIndices.map(i => (i === undefined ? undefined : manifest.nodes[i]));
    // Page options: each level's universal option over its server one, inner over outer.
    let prerender = false;
    const universals = [];
    const servers = [];
    for (const node of nodes) {
      const universal = await moduleOf(node?.universal);
      const srv = await moduleOf(node?.server);
      universals.push(universal);
      servers.push(srv);
      const option = universal?.prerender ?? srv?.prerender;
      if (option !== undefined) prerender = option;
    }
    const serverNodes = nodes.filter(n => n?.server);
    if (prerender !== true) {
      const withLoad = serverNodes.find((n, i) => servers[nodes.indexOf(n)]?.load);
      if (withLoad)
        fail(
          'E_KIT_SERVER',
          `The route ${route.id} has a server load but is not prerendered (export const prerender = true): the native app has no server`,
          withLoad.server,
        );
      continue;
    }
    const leaf = nodes.at(-1);
    let entries;
    if (route.params.length) {
      const fn = universals.at(-1)?.entries ?? servers.at(-1)?.entries;
      if (!fn) {
        if (serverNodes.length)
          fail(
            'E_KIT_SERVER',
            `The prerendered route ${route.id} has parameters and server code but no entries(): its server data cannot be generated (Kit's link crawl is not modelled)`,
            leaf.server ?? leaf.universal ?? leaf.component,
          );
        continue;
      }
      entries = await fn();
    } else entries = [{}];
    const done = [];
    for (const params of entries) {
      let pathname;
      try {
        pathname = routing.resolve_route(route.id, params);
      } catch (e) {
        fail(
          'E_KIT_SERVER',
          `entries() of ${route.id} gives ${JSON.stringify(params)}: ${e.message}`,
          leaf.server ?? leaf.universal,
        );
      }
      const url = new URL(pathname, ORIGIN);
      // Kit's own matching gives the decoded parameters the loads see.
      const decoded = routing.exec(route.pattern.exec(url.pathname), route.params, matchers);
      if (!decoded)
        fail(
          'E_KIT_SERVER',
          `${pathname} (an entry of ${route.id}) does not match its route`,
          leaf.server ?? leaf.universal,
        );
      done.push({ path: pathname, params: decoded });
      const serverData = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const load = servers[i]?.load;
        if (!node || !load) {
          serverData.push(null);
          continue;
        }
        const uses = {
          params: new Set(),
          url: false,
          route: false,
          parent: false,
          search_params: new Set(),
        };
        const t = tracked(new URL(url), { ...decoded }, route.id, uses);
        const event = {
          ...requestEvent(new URL(url), decoded, route.id, new Request(url)),
          ...t,
          parent: async () => {
            uses.parent = true;
            const merged = {};
            for (let j = 0; j < i; j++) Object.assign(merged, serverData[j] ?? {});
            return merged;
          },
        };
        let data;
        try {
          data = (await load(event)) ?? null;
        } catch (e) {
          if (e instanceof Diagnostic) throw e;
          fail(
            'E_KIT_SERVER',
            `The server load of ${route.id} failed at generation for ${pathname}: ${e?.body?.message ?? e.message}`,
            node.server,
          );
        }
        checkData(data, node.server);
        serverData.push(data);
        const file = rel(node.server);
        if (!nodeTables.has(file)) nodeTables.set(file, []);
        nodeTables.get(file).push({
          path: pathname,
          route: route.id,
          params: decoded,
          search: url.search,
          uses: {
            params: [...uses.params].sort(),
            url: uses.url,
            route: uses.route,
            parent: uses.parent,
            search_params: [...uses.search_params].sort(),
          },
          data,
        });
      }
      // The universal loads, for the URLs they fetch (Kit's crawl).
      const universalData = [];
      for (let i = 0; i < nodes.length; i++) {
        const load = universals[i]?.load;
        if (!load) {
          universalData.push(serverData[i]);
          continue;
        }
        const uses = {
          params: new Set(),
          url: false,
          route: false,
          parent: false,
          search_params: new Set(),
        };
        const event = {
          ...tracked(new URL(url), { ...decoded }, route.id, uses),
          data: serverData[i],
          parent: async () => {
            const merged = {};
            for (let j = 0; j < i; j++) Object.assign(merged, universalData[j] ?? {});
            return merged;
          },
          fetch: recordingFetch(url, nodes[i].universal),
          setHeaders() {},
          depends() {},
          untrack: fn => fn(),
        };
        try {
          universalData.push((await load(event)) ?? null);
        } catch (e) {
          if (e instanceof Diagnostic) throw e;
          // error() and redirect() (Kit's HttpError and Redirect): the page is not prerendered.
          if (e && typeof e.status === 'number' && ('body' in e || 'location' in e)) {
            universalData.push(null);
            break;
          }
          fail(
            'E_KIT_SERVER',
            `The load of ${route.id} failed at generation for ${pathname}: ${e.message}`,
            nodes[i].universal,
          );
        }
      }
    }
    routesOut.push({ id: route.id, entries: done });
  }
  // Endpoints' own entries.
  for (const route of endpoints) {
    const mod = await moduleOf(route.endpoint.file);
    if (mod.prerender !== true || typeof mod.entries !== 'function') continue;
    for (const params of await mod.entries()) {
      const url = new URL(routing.resolve_route(route.id, params), ORIGIN);
      const key = url.pathname;
      if (!fetchTable[key]) fetchTable[key] = await endpointResponse(url, route.endpoint.file);
    }
  }
  await server.close();
  rmSync(cacheDir, { recursive: true, force: true });
  // Server nodes: each table by the parameters, url parts, route and parent
  // its load read in any entry (one data value per key).
  const nodesOut = {};
  for (const [file, rows] of nodeTables) {
    const uses = {
      params: new Set(),
      url: false,
      route: false,
      parent: false,
      search_params: new Set(),
    };
    for (const r of rows) {
      r.uses.params.forEach(p => uses.params.add(p));
      uses.url ||= r.uses.url;
      uses.route ||= r.uses.route;
      uses.parent ||= r.uses.parent;
      r.uses.search_params.forEach(p => uses.search_params.add(p));
    }
    const keyOf = r =>
      JSON.stringify({
        params: [...uses.params].sort().map(p => r.params[p] ?? null),
        path: uses.url || uses.parent ? r.path + r.search : null,
        route: uses.route || uses.parent ? r.route : null,
        search: [...uses.search_params].sort().map(n => new URLSearchParams(r.search).getAll(n)),
      });
    const table = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      const text = JSON.stringify(r.data);
      if (table.has(key) && JSON.stringify(table.get(key).data) !== text)
        fail(
          'E_KIT_SERVER',
          `The server load gives different data for the same inputs (${key}): build-time data must be deterministic`,
          file,
        );
      table.set(key, { key: JSON.parse(key), data: r.data });
    }
    nodesOut[file] = {
      uses: {
        params: [...uses.params].sort(),
        url: uses.url,
        route: uses.route,
        parent: uses.parent,
        search_params: [...uses.search_params].sort(),
      },
      table: [...table.values()],
    };
  }
  mkdirSync(path.dirname(out), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(fetchTable).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    out,
    JSON.stringify({ format: 1, routes: routesOut, nodes: nodesOut, fetch: sorted }, null, 2) +
      '\n',
  );
}

main().then(
  () => process.exit(0),
  e => {
    if (e instanceof Diagnostic) console.log(JSON.stringify(e.toJSON()));
    else console.error(e?.stack ?? e);
    process.exit(1);
  },
);
