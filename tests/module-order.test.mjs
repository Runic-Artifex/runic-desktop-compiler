// Deterministic builds: the collector's modules come in a stable order,
// whatever order the bundler's concurrent transforms finish in (kit-docs'
// markdown pages, reached only through a lazy glob, came in a different
// order from run to run, and so did their constants in the IR). The order:
// from the entry, each module before its static imports (in source order)
// and its glob entries (in key order), depth first; then the rest by path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';

const PAGES = ['zeta', 'alpha', 'mid', 'beta', 'omega', 'delta', 'kappa', 'gamma'];

/** A Svelte app whose pages are reached through a lazy glob; `run` gets its root. */
async function withApp(run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/module-order-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const files = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
      'style.css':
        "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
      'runic.json': JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
      'titles.ts': `const pages = import.meta.glob<{ title: string[] }>('./pages/*.ts', { eager: true });
export const titles: string[] = Object.keys(pages);
`,
      'App.svelte': `<script lang="ts">
  import { titles } from './titles.ts';
</script>
<p id="out">{titles.join(' ')}</p>
`,
      ...Object.fromEntries(
        PAGES.map(p => [`pages/${p}.ts`, `export const title: string[] = ['${p}'];\n`]),
      ),
    };
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('modules are collected in a stable order, and the IR is the same on every run', async () => {
  await withApp(async root => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const graph = await collect(root);
      const ids = [...graph.modules.keys()].map(id => path.relative(root, id));
      runs.push({ ids, ir: JSON.stringify((await lower(graph)).ir) });
    }
    // Entry first, its imports depth first, the glob's pages in key order.
    const local = runs[0].ids.filter(id => !id.startsWith('..') && !id.includes('node_modules'));
    assert.deepEqual(local.slice(0, 2), ['main.js', 'App.svelte']);
    assert.deepEqual(
      local.filter(id => id.startsWith('pages/')),
      [...PAGES].sort().map(p => `pages/${p}.ts`),
    );
    assert.ok(local.indexOf('titles.ts') < local.indexOf('pages/alpha.ts'));
    for (const r of runs.slice(1)) {
      assert.deepEqual(r.ids, runs[0].ids);
      assert.equal(r.ir, runs[0].ir);
    }
  });
});
