// Language for bits-ui's tooltip (M6 overlays): iterating a map's values,
// a fresh iterator's first result, once listeners, element tests of event
// targets, and generic components instantiated with their defaults.
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
  const root = await mkdtemp(path.resolve('.cache/tests/iteration-'));
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

test('map values in for-of, a first iteration result, a once listener', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const m = new Map<string, number>();
  m.set('a', 1);
  m.set('b', 2);
  let sum = $state(0);
  let first = $state('');
  let clicks = $state(0);
  function total() {
    let s = 0;
    for (const v of m.values()) s += v;
    for (const k of m.keys()) s += k.length;
    sum = s;
    const e = m.entries().next();
    first = e.done ? 'none' : e.value[0];
    const empty = new Map<string, number>().keys().next();
    if (!empty.done) first = 'wrong';
  }
  function once() {
    document.addEventListener('click', () => {
      clicks++;
    }, { once: true });
  }
</script>

<button id="total" onclick={total}>total</button>
<button id="once" onclick={once}>once</button>
<p id="out">{sum} {first} {clicks}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [
        { kind: 'click', id: 'total' },
        { kind: 'click', id: 'once' },
        { kind: 'click', id: 'total' },
        { kind: 'click', id: 'total' },
      ]);
      const out = i => text(byId(steps[i].state.dom, 'out'));
      assert.equal(out(1), '5 a 0');
      // The listener added during the click runs from the next click on, once.
      assert.equal(out(3), '5 a 1');
      assert.equal(out(4), '5 a 1');
    },
  );
});

test('a generic component takes its type parameters’ defaults', async () => {
  await withApp(
    {
      'Box.svelte': `<script lang="ts" module>
  type T = unknown;
</script>

<script lang="ts" generics="T = never">
  import type { Snippet } from 'svelte';
  let { children }: { children?: Snippet<[{ open: boolean; payload: [T] extends [never] ? null : T | null }]> } = $props();
</script>

{@render children?.({ open: true, payload: null })}
`,
      'App.svelte': `<script lang="ts">
  import Box from './Box.svelte';
</script>

<Box>{#snippet children({ open, payload })}<p id="out">{open} {payload === null}</p>{/snippet}</Box>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const [step] = interpret(ir, []);
      assert.equal(text(byId(step.state.dom, 'out')), 'true true');
    },
  );
});
