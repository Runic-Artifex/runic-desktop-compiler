// Symbols as svelte context keys (frontend/svelte-context.ts): a module
// constant `Symbol(description?)` used only as the key of setContext,
// getContext and hasContext, as shadcn-svelte's carousel keys its context.
// Every other use of a symbol needs symbol values and is rejected where it
// stands. The fixture is also conformance case `symbol-context`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const FIXTURE = 'fixtures/symbol-context-svelte';

const lowered = root => collect(root).then(g => lower(g));
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const byId = (step, id) => flat(step.state.dom).find(n => n.attrs.id === id);
const shown = (step, id) => text(byId(step, id)).replace(/\s+/g, ' ').trim();

/** The literal keys of the program's context built-ins. */
function contextKeys(ir) {
  const keys = new Set();
  JSON.stringify(ir, (_, v) => {
    if (v && v.op === 'builtin' && /^context\.(set|get)$/.test(v.name)) keys.add(v.args[0].value);
    return v;
  });
  return [...keys].sort();
}

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

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/symbol-'));
  try {
    await cp(path.join(FIXTURE, 'assets'), path.join(root, 'assets'), { recursive: true });
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
    for (const [file, body] of Object.entries(all)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), body);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('symbol context keys: one context per constant, nearest provider, hasContext', async () => {
  const { ir } = await lowered(FIXTURE);
  // TONE and OTHER share a description and are two contexts; UNSET is
  // never set, so hasContext of it is false without a lookup.
  assert.deepEqual(contextKeys(ir), ['symbol:TONE#1', 'symbol:TONE#2']);
  const steps = interpret(ir, [
    { kind: 'click', id: 'a-bump' },
    { kind: 'click', id: 'b-bump' },
    { kind: 'click', id: 'c-bump' },
    { kind: 'click', id: 'd-bump' },
    { kind: 'click', id: 'inner-reset' },
  ]);
  const row = step => ['a', 'b', 'c', 'd'].map(id => shown(step, `${id}-text`));
  assert.deepEqual(row(steps[0]), ['outer: 0', 'inner: 0', 'inner: 0', 'third: 0']);
  assert.deepEqual(row(steps[3]), ['outer: 1', 'inner: 2', 'inner: 2', 'third: 0']);
  assert.deepEqual(row(steps[4]), ['outer: 1', 'inner: 2', 'inner: 2', 'third: 1']);
  assert.deepEqual(row(steps[5]), ['outer: 1', 'inner: 0', 'inner: 0', 'third: 1']);
  assert.deepEqual(
    ['p1', 'p2', 'p3', 'p4'].map(id => shown(steps[0], id)),
    [
      'tone · other: none · unset: false',
      'no tone · other: other value · unset: false',
      'tone · other: other value · unset: false',
      'no tone · other: none · unset: false',
    ],
  );
});

test('a $state object shared through a context and mutated is rejected where a constant reads it', async () => {
  // The carousel's pattern (`let carouselState = $state<EmblaContext>({…})`
  // set as the context, read as `const emblaCtx = getEmblaContext()`):
  // Svelte tracks reads through the proxy, a native constant does not.
  const files = {};
  for (const f of ['context.ts', 'Show.svelte', 'Probe.svelte', 'Other.svelte', 'App.svelte'])
    files[f] = await readFile(path.join(FIXTURE, f), 'utf8');
  files['Provider.svelte'] = `<script lang="ts">
  import type { Snippet } from 'svelte';
  import { setTone, type Tone } from './context.ts';
  let { label, children }: { label: string; children?: Snippet } = $props();
  // svelte-ignore state_referenced_locally
  let tone = $state<Tone>({ label, count: 0, bump, reset });
  setTone(tone);
  function bump() { tone.count += 1; }
  function reset() { tone.count = 0; }
</script>
<h2>{label} ({tone.count})</h2>
{@render children?.()}
`;
  await withApp(files, async root =>
    assert.rejects(
      lowered(root),
      failWith('E_REACTIVITY', 'Show.svelte', /tone holds a value that may be deep state/),
    ),
  );
});

/** An app whose context module declares KEY and `extra`; components add `uses`. */
const app = (extra, { context = '', show = '' } = {}) => ({
  'context.ts': `import { getContext, hasContext, setContext } from 'svelte';
export const KEY = Symbol('k');
export function setK(v: number) { setContext(KEY, v); }
export function getK() { return getContext<number | undefined>(KEY); }
export function hasK() { return hasContext((KEY)); }
${extra}
`,
  'Provider.svelte': `<script lang="ts">
  import type { Snippet } from 'svelte';
  import { setK } from './context.ts';
  let { children }: { children?: Snippet } = $props();
  setK(7);${context}
</script>
{@render children?.()}
`,
  'Show.svelte': `<script lang="ts">
  import { getK, hasK } from './context.ts';
  let { id }: { id: string } = $props();
  const k = getK() ?? 0;
  const has = hasK();${show}
</script>
<p {id}>{k} {has}</p>
`,
  'App.svelte': `<script lang="ts">
  import Provider from './Provider.svelte';
  import Show from './Show.svelte';
</script>
<Provider><Show id="in" /></Provider>
<Show id="out" />
`,
});

test('symbol context keys: accepted through re-exports and type positions', async () => {
  // A key re-exported under another name and used as a key in another
  // module; `typeof KEY` in a type is not a use.
  await withApp(
    {
      ...app(`export type Key = typeof KEY;`),
      'keys.ts': `export { KEY as RENAMED } from './context.ts';\n`,
      'reader.ts': `import { getContext } from 'svelte';
import { RENAMED } from './keys.ts';
import type { Key } from './context.ts';
export function read(): number | undefined { return getContext<number | undefined>(RENAMED); }
export type K2 = Key | typeof RENAMED;
`,
      'Show.svelte': `<script lang="ts">
  import { read } from './reader.ts';
  let { id }: { id: string } = $props();
  const k = read() ?? 0;
</script>
<p {id}>{k}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      assert.deepEqual(contextKeys(ir), ['symbol:k#1']);
      const [first] = interpret(ir, []);
      assert.deepEqual([shown(first, 'in'), shown(first, 'out')], ['7', '0']);
    },
  );
});

test('symbol context keys: every use needing a symbol value is rejected where it stands', async () => {
  const symbolUse = /KEY is a symbol, supported only as the key of svelte's setContext/;
  const inContext = [
    ['export const d = () => KEY.description;', symbolUse],
    ['export const s = () => KEY.toString();', symbolUse],
    ['export const s = () => String(KEY);', symbolUse],
    ['export const s = () => `${KEY}`;', symbolUse],
    ["const OTHER = Symbol('k');\nexport const same = () => KEY === OTHER;", symbolUse],
    ['export const m = () => new Map([[KEY, 1]]);', symbolUse],
    ['export const o = () => ({ [KEY]: 1 });', symbolUse],
    ['export const alias = () => KEY;', symbolUse],
    ['export function pass(f: (k: symbol) => void) { f(KEY); }', symbolUse],
    ["export function wrong() { setContext('x', KEY); }", symbolUse],
    ['export default KEY;', symbolUse],
    [
      'const make = (k: symbol) => class { k = k; };\nexport class C extends make(KEY) {}',
      symbolUse,
    ],
  ];
  for (const [extra, pattern] of inContext)
    await withApp(app(extra), async root =>
      assert.rejects(lowered(root), failWith('E_TYPE_UNSUPPORTED', 'context.ts', pattern), extra),
    );
  // A use in a component that imports the key, by name or as the default
  // export (`export { KEY as default }` alone is not a use).
  for (const [extra, show] of [
    ['', "\n  import { KEY } from './context.ts';\n  console.log(KEY);"],
    ['export { KEY as default };', "\n  import K from './context.ts';\n  const s = String(K);"],
  ])
    await withApp(app(extra, { show }), async root =>
      assert.rejects(lowered(root), failWith('E_TYPE_UNSUPPORTED', 'Show.svelte', /is a symbol/)),
    );
  // A use in a template.
  const files = app('');
  files['Show.svelte'] = files['Show.svelte'].replace(
    '</script>',
    "  import { KEY } from './context.ts';\n</script>\n<p>{KEY.description}</p>",
  );
  await withApp(files, async root =>
    assert.rejects(lowered(root), failWith('E_TYPE_UNSUPPORTED', 'Show.svelte', /is a symbol/)),
  );
  // Symbols the constant form does not cover: registered and well-known
  // symbols, a description that is not a literal, a `let`, and a symbol
  // created in a function (once per call).
  const outside = /bigint and symbol values are outside the supported value model/;
  for (const [extra, code, pattern] of [
    ["export const R = Symbol.for('k');", 'E_TYPE_UNSUPPORTED', outside],
    ['export const I = Symbol.iterator;', 'E_TYPE_UNSUPPORTED', outside],
    [
      "const d = 'k';\nexport const D = Symbol(d);",
      'E_TYPE_UNSUPPORTED',
      /string literal description or none/,
    ],
    ["export let L = Symbol('k');", 'E_TYPE_UNSUPPORTED', outside],
    [
      "export function fresh() { const k = Symbol('k'); setContext(k, 1); }",
      'E_TYPE_UNSUPPORTED',
      outside,
    ],
  ])
    await withApp(app(extra, { context: '' }), async root =>
      assert.rejects(lowered(root), failWith(code, 'context.ts', pattern), extra),
    );
});
