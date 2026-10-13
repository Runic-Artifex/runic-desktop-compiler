// What bits-ui's Slider and PinInput needed from the language and the host:
// `Math.min(...xs)` (and `max`, `hypot`) spreading an array, `e.composedPath()[0]`,
// and `CSS.supports(property, value)` of constant arguments
// (frontend/language.ts `mathSpread`, `element`, `cssSupports`;
// frontend/css-supports.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { cssCheck, interpret } from '../compiler/codegen.mjs';
import { CSS_SUPPORTS } from '../frontend/css-supports.ts';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/slider-pin-input-'));
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

const lowered = root => collect(root).then(g => lower(g));
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));

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

/** The text of `#id` after each of `clicks`. */
async function shown(root, id, clicks) {
  const { ir } = await lowered(root);
  const steps = interpret(
    ir,
    clicks.map(c => ({ kind: 'click', id: c })),
  );
  return steps.map(s => text(s.state.dom.find(n => typeof n !== 'string' && n.attrs.id === id)));
}

/** A number as the test apps print it: -0 apart from 0. */
const show = v => (Object.is(v, -0) ? '-0' : String(v));

// The arrays each click spreads, with the edge cases of the specification:
// none (Infinity, -Infinity, +0), NaN anywhere, -0 against +0 in both orders.
const NUMBER_LISTS = [
  [],
  [0, -0],
  [-0, 0],
  [3, NaN, 1],
  [1, 2, 3],
  [-Infinity, 5],
  [Infinity, -0],
  [5e-324, -5e-324],
  [3, 4],
];

test('Math.min, max and hypot spread an array as JavaScript calls them', async () => {
  const lists = NUMBER_LISTS.map(
    xs => `[${xs.map(x => (Object.is(x, -0) ? '-0' : String(x))).join(', ')}]`,
  );
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const lists: number[][] = [${lists.join(', ')}];
  let i = $state(0);
  let out = $state('');
  const show = (v: number): string => (v === 0 && 1 / v < 0 ? '-0' : String(v));
  function next() {
    const xs = lists[i];
    out = [Math.min(...xs), Math.max(...xs), Math.hypot(...xs), Math.min(2, ...xs, -1), Math.max(...xs, ...xs, 0)].map(show).join(' ');
    i++;
  }
</script>
<button id="b" onclick={next}>next</button>
<p id="out">{out}</p>`,
    },
    async root => {
      const got = await shown(
        root,
        'out',
        NUMBER_LISTS.map(() => 'b'),
      );
      const want = NUMBER_LISTS.map(xs =>
        [
          Math.min(...xs),
          Math.max(...xs),
          Math.hypot(...xs),
          Math.min(2, ...xs, -1),
          Math.max(...xs, ...xs, 0),
        ]
          .map(show)
          .join(' '),
      );
      assert.deepEqual(got.slice(1), want);
    },
  );
});

test('the elements of a spread array are converted by ToNumber', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let out = $state('');
  const strings: string[] = ['3', ' 10 ', ''];
  const flags: boolean[] = [true, false];
  const maybe: (number | null | undefined)[] = [null, 4];
  const missing: (number | undefined)[] = [undefined, 4];
  function run() {
    out = [Math.min(...strings), Math.max(...strings), Math.max(...flags), Math.min(...maybe), Math.min(...missing), Math.max(...['x'])].join(' ');
  }
</script>
<button id="b" onclick={run}>run</button>
<p id="out">{out}</p>`,
    },
    async root => {
      const [, got] = await shown(root, 'out', ['b']);
      const strings = ['3', ' 10 ', ''];
      assert.equal(
        got,
        [
          Math.min(...strings),
          Math.max(...strings),
          Math.max(...[true, false]),
          Math.min(...[null, 4]),
          Math.min(...[undefined, 4]),
          Math.max(...['x']),
        ].join(' '),
      );
    },
  );
});

test('Math.min spreading something other than an array of primitives is rejected', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const s = new Set([1, 2]);
  const m = Math.min(...s);
</script>
<p>{m}</p>`,
    },
    async root => {
      await assert.rejects(lowered(root), failWith('E_EXPRESSION', 'App.svelte', /is an array/));
    },
  );
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const xs: { v: number }[] = [{ v: 1 }];
  const m = Math.max(...(xs as unknown as number[]));
</script>
<p>{m}</p>`,
    },
    async root => {
      await assert.rejects(lowered(root), e => e instanceof Diagnostic && e.source?.line > 0);
    },
  );
});

// bits-ui's Slider: `const target = e.composedPath()[0] ?? e.target`, and a
// held event read after its dispatch, whose path is empty.
test('composedPath()[0] is the target during the dispatch and undefined after it', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let out = $state('');
  let held: PointerEvent | undefined;
  function down(e: PointerEvent) {
    const target = e.composedPath()[0] ?? e.target;
    out = String(target === e.target) + ' ' + String(e.composedPath()[0] === undefined);
    held = e;
  }
  function later() {
    out = String(held!.composedPath()[0] === undefined);
  }
</script>
<div onpointerdown={down}><span id="inner">inner</span></div>
<button id="later" onclick={later}>later</button>
<p id="out">{out}</p>`,
    },
    async root => {
      const got = await shown(root, 'out', ['inner', 'later']);
      assert.deepEqual(got.slice(1), ['true false', 'true']);
    },
  );
});

test('composedPath() itself is rejected', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let n = $state(0);
  function down(e: PointerEvent) {
    n = e.composedPath().length;
  }
</script>
<div id="d" onpointerdown={down}>{n}</div>`,
    },
    async root => {
      await assert.rejects(
        lowered(root),
        failWith('E_EVENT', 'App.svelte', /composedPath\(\)\[0\]/),
      );
    },
  );
});

test('CSS.supports of constant arguments answers as Chromium measured', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const ios = typeof window !== 'undefined' && window?.CSS?.supports('-webkit-touch-callout', 'none');
  const direct = CSS.supports('-webkit-touch-callout', 'none');
</script>
<p id="out">{String(ios)} {String(direct)}</p>`,
    },
    async root => {
      const [got] = await shown(root, 'out', []);
      assert.equal(got, 'false false');
    },
  );
});

test('CSS.supports of other arguments is rejected', async () => {
  for (const [call, pattern] of [
    ["CSS.supports(name, 'none')", /constant strings/],
    ["CSS.supports('display', 'grid')", /not measured/],
    ["CSS.supports('(display: grid)')", /constant strings/],
  ])
    await withApp(
      {
        'App.svelte': `<script lang="ts">
  let name = $state('display');
  const v = ${call};
</script>
<p>{String(v)}</p>`,
      },
      async root => {
        await assert.rejects(lowered(root), failWith('E_CALL', 'App.svelte', pattern));
      },
    );
});

test("the table's native answers are what Stylo parses", () => {
  const keys = Object.keys(CSS_SUPPORTS);
  const declarations = keys.map(k => {
    const at = k.indexOf(': ');
    return [k.slice(0, at), k.slice(at + 2)];
  });
  const { invalid } = cssCheck('', declarations);
  keys.forEach((k, i) =>
    assert.equal(CSS_SUPPORTS[k].native, !invalid.includes(i), `native support of ${k}`),
  );
});

// bits-ui's Slider builds its thumbs with `Array.from({ length: 1 }, …)` and
// PinInput its cells with `Array.from({ length }).map(…)`.
const LENGTHS = ['3', '0', '-1', 'NaN', '2.7', '-0.5', 'Infinity', '2 ** 32'];

test('Array.from({ length: n }, f) converts n by ToLength and calls f with each index', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const lengths: number[] = [${LENGTHS.join(', ')}];
  let i = $state(0);
  let out = $state('');
  function next() {
    const n = lengths[i];
    try {
      const a = Array.from({ length: n }, (_, k) => k * 2);
      const b = Array.from({ length: n }).map((_, k) => String(k));
      const c = Array.from({ length: n }, () => 'x');
      out = a.join(',') + ' ' + b.join(',') + ' ' + c.length;
    } catch (e) {
      out = (e as Error).name + ': ' + (e as Error).message;
    }
    i++;
  }
</script>
<button id="b" onclick={next}>next</button>
<p id="out">{out}</p>`,
    },
    async root => {
      const got = await shown(
        root,
        'out',
        LENGTHS.map(() => 'b'),
      );
      const want = LENGTHS.map(src => {
        const n = Function(`return ${src}`)();
        try {
          const a = Array.from({ length: n }, (_, k) => k * 2);
          const b = Array.from({ length: n }).map((_, k) => String(k));
          const c = Array.from({ length: n }, () => 'x');
          return a.join(',') + ' ' + b.join(',') + ' ' + c.length;
        } catch (e) {
          return e.name + ': ' + e.message;
        }
      });
      assert.deepEqual(got.slice(1), want);
    },
  );
});

test('Array.from of other array-like objects or without a mapping arrow is rejected', async () => {
  for (const [call, pattern] of [
    ['Array.from({ length: 2, 0: 1 }, (_x, i) => i)', /\{ length: n \}/],
    ['Array.from({ length: 2 }) as number[]', /mapping arrow/],
    ['Array.from({ length: 2 }, (_, i) => i, null)', /this argument/],
  ])
    await withApp(
      {
        'App.svelte': `<script lang="ts">
  const v = ${call};
</script>
<p>{String(v)}</p>`,
      },
      async root => {
        await assert.rejects(lowered(root), failWith('E_BUILTIN', 'App.svelte', pattern));
      },
    );
});

// bits-ui's `isValidIndex(index, arr: unknown[])`.
test('a function of an unknown[] parameter is specialised per call site', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  function validIndex(index: number, arr: unknown[]): boolean {
    return index >= 0 && index < arr.length;
  }
  const nums: number[] = [1, 2];
  const words: string[] = ['a'];
</script>
<p id="out">{validIndex(1, nums)} {validIndex(1, words)}</p>`,
    },
    async root => {
      const [got] = await shown(root, 'out', []);
      assert.equal(got, 'true false');
    },
  );
});

/**
 * A source package (svelte-sonner at its pinned version, standing in for
 * bits-ui's Slider) whose module builds style objects and thumb records as
 * the Slider does, and whose declaration file types them as bits-ui's does.
 */
const SLIDER_PACKAGE = {
  'node_modules/svelte-sonner/package.json': JSON.stringify({
    name: 'svelte-sonner',
    version: '1.2.1',
    type: 'module',
    sideEffects: false,
    svelte: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', svelte: './dist/index.js', default: './dist/index.js' },
    },
  }),
  'node_modules/svelte-sonner/dist/attrs.js': `export function createAttrs(component, parts) {
    const out = {};
    for (const part of parts) out[part] = \`data-\${component}-\${part}\`;
    return out;
}
`,
  'node_modules/svelte-sonner/dist/attrs.d.ts': `export declare function createAttrs<const T extends readonly string[]>(component: string, parts: T): {
    [K in T[number]]: string;
};
`,
  'node_modules/svelte-sonner/dist/index.js': `import { createAttrs } from "./attrs.js";
const attrs = createAttrs("slider", ["thumb"]);
export function styles(left) {
    const style = { position: "absolute" };
    style.left = left;
    return style;
}
export class Thumbs {
    items = Array.from({ length: 2 }, (_, i) => ({ role: "slider", n: i + 1, [attrs.thumb]: "" }));
    style = { position: "fixed", ...styles("2%") };
}
export class Layered {
    style = { zIndex: 2, ...styles("2%") };
}
`,
  'node_modules/svelte-sonner/dist/index.d.ts': `import type * as CSS from "csstype";
export type StyleProperties = CSS.Properties & {
    [str: \`--\${string}\`]: any;
};
declare const attrs: { thumb: string };
export declare function styles(left: string): StyleProperties;
export declare class Thumbs {
    readonly items: {
        readonly [attrs.thumb]: "";
        readonly role: string;
        readonly n: number;
    }[];
    readonly style: {
        position: string;
        accentColor?: import("csstype").Property.AccentColor | undefined;
        left?: import("csstype").Property.Left<0 | (string & {})> | undefined;
    };
}
export declare class Layered {
    readonly style: {
        zIndex: import("csstype").Property.ZIndex;
        position: string;
        left?: import("csstype").Property.Left<0 | (string & {})> | undefined;
    };
}
`,
};

// bits-ui's Slider: `getThumbStyles` builds `const style = { position:
// "absolute" }` and sets properties on it; its range styles spread one
// (`{ position: "absolute", ...getRangeStyles(…) }`), declared as a copy of
// csstype's properties; its thumbs are `{ role: "slider", …,
// [sliderAttrs.thumb]: "" }`, whose declared type cannot name the computed key.
test("bits-ui's Slider style objects and thumb records keep their keys and values", async () => {
  await withApp(
    {
      ...SLIDER_PACKAGE,
      'App.svelte': `<script lang="ts">
  import { Thumbs, styles } from 'svelte-sonner';
  const t = new Thumbs();
  const s = styles('5%');
</script>
<div id="a" {...t.items[1]}></div>
<p id="n">{t.items[1].n + 1}</p>
<p id="s">{Object.keys(s).join(',')} {s['position']} {s['left']}</p>
<p id="r">{Object.keys(t.style).join(',')} {t.style['position']} {t.style['left']}</p>`,
    },
    async root => {
      const { ir } = await lowered(root);
      const [start] = interpret(ir, []);
      const el = id => start.state.dom.find(n => typeof n !== 'string' && n.attrs.id === id);
      assert.deepEqual(el('a').attrs, { id: 'a', role: 'slider', n: '2', 'data-slider-thumb': '' });
      assert.equal(text(el('n')), '3');
      assert.equal(text(el('s')), 'position,left absolute 5%');
      // (The spread's position replaces the earlier one in its place.)
      assert.equal(text(el('r')), 'position,left absolute 2%');
    },
  );
});

// A number among the entries is read as a number, not printed as a style
// object prints it, so such a literal is not lowered as a style dictionary.
test('a csstype-typed object with a number entry is not a style dictionary', async () => {
  await withApp(
    {
      ...SLIDER_PACKAGE,
      'App.svelte': `<script lang="ts">
  import { Layered } from 'svelte-sonner';
  const t = new Layered();
</script>
<p>{t.style['zIndex']}</p>`,
    },
    async root => {
      await assert.rejects(
        lowered(root),
        failWith('E_OBJECT', 'node_modules/svelte-sonner/dist/index.js', /Dictionary objects/),
      );
    },
  );
});
