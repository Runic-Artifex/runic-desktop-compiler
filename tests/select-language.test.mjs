// What bits-ui's Select needed of the language layer (M6, case
// bits-select): component styles of global rules, data attributes, bindings
// of members and after spreads, `{#if}` narrowing, subclass fields the base
// constructor cannot observe, values and classes known at build time (a
// parameter traced to its calls, the classes the program constructs), bare
// returns, style dictionaries and style records of numbers, passive
// listeners that take nothing, and runed's Previous. The interpreter runs
// each program.
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
  const root = await mkdtemp(path.resolve('.cache/tests/select-language-'));
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
/** The texts of the top-level elements (whitespace between them left out). */
const texts = dom => dom.filter(n => typeof n !== 'string').map(text);
const failWith = (code, pattern) => e =>
  (e instanceof Diagnostic && e.code === code && (!pattern || pattern.test(e.message))) ||
  assert.fail(`expected ${code}, got ${e.code}: ${e.message}`);

test('component styles of :global rules join the stylesheet; scoped ones are rejected', async () => {
  await withApp(
    {
      'App.svelte': `<div class="x">x</div>

<style>
  :global(.x) {
    color: red;
  }
</style>
`,
    },
    async root => {
      const graph = await collect(root);
      assert.match(graph.css, /\.x\s*\{\s*color:\s*red/);
      await lower(graph);
    },
  );
  await withApp(
    {
      'App.svelte': `<div class="x">x</div>

<style>
  .x {
    color: red;
  }
</style>
`,
    },
    async root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        failWith('E_TEMPLATE', /Scoped component styles/),
      ),
  );
});

test('data attributes read through dataset; no pointer is ever captured', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let out = $state('');
  function down(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    out = (el.dataset.fruitName ?? '-') + (el.dataset.missing ?? '-') + el.hasPointerCapture(e.pointerId);
  }
</script>

<button id="b" data-fruit-name="apple" onpointerdown={down}>{out}</button>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(text(steps[1].state.dom[0]), 'apple-false');
    },
  );
});

test('a binding after a spread gives the prop; a member can be bound', async () => {
  await withApp(
    {
      'Child.svelte': `<script lang="ts">
  let { value = $bindable(), id }: { value?: string; id: string } = $props();
</script>

<button {id} onclick={() => (value = (value ?? '') + '!')}>{value}</button>
`,
      'App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  class Holder {
    v = $state('a');
  }
  const h = new Holder();
  const bag = { value: 'from the spread', id: 'c' };
</script>

<Child {...bag} bind:value={h.v} />
<p>{h.v}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [{ kind: 'click', id: 'c' }]);
      assert.deepEqual(texts(steps[0].state.dom), ['a', 'a']);
      assert.deepEqual(texts(steps[1].state.dom), ['a!', 'a!']);
    },
  );
});

test('{#if} narrows the expressions of its branches', async () => {
  await withApp(
    {
      'Child.svelte': `<script lang="ts">
  let { label }: { label: string } = $props();
</script>

<span>{label}</span>
`,
      'App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  let v: string | undefined = $state();
</script>

<button id="b" onclick={() => (v = 'set')}>b</button>
{#if v !== undefined}<Child label={v} />{/if}
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.deepEqual(texts(steps[0].state.dom), ['b']);
      assert.deepEqual(texts(steps[1].state.dom), ['b', 'set']);
    },
  );
});

test('subclass fields a base constructor cannot observe exist from the start', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  class Base {
    opts: { n: number };
    seen = 0;
    constructor(opts: { n: number }) {
      this.opts = opts;
      this.seen = this.opts.n;
      $effect(() => {
        this.report();
      });
    }
    report() {}
  }
  class Sub extends Base {
    readonly flag = true;
    total = $derived(this.seen + 1);
  }
  const s = new Sub({ n: 4 });
</script>

<p>{s.flag} {s.total}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, []);
      assert.equal(text(steps[0].state.dom[0]), 'true 5');
    },
  );
  // A base constructor that reads a subclass field at once: rejected.
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  class Base {
    seen = '';
    constructor() {
      this.seen = String(this.flag());
    }
    flag(): boolean {
      return false;
    }
  }
  class Sub extends Base {
    readonly on = true;
    flag() {
      return this.on;
    }
  }
  const s = new Sub();
</script>

<p>{s.seen}</p>
`,
    },
    async root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        failWith('E_CLASS', /uses this before they exist/),
      ),
  );
});

test('values known at build time: a parameter traced to its calls, the classes constructed', async () => {
  await withApp(
    {
      'state.svelte.ts': `export class Single {
  readonly isMulti = false;
  value = $state('one');
}
export class Multi {
  readonly isMulti = true;
  value = $state<string[]>([]);
}
export function create(props: { type: 'single' | 'multiple'; label: string }) {
  const { type } = props;
  return type === 'single' ? new Single() : new Multi();
}
export type Selection =
  | { type: 'single'; selected: string }
  | { type: 'multiple'; selected: string[] };
`,
      'Picker.svelte': `<script lang="ts">
  import { create, type Selection } from './state.svelte.ts';
  let { type }: { type: 'single' | 'multiple' } = $props();
  const root = create({ type, label: 'x' });
  const selection: Selection = $derived.by(() => {
    if (root.isMulti) return { type: 'multiple', selected: [] };
    return { type: 'single', selected: 'one' };
  });
</script>

<p>{root.isMulti ? 'multi' : 'single'}</p>
{#if selection.type === 'single'}<p>{selection.selected}</p>{:else}<p>{selection.selected.length}</p>{/if}
`,
      'App.svelte': `<script lang="ts">
  import Picker from './Picker.svelte';
</script>

<Picker type="single" />
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, []);
      assert.deepEqual(texts(steps[0].state.dom), ['single', 'one']);
      // The selection is the single member's record: a union would be a class reference.
      assert.ok(!JSON.stringify(ir.records).includes('"classes"'));
    },
  );
});

test('a bare return makes the result undefined', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const small = (n: number) => {
    if (n > 1) return;
    return 'small';
  };
  const out = String(small(2)) + small(1);
</script>

<p>{out}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      assert.equal(text(interpret(ir, [])[0].state.dom[0]), 'undefinedsmall');
    },
  );
});

test('passive listeners are covered where they take nothing', async () => {
  const app = handler => ({
    'App.svelte': `<script lang="ts">
  import { on } from 'svelte/events';
  let el: HTMLElement | undefined = $state();
  let wheels = $state(0);
  $effect(() => {
    if (!el) return;
    return on(el, 'wheel', ${handler}, { passive: true });
  });
</script>

<div bind:this={el}>{wheels}</div>
`,
  });
  await withApp(app('() => (wheels += 1)'), async root => {
    await lower(await collect(root));
  });
  await withApp(app('(e: WheelEvent) => (wheels += e.deltaY)'), async root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      failWith('E_EVENT', /passive: true is not covered/),
    ),
  );
});

test("runed's Previous holds the getter's value from before", async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { Previous } from 'runed';
  let count = $state(0);
  const previous = new Previous(() => count);
</script>

<button id="b" onclick={() => (count += 1)}>{count} {previous.current ?? -1}</button>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [
        { kind: 'click', id: 'b' },
        { kind: 'click', id: 'b' },
      ]);
      assert.deepEqual(
        steps.map(s => text(s.state.dom[0])),
        ['0 -1', '1 0', '2 1'],
      );
    },
  );
});

test('a cancelled pointerdown keeps focus where it is', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let log = $state('');
</script>

<button id="t" onfocus={() => (log += 't')}>t</button>
<div tabindex="-1" onfocus={() => (log += 'c')}>
  <span id="i" onpointerdown={e => e.preventDefault()} onclick={() => (log += '!')}>i</span>
  <span id="j">j</span>
</div>
<p>{log}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [
        { kind: 'click', id: 't' },
        { kind: 'click', id: 'i' },
        { kind: 'click', id: 'j' },
      ]);
      // The click still runs; focus only moves on the press not cancelled.
      assert.deepEqual(
        steps.map(s => texts(s.state.dom).at(-1)),
        ['', 't', 't!', 't!c'],
      );
    },
  );
});

// shadcn-svelte's select-scrollable: `items` computed from other constants
// (`timezones.flatMap((group) => group.options)`) reaches bits-ui's Select
// through the wrapper's rest props, declared with an optional `disabled`.
// `option(value, label)` writes each option literal.
const listApp = option => ({
  'List.svelte': `<script lang="ts">
  let { items = [] }: { items?: { value: string; label: string; disabled?: boolean }[] } = $props();
</script>

<ul>{#each items as item (item.value)}<li>{item.label}:{item.disabled === undefined ? 'u' : 'd'}</li>{/each}</ul>
`,
  'Wrapper.svelte': `<script lang="ts">
  import List from './List.svelte';
  import type { ComponentProps } from 'svelte';
  let { ...restProps }: ComponentProps<typeof List> = $props();
</script>

<List {...restProps} />
`,
  'App.svelte': `<script lang="ts">
  import Wrapper from './Wrapper.svelte';
  import List from './List.svelte';
  const groups = [
    { label: 'A', options: [${option('a', 'A1')}, ${option('b', 'B1')}] },
    { label: 'B', options: [${option('c', 'C')}] },
  ];
  const items = groups.flatMap((group) => group.options);
</script>

<Wrapper {items} />
<List {items} />
<p>{groups[0].options[1] === items[1]}</p>
`,
});

test('a constant computed from literals takes the records of the prop it reaches through rest props', async () => {
  await withApp(
    listApp((v, l) => `{ value: '${v}', label: '${l}' }`),
    async root => {
      const { ir } = await lower(await collect(root));
      // The literals' record is the prop's throughout (no run-time
      // RunicAttrsError where the wrapper's rest props reach List), and the
      // objects keep their identity.
      const app = ir.components.find(c => c.name === 'App');
      const items = app.cells.find(c => c.name === 'items');
      assert.deepEqual(
        ir.records[items.type.array.record].fields.map(f => f.name),
        ['value', 'label', 'disabled'],
      );
      const [step] = interpret(ir, []);
      assert.deepEqual(texts(step.state.dom), ['A1:uB1:uC:u', 'A1:uB1:uC:u', 'true']);
    },
  );
});

test('a computed constant whose records do not fit the prop it reaches through rest props is rejected at its site', async () => {
  // (A field the prop's type does not have: the objects are not values of it.)
  await withApp(
    listApp((v, l) => `{ value: '${v}', label: '${l}', note: '' }`),
    async root => {
      await assert.rejects(lower(await collect(root)), e => {
        failWith(
          'E_PROPS',
          /^items reaches List's prop items through rest props with objects of other fields than its type's \(\{ value, label, note \}\[\] for \{ value, label, disabled \}\[\]\)/,
        )(e);
        assert.equal(e.source?.file, 'App.svelte');
        return true;
      });
    },
  );
});
