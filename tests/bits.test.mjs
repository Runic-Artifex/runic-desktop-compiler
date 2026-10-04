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
  for (const [entries, pattern] of [
    ['onPick: () => {}', /executeCallbacks/],
    ["style: { color: 'blue' }", /cssToStyleObj/],
  ])
    await withApp(app(entries), async root => {
      const { ir } = await lowered(root);
      assert.throws(() => interpret(ir, []), pattern);
    });
});
