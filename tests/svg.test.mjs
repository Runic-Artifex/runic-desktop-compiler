// Inline SVG (M5): the elements and attributes each adapter lowers, React's
// prop-to-attribute mapping, and source-located rejections of what Blitz's
// SVG rendering cannot reproduce. Rendering parity is checked by the `icons`
// conformance case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const ENTRY = {
  svelte: [
    'main.js',
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
    'App.svelte',
  ],
  vue: [
    'main.js',
    "import { createApp } from 'vue';\nimport App from './App.vue';\nimport './style.css';\ncreateApp(App).mount('#root');\n",
    'App.vue',
  ],
  react: [
    'main.jsx',
    "import { createRoot } from 'react-dom/client';\nimport { App } from './App.jsx';\nimport './style.css';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
    'App.jsx',
  ],
};

/** Lowers a one-component app; `run` gets the IR (or the lowering's rejection). */
async function withApp(framework, source, run, css = '') {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve(`.cache/tests/svg-${framework}-`));
  try {
    const [entry, main, component] = ENTRY[framework];
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'style.css'),
      "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n" +
        css,
    );
    await writeFile(
      path.join(root, 'index.html'),
      `<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,
    );
    await writeFile(path.join(root, entry), main);
    await writeFile(path.join(root, component), source);
    await writeFile(
      path.join(root, 'runic.json'),
      JSON.stringify({ framework, entry, title: 'T' }),
    );
    return await run(root, component);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lowered = root => collect(root).then(g => lower(g));

/** Expects a diagnostic `code` located in `file`. */
const failWith = (code, file) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    e.source.column > 0) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
/** Tag and attributes of the elements inside the first <svg>, after each step. */
function svgs(steps) {
  return steps.map(s => {
    const svg = flat(s.state.dom).find(n => n.tag === 'svg');
    return flat([svg]).map(n => ({
      tag: n.tag,
      attrs: n.attrs,
      texts: n.children.filter(c => typeof c === 'string'),
    }));
  });
}

test('React maps SVG props as react-dom 19.3 sets them', async () => {
  await withApp(
    'react',
    `import { useState } from 'react';
export function App() {
  const [w, setW] = useState(2);
  return (
    <button id="go" onClick={() => setW(3)}>
      <svg xmlns="http://www.w3.org/2000/svg" width={24} height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" className="icon" aria-hidden data-n={w}>
        <path d="M1 1h4" fillRule="evenodd" fillOpacity="0.5" strokeDasharray="1 2" strokeDashoffset={1} strokeMiterlimit="4" strokeOpacity="0.5" stroke-width="3" /> <circle cx={12} cy="12" r="2" />
      </svg>
    </button>
  );
}
`,
    async root => {
      const { ir } = await lowered(root);
      const [before, after] = svgs(interpret(ir, [{ kind: 'click', id: 'go' }]));
      assert.deepEqual(before[0].attrs, {
        xmlns: 'http://www.w3.org/2000/svg',
        width: '24',
        height: '24',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        class: 'icon',
        // setValueForAttribute: true on aria-* and data-* is the string "true".
        'aria-hidden': 'true',
        'data-n': '2',
      });
      assert.deepEqual(before[1].attrs, {
        d: 'M1 1h4',
        'fill-rule': 'evenodd',
        'fill-opacity': '0.5',
        'stroke-dasharray': '1 2',
        'stroke-dashoffset': '1',
        'stroke-miterlimit': '4',
        'stroke-opacity': '0.5',
        'stroke-width': '3',
      });
      // JSX keeps a space between elements on one line as a text node.
      assert.deepEqual(before[0].texts, [' ']);
      assert.equal(after[0].attrs['stroke-width'], '3');
      assert.equal(after[0].attrs['data-n'], '3');
    },
  );
});

test('Svelte and Vue lower SVG attributes as written, with their whitespace rules', async () => {
  const markup = `<svg id="i" width="16" height={String(n)} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={n} class:on={n > 2}>
    <g transform="rotate(45 12 12)" opacity="0.5"><path d="M1 1" /> <rect x="1" y="1" width="2" height="2" rx="1" /></g>
    {#each [1, 2] as x}<circle cx={x} cy="1" r="1" />{/each}
  </svg>`;
  await withApp(
    'svelte',
    `<script lang="ts">\n  let n = $state(2);\n</script>\n<button id="go" onclick={() => (n = 3)}>${markup}</button>\n`,
    async root => {
      const { ir } = await lowered(root);
      const [before, after] = svgs(interpret(ir, [{ kind: 'click', id: 'go' }]));
      assert.deepEqual(
        before.map(n => n.tag),
        ['svg', 'g', 'path', 'rect', 'circle', 'circle'],
      );
      // Svelte drops whitespace-only text in the SVG namespace.
      assert.ok(before.every(n => n.texts.length === 0));
      assert.equal(before[0].attrs.viewBox, '0 0 24 24');
      assert.equal(before[0].attrs['stroke-width'], '2');
      assert.equal(after[0].attrs['stroke-width'], '3');
      assert.equal(after[0].attrs.class, 'on');
      assert.equal(after[4].attrs.cx, '1');
    },
  );
  await withApp(
    'vue',
    `<script setup lang="ts">
import { ref } from 'vue';
const n = ref(2);
</script>
<template>
  <button id="go" @click="n = 3">
    <svg width="16" :height="n" viewBox="0 0 24 24" fill="none" :stroke-width="n" :class="{ on: n > 2 }">
      <g transform="rotate(45 12 12)" opacity="0.5"><path d="M1 1" /> <rect x="1" y="1" width="2" height="2" rx="1" /></g>
      <circle v-for="x in [1, 2]" :key="x" :cx="x" cy="1" r="1" />
    </svg>
  </button>
</template>
`,
    async root => {
      const { ir } = await lowered(root);
      const [before, after] = svgs(interpret(ir, [{ kind: 'click', id: 'go' }]));
      assert.deepEqual(
        before.map(n => n.tag),
        ['svg', 'g', 'path', 'rect', 'circle', 'circle'],
      );
      // Vue condenses whitespace between elements on one line to a space.
      assert.deepEqual(before[1].texts, [' ']);
      assert.equal(before[0].attrs.height, '2');
      assert.equal(after[0].attrs['stroke-width'], '3');
      assert.equal(after[0].attrs.class, 'on');
    },
  );
});

test('SVG outside the verified surface is rejected with a location in every framework', async () => {
  const svelte = [
    ['<svg width="1" height="1"><path d="M0 0" /></svg>', 'E_SVG'], // no viewBox
    ['<svg viewBox="0 0 1 1">x</svg>', 'E_SVG'], // text
    ['<svg viewBox="0 0 1 1"><p>x</p></svg>', 'E_SVG'],
    ['<p><path d="M0 0" /></p>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1"><svg viewBox="0 0 1 1" /></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1"><text>x</text></svg>', 'E_TEMPLATE'],
    ['<svg viewBox="0 0 1 1" onclick={() => {}}></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" style="color: red"></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" style:color="red"></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" color="red"></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" opacity="0.5"></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" xmlns="urn:x"></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" tabindex="0"></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1"><path id="p" d="M0 0" /></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1"><path clip-path="url(#c)" d="M0 0" /></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" preserveAspectRatio="none"></svg>', 'E_TEMPLATE'],
  ];
  for (const [markup, code] of svelte)
    await withApp('svelte', `${markup}\n`, async (root, file) =>
      assert.rejects(lowered(root), failWith(code, file)),
    );
  const react = [
    ['<svg viewBox="0 0 1 1" preserveAspectRatio="none" />', 'E_JSX'],
    ['<svg viewBox="0 0 1 1" xmlnsXlink="http://www.w3.org/1999/xlink" />', 'E_JSX'],
    ['<svg viewBox="0 0 1 1"><path xlinkHref="#a" d="M0 0" /></svg>', 'E_JSX'],
    // An alias React has, for an attribute the IR does not accept.
    ['<svg viewBox="0 0 1 1"><path clipRule="evenodd" d="M0 0" /></svg>', 'E_JSX'],
    ['<svg viewBox="0 0 1 1"><path fill d="M0 0" /></svg>', 'E_JSX'],
    ['<svg viewBox="0 0 1 1" focusable="false" />', 'E_JSX'],
    ['<svg viewBox="0 0 1 1" onClick={() => {}} />', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" style={{ color: "red" }} />', 'E_SVG'],
    ['<svg viewBox="0 0 1 1">{"x"}</svg>', 'E_SVG'],
  ];
  for (const [jsx, code] of react)
    await withApp('react', `export function App() {\n  return ${jsx};\n}\n`, async (root, file) =>
      assert.rejects(lowered(root), failWith(code, file)),
    );
  const vue = [
    ['<svg viewBox="0 0 1 1" @click="() => {}"></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1" :style="{ color: \'red\' }"></svg>', 'E_SVG'],
    ['<svg viewBox="0 0 1 1">{{ "x" }}</svg>', 'E_SVG'],
  ];
  for (const [markup, code] of vue)
    await withApp(
      'vue',
      `<script setup lang="ts">\nconst unused = 1;\n</script>\n<template>\n  ${markup}\n</template>\n`,
      async (root, file) => assert.rejects(lowered(root), failWith(code, file)),
    );
  // CSS for SVG paint and geometry would be ignored natively.
  for (const decl of ['fill: red', 'stroke-width: 2px', 'r: 4px'])
    await withApp(
      'svelte',
      '<p>x</p>\n',
      async root => assert.rejects(lowered(root), failWith('E_CSS_PROPERTY', 'style.css')),
      `svg { ${decl}; }\n`,
    );
});
