// Dynamic values (M6 spike, docs/design/M6-DYNAMIC-VALUES.md): with
// runic.json "dynamicValues": true, values outside the static model compile
// to dynamic operations; static and dynamic values meet at checked
// boundaries. The interpreter runs each program; case bits-pagination and
// fixture dyn-values-svelte compare the native build with Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files` with dynamic values (or not); `run` gets its root. */
async function withApp(files, run, dynamicValues = true) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/dynamic-values-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root') });\n",
      'runic.json': JSON.stringify({
        framework: 'svelte',
        entry: 'main.js',
        title: 'T',
        dynamicValues,
      }),
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
const texts = dom => dom.filter(n => typeof n !== 'string').map(text);
const failWith = (code, pattern) => e =>
  (e instanceof Diagnostic && e.code === code && (!pattern || pattern.test(e.message))) ||
  assert.fail(`expected ${code}, got ${e.code}: ${e.message}`);

const LIB = `export function makeItems(n) {
  const items = [];
  for (let i = 1; i <= n; i++) items.push(i % 2 ? { kind: 'odd', n: i } : { kind: 'even', n: i, half: i / 2 });
  return items;
}
export function keyed(a, b) {
  return { [a]: 1, [b]: 2 };
}
export function describe(x) {
  return x.kind + ':' + x.n + (x.half ? '/' + x.half : '');
}
`;

test('untyped code compiles to dynamic values: objects, arrays, computed keys, operators', async () => {
  const app = {
    'lib.js': LIB,
    'App.svelte': `<script lang="ts">
  import { makeItems, keyed, describe } from './lib.js';
  let count = $state(3);
  const items = $derived(makeItems(count));
  let key = $state('a');
  const table = $derived(keyed(key, 'b'));
</script>

<button id="more" onclick={() => count++}>more</button>
<button id="key" onclick={() => (key = key === 'a' ? 'c' : 'a')}>key</button>
<ul>{#each items as item (item.n)}<li>{describe(item)}</li>{/each}</ul>
<p>{table.a ?? '-'} {table.b} {table.c ?? '-'} {items.length}</p>
`,
  };
  await withApp(app, async root => {
    const { ir } = await lower(await collect(root));
    assert.ok(JSON.stringify(ir).includes('"dyn.get"'));
    const steps = interpret(ir, [
      { kind: 'click', id: 'more' },
      { kind: 'click', id: 'key' },
    ]);
    const shown = s => texts(s.state.dom).slice(2).join(' | ');
    assert.equal(shown(steps[0]), 'odd:1even:2/1odd:3 | 1 2 - 3');
    assert.equal(shown(steps[1]), 'odd:1even:2/1odd:3even:4/2 | 1 2 - 4');
    assert.equal(shown(steps[2]), 'odd:1even:2/1odd:3even:4/2 | - 2 1 4');
  });
  // Without the opt-in the same program is rejected where untyped values meet.
  await withApp(
    app,
    async root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        e => e instanceof Diagnostic,
      ),
    false,
  );
});

test('a dynamic value reaching a static slot of another type throws, never coerced', async () => {
  await withApp(
    {
      'lib.js': `export function pick(flag) { return flag ? 1 : 'one'; }\n`,
      'App.svelte': `<script lang="ts">
  import { pick } from './lib.js';
  let out = $state(0);
  let error = $state('');
  function take(flag: boolean) {
    try {
      const n: number = pick(flag);
      out = n + 1;
    } catch (e) {
      error = (e as Error).name;
    }
  }
</script>

<button id="ok" onclick={() => take(true)}>ok</button>
<button id="bad" onclick={() => take(false)}>bad</button>
<p>{out} {error}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [
        { kind: 'click', id: 'ok' },
        { kind: 'click', id: 'bad' },
      ]);
      assert.equal(texts(steps[1].state.dom).at(-1), '2 ');
      assert.equal(texts(steps[2].state.dom).at(-1), '2 RunicUnsupportedError');
    },
  );
});

test('dynamic objects copied into records only where no code can tell the copy apart', async () => {
  const app = mutate => ({
    'lib.js': `export function make() { return [{ label: 'a', size: 1 }, { label: 'b', size: 2, extra: true }]; }\n`,
    'App.svelte': `<script lang="ts">
  import { make } from './lib.js';
  type Item = { label: string; size: number };
  const items = make();
  const first: Item = items[0];
  let out = $state(0);
  function grow() {
    const second: Item = items[1];
    ${mutate ? 'second.size += 1;' : ''}
    out = second.size;
  }
</script>

<button id="b" onclick={grow}>{first.label} {first.size} {out}</button>
`,
  });
  await withApp(app(false), async root => {
    const { ir } = await lower(await collect(root));
    const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
    assert.equal(texts(steps[0].state.dom)[0], 'a 1 0');
    assert.equal(texts(steps[1].state.dom)[0], 'a 1 2');
  });
  // A copied record that the program mutates: the dynamic object would not see it.
  await withApp(app(true), async root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      failWith('E_DYN_COPY', /is assigned/),
    ),
  );
});

test('a dynamic value in state changed in place is rejected: no tracking sees it', async () => {
  await withApp(
    {
      'lib.js': 'export function make(k) { return { [k]: 1 }; }\n',
      'App.svelte': `<script lang="ts">
  import { make } from './lib.js';
  let o = $state(make('k'));
</script>

<button id="b" onclick={() => (o.k = 2)}>{o.k}</button>
`,
    },
    async root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        failWith('E_REACTIVITY', /dynamic value that is changed in place/),
      ),
  );
});

// Dynamic values are the fallback: a value a static rule types keeps that
// type with the opt-in, so the opt-in never loses a program the typed path
// lowers.
const TYPED = {
  'types.ts': `export type Page = { type: 'page'; value: number };
export type Gap = { type: 'ellipsis' };
export type Item = (Page | Gap) & { key: string };
`,
  'Link.svelte': `<script lang="ts">
  import type { Page } from './types.ts';
  let { page }: { page: Page } = $props();
</script>

<span>{page.value}</span>
`,
  'App.svelte': `<script lang="ts">
  import Link from './Link.svelte';
  import type { Item } from './types.ts';
  const items: Item[] = [
    { type: 'page', value: 1, key: 'a' },
    { type: 'ellipsis', key: 'b' },
    { type: 'page', value: 3, key: 'c' },
  ];
  let side = $state<'data-top' | 'data-left'>('data-top');
</script>

<button id="side" onclick={() => (side = side === 'data-top' ? 'data-left' : 'data-top')} {...{ title: 'x', [side]: '0' }}>side</button>
<p>{#each items as item (item.key)}{#if item.type === 'ellipsis'}<span>…</span>{:else}<Link page={item} />{/if}{/each}</p>
`,
};

test('with the opt-in, values a static rule types stay typed: the same program', async () => {
  const lowered = async dynamicValues => {
    let out;
    await withApp(
      TYPED,
      async root => (out = (await lower(await collect(root))).ir),
      dynamicValues,
    );
    return out;
  };
  const typed = await lowered(false);
  const dynamic = await lowered(true);
  // (A union of object types and a bag of a key from a finite set of names:
  // the same records and functions, no dynamic value.)
  assert.ok(!JSON.stringify(dynamic).includes('"dyn'));
  assert.deepEqual(dynamic.records, typed.records);
  assert.deepEqual(dynamic.functions, typed.functions);
  assert.deepEqual(dynamic.components, typed.components);
  const steps = interpret(dynamic, []);
  assert.deepEqual(texts(steps[0].state.dom).slice(1), ['1…3']);
});

test('with the opt-in, a value no static rule types is dynamic', async () => {
  const app = {
    'lib.js': 'export function wrap(k, n) { return { [k]: n, size: n }; }\n',
    'App.svelte': `<script lang="ts">
  import { wrap } from './lib.js';
  let n = $state(2);
  const o = $derived(wrap('k' + n, n * 2));
</script>

<button id="b" onclick={() => n++}>{o.size}</button>
`,
  };
  await withApp(app, async root => {
    const { ir } = await lower(await collect(root));
    // (An object of a key computed at run time is a dynamic value.)
    assert.ok(JSON.stringify(ir).includes('"dyn.get"'));
    const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
    assert.equal(texts(steps[0].state.dom)[0], '4');
    assert.equal(texts(steps[1].state.dom)[0], '6');
  });
  // (Without the opt-in, the typed path rejects it.)
  await withApp(
    app,
    async root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        e => e instanceof Diagnostic,
      ),
    false,
  );
});

test('a prop typed `any` with an `undefined` default: valid IR or a located rejection', async () => {
  // (bits-ui's Checkbox `name = undefined` of `name?: any`: the default once
  // took the dynamic contextual type, an initialiser of another type than
  // the cell's, invalid IR.)
  await withApp(
    {
      'Box.svelte': `<script lang="ts">
  let { name = undefined }: { name?: any } = $props();
</script>

<input type="checkbox" {name} />
`,
      'App.svelte': `<script lang="ts">
  import Box from './Box.svelte';
</script>

<Box name="terms" />
`,
    },
    async root => {
      let ir;
      try {
        ({ ir } = await lower(await collect(root)));
      } catch (e) {
        failWith('E_TYPE_UNION', /default of name/)(e);
        return;
      }
      interpret(ir, []);
    },
  );
});
