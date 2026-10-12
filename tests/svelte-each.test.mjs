// Svelte `{#each}` blocks without an item binding: `{#each items, i}` and
// `{#each items}` (the parser's `context` is null). shadcn-svelte's
// carousel-demo writes `{#each Array(5), i}`; the adapter crashed on the
// missing pattern (E_INTERNAL) before they were lowered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** Lowers a one-component Svelte app; `run` gets its root. */
async function withApp(source, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/each-svelte-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'style.css'),
      "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
    );
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
    );
    await writeFile(
      path.join(root, 'main.js'),
      "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
    );
    await writeFile(path.join(root, 'App.svelte'), source);
    await writeFile(
      path.join(root, 'runic.json'),
      JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const text = (step, id) => textOf(flat(step.state.dom).find(n => n.attrs.id === id));

test('{#each} without an item binding renders its body per item, with and without the index', async () => {
  const source = `<script lang="ts">
  let items = $state(['a', 'b', 'c']);
  let none = $state<string[]>([]);
</script>
<button id="go" onclick={() => items.push('d')}>go</button>
<ul id="indexed">{#each items, i}<li>{i + 1}</li>{/each}</ul>
<p id="plain">{#each items}x{:else}none{/each}</p>
<p id="empty">{#each none}x{:else}none{/each}</p>
`;
  await withApp(source, async root => {
    const { ir } = await lower(await collect(root));
    const steps = interpret(ir, [{ kind: 'click', id: 'go' }]);
    assert.deepEqual(
      steps.map(s => [text(s, 'indexed'), text(s, 'plain'), text(s, 'empty')]),
      [
        ['123', 'xxx', 'none'],
        ['1234', 'xxxx', 'none'],
      ],
    );
  });
});
