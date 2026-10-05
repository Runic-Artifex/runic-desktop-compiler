// Ordinary-language needs of bits-ui's overlay layers (M6 step 7,
// docs/design/M6-OVERLAYS.md): tuples of different types, dictionary
// objects in for-in and Object.keys/values, functions with properties,
// event interfaces (`instanceof`, `in`), keyboard event copies, selectors
// in `closest`, and the svelte-toolbelt helpers the layers compose
// listeners with. The interpreter runs each program.
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
  const root = await mkdtemp(path.resolve('.cache/tests/overlay-language-'));
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

const lowered = root => collect(root).then(g => lower(g));
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const failWith = (code, pattern) => e =>
  (e instanceof Diagnostic && e.code === code && (!pattern || pattern.test(e.message))) ||
  assert.fail(`expected ${code}, got ${e.code}: ${e.message}`);

test('tuples of different types: map entries, destructuring, literal indices', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const m = new Map<string, number>();
  let out = $state('');
  function run() {
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    const entries = [...m];
    const parts: string[] = [];
    for (const [k, v] of entries) parts.push(k + v);
    const last = entries[entries.length - 1];
    const pair: [string, boolean] = ['x', true];
    out = parts.join(',') + ' ' + last[0] + ' ' + pair[1];
  }
</script>

<button id="b" onclick={run}>{out}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(text(steps[1].state.dom[0]), 'a1,b2,c3 c true');
    },
  );
});

test('dictionary objects: for-in and Object.keys/values in own-key order', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const seen: Record<string, boolean> = { pointerdown: false };
  let out = $state('');
  function run() {
    seen['10'] = true;
    seen.click = true;
    seen['2'] = false;
    const keys: string[] = [];
    for (const k in seen) {
      keys.push(k);
      if (k === '2') delete seen.click;
    }
    out = keys.join(',') + ' ' + Object.keys(seen).join(',') + ' ' +
      Object.values(seen).some(Boolean);
  }
</script>

<button id="b" onclick={run}>{out}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      // Array indices first, ascending; a key deleted before it is reached is skipped.
      assert.equal(text(steps[1].state.dom[0]), '2,10,pointerdown 2,10,pointerdown true');
    },
  );
});

test('a function with properties assigned after its declaration is a record of both', async () => {
  await withApp(
    {
      'debounce.js': `export function debounce(fn, wait = 500) {
  let timeout = null;
  const debounced = (...args) => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => {
      fn(...args);
    }, wait);
  };
  debounced.destroy = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
  return debounced;
}
`,
      'debounce.d.ts': `export declare function debounce<T extends (...args: any[]) => any>(fn: T, wait?: number): {
  (...args: Parameters<T>): void;
  destroy(): void;
};
`,
      'App.svelte': `<script lang="ts">
  import { debounce } from './debounce.js';
  let out = $state('');
  const later: { (word: string): void; destroy(): void } = debounce((word: string) => {
    out += word;
  }, 10);
  function call(f: (word: string) => void) {
    f('b');
  }
</script>

<button id="a" onclick={() => later('a')}>{out}</button>
<button id="b" onclick={() => call(later)}>b</button>
<button id="c" onclick={() => later.destroy()}>c</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'a' },
        { kind: 'wait', ms: 20 },
        { kind: 'click', id: 'b' },
        { kind: 'click', id: 'c' },
        { kind: 'wait', ms: 20 },
      ]);
      assert.equal(text(steps[2].state.dom[0]), 'a');
      assert.equal(text(steps[5].state.dom[0]), 'a');
    },
  );
});

test('function properties assigned anywhere else are rejected', async () => {
  await withApp(
    {
      'make.js': `export function make(flag) {
  const f = () => 1;
  if (flag) f.extra = () => 2;
  return f;
}
`,
      'App.svelte': `<script lang="ts">
  import { make } from './make.js';
  const g = make(true);
</script>

<p>{g()}</p>
`,
    },
    async root => {
      await assert.rejects(lowered(root), failWith('E_FUNCTION_PROPERTY'));
    },
  );
});

test('events: instanceof their interface, members by in, keyboard copies', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let out = $state('');
  function click(e: MouseEvent) {
    out = \`\${e instanceof PointerEvent},\${e instanceof MouseEvent},\${e instanceof KeyboardEvent},\${'button' in e},\${'key' in e}\`;
  }
  function key(e: KeyboardEvent) {
    const copy = new KeyboardEvent(e.type, e);
    out = \`\${e instanceof KeyboardEvent},\${e instanceof MouseEvent},\${'button' in e},\${copy.key},\${copy instanceof KeyboardEvent},\${copy.defaultPrevented}\`;
  }
</script>

<button id="b" onclick={click} onkeydown={key}>{out}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'b' },
        { kind: 'keydown', id: 'b', key: 'x' },
      ]);
      assert.equal(text(steps[1].state.dom[0]), 'true,true,false,true,false');
      assert.equal(text(steps[2].state.dom[0]), 'true,false,false,x,true,false');
    },
  );
});

test('closest takes a selector of the supported subset', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let out = $state('');
  function run(e: MouseEvent) {
    const t = e.target;
    out = [t.closest('[data-menu]')?.id ?? 'none', t.closest('section > div')?.id ?? 'none',
      t.closest('span')?.id ?? 'none'].join(',');
  }
</script>

<section><div id="outer" data-menu=""><button id="b" onclick={run}>{out}</button></div></section>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.match(JSON.stringify(steps[1].state.dom), /outer,outer,none/);
    },
  );
});

test('svelte-toolbelt helpers: executeCallbacks, composeHandlers, contains, afterSleep', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { executeCallbacks, composeHandlers, contains, afterSleep } from 'svelte-toolbelt';
  let out = $state('');
  let inner = $state<HTMLElement | null>(null);
  let outer = $state<HTMLElement | null>(null);
  const log = (s: string) => () => { out += s; };
  function run(e: MouseEvent) {
    const both = executeCallbacks(log('a'), (e: MouseEvent) => { out += e.type.slice(0, 1); });
    const composed = composeHandlers(
      (e: MouseEvent) => { out += '1'; e.preventDefault(); },
      () => { out += '2'; },
    );
    both(e);
    composed(e);
    out += contains(outer, inner) ? 'y' : 'n';
    out += contains(inner, outer) ? 'y' : 'n';
    afterSleep(5, () => { out += 's'; });
  }
</script>

<div bind:this={outer}><button id="b" bind:this={inner} onclick={run}>{out}</button></div>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'b' },
        { kind: 'wait', ms: 10 },
      ]);
      // composeHandlers stops at the cancelled event.
      assert.equal(text(steps[1].state.dom[0]), 'ac1yn');
      assert.equal(text(steps[2].state.dom[0]), 'ac1yns');
    },
  );
});

test('tuples are not plain data: strings and JSON of them are rejected', async () => {
  for (const use of ['`${pair}`', 'JSON.stringify(pair)', 'Object.keys(pair).join()']) {
    await withApp(
      {
        'App.svelte': `<script lang="ts">
  const m = new Map<string, number>();
  m.set('a', 1);
  const pair = [...m][0];
  const shown = ${use};
</script>

<p>{shown}</p>
`,
      },
      async root => {
        await assert.rejects(lowered(root), e =>
          ['E_IR', 'E_OBJECT'].includes(e.code)
            ? true
            : assert.fail(`${use}: ${e.code} ${e.message}`),
        );
      },
    );
  }
});

test('rest props pass numbers and objects to the props a child declares', async () => {
  await withApp(
    {
      'Inner.svelte': `<script lang="ts">
  let { offset, box, ...rest }: { offset: number; box: { w: number } } & Record<string, unknown> = $props();
</script>

<p id="p" {...rest}>{offset + box.w}</p>
`,
      'Middle.svelte': `<script lang="ts">
  import Inner from './Inner.svelte';
  let { ...rest }: Record<string, unknown> = $props();
</script>

<Inner {...rest} />
`,
      'App.svelte': `<script lang="ts">
  import Middle from './Middle.svelte';
  let n = $state(1);
</script>

<button id="b" onclick={() => n++}>+</button>
<Middle offset={n} box={{ w: 10 }} tabindex={n} />
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      const p = JSON.stringify(steps[0].state.dom);
      assert.match(p, /"tabindex":"1"/);
      assert.match(p, /11/);
      assert.match(JSON.stringify(steps[1].state.dom), /12/);
    },
  );
});

test('{@const} of a bag or text, and tests the props decide', async () => {
  await withApp(
    {
      'Field.svelte': `<script lang="ts">
  let { type, value = $bindable(), files = $bindable() }: { type?: string; value?: string; files?: unknown } = $props();
</script>

{#if type === 'file'}
  <input type="file" bind:files />
{:else}
  <input id="text" bind:value />
{/if}
`,
      'App.svelte': `<script lang="ts">
  import { mergeProps } from 'svelte-toolbelt';
  import Field from './Field.svelte';
  let label = $state('a');
</script>

{#if label}
  {@const bag = mergeProps({ id: 'x' }, { title: label })}
  {@const shout = label.toUpperCase()}
  <p {...bag}>{shout}</p>
{/if}
<button id="b" onclick={() => (label += 'b')}>+</button>
<Field />
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.match(JSON.stringify(steps[0].state.dom), /"title":"a"/);
      assert.match(JSON.stringify(steps[1].state.dom), /"title":"ab".*AB/);
      // The file branch is not lowered: no site passes \`type\`.
      assert.doesNotMatch(JSON.stringify(ir), /"type","value":\{"op":"lit","value":"file"/);
    },
  );
});

test('{@const} of a value with identity is rejected', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let n = $state(1);
</script>

{#if n}
  {@const box = { n }}
  <p>{box.n}</p>
{/if}
`,
    },
    async root => {
      await assert.rejects(lowered(root), failWith('E_TEMPLATE', /@const/));
    },
  );
});

test('capture listeners of a bag run from the root to the target, before the others', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let log = $state('');
  const outer = {
    onclickcapture: () => { log += 'C'; },
    onclick: () => { log += 'b'; },
  };
  const inner = {
    onclickcapture: () => { log += 'c'; },
  };
</script>

<div {...outer}><p {...inner}><button id="b" onclick={() => (log += 't')}>{log}</button></p></div>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(text(steps[1].state.dom[0]), 'Cctb');
    },
  );
});
