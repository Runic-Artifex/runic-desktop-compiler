// Language rules embla-carousel's bundle needs past its EventHandler (M6
// script DOM, slice 4; docs/design/M6-SCRIPT-DOM.md), checked on application
// code against Node running the same module, and on an untyped package:
// a dictionary typed from the values written into it, also through itself
// (`d[k] = get(k).concat([v])`); a call through a record by a key of its
// names whose functions take different numbers of parameters;
// `[].slice.call(list)`; `Object.keys(array)` and `map(Number)`; a closure
// created before a constant it reads; a function declaration reading
// variables declared before its first use; `concat` of array literals;
// `&&` of an operand that is always an object; element metrics destructured.
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
  const root = await mkdtemp(path.resolve('.cache/tests/script-dom-embla-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root') });\n",
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

const LOGIC = `export function run(k: number): string {
  const predefined = { start, center, end };
  function start(): number {
    return 0;
  }
  function center(n: number): number {
    return end(n) / 2;
  }
  function end(n: number): number {
    return 10 - n;
  }
  const pick = (a: 'start' | 'center' | 'end', n: number) => predefined[a](n);
  const isVertical = k > 1;
  const edge = getEdge();
  function getEdge(): string {
    return isVertical ? 'top' : 'left';
  }
  let list: number[] = [];
  list = list.concat([k, k + 1]).concat([], [k * 2]);
  const keys = Object.keys(list).map(Number);
  const rows = [{ v: k }];
  const first = rows[0] && k > 1;
  const later = () => late.v;
  const late = { v: k * 3 };
  const copy: number[] = [].slice.call(list);
  copy.push(9);
  const filled = Array.from(Array(k + 1), (_, i) => k + i);
  const errorName = (f: () => number): string => {
    try {
      f();
      return 'none';
    } catch (e) {
      return (e as Error).name;
    }
  };
  const invalid = errorName(() => Array.from(Array(k - 1.5), (_, i) => i).length);
  const d: { [key: string]: { v: number } } = { a: { v: k } };
  const { v } = d['a'];
  const missing = errorName(() => {
    const { v: w } = d['b'];
    return w;
  });
  const flick = k && k > 1;
  return [pick('start', k), pick('center', k), pick('end', k), edge, list.join(','),
    keys.join(','), first, later(), copy.join(','), list.length, filled.join(','), invalid,
    v, missing, flick ? 'flick' : 'still'].join(' ');
}
`;

test('keyed calls of functions of different arities, early functions, concat, Object.keys of an array, slice.call', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const dir = await mkdtemp(path.resolve('.cache/tests/script-dom-embla-node-'));
  let want;
  try {
    await writeFile(path.join(dir, 'logic.ts'), LOGIC);
    const { run } = await import(pathToFileURL(path.join(dir, 'logic.ts')).href);
    want = [1, 2].map(run);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(
    want[0],
    '0 4.5 9 left 1,2,2 0,1,2 false 3 1,2,2,9 3 1,2 RangeError 1 TypeError still',
  );
  const out = await withApp(
    {
      'logic.ts': LOGIC,
      'App.svelte': `<script lang="ts">
  import { run } from './logic.ts';
  let k = $state(1);
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out">{run(k)}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [{ kind: 'click', id: 'go' }]);
      return steps.map(s => text(find(s.state.dom, 'out')));
    },
  );
  assert.deepEqual(out, want);
});

test('element metrics destructured and a computed property name of finitely many names', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let el: HTMLElement | undefined = $state();
  let k = $state(1);
  function measure(node: HTMLElement): string {
    const { offsetTop, offsetWidth: w } = node;
    const side: 'left' | 'right' = k > 1 ? 'left' : 'right';
    return getComputedStyle(node).getPropertyValue(\`margin-\${side}\`) + (offsetTop + w);
  }
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out" bind:this={el}>{el ? measure(el) : ''}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const body = JSON.stringify(ir.functions);
      assert.match(body, /"name":"element\.offsetTop"/);
      assert.match(body, /"name":"element\.offsetWidth"/);
      assert.match(body, /"name":"element\.computed-style","args":\[[^\]]*\{"op":"local"/);
    },
  );
  // A name outside the covered properties is rejected, located.
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let el: HTMLElement | undefined = $state();
  let k = $state(1);
  const side: 'left' | 'width' = k > 1 ? 'left' : 'width';
</script>
<p id="out" bind:this={el}>{el ? getComputedStyle(el).getPropertyValue(\`margin-\${side}\`) : ''}</p>
`,
    },
    root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        e => e.code === 'E_CALL' && /getPropertyValue reads/.test(e.message),
      ),
  );
});

test('an IntersectionObserver with an element root, instanceof of a window member, and a computed read of a conditional', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let el: HTMLElement | undefined = $state();
  let hit = $state('');
  let axis = $state('x');
  const point = { clientX: 5, clientY: 6 };
  function threshold(): number | undefined {
    return undefined;
  }
  $effect(() => {
    const o = new IntersectionObserver(() => {}, { root: el?.parentElement, threshold: threshold() });
    return () => o.disconnect();
  });
  function onclick(e: MouseEvent) {
    const coord = \`client\${axis === 'x' ? 'X' : 'Y'}\`;
    const isMouse = e instanceof window.MouseEvent;
    const read = (isMouse ? e : point)[coord];
    hit = String(isMouse) + ' ' + (read > -1) + ' ' + (axis === 'x' ? point : e)[coord];
    axis = 'y';
  }
</script>
<div><button id="go" bind:this={el} {onclick}>go</button></div>
<p id="out">{hit}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const body = JSON.stringify(ir.functions);
      assert.match(body, /"name":"intersection\.new","args":\[[^\]]*\]?.*?\{"op":"nullish"/s);
      const io = ir.functions.flatMap(
        f => JSON.stringify(f.body).match(/"name":"intersection\.new","args":\[/g) ?? [],
      ).length;
      assert.equal(io, 1);
      assert.match(
        body,
        /"name":"event\.instance-of","args":\[\{"op":"local","local":\d+\},\{"op":"lit","value":"MouseEvent"\}/,
      );
      const steps = interpret(ir, [
        { kind: 'click', id: 'go' },
        { kind: 'click', id: 'go' },
      ]);
      assert.equal(text(find(steps[1].state.dom, 'out')), 'true true 5');
      assert.match(text(find(steps[2].state.dom, 'out')), /^true true \d+(\.\d+)?$/);
    },
  );
});

/**
 * A source package (svelte-sonner at its pinned version) whose untyped
 * module keeps listeners in a dictionary, as embla's EventHandler does.
 */
function pkg(js, dts = '') {
  return {
    'node_modules/svelte-sonner/package.json': JSON.stringify({
      name: 'svelte-sonner',
      version: '1.2.1',
      type: 'module',
      sideEffects: false,
      svelte: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', svelte: './dist/index.js', default: './dist/index.js' },
      },
    }),
    'node_modules/svelte-sonner/dist/index.js': js,
    'node_modules/svelte-sonner/dist/index.d.ts': `type CallbackType = (evt: string, n: number) => void;
export type RegistryType = {
    on: (evt: string, cb: CallbackType) => RegistryType;
    off: (evt: string, cb: CallbackType) => RegistryType;
    emit: (evt: string, n: number) => RegistryType;
    clear: () => void;
};
export declare function Registry(): RegistryType;
${dts}`,
  };
}

const REGISTRY = `export function Registry() {
    let listeners = {};
    function getListeners(evt) {
        return listeners[evt] || [];
    }
    function on(evt, cb) {
        listeners[evt] = getListeners(evt).concat([cb]);
        return self;
    }
    function off(evt, cb) {
        listeners[evt] = getListeners(evt).filter(e => e !== cb);
        return self;
    }
    function emit(evt, n) {
        getListeners(evt).forEach(e => e(evt, n));
        return self;
    }
    function clear() {
        listeners = {};
    }
    const self = { on, off, emit, clear };
    return self;
}
`;

const USE = `<script lang="ts">
  import { Registry } from 'svelte-sonner';
  const log = $state<string[]>([]);
  const r = Registry();
  // (Of result \`number\`: converted to the callback type, keeping identity.)
  const a = (evt: string, n: number) => log.push('a' + evt + n);
  const b = (evt: string, n: number) => log.push('b' + evt + n);
  r.on('x', a).on('x', b).on('y', a).emit('x', 1).off('x', a).emit('x', 2).emit('y', 3);
  r.clear();
  r.emit('x', 4);
</script>
<p id="out">{log.join(' ')}</p>
`;

test("a dictionary an untyped package writes from itself takes the values' type", async () => {
  await withApp({ ...pkg(REGISTRY), 'App.svelte': USE }, async root => {
    const { ir } = await lower(await collect(root));
    const [start] = interpret(ir, []);
    assert.equal(text(find(start.state.dom, 'out')), 'ax1 bx1 bx2 ay3');
  });
});

test('a dictionary written values of two types, or escaping, stays untyped (rejected, located)', async () => {
  // (At the first function reading it.)
  const at = 'node_modules/svelte-sonner/dist/index.js:3:14';
  const rejects = (js, use = USE) =>
    withApp({ ...pkg(js), 'App.svelte': use }, root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        e => {
          assert.equal(e.code, 'E_TYPE_UNSUPPORTED', e.message);
          assert.equal(`${e.source?.file}:${e.source?.line}:${e.source?.column}`, at, e.message);
          return true;
        },
      ),
    );
  // Values of two types.
  await rejects(
    REGISTRY.replace(
      'return self;\n    }\n    function off',
      "listeners[evt + '!'] = 'z';\n        return self;\n    }\n    function off",
    ),
  );
  // Passed to a function, which may write it.
  await rejects(
    REGISTRY.replace('function clear() {', 'function clear() {\n        Object.freeze(listeners);'),
  );
});
