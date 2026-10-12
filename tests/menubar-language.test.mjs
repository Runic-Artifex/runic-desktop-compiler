// Language for bits-ui's menubar (M6, shadcn-svelte census): `Boolean(x)`,
// strict equality of different primitive types, `boolean` in a union with
// a literal, `onMount` in a function called while a component is created,
// untyped JavaScript reading through a nullable value TypeScript forgot
// the test of, `element.disabled`, a present value searched among
// nullable ones, a runed context nothing reads set with values of
// different types, and an attachRef setter with a result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/menubar-language-'));
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
const byId = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const found = byId(n.children, id);
    if (found) return found;
  }
  return undefined;
};

/** Lowering `files` fails with `code` at `at` (file:line:column). */
async function rejects(files, code, at) {
  await withApp(files, root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e => {
        assert.equal(e.code, code, e.message);
        assert.equal(`${e.source?.file}:${e.source?.line}:${e.source?.column}`, at, e.message);
        return true;
      },
    ),
  );
}

const MOUNT = `<script lang="ts">
  import { onMount } from 'svelte';
  let s = $state('');
  let on = $state(false);
  let mounted = $state(0);
  function track() {
    onMount(() => {
      mounted += 1;
    });
  }
  track();
  function label(c: boolean | 'mixed'): string {
    return c === 'mixed' ? 'mixed' : c ? 'on' : 'off';
  }
</script>

<button id="go" onclick={() => { s = 'x'; on = !on; }}>go</button>
<p id="b">{Boolean(s && s !== 'y')}</p>
<p id="l">{label(on)}</p>
<p id="m">{mounted}</p>
`;

test('Boolean(x), equality of different primitives, boolean unions, onMount in a function', async () => {
  await withApp({ 'App.svelte': MOUNT }, async root => {
    const { ir } = await lower(await collect(root));
    const [start, clicked] = interpret(ir, [{ kind: 'click', id: 'go' }]);
    assert.equal(text(byId(start.state.dom, 'b')), 'false');
    assert.equal(text(byId(start.state.dom, 'l')), 'off');
    assert.equal(text(byId(start.state.dom, 'm')), '1');
    assert.equal(text(byId(clicked.state.dom, 'b')), 'true');
    assert.equal(text(byId(clicked.state.dom, 'l')), 'on');
    assert.equal(text(byId(clicked.state.dom, 'm')), '1');
  });
  // onMount of a function taking parameters is rejected where it is called.
  await rejects(
    { 'App.svelte': MOUNT.replace('onMount(() => {', 'onMount((x: number) => {') },
    'E_EFFECT',
    'App.svelte:7:5',
  );
});

const HELPER = `/** @param {boolean} pick */
export function reader(pick) {
  const holder = { g: pick ? { name: 'a' } : null };
  if (holder.g) return () => holder.g.name;
  return () => 'none';
}

/** @param {Element[]} els */
export function enabled(els) {
  return els.filter((el) => !el.disabled).map((el) => el.id).join(',');
}

/** @param {Element[]} els @param {string} v */
export function position(els, v) {
  const values = els.map((el) => el.getAttribute('data-v'));
  return values.indexOf(v);
}
`;

const JS_APP = `<script lang="ts">
  import { reader, enabled, position } from './helper.js';
  let a = $state<HTMLElement>();
  let c = $state<HTMLElement>();
  let out = $state('');
  const read = reader(true);
</script>

<button id="a" bind:this={a} data-v="x">a</button>
<button id="c" bind:this={c} disabled>c</button>
<button id="go" onclick={() => (out = enabled([a!, c!]) + ':' + position([c!, a!], 'x') + ':' + read())}>go</button>
<p id="out">{out}</p>
`;

test('untyped JavaScript: nullable reads in closures, element.disabled, indexOf among nullable values', async () => {
  await withApp({ 'helper.js': HELPER, 'App.svelte': JS_APP }, async root => {
    const { ir } = await lower(await collect(root));
    const [, clicked] = interpret(ir, [{ kind: 'click', id: 'go' }]);
    assert.equal(text(byId(clicked.state.dom, 'out')), 'a:1:a');
  });
  // Numbers keep their own search rules: a present number among nullable
  // ones is not compared as present.
  await rejects(
    {
      'helper.js': HELPER.replace(
        "els.map((el) => el.getAttribute('data-v'))",
        'els.map((el) => (el.id ? 1 : null))',
      ).replace('values.indexOf(v)', 'values.indexOf(1)'),
      'App.svelte': JS_APP,
    },
    'E_BUILTIN',
    'helper.js:16:3',
  );
});

const CTX = `import { Context } from 'runed';
export class A {
  kind = 'a';
}
export class B {
  n = 1;
}
const Either = new Context<A | B>('Either');
export const setA = () => Either.set(new A());
export const setB = () => Either.set(new B());
export const describe = () => {
  const v = Either.get();
  return v instanceof A ? v.kind : 'b' + v.n;
};
`;

// (Untyped, as bits-ui's contexts are.)
const MIXED = `import { Context } from 'runed';
const Mixed = new Context('Mixed');
export const setText = () => Mixed.set('t');
export const setCount = () => Mixed.set(2);
`;

const CTX_APP = `<script lang="ts">
  import { attachRef } from 'svelte-toolbelt';
  import { setA, setB, describe } from './ctx.ts';
  import { setText, setCount } from './mixed.js';
  setA();
  const first = describe();
  setB();
  const second = describe();
  setText();
  setCount();
  let node = $state<HTMLElement | null>(null);
  const attach = attachRef((v: HTMLElement | null) => (node = v));
</script>

<p id="t" {...attach}>{first}{second}</p>
<p id="r">{node ? 'set' : 'unset'}</p>
`;

test('runed contexts of several classes, or never read; attachRef setters with a result', async () => {
  await withApp({ 'ctx.ts': CTX, 'mixed.js': MIXED, 'App.svelte': CTX_APP }, async root => {
    const { ir } = await lower(await collect(root));
    const [start] = interpret(ir, []);
    assert.equal(text(byId(start.state.dom, 't')), 'ab1');
    assert.equal(text(byId(start.state.dom, 'r')), 'set');
  });
  // Values of different types that are not class instances, read anywhere
  // that runs, are rejected where a set disagrees.
  await rejects(
    {
      'ctx.ts': CTX,
      'mixed.js': MIXED + 'export const peek = () => Mixed.get();\n',
      'App.svelte': CTX_APP.replace('setCount }', 'setCount, peek }').replace(
        '  setCount();',
        '  setCount();\n  peek();',
      ),
    },
    'E_PACK',
    'mixed.js:4:31',
  );
  // A setter of another parameter list stays rejected.
  await rejects(
    {
      'ctx.ts': CTX,
      'mixed.js': MIXED,
      'App.svelte': CTX_APP.replace(
        '(v: HTMLElement | null) => (node = v)',
        '(v: HTMLElement | null, n: number) => (node = v)',
      ),
    },
    'E_PACK',
    'App.svelte:12:28',
  );
});
