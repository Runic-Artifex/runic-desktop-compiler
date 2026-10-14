// Language rules embla-carousel's bundle needs (M6 script DOM, slice 4;
// docs/design/M6-SCRIPT-DOM.md), checked on application code against Node
// running the same module: a constant naming a function declaration of its
// block is that function (embla's `const reInit = reActivate`, before the
// `let`s the function reads); `d || {}` of a nullable dictionary object is
// the dictionary or an empty one (`options.breakpoints || {}`);
// `window.matchMedia` as a function value (`queries.map(ownerWindow.matchMedia)`),
// whose query, computed at run time, is reported unsupported where it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app with `files`; `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/embla-language-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
      'style.css':
        "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
      'runic.json': JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
      ...files,
    };
    for (const [file, text] of Object.entries(all)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const find = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const f = find(n.children, id);
    if (f) return f;
  }
};

const LOGIC = `export function factory(start: number) {
  const reset = restart;
  let count = start;
  let seen: string[] = [];
  function restart(to: number): number {
    seen.push('r' + to);
    count = to;
    return bump();
  }
  function bump(): number {
    count = count + 1;
    return count;
  }
  const self = { reset, bump, log: () => seen.join(',') };
  return self;
}
export function keys(d?: { [key: string]: number }): string {
  const m = d || {};
  return Object.keys(m).join(',') + '=' + Object.values(m).join(',');
}
export function run(k: number): string {
  const f = factory(k);
  const a = f.bump();
  const b = f.reset(10 * k);
  return [a, b, f.bump(), f.log(), keys(), keys({ x: k, y: 2 })].join(' ');
}
`;

test('a constant naming a function, `d || {}` of a dictionary and matchMedia as a value', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const dir = await mkdtemp(path.resolve('.cache/tests/embla-language-node-'));
  let want;
  try {
    await writeFile(path.join(dir, 'logic.ts'), LOGIC);
    const { run } = await import(pathToFileURL(path.join(dir, 'logic.ts')).href);
    want = [1, 2].map(run);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(want[0], '2 11 12 r10 = x,y=1,2');
  const out = await withApp(
    {
      'logic.ts': LOGIC,
      'App.svelte': `<script lang="ts">
  import { run } from './logic.ts';
  let k = $state(1);
  const queries = ['(min-width: 1px)', '(max-width: 1px)'];
  const lists = $derived(k > 1 ? queries.map(window.matchMedia) : []);
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out">{run(k)}</p>
<p id="media">{lists.length} {window.matchMedia('(min-width: 1px)').matches}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, []);
      const value = ir.functions.find(f => f.name === 'matchMedia');
      return {
        out: text(find(steps[0].state.dom, 'out')),
        media: text(find(steps[0].state.dom, 'media')),
        value: JSON.stringify(value.body),
      };
    },
  );
  assert.equal(out.out, want[0]);
  assert.equal(out.media, '0 true');
  // (The function value's query is known at run time only: reported there.)
  assert.match(out.value, /"op":"call"/);
});

test("an instantiation's result typed through its type parameter's constraint is rejected, located", async () => {
  // TypeScript types `o.m` through `T`'s constraint (values of `{ [x: string]:
  // unknown }`, an attribute bag); the instantiation's values are records
  // (Lowerer.constrainedRead), so a result TypeScript types `Loose[]` is not
  // theirs. (The instantiation typed through its members' values is
  // exercised by embla's optionsAtMedia, conformance/triage.mjs.)
  const app = result => ({
    'App.svelte': `<script lang="ts">
  type Loose = { [x: string]: unknown };
  function outer(k: string) {
    function pick<T extends { m?: { [k: string]: Loose } }>(o: T)${result} {
      const d = o.m || {};
      const found = Object.keys(d)
        .filter(x => x === k)
        .map(x => d[x]);
      return ${result ? 'found.length' : 'found'};
    }
    const m: { [k: string]: { c: number } } = { a: { c: 1 }, b: { c: 2 } };
    return pick({ m });
  }
  const r = outer('b');
</script>
<p id="out">{${result ? 'r' : 'r.length'}}</p>
`,
  });
  // A result TypeScript types through the constraint (`Loose[]`): rejected, located.
  await withApp(app(''), root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e =>
        (e.code === 'E_TYPE_UNION' && /constraint/.test(e.message) && !!e.source) ||
        assert.fail(`${e.code}: ${e.message}`),
    ),
  );
});

test("a nested generic's declarations take its instantiation's values, and a constraint type shared with another value is rejected, located", async () => {
  // `const d = o.m || {}` is declared (typed) before the read `o.m` shows
  // what TypeScript's constraint type of it stands for: the reads are
  // known before the body is lowered. `d[x]` of a key of `d` itself is
  // present.
  const ok = {
    'App.svelte': `<script lang="ts">
  type Loose = { [x: string]: unknown };
  function outer(k: string) {
    function pick<T extends { m?: { [k: string]: Loose } }>(o: T): number {
      const d = o.m || {};
      return Object.keys(d)
        .filter(x => x !== k)
        .map(x => d[x]).length;
    }
    const m: { [k: string]: { c: number } } = { a: { c: 1 }, b: { c: 2 }, c: { c: 3 } };
    const n: { [k: string]: { c: number } } = { b: { c: 5 }, d: { c: 6 } };
    return pick({ m }) + pick({ m: n });
  }
  const r = outer('b');
</script>
<p id="out">{r}</p>
`,
  };
  await withApp(ok, async root => {
    const { ir } = await lower(await collect(root));
    assert.equal(text(find(interpret(ir, [])[0].state.dom, 'out')), '3');
  });
  // A parameter of the constraint's dictionary type that holds other values.
  const shared = {
    'App.svelte': `<script lang="ts">
  type Loose = { [x: string]: unknown };
  type Dict = { [k: string]: Loose };
  function pick<T extends { m?: Dict }>(o: T, p: Dict): number {
    const d = o.m || {};
    return Object.keys(d).length + Object.keys(p).length;
  }
  const m: { [k: string]: { c: number } } = { a: { c: 1 } };
  const r = pick({ m }, { z: { y: 1 } });
</script>
<p id="out">{r}</p>
`,
  };
  await withApp(shared, root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e =>
        (e.code === 'E_TYPE_UNION' &&
          /also the type of values/.test(e.message) &&
          e.source?.line === 5) ||
        assert.fail(`${e.code}: ${e.message} ${JSON.stringify(e.source)}`),
    ),
  );
});

test("a dictionary read returned where TypeScript types it present is rejected, located, unless its key is the dictionary's own", async () => {
  const app = keys => ({
    'App.svelte': `<script lang="ts">
  const d: { [k: string]: { c: number } } = { a: { c: 1 }, b: { c: 2 } };
  const vs = ${keys}.map(k => d[k]);
  const r = vs.map(v => v.c).join(',');
</script>
<p id="out">{r}</p>
`,
  });
  await withApp(app("['a', 'z']"), root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e =>
        (e.code === 'E_TYPE_UNION' && /dictionary read/.test(e.message) && e.source?.line === 3) ||
        assert.fail(`${e.code}: ${e.message} ${JSON.stringify(e.source)}`),
    ),
  );
  await withApp(app("Object.keys(d).filter(k => k !== 'a')"), async root => {
    const { ir } = await lower(await collect(root));
    assert.equal(text(find(interpret(ir, [])[0].state.dom, 'out')), '2');
  });
});

test('reduce into the empty dictionary a function returns, and Object.assign of entries onto a dictionary', async () => {
  // embla's PluginsHandler `init(…): EmblaPluginsType` returns
  // `plugins.reduce((map, plugin) => Object.assign(map, { [plugin.name]:
  // plugin }), {})`: the accumulator is that dictionary, the assignment a
  // keyed set returning it (own-key order: integer-like keys first).
  const LOGIC = `type P = { name: string; n: number };
export function index(ps: P[]): { [k: string]: P } {
  return ps.reduce((map, p) => Object.assign(map, { [p.name]: p, ['x' + p.n]: p }), {});
}
export function show(): string {
  const d = index([{ name: 'b', n: 1 }, { name: '2', n: 2 }, { name: 'a', n: 3 }, { name: 'b', n: 4 }]);
  return Object.keys(d).join(',') + ' ' + Object.values(d).map(p => p.n).join(',');
}
`;
  await mkdir('.cache/tests', { recursive: true });
  const dir = await mkdtemp(path.resolve('.cache/tests/embla-language-node-'));
  let want;
  try {
    await writeFile(path.join(dir, 'logic.ts'), LOGIC);
    want = (await import(pathToFileURL(path.join(dir, 'logic.ts')).href)).show();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(want, '2,b,x1,x2,a,x3,x4 2,4,1,2,3,3,4');
  const out = await withApp(
    {
      'logic.ts': LOGIC,
      'App.svelte': `<script lang="ts">
  import { show } from './logic.ts';
</script>
<p id="out">{show()}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      return text(find(interpret(ir, [])[0].state.dom, 'out'));
    },
  );
  assert.equal(out, want);
  // Object.assign onto anything else: rejected, located.
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const o = Object.assign({ a: 1 }, { b: 2 });
</script>
<p id="out">{o.b}</p>
`,
    },
    root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        e =>
          (e.code === 'E_BUILTIN' && /Object.assign/.test(e.message) && e.source?.line === 2) ||
          assert.fail(`${e.code}: ${e.message} ${JSON.stringify(e.source)}`),
      ),
  );
});

test("a dictionary type another module's augmentation adds a member to is the dictionary, the member's reads rejected, located", async () => {
  // embla-carousel-autoplay's `declare module 'embla-carousel' { interface
  // EmblaPluginsType { autoplay: AutoplayType } }` beside the index
  // signature of the plugins dictionary.
  const app = read => ({
    'node_modules/dict-base/package.json': JSON.stringify({
      name: 'dict-base',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    }),
    'node_modules/dict-base/index.js': 'export {};\n',
    'node_modules/dict-base/index.d.ts':
      '/// <reference path="./ext.d.ts" />\nexport interface Plugins {\n  [key: string]: { name: string };\n}\n',
    'node_modules/dict-base/ext.d.ts':
      "declare module 'dict-base' {\n  interface Plugins {\n    extra?: { name: string; more: number };\n  }\n}\nexport {};\n",
    'App.svelte': `<script lang="ts">
  import type { Plugins } from 'dict-base';
  const d: Plugins = { a: { name: 'a' }, b: { name: 'b' } };
  const r = ${read};
</script>
<p id="out">{r}</p>
`,
  });
  await withApp(app("Object.keys(d).join(',')"), async root => {
    const { ir } = await lower(await collect(root));
    assert.equal(text(find(interpret(ir, [])[0].state.dom, 'out')), 'a,b');
  });
  await withApp(app('d.extra?.more ?? 0'), root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e =>
        (e.code === 'E_MEMBER' && /augmentation/.test(e.message) && e.source?.line === 4) ||
        assert.fail(`${e.code}: ${e.message} ${JSON.stringify(e.source)}`),
    ),
  );
});

test("a function declared before a variable it refers to shares its binding (a factory member returning the factory's object)", async () => {
  // embla's EventStore: `function add(…) { …; return self; }` before
  // `const self = { add, clear }`.
  const out = await withApp(
    {
      'App.svelte': `<script lang="ts">
  type Store = { add: (k: number) => Store; get: () => number };
  function store(): Store {
    let n = 0;
    function add(k: number): Store {
      n += k;
      return self;
    }
    function get(): number {
      return n;
    }
    const self = { add, get };
    return self;
  }
  const r = store().add(2).add(3).get();
</script>
<p id="out">{r}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      return text(find(interpret(ir, [])[0].state.dom, 'out'));
    },
  );
  assert.equal(out, '5');
});

test("listener options of a boolean or a record, and a host feature test's dead branch", async () => {
  // embla's EventStore `add(node, type, handler, options = { passive: true })`
  // with `EventOptionsType = boolean | AddEventListenerOptions | undefined`:
  // each call's options by the member they hold; `'addEventListener' in
  // node` is true at build time, so the legacy branch is never lowered.
  const out = await withApp(
    {
      'App.svelte': `<script lang="ts">
  let log = $state('');
  let outer: HTMLElement;
  let inner: HTMLElement;
  function add(node: EventTarget, f: () => void, options: boolean | AddEventListenerOptions = { passive: true }) {
    if ('addEventListener' in node) node.addEventListener('click', f, options);
    else {
      const legacy = node as unknown as { addListener(h: () => void): void };
      legacy.addListener(f);
    }
  }
  $effect(() => {
    add(inner, () => (log += 'i'));
    add(outer, () => (log += 'c'), true);
    add(outer, () => (log += 'r'), { capture: true });
    add(outer, () => (log += 'b'), false);
  });
</script>
<div id="outer" bind:this={outer}><button id="inner" bind:this={inner}>x</button></div>
<p id="out">{log}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [{ kind: 'click', id: 'inner' }]);
      return text(find(steps.at(-1).state.dom, 'out'));
    },
  );
  // (Capture listeners at the ancestor, the target's, then the bubbling one.)
  assert.equal(out, 'crib');
});
