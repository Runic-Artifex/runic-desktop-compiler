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

test('{@const} of a component value names a dynamic tag, beside a type-only import of its name', async () => {
  // shadcn-svelte's ComponentPreviewTabs: `import type { Component }` and
  // `{@const Component = component}<Component />`.
  await withApp(
    {
      'A.svelte': '<p id="a">A</p>\n',
      'B.svelte': '<p id="b">B</p>\n',
      'Preview.svelte': `<script lang="ts">
  import type { Component } from 'svelte';
  let { component }: { component?: Component } = $props();
</script>

{#if component}
  {@const Component = component}
  <Component />
{/if}
`,
      'App.svelte': `<script lang="ts">
  import Preview from './Preview.svelte';
  import A from './A.svelte';
  import B from './B.svelte';
  let which = $state(true);
</script>

<Preview component={which ? A : B} />
<button id="t" onclick={() => (which = !which)}>t</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 't' }]);
      assert.match(JSON.stringify(steps[0].state.dom), /"A"/);
      assert.doesNotMatch(JSON.stringify(steps[0].state.dom), /"B"/);
      assert.match(JSON.stringify(steps[1].state.dom), /"B"/);
      assert.doesNotMatch(JSON.stringify(steps[1].state.dom), /"A"/);
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

test('a test of a snippet prop is not decided by the props sites pass', async () => {
  await withApp(
    {
      'Inner.svelte': `<script lang="ts">
  import type { Snippet } from 'svelte';
  let { child }: { child?: Snippet } = $props();
</script>

{#if child}{@render child()}{:else}<p id="none">none</p>{/if}
`,
      'App.svelte': `<script lang="ts">
  import Inner from './Inner.svelte';
</script>

<Inner>{#snippet child()}<p id="given">given</p>{/snippet}</Inner>
<Inner />
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, []);
      const dom = JSON.stringify(steps[0].state.dom);
      assert.match(dom, /given/);
      assert.match(dom, /none/);
    },
  );
});

test('a property typed as any function takes the type of the functions given to it', async () => {
  await withApp(
    {
      'menu.svelte.ts': `import { executeCallbacks } from 'svelte-toolbelt';
type AnyFn = (...args: any[]) => any;
interface Opts {
  onClose: AnyFn;
}
export class Menu {
  static opened = 0;
  static cleanup?: AnyFn;
  opts: Opts;
  constructor(opts: Opts) {
    this.opts = opts;
  }
  open(log: string[]) {
    if (Menu.opened === 0) Menu.cleanup = () => log.push('cleanup');
    Menu.opened++;
  }
  close(log: string[]) {
    Menu.opened--;
    if (Menu.opened === 0) Menu.cleanup?.();
    const fns: (() => void)[] = [() => log.push('a'), () => log.push('b')];
    const all = executeCallbacks(...fns);
    all();
    this.opts.onClose();
  }
}
`,
      'App.svelte': `<script lang="ts">
  import { Menu } from './menu.svelte';
  let out = $state('');
  const log: string[] = [];
  const menu = new Menu({ onClose: () => log.push('closed') });
  function run() {
    menu.open(log);
    menu.close(log);
    out = log.join(' ');
  }
</script>

<button id="run" onclick={run}>run</button>
<p id="out">{out}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'run' }]);
      const out = steps[1].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'out');
      assert.equal(text(out), 'cleanup a b closed');
    },
  );
});

test('a field set after this escapes is late where every read dereferences it', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  class Group {
    first(): string {
      return 'first';
    }
  }
  const queue: (() => string)[] = [];
  class Content {
    group: Group;
    constructor() {
      queue.push(() => this.group.first());
      this.group = new Group();
    }
  }
  let out = $state('');
  new Content();
  function run() {
    const first = queue[0];
    out = first();
  }
</script>

<button id="run" onclick={run}>run</button>
<p id="out">{out}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'run' }]);
      const out = steps[1].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'out');
      assert.equal(text(out), 'first');
    },
  );
});

test('host functions, capture listeners on the document, textContent', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  interface Opts {
    getWindow: () => Window;
  }
  const opts: Opts = { getWindow: () => window };
  let out = $state('');
  const log: string[] = [];
  let el = $state<HTMLElement | null>(null);
  $effect(() => {
    const capture = () => log.push('capture');
    document.addEventListener('click', capture, true);
    return () => document.removeEventListener('click', capture, true);
  });
  function run() {
    log.push('target');
    opts.getWindow().setTimeout(() => {
      out = log.join(' ') + ' | ' + (el ? el.textContent : '');
    }, 10);
  }
</script>

<button id="run" onclick={run}>run</button>
<p id="out" bind:this={el}>{out}<b>!</b></p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'run' },
        { kind: 'wait', ms: 20 },
      ]);
      const out = steps[2].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'out');
      assert.equal(text(out), 'capture target | !!');
    },
  );
});

test('custom events: dispatched by script to listeners of a name held in a field, bubbling', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { on } from 'svelte/events';
  class Dispatcher {
    eventName: string;
    constructor(name: string) {
      this.eventName = name;
    }
    dispatch(element: HTMLElement): boolean {
      return element.dispatchEvent(
        new CustomEvent(this.eventName, { bubbles: true, cancelable: true }),
      );
    }
    listen(element: HTMLElement, callback: () => void): () => void {
      return on(element, this.eventName, () => callback());
    }
  }
  const opened = new Dispatcher('appopen');
  let outer = $state<HTMLElement | null>(null);
  let inner = $state<HTMLElement | null>(null);
  let out = $state('');
  const log: string[] = [];
  $effect(() => {
    if (!outer) return;
    return opened.listen(outer, () => log.push('heard'));
  });
  function run() {
    if (inner) log.push(String(opened.dispatch(inner)));
    out = log.join(' ');
  }
</script>

<div id="outer" bind:this={outer}><span id="inner" bind:this={inner}>x</span></div>
<button id="run" onclick={run}>run</button>
<p id="out">{out}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'wait', ms: 0 },
        { kind: 'click', id: 'run' },
      ]);
      const out = steps[2].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'out');
      assert.equal(text(out), 'heard true');
    },
  );
});

test('click() runs the click listeners nested in the script', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let count = $state(0);
  let box = $state<HTMLElement | null>(null);
</script>

<div id="box" bind:this={box} onclick={() => count++}>box</div>
<button id="run" onclick={() => box?.click()}>run</button>
<p id="out">{count}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'run' },
        { kind: 'click', id: 'run' },
      ]);
      const out = steps[2].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'out');
      assert.equal(text(out), '2');
    },
  );
});

test('a record passed where a record of some of its fields is expected; dictionary reads may be undefined', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  interface Base {
    label: string;
  }
  interface Full extends Base {
    count: number;
  }
  function describe(o: Base): string {
    return o.label;
  }
  const full: Full = { count: 2, label: 'full' };
  const index: Record<string, number> = { a: 1 };
  let out = $state('');
  function run(key: string) {
    let found = index[key];
    if (found === undefined) {
      out = describe(full) + ' none';
      return;
    }
    out = describe(full) + ' ' + String(found + full.count);
  }
</script>

<button id="a" onclick={() => run('a')}>a</button>
<button id="b" onclick={() => run('b')}>b</button>
<p id="out">{out}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'a' },
        { kind: 'click', id: 'b' },
      ]);
      const out = s => steps[s].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'out');
      assert.equal(text(out(1)), 'full 3');
      assert.equal(text(out(2)), 'full none');
    },
  );
});
