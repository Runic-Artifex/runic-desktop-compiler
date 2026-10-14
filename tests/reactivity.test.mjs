// Reactivity of deep state, aliasing and staleness
// (docs/design/REACTIVITY-ALIASING.md): the adversarial fixtures the
// frameworks and the native model disagree on are rejected where they
// stand, and those the model covers agree with the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const lowered = root => collect(root).then(g => lower(g));
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const shown = (step, id) =>
  text(flat(step.state.dom).find(n => n.attrs.id === id))
    .replace(/\s+/g, ' ')
    .trim();
const click = id => ({ kind: 'click', id });

/** Expects a diagnostic `code` located in `file` (and matching `pattern`). */
const failWith = (code, file, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    (!pattern || pattern.test(e.message))) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

test('effects that write what they read run again, through proxies too (R4)', async () => {
  const { ir } = await lowered('fixtures/effect-self-svelte');
  const steps = interpret(ir, [click('dump'), click('grow'), click('dump')], {});
  assert.equal(shown(steps[0], 'values'), '3 3 3 1 1');
  // Svelte 5.57.1 in Chromium: every effect runs, then each one its write
  // invalidated, in passes; one writing back the value it read runs once
  // more and stops (case effect-self).
  assert.equal(
    shown(steps[1], 'log'),
    'len 5 | count 5 | box 5 | mirror 0 0 | len 4 | count 4 | box 4 | mirror 1 1 | len 3 | count 3 | box 3',
  );
  assert.equal(
    shown(steps[3], 'log'),
    'len 5 | count 6 | box 6 | mirror 1 1 | len 4 | count 5 | box 5 | mirror 2 2 | len 3 | count 4 | box 4 | count 3 | box 3',
  );
});

test('a Vue watcher writing what it reads is rejected', async () => {
  // Vue does not run a watchEffect again for its own writes (case
  // effect-self's Vue fixture in Chromium: `len 5 | count 5 | box 5`).
  await assert.rejects(
    lowered('fixtures/effect-self-vue'),
    failWith('E_EFFECT', 'App.vue', /writes items, which it depends on/),
  );
});

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(name, files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve(`.cache/tests/${name}-`));
  try {
    await cp('fixtures/alias-reads-svelte/assets', path.join(root, 'assets'), { recursive: true });
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
    for (const [file, body] of Object.entries(all)) await writeFile(path.join(root, file), body);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A React app whose App.tsx is `app`; `run` gets its root. */
async function withReactApp(name, app, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve(`.cache/tests/${name}-`));
  try {
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
      'main.tsx':
        "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './App.tsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
      'App.tsx': app,
      'runic.json': JSON.stringify({ framework: 'react', entry: 'main.tsx', title: 'T' }),
    };
    for (const [file, body] of Object.entries(all)) await writeFile(path.join(root, file), body);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('React refs and module state mutated while rendering are rejected', async () => {
  // React does not re-render for refs and renders as often as it decides;
  // the cross-framework matrix's row of values mutated while rendering.
  await withReactApp(
    'ref-render',
    `import { useEffect, useRef, useState } from 'react';
const log: string[] = [];
function Child({ onRender, n }: { onRender: () => number; n: number }) {
  const seen = onRender();
  return <p id="child">{n} {seen}</p>;
}
export function App() {
  const [n, setN] = useState(0);
  const renders = useRef(0);
  useEffect(() => {
    log.push(\`effect \${renders.current}\`);
  });
  return (
    <main>
      <Child n={n} onRender={() => (renders.current += 1)} />
      <button id="inc" onClick={() => setN(n + 1)}>inc</button>
    </main>
  );
}
`,
    root => assert.rejects(lowered(root), failWith('E_REF', 'App.tsx', /may run while rendering/)),
  );
  await withReactApp(
    'module-render',
    `import { useState } from 'react';
let renders = 0;
function bump() {
  renders += 1;
  return renders;
}
export function App() {
  const [n, setN] = useState(0);
  const count = bump();
  return <button id="inc" onClick={() => setN(n + 1)}>{n} {count}</button>;
}
`,
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_REACTIVITY', 'App.tsx', /mutated and read while rendering/),
      ),
  );
});

test('untrack in a template is rejected (R7)', async () => {
  // Svelte memoizes the expression: `{untrack(() => state.count)}` keeps its
  // first value (case untrack-template in Chromium).
  await assert.rejects(
    lowered('fixtures/untrack-template-svelte'),
    failWith('E_REACTIVITY', 'App.svelte', /reads values with untrack\(\)/),
  );
});

test('a prop holding a raw object its child mutates is rejected, one holding $state is not (R6)', async () => {
  // Svelte passes the raw object as it is: the child's write is not
  // reactive, and shows when the block renders for another prop (case
  // prop-raw in Chromium).
  await assert.rejects(
    lowered('fixtures/prop-raw-svelte'),
    failWith('E_REACTIVITY', 'Child.svelte', /item is a prop that may hold a plain object/),
  );
  await withApp(
    'prop-owned',
    {
      'App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  let owned = $state({ count: 0 });
  let rows = $state([{ count: 0 }, { count: 1 }]);
</script>
<Child item={owned} />
{#each rows as row}<Child item={row} />{/each}
<p id="parent">{owned.count}</p>
`,
      'Child.svelte': `<script lang="ts">
  let { item }: { item: { count: number } } = $props();
</script>
<button onclick={() => (item.count += 1)}>{item.count}</button>
`,
    },
    root => lowered(root),
  );
});

test('a raw object a Vue ref holds, changed directly, is rejected (R6)', async () => {
  // Vue tracks writes through the ref's reactive proxy only (case
  // raw-target-vue in Chromium: the view shows the raw write at its next
  // render).
  await assert.rejects(
    lowered('fixtures/raw-target-vue'),
    failWith('E_REACTIVITY', 'App.vue', /r holds an object that raw also holds/),
  );
});

test('Vue watchers whose order in a flush may differ from their declaration order are rejected', async () => {
  // Vue 3.5 in Chromium (case watch-order's fixture): runtime-core queues a
  // component's watchers in the order the flush triggers them, so a handler
  // writing b, then a runs watch(b) first (`b2 | effect 2 | a2`, status a2);
  // Runic runs them in declaration order.
  await assert.rejects(
    lowered('fixtures/watch-order-vue'),
    failWith('E_EFFECT', 'App.vue', /before the one at line 12.*b, which this watcher depends on/),
  );
  // A computed value first evaluated in a watchEffect's cleanup takes over
  // its links: the watchEffect runs after the watch declared below it from
  // the second flush on (`cleanup 0 d2 | watch 1 | watch 2 | cleanup 1 d4`).
  await assert.rejects(
    lowered('fixtures/watch-cleanup-computed-vue'),
    failWith(
      'E_EFFECT',
      'App.vue',
      /before the one at line 13.*evaluates the computed value doubled/,
    ),
  );
  // Three watchEffects over deep refs logging into one array: their signals
  // are array elements and lengths, which the analysis does not tell apart.
  await assert.rejects(
    lowered('fixtures/deep-tracking-vue'),
    failWith(
      'E_EFFECT',
      'App.vue',
      /before the one at line 11.*array elements, lengths or iteration/,
    ),
  );
  // Watchers of instances a write triggers directly run in creation order:
  // a branch shown before a list and an item inserted at its front run last
  // (`row 1 3 | row 2 3 | row 3 3 | row 0 3` in Chromium; natively document
  // order, `row 0 3 | row 3 3 | row 1 3 | row 2 3`).
  await assert.rejects(
    lowered('fixtures/watch-instances-deep-vue'),
    failWith(
      'E_EFFECT',
      'App.vue',
      /instance created here after those of instances that follow it/,
    ),
  );
  // Items of one list whose watchers prop updates trigger: Vue runs them in
  // document order (`row 3 2 | row 1 2 | row 2 2` in Chromium), native code
  // in reverse (`row 2 2 | row 1 2 | row 3 2`: it updates a list's blocks
  // from the last one; the differential found it, the interpreter agrees
  // with Chromium).
  await assert.rejects(
    lowered('fixtures/watch-list-vue'),
    failWith('E_EFFECT', 'App.vue', /other items of this list.*in reverse order/),
  );
});

test('Vue watchers in a proven order agree with Chromium', async () => {
  // Case watch-declared in Chromium: a later watcher's signals are a subset
  // of what an earlier one reads in every run (a ref; a record field through
  // a prop), in both write orders; two watchers no handler triggers together.
  const steps = interpret(
    (await lowered('fixtures/watch-declared-vue')).ir,
    ['dump', 'list-a', 'a-list', 'dump', 'x', 'y', 'x', 'dump', 'deep-n', 'n-deep', 'dump'].map(
      click,
    ),
    {},
  );
  assert.equal(shown(steps[4], 'log'), 'effect 1 1 | watch a 1 | effect 2 2 | watch a 2');
  assert.equal(shown(steps[8], 'log'), 'watch x 1 | watch y 1 | watch x 2');
  assert.equal(
    shown(steps[11], 'log'),
    'child effect 1 1 | child watch 1 | child effect 2 2 | child watch 2',
  );
  // Case watch-instances: watchers of instances a prop update triggers run
  // while the parent patches them, in document order, also for an instance
  // created after the ones it precedes.
  const instances = interpret(
    (await lowered('fixtures/watch-instances-vue')).ir,
    ['bump', 'dump', 'show', 'bump', 'dump'].map(click),
    {},
  );
  assert.equal(shown(instances[2], 'log'), 'row 1 1 | row 2 1');
  assert.equal(shown(instances[5], 'log'), 'row 0 2 | row 1 2 | row 2 2');
  // Case teardown-vue: a computed value read in a cleanup is settled where
  // the template reads it at its root (cleanups read live values).
  const teardown = interpret(
    (await lowered('fixtures/teardown-vue')).ir,
    ['bump', 'dump', 'twice', 'dump', 'hide', 'dump'].map(click),
    {},
  );
  assert.equal(
    shown(teardown[4], 'log'),
    'cleanup 1/3 1/3 d6 | watch cleanup 1/3 3 | child cleanup 1/3 3',
  );
  assert.equal(
    shown(teardown[6], 'log'),
    'cleanup 3/13 3/13 d26 | watch cleanup 3/13 13 | before unmount 13 3 | child cleanup 3/3 13 | unmounted 13 3',
  );
});

test('writes of an equal value change nothing; reverse, sort and fill write the elements they change (R4)', async () => {
  // Case array-writes (Svelte 5.57.1 in Chromium): the effect reading the
  // middle element does not run for reverse, sort or fill, which leave it as
  // it is; fill stores a new proxy of the plain object at each index.
  const svelte = interpret(
    (await lowered('fixtures/array-writes-svelte')).ir,
    [
      'dump',
      'reverse',
      'dump',
      'sort',
      'dump',
      'fill-same',
      'dump',
      'fill-first',
      'dump',
      'fill-objs',
      'bump',
      'dump',
    ].map(click),
    {},
  );
  assert.equal(shown(svelte[3], 'log'), 'first 3');
  assert.equal(shown(svelte[5], 'log'), 'first 1');
  assert.equal(shown(svelte[7], 'log'), '');
  assert.equal(shown(svelte[9], 'log'), 'first 7');
  assert.equal(shown(svelte[11], 'objs'), '6 5');
  // Case equal-writes (Vue 3.5 in Chromium): a deep ref's field, element or
  // a ref set to its value, a palindrome reversed and a push notify nothing
  // the watchEffect reads (hasChanged); a reversal that changes it does.
  const vue = interpret(
    (await lowered('fixtures/equal-writes-vue')).ir,
    [
      'dump',
      'same',
      'dump',
      'palindrome',
      'dump',
      'flip',
      'dump',
      'push',
      'dump',
      'flip',
      'dump',
    ].map(click),
    {},
  );
  assert.equal(shown(vue[3], 'log'), '');
  assert.equal(shown(vue[7], 'log'), '');
  assert.equal(shown(vue[9], 'log'), '');
  assert.equal(shown(vue[11], 'log'), 'run 0 9 0');
});

test('a Vue shallowRef mutated in place is rejected', async () => {
  // shallowRef tracks .value only: Vue shows an in-place change at the
  // component's next render (the cross-framework matrix's shallow row).
  await assert.rejects(
    lowered('fixtures/shallow-vue'),
    failWith('E_REACTIVITY', 'App.vue', /box is mutated in place/),
  );
});

test("writes through a constant holding a context's $state object are writes through its proxy (R8)", async () => {
  // The context's value comes through a module function's parameter and
  // another's result (case alias-writes in Chromium).
  const steps = interpret(
    (await lowered('fixtures/alias-writes-svelte')).ir,
    ['bump', 'add', 'bump', 'add', 'clear'].map(click),
    {},
  );
  assert.equal(shown(steps[1], 'owner'), '1');
  assert.equal(shown(steps[4], 'owner'), '2 1,2');
  assert.equal(shown(steps[4], 'seen'), '2 2');
  assert.equal(shown(steps[5], 'seen'), '2 0');
  // A constant of a raw object mutated in place stays rejected.
  await withApp(
    'raw-const',
    {
      'App.svelte': `<script lang="ts">
  const raw = { count: 0 };
  const alias = raw;
</script>
<button onclick={() => (alias.count += 1)}>{alias.count}</button>
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_REACTIVITY', 'App.svelte', /alias is mutated in place/),
      ),
  );
});

test("writes through aliases of a Vue ref's contents are writes through its proxy (R8)", async () => {
  // Vue 3.5 in Chromium (case alias-writes-vue): a constant, a parameter
  // and a function result holding the ref's reactive proxy; after the ref
  // is given a new object, the constant keeps the old one.
  const steps = interpret(
    (await lowered('fixtures/alias-writes-vue')).ir,
    ['bump', 'add', 'twice', 'replace', 'bump', 'add'].map(click),
    {},
  );
  assert.equal(shown(steps[1], 'alias'), '1 0');
  assert.equal(shown(steps[3], 'owner'), '2 1');
  assert.equal(shown(steps[4], 'owner'), '10 7');
  assert.equal(shown(steps[5], 'alias'), '3 1');
  assert.equal(shown(steps[6], 'owner'), '10 7,10');
  // A raw object a ref holds, changed through a constant of it, stays
  // rejected (R6).
  await assert.rejects(
    lowered('fixtures/raw-target-vue'),
    failWith('E_REACTIVITY', 'App.vue', /r holds an object that raw also holds/),
  );
});

test('proxies never write their target and take its properties lazily (R3)', async () => {
  // Svelte 5.57.1 in Chromium (case proxy-target): $state(INITIAL) leaves
  // INITIAL as it was, so a reset to it shows the original items.
  const target = interpret(
    (await lowered('fixtures/proxy-target-svelte')).ir,
    [
      'show',
      'add',
      'toggle',
      'show',
      'reset',
      'show',
      'edit',
      'show',
      'reset-form',
      'deep',
      'show',
    ].map(click),
    {},
  );
  assert.equal(shown(target[1], 'shown'), '2 false Ada 1 1 false');
  assert.equal(shown(target[3], 'todos'), 'a+,b,c');
  assert.equal(shown(target[4], 'shown'), '2 false Ada 1 1 false');
  assert.equal(shown(target[5], 'todos'), 'a,b');
  assert.equal(shown(target[8], 'shown'), '2 false Ada 1 1 false');
  assert.equal(shown(target[9], 'form'), 'Ada x');
  assert.equal(shown(target[11], 'shown'), '2 false Ada 1 1 false');
  // Case proxy-lazy: a raw write after the first read stays invisible, one
  // right after storing is visible.
  const lazy = interpret(
    (await lowered('fixtures/proxy-lazy-svelte')).ir,
    ['raw-write', 'touch', 'push-write', 'later-write', 'touch'].map(click),
    {},
  );
  assert.equal(shown(lazy[2], 'held'), 'first');
  assert.equal(shown(lazy[3], 'items'), 'touch 0,renamed');
  assert.equal(shown(lazy[5], 'items'), 'touch 0,renamed,touch 2');
});

test('an effect depends on a nested object it is the first to read through a proxy (R3, R4)', async () => {
  // Case deep-tracking in Chromium: the effect reading `items[0].done` runs
  // again after the item is toggled. Its first run makes the proxy of
  // items[0]; Svelte creates it with the array's proxy (`with_parent`), so
  // it is not a source the effect created itself.
  const steps = interpret(
    (await lowered('fixtures/deep-tracking-svelte')).ir,
    ['dump', 'toggle-first', 'dump'].map(click),
    {},
  );
  assert.equal(shown(steps[1], 'log'), 'a 1 | first false | count 2');
  assert.equal(shown(steps[3], 'log'), 'first true');
});

test('changing an array in place under a proxy is reported (R3)', async () => {
  await withApp(
    'raw-array',
    {
      'App.svelte': `<script lang="ts">
  const initial = [1, 2];
  let list = $state(initial);
  let n = $state(0);
</script>
<p id="list">{list.length} {n}</p>
<button id="raw" onclick={() => { initial.push(3); n += 1; }}>raw</button>
`,
    },
    async root => {
      const steps = interpret((await lowered(root)).ir, [click('raw')], {});
      assert.equal(steps[1].outcome.rejected?.code, 'E_UNSUPPORTED');
      assert.match(
        steps[1].outcome.rejected.message,
        /changed in place other than through its proxy/,
      );
    },
  );
});

test('teardowns read deep state and derived values as before the flush (R5)', async () => {
  // Svelte 5.57.1 in Chromium (case teardown-proxy): an effect's cleanup and
  // a child's onDestroy read proxies as they were before the flush's first
  // write, and a derived value they read is computed from those values.
  const steps = interpret(
    (await lowered('fixtures/teardown-proxy-svelte')).ir,
    ['bump', 'dump', 'twice', 'dump', 'hide', 'dump'].map(click),
    {},
  );
  assert.equal(shown(steps[2], 'log'), 'cleanup 0/0 0/0 d0');
  assert.equal(shown(steps[4], 'log'), 'cleanup 1/1 1/1 d2');
  assert.equal(shown(steps[6], 'log'), 'destroy 3 3 | cleanup 3/3 3/3 d6');
});
