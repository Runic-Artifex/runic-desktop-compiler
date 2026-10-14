// A function value converted to another function type keeps its identity
// (frontend `adaptFunction`, IR `fn.adapted`): JavaScript passes the same
// function, so an app's `(evt, n) => log.push(…)` (of result `number`)
// given to `on(list, cb)` and `off(list, cb)` taking a `(evt: string, n:
// number) => void` is removed by `off`, as embla's EventHandler removes
// shadcn-svelte's `onSelect` (an untyped package's dictionary registry:
// tests/script-dom-embla.test.mjs). In Svelte, React and Vue, through the
// reference interpreter; the conversion is cached per function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** An app of `files` for `framework` (entry `entry`); `run` gets its root. */
async function withApp(framework, entry, files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve(`.cache/tests/function-identity-${framework}-`));
  try {
    const all = {
      'index.html': `<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,
      'runic.json': JSON.stringify({ framework, entry, title: 'T' }),
      ...PKG,
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

/**
 * A module keeping listeners in a list (source packages are compiled for
 * Svelte apps only: the untyped package's form is
 * tests/script-dom-embla.test.mjs').
 */
const PKG = {
  'registry.ts': `export type CallbackType = (evt: string, n: number) => void;
export function on(list: CallbackType[], cb: CallbackType): void {
  list.push(cb);
}
export function off(list: CallbackType[], cb: CallbackType): void {
  const i = list.indexOf(cb);
  if (i >= 0) list.splice(i, 1);
}
export function emit(list: CallbackType[], evt: string, n: number): void {
  list.slice().forEach(e => e(evt, n));
}
`,
};

/** The script every framework runs: `a` and `b` return the new length. */
const SCRIPT = `function run(): string {
  const log: string[] = [];
  const list: CallbackType[] = [];
  const a = (evt: string, n: number) => log.push('a' + evt + n);
  const b = (evt: string, n: number) => log.push('b' + evt + n);
  on(list, a);
  on(list, b);
  emit(list, 'x', 1);
  off(list, a);
  emit(list, 'x', 2);
  off(list, b);
  emit(list, 'x', 3);
  return log.join(' ') + ' ' + list.length;
}
const text = run();`;
const WANT = 'ax1 bx1 bx2 0';

const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const find = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const f = find(n.children, id);
    if (f) return f;
  }
};

async function check(framework, entry, files) {
  const { out, ir } = await withApp(framework, entry, files, async root => {
    const { ir } = await lower(await collect(root));
    const [start] = interpret(ir, []);
    return { out: text(find(start.state.dom, 'out')), ir };
  });
  assert.equal(out, WANT);
  // One converted value per function: a maker per conversion, cached.
  const body = JSON.stringify(ir.functions);
  assert.match(body, /"name":"fn\.adapted"/);
  assert.equal(ir.functions.filter(f => f.name === 'adapt').length, 1);
}

test('Svelte: a converted callback is removed by the same function', () =>
  check('svelte', 'main.js', {
    'main.js':
      "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root') });\n",
    'App.svelte': `<script lang="ts">
  import { on, off, emit, type CallbackType } from './registry.ts';
  ${SCRIPT}
</script>
<p id="out">{text}</p>
`,
  }));

test('React: a converted callback is removed by the same function', () =>
  check('react', 'main.tsx', {
    'main.tsx':
      "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './App.tsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
    'App.tsx': `import React from 'react';
import { on, off, emit, type CallbackType } from './registry.ts';
export function App() {
  ${SCRIPT}
  return <p id="out">{text}</p>;
}
`,
  }));

test('Vue: a converted callback is removed by the same function', () =>
  check('vue', 'main.js', {
    'main.js':
      "import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#root');\n",
    'App.vue': `<script setup lang="ts">
import { on, off, emit, type CallbackType } from './registry.ts';
${SCRIPT}
</script>
<template><p id="out">{{ text }}</p></template>
`,
  }));
