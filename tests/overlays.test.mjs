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
    // (M6 script DOM: literal selectors of the subset search the document; a
    // target other than the body is reported at run time, as below.)
    async root => assert.match(JSON.stringify((await lowered(root)).ir), /document\.querySelector/),
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

test('a union reached by values of two members holds either', async () => {
  const files = sites => ({
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
${sites}
`,
  });
  // The default (a site without \`to\`) and an element: the prop holds an IR
  // union of both (M6 unions), \`typeof\` testing the member it holds.
  await withApp(files('<Target />\n{#if el}<Target to={el} />{/if}'), async root => {
    const { ir } = await lowered(root);
    assert.ok(JSON.stringify(ir).includes('{"union":["string","element"]}'));
    const dom = interpret(ir, []).at(-1).state.dom;
    assert.deepEqual(dom.filter(n => typeof n !== 'string' && n.tag === 'p').map(text), [
      'body',
      'element',
    ]);
  });
  // Only elements: the default never applies, so the prop holds an element,
  // which the nullable `el` is where `{#if el}` narrowed it (M6).
  await withApp(files('{#if el}<Target to={el} />{/if}'), async root => {
    const { ir } = await lowered(root);
    assert.match(JSON.stringify(interpret(ir, []).at(-1).state.dom), /"element"/);
  });
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

test('values reach a union through bags; a default reaches it only where a site can omit the prop', async () => {
  const files = sites => ({
    'Inner.svelte': `<script lang="ts">
  type Style = string | Record<string, string>;
  let { style = {}, ...rest }: { style?: Style; id?: string } = $props();
  const css = $derived(typeof style === 'string' ? style : 'object');
</script>

<p {...rest}>{css}</p>
`,
    'Outer.svelte': `<script lang="ts">
  import Inner from './Inner.svelte';
  let { ...rest }: { style?: string | Record<string, string>; id?: string } = $props();
</script>

<Inner {...rest} />
`,
    'App.svelte': `<script lang="ts">
  import { mergeProps } from 'svelte-toolbelt';
  import Outer from './Outer.svelte';
  let color = $state('red');
  const props = $derived(mergeProps({ id: 'p', style: { margin: '0' } }, { style: \`color: \${color}\` }));
</script>

${sites}
<button id="b" onclick={() => (color = 'blue')}>c</button>
`,
  });
  // mergeProps prints the merged style: only strings reach \`style\`, and
  // every site passes it, so the default \`{}\` does not.
  await withApp(files('<Outer {...props} />'), async root => {
    const { ir } = await lowered(root);
    const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
    const p = s => steps[s].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'p');
    assert.equal(text(p(0)), 'margin: 0; color: red;');
    assert.equal(text(p(1)), 'margin: 0; color: blue;');
  });
  // A site without it gives the default: both members reach the union.
  await withApp(files('<Outer {...props} />\n<Outer id="q" />'), root =>
    assert.rejects(
      lowered(root),
      failWith('E_TYPE_UNION', 'Inner.svelte', /outside the value model/),
    ),
  );
});

test('a field only null where it is declared, set elsewhere, is not decided null', async () => {
  await withApp(
    {
      'timer.svelte.js': `export class Timer {
  #pending = null;
  label = $state('idle');
  start() {
    this.#pending = setTimeout(() => {}, 1000);
  }
  stop() {
    if (this.#pending !== null) {
      clearTimeout(this.#pending);
      this.#pending = null;
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
</script>

<button id="stop" onclick={() => timer.stop()}>{timer.label}</button>
<button id="start" onclick={() => timer.start()}>start</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'stop' },
        { kind: 'click', id: 'start' },
        { kind: 'click', id: 'stop' },
        { kind: 'click', id: 'stop' },
      ]);
      const label = s => text(steps[s].state.dom.find(n => typeof n !== 'string'));
      assert.deepEqual([1, 3, 4].map(label), ['nothing', 'cleared', 'nothing']);
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

test('snippet branches decided by the sites; snippets passed on through mergeProps constants', async () => {
  const files = (sites, middle = 'mergeProps(rest, { "data-m": "" })') => ({
    'Arrow.svelte': `<script lang="ts">
  import type { Snippet } from 'svelte';
  let { child, ...rest }: { child?: Snippet; id?: string; 'data-m'?: string } = $props();
</script>

{#if child}
  {@render child()}
{:else}
  <svg {...rest} width="10" height="5" viewBox="0 0 30 10" preserveAspectRatio="none"><polygon points="0,0 30,0 15,10" /></svg>
{/if}
`,
    'Middle.svelte': `<script lang="ts">
  import { mergeProps } from 'svelte-toolbelt';
  import type { Snippet } from 'svelte';
  import Arrow from './Arrow.svelte';
  let { ...rest }: { child?: Snippet; id?: string } = $props();
  const merged = $derived(${middle});
</script>

<Arrow {...merged} />
`,
    'App.svelte': `<script lang="ts">
  import Middle from './Middle.svelte';
</script>

${sites}
`,
  });
  // Every site passes `child` (through the rest props and a mergeProps
  // constant): the branch rendering the svg is never taken.
  await withApp(
    files('<Middle id="m">{#snippet child()}<i id="c">child</i>{/snippet}</Middle>'),
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, []);
      assert.deepEqual(steps[0].state.dom.filter(n => typeof n !== 'string').map(text), ['child']);
    },
  );
  // A site without it renders the svg, whose attribute is unsupported.
  await withApp(
    files('<Middle id="m">{#snippet child()}<i>child</i>{/snippet}</Middle>\n<Middle />'),
    root =>
      assert.rejects(lowered(root), failWith('E_TEMPLATE', 'Arrow.svelte', /preserveAspectRatio/)),
  );
  // A bag built otherwise from the rest props would lose the snippet.
  await withApp(
    files('<Middle id="m">{#snippet child()}<i>child</i>{/snippet}</Middle>', 'rest'),
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_TEMPLATE', 'Middle.svelte', /passes on the rest props/),
      ),
  );
});

test('values reach a union from the sites of props, through bags and large props types', async () => {
  const files = site => ({
    'Inner.svelte': `<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  type Target = HTMLElement | string;
  let { customAnchor, ...rest }: HTMLAttributes<HTMLDivElement> & { customAnchor?: Target | null } = $props();
  const chosen: Target | null = customAnchor ?? null;
  const label = $derived(typeof chosen === 'string' ? 'selector' : chosen ? 'element' : 'none');
</script>

<p {...rest}>{label}</p>
`,
    'Outer.svelte': `<script lang="ts">
  import { mergeProps } from 'svelte-toolbelt';
  import type { HTMLAttributes } from 'svelte/elements';
  import Inner from './Inner.svelte';
  let {
    customAnchor,
    ...rest
  }: HTMLAttributes<HTMLDivElement> & { customAnchor?: HTMLElement | string | null } = $props();
  let el = $state<HTMLElement | null>(null);
  const merged = $derived(mergeProps(rest, { customAnchor: customAnchor ?? el }));
</script>

<span bind:this={el}>s</span>
<Inner {...merged} />
`,
    'App.svelte': `<script lang="ts">
  import Outer from './Outer.svelte';
</script>

${site}
`,
  });
  // No site passes a customAnchor: only the element reaches the union.
  await withApp(files('<Outer id="o" />'), async root => {
    const { ir } = await lowered(root);
    const steps = interpret(ir, [{ kind: 'wait', ms: 0 }]);
    const p = s => steps[s].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'o');
    assert.equal(text(p(1)), 'element');
  });
  // A selector passed at the outer site reaches it through both components:
  // the outer prop holds an IR union of a string and an element (M6
  // unions), which attribute bags do not carry yet.
  await withApp(files('<Outer id="o" customAnchor="#x" />'), root =>
    assert.rejects(
      lowered(root),
      failWith('E_ATTRS', 'Outer.svelte', /customAnchor: values of type \{"union"/),
    ),
  );
});
