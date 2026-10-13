// Program globals of package modules (packages compiled from source and pack
// ports) are created when code first reaches them, which may be after an app
// module constant that calls into the package (`export const d = new
// CalendarDate(…)`, whose constructor reads the @internationalized/date
// port's month-length tables). JavaScript evaluates a package's modules
// before the modules importing them, so the program initialises each package
// global before every global whose initialiser reaches it. Before this, the
// native app read the uninitialised table at start-up (a RangeError panic);
// the native run is the conformance case `default-parameters`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as real from '@internationalized/date';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files`; `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/global-order-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
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

/** The globals an expression reads directly or through the functions it calls or creates. */
function reached(ir, init) {
  const out = new Set();
  const seen = new Set();
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.op === 'global') out.add(node.global);
    if ((node.op === 'call' || node.op === 'closure') && !seen.has(node.function)) {
      seen.add(node.function);
      walk(ir.functions[node.function].body);
    }
    Object.values(node).forEach(walk);
  };
  walk(init);
  return out;
}

test('a module constant constructing pack classes is initialised after the pack tables it reads', async () => {
  await withApp(
    {
      'dates.ts': `import { CalendarDate, CalendarDateTime, toZoned, type DateValue } from '@internationalized/date';
export const values: DateValue[] = [
  new CalendarDate(2024, 2, 29),
  new CalendarDateTime(2023, 2, 28, 1, 2),
  toZoned(new CalendarDateTime(2025, 6, 7, 8, 9), 'UTC'),
];
export const first = values[0].add({ months: 1 });
`,
      'App.svelte': `<script lang="ts">
  import { first, values } from './dates.ts';
</script>
<p id="out">{first.toString()} {values.map(v => v.toString()).join(' ')}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const names = ir.globals.map(g => g.name);
      const at = name => names.indexOf(name);
      // The app constants come after every global their initialisers reach.
      for (const name of ['values', 'first']) {
        assert.ok(at(name) >= 0, name);
        for (const g of reached(ir, ir.globals[at(name)].init))
          assert.ok(g < at(name), `${name} reaches ${names[g]}, initialised after it`);
      }
      assert.ok(at('LEAP_DAYS') < at('values') && at('STANDARD_DAYS') < at('values'), names.join());
      const [step] = interpret(ir, []);
      const find = nodes =>
        nodes.flatMap(n =>
          typeof n === 'string' ? [] : n.attrs.id === 'out' ? [n] : find(n.children),
        );
      const values = [
        new real.CalendarDate(2024, 2, 29),
        new real.CalendarDateTime(2023, 2, 28, 1, 2),
        real.toZoned(new real.CalendarDateTime(2025, 6, 7, 8, 9), 'UTC'),
      ];
      const first = values[0].add({ months: 1 });
      assert.equal(text(find(step.state.dom)[0]), `${first} ${values.join(' ')}`);
    },
  );
});
