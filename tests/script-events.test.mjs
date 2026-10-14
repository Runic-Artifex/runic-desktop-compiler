// Script DOM (M6, docs/design/M6-SCRIPT-DOM.md), slice 3: listeners script
// adds with options at any event target, events script creates and
// dispatches (CustomEvent details at their types, init members), template
// listeners of custom event types, feature tests of host objects, and the
// orders frameworks give their own listeners. The interpreter runs each
// program; the native runtime is checked against Chromium by the
// conformance case `script-dom-events`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { generate, interpret } from '../compiler/codegen.mjs';
import { FIRED_TYPES, NATIVE_TYPES, NEVER_FIRED_TYPES } from '../frontend/event-types.ts';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/script-events-'));
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
const failWith = (code, pattern) => e =>
  (e instanceof Diagnostic && e.code === code && (!pattern || pattern.test(e.message))) ||
  assert.fail(`expected ${code}, got ${e.code}: ${e.message}`);
const builtins = ir => {
  const names = new Set();
  const walk = x => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if (x.op === 'builtin') names.add(x.name);
      Object.values(x).forEach(walk);
    }
  };
  walk(ir);
  return names;
};
const byId = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n !== 'object') continue;
    if (n.attrs?.id === id) return n;
    const found = byId(n.children ?? [], id);
    if (found) return found;
  }
  return undefined;
};
const text = n => (typeof n === 'string' ? n : (n.children ?? []).map(text).join(''));
const out = step => text(byId(step.state.dom, 'out'));

test('the frontend lists event types as runic-js does', async () => {
  const rust = await readFile('crates/runic-js/src/event.rs', 'utf8');
  const list = name =>
    [
      ...rust
        .match(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`))[1]
        .matchAll(/"([^"]+)"/g),
    ].map(m => m[1]);
  assert.deepEqual(list('FIRED_TYPES'), FIRED_TYPES);
  assert.deepEqual(list('NATIVE_TYPES'), NATIVE_TYPES);
  assert.deepEqual(list('NEVER_FIRED_TYPES'), NEVER_FIRED_TYPES);
});

test('listeners with options, identified by type, listener and capture', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { onMount } from 'svelte';
  let outer = $state<HTMLElement | null>(null);
  let inner = $state<HTMLElement | null>(null);
  let out = $state('');
  const note = (s: string) => { out = out + s + ';'; };
  function onCapture(e: MouseEvent) { note('capture ' + (e.currentTarget === outer)); }
  function onTarget() { note('target'); }
  function onOnce() { note('once'); }
  const options = { passive: true };
  function onPassive(e: MouseEvent) { e.preventDefault(); note('passive ' + e.defaultPrevented); }
  onMount(() => {
    if (!outer || !inner) return;
    outer.addEventListener('click', onCapture, { capture: true });
    outer.addEventListener('click', onCapture, true);
    inner.addEventListener('click', onTarget);
    inner.addEventListener('click', onOnce, { once: true });
    inner.addEventListener('click', onPassive, options);
    document.addEventListener('click', onOnce, { once: true });
  });
  function drop() { outer?.removeEventListener('click', onCapture); note('kept'); outer?.removeEventListener('click', onCapture, { capture: true }); }
</script>
<button id="drop" onclick={drop}>drop</button>
<div id="outer" bind:this={outer}><span id="inner" bind:this={inner}>inner</span></div>
<p id="out">{out}</p>`,
    },
    async root => {
      const { ir } = await lowered(root);
      assert.ok(builtins(ir).has('target.listen'));
      assert.ok(builtins(ir).has('target.unlisten'));
      const steps = interpret(ir, [
        { kind: 'click', id: 'inner' },
        { kind: 'click', id: 'inner' },
        { kind: 'click', id: 'drop' },
        { kind: 'click', id: 'inner' },
      ]);
      assert.equal(out(steps[1]), 'capture true;target;once;passive false;once;');
      assert.equal(
        out(steps[2]),
        'capture true;target;once;passive false;once;capture true;target;passive false;',
      );
      assert.equal(out(steps[4]), `${out(steps[3])}target;passive false;`);
    },
  );
});

test('events script creates: a CustomEvent detail at its type, init members, dispatch', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { onMount } from 'svelte';
  type Tick = { n: number; label: string };
  let box = $state<HTMLElement | null>(null);
  let out = $state('');
  let fired = $state('');
  const note = (s: string) => { out = out + s + ';'; };
  function onTick(e: CustomEvent<Tick>) { fired = fired + e.detail.label + e.detail.n; }
  function onBox(e: CustomEvent<Tick>) { if (e.detail.n > 1) e.preventDefault(); }
  onMount(() => {
    box?.addEventListener('tick', onBox);
    window.addEventListener('ping', (e: Event) => note('window ' + e.isTrusted));
  });
  let n = 0;
  function go() {
    if (!box) return;
    n += 1;
    const tick = new CustomEvent<Tick>('tick', { bubbles: true, cancelable: true, detail: { n, label: 't' } });
    note(String(box.dispatchEvent(tick)));
    const click = new MouseEvent('click', { clientX: 3, ctrlKey: true });
    note(click.clientX + ' ' + click.ctrlKey + ' ' + click.bubbles);
    document.dispatchEvent(new Event('ping', { bubbles: true }));
    const wrong = new CustomEvent<string>('tick', { detail: 'text' });
    try { box.dispatchEvent(wrong); } catch (x) { note((x as Error).name); }
  }
</script>
<button id="go" onclick={go}>go</button>
<div id="wrap" ontick={onTick}><div id="box" bind:this={box}>box</div></div>
<p id="out">{out}</p><p id="fired">{fired}</p>`,
    },
    async root => {
      const { ir } = await lowered(root);
      for (const b of [
        'event.custom',
        'event.create',
        'event.custom-detail',
        'element.dispatchEvent',
      ])
        assert.ok(builtins(ir).has(b), b);
      const custom = [];
      const walk = x => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === 'object') {
          if (x.customListeners) custom.push(...x.customListeners.map(l => l.event));
          Object.values(x).forEach(walk);
        }
      };
      walk(ir.components);
      assert.deepEqual(custom, ['tick']);
      const steps = interpret(ir, [
        { kind: 'click', id: 'go' },
        { kind: 'click', id: 'go' },
      ]);
      // The second detail's listener reads a string as a Tick: a TypeError
      // (reported; the dispatch goes on).
      assert.equal(out(steps[1]), 'true;3 true false;window false;');
      assert.equal(text(byId(steps[1].state.dom, 'fired')), 't1');
      assert.equal(
        out(steps[2]),
        'true;3 true false;window false;false;3 true false;window false;',
      );
      assert.equal(text(byId(steps[2].state.dom, 'fired')), 't1t2');
    },
  );
});

test('feature tests of host objects fold where every type declares the member', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let box = $state<HTMLElement | null>(null);
  let out = $state('');
  function go() {
    if (!box) return;
    out = ('addEventListener' in box) + ' ' + typeof window.MouseEvent + ' ' + typeof CustomEvent;
  }
</script>
<button id="go" onclick={go}>go</button><div bind:this={box}></div><p id="out">{out}</p>`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'go' }]);
      assert.equal(out(steps[1]), 'true function function');
    },
  );
});

test('listener options and types outside the covered set are rejected where they are', async () => {
  const app = body => ({
    'App.svelte': `<script lang="ts">
  let box = $state<HTMLElement | null>(null);
  function f() {}
  function go() { if (!box) return; ${body} }
</script>
<button onclick={go}>go</button><div bind:this={box}></div>`,
  });
  await withApp(app("box.addEventListener('keypress', f);"), root =>
    assert.rejects(lowered(root), failWith('E_EVENT', /keypress/)),
  );
  await withApp(app("box.addEventListener('load', f);"), root =>
    assert.rejects(lowered(root), failWith('E_EVENT', /load/)),
  );
  await withApp(app("box.addEventListener('click', f, { signal: undefined });"), root =>
    assert.rejects(lowered(root), failWith('E_EVENT', /signal/)),
  );
});

test("Svelte's delegated template listeners run from its root, after listeners script adds below it", async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { onMount } from 'svelte';
  let outer = $state<HTMLElement | null>(null);
  let out = $state('');
  let stop = false;
  onMount(() => outer?.addEventListener('click', (e: MouseEvent) => { out = out + 'raw;'; if (stop) e.stopPropagation(); }));
</script>
<div onclick={(e: MouseEvent) => { out = out + 'root ' + (e.currentTarget === outer) + ';'; }}>
  <div bind:this={outer}><button id="b" onclick={(e: MouseEvent) => { out = out + 'button ' + (e.currentTarget === e.target) + ';'; }}>b</button></div>
</div>
<button id="s" onclick={() => { stop = true; }}>s</button>
<p id="out">{out}</p>`,
    },
    async root => {
      const { ir } = await lowered(root);
      assert.ok(ir.schedule.delegation.includes('click'));
      const steps = interpret(ir, [
        { kind: 'click', id: 'b' },
        { kind: 'click', id: 's' },
        { kind: 'click', id: 'b' },
      ]);
      // (Chromium's order: the listener script added on the way up, then
      // Svelte's root runs the button's and its ancestor's handlers; one
      // that stops propagation below the root keeps all of them from running.)
      assert.equal(out(steps[1]), 'raw;button true;root false;');
      assert.equal(out(steps[3]), 'raw;button true;root false;raw;');
    },
  );
});

test("Vue's template listeners are its elements' own; nested dispatches check the order in both engines", async () => {
  const log = step => text(byId(step.state.dom, 'log'));
  // Vue declares schedule.elementListeners: its invokers run at their
  // elements in registration order, before listeners script adds after
  // mount, also for nested dispatches (Chromium: case element-listeners-vue).
  const vue = (await lowered(path.resolve('fixtures/element-listeners-vue'))).ir;
  assert.equal(vue.schedule.elementListeners, true);
  assert.equal(vue.schedule.delegation, undefined);
  const steps = interpret(vue, [
    { kind: 'click', id: 'target' },
    { kind: 'click', id: 'nested-click' },
    { kind: 'click', id: 'nested-submit' },
  ]);
  assert.ok(
    steps.every(s => !s.outcome?.rejected),
    JSON.stringify(steps.map(s => s.outcome)),
  );
  assert.equal(log(steps[1]), 'soc stc tt st m ti si to');
  assert.equal(
    log(steps[3]),
    'soc stc tt st m ti si to soc n< tx sx ts >n ti si to soc r< tf sf >r ti si to',
  );
  // React declares neither: a listener script adds below its root, of a type
  // known only at run time, is reported where a nested dispatch reaches it,
  // in the interpreter and in the generated code alike (the differential
  // compares the two over nested-order-react).
  const react = (await lowered(path.resolve('fixtures/nested-order-react'))).ir;
  assert.equal(react.schedule.elementListeners, undefined);
  // (requestSubmit: the order check of the nested dispatch; dispatchEvent
  // of a native type: first the report of one reaching a template listener.)
  for (const [id, message] of [
    ['request', /submit listener added with addEventListener on the path of a template listener/],
    ['dispatch', /dispatchEvent of a native click event reaching a template listener/],
  ]) {
    const [, step] = interpret(react, [{ kind: 'click', id }]);
    assert.match(step.outcome?.rejected?.message ?? '', message, id);
  }
  const rust = generate(react);
  assert.match(rust, /if elements \{ cx\.dom\.check_listener_order\(&path, kind\); \}/);
});
