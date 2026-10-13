// Internal errors on valid input and `null!` element refs: uncontrolled
// checkboxes and radio buttons (crates/runic-ir validate.rs, interp.rs), a
// subclass field re-declared with an object of the base field's shape but
// another record (frontend/classes.ts `overrideValue`), object literal
// methods with fewer parameters and callback props whose expression body
// has a value (frontend/language.ts, frontend/adapters/svelte.ts), array
// literals whose objects list their keys in different orders (shadcn-svelte's
// combobox `countries`), and `$state<HTMLButtonElement>(null!)` (the
// shadcn-svelte combobox examples).
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
  const root = await mkdtemp(path.resolve('.cache/tests/ir-errors-null-refs-'));
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
const find = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const inner = find(n.children, id);
    if (inner) return inner;
  }
  return undefined;
};

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

/** The steps of interpreting the app at `root` with `actions`. */
async function run(root, actions) {
  const { ir } = await lowered(root);
  return interpret(ir, actions);
}

const click = id => ({ kind: 'click', id });

test('a checkbox without bind:checked is uncontrolled: the user toggles it, and events read its state', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let watched = $state(false);
  let changes = $state(0);
  let size = $state('');
</script>
<input id="plain" type="checkbox" />
<input id="preset" type="checkbox" checked />
<input id="watched" type="checkbox" onchange={(e) => { watched = e.currentTarget.checked; changes++; }} />
<input id="small" type="radio" name="size" value="s" onchange={(e) => (size = e.currentTarget.value)} />
<input id="large" type="radio" name="size" value="l" onchange={(e) => (size = e.currentTarget.value)} />
<p id="state">{watched} {changes} {size}</p>
`,
    },
    async root => {
      const steps = await run(root, [
        click('plain'),
        click('preset'),
        click('watched'),
        click('watched'),
        click('small'),
        click('large'),
      ]);
      const checked = (i, id) => find(steps[i].state.dom, id).checked;
      const shown = i => text(find(steps[i].state.dom, 'state'));
      assert.equal(checked(0, 'plain'), false);
      assert.equal(checked(0, 'preset'), true);
      assert.equal(checked(1, 'plain'), true);
      assert.equal(checked(2, 'preset'), false);
      assert.equal(shown(3), 'true 1 ');
      assert.equal(shown(4), 'false 2 ');
      assert.equal(checked(5, 'small'), true);
      assert.equal(shown(5), 'false 2 s');
      assert.equal(checked(6, 'small'), false);
      assert.equal(checked(6, 'large'), true);
      assert.equal(shown(6), 'false 2 l');
    },
  );
});

const model = (base, sub, read = 'this.opts.k') => ({
  'App.svelte': `<script lang="ts">
  import { Sub, Base } from './model.svelte.ts';
  const s = new Sub();
  const t = new Base();
</script>
<p id="o">{s.show()} {t.show()}</p>
`,
  'model.svelte.ts': `${base.includes('make()') || sub.includes('make()') ? "function make(): { k: string; n: number } { return { k: 'b', n: 2 }; }\n" : ''}export class Base {
  ${base}
  show(): string {
    return ${read};
  }
}
export class Sub extends Base {
  ${sub}
}
`,
});

test('a subclass re-declaring a base field with an object of the same shape lowers in the base field’s key order', async () => {
  await withApp(
    model(
      "opts: { n: number; k: string } = { n: 1, k: 'a' };",
      "opts: { k: string; n: number } = { n: 2, k: 'b' };",
      'JSON.stringify(this.opts)',
    ),
    async root => {
      const steps = await run(root, []);
      assert.equal(text(find(steps[0].state.dom, 'o')), '{"n":2,"k":"b"} {"n":1,"k":"a"}');
    },
  );
});

test('a re-declared field whose object differs from the base field’s in key order or getters is rejected, located', async () => {
  const cases = [
    [
      "opts: { n: number; k: string } = { n: 1, k: 'a' };",
      "opts: { k: string; n: number } = { k: 'b', n: 2 };",
      'E_OBJECT',
    ],
    [
      "opts: { n: number; k: string } = { n: 1, k: 'a' };",
      'opts: { k: string; n: number } = make();',
      'E_CLASS',
    ],
    [
      "opts: { n: number; k: string } = { get n() { return 1; }, get k() { return 'a'; } };",
      "opts: { n: number; k: string } = { n: 2, k: 'b' };",
      'E_OBJECT',
    ],
    [
      "opts: { n: number; k: string } = { n: 1, k: 'a' };",
      "opts: { n: number; k: string } = { get n() { return 2; }, get k() { return 'b'; } };",
      'E_CLASS',
    ],
  ];
  for (const [base, sub, code] of cases)
    await withApp(model(base, sub), root =>
      assert.rejects(lowered(root), failWith(code, 'model.svelte.ts')),
    );
});

test('functions with fewer parameters in object literals and callback props with a valued body lower', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import Trigger from './Trigger.svelte';
  let open = $state(false);
  let n = $state(0);
  const handlers: { on: (v: number) => void } = { on: () => { n += 10; } };
</script>
<Trigger onclick={() => (open = !open)} other={() => n++} />
<button id="h" onclick={() => handlers.on(1)}>h</button>
<p id="o">{open} {n}</p>
`,
      'Trigger.svelte': `<script lang="ts">
  let { onclick, other }: { onclick: () => void; other: () => void } = $props();
</script>
<button id="trigger" onclick={() => { onclick(); other(); }}>trigger</button>
`,
    },
    async root => {
      const steps = await run(root, [click('trigger'), click('h')]);
      assert.deepEqual(
        steps.map(s => text(find(s.state.dom, 'o'))),
        ['false 0', 'true 1', 'true 11'],
      );
    },
  );
});

test('objects of an array literal listing their keys in different orders lower; key-observing built-ins reject them', async () => {
  const xs = `const xs = [
    { code: '', value: '', continent: '', label: 'Select' },
    { code: 'ar', value: 'argentina', label: 'Argentina', continent: 'South America' },
  ];`;
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  ${xs}
</script>
<p id="o">{#each xs as x}{x.label}:{x.continent};{/each}</p>
`,
    },
    async root => {
      const steps = await run(root, []);
      assert.equal(text(find(steps[0].state.dom, 'o')), 'Select:;Argentina:South America;');
    },
  );
  // (Also where the call is lowered before the array, through a spread.)
  for (const script of [
    `${xs}\n  const show = (x: (typeof xs)[number]) => JSON.stringify(x);`,
    `const show = (x: { code: string; value: string; continent: string; label: string }) => JSON.stringify({ ...x });\n  ${xs}`,
    `${xs}\n  const show = (x: (typeof xs)[number]) => Object.keys(x).join();`,
  ])
    await withApp(
      {
        'App.svelte': `<script lang="ts">
  ${script}
</script>
{#each xs as x}<p>{show(x)}</p>{/each}
`,
      },
      root =>
        assert.rejects(
          lowered(root),
          failWith('E_OBJECT', 'App.svelte', /key order is not tracked/),
        ),
    );
});

const REF = `<script lang="ts">
  import { tick } from 'svelte';
  import Trigger from './Trigger.svelte';
  let open = $state(false);
  let triggerRef = $state<HTMLButtonElement>(null!);
  let late = $state<HTMLButtonElement>(null!);
  function closeAndFocus() {
    open = false;
    tick().then(() => {
      triggerRef.focus();
    });
  }
</script>
<Trigger bind:ref={triggerRef} onclick={() => (open = !open)} />
{#if open}<button id="close" onclick={closeAndFocus}>close</button>{/if}
<button id="early" onclick={() => late.focus()}>early</button>
{#if open}<button id="late" bind:this={late}>late</button>{/if}
<p id="o">{open}</p>
`;
const TRIGGER = `<script lang="ts">
  let { ref = $bindable(null), onclick }: { ref?: HTMLButtonElement | null; onclick: () => void } = $props();
</script>
<button id="trigger" bind:this={ref} {onclick}>trigger</button>
`;

test('$state<Element>(null!) is a nullable element ref: reads work once bound and throw a TypeError before', async () => {
  await withApp({ 'App.svelte': REF, 'Trigger.svelte': TRIGGER }, async root => {
    const steps = await run(root, [click('trigger'), click('close'), click('early')]);
    assert.equal(text(find(steps[1].state.dom, 'o')), 'true');
    assert.equal(text(find(steps[2].state.dom, 'o')), 'false');
    assert.equal(steps[2].outcome?.rejected, undefined);
    // `late` is null while closed: the `!` read throws, as in JavaScript.
    assert.equal(steps[3].outcome?.rejected?.code, 'E_THROW');
    assert.match(steps[3].outcome.rejected.message, /^TypeError: Cannot read properties of null/);
  });
});

// (A variable of an element type holds null too: `const el: HTMLElement = null!`.)
test('null! where the IR type holds no null is rejected, located', async () => {
  for (const script of [
    'let n = $state<number>(null!);',
    'const n: number = null!;',
    'let el = $state<HTMLButtonElement>(null!);\n  const f = () => null!;',
  ])
    await withApp(
      {
        'App.svelte': `<script lang="ts">
  ${script}
</script>
<p>x</p>
`,
      },
      root => assert.rejects(lowered(root), failWith('E_TYPE_UNSUPPORTED', 'App.svelte')),
    );
});
