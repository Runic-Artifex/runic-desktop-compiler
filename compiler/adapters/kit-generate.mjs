// The generated modules of a SvelteKit app (compiler/adapters/kit.mjs):
// TypeScript and Svelte source the Svelte adapter compiles with the app.
//
//  - params.ts: the app's route parameters (`Params`) and their tracked
//    reads in loads (`LoadParams`);
//  - app.ts: per route, Kit's `load_route` and `get_navigation_result_from_branch`
//    specialised to the route's levels (client.js), with each level's data
//    typed by its load; the root error page; registration with the router;
//  - tree.svelte.ts: the composition the root renders (per depth, the
//    component's place in the route trie) and each level's data;
//  - Root.svelte: Kit's root (root.svelte as Kit 2.70.1 writes it, with the
//    pyramid of dynamic components unrolled into the route trie) and its
//    live-region announcer; App.svelte: Kit creates its root once the first
//    navigation has loaded; entry.ts mounts it;
//  - types/<route dir>/$types.ts: `PageData`, `PageProps`, `PageLoad`, … .
import path from 'node:path';

const js = s => JSON.stringify(s);

/** A JSON value as a TypeScript literal (identifier keys where they are names). */
function literal(value, indent = '') {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = indent + '  ';
  if (Array.isArray(value))
    return value.length
      ? `[\n${value.map(v => inner + literal(v, inner)).join(',\n')},\n${indent}]`
      : '[]';
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  const key = k => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  return `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${literal(v, inner)}`).join(',\n')},\n${indent}}`;
}

/** A RegExp literal of `pattern`. */
const regexLiteral = pattern => `/${pattern.source}/${pattern.flags}`;

export function generate(m) {
  const files = new Map();
  const { nodes, routes, trie, variants, rootError, maxDepth, paramNames, matchers } = m;
  const dataType = t => `Data_t${t}`;
  const parentData = t => (trie[t].parent < 0 ? 'Empty' : dataType(trie[t].parent));
  const own = n => `Own_${n}`;
  // A level's record: its data and what its load read (Branch_n), what a
  // load without data read (LoadOnly), or nothing (NoLoad). A level with a
  // server load (build-time data, compiler/adapters/kit-server.mjs) has data
  // (its universal load's, else the server's) and its server node.
  const hasServer = n => !!nodes[n].server;
  const hasUniversalData = n => nodes[n].load && nodes[n].data;
  const hasData = n => hasUniversalData(n) || hasServer(n);
  const branchType = n => (hasData(n) ? `Branch_${n}` : nodes[n].load ? 'LoadOnly' : 'NoLoad');
  // A level's `params` in its load: Kit's tracked proxy over the route's
  // parameters, `string` where every route reaching the level has the
  // parameter (rest parameters included), else possibly undefined.
  const loadParams = node => {
    const n = node.index;
    const reaching = routes.filter(r => r.leaf === n || r.layouts.includes(n));
    const names = [];
    for (const r of reaching)
      for (const p of r.params) if (!names.includes(p.name)) names.push(p.name);
    const required = name =>
      reaching.length > 0 &&
      reaching.every(r => r.params.some(p => p.name === name && (!p.optional || p.rest)));
    return `/** The \`params\` of ${node.universal}'s load: reads are dependencies (Kit's Proxy). */
export class LoadParams_${n} {
  #params: Params;
  #uses: Uses;

  constructor(params: Params, uses: Uses) {
    this.#params = params;
    this.#uses = uses;
  }
${names
  .map(p =>
    required(p)
      ? `
  get ${p}(): string {
    this.#uses.params.add(${js(p)});
    return present(this.#params.${p});
  }`
      : `
  get ${p}(): string | undefined {
    this.#uses.params.add(${js(p)});
    return this.#params.${p};
  }`,
  )
  .join('\n')}
}
`;
  };
  // A server load's build-time data (compiler/adapters/kit-server.mjs): a
  // table by what its load read; each lookup gives new objects, as each
  // response Kit parses does.
  const serverDecls = node => {
    const n = node.index;
    const s = node.server;
    const conds = key => {
      const out = [];
      s.uses.params.forEach((p, i) =>
        out.push(
          `intent.params.get(${js(p)}) === ${key.params[i] === null ? 'undefined' : js(key.params[i])}`,
        ),
      );
      if (key.path !== null)
        out.push(`intent.url.pathname + intent.url.search === ${js(key.path)}`);
      if (key.route !== null) out.push(`intent.route_id === ${js(key.route)}`);
      s.uses.search_params.forEach((name, i) =>
        out.push(
          `intent.url.searchParams.getAll(${js(name)}).join('\\u0000') === ${js(key.search[i].join('\u0000'))}`,
        ),
      );
      return out.length ? out.join(' && ') : 'true';
    };
    const uses = [
      ...s.uses.params.map(p => `    uses.params.add(${js(p)});`),
      ...(s.uses.url ? ['    uses.url = true;'] : []),
      ...(s.uses.route ? ['    uses.route = true;'] : []),
      ...(s.uses.parent ? ['    uses.parent = true;'] : []),
      ...s.uses.search_params.map(p => `    uses.search_params.add(${js(p)});`),
    ];
    return `
export type ServerData_${n} = Awaited<ReturnType<typeof server_load_${n}>>;

/** A server data node of ${s.rel}: its data and what its server load read (generation). */
export class ServerNode_${n} {
  data: ServerData_${n};
  uses: Uses;

  constructor(data: ServerData_${n}) {
    this.data = data;
    const uses = new Uses();
${uses.join('\n')}
    this.uses = uses;
  }
}

/** The build-time data of ${s.rel} for a navigation (runic generate). */
function server_data_${n}(intent: Intent): ServerData_${n} {
${s.table.map(r => `  if (${conds(r.key)}) return ${literal(r.data, '  ')};`).join('\n')}
  __runic.unsupported(\`the server data of ${s.rel} for \${intent.url.pathname}, which generation did not evaluate (not an entry of a prerendered route)\`);
  throw new Error('No server data');
}
`;
  };
  // The trie node of each layout and page (their chains are fixed).
  const nodeTrie = new Map();
  for (const t of trie) if (!nodeTrie.has(t.node)) nodeTrie.set(t.node, t.id);

  // --- params.ts ---
  files.set(
    'params.ts',
    `// Generated by the compiler from the route manifest: the app's route parameters.
import type { Uses } from './load.ts';

/** A route's parameters (\`page.params\`, \`params\` props): every parameter of the app, undefined where the route has none. */
export class Params {
${paramNames.map(p => `  readonly ${p}: string | undefined;`).join('\n')}

  constructor(${paramNames.map(p => `${p}?: string`).join(', ')}) {
${paramNames.map(p => `    this.${p} = ${p};`).join('\n')}
  }

  get(name: string): string | undefined {
${paramNames.map(p => `    if (name === ${js(p)}) return this.${p};`).join('\n')}
    return undefined;
  }
}

/** A load function's \`params\`: reads are dependencies (Kit's Proxy). */
export class LoadParams {
  #params: Params;
  #uses: Uses;

  constructor(params: Params, uses: Uses) {
    this.#params = params;
    this.#uses = uses;
  }
${paramNames
  .map(
    p => `
  get ${p}(): string | undefined {
    this.#uses.params.add(${js(p)});
    return this.#params.${p};
  }`,
  )
  .join('\n')}
}
`,
  );

  // --- app.ts ---
  const imports = [];
  for (const node of nodes)
    if (node.load) {
      imports.push(`import { load as load_${node.index} } from ${js(node.universalImport)};`);
    }
  for (const node of nodes)
    if (node.server)
      imports.push(
        `import type { load as server_load_${node.index} } from ${js(node.server.import)};`,
      );
  for (const x of matchers)
    imports.push(`import { match as match_${x.name} } from ${js(x.import)};`);
  if (m.hooksClient) imports.push(`import { handleError } from ${js(m.hooksClient)};`);

  let decls = '';
  for (const node of nodes) {
    if (hasServer(node.index)) decls += serverDecls(node);
    if (hasUniversalData(node.index))
      decls += `export type ${own(node.index)} = Awaited<ReturnType<typeof load_${node.index}>>;\n`;
    else if (hasServer(node.index))
      decls += `export type ${own(node.index)} = ServerData_${node.index};\n`;
  }
  for (const t of trie) {
    const node = nodes[t.node];
    const withData = hasData(node.index);
    decls += withData
      ? `export function merge_t${t.id}(parent: ${parentData(t.id)}, own: ${own(t.node)}) {\n  return { ...parent, ...own };\n}\n`
      : `export function merge_t${t.id}(parent: ${parentData(t.id)}) {\n  return { ...parent };\n}\n`;
    decls += `export type ${dataType(t.id)} = ReturnType<typeof merge_t${t.id}>;\n`;
  }
  for (const node of nodes) {
    const n = node.index;
    const t = nodeTrie.get(n);
    const server = hasServer(n);
    if (node.load)
      decls += `
${loadParams(node)}
/** The load event of ${node.universal}. */
export class LoadEvent_${n} {
  readonly params: LoadParams_${n};
  readonly url: LoadURL;
  readonly route: LoadRoute;
  readonly parent: () => Promise<${parentData(t)}>;
  readonly fetch: (input: string) => Promise<KitResponse>;
${server ? `  readonly data: ServerData_${n};\n` : ''}
  constructor(intent: Intent, uses: Uses, parent: () => Promise<${parentData(t)}>${server ? `, server: ServerNode_${n}` : ''}) {
    this.params = new LoadParams_${n}(intent.params, uses);
    this.url = new LoadURL(intent.url, uses, HASH);
    this.route = new LoadRoute(intent.route_id, uses);
    this.parent = () => {
      uses.parent = true;
      return parent();
    };
    this.fetch = (input: string) => kit_fetch(input, intent.url);
${server ? '    this.data = server.data;\n' : ''}  }
}
`;
    if (hasData(n))
      decls += `
/** A level of ${node.universal ?? node.server.rel}: its data, what its universal load read${server ? ' and its server node' : ''}. */
export class Branch_${n} {
  data: ${own(n)};
  uses: Uses | undefined;
${server ? `  server: ServerNode_${n};\n` : ''}
  constructor(data: ${own(n)}, uses: Uses | undefined${server ? `, server: ServerNode_${n}` : ''}) {
    this.data = data;
    this.uses = uses;
${server ? '    this.server = server;\n' : ''}  }
}
`;
    const args = [
      ...(node.load ? ['intent: Intent', `parent: () => Promise<${parentData(t)}>`] : []),
      ...(server ? [`server: ServerNode_${n}`] : []),
    ].join(', ');
    const event = `new LoadEvent_${n}(intent, uses, parent${server ? ', server' : ''})`;
    if (node.load && hasUniversalData(n))
      decls += `
async function load_node_${n}(${args}): Promise<Branch_${n}> {
  const uses = new Uses();
  await node_loader();
  const event = ${event};
  const data = await load_${n}(event);
  return new Branch_${n}(data, uses${server ? ', server' : ''});
}
`;
    else if (node.load && server)
      decls += `
/** A level of ${node.universal} whose universal load gives no data: the server's (Kit: data ?? server data). */
async function load_node_${n}(${args}): Promise<Branch_${n}> {
  const uses = new Uses();
  await node_loader();
  const event = ${event};
  await load_${n}(event);
  return new Branch_${n}(server.data, uses, server);
}
`;
    else if (node.load)
      decls += `
/** A level of ${node.universal}, whose load gives no data (Kit: data null). */
async function load_node_${n}(${args}): Promise<LoadOnly> {
  const uses = new Uses();
  await node_loader();
  const event = ${event};
  await load_${n}(event);
  return new LoadOnly(uses);
}
`;
    else if (server)
      decls += `
/** A level with a server load only: its data is the server's. */
async function load_node_${n}(${args}): Promise<Branch_${n}> {
  await node_loader();
  return new Branch_${n}(server.data, undefined, server);
}
`;
    // Nodes without a load (layouts, pages; error pages never run as levels).
    else if (nodeTrie.has(n))
      decls += `
async function load_node_${n}(): Promise<NoLoad> {
  await node_loader();
  return new NoLoad();
}
`;
  }

  // The previous level records (`current.branch`), by node.
  const recordNodes = nodes.filter(n => nodeTrie.has(n.index) && !n.errorOnly);
  decls += `
/** \`current.branch\`: per level absent, without data or with data, and its node and record. */
class Current {
  kinds: number[] = [];
  nodes: number[] = [];
${recordNodes.map(n => `  p${n.index}: ${branchType(n.index)} | undefined = undefined;`).join('\n')}
}
const cur = new Current();
`;

  /**
   * get_navigation_result_from_branch for a branch: `entries` are its
   * present levels in order ({ index, node, local, kind }: kind 'data' (a
   * node with a load), 'null' (without), 'error' (an error page: data
   * `{}`), 'empty' (the root error page of load_root_error_page: no data)).
   */
  const resultFunction = (name, entries, trieIds, routeId, hasRoute) => {
    const length = entries.length ? entries.at(-1).index + 1 : 0;
    const args = entries.filter(e => e.local).map(e => `${e.local}: ${branchType(e.node)}`);
    let body =
      '  const url = normalised_url(intent_url);\n  if (intent) intent.url = url;\n  let dc = false;\n';
    let p = 0;
    let parentExpr = '{}';
    const assigns = [];
    for (let i = 0; i < length; i++) {
      const e = entries.find(x => x.index === i);
      if (!e) {
        body += `  if (cur.kinds.length > ${i} && cur.kinds[${i}] !== ABSENT) dc = true;\n`;
        continue;
      }
      if (e.kind === 'data')
        body += `  if (!(cur.nodes.length > ${i} && cur.nodes[${i}] === ${e.node} && cur.kinds[${i}] === DATA && cur.p${e.node} !== undefined && cur.p${e.node}.data === ${e.local}.data)) dc = true;\n`;
      else if (e.kind === 'error') body += '  dc = true;\n';
      else body += `  if (!(cur.kinds.length > ${i} && cur.kinds[${i}] === NULL)) dc = true;\n`;
      const t = trieIds[p];
      body +=
        e.kind === 'data'
          ? `  const m${p} = merge_t${t}(${parentExpr}, ${e.local}.data);\n`
          : `  const m${p} = merge_t${t}(${parentExpr});\n`;
      body += `  const set${p} = dc;\n`;
      assigns.push({ p, t });
      parentExpr = `m${p}`;
      p += 1;
    }
    body += `  if (trailing_changed(${length})) dc = true;\n`;
    body += `  const changed = page_changed(url, error, dc);\n`;
    body += `  const page_value = result_page(changed, url, params, ${routeId}, status, error);\n`;
    const kinds = [];
    const nodeIds = [];
    for (let i = 0; i < length; i++) {
      const e = entries.find(x => x.index === i);
      kinds.push(!e ? 'ABSENT' : e.kind === 'data' || e.kind === 'error' ? 'DATA' : 'NULL');
      nodeIds.push(!e ? -1 : e.node);
    }
    const adopt = entries.filter(e => e.local).map(e => `      cur.p${e.node} = ${e.local};`);
    const data = assigns.map(
      a => `      if (set${a.p} || previous[${a.p}] !== ${a.t}) tree.d${a.t} = m${a.p};`,
    );
    const depths = Array.from(
      { length: maxDepth },
      (_, d) => `      tree.n${d} = ${d < trieIds.length ? trieIds[d] : -1};`,
    );
    return `
async function ${name}(intent: Intent | undefined, intent_url: KitURL, params: Params, ${args.map(a => a + ', ').join('')}status: number, error: KitError | null): Promise<NavResult> {
${body}  return new NavResult(
    url,
    params,
    ${hasRoute},
    ${routeId},
    error,
    page_value,
    () => {
      cur.kinds = [${kinds.join(', ')}];
      cur.nodes = [${nodeIds.join(', ')}];
${adopt.join('\n')}
    },
    () => {
      const previous: number[] = [${Array.from({ length: maxDepth }, (_, d) => `tree.n${d}`).join(', ')}];
${data.join('\n')}
${depths.join('\n')}
      tree.version += 1;
    },
  );
}
`;
  };

  let results = '';
  let loadRoutes = '';
  for (const v of variants.filter(x => x.kind === 'route')) {
    const r = v.route;
    const routeId = js(r.id);
    const loaders = v.loaders;
    const entry = (n, i) => ({
      index: i,
      node: n,
      local: `b${i}`,
      kind: hasData(n) ? 'data' : 'null',
    });
    const entries = loaders
      .map((n, i) => (n === undefined ? undefined : entry(n, i)))
      .filter(Boolean);
    results += resultFunction(`result_r${r.index}`, entries, v.trie, routeId, true);
    const errorVariants = variants.filter(x => x.kind === 'error' && x.route === r);
    for (const ev of errorVariants)
      results += resultFunction(
        `result_r${r.index}_e${ev.level}`,
        [
          ...ev.kept.map(x => entry(x.n, x.i)),
          { index: ev.idx, node: ev.errorNode, kind: 'error' },
        ],
        ev.trie,
        routeId,
        true,
      );
    let body = '';
    // client.js first preloads the modules (`loader().catch(noop)`) and
    // marks each level's promise handled (`p.catch(noop)`): promise chains
    // nothing waits for, whose jobs do not reorder any other job, so they
    // are left out.
    body += '  const ctx = new LoadContext(intent);\n  let parent_changed = false;\n';
    // Server data (Kit's `invalid_server_nodes` and `load_data`): a level
    // whose server load is new or read what changed gets new data.
    const serverLevels = loaders
      .map((n, i) => ({ n, i }))
      .filter(x => x.n !== undefined && hasServer(x.n));
    if (serverLevels.length) {
      body += '  let parent_invalid = false;\n';
      for (const { n, i } of serverLevels)
        body += `  const prev_s${i} = cur.nodes.length > ${i} && cur.nodes[${i}] === ${n} ? cur.p${n} : undefined;
  const inv${i} = prev_s${i} === undefined || ctx.has_changed(parent_invalid, prev_s${i}.server.uses);
  if (inv${i}) parent_invalid = true;
  let sd${i}: ServerNode_${n} | undefined = undefined;
`;
      body += `  if (${serverLevels.map(x => `inv${x.i}`).join(' || ')}) {
    await load_data();
${serverLevels.map(x => `    if (inv${x.i}) sd${x.i} = new ServerNode_${x.n}(server_data_${x.n}(intent));`).join('\n')}
  }
`;
    }
    loaders.forEach((n, i) => {
      if (n === undefined) {
        body += `  const run${i} = async (): Promise<undefined> => undefined;\n  const bp${i} = run${i}();\n`;
        return;
      }
      const t = nodeTrie.get(n);
      const server = hasServer(n);
      const args = [];
      if (nodes[n].load) {
        // parent(): the data of the levels above, each awaited in order.
        let fn = `async (): Promise<${parentData(t)}> => {\n`;
        const spread = [];
        for (let j = 0; j < i; j++) {
          fn += `      const p${j} = await bp${j};\n`;
          if (loaders[j] !== undefined && hasData(loaders[j])) spread.push(`...p${j}.data`);
          else fn += `      void p${j};\n`;
        }
        fn += `      return { ${spread.join(', ')} };\n    }`;
        args.push('intent', fn);
      }
      if (server) args.push('server');
      const call = `load_node_${n}(${args.join(', ')})`;
      body += `  const run${i} = async (): Promise<${branchType(n)}> => {
    const previous = cur.nodes.length > ${i} && cur.nodes[${i}] === ${n} ? cur.p${n} : undefined;
    if (${server ? `sd${i} === undefined && ` : ''}previous !== undefined && !ctx.has_changed(parent_changed, ${nodes[n].load || server ? 'previous.uses' : 'undefined'})) return previous;
    parent_changed = true;
${
  server
    ? `    const server = sd${i} ?? (previous !== undefined ? previous.server : undefined);
    if (server === undefined) throw new Error('No server data');
`
    : ''
}    return ${call};
  };
  const bp${i} = run${i}();
`;
    });
    loaders.forEach((n, i) => {
      if (n === undefined) return;
      body += `  let b${i}: ${branchType(n)};
  try {
    b${i} = await bp${i};
  } catch (err) {
    const location = redirect_location(err);
    if (location !== undefined) return redirect_result(location);
    const status = http_status(err) ?? 500;
    let error: KitError;
    if (http_status(err) !== undefined) error = http_body(err);
    else {
      await updated_check();
      const handled = handle_error(err, { params: intent.params, route: { id: ${routeId} }, url: intent.url });
      error = await Promise.resolve(handled);
    }
`;
      if (i === 0) body += `    return root_error_page(intent.url, status, error, ${routeId});\n`;
      else {
        const ev = errorVariants.find(x => x.level === i);
        const kept = ev.kept.map(x => `b${x.i}, `).join('');
        body += `    await nearest_error();\n    return result_r${r.index}_e${i}(intent, intent.url, intent.params, ${kept}status, error);\n`;
      }
      body += '  }\n';
    });
    const all = loaders.map((n, i) => (n === undefined ? '' : `b${i}, `)).join('');
    body += `  return result_r${r.index}(intent, intent.url, intent.params, ${all}200, null);\n`;
    loadRoutes += `
async function load_route_r${r.index}(intent: Intent): Promise<NavResult> {
${body}}
`;
  }
  // load_root_error_page: the root layout's load again (no params), then the root error page.
  const rootLoad = nodes[0].load;
  const rootData = hasData(0);
  results += resultFunction(
    'result_root_error',
    [
      { index: 0, node: 0, local: 'b0', kind: rootData ? 'data' : 'null' },
      { index: 1, node: 1, kind: 'empty' },
    ],
    rootError.trie,
    'null',
    false,
  );
  const rootErrorPage = `
async function root_error_page(url: KitURL, status: number, error: KitError, route_id: string | null): Promise<NavResult> {
  const intent = new Intent(get_page_key(url), false, -1, route_id ?? '', new Params(), url);
${
  hasServer(0)
    ? `  await load_data();
  const s0 = new ServerNode_0(server_data_0(intent));
`
    : ''
}  const b0 = await load_node_0(${[...(rootLoad ? ['intent', '() => Promise.resolve({})'] : []), ...(hasServer(0) ? ['s0'] : [])].join(', ')});
  await node_loader();
  return result_root_error(undefined, url, new Params(), b0, status, error);
}
`;

  const routeDefs = routes
    .map(r => {
      const defs = r.params
        .map(
          p =>
            `{ name: ${js(p.name)}, matcher: ${p.matcher ? js(p.matcher) : 'undefined'}, optional: ${p.optional}, rest: ${p.rest}, chained: ${p.chained} }`,
        )
        .join(', ');
      return `  {
    id: ${js(r.id)},
    index: ${r.index},
    exec: (path: string): Params | undefined => {
      // A capture that does not participate is undefined (optional and rest
      // parameters): at() reads it as TypeScript types it, string | undefined.
      const match = ${regexLiteral(r.pattern)}.exec(path);
      if (!match) return undefined;
      const values: (string | undefined)[] = [];
      for (let i = 1; i < match.length; i++) values.push(match.at(i));
      const result = exec_params(values, [${defs}], matches);
      if (!result) return undefined;
      return new Params(${paramNames.map(p => `decode(result.get(${js(p)}))`).join(', ')});
    },
  },`;
    })
    .join('\n');

  const linkOption = name => {
    const c = m.html.containerAttrs[`data-sveltekit-${name}`];
    if (c !== undefined) return js(c);
    const b = m.html.bodyAttrs[`data-sveltekit-${name}`];
    return b !== undefined ? js(b) : 'null';
  };
  const OPTIONS = ['reload', 'replacestate', 'keepfocus', 'noscroll'];

  files.set(
    'app.ts',
    `// Generated by the compiler from the SvelteKit route manifest (Kit ${m.version}):
// the app's routes, loads, data and composition, registered with the router.
${imports.join('\n')}
import {
  start as start_router,
  Intent,
  kit_fetch,
  KitResponse,
  load_data,
  LoadContext,
  NavResult,
  get_page_key,
  handle_error,
  http_body,
  http_status,
  normalised_url,
  page_changed,
  redirect_location,
  redirect_result,
  result_page,
  updated_check,
  type HandleErrorInput,
  type RouteDef,
} from './client.ts';
import { exec_params, LoadRoute, LoadURL, present, Uses } from './load.ts';
import type { KitError } from './page.svelte.ts';
import { KitURL } from './url.ts';
import { LoadParams, Params } from './params.ts';
import { tree } from './tree.svelte.ts';

export { Params };

const HASH = ${m.hash};
const ABSENT = 0;
const NULL = 1;
const DATA = 2;

/** The data above the root layout. */
export type Empty = {};


function rethrow(e: Error): boolean {
  throw e;
}

/**
 * A route module's loader in the browser build ('single' bundle): Vite's
 * preload helper around the import of a module bundled with the app,
 * \`Promise.resolve().then(() => import()…catch(…))\`, \`import()\` being
 * \`Promise.resolve().then(() => module)\`.
 */
function node_loader(): Promise<boolean> {
  return Promise.resolve().then(() => Promise.resolve().then(() => true).catch(rethrow));
}

/** load_nearest_error_page: the error page's module. */
async function nearest_error(): Promise<void> {
  await node_loader();
}

/** A level without a load (its data is null). */
class NoLoad {
  readonly __noLoad = true;
}

/** A level whose load gives no data: what it read. */
class LoadOnly {
  uses: Uses;

  constructor(uses: Uses) {
    this.uses = uses;
  }
}

function decode(value: string | undefined): string | undefined {
  return value === undefined ? undefined : decodeURIComponent(value);
}

function matches(matcher: string, value: string): boolean {
${matchers.map(x => `  if (matcher === ${js(x.name)}) return match_${x.name}(value);`).join('\n')}
  void value;
  throw new Error(\`No matcher \${matcher}\`);
}

${decls}
/** Whether the current branch has a level at or after \`length\` (client.js compares up to both lengths). */
function trailing_changed(length: number): boolean {
  for (let i = length; i < cur.kinds.length; i++) if (cur.kinds[i] !== ABSENT) return true;
  return false;
}
${results}${loadRoutes}${rootErrorPage}
const ROUTES: RouteDef[] = [
${routeDefs}
];

/** The route's load_route. */
function load_route(intent: Intent): Promise<NavResult> {
${routes.map(r => `  if (intent.route === ${r.index}) return load_route_r${r.index}(intent);`).join('\n')}
  throw new Error('No route');
}

/**
 * The responses of the prerendered endpoints the loads fetch, by URL
 * (generation, compiler/adapters/kit-server.mjs); a new response per fetch.
 */
function fetch_table(url: string): KitResponse | undefined {
${Object.entries(m.fetchTable ?? {})
  .map(
    ([url, r]) =>
      `  if (url === ${js(url)}) return new KitResponse(${r.status}, ${js(r.type)}, ${js(r.body)});`,
  )
  .join('\n')}
  void url;
  return undefined;
}

/** \`data-sveltekit-*\` of app.html's container and body. */
function link_options(name: string): string | null {
${OPTIONS.map(o => `  if (name === ${js(o)}) return ${linkOption(o)};`).join('\n')}
  return null;
}

${
  m.hooksClient
    ? `function handle_client_error(input: HandleErrorInput): KitError | undefined {
  const result = handleError(input);
  return result === undefined ? undefined : result;
}
`
    : ''
}
/** Starts the router (Kit's \`start\`, without server rendering). */
export function start() {
  start_router({
    hash: HASH,
    routes: ROUTES,
    load_route,
    root_error: root_error_page,
    handle_error: ${m.hooksClient ? 'handle_client_error' : 'undefined'},
    // The root layout's and error page's modules (void loader(): nothing waits for them).
    default_loaders: () => {},
    link_options,
    fetch_table,
    mount: () => {
      tree.mounted = true;
    },
  });
}
`,
  );

  // --- tree.svelte.ts ---
  files.set(
    'tree.svelte.ts',
    `// Generated: what the root renders (per depth, the place in the route
// trie; -1 for none) and each place's data (Kit's root props).
import type { ${trie.map(t => dataType(t.id)).join(', ')} } from './app.ts';

class Tree {
  mounted = $state.raw(false);
  version = $state.raw(0);
${Array.from({ length: maxDepth }, (_, d) => `  n${d} = $state.raw(-1);`).join('\n')}
${trie.map(t => `  d${t.id} = $state.raw<${dataType(t.id)} | undefined>(undefined);`).join('\n')}
}

export const tree = new Tree();
`,
  );

  // --- Root.svelte ---
  const componentName = n => `C${n}`;
  const usedNodes = [...new Set(trie.map(t => t.node))];
  const renderTrie = t => {
    const node = nodes[trie[t].node];
    const props = [];
    if (node.props.has('data')) props.push(`data={tree.d${t}!}`);
    if (node.props.has('params')) props.push('params={page.params}');
    const open = `<${componentName(node.index)}${props.length ? ' ' + props.join(' ') : ''}`;
    const kids = trie[t].children;
    if (!kids.length || !node.props.has('children')) return `${open} />`;
    return `${open}>${renderLevel(trie[t].depth + 1, kids)}</${componentName(node.index)}>`;
  };
  const renderLevel = (depth, ids) =>
    ids
      .map((t, i) => `${i ? '{:else if' : '{#if'} tree.n${depth} === ${t}}${renderTrie(t)}`)
      .join('') + '{/if}';
  const roots = trie.filter(t => t.parent < 0).map(t => t.id);
  files.set(
    'Root.svelte',
    `<script lang="ts">
  // Kit's root component (Kit ${m.version}, src/core/sync/write_root.js): the
  // layouts and page nested through their children, and the live-region
  // announcer, which reads the title after each navigation.
  import { onMount, tick, untrack } from 'svelte';
  import { tree } from './tree.svelte.ts';
  import { internal as page } from './page.svelte.ts';
  import { page_store } from './client.ts';
${usedNodes.map(n => `  import ${componentName(n)} from ${js(nodes[n].componentImport)};`).join('\n')}

  let mounted = $state(false);
  let navigated = $state(false);
  let title = $state<string | null>(null);

  // The page store's subscriber (subscribed when the root mounts).
  function subscriber() {
    if (mounted) {
      navigated = true;
      tick().then(() => {
        title = document.title || 'untitled page';
      });
    }
  }

  // \`stores.page.notify()\` after each update of the root's props.
  $effect(() => {
    tree.version;
    untrack(() => {
      if (page_store.subscribed) subscriber();
    });
  });

  onMount(() => {
    page_store.subscriber = subscriber;
    page_store.subscribed = true;
    mounted = true;
  });
</script>

${renderLevel(0, roots)}

{#if mounted}
  <div id="svelte-announcer" aria-live="assertive" aria-atomic="true" style="position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px">{#if navigated}{title}{/if}</div>
{/if}
`,
  );

  // --- App.svelte and entry.ts ---
  files.set(
    'App.svelte',
    `<script lang="ts">
  // Kit creates its root component when the first navigation has loaded.
  import { onMount } from 'svelte';
  import { tree } from './tree.svelte.ts';
  import Root from './Root.svelte';
  import { start } from './app.ts';

  onMount(() => {
    start();
  });
</script>

{#if tree.mounted}<Root />{/if}
`,
  );
  files.set(
    'entry.ts',
    `import { mount } from 'svelte';
import App from './App.svelte';

mount(App, { target: document.getElementById('root') });
`,
  );

  // --- $types of each route directory ---
  for (const [dir, info] of m.typeDirs) {
    const appImport = path.posix.relative(path.posix.join('types', dir), 'app.ts');
    const names = [];
    let text = `// Generated: the types of ${dir || '/'} (Kit's ./$types).\nimport type { Snippet } from 'svelte';\n`;
    const lines = [];
    if (info.page !== undefined) {
      const t = nodeTrie.get(info.page);
      names.push(dataType(t));
      if (trie[t].parent >= 0) names.push(dataType(trie[t].parent));
      lines.push(`export type PageData = ${dataType(t)};`);
      lines.push(`export type PageParentData = ${parentData(t)};`);
      lines.push('export type PageProps = { data: PageData; params: Params };');
      if (nodes[info.page].load) {
        names.push(`LoadEvent_${info.page}`);
        lines.push(`export type PageLoadEvent = LoadEvent_${info.page};`);
        lines.push('export type PageLoad = (event: PageLoadEvent) => unknown;');
      }
    }
    if (info.layout !== undefined) {
      const t = nodeTrie.get(info.layout);
      names.push(dataType(t));
      if (trie[t].parent >= 0) names.push(dataType(trie[t].parent));
      lines.push(`export type LayoutData = ${dataType(t)};`);
      lines.push(`export type LayoutParentData = ${parentData(t)};`);
      lines.push(
        'export type LayoutProps = { data: LayoutData; params: Params; children: Snippet };',
      );
      if (nodes[info.layout].load) {
        names.push(`LoadEvent_${info.layout}`);
        lines.push(`export type LayoutLoadEvent = LoadEvent_${info.layout};`);
        lines.push('export type LayoutLoad = (event: LayoutLoadEvent) => unknown;');
      }
    }
    lines.push('export type RouteParams = Params;', 'export type LayoutParams = Params;');
    names.push('Params', 'Empty');
    text += `import type { ${[...new Set(names)].join(', ')} } from ${js(appImport.startsWith('.') ? appImport : './' + appImport)};\n\n`;
    text += lines.join('\n') + '\n';
    files.set(path.posix.join('types', dir, '$types.ts'), text);
  }
  return files;
}
