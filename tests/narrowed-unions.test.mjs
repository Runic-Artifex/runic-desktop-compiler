// Values of a union the census narrowed program-wide (frontend/unions.ts)
// where a prop a discriminant narrowed holds another member: bits-ui's
// Slider, whose `step` and `value` share `number | number[]`. The values
// keep their own type (functions without a declared result, boxes), records
// expected of `map` take their computed keys by value, and a call passing a
// value its function's parameter does not hold is rejected where it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/narrowed-unions-'));
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
function findDeep(nodes, id) {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const inner = findDeep(n.children, id);
    if (inner) return inner;
  }
  return undefined;
}
const shown = (step, id) => text(findDeep(step.state.dom, id));

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

// The Slider's root in small: a discriminated props type whose `value`
// and `step` share `number | number[]`, every site multiple (the
// discriminant narrows `value` to `number[]`) with a number step (the
// census narrows the union to `number`).
const slider = call => ({
  'Slider.svelte': `<script lang="ts">
  import { boxWith } from 'svelte-toolbelt';
  type Single = { type: 'single'; value?: number; onValueChange?: (v: number) => void };
  type Multiple = { type: 'multiple'; value?: number[]; onValueChange?: (v: number[]) => void };
  type Props = (Single | Multiple) & { step?: number | number[] };
  let { type, value = $bindable(), step = 1, onValueChange = () => {} }: Props = $props();
  const read = () => value;
  const box = boxWith(
    () => value,
    v => {
      value = v;
      ${call}
    },
  );
  const max = $derived(Array.isArray(step) ? Math.max(...step) : step * 10);
</script>

<p id="v">{type} {String(read())} {String(box.current)} {max}</p>
`,
  'App.svelte': `<script lang="ts">
  import Slider from './Slider.svelte';
  let value = $state([1, 2]);
</script>

<button id="add" onclick={() => (value = [...value, value.length + 1])}>add</button>
<Slider type="multiple" bind:value step={5} />
`,
});

test('a getter and a box of a discriminated prop keep its member where the census narrowed its union to another', async () => {
  await withApp(slider(''), async root => {
    const { ir } = await lowered(root);
    const steps = interpret(ir, [{ kind: 'click', id: 'add' }]);
    assert.equal(shown(steps[0], 'v'), 'multiple 1,2 1,2 50');
    assert.equal(shown(steps[1], 'v'), 'multiple 1,2,3 1,2,3 50');
  });
});

test('a call passing a value its function parameter does not hold is rejected at the argument', async () => {
  await withApp(slider('// @ts-expect-error - we know\n      onValueChange(v);'), root =>
    assert.rejects(
      lowered(root),
      failWith('E_CALL', 'Slider.svelte', /parameter holds .*@ts-expect-error/),
    ),
  );
});

/**
 * A source package (svelte-sonner at its pinned version, standing in for
 * bits-ui's Slider) whose untyped module maps values to tick records with a
 * computed key, declared as bits-ui declares `ticksPropsArr`.
 */
const TICKS_PACKAGE = {
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
  'node_modules/svelte-sonner/dist/index.js': 'export { Ticks } from "./ticks.svelte.js";\n',
  'node_modules/svelte-sonner/dist/ticks.svelte.js': `import { createAttrs } from "./attrs.js";
const attrs = createAttrs("slider", ["tick"]);
export class Ticks {
    values = $state([10, 20]);
    ticks = $derived.by(() => {
        const values = this.values;
        return values.map((v, i) => {
            const last = i === values.length - 1;
            return { "data-value": v, "data-last": last ? "" : undefined, [attrs.tick]: "" };
        });
    });
}
`,
  'node_modules/svelte-sonner/dist/index.d.ts': 'export { Ticks } from "./ticks.svelte.js";\n',
  'node_modules/svelte-sonner/dist/ticks.svelte.d.ts': `declare const attrs: { tick: string };
export declare class Ticks {
    values: number[];
    readonly ticks: {
        readonly [attrs.tick]: "";
        readonly "data-value": number;
        readonly "data-last": string | undefined;
    }[];
}
`,
};

// bits-ui's Slider `ticksPropsArr`: `steps.map((tickValue, i) => { …; return
// { "data-value": tickValue, …, [sliderAttrs.tick]: "" } })`, whose
// declared element names the computed key by the module's constant.
test('records expected of map take their computed keys by value', async () => {
  await withApp(
    {
      ...TICKS_PACKAGE,
      'App.svelte': `<script lang="ts">
  import { Ticks } from 'svelte-sonner';
  const t = new Ticks();
</script>

{#each t.ticks as tick}<span {...tick}>{tick['data-value'] + 1}</span>{/each}
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const spans = interpret(ir, [])[0].state.dom.filter(
        n => typeof n !== 'string' && n.tag === 'span',
      );
      assert.deepEqual(
        spans.map(n => [n.attrs, text(n)]),
        [
          [{ 'data-value': '10', 'data-slider-tick': '' }, '11'],
          [{ 'data-value': '20', 'data-last': '', 'data-slider-tick': '' }, '21'],
        ],
      );
    },
  );
});

// embla's `align` (`AlignmentOptionType = 'start' | 'center' | 'end' |
// ((viewSize, snapSize, index) => number)`): a literal's value counts as the
// union of the literal members of its kind (the census traces it as its base
// type), so values of a literal and of a function reaching the union are
// rejected at the union, located, instead of failing IR validation; one
// given literals only is a string, its `typeof` test decided.
const align = given => ({
  'App.svelte': `<script lang="ts">
  type Align = 'start' | 'center' | ((n: number) => number);
  const a: { align: Align } = { align: 'center' };
  ${given}
  const v = typeof a.align === 'function' ? 0 : a.align;
</script>
<p id="v">{v}</p>
`,
});

test('a union of literals and a function given a literal and a function is rejected, located', async () => {
  await withApp(align('const b: { align?: Align } = { align: (n: number) => n * 2 };'), root =>
    assert.rejects(lowered(root), failWith('E_TYPE_UNION', 'App.svelte', /several members/)),
  );
});

test('a union of literals and a function given literals only is a string, and a variable typed by its initialiser takes its values', async () => {
  await withApp(align(''), async root => {
    const { ir } = await lowered(root);
    assert.equal(shown(interpret(ir, [])[0], 'v'), 'center');
  });
});
