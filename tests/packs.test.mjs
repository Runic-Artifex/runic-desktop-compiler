// Mapping packs (docs/design/M6-LIBRARIES.md#mapping-packs-d9): the clsx
// pack against vectors from the real package, run through the reference
// interpreter; the @lucide/svelte expansion; and the located rejections of
// packages without a pack, other versions and uncovered shapes. Rendering
// parity with Chromium is checked by the `packs` conformance case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';
import { vectors as live } from '../conformance/packs/clsx.mjs';

const committed = JSON.parse(readFileSync('conformance/packs/clsx-2.1.1.json', 'utf8'));

const ENTRY = {
  svelte: [
    'main.js',
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
    'App.svelte',
  ],
  react: [
    'main.jsx',
    "import { createRoot } from 'react-dom/client';\nimport { App } from './App.tsx';\nimport './style.css';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
    'App.tsx',
  ],
};

/** A one-component app (and extra files, such as fake packages); `run` gets its root. */
async function withApp(framework, source, run, files = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve(`.cache/tests/packs-${framework}-`));
  try {
    const [entry, main, component] = ENTRY[framework];
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'style.css'),
      "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
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
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return await run(root, component);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lowered = root => collect(root).then(g => lower(g));
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const byId = (step, id) => flat(step.state.dom).find(n => n.attrs.id === id);

/** Expects a diagnostic `code` located in `file`. */
const failWith = (code, file, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    e.source.column > 0 &&
    (!pattern || pattern.test(e.message))) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

test('the committed clsx vectors are the output of the installed clsx 2.1.1', () => {
  assert.equal(committed.version, '2.1.1');
  assert.deepEqual(committed.vectors, live);
});

test('clsx calls lowered by the pack agree with the real package on every vector', async () => {
  const { variables, vectors } = committed;
  const script = [
    "import clsx from 'clsx';",
    ...variables.map(v => `let ${v.name} = $state<${v.type}>(${v.a});`),
    `function go() {\n${variables.map(v => `  ${v.name} = ${v.b};`).join('\n')}\n}`,
  ].join('\n');
  const markup = [
    '<button id="go" onclick={go}>go</button>',
    ...vectors.map((v, i) => `<i id="v${i}" data-v={clsx(${v.args})}></i>`),
  ].join('\n');
  await withApp('svelte', `<script lang="ts">\n${script}\n</script>\n${markup}\n`, async root => {
    const { ir } = await lowered(root);
    assert.deepEqual(
      ir.meta.mappings.map(m => m.id),
      ['clsx@2.1.1'],
    );
    const steps = interpret(ir, [{ kind: 'click', id: 'go' }]);
    let compared = 0;
    vectors.forEach((v, i) =>
      ['a', 'b'].forEach((state, s) => {
        assert.equal(
          byId(steps[s], `v${i}`).attrs['data-v'],
          v[state],
          `clsx(${v.args}) in state ${state}`,
        );
        compared++;
      }),
    );
    assert.equal(compared, vectors.length * 2);
  });
});

test('clsx lowers in React components and module functions alike', async () => {
  const source = `import { useState } from 'react';
import { clsx } from 'clsx';
const cn = (parts: string[]) => clsx(parts);
export function App() {
  const [on, setOn] = useState(false);
  return <p id="p" className={clsx('a', on && 'b', { c: !on })} onClick={() => setOn(!on)}>{cn(['x', on ? 'y' : ''])}</p>;
}
`;
  await withApp('react', source, async root => {
    const steps = interpret((await lowered(root)).ir, [{ kind: 'click', id: 'p' }]);
    assert.deepEqual(
      steps.map(s => [byId(s, 'p').attrs.class, byId(s, 'p').children.join('')]),
      [
        ['a c', 'x'],
        ['a b', 'x y'],
      ],
    );
  });
});

test('lucide icons expand to the inline SVG of Icon.svelte with the package data', async () => {
  const source = `<script lang="ts">
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  let on = $state(false);
</script>
<button id="go" onclick={() => (on = !on)}>go</button>
<AlertCircle id="a" class={on && 'on'} data-icon="x" />
<Settings2 id="s" size={16} absoluteStrokeWidth={true} color={on ? 'red' : ''} role="img" aria-label="Settings" />
`;
  await withApp('svelte', source, async root => {
    const { ir } = await lowered(root);
    assert.deepEqual(
      ir.meta.mappings.map(m => m.id),
      ['@lucide/svelte@1.52.0', 'clsx@2.1.1'],
    );
    const steps = interpret(ir, [{ kind: 'click', id: 'go' }]);
    const a = byId(steps[0], 'a');
    assert.deepEqual(a.attrs, {
      xmlns: 'http://www.w3.org/2000/svg',
      width: '24',
      height: '24',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      // circle-alert, with its alias alert-circle.
      class: 'lucide lucide-circle-alert lucide-alert-circle lucide-icon',
      'aria-hidden': 'true',
      'data-icon': 'x',
      id: 'a',
    });
    assert.deepEqual(
      a.children.map(c => c.tag),
      ['circle', 'line', 'line'],
    );
    assert.equal(
      byId(steps[1], 'a').attrs.class,
      'lucide lucide-circle-alert lucide-alert-circle lucide-icon on',
    );
    const s = byId(steps[0], 's').attrs;
    assert.equal(s.width, '16');
    assert.equal(s['stroke-width'], '3'); // 2 * 24 / 16
    assert.equal(s.stroke, 'currentColor');
    assert.equal(s['aria-hidden'], undefined);
    assert.equal(s.role, 'img');
    assert.equal(byId(steps[1], 's').attrs.stroke, 'red');
  });
});

test('packages without a pack, other versions and uncovered shapes are rejected with a location', async () => {
  const fake = (name, version) => ({
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version,
      type: 'module',
      exports: './index.js',
    }),
    [`node_modules/${name}/index.js`]:
      'export function clsx() { return ""; }\nexport default clsx;\n',
  });
  const svelte = (script, markup = '') => `<script lang="ts">\n${script}\n</script>\n${markup}\n`;
  const cases = [
    // No pack for the package (compiled from source later in M6).
    [
      svelte("import left from 'left-lib';\nconst x = left();"),
      'E_DEPENDENCY',
      fake('left-lib', '1.0.0'),
    ],
    // A pack exists for another version only.
    [
      svelte("import clsx from 'clsx';\nconst x = clsx('a');"),
      'E_PACK_VERSION',
      fake('clsx', '2.0.0'),
    ],
    [svelte("import * as c from 'clsx';"), 'E_PACK'],
    [
      svelte(
        "import clsx from 'clsx';\nconst apply = (f: (a: string) => string) => f('a');\nconst c = apply(clsx);",
      ),
      'E_PACK',
    ],
    [svelte("import clsx from 'clsx';\nconst xs = ['a'];\nconst c = clsx(...xs);"), 'E_PACK'],
    [svelte("import clsx from 'clsx';\nconst k = 'a';\nconst c = clsx({ [k]: true });"), 'E_PACK'],
    [
      svelte("import clsx from 'clsx';\nconst o = { a: true };\nconst c = clsx({ ...o });"),
      'E_PACK',
    ],
    [svelte("import clsx from 'clsx';\nconst o = { a: true };\nconst c = clsx(o);"), 'E_PACK'],
    [svelte("import clsx from 'clsx';\nconst c = clsx(() => 'a');"), 'E_PACK'],
    [svelte("import clsx from 'clsx';\nconst c = clsx({ a: true, a: false });"), 'E_PACK'],
    [svelte("import { X } from '@lucide/svelte';"), 'E_PACK'],
    [svelte("import X from '@lucide/svelte/icons/x';", '<X name="x" />'), 'E_PACK'],
    [svelte("import X from '@lucide/svelte/icons/x';", '<X title="x" />'), 'E_PACK'],
    [svelte("import X from '@lucide/svelte/icons/x';", '<X onclick={() => {}} />'), 'E_PACK'],
    [svelte("import X from '@lucide/svelte/icons/x';", '<X>text</X>'), 'E_PACK'],
    [svelte("import X from '@lucide/svelte/icons/x';", '<X nonScalingStroke />'), 'E_PACK'],
    [
      svelte(
        "import X from '@lucide/svelte/icons/x';\nlet s = $state<number | null>(null);",
        '<X size={s} />',
      ),
      'E_PACK',
    ],
    [
      svelte("import X from '@lucide/svelte/icons/x';\nconst c = 'a';", '<X class="a {c}" />'),
      'E_PACK',
    ],
    // A component used as a value: its props type is outside the value model.
    [svelte("import X from '@lucide/svelte/icons/x';\nconst y = X;"), 'E_TYPE_UNSUPPORTED'],
  ];
  const wrong = [];
  for (const [source, code, files] of cases)
    await withApp(
      'svelte',
      source,
      async (root, file) =>
        lowered(root).then(
          () => wrong.push(`accepted: ${source}`),
          e =>
            e instanceof Diagnostic &&
            e.code === code &&
            e.source?.file === file &&
            e.source.line > 0
              ? undefined
              : wrong.push(`${source}\n  → ${e.code} ${JSON.stringify(e.source)} ${e.message}`),
        ),
      files,
    );
  assert.deepEqual(wrong, []);
});
