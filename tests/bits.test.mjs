// Libraries compiled from source (M6 steps 5 and 6, docs/design/M6-LIBRARIES.md):
// bits-ui's Collapsible from its published package through shadcn-svelte's
// unmodified wrapper and demo, the svelte-toolbelt and runed packs it uses,
// in app code too (fixture toolbelt-svelte, run by the interpreter), and the
// rejections around them. Rendering parity with Chromium is checked by the
// `bits-collapsible` and `toolbelt` conformance cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { generate, interpret } from '../compiler/codegen.mjs';

const FIXTURE = 'fixtures/bits-collapsible-svelte';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/bits-'));
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
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const byId = (step, id) => flat(step.state.dom).find(n => n.attrs.id === id);
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

/** The fixtures built from vendored shadcn-svelte sources over bits-ui. */
const BITS_FIXTURES = readdirSync('fixtures')
  .filter(f => f.startsWith('bits-') && existsSync(path.join('fixtures', f, 'vendor.json')))
  .map(f => path.join('fixtures', f));

test('the vendored shadcn-svelte sources are unmodified', () => {
  assert.ok(BITS_FIXTURES.includes(FIXTURE));
  for (const fixture of BITS_FIXTURES) {
    const vendor = JSON.parse(readFileSync(path.join(fixture, 'vendor.json'), 'utf8'));
    const corpus = path.join('.cache/corpus', vendor.source);
    for (const [file, { upstream, sha256 }] of Object.entries(vendor.files)) {
      const bytes = readFileSync(path.join(fixture, file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `${fixture}/${file}`);
      if (existsSync(path.join(corpus, upstream)))
        assert.deepEqual(bytes, readFileSync(path.join(corpus, upstream)), upstream);
    }
  }
});

test("bits-ui's Collapsible compiles from its published source with the toolbelt and runed packs", async () => {
  const { ir } = await lowered(FIXTURE);
  const names = ir.components.map(c => c.name);
  for (const n of ['collapsible', 'collapsible-trigger', 'collapsible-content', 'button'])
    assert.ok(names.includes(n), n);
  const ids = ir.meta.mappings.map(m => m.id);
  for (const id of ['runed@0.35.1', 'svelte-toolbelt@0.10.6']) assert.ok(ids.includes(id), id);
  // The package's modules are provenance like the app's.
  assert.ok(ir.meta.provenance.some(p => p.path.includes('node_modules/bits-ui/dist/')));
  const builtins = new Set();
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (v.op === 'builtin') builtins.add(v.name);
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(ir);
  for (const b of ['attrs.merge-props', 'context.set', 'context.get', 'effect.pre', 'uid.next'])
    assert.ok(builtins.has(b), b);
  // The backend never sees framework names.
  const rust = generate(ir).replace(/^(const|static) (TITLE|CSS|IR_HASH)\b.*$/gm, '');
  assert.doesNotMatch(rust, /react|vue|svelte|\$state/i);
  // The content is measured (getBoundingClientRect): the interpreter has no
  // layout and throws rather than guessing.
  assert.throws(() => interpret(ir, []), /RunicLayoutError|needs the native layout/);
});

test('Separator and Progress: props through rest bags, values as Svelte spreads them', async () => {
  const sep = interpret((await lowered('fixtures/bits-separator-svelte')).ir, [
    { kind: 'click', id: 'orientation' },
    { kind: 'click', id: 'decorative' },
  ]);
  // `decorative` and `orientation` pass through the wrapper's rest props
  // (a boolean stays a boolean) to the bits-ui component's declared props.
  const dynamic = s => byId(s, 'dynamic').attrs;
  assert.equal(dynamic(sep[0]).role, 'separator');
  assert.equal(dynamic(sep[1])['data-orientation'], 'vertical');
  assert.deepEqual([dynamic(sep[2]).role, dynamic(sep[2])['aria-hidden']], ['none', 'true']);
  const progress = interpret((await lowered('fixtures/bits-progress-svelte')).ir, [
    { kind: 'click', id: 'unknown' },
  ]);
  const bar = s => byId(s, 'bar').children.find(n => typeof n !== 'string');
  // Svelte assigns `value` to a div's (expando) property: no attribute.
  assert.equal(bar(progress[0]).attrs.value, undefined);
  assert.equal(bar(progress[0]).attrs['aria-valuenow'], '25');
  assert.equal(bar(progress[1]).attrs['data-state'], 'indeterminate');
  assert.equal(bar(progress[1]).children[0].attrs.style, 'transform: translateX(-100%);');
});

test("svelte-toolbelt's srOnlyStyles in the pack is the package's", async () => {
  const { SR_ONLY_STYLES } = await import('../frontend/packs/svelte-toolbelt-0.10.6.ts');
  const { srOnlyStyles } =
    await import('../node_modules/svelte-toolbelt/dist/utils/sr-only-styles.js');
  assert.deepEqual(Object.entries(SR_ONLY_STYLES), Object.entries(srOnlyStyles));
});

test('Checkbox and Label: label activation, double clicks (e.detail), the hidden input', async () => {
  const { ir } = await lowered('fixtures/bits-checkbox-svelte');
  const steps = interpret(ir, [
    { kind: 'click', id: 'bound' },
    { kind: 'click', id: 'bound-label' },
    { kind: 'dblclick', id: 'bound-label' },
    { kind: 'click', id: 'toggle-checkbox' },
  ]);
  // checked, indeterminate, onCheckedChange calls: the first click clears
  // indeterminate and checks; the label's click toggles the button; a
  // double click toggles twice; the disabled box ignores clicks.
  assert.deepEqual(
    steps.map(s => text(byId(s, 'state')).trim()),
    ['false true 0', 'true false 1', 'false false 2', 'false false 4', 'false false 4'],
  );
  // The hidden input: checked as a property (no attribute), srOnlyStyles.
  const button = byId(steps[1], 'bound');
  assert.equal(button.attrs['aria-checked'], 'true');
  const input = flat(steps[1].state.dom).find(n => n.tag === 'input' && n.attrs.name === 'bound');
  assert.equal(input.attrs.checked, undefined);
  assert.equal(input.checked, true);
  assert.match(input.attrs.style, /^position: absolute; width: 1px;.* top: 0px; left: 0px;$/);
});

test('another version of a package compiled from source is rejected', async () => {
  await withApp(
    {
      'App.svelte':
        '<script lang="ts">\n  import { Collapsible } from \'bits-ui\';\n</script>\n<Collapsible.Root />\n',
      'node_modules/bits-ui/package.json': JSON.stringify({
        name: 'bits-ui',
        version: '2.0.0',
        type: 'module',
        sideEffects: false,
        svelte: './index.js',
        exports: { '.': { types: './index.d.ts', svelte: './index.js', default: './index.js' } },
      }),
      'node_modules/bits-ui/index.js': 'export const Collapsible = {};\n',
      'node_modules/bits-ui/index.d.ts': 'export declare const Collapsible: {};\n',
    },
    async root =>
      assert.rejects(lowered(root), failWith('E_SOURCE_VERSION', 'App.svelte', /2\.19\.2/)),
  );
});

test('spreads: data and aria booleans become text, callbacks reach declared props', async () => {
  await withApp(
    {
      'Child.svelte': `<script lang="ts">
  let { label = 'none', onPick, ...rest }: { label?: string; onPick?: (n: number) => void; [k: string]: unknown } = $props();
</script>
<button id="pick" {...rest} onclick={() => onPick?.(2)}>{label}</button>
`,
      'Middle.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  let { ...rest }: { [k: string]: unknown } = $props();
</script>
<Child {...rest} />
`,
      'App.svelte': `<script lang="ts">
  import Middle from './Middle.svelte';
  let on = $state(false);
  let picked = $state(0);
</script>
<Middle data-on={on} aria-pressed={on} hidden={false} label={on ? 'yes' : undefined} onPick={(n: number) => (picked += n)} />
<button id="flip" onclick={() => (on = !on)}>flip</button>
<p id="out">{picked}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'pick' },
        { kind: 'click', id: 'flip' },
      ]);
      const attrs = s => byId(s, 'pick').attrs;
      // Booleans of attributes without a boolean property are set as text;
      // `hidden: false` removes the attribute.
      assert.deepEqual(attrs(steps[0]), {
        'aria-pressed': 'false',
        'data-on': 'false',
        id: 'pick',
      });
      assert.deepEqual(attrs(steps[2]), { 'aria-pressed': 'true', 'data-on': 'true', id: 'pick' });
      // Undefined takes the prop's default; the callback from the bag is called.
      assert.equal(text(byId(steps[0], 'pick')), 'none');
      assert.equal(text(byId(steps[2], 'pick')), 'yes');
      assert.equal(text(byId(steps[1], 'out')), '2');
    },
  );
});

test('svelte-toolbelt and runed in app code: the toolbelt fixture in the interpreter', async () => {
  const { ir } = await lowered('fixtures/toolbelt-svelte');
  // The case's clicks (the interpreter has no keyboard focus: no presses).
  const actions = JSON.parse(
    readFileSync('conformance/cases/toolbelt.json', 'utf8'),
  ).actions.filter(a => a.kind === 'click');
  const steps = interpret(ir, actions);
  const state = steps.map(s => text(byId(s, 'state')).trim());
  // Trigger and outside toggles; a cancelled click does not toggle;
  // onOpenChange counts the trigger's changes only; the panel's attachment
  // clears the bound ref when the disclosure unmounts.
  assert.deepEqual(state, [
    'false 0 false ref',
    'true 1 false ref',
    'false 1 false ref',
    'false 1 true ref',
    'false 1 true ref',
    'false 1 false ref',
    'true 2 false ref',
    'true 2 false no ref',
    'true 2 false ref',
    'false 3 false ref',
  ]);
  const root = byId(steps[2], 'root-c1');
  // mergeProps: the user's class first, the state's style object printed.
  assert.equal(root.attrs.class, 'user root');
  assert.equal(root.attrs.style, '--toggles: 2;');
  assert.match(text(root), /toggles 2, panel panel-c2/);
  // A remount takes new ids.
  assert.ok(byId(steps[8], 'root-c3'));
});

test('mergeProps shapes outside the pack fail at run time', async () => {
  const app = merged => ({
    'state.svelte.ts': `export class S {
  a: Record<string, unknown> = $derived.by(() => ({ onPick: () => {}, style: 'color: red' }));
  b: Record<string, unknown> = $derived.by(() => ({ ${merged} }));
}
`,
    'App.svelte': `<script lang="ts">
  import { mergeProps } from 'svelte-toolbelt';
  import { S } from './state.svelte.ts';
  const s = new S();
  const m = $derived(mergeProps(s.a, s.b));
</script>
<div id="out" {...m}></div>
`,
  });
  for (const [entries, pattern] of [['onPick: () => {}', /executeCallbacks/]])
    await withApp(app(entries), async root => {
      const { ir } = await lowered(root);
      assert.throws(() => interpret(ir, []), pattern);
    });
  // A style string and a style object merge through cssToStyleObj
  // (crates/runic-js/src/style_parse.rs), as svelte-toolbelt does.
  await withApp(app("style: { color: 'blue', marginTop: '1px' }"), async root => {
    const { ir } = await lowered(root);
    assert.equal(byId(interpret(ir, [])[0], 'out').attrs.style, 'color: blue; margin-top: 1px;');
  });
});

// (Records spread with keys a package's object literals may leave out,
// bits-ui's floatingStyles, are compared with Chromium by the bits-popover
// conformance case.)
test('a style record spread into a style object keeps its keys in order', async () => {
  await withApp(
    {
      'state.svelte.ts': `export class S {
  wide = $state(false);
  styles = $derived.by(() => ({
    position: 'absolute',
    left: this.wide ? '2px' : '0',
    top: '1px',
  }));
  props: Record<string, unknown> = $derived.by(() => ({
    id: 'p',
    style: { ...this.styles, zIndex: '2' },
  }));
}
`,
      'App.svelte': `<script lang="ts">
  import { mergeProps } from 'svelte-toolbelt';
  import { S } from './state.svelte.ts';
  const s = new S();
  const m = $derived(mergeProps(s.props, { style: { color: 'red' } }));
</script>
<p {...m}>x</p>
<button id="b" onclick={() => (s.wide = !s.wide)}>wide</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      // (svelte-toolbelt's mergeProps in Node gives the same keys in the
      // same order; the element's style serialises `0` as `0px`.)
      assert.equal(
        byId(steps[0], 'p').attrs.style,
        'position: absolute; left: 0px; top: 1px; z-index: 2; color: red;',
      );
      assert.equal(
        byId(steps[1], 'p').attrs.style,
        'position: absolute; left: 2px; top: 1px; z-index: 2; color: red;',
      );
    },
  );
});

test('Avatar: Avatar.Image pins its sources (new Image() and <img>), open ones are E_ASSET', async () => {
  const graph = await collect('fixtures/bits-avatar-svelte');
  const { ir, imageUrls } = await lower(graph, { images: false });
  const SHADCN = 'https://github.com/shadcn.png?size=40';
  const RABBIT = 'https://github.com/evilrabbit.png?size=40';
  const MISSING = 'https://github.com/runic-artifex-no-such-user-404.png?size=40';
  // The literals App.svelte passes reach bits-ui's `<img {...mergedProps}
  // {src} />` through the props and `image.src = src` in its root state's
  // `loadImage` through the box, the runed watch and the method's call site.
  const by = file =>
    [...new Set(imageUrls.filter(u => u.source.file.endsWith(file)).map(u => u.url))].sort();
  assert.deepEqual(by('components/avatar-image.svelte'), [RABBIT, MISSING, SHADCN].sort());
  assert.deepEqual(by('avatar/avatar.svelte.js'), [RABBIT, MISSING, SHADCN].sort());
  const names = new Set();
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (v.op === 'builtin' && v.name.startsWith('image.')) names.add(v.name);
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(ir);
  assert.deepEqual([...names].sort(), [
    'image.new',
    'image.set-cross-origin',
    'image.set-handler',
    'image.set-referrer-policy',
    'image.set-src',
  ]);
  // The interpreter loads no images: the avatars stay loading (the
  // differential reports the program incomplete).
  const steps = interpret(ir, [{ kind: 'click', id: 'small' }]);
  assert.equal(byId(steps[1], 'cn').attrs['data-size'], 'sm');
  assert.equal(byId(steps[1], 'cn').attrs['data-status'], 'loading');

  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/avatar-'));
  try {
    await cp('fixtures/bits-avatar-svelte', root, { recursive: true });
    const app = path.join(root, 'src/App.svelte');
    const code = readFileSync(app, 'utf8');
    // An open source: rejected at the site that passes it (followed back
    // from bits-ui's code through the props).
    await writeFile(
      app,
      code.replace(
        '<Avatar.Image src={SHADCN} alt="@shadcn" />',
        '<Avatar.Image src={trace.join("")} alt="@shadcn" />',
      ),
    );
    await assert.rejects(
      lower(await collect(root), { images: false }),
      failWith('E_ASSET', 'src/App.svelte', /may take this value, which is open/),
    );
    // A crossorigin with a value: rejected at the spread.
    await writeFile(
      app,
      code.replace(
        '<Avatar.Image src={SHADCN} alt="@shadcn" />',
        '<Avatar.Image src={SHADCN} alt="@shadcn" crossorigin="anonymous" />',
      ),
    );
    await assert.rejects(
      lower(await collect(root), { images: false }),
      failWith(
        'E_TEMPLATE',
        'node_modules/bits-ui/dist/bits/avatar/components/avatar-image.svelte',
        /This spread may give the <img> a crossorigin attribute/,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SvelteMap key reads in effects are reported; iteration and untracked reads are not; dictionary objects guard prototype names', async () => {
  // A key read by a tracked effect: Svelte tracks that key, this the map.
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  const m = new SvelteMap<string, number>();
  let seen = $state(0);
  $effect(() => {
    seen = m.get('a') ?? 0;
  });
</script>
<button id="b" onclick={() => m.set('a', 1)}>{seen}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.match(
        JSON.stringify(steps.map(x => x.outcome)),
        /keyed collection read by a tracked effect/,
      );
    },
  );
  // Iteration depends on every entry in Svelte too, and handlers do not track.
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  const m = new SvelteMap<string, number>();
  let total = $state(0);
  let size = $state(0);
  $effect(() => {
    let t = 0;
    for (const [, v] of m) t += v;
    for (const v of m.values()) t += v;
    total = t;
  });
</script>
<button id="b" onclick={() => { m.set(String(size), 2); size = m.size; }}>{total} {size}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'b' },
        { kind: 'click', id: 'b' },
      ]);
      assert.equal(text(byId(steps[2], 'b')), '8 2');
    },
  );
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let key = $state('Home');
  let out = $state('');
  function pick(k: string) {
    const table = { Home: 0, [k + '!']: 1 };
    out = String(table[key] ?? -1);
  }
</script>
<button id="home" onclick={() => pick('x')}>{out}</button>
<button id="proto" onclick={() => (key = 'toString')}>proto</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'home' }]);
      assert.equal(text(byId(steps[1], 'home')), '0');
      // A prototype member's name is not read as an entry.
      const rejected = interpret(ir, [
        { kind: 'click', id: 'proto' },
        { kind: 'click', id: 'home' },
      ])[2].outcome.rejected;
      assert.match(rejected.message, /RunicUnsupportedError.*Object\.prototype member/);
    },
  );
});

test('ToggleGroup: multiple and single programs, one type per program', async () => {
  const multiple = (await lowered('fixtures/bits-toggle-group-svelte')).ir;
  const m = interpret(multiple, [
    { kind: 'click', id: 'italic' },
    { kind: 'click', id: 'bold' },
    { kind: 'click', id: 'underline' },
    { kind: 'click', id: 'reset' },
  ]);
  assert.deepEqual(
    m.map(s => text(byId(s, 'state'))),
    ['bold 0', 'bold,italic 1', 'italic 2', 'italic 2', 'italic 2'],
  );
  assert.equal(byId(m[1], 'italic').attrs['aria-pressed'], 'true');
  assert.equal(byId(m[1], 'italic').attrs['data-variant'], 'default');
  const single = (await lowered('fixtures/bits-toggle-group-single-svelte')).ir;
  const s = interpret(single, [
    { kind: 'click', id: 'center' },
    { kind: 'click', id: 'center' },
    { kind: 'click', id: 'reset' },
  ]);
  assert.deepEqual(
    s.map(x => text(byId(x, 'state'))),
    ['left 0', 'center 1', ' 2', 'center 2'],
  );
  assert.equal(byId(s[1], 'center').attrs['aria-checked'], 'true');
  assert.equal(byId(s[1], 'center').attrs.role, 'radio');
  // Both types in one program: the value is a string or an array.
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { ToggleGroup } from 'bits-ui';
  let one = $state('a');
  let many = $state<string[]>([]);
</script>
<ToggleGroup.Root type="single" bind:value={one}><ToggleGroup.Item value="a">A</ToggleGroup.Item></ToggleGroup.Root>
<ToggleGroup.Root type="multiple" bind:value={many}><ToggleGroup.Item value="a">A</ToggleGroup.Item></ToggleGroup.Root>
`,
    },
    async root =>
      assert.rejects(
        lowered(root),
        failWith(
          'E_TYPE_UNION',
          'node_modules/bits-ui/dist/bits/toggle-group/components/toggle-group.svelte',
          /type is "single" and "multiple" at different sites/,
        ),
      ),
  );
});

test('svelte contexts with string keys, getter objects, bound optional props, capitalize', async () => {
  const context = (body, get) => ({
    'Ctx.svelte': `<script lang="ts" module>
  import { getContext, setContext } from 'svelte';
  interface C { tone?: string }
  export function setC(c: C) { setContext('c', c); }
  export function getC() { return ${get}; }
</script>
<script lang="ts">
  let { children }: { children?: import('svelte').Snippet } = $props();
  let tone = $state('loud');
  setC({ get tone() { return tone; } });
</script>
<button id="t" onclick={() => (tone = tone === 'loud' ? 'soft' : 'loud')}>t</button>
{@render children?.()}
`,
    'Show.svelte': `<script lang="ts">
  import { getC } from './Ctx.svelte';
  const c = getC();
</script>
<p id="show">${body}</p>
`,
    'App.svelte': `<script lang="ts">
  import Ctx from './Ctx.svelte';
  import Show from './Show.svelte';
</script>
<Ctx><Show /></Ctx>
<Show />
`,
  });
  // A getter is read each time: the context follows the state. A component
  // outside the provider reads undefined where the type allows it, and
  // throws RunicUnsupportedError where it does not.
  await withApp(context("{c?.tone ?? 'none'}", "getContext<C | undefined>('c')"), async root => {
    const { ir } = await lowered(root);
    const steps = interpret(ir, [{ kind: 'click', id: 't' }]);
    const shown = st =>
      flat(st.state.dom)
        .filter(n => n.attrs.id === 'show')
        .map(text);
    assert.deepEqual(shown(steps[0]), ['loud', 'none']);
    assert.deepEqual(shown(steps[1]), ['soft', 'none']);
  });
  await withApp(context('{c.tone}', "getContext<Required<C>>('c')"), async root => {
    const { ir } = await lowered(root);
    assert.throws(
      () => interpret(ir, []),
      /RunicUnsupportedError: getContext\(\\?"c\\?"\): no parent/,
    );
  });
  await withApp(
    {
      ...context('{c.tone}', "getContext<Required<C>>('c' + '')"),
      'App.svelte': `<script lang="ts">
  import Ctx from './Ctx.svelte';
  import Show from './Show.svelte';
</script>
<Ctx><Show /></Ctx>
`,
    },
    async root =>
      assert.rejects(lowered(root), failWith('E_CAPABILITY', 'Ctx.svelte', /string literal key/)),
  );
  // A variable of the present type bound to an optional prop its component
  // may set to undefined.
  await withApp(
    {
      'Child.svelte': `<script lang="ts">
  let { value = $bindable() }: { value?: string } = $props();
</script>
<button id="clear" onclick={() => (value = undefined)}>{value}</button>
`,
      'App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  let v = $state('a');
</script>
<Child bind:value={v} />
`,
    },
    async root => assert.rejects(lowered(root), failWith('E_TEMPLATE', 'App.svelte', /undefined/)),
  );
  // Blitz transforms text to upper and lower case only.
  await withApp(
    {
      'style.css': '.c { text-transform: capitalize; }\n',
      'App.svelte': '<p class="c">a</p>\n',
    },
    async root =>
      assert.rejects(lowered(root), e => {
        assert.equal(e.code, 'E_CSS_PROPERTY');
        assert.match(e.message, /capitalize/);
        return true;
      }),
  );
});

test('Accordion: single and multiple compile; watch effects are functions of the values', async () => {
  // The fixtures read layout (the content's size), so the conformance cases
  // bits-accordion and bits-accordion-multiple run them.
  for (const fixture of [
    'fixtures/bits-accordion-svelte',
    'fixtures/bits-accordion-multiple-svelte',
  ]) {
    const { ir } = await lowered(fixture);
    assert.ok(
      ir.components.some(c => c.name === 'accordion-content'),
      fixture,
    );
  }
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { watch } from 'runed';
  let a = $state(1);
  const f = (s: string) => console.log(s);
  watch(() => a, f as never);
</script>
<p>{a}</p>
`,
    },
    async root =>
      assert.rejects(
        lowered(root),
        failWith('E_PACK', 'App.svelte', /function of the sources' values/),
      ),
  );
  // An effect that takes fewer values than there are sources (bits-ui's
  // RadioGroupItemState watches two values with `() => …`).
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { watch } from 'runed';
  let a = $state(1);
  let b = $state(1);
  let runs = $state(0);
  watch([() => a, () => b], () => {
    runs++;
  });
</script>
<button id="a" onclick={() => a++}>{runs}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'a' }]);
      assert.deepEqual(
        steps.map(s => text(byId(s, 'a'))),
        ['1', '2'],
      );
    },
  );
});

test("bits-ui's Command compiles: its untyped score function, contexts typed by what is set, script reordering", async () => {
  const { ir } = await lowered('fixtures/bits-command-svelte');
  const builtins = new Set();
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (v.op === 'builtin') builtins.add(v.name);
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(ir);
  // Sorting moves items (appendChild), script writes data-value, the first
  // item of a group is found past whitespace, selectors escape values, and
  // the state is published as a snapshot holding a map and a set.
  for (const b of [
    'element.appendChild',
    'element.setAttribute',
    'element.firstNonCommentNode',
    'css.escape',
    'structuredClone',
  ])
    assert.ok(builtins.has(b), b);
  // The recursive score function, typed from its calls outside itself.
  assert.ok(ir.functions.some(f => f.name === 'computeCommandScoreInner'));
  // setState(key, …) takes the keys of every call, through the declaration
  // file's class too (the input's `this.root.setState("search", …)`).
  const setState = JSON.stringify(ir.functions.find(f => f.name === 'CommandRootState.setState'));
  for (const key of ['search', 'value']) assert.ok(setState.includes(`"value":"${key}"`), key);
  // Script writing attributes and moving nodes needs the native DOM.
  assert.throws(() => interpret(ir, []), /RunicLayoutError|needs the native DOM/);
});
