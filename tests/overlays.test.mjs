// The overlay host layer (M6 step 7, docs/design/M6-OVERLAYS.md): imperative
// mounts (svelte's mount/unmount/getAllContexts lowered to IR mount sites),
// the body as an element, conditions folded at build time, and the
// rejections around them. Rendering parity with Chromium is checked by the
// `portal` conformance case; the differential runs the fixture too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { generate, interpret } from '../compiler/codegen.mjs';

const FIXTURE = 'fixtures/portal-svelte';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/overlays-'));
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
      'Content.svelte':
        '<script lang="ts">\n  let { children }: { children?: import("svelte").Snippet } = $props();\n</script>\n\n{@render children?.()}\n',
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

test('svelte mount lowers to a mount site of the mounting component', async () => {
  const { ir } = await lowered(FIXTURE);
  // bits-ui's own Portal (utilities/portal/portal.svelte), compiled from source.
  const portal = ir.components.find(c => c.name === 'portal');
  assert.equal(portal.mounts.length, 1);
  const consumer = ir.components[portal.mounts[0].component];
  assert.equal(consumer.name, 'portal-consumer');
  // The children snippet is forwarded: rendered in the Portal, which owns it.
  assert.deepEqual(portal.mounts[0].slots, [
    {
      name: 'children',
      body: [{ kind: 'slot', name: 'children' }],
      when: { op: 'slot-provided', name: 'children' },
    },
  ]);
  const json = JSON.stringify(ir);
  assert.match(json, /"op":"mount","site":0/);
  assert.match(json, /"name":"context\.all"/);
  assert.match(json, /"name":"mounted\.unmount"/);
  // The backend never sees framework names.
  const rust = generate(ir).replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.doesNotMatch(rust, /svelte|\$state/i);
});

test('portalled content is the body’s last children, with the caller’s contexts', async () => {
  const { ir } = await lowered(FIXTURE);
  const steps = interpret(ir, [
    { kind: 'click', id: 'first' },
    { kind: 'click', id: 'second' },
    { kind: 'click', id: 'inc' },
    { kind: 'click', id: 'first' },
  ]);
  const portals = i => (steps[i].state.portals ?? []).map(n => n.attrs.id);
  assert.deepEqual(portals(0), []);
  assert.deepEqual(portals(1), ['first-box']);
  assert.deepEqual(portals(2), ['first-box', 'second-box']);
  assert.match(text(steps[3].state.portals[0]), /first: dark\s*1/);
  assert.deepEqual(portals(4), ['second-box']);
  assert.match(text(steps[4].state.portals[0]), /second: dark/);
});

test('mount options and targets outside the model are rejected', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { mount } from 'svelte';
  import Content from './Content.svelte';
  $effect(() => {
    mount(Content, { target: document.querySelector('body')!, intro: false });
  });
</script>
`,
    },
    root =>
      assert.rejects(lowered(root), failWith('E_MOUNT', 'App.svelte', /intro is unsupported/)),
  );
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { mount } from 'svelte';
  import Content from './Content.svelte';
  $effect(() => {
    mount(Content, { target: document.querySelector('main > p')! });
  });
</script>
`,
    },
    root => assert.rejects(lowered(root), failWith('E_CALL', 'App.svelte', /body and #id/)),
  );
});

test('a mount outside the body is reported at run time', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { mount } from 'svelte';
  import Content from './Content.svelte';
  let shown = $state(false);
  $effect(() => {
    if (shown) mount(Content, { target: document.getElementById('host')! });
  });
</script>

<div id="host"></div>
<button id="show" onclick={() => (shown = true)}>Show</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'show' }]);
      assert.match(
        JSON.stringify(steps[1].outcome),
        /unsupported: mounting a component into an element other than the body/,
      );
    },
  );
});

test('conditions known at build time are folded (the branch never taken is not lowered)', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { BROWSER, DEV } from 'esm-env';
  let n = $state(0);
  function bump() {
    if (DEV && n > 1) {
      // Never lowered: a development build's check.
      throw new Error(String(Symbol('dev')));
    }
    n = typeof document !== 'undefined' && BROWSER ? n + 1 : -1;
  }
</script>

<button id="b" onclick={bump}>{n}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      assert.ok(ir.meta.mappings.some(m => m.id === 'esm-env@1.2.2'));
      const steps = interpret(ir, [
        { kind: 'click', id: 'b' },
        { kind: 'click', id: 'b' },
        { kind: 'click', id: 'b' },
      ]);
      assert.equal(text(steps[3].state.dom[0]), '3');
    },
  );
});

test('ResizeObserver lowers to observer records and resize built-ins', async () => {
  const { ir } = await lowered('fixtures/resize-svelte');
  const ro = ir.records.findIndex(r => r.name === 'ResizeObserver');
  assert.ok(ro >= 0);
  assert.equal(ir.records[ro].fields[0].name, 'callback');
  const json = JSON.stringify(ir);
  assert.match(json, /"name":"resize\.new"/);
  assert.match(json, /"name":"resize\.observe","args":\[[^\]]*\{"op":"lit","value":"border-box"\}/);
  assert.match(json, /"name":"resize\.unobserve"/);
  assert.match(json, /"name":"resize\.disconnect"/);
  // The interpreter has no layout: observing is reported there.
  assert.throws(() => interpret(ir, []), /RunicLayoutError: resize\.observe/);
});

test('ResizeObserver options outside the model are rejected', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let box = $state<HTMLElement | null>(null);
  $effect(() => {
    if (!box) return;
    const o = new ResizeObserver(() => {});
    const which = Math.random() > 2 ? 'border-box' : 'content-box';
    o.observe(box, { box: which });
  });
</script>

<div bind:this={box}></div>
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_CALL', 'App.svelte', /ResizeObserver observe takes/),
      ),
  );
});

test('a closure created in its variable’s initialiser sees the variable', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let same = $state('');
  function run() {
    const count: (n: number) => number = n => (n > 0 ? 1 + count(n - 1) : 0);
    const o: { n: number; get: () => number } = { n: 2, get: () => o.n };
    same = \`\${count(3)} \${o.get()}\`;
  }
</script>

<button id="b" onclick={run}>{same}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(text(steps[1].state.dom[0]), '3 2');
    },
  );
});

test('bits-ui’s Portal narrows its target union to the selector and queries the document', async () => {
  const { ir } = await lowered(FIXTURE);
  const json = JSON.stringify(ir);
  // `typeof to.current === "string"` is decided: the element branch is not lowered.
  assert.match(json, /"name":"document\.querySelector"/);
  assert.doesNotMatch(json, /"op":"typeof"/);
});

test('a union outside the value model takes the member of the values that reach it', async () => {
  await withApp(
    {
      'Target.svelte': `<script lang="ts">
  type Target = HTMLElement | string;
  let { to = 'body' }: { to?: Target } = $props();
  const label = $derived(typeof to === 'string' ? to : 'element');
</script>

<p id="t">{label}</p>
`,
      'App.svelte': `<script lang="ts">
  import Target from './Target.svelte';
</script>

<Target />
<Target to="#x" />
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, []);
      const shown = steps[0].state.dom.filter(n => typeof n !== 'string').map(text);
      assert.deepEqual(shown, ['body', '#x']);
    },
  );
});

test('a union reached by values of two members is rejected, naming a site of each', async () => {
  await withApp(
    {
      'Target.svelte': `<script lang="ts">
  type Target = HTMLElement | string;
  let { to = 'body' }: { to?: Target } = $props();
  const label = $derived(typeof to === 'string' ? to : 'element');
</script>

<p>{label}</p>
`,
      'App.svelte': `<script lang="ts">
  import Target from './Target.svelte';
  let el = $state<HTMLElement | null>(null);
</script>

<div bind:this={el}></div>
{#if el}<Target to={el} />{/if}
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_TYPE_UNION', 'Target.svelte', /outside the value model/),
      ),
  );
});

test('untyped helpers: function literals typed by their use, curried helpers, presence tests', async () => {
  await withApp(
    {
      'helpers.js': `export function makeResolver(fallback) {
  return getProp => {
    const value = getProp();
    if (value !== undefined) return value;
    return fallback;
  };
}
export function apply(f, a, b) {
  return [f(a), f(b)];
}
`,
      'App.svelte': `<script lang="ts">
  import { makeResolver, apply } from './helpers.js';
  let out = $state('');
  function run(given: string | undefined) {
    const resolve = makeResolver('fallback');
    const both = apply(o => o.n, { n: 1 }, { n: 2, m: 3 });
    out = \`\${resolve(() => given)} \${both.join(',')}\`;
  }
</script>

<button id="a" onclick={() => run(undefined)}>{out}</button>
<button id="b" onclick={() => run('given')}>b</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'a' },
        { kind: 'click', id: 'b' },
      ]);
      assert.equal(text(steps[1].state.dom[0]), 'fallback 1,2');
      assert.equal(text(steps[2].state.dom[0]), 'given 1,2');
    },
  );
});

test('values a union takes are traced: a prop no site passes gives none', async () => {
  await withApp(
    {
      'Target.svelte': `<script lang="ts">
  type Target = HTMLElement | string;
  let { anchor, to = 'body' }: { anchor?: HTMLElement; to?: string } = $props();
  const chosen: Target = anchor ?? to;
  const label = $derived(typeof chosen === 'string' ? chosen : 'element');
</script>

<p>{label}</p>
`,
      'App.svelte': `<script lang="ts">
  import Target from './Target.svelte';
</script>

<Target to="#x" />
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, []);
      const shown = steps[0].state.dom.filter(n => typeof n !== 'string').map(text);
      assert.deepEqual(shown, ['#x']);
    },
  );
});

test('untyped class fields only ever null, untyped conditionals, pointerType', async () => {
  await withApp(
    {
      'timer.svelte.js': `export class Timer {
  #pending = null;
  label = $state('idle');
  pick(flag) {
    return flag ? this.word('yes') : this.word('no');
  }
  word(w) {
    return w;
  }
  stop() {
    if (this.#pending !== null) {
      clearTimeout(this.#pending);
      this.label = 'cleared';
      return;
    }
    this.label = 'nothing';
  }
}
`,
      'App.svelte': `<script lang="ts">
  import { Timer } from './timer.svelte.js';
  const timer = new Timer();
  let kinds = $state('');
</script>

<button id="b" onclick={(e) => { timer.stop(); kinds += e.pointerType + ';' + timer.pick(kinds.length > 0) + ';'; }}>{timer.label} {kinds}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'b' },
        { kind: 'keydown', id: 'b', key: 'Enter' },
      ]);
      assert.equal(text(steps[1].state.dom[0]), 'nothing mouse;no;');
      assert.equal(text(steps[2].state.dom[0]), 'nothing mouse;no;;yes;');
    },
  );
});

test('getAnimations lowers to animation objects read through built-ins', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let box = $state<HTMLElement | null>(null);
  let log = $state('');
  function wait() {
    const animations = box!.getAnimations();
    Promise.all(animations.map(a => a.finished)).then(
      () => (log = 'done'),
      () => (log = animations.some(a => a.pending || a.playState !== 'finished') ? 'again' : 'idle'),
    );
  }
</script>

<button id="b" onclick={wait}>wait</button>
<div bind:this={box}>{log}</div>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const json = JSON.stringify(ir);
      assert.match(
        json,
        /"name":"element\.getAnimations","args":\[[^\]]*\],"type":\{"array":"animation"\}/,
      );
      assert.match(
        json,
        /"name":"animation\.finished","args":\[[^\]]*\],"type":\{"promise":"animation"\}/,
      );
      assert.match(json, /"name":"animation\.pending"/);
      assert.match(json, /"name":"animation\.playState"/);
      // The interpreter has no style engine: the call is reported there.
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.match(JSON.stringify(steps[1]), /RunicLayoutError: element\.getAnimations/);
      // Native apps track the document's animations only when the program reads them.
      assert.match(generate(ir), /const TRACKS_ANIMATIONS: bool = true;/);
    },
  );
});

test('animation members outside the model are rejected', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let box = $state<HTMLElement | null>(null);
  let log = $state('');
  function read() {
    for (const a of box!.getAnimations()) log = String(a.currentTime);
  }
</script>

<button onclick={read}>read</button>
<div bind:this={box}>{log}</div>
`,
    },
    root =>
      assert.rejects(lowered(root), failWith('E_MEMBER', 'App.svelte', /Animation currentTime/)),
  );
});
