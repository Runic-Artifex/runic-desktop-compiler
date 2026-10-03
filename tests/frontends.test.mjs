// Framework adapters on the shared language layer: observable semantics
// (through the reference interpreter) and diagnostics for uncovered input.
// Behaviour against the real frameworks is checked by conformance/run.mjs;
// these tests pin adapter decisions and rejection locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret, generate } from '../compiler/codegen.mjs';

const graphs = new Map();
const graph = name => {
  if (!graphs.has(name)) graphs.set(name, collect(name.includes('/') ? name : 'fixtures/' + name));
  return graphs.get(name);
};

/** The collected fixture with `from` replaced by `to` in `file` (default: the component). */
async function edit(name, file, from, to) {
  const g = await graph(name);
  const id = file
    ? path.join(g.root, file)
    : [...g.modules.keys()].find(f => /\.(svelte|vue)$/.test(f));
  const m = g.modules.get(id);
  assert.ok(m.code.includes(from), `Replacement must match in ${name}: ${from}`);
  const code = m.code.replace(from, to);
  const modules = new Map(g.modules);
  modules.set(id, { ...m, code });
  return { ...g, modules, hash: hash(code) };
}

/** A React app whose entry is `source` followed by the bootstrap. */
async function react(source, run, files = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/react-'));
  try {
    await writeFile(
      path.join(root, 'runic.json'),
      JSON.stringify({ entry: 'main.jsx', title: 'T' }),
    );
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>',
    );
    await writeFile(
      path.join(root, 'main.jsx'),
      `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';${source}\ncreateRoot(document.getElementById('root')).render(<App/>);`,
    );
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const failWith = (code, file) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    e.source.column > 0) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
/** Text of each element id in the DOM after the last action. */
function texts(steps, ids) {
  const dom = flat(steps.at(-1).state.dom);
  return Object.fromEntries(
    ids.map(id => [
      id,
      dom
        .find(n => n.attrs.id === id)
        ?.children.map(textOf)
        .join(''),
    ]),
  );
}
const run = (ir, actions) => interpret(ir, actions);

test('React reads the render snapshot; Vue and Svelte read the current value', async () => {
  const actions = [{ kind: 'click', id: 'sequence' }];
  const r = run((await lower(await graph('counter-react'))).ir, actions);
  const v = run((await lower(await graph('counter-vue'))).ir, actions);
  const s = run((await lower(await graph('counter-svelte'))).ir, actions);
  assert.deepEqual(r.at(-1).state.cells, [3, 1, 1, true]);
  assert.deepEqual(v.at(-1).state.cells, [3, 1, 3, true]);
  assert.deepEqual(texts(s, ['value', 'seen', 'observed', 'during', 'initial']), {
    value: '3',
    seen: '1',
    observed: '6',
    during: '4',
    initial: '1',
  });
  // The backend never sees framework names or reactivity APIs.
  const rust = generate((await lower(await graph('counter-vue'))).ir).replace(
    /^(const|static) (TITLE|CSS|IR_HASH)\b.*$/gm,
    '',
  );
  assert.doesNotMatch(rust, /react|vue|svelte|\.value\b|computed\(|\$state/i);
});

test('editors keep arbitrary UTF-16 content and honour locks in all frameworks', async () => {
  for (const name of ['editor-react', 'editor-vue', 'editor-svelte']) {
    const { ir } = await lower(await graph(name));
    for (const value of ['é', '😀', 'e\u0301', '日本語', '<&"', '😀'.repeat(128)]) {
      const steps = run(ir, [{ kind: 'input', id: 'editor', value }]);
      assert.deepEqual(
        texts(steps, ['preview', 'count']),
        { preview: value, count: String(value.length) },
        name,
      );
      const cleared = run(ir, [
        { kind: 'input', id: 'editor', value },
        { kind: 'click', id: 'clear' },
      ]);
      assert.deepEqual(texts(cleared, ['preview', 'count']), { preview: '', count: '0' }, name);
    }
    for (const lock of ['lock', 'readonly']) {
      const steps = run(ir, [
        { kind: 'input', id: 'editor', value: 'before' },
        { kind: 'click', id: lock },
        { kind: 'input', id: 'editor', value: 'after' },
      ]);
      assert.equal(texts(steps, ['preview']).preview, 'before', `${name} ${lock}`);
    }
  }
});

test('Svelte inline handlers, getter blocks, else branches and whitespace lower explicitly', async () => {
  const inline = await lower(
    await edit(
      'counter-svelte',
      null,
      'onclick={increment}',
      'onclick={() => { n += 1; n = Math.min(n, 3); }}',
    ),
  );
  assert.deepEqual(texts(run(inline.ir, [{ kind: 'click', id: 'increment' }]), ['value']), {
    value: '2',
  });
  const getter = await lower(
    await edit('counter-svelte', null, '()=>n*2', '() => { return n*2; }'),
  );
  assert.equal(
    texts(run(getter.ir, [{ kind: 'click', id: 'sequence' }]), ['observed']).observed,
    '6',
  );
  const branches = await lower(
    await edit(
      'counter-svelte',
      null,
      'Visible</p>{/if}',
      'Visible</p>{:else}<p id="hidden">Hidden</p>{/if}',
    ),
  );
  assert.equal(
    texts(run(branches.ir, [{ kind: 'click', id: 'toggle' }]), ['hidden']).hidden,
    'Hidden',
  );
  const spaced = await lower(
    await edit(
      'counter-svelte',
      null,
      '<p id="value">{label}</p>',
      '<p id="value">  Count {label} units  </p>',
    ),
  );
  assert.equal(texts(run(spaced.ir, []), ['value']).value, 'Count 1 units');
  const explicit = await lower(
    await edit(
      'editor-svelte',
      null,
      'bind:value={text}',
      'value={text} oninput={(event) => text = event.currentTarget.value}',
    ),
  );
  assert.equal(
    texts(run(explicit.ir, [{ kind: 'input', id: 'editor', value: 'é😀' }]), ['count']).count,
    '3',
  );
});

test('shared local modules give identical behaviour in all three frameworks', async () => {
  const actions = [
    { kind: 'click', id: 'increment' },
    { kind: 'click', id: 'sequence' },
    { kind: 'click', id: 'increment' },
    { kind: 'click', id: 'increment' },
    { kind: 'click', id: 'toggle' },
    { kind: 'click', id: 'reset' },
  ];
  const ids = ['heading', 'value', 'seen', 'initial', 'flag', 'details'];
  const traces = [];
  for (const f of ['react', 'vue', 'svelte']) {
    const { ir } = await lower(await graph('modules-' + f));
    traces.push(run(ir, actions).map(s => texts([s], ids)));
  }
  assert.deepEqual(traces[0], traces[1]);
  assert.deepEqual(traces[1], traces[2]);
  assert.equal(traces[0][0].heading, 'Shared modules');
  for (const f of ['react', 'vue', 'svelte']) {
    const { ir } = await lower(await edit('modules-' + f, 'logic.ts', 'starting=0', 'starting=1'));
    assert.deepEqual(texts(run(ir, []), ['value', 'initial']), { value: '1', initial: '1' }, f);
  }
});

test('modules reject mutable state, effects and unsupported import/export forms', async () => {
  const cases = [
    ['export const starting=0;', 'export let starting=0;', 'E_MODULE'],
    ['export const starting=0;', 'console.log(1);export const starting=0;', 'E_MODULE'],
    ['export const starting=0;', 'export default 0;', 'E_IMPORT'],
    ['export const starting=0;', 'class A {}\nexport const starting=0;', 'E_TYPE_UNSUPPORTED'],
    ["export {advance} from './advance.js';", "export * from './advance.js';", 'E_IMPORT'],
    ['import {LIMIT as maximum}', 'import * as maximum', 'E_IMPORT'],
    ['export const starting=0;', 'export const starting=new Date().getTime();', 'E_NEW'],
  ];
  for (const f of ['react', 'vue', 'svelte'])
    for (const [from, to, code] of cases)
      await assert.rejects(
        lower(await edit('modules-' + f, 'logic.ts', from, to)),
        failWith(code, 'logic.ts'),
      );
});

test('every file has ES module scope: a local Math shadows the global', async () => {
  for (const f of ['vue', 'svelte']) {
    // A component-local Math is a number; Math.min on it is not a builtin.
    const component = f === 'vue' ? 'App.vue' : 'App.svelte';
    const capture = f === 'vue' ? 'const n=ref(starting);' : 'let n=$state(starting);';
    const shadowed = await edit('modules-' + f, null, capture, 'const Math=0;\n' + capture);
    await lower(shadowed); // modules-* components do not call Math themselves
    const g = await edit(
      'modules-' + f,
      'base.ts',
      'export const STEP=1;',
      'const Math=0;\nexport const STEP=1;',
    );
    // base.ts's private Math must not change advance.js's global Math.min.
    const { ir } = await lower(g);
    assert.equal(
      texts(run(ir, [{ kind: 'click', id: 'increment' }]), ['value']).value,
      '1',
      component,
    );
  }
  await assert.rejects(
    lower(await edit('counter-svelte', null, 'const initial=n;', 'const Math=0;const initial=n;')),
    failWith('E_BUILTIN', 'App.svelte'),
  );
  await assert.rejects(
    lower(await edit('counter-vue', null, 'const n=ref(1);', 'const Math=0;const n=ref(1);')),
    failWith('E_BUILTIN', 'App.vue'),
  );
});

test('Svelte rejects uncovered reactive, component and template behaviour with locations', async () => {
  const cases = [
    [
      'counter-svelte',
      'const initial=n;',
      '$effect.root(() => {}); const initial=n;',
      'E_STATEMENT',
    ],
    ['counter-svelte', 'const initial=n;', '$effect(async () => {}); const initial=n;', 'E_EFFECT'],
    ['counter-svelte', 'const initial=n;', 'n; const initial=n;', 'E_STATEMENT'],
    ['counter-svelte', 'n=2;', 'doubled=2;', 'E_ASSIGN'],
    ['counter-svelte', '()=>n*2', '() => { console.log(n); return n*2; }', 'E_UNRESOLVED'],
    ['counter-svelte', '<script>', '<script context="module">', 'E_TEMPLATE'],
    ['counter-svelte', '</script>', '</script><style>p { color:red; }</style>', 'E_TEMPLATE'],
    ['counter-svelte', 'onclick={toggle}', 'on:click={toggle}', 'E_TEMPLATE'],
    ['counter-svelte', '<main>', '<main use:action>', 'E_TEMPLATE'],
    ['counter-svelte', '<main>', '<main class:active={show}>', 'E_TEMPLATE'],
    [
      'counter-svelte',
      '{#if show}<p id="details">Visible</p>{/if}',
      '{@html "<b>x</b>"}',
      'E_TEMPLATE',
    ],
    [
      'editor-svelte',
      'bind:value={text}',
      'bind:value={() => text, value => text = value}',
      'E_TEMPLATE',
    ],
    ['editor-svelte', 'bind:value={text}', 'bind:value={length}', 'E_TEMPLATE'],
  ];
  for (const [name, from, to, code] of cases)
    await assert.rejects(lower(await edit(name, null, from, to)), failWith(code, 'App.svelte'));
  for (const to of ['mount(Other,', 'new App('])
    await assert.rejects(
      lower(await edit('counter-svelte', 'main.js', 'mount(App,', to)),
      e => failWith('E_BOOTSTRAP', 'main.js')(e) && e.source.line === 4,
    );
});

test('Vue rejects setup effects, lifecycle hooks, modifiers and lists with locations', async () => {
  const cases = [
    ['const n=ref(1);', "const n=ref(1);console.log('effect');", 'E_STATEMENT'],
    ['{ref,computed}', '{ref,computed,onMounted}', 'E_CAPABILITY'],
    ['@click="toggle"', '@click.prevent="toggle"', 'E_TEMPLATE'],
    [
      '<p id="details" v-if="show">Visible</p>',
      '<p v-for="x in [1]" v-if="show">{{x}}</p>',
      'E_TEMPLATE',
    ],
    [
      '<p id="details" v-if="show">Visible</p>',
      '<p v-for="(v, k, i) in [1]">{{v}}</p>',
      'E_TEMPLATE',
    ],
    ['<p id="details" v-if="show">Visible</p>', '<p :key="n">Visible</p>', 'E_TEMPLATE'],
    ['<p id="details" v-if="show">Visible</p>', '<p v-show="show">Visible</p>', 'E_TEMPLATE'],
  ];
  for (const [from, to, code] of cases)
    await assert.rejects(
      lower(await edit('counter-vue', null, from, to)),
      failWith(code, 'App.vue'),
    );
  // Booleans interpolate as text in Vue.
  const { ir } = await lower(await edit('counter-vue', null, '{{label}}', '{{show}}'));
  assert.equal(texts(run(ir, []), ['value']).value, 'true');
});

/** Element ids in document order and the text of each, after the last action. */
function page(steps) {
  const dom = flat(steps.at(-1).state.dom).filter(n => n.attrs.id);
  return dom.map(
    n => `${n.attrs.id}${n.attrs.disabled === undefined ? '' : '[disabled]'}=${textOf(n)}`,
  );
}
const componentActions = [
  { kind: 'click', id: 'count-2' },
  { kind: 'click', id: 'count-2' },
  { kind: 'click', id: 'count-3' },
  { kind: 'click', id: 'up-2' },
  { kind: 'click', id: 'up-3' },
  { kind: 'click', id: 'reverse' },
  { kind: 'input', id: 'name', value: 'Delta!' },
  { kind: 'click', id: 'add' },
  { kind: 'click', id: 'count-4' },
  { kind: 'click', id: 'remove-1' },
  { kind: 'input', id: 'name', value: 'Epsilon' },
  { kind: 'click', id: 'toggle' },
  { kind: 'click', id: 'toggle' },
  { kind: 'click', id: 'remove-2' },
];

test('Vue components: props, emits, v-model, keyed lists and remounts match Svelte', async () => {
  const svelte = run((await lower(await graph('components-svelte'))).ir, componentActions);
  const vue = run((await lower(await graph('components-vue'))).ir, componentActions);
  for (let i = 0; i < componentActions.length; i++)
    assert.deepEqual(page(vue.slice(0, i + 1)), page(svelte.slice(0, i + 1)), `step ${i}`);
  const last = page(vue);
  assert.ok(last.includes('label-3=Gamma (1)'), last.join());
  assert.ok(last.includes('summary=2 items, next 5, name Epsilon'), last.join());
  // The editor remounted: its own state reset, its model reads the parent's value.
  assert.ok(last.includes('edits=Edits: 0'), last.join());
  assert.deepEqual(vue.at(-1).state.instances.at(-1), {
    component: 'Editor',
    cells: ['Epsilon', 0],
  });
  // Removing every row shows the fallback.
  const empty = run((await lower(await graph('components-vue'))).ir, [
    { kind: 'click', id: 'remove-1' },
    { kind: 'click', id: 'remove-2' },
    { kind: 'click', id: 'remove-3' },
  ]);
  assert.equal(texts(empty, ['empty']).empty, 'Nothing left');
});

test('Vue listener forms, props objects, defaults and boolean casting', async () => {
  const base = page(run((await lower(await graph('components-vue'))).ir, componentActions));
  const variants = [
    ['App.vue', '@remove="remove"', '@remove="remove(item.id)"'],
    ['App.vue', '@remove="remove"', '@remove="(id: number) => remove(id)"'],
    ['App.vue', '@up="(id) => up(id)"', '@up="up($event)"'],
    ['App.vue', '@up="(id) => up(id)"', '@up="() => up(item.id)"'],
    ['Row.vue', '@click="emit(\'up\', id)"', '@click="$emit(\'up\', id)"'],
    [
      'Row.vue',
      'const { id, label, first } = defineProps<{ id: number; label: string; first: boolean }>();',
      'interface P { id: number; label: string; first: boolean }\nconst props = defineProps<P>();\nconst { id } = { id: 0 };',
    ],
  ];
  for (const [file, from, to] of variants) {
    let g = await edit('components-vue', file, from, to);
    if (to.includes('const props')) {
      // Script reads through props.x; the template keeps bare prop names.
      const row = path.join(g.root, 'Row.vue');
      const m = g.modules.get(row);
      const code = m.code
        .replace('const { id } = { id: 0 };', '')
        .replaceAll("emit('up', id)", "emit('up', props.id)")
        .replaceAll("emit('remove', id)", "emit('remove', props.id)");
      g = { ...g, modules: new Map(g.modules).set(row, { ...m, code }), hash: hash(code) };
    }
    assert.deepEqual(page(run((await lower(g)).ir, componentActions)), base, to);
  }
  // Absent boolean props are false; destructure defaults and withDefaults apply.
  const g = await edit(
    'components-vue',
    'Row.vue',
    'const { id, label, first } = defineProps<{ id: number; label: string; first: boolean }>();',
    'const { id, label = "?", first } = defineProps<{ id: number; label?: string; first?: boolean }>();',
  );
  const app = path.join(g.root, 'App.vue');
  const m = g.modules.get(app);
  const code = m.code.replace(':label="item.label" :first="i === 0"', '');
  const { ir } = await lower({
    ...g,
    modules: new Map(g.modules).set(app, { ...m, code }),
    hash: hash(code),
  });
  const p = page(run(ir, []));
  assert.ok(p.includes('label-1=? (0)') && p.includes('up-1=Up'), p.join());
  // withDefaults (factories are called); the template reads bare prop names.
  const d = await edit(
    'components-vue',
    'Row.vue',
    'const { id, label, first } = defineProps<{ id: number; label: string; first: boolean }>();',
    'const props = withDefaults(defineProps<{ id: number; label?: string; first: boolean }>(), { label: () => "x" + 1 });\nconst initial = props.label.length;',
  );
  const row = path.join(d.root, 'Row.vue');
  const rm = d.modules.get(row);
  const rowCode = rm.code
    .replaceAll("emit('up', id)", "emit('up', props.id)")
    .replaceAll("emit('remove', id)", "emit('remove', props.id)")
    .replace('{{ clicks }}', '{{ clicks + initial }}');
  const appCode = d.modules.get(app).code.replace(':label="item.label"', '');
  const defaults = await lower({
    ...d,
    modules: new Map(d.modules)
      .set(row, { ...rm, code: rowCode })
      .set(app, { ...d.modules.get(app), code: appCode }),
    hash: hash(rowCode + appCode),
  });
  const q = page(run(defaults.ir, [{ kind: 'click', id: 'remove-1' }]));
  assert.ok(q.includes('label-2=x1 (2)') && q.includes('up-2[disabled]=Up'), q.join());
});

test('Vue rejects uncovered component behaviour with locations', async () => {
  const cases = [
    ['Row.vue', '@click="clicks++"', '@click="clicks++; label = \'x\'"', 'E_PROPS'],
    ['Row.vue', "emit('up', id)", "emit('down', id)", 'E_EMITS'],
    [
      'Row.vue',
      'defineProps<{ id: number; label: string; first: boolean }>()',
      'defineProps({ id: Number })',
      'E_PROPS',
    ],
    [
      'Row.vue',
      'defineEmits<{ remove: [id: number]; up: [id: number] }>()',
      "defineEmits(['remove', 'up'])",
      'E_EMITS',
    ],
    ['App.vue', ':label="item.label"', '', 'E_PROPS'],
    ['App.vue', ':first="i === 0"', ':first="i === 0" title="x"', 'E_PROPS'],
    ['App.vue', '@up="(id) => up(id)"', '@up="(id) => up(id)" @down="add"', 'E_PROPS'],
    ['App.vue', ':label="item.label"', ':label="item.id"', 'E_PROPS'],
    [
      'App.vue',
      '<Editor v-if="showEditor" v-model="name" />',
      '<Editor v-if="showEditor" v-model="next" />',
      'E_MODEL',
    ],
    [
      'App.vue',
      '<Editor v-if="showEditor" v-model="name" />',
      '<Editor v-if="showEditor" v-model.trim="name" />',
      'E_TEMPLATE',
    ],
    [
      'App.vue',
      '<Editor v-if="showEditor" v-model="name" />',
      '<Editor v-if="showEditor" v-model="name">x</Editor>',
      'E_SLOTS',
    ],
    ['App.vue', '<Editor v-if="showEditor" v-model="name" />', '<Other />', 'E_TEMPLATE'],
    ['Editor.vue', 'edits++', 'edits = value.length', 'E_MODEL'],
    ['Editor.vue', ':value="value"', 'v-model="value"', 'E_TEMPLATE'],
    [
      'Editor.vue',
      "defineModel<string>({ default: '' })",
      'defineModel<string>({ get: (v: string) => v })',
      'E_MODEL',
    ],
  ];
  for (const [file, from, to, code] of cases)
    await assert.rejects(
      lower(await edit('components-vue', file, from, to)),
      failWith(code, file),
      `${file}: ${to}`,
    );
});

test('React rejects uncovered behaviour with locations', async () => {
  const cases = [
    ['function App(){console.log("render");return <p>Hi</p>;}', 'E_COMPONENT'],
    ['const discarded=new Date().getTime();function App(){return <p>Hi</p>;}', 'E_NEW'],
    ['import {useMemo} from "react";function App(){return <p>Hi</p>;}', 'E_CAPABILITY'],
    ['const App=()=> <select><option>one</option></select>;', 'E_JSX'],
    // Lists need an inline callback returning JSX, with plain parameters and value keys.
    ['function App(){return <p>{[1,2].map(String)}</p>;}', 'E_JSX'],
    ['function App(){return <p>{[1,2].map(x=>x)}</p>;}', 'E_JSX'],
    ['function App(){return <p>{[1,2].map(x=>{const y=x;return <b>{y}</b>;})}</p>;}', 'E_JSX'],
    ['function App(){return <p>{[[1]].map(([x])=><b>{x}</b>)}</p>;}', 'E_JSX'],
    ['function App(){return <p>{[[1]].map(x=><b key={x}>a</b>)}</p>;}', 'E_JSX'],
    ['function App(){return <p>{[1].map((x,i,all)=><b>{x}</b>)}</p>;}', 'E_JSX'],
    ['function App(){return <p>{[1].map(x=>x>0&&<b key={x}>a</b>)}</p>;}', 'E_JSX'],
    // React keeps one instance (or DOM node) when both branches render the same type.
    [
      'function C({n}){const[c,s]=useState(n);return <b>{c}</b>;}function App(){const[f,set]=useState(true);return <p>{f?<C n={1}/>:<C n={2}/>}</p>;}',
      'E_JSX',
    ],
    [
      'function App(){const[f,set]=useState(true);return <p>{f?<b>a</b>:f?null:<b>b</b>}</p>;}',
      'E_JSX',
    ],
    // Props: unknown, missing, untyped and unused, recursive components.
    [
      'function C({n}){return <b>{n}</b>;}function App(){return <p><C n={1} m={2}/></p>;}',
      'E_PROPS',
    ],
    ['function C({n}){return <b>{n}</b>;}function App(){return <p><C/></p>;}', 'E_PROPS'],
    [
      'function C({n}){return <b>{n}</b>;}function App(){return <p><C n={1}/><C n="a"/></p>;}',
      'E_PROPS',
    ],
    [
      'function C({n,items=[1]}){return <b>{n}</b>;}function App(){return <p><C n={1}/></p>;}',
      'E_PROPS',
    ],
    [
      'function C({n}){return <p>{n>0&&<C n={n-1}/>}</p>;}function App(){return <C n={2}/>;}',
      'E_COMPONENT',
    ],
    // Children and render props: rendered only as JSX children, passed inline, never both
    // branches of a conditional (React would reconcile their content in place).
    ['function C(){return <b>a</b>;}function App(){return <C>child</C>;}', 'E_COMPONENT'],
    [
      'function C({children}){return <b title={children}>a</b>;}function App(){return <C>x</C>;}',
      'E_PROPS',
    ],
    [
      'function C({children}){const n=children;return <b>a</b>;}function App(){return <C>x</C>;}',
      'E_PROPS',
    ],
    [
      'function L({row}){return <p>{row(1)}</p>;}function App(){return <p><L row={x=><b>{x}</b>}/><L/></p>;}',
      'E_PROPS',
    ],
    [
      'function L({row}){return <p>{row(1)}</p>;}function App(){return <L row={x=>{const y=x;return <b>{y}</b>;}}/>;}',
      'E_PROPS',
    ],
    [
      'function L({row}){return <p>{row}</p>;}function App(){return <L row={x=><b>{x}</b>}/>;}',
      'E_PROPS',
    ],
    [
      'function C({children,n}){return <p>{n?children:<b>a</b>}</p>;}function App(){return <C n={1}><b>x</b></C>;}',
      'E_JSX',
    ],
    [
      'function C({children}){return <p>{children}</p>;}function App(){return <C children={<i>a</i>}><b>x</b></C>;}',
      'E_PROPS',
    ],
    // Checkboxes are controlled; keyboard events other than keydown are M5.
    ['function App(){return <input type="checkbox"/>;}', 'E_JSX'],
    ['function App(){return <input onKeyUp={()=>1}/>;}', 'E_EVENT'],
    [
      'function App(){const[xs,set]=useState([()=>{}]);return <p>{xs.map(f=><b onClick={f}>a</b>)}</p>;}',
      'E_EVENT',
    ],
    ['function App(){return <p style={{color:"red"}}>a</p>;}', 'E_JSX'],
    ['function App(){return <p onMouseOver={()=>1}>a</p>;}', 'E_EVENT'],
    [
      'const helper=x=>{console.log(x);return x;};const App=()=> <p>{helper(1)}</p>;',
      'E_UNRESOLVED',
    ],
    // Found by the Rust validator during analysis.
    [
      'const App=()=>{const[x,set]=useState("a");return <button onClick={()=>set(2)}>{x}</button>;}',
      'E_IR',
    ],
    ['function App(){return <p>{Math.random()}</p>;}', 'E_BUILTIN'],
  ];
  for (const [source, code] of cases)
    await react(source, async root =>
      assert.rejects(collect(root).then(lower), failWith(code, 'main.jsx')),
    );
});

test('React untyped props and helpers take the IR types of their values', async () => {
  await react(
    `const Price=({total, plan})=><p id="out" title={total}>{plan}: {total}{total>2&&<b id="big">!</b>}</p>;
     const twice=x=>x*2;
     function App(){const[n,set]=useState(1);const label='EUR';
       return <main><Price total={twice(n)} plan={label}/><button id="go" onClick={()=>set(v=>v+1)}>+</button></main>;}`,
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = run(ir, [{ kind: 'click', id: 'go' }]);
      assert.deepEqual(texts(steps.slice(0, 1), ['out']), { out: 'EUR: 2' });
      assert.deepEqual(texts(steps, ['out']), { out: 'EUR: 4!' });
      assert.equal(flat(steps.at(-1).state.dom).find(n => n.attrs.id === 'out').attrs.title, '4');
    },
  );
});

/** The interpreter DOM without whitespace-only text nodes (Svelte keeps them between blocks). */
const visible = nodes =>
  nodes
    .filter(n => typeof n !== 'string' || n.trim())
    .map(n => (typeof n === 'string' ? n : { ...n, children: visible(n.children) }));

test('React and Svelte components agree: instances, keyed lists, callbacks and remounts', async () => {
  const actions = [
    ['count-2'],
    ['count-2'],
    ['count-3'],
    ['up-2'],
    ['up-3'],
    ['reverse'],
    ['name', 'Delta!'],
    ['add'],
    ['count-4'],
    ['remove-1'],
    ['toggle'],
    ['toggle'],
    ['remove-2'],
    ['remove-3'],
    ['remove-4'],
    ['add'],
  ].map(([id, value]) => (value ? { kind: 'input', id, value } : { kind: 'click', id }));
  const traces = [];
  for (const f of ['react', 'svelte']) {
    const { ir } = await lower(await graph('components-' + f));
    traces.push(run(ir, actions).map(s => visible(s.state.dom)));
  }
  assert.deepEqual(traces[0], traces[1]);
  const { ir } = await lower(await graph('components-react'));
  const steps = run(ir, actions);
  // Moved rows keep their own state; the remounted editor starts over.
  assert.deepEqual(texts(steps.slice(0, 8), ['label-2', 'label-3', 'edits']), {
    'label-2': 'Beta (2)',
    'label-3': 'Gamma (1)',
    edits: 'Edits: 1',
  });
  assert.deepEqual(texts(steps.slice(0, 13), ['label-4', 'edits']), {
    'label-4': 'Delta! (1)',
    edits: 'Edits: 0',
  });
  assert.equal(texts(steps.slice(0, 16), ['empty']).empty, 'Nothing left');
  assert.equal(texts(steps, ['label-5'])['label-5'], 'Delta! (0)');
  assert.equal(ir.components.length, 3);
  assert.deepEqual(
    ir.components.map(c => c.cells.filter(x => x.prop).map(x => `${x.prop}:${x.tracking}`)),
    [
      [],
      ['id:identity', 'label:identity', 'first:identity', 'onRemove:identity', 'onUp:identity'],
      ['value:identity', 'onChange:identity'],
    ],
  );
});

test('React instances remount with conditions and keys; setters and props objects pass as values', async () => {
  await react(
    `function Counter({label, start = 0, onDone}) {
       const [n, setN] = useState(start);
       return <p><button id={'inc-' + label} onClick={() => setN(v => v + 1)}>{label}:{n}</button><button id={'done-' + label} onClick={() => onDone(n)}>done</button></p>;
     }
     function Tag(props) { return <i id="tag">{props.text}</i>; }
     function App() {
       const [show, setShow] = useState(true);
       const [total, setTotal] = useState(0);
       const [names, setNames] = useState(['a', 'b']);
       const [k, setK] = useState(0);
       return <main>
         <p id="total">{total && <b>{total}</b>}</p>
         <button id="show" onClick={() => setShow(!show)}>s</button>
         <button id="rekey" onClick={() => setK(k + 1)}>k</button>
         <button id="rot" onClick={() => setNames([...names.slice(1), names[0]])}>r</button>
         <Tag text={'t' + total}/>
         {show && <Counter label="x" onDone={setTotal}/>}
         <Counter key={k} label="y" start={10} onDone={setTotal}/>
         <ul id="list">{names.map((name, i) => <li key={name} id={'li-' + name}><Counter label={name} onDone={(/** @type {number} */ v) => setTotal(v * 10 + i)}/>{i}</li>)}</ul>
       </main>;
     }`,
    async root => {
      const { ir } = await lower(await collect(root));
      const click = id => ({ kind: 'click', id });
      const steps = run(ir, [
        click('inc-x'),
        click('inc-x'),
        click('done-x'),
        click('show'),
        click('show'),
        click('inc-y'),
        click('rekey'),
        click('inc-a'),
        click('rot'),
        click('done-a'),
      ]);
      const at = (i, ids) => texts(steps.slice(0, i + 1), ids);
      // A falsy number renders as text in React.
      assert.deepEqual(at(0, ['total', 'tag']), { total: '0', tag: 't0' });
      assert.deepEqual(at(3, ['total', 'tag', 'inc-x']), { total: '2', tag: 't2', 'inc-x': 'x:2' });
      assert.equal(at(4, ['inc-x'])['inc-x'], undefined);
      assert.equal(at(5, ['inc-x'])['inc-x'], 'x:0');
      assert.equal(at(6, ['inc-y'])['inc-y'], 'y:11');
      assert.equal(at(7, ['inc-y'])['inc-y'], 'y:10');
      assert.deepEqual(at(9, ['li-a', 'li-b']), { 'li-a': 'a:1done1', 'li-b': 'b:0done0' });
      const list = flat(steps[9].state.dom).find(n => n.attrs.id === 'list');
      assert.deepEqual(
        list.children.map(c => c.attrs.id),
        ['li-b', 'li-a'],
      );
      // The callback captured the item's current index (1).
      assert.equal(at(10, ['total']).total, '11');
    },
  );
});

test('JSX entities decode; strings count UTF-16 units; lone surrogate literals are rejected', async () => {
  await react(
    'function App(){return <p id="out" title="A &amp; B">Fish &amp; chips &#169; {"😀".length}</p>;}',
    async root => {
      const { ir } = await lower(await collect(root));
      const out = flat(run(ir, [])[0].state.dom).find(n => n.attrs.id === 'out');
      assert.equal(out.attrs.title, 'A & B');
      assert.equal(textOf(out), 'Fish & chips © 2');
    },
  );
  await react('function App(){return <p>{"\\ud800"}</p>;}', async root =>
    assert.rejects(collect(root).then(lower), failWith('E_STRING', 'main.jsx')),
  );
});

test('Svelte {#each} items can be destructured (fields of the item, captured by handlers)', async () => {
  const actions = [
    { kind: 'click', nth: 4 },
    { kind: 'click', nth: 7 },
    { kind: 'click', nth: 2 },
    { kind: 'click', id: 'reverse' },
    { kind: 'click', nth: 5 },
  ];
  const plain = run((await lower(await graph('components-svelte'))).ir, actions);
  const destructured = run(
    (
      await lower(
        await edit(
          'components-svelte',
          null,
          '{#each items as item, i (item.id)}<Row id={item.id} label={item.label}',
          '{#each items as { id, label }, i (id)}<Row id={id} label={label}',
        ),
      )
    ).ir,
    actions,
  );
  assert.deepEqual(
    destructured.map(s => s.state),
    plain.map(s => s.state),
  );
});

test('React and Svelte examples agree: TodoMVC, CRUD and slots', async () => {
  const click = id => ({ kind: 'click', id });
  const input = (id, value) => ({ kind: 'input', id, value });
  const key = (id, k) => ({ kind: 'keydown', id, key: k });
  const pairs = [
    [
      'examples/todomvc',
      [
        input('new-todo', 'Buy milk'),
        key('new-todo', 'Enter'),
        input('new-todo', 'Walk'),
        key('new-todo', 'Escape'),
        input('new-todo', '  '),
        key('new-todo', 'Enter'),
        input('new-todo', 'Ship M3'),
        key('new-todo', 'Enter'),
        click('toggle-3'),
        click('filter-active'),
        click('toggle-2'),
        click('filter-completed'),
        key('toggle-1', ' '),
        click('filter-all'),
        click('toggle-all'),
        click('toggle-all'),
        click('toggle-2'),
        click('destroy-1'),
        click('clear'),
      ],
    ],
    [
      'examples/7guis-crud',
      [
        click('person-2'),
        input('name', 'Maximilian'),
        click('update'),
        input('prefix', 'm'),
        click('person-2'),
        click('delete'),
        input('prefix', ''),
        input('name', 'Ada'),
        input('surname', 'Lovelace'),
        click('create'),
        click('person-1'),
      ],
    ],
    [
      'fixtures/slots',
      ['pick-2', 'tally-3', 'tally-3', 'order', 'tally-1', 'note', 'pick-3', 'order', 'drop'].map(
        click,
      ),
    ],
  ];
  for (const [base, actions] of pairs) {
    const traces = [];
    for (const f of ['react', 'svelte']) {
      const { ir } = await lower(await collect(`${base}-${f}`));
      const steps = run(ir, actions);
      assert.ok(
        steps.slice(1).every(s => s.outcome === 'handled'),
        `${base}-${f}: every action is handled`,
      );
      traces.push(steps.map(s => visible(s.state.dom)));
    }
    assert.deepEqual(traces[0], traces[1], base);
  }
});

test('React children and render props: untyped slots, forwarding and parent state', async () => {
  await react(
    `function Box({children, foot}) { return <div id="box">{children}<p id="foot">{foot}</p></div>; }
     function List({items, row}) { return <ul>{items.map((x, i) => <li key={x}>{row(x, i)}</li>)}</ul>; }
     function Wrap({children}) { return <Box foot="w">{children}</Box>; }
     function App() {
       const [n, setN] = useState(0);
       const [xs, setXs] = useState(['a', 'b']);
       return <main>
         <Box foot={<b id="b">{n}</b>}><button id="inc" onClick={() => setN(n + 1)}>+</button>{n > 1 && <i id="big">big</i>}</Box>
         <List items={xs} row={(x, i) => <span id={'r-' + x}>{x}{i}{n}</span>} />
         <Wrap><em id="wrapped">{n}</em></Wrap>
       </main>;
     }`,
    async root => {
      const { ir } = await lower(await collect(root));
      const list = ir.components.find(c => c.name === 'List');
      assert.deepEqual(list.slots, [{ name: 'row', params: ['string', 'number'] }]);
      const steps = run(ir, [
        { kind: 'click', id: 'inc' },
        { kind: 'click', id: 'inc' },
      ]);
      assert.deepEqual(texts(steps.slice(0, 1), ['b', 'r-a', 'big', 'wrapped']), {
        b: '0',
        'r-a': 'a00',
        big: undefined,
        wrapped: '0',
      });
      assert.deepEqual(texts(steps, ['b', 'r-a', 'r-b', 'big', 'wrapped']), {
        b: '2',
        'r-a': 'a02',
        'r-b': 'b12',
        big: 'big',
        wrapped: '2',
      });
      // Forwarded children render inside the inner Box, before its own footer.
      const boxes = flat(steps.at(-1).state.dom).filter(n => n.attrs.id === 'box');
      assert.equal(boxes.length, 2);
      assert.equal(textOf(boxes[1]), '2w');
    },
  );
});

test('React checkboxes and keydown: click then change, bubbling keydown, Space activation', async () => {
  await react(
    `function App() {
       const [on, setOn] = useState(false);
       const [log, setLog] = useState('');
       return <main onKeyDown={e => { const k = e.key; setLog(l => l + '<' + k); }}>
         <input id="c" type="checkbox" checked={on} onClick={() => setLog(l => l + 'click')} onChange={e => setOn(e.target.checked)} />
         <input id="t" onKeyDown={e => { const k = e.key; setLog(l => l + k); }} />
         <p id="log">{log}{on ? ' on' : ' off'}</p>
       </main>;
     }`,
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = run(ir, [
        { kind: 'keydown', id: 't', key: 'x' },
        { kind: 'click', id: 'c' },
        { kind: 'keydown', id: 'c', key: ' ' },
      ]);
      const log = i => texts(steps.slice(0, i + 1), ['log']).log;
      assert.equal(log(1), 'x<x off');
      assert.equal(log(2), 'x<xclick on');
      assert.equal(log(3), 'x<xclick< click off');
      assert.equal(flat(steps[2].state.dom).find(n => n.attrs.id === 'c').checked, true);
    },
  );
});

/**
 * Ids, disabled state, live control state (value, checked) and the text of
 * leaf elements after the last action (frameworks keep different whitespace
 * between elements).
 */
function controls(steps) {
  const dom = flat(steps.at(-1).state.dom).filter(n => n.attrs.id);
  const leafText = n => (n.children.every(c => typeof c === 'string') ? textOf(n) : '…');
  return dom.map(n => {
    const live =
      n.checked !== undefined
        ? `[${n.checked ? 'x' : ' '}]`
        : n.value !== undefined
          ? `[${n.value}]`
          : '';
    return `${n.attrs.id}${n.attrs.disabled === undefined ? '' : '[disabled]'}${live}=${leafText(n)}`;
  });
}
const todoActions = [
  { kind: 'input', id: 'new-todo', value: 'Buy milk' },
  { kind: 'keydown', id: 'new-todo', key: 'Enter' },
  { kind: 'input', id: 'new-todo', value: 'Walk' },
  { kind: 'keydown', id: 'new-todo', key: 'Escape' },
  { kind: 'input', id: 'new-todo', value: '  ' },
  { kind: 'keydown', id: 'new-todo', key: 'Enter' },
  { kind: 'input', id: 'new-todo', value: 'Ship M3' },
  { kind: 'keydown', id: 'new-todo', key: 'a' },
  { kind: 'keydown', id: 'new-todo', key: 'Enter' },
  { kind: 'click', id: 'toggle-3' },
  { kind: 'click', id: 'filter-active' },
  { kind: 'click', id: 'toggle-2' },
  { kind: 'click', id: 'filter-completed' },
  { kind: 'keydown', id: 'toggle-1', key: ' ' },
  { kind: 'click', id: 'filter-all' },
  { kind: 'click', id: 'toggle-all' },
  { kind: 'click', id: 'toggle-all' },
  { kind: 'click', id: 'toggle-2' },
  { kind: 'click', id: 'destroy-1' },
  { kind: 'click', id: 'clear' },
];
const crudActions = [
  { kind: 'click', id: 'person-2' },
  { kind: 'input', id: 'name', value: 'Maximilian' },
  { kind: 'click', id: 'update' },
  { kind: 'input', id: 'prefix', value: 'm' },
  { kind: 'click', id: 'person-2' },
  { kind: 'click', id: 'delete' },
  { kind: 'input', id: 'prefix', value: '' },
  { kind: 'input', id: 'name', value: 'Ada' },
  { kind: 'input', id: 'surname', value: 'Lovelace' },
  { kind: 'click', id: 'create' },
  { kind: 'click', id: 'person-1' },
];
const slotActions = [
  { kind: 'click', id: 'pick-2' },
  { kind: 'click', id: 'tally-3' },
  { kind: 'click', id: 'tally-3' },
  { kind: 'click', id: 'order' },
  { kind: 'click', id: 'tally-1' },
  { kind: 'click', id: 'note' },
  { kind: 'click', id: 'pick-3' },
  { kind: 'click', id: 'order' },
  { kind: 'click', id: 'drop' },
  { kind: 'click', id: 'tally-2' },
];
/** Vue and Svelte agree after every action (the Vue card also renders a header fallback). */
async function agree(vueName, svelteName, actions) {
  const vue = run((await lower(await graph(vueName))).ir, actions);
  const svelte = run((await lower(await graph(svelteName))).ir, actions);
  const strip = lines => lines.filter(l => !l.startsWith('header-'));
  for (let i = 0; i <= actions.length; i++)
    assert.deepEqual(
      strip(controls(vue.slice(0, i + 1))),
      strip(controls(svelte.slice(0, i + 1))),
      `${vueName} step ${i}`,
    );
  return [vue, svelte];
}

test('Vue TodoMVC, CRUD and slots match Svelte: checkboxes, keys, slot props and fallbacks', async () => {
  const [todo] = await agree('examples/todomvc-vue', 'examples/todomvc-svelte', todoActions);
  // Escape cleared "Walk", the blank draft was ignored, clear removed the completed todos.
  assert.deepEqual(
    controls(todo).filter(l => /^(title|count|new-todo|toggle)/.test(l)),
    [
      'toggle-all[ ]=',
      'new-todo[]=',
      'toggle-3[ ]=',
      'title-3=Buy milk',
      'toggle-4[ ]=',
      'title-4=Ship M3',
      'count=2 items left',
    ],
  );
  await agree('examples/7guis-crud-vue', 'examples/7guis-crud-svelte', crudActions);
  const [vue, svelte] = await agree('slots-vue', 'slots-svelte', slotActions);
  // The plain card renders the header fallback in the child's scope.
  assert.ok(controls(vue).includes('header-plain=plain'), controls(vue).join());
  // Stateful components inside slot content keep their state across moves.
  const tallies = steps => steps.at(-1).state.instances.filter(i => i.component === 'Tally');
  assert.deepEqual(tallies(vue), tallies(svelte));
  assert.deepEqual(
    tallies(vue).map(i => i.cells),
    [
      [2, 1],
      [3, 2],
    ],
  );
});

test('Vue listener, model and slot forms lower to the same behaviour', async () => {
  const same = async (name, actions, variants) => {
    const base = controls(run((await lower(await graph(name))).ir, actions));
    for (const [file, from, to] of variants) {
      const { ir } = await lower(await edit(name, file, from, to));
      assert.deepEqual(controls(run(ir, actions)), base, `${file}: ${to}`);
    }
  };
  await same('examples/todomvc-vue', todoActions, [
    ['App.vue', '@keydown.esc=', '@keydown.escape='],
    ['App.vue', '@keydown.esc=', '@keydown.enter.esc="() => {}" @keydown.esc='],
    // A return ends only its own listener of the merged event.
    [
      'App.vue',
      '@keydown.enter="add" @keydown.esc="draft = \'\'"',
      '@keydown="(e) => { if (e.key !== \'Enter\') return; add(); }" @keydown.esc="draft = \'\'"',
    ],
    [
      'App.vue',
      '@change="toggleAll($event.target.checked)"',
      '@change="(e) => toggleAll(e.target.checked)"',
    ],
    [
      'TodoItem.vue',
      'v-model="todo.done"',
      ':checked="todo.done" @change="todo.done = $event.target.checked"',
    ],
    ['TodoItem.vue', 'v-model="todo.done"', 'v-model="todo.done" @change="() => {}"'],
    // v-model on a member of a v-for item, without a child component.
    [
      'App.vue',
      '<TodoItem v-for="todo in shown" :key="todo.id" :todo="todo" @remove="remove" />',
      '<li v-for="todo in shown" :key="todo.id" :id="`todo-${todo.id}`" :class="todo.done ? \'completed\' : \'\'"><input :id="`toggle-${todo.id}`" type="checkbox" aria-label="Done" v-model="todo.done" /><span :id="`title-${todo.id}`">{{ todo.title }}</span><button :id="`destroy-${todo.id}`" class="destroy" @click="remove(todo.id)">Delete</button></li>',
    ],
  ]);
  await same('slots-vue', slotActions, [
    ['Card.vue', 'defineSlots<{ default(): any; header?(props: { title: string }): any }>();', ''],
    [
      'Picker.vue',
      'const descending',
      'defineSlots<{ row(props: { item: Item; first: boolean }): any }>();\nconst descending',
    ],
    [
      'App.vue',
      '<template #header="{ title }"><span id="fancy-header">Header for {{ title }}',
      '<template v-slot:header="{ title: t }"><span id="fancy-header">Header for {{ t }}',
    ],
    ['App.vue', '<template #row="{ item, first }">', '<template #row="{ first, item }">'],
    [
      'App.vue',
      '<Card title="plain"><p id="plain-body">Picked {{ picked }}</p></Card>',
      '<Card title="plain"><template #default><p id="plain-body">Picked {{ picked }}</p></template></Card>',
    ],
  ]);
});

test('Vue key modifiers follow withKeys: hyphenated keys and aliases', async () => {
  const { vueKeyValues } = await import('../frontend/adapters/vue.ts');
  assert.deepEqual(vueKeyValues(['enter']), ['enter', 'Enter']);
  assert.deepEqual(vueKeyValues(['esc']), ['esc', 'Esc', 'escape', 'Escape']);
  assert.deepEqual(vueKeyValues(['space']), ['space', 'Space', ' ']);
  assert.deepEqual(vueKeyValues(['delete']), ['delete', 'Delete', 'backspace', 'Backspace']);
  assert.deepEqual(vueKeyValues(['up']), ['up', 'Up', 'arrow-up', 'Arrow-up', 'ArrowUp']);
  assert.deepEqual(vueKeyValues(['page-down']), ['page-down', 'Page-down', 'PageDown']);
  assert.deepEqual(vueKeyValues(['a']), ['a', 'A']);
  // .delete also handles Backspace; other keys are ignored.
  const { ir } = await lower(
    await edit('examples/todomvc-vue', 'App.vue', '@keydown.esc=', '@keydown.delete='),
  );
  const typed = { kind: 'input', id: 'new-todo', value: 'x' };
  for (const [key, value] of [
    ['Backspace', ''],
    ['Delete', ''],
    ['Escape', 'x'],
    ['Del', 'x'],
  ]) {
    const steps = run(ir, [typed, { kind: 'keydown', id: 'new-todo', key }]);
    assert.ok(controls(steps).includes(`new-todo[${value}]=`), `${key}: ${controls(steps)}`);
  }
});

test('Vue rejects uncovered checkbox, key and slot behaviour with locations', async () => {
  const todo = 'examples/todomvc-vue';
  const cases = [
    [todo, 'App.vue', '@keydown.esc=', '@keydown.ctrl.esc=', 'E_TEMPLATE'],
    [todo, 'App.vue', '@keydown.esc=', '@keydown.esc.prevent=', 'E_TEMPLATE'],
    [todo, 'App.vue', '@click="clearCompleted"', '@click.enter="clearCompleted"', 'E_TEMPLATE'],
    [todo, 'App.vue', '@input="draft = $event.target.value"', '@change="draft = 1"', 'E_EVENT'],
    [
      todo,
      'App.vue',
      ':value="draft" @input="draft = $event.target.value"',
      'v-model="draft"',
      'E_TEMPLATE',
    ],
    [todo, 'App.vue', ':checked="left === 0"', '', 'E_TEMPLATE'],
    [todo, 'App.vue', ':checked="left === 0"', ':checked="left"', 'E_TEMPLATE'],
    [todo, 'App.vue', ':checked="left === 0"', ':checked="left === 0" checked', 'E_TEMPLATE'],
    [todo, 'TodoItem.vue', 'v-model="todo.done"', 'v-model="todo.title"', 'E_TEMPLATE'],
    [
      todo,
      'TodoItem.vue',
      'v-model="todo.done"',
      'v-model="todo.done" true-value="y"',
      'E_TEMPLATE',
    ],
    [todo, 'TodoItem.vue', 'v-model="todo.done"', 'v-model.lazy="todo.done"', 'E_TEMPLATE'],
    [
      todo,
      'TodoItem.vue',
      'v-model="todo.done"',
      'v-model="todo.done" :value="todo.id"',
      'E_TEMPLATE',
    ],
    ['slots-vue', 'App.vue', '#row="{ item, first }"', '#row="props"', 'E_SLOTS'],
    ['slots-vue', 'App.vue', '#row="{ item, first }"', '#row="{ item, first, last }"', 'E_SLOTS'],
    ['slots-vue', 'App.vue', '#row="{ item, first }"', '#row="{ item = 1, first }"', 'E_SLOTS'],
    [
      'slots-vue',
      'App.vue',
      '<template #header="{ title }">',
      '<template v-if="note" #header="{ title }">',
      'E_SLOTS',
    ],
    ['slots-vue', 'App.vue', '#header="{ title }"', '#footer="{ title }"', 'E_SLOTS'],
    // Vue would render Card's header fallback whenever this content renders nothing.
    [
      'slots-vue',
      'App.vue',
      '<span id="fancy-header">',
      '<span v-if="note === \'set\'" id="fancy-header">',
      'E_SLOTS',
    ],
    [
      'slots-vue',
      'App.vue',
      '<Tally :id="item.id" />',
      '<Tally :id="item.id">x</Tally>',
      'E_SLOTS',
    ],
    [
      'slots-vue',
      'App.vue',
      '<Picker :items="items">',
      '<Picker :items="items" v-slot="{ item }">',
      'E_SLOTS',
    ],
    [
      'slots-vue',
      'Card.vue',
      '<slot name="header" :title="title">',
      '<slot :name="title">',
      'E_SLOTS',
    ],
    ['slots-vue', 'Card.vue', ':title="title">', ':title="title" :extra="1">', 'E_SLOTS'],
    ['slots-vue', 'Card.vue', ':title="title">', ':title="1">', 'E_PROPS'],
    ['slots-vue', 'Card.vue', '<slot />', '<slot name="footer" />', 'E_SLOTS'],
    ['slots-vue', 'Picker.vue', '<slot name="row"', '<slot v-bind="item" name="row"', 'E_SLOTS'],
  ];
  for (const [name, file, from, to, code] of cases)
    await assert.rejects(
      lower(await edit(name, file, from, to)),
      failWith(code, file),
      `${file}: ${to}`,
    );
});

/** `edit` with several replacements in one file. */
async function edits(name, file, pairs) {
  let g = await graph(name);
  const id = path.join(g.root, file);
  let code = g.modules.get(id).code;
  for (const [from, to] of pairs) {
    assert.ok(code.includes(from), `Replacement must match in ${name}: ${from}`);
    code = code.replace(from, to);
  }
  const modules = new Map(g.modules);
  modules.set(id, { ...g.modules.get(id), code });
  return { ...g, modules, hash: hash(code) };
}

test('Vue template refs match Svelte bind:this: set at mount, null after removal', async () => {
  const [vue] = await agree('refs-vue', 'refs-svelte', refActions);
  const status = steps => texts(steps, ['status']).status;
  assert.equal(status(vue.slice(0, 6)), 'details mounted');
  assert.equal(status(vue.slice(0, 10)), 'details gone');
  assert.equal(status(vue), 'details mounted');
  const refsOf = ir => JSON.stringify(ir.components[ir.root].template).match(/"ref":\d+/g);
  const { ir } = await lower(await graph('refs-vue'));
  // The ref attribute is not rendered; both elements bind their cells.
  assert.deepEqual(refsOf(ir), ['"ref":0', '"ref":1']);
  assert.ok(!JSON.stringify(ir.components[ir.root].template).includes('"name":"ref"'));
  // ref="name" also binds a useTemplateRef by its variable name (ref_key),
  // and `ref<T>()` starts undefined.
  const variants = [
    [['ref="field"', 'ref="input"']],
    [['ref<HTMLButtonElement | null>(null)', 'ref<HTMLButtonElement>()']],
    [
      ['ref<HTMLButtonElement | null>(null)', 'shallowRef<HTMLButtonElement | null>(null)'],
      ['import { ref,', 'import { ref, shallowRef,'],
    ],
  ];
  for (const pairs of variants) {
    const steps = run((await lower(await edits('refs-vue', 'App.vue', pairs))).ir, refActions);
    assert.deepEqual(controls(steps), controls(vue), JSON.stringify(pairs));
  }
});

test('Vue rejects uncovered template refs with locations', async () => {
  const r = 'refs-vue';
  const cases = [
    [r, [['ref="details"', ':ref="(el) => {}"']]],
    [r, [['ref="details"', ':ref="\'details\'"']]],
    [r, [['<p v-if="show">', '<p v-for="i in [1]" :key="i">']]],
    [r, [['ref="details"', 'ref="other"']]],
    [r, [['ref="details"', 'ref="check"']]],
    [r, [['ref="details"', 'ref="status"']]],
    [r, [['ref="details"', 'ref=""']]],
    [r, [['<button id="focus"', '<button id="focus" ref="details"']]],
    [r, [['<p id="echo">', '<p id="echo" ref="field">']]],
    // ref="details" names the ref `details` and the key of `input`.
    [
      r,
      [
        [
          "useTemplateRef<HTMLInputElement>('field')",
          "useTemplateRef<HTMLInputElement>('details')",
        ],
        ['ref="field"', 'ref="input"'],
      ],
    ],
    [r, [["useTemplateRef<HTMLInputElement>('field')", "useTemplateRef('field')"]]],
    [r, [["useTemplateRef<HTMLInputElement>('field')", "useTemplateRef<string>('field')"]]],
    [
      r,
      [
        [
          "useTemplateRef<HTMLInputElement>('field')",
          'useTemplateRef<HTMLInputElement>(text.value)',
        ],
      ],
    ],
    [
      r,
      [
        [
          'const details = ref<HTMLButtonElement | null>(null);',
          "const details = useTemplateRef<HTMLButtonElement>('field');",
        ],
      ],
    ],
    [r, [['input.value?.focus();', "useTemplateRef<HTMLInputElement>('x');"]]],
    // Writes: Vue owns the value.
    [r, [['input.value?.focus();', 'input.value = null;']]],
    [r, [['@click="details?.focus()"', '@click="details = null"']]],
    // Reads while rendering: Vue sets refs after rendering and renders again.
    [r, [['{{ status }}', "{{ details ? 'mounted' : status }}"]]],
    [
      r,
      [
        ['{{ status }}', '{{ status }}{{ label() }}'],
        [
          'function check() {',
          'function label() { return input.value ? "a" : ""; }\nfunction check() {',
        ],
      ],
    ],
    [
      r,
      [
        ['import { ref,', 'import { computed, ref,'],
        [
          'const text',
          'const label = computed(() => (details.value === null ? "gone" : "here"));\nconst text',
        ],
        ['{{ status }}', '{{ label }}'],
      ],
    ],
    // Component and slot-content refs.
    ['slots-vue', [['<Card title="plain">', '<Card title="plain" ref="card">']]],
    ['slots-vue', [['<p id="plain-body">', '<p id="plain-body" ref="body">']]],
    ['slots-vue', [['<p id="fancy-body">', '<p id="fancy-body" :ref="note">']]],
  ];
  for (const [name, pairs] of cases)
    await assert.rejects(
      lower(await edits(name, 'App.vue', pairs)),
      failWith('E_REF', 'App.vue'),
      JSON.stringify(pairs),
    );
});

test('Event fields inside closures in a handler; spreads keep the source key order', async () => {
  const app = `import { useState } from 'react';
type Todo = { id: number; done: boolean; title: string };
export function App() {
  const [todos, setTodos] = useState<Todo[]>([{ id: 1, done: false, title: 'a' }]);
  const [log, setLog] = useState('');
  return <main>
    <button id="t" onClick={() => setTodos(todos.map(t => ({ ...t, done: !t.done })))}>toggle</button>
    <p id="keys">{todos.map(t => Object.keys(t).join(',') + ':' + String(t.done)).join(';')}</p>
    <input id="k" onKeyDown={e => setLog(l => l + e.key)} />
    <p id="log">{log}</p>
  </main>;
}`;
  await react(
    `import { App } from './App.tsx';`,
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = run(ir, [
        { kind: 'click', id: 't' },
        { kind: 'keydown', id: 'k', key: 'a' },
        { kind: 'keydown', id: 'k', key: 'b' },
      ]);
      assert.deepEqual(texts(steps, ['keys', 'log']), { keys: 'id,done,title:true', log: 'ab' });
    },
    { 'App.tsx': app },
  );
  await react(
    `import { App } from './App.tsx';`,
    root => assert.rejects(collect(root).then(lower), failWith('E_OBJECT', 'App.tsx')),
    {
      'App.tsx': app.replace(
        "{ id: 1, done: false, title: 'a' }",
        "{ id: 1, title: 'a', done: false }",
      ),
    },
  );
});

/**
 * The refs conformance actions as the interpreter sees them (it has no focus
 * model): typing goes to the focused field, Escape blurs it so the next
 * typing is lost, Enter activates the focused details button.
 */
const refActions = [
  { kind: 'click', id: 'focus' },
  { kind: 'input', id: 'field', value: 'abc' },
  { kind: 'keydown', id: 'field', key: 'Escape' },
  { kind: 'click', id: 'check' },
  { kind: 'click', id: 'focus-details' },
  { kind: 'keydown', id: 'details', key: 'Enter' },
  { kind: 'click', id: 'toggle' },
  { kind: 'click', id: 'check' },
  { kind: 'click', id: 'focus-details' },
  { kind: 'click', id: 'toggle' },
  { kind: 'click', id: 'check' },
  { kind: 'click', id: 'focus' },
  { kind: 'input', id: 'field', value: 'abc!' },
];

test('React and Svelte element refs agree: set at mount, null after removal, read live', async () => {
  const react = run((await lower(await graph('refs-react'))).ir, refActions);
  const svelte = run((await lower(await graph('refs-svelte'))).ir, refActions);
  for (let i = 0; i <= refActions.length; i++) {
    assert.deepEqual(
      controls(react.slice(0, i + 1)),
      controls(svelte.slice(0, i + 1)),
      `refs step ${i}`,
    );
    assert.deepEqual(react[i].state.cells, svelte[i].state.cells, `refs cells step ${i}`);
  }
  // The details ref is null while its button is removed, and set again on remount.
  assert.deepEqual(react[7].state.cells.slice(0, 2), ['element', null]);
  assert.deepEqual(react[10].state.cells.slice(0, 2), ['element', 'element']);
  assert.deepEqual(
    [8, 11].map(i => texts(react.slice(0, i + 1), ['status']).status),
    ['details gone', 'details mounted'],
  );
});

test('React refs in JavaScript; mutable boxes are read live and never re-render', async () => {
  await react(
    `import {useRef} from 'react';
     function App() {
       const field = useRef(/** @type {HTMLInputElement | null} */ (null));
       const clicks = useRef(0);
       const [shown, setShown] = useState(0);
       const [text, setText] = useState('');
       return <main>
         <input id="f" ref={field} value={text} onChange={e => setText(e.target.value)} />
         <button id="focus" onClick={() => field.current?.focus()}>Focus</button>
         <button id="count" onClick={() => { clicks.current++; clicks.current += 1; }}>Count</button>
         <button id="show" onClick={() => setShown(clicks.current)}>Show</button>
         <p id="out">{shown}</p>
       </main>;
     }`,
    async root => {
      const { ir } = await lower(await collect(root));
      assert.deepEqual(
        ir.components[0].cells.slice(0, 2).map(c => [c.type, c.tracking]),
        [
          [{ maybe: 'element' }, 'none'],
          ['number', 'none'],
        ],
      );
      const steps = run(ir, [
        { kind: 'click', id: 'focus' },
        { kind: 'click', id: 'count' },
        { kind: 'click', id: 'count' },
        { kind: 'click', id: 'show' },
      ]);
      assert.ok(steps.slice(1).every(s => s.outcome === 'handled'));
      // The second write in a handler sees the first (no snapshot), and
      // writing the box does not re-render.
      assert.equal(texts(steps.slice(0, 4), ['out']).out, '0');
      assert.equal(texts(steps, ['out']).out, '4');
    },
  );
});

test('React rejects uncovered ref behaviour with locations', async () => {
  const app = body => `import { useRef, useState, type ReactNode } from 'react';\n${body}`;
  const cases = [
    // Callback refs, ref forwarding and ref objects passed as values.
    ['export function App() { return <input ref={el => {}} />; }', 'E_REF'],
    [
      `function C() { return <b>c</b>; }
export function App() { const r = useRef<HTMLElement | null>(null); return <C ref={r} />; }`,
      'E_REF',
    ],
    [
      `function C({ r }: { r: { current: HTMLElement | null } }) { return <b>c</b>; }
export function App() { const r = useRef<HTMLElement | null>(null); return <C r={r} />; }`,
      'E_REF',
    ],
    // React owns element refs: writes, several elements, lists and slot content.
    [
      `export function App() {
  const r = useRef<HTMLInputElement>(null);
  return <input ref={r} onClick={() => { r.current = null; }} />;
}`,
      'E_REF',
    ],
    [
      `export function App() {
  const r = useRef<HTMLElement>(null);
  return <p><b ref={r}>a</b><i ref={r}>b</i></p>;
}`,
      'E_REF',
    ],
    [
      `export function App() {
  const r = useRef<HTMLElement>(null);
  return <ul>{[1, 2].map(i => <li key={i} ref={r}>{i}</li>)}</ul>;
}`,
      'E_REF',
    ],
    [
      `function Box({ children }: { children: ReactNode }) { return <div>{children}</div>; }
export function App() {
  const r = useRef<HTMLInputElement>(null);
  return <Box><input ref={r} /></Box>;
}`,
      'E_REF',
    ],
    ['export function App() { const r = useRef(0); return <input ref={r} />; }', 'E_REF'],
    ['export function App() { const [r, setR] = useState(1); return <input ref={r} />; }', 'E_REF'],
    // Reads and writes while rendering: JSX, render-time consts, initialisers,
    // functions called from them and closures called through function values.
    [
      `export function App() {
  const r = useRef<HTMLInputElement>(null);
  return <p><input ref={r} />{r.current ? 'mounted' : 'none'}</p>;
}`,
      'E_REF',
    ],
    [
      `export function App() {
  const n = useRef(1);
  const doubled = n.current * 2;
  return <p>{doubled}</p>;
}`,
      'E_REF',
    ],
    [
      `export function App() {
  const n = useRef(1);
  const [m, setM] = useState(n.current);
  return <p>{m}</p>;
}`,
      'E_REF',
    ],
    [
      `export function App() {
  const n = useRef(1);
  function bump() { n.current++; return 'x'; }
  return <p onClick={() => { n.current = 0; }}>{bump()}</p>;
}`,
      'E_REF',
    ],
    [
      `function Label({ text }: { text: () => string }) { return <b>{text()}</b>; }
export function App() {
  const n = useRef('a');
  return <Label text={() => n.current} />;
}`,
      'E_REF',
    ],
    // Boxes holding shared heap values, and untyped refs that are never attached.
    ['export function App() { const r = useRef([1]); return <p>a</p>; }', 'E_CAPABILITY'],
    ['export function App() { const r = useRef(null); return <p>a</p>; }', 'E_REF'],
  ];
  for (const [source, code] of cases)
    await react(
      `import { App } from './App.tsx';`,
      root => assert.rejects(collect(root).then(lower), failWith(code, 'App.tsx'), source),
      { 'App.tsx': app(source) },
    );
});

/** The text of #log after each Dump click of `actions` (React effect fixtures). */
async function effectLogs(fixture, actions) {
  const { ir } = await lower(await graph(fixture));
  const steps = run(ir, actions);
  return actions
    .map((a, i) => (a.id === 'dump' ? texts(steps.slice(0, i + 2), ['log']).log : undefined))
    .filter(x => x !== undefined)
    .map(s => s.split(' | '));
}
const click = id => ({ kind: 'click', id });

test('React effects: commit order, render snapshots, batched cleanups and unmounts', async () => {
  const [mount, update, hide, show] = await effectLogs(
    'effects-react',
    ['dump', 'inc', 'dump', 'toggle', 'dump', 'inc', 'toggle', 'dump'].map(click),
  );
  // Layout effects children first, then passive effects children first.
  assert.deepEqual(mount, [
    ...['A layout 0', 'B layout 0', 'App layout 0'],
    ...['A effect 0', 'A mount', 'B effect 0', 'B mount', 'App effect 0', 'App mount'],
  ]);
  // Dump re-renders App, which re-renders the children: effects without
  // dependencies run again. All cleanups of a phase precede its effects and
  // read their own render's values.
  assert.deepEqual(update, [
    ...['A layout cleanup 0', 'B layout cleanup 0', 'A layout 0', 'B layout 0'],
    ...['A layout cleanup 0', 'B layout cleanup 0', 'A layout 1', 'B layout 1', 'App layout 1'],
    ...['A cleanup 0', 'B cleanup 0', 'App cleanup 0', 'A effect 1', 'B effect 1', 'App effect 1'],
  ]);
  // Unmount: layout cleanups parent first, then passive cleanups parent first.
  assert.deepEqual(hide.slice(4), [
    ...['A layout cleanup 1', 'B layout cleanup 1'],
    ...['A cleanup 1', 'A unmount', 'B cleanup 1', 'B unmount'],
  ]);
  assert.deepEqual(show, [
    ...['App layout 2', 'App cleanup 1', 'App effect 2'],
    ...['A layout 2', 'B layout 2', 'A effect 2', 'A mount', 'B effect 2', 'B mount'],
  ]);
});

test('React effects writing state: layout writes re-render at once, passive writes later', async () => {
  const [, first, second] = await effectLogs(
    'layout-effect-writes-state-react',
    ['dump', 'inc', 'dump', 'inc', 'dump'].map(click),
  );
  // The passive effects of the first commit run before the synchronous re-render;
  // everything precedes the handler's microtask.
  assert.deepEqual(first, [
    'effect a=0 b=0',
    ...['layout a=1 b=0', 'effect a=1 b=0', 'layout b=10', 'effect a=1 b=10', 'microtask'],
  ]);
  assert.equal(second.at(-1), 'microtask');
  const passive = await effectLogs(
    'effect-writes-state-react',
    ['dump', 'inc', 'dump', 'inc', 'inc', 'dump'].map(click),
  );
  assert.deepEqual(passive, [
    ['b effect 0 (1 runs)'],
    ['b effect 10 (1 runs)'],
    ['b effect 20', 'b effect 30 (2 runs)'],
  ]);
  // An unmount in the same commit as updates: destroyed subtrees clean up in
  // their phase's walk, before the live children of their parent; state set
  // by a passive unmount cleanup renders after the handler's microtask.
  const [, swap] = await effectLogs('effects-swap-react', ['dump', 'swap', 'dump'].map(click));
  assert.deepEqual(swap.slice(swap.indexOf('App effect gone=0') + 1), [
    ...['A layout cleanup 0', 'A.leaf layout cleanup 0', 'C layout cleanup 0'],
    ...['C layout 1', 'B.leaf layout 1', 'B layout 1'],
    ...['A cleanup 0', 'A.leaf cleanup 0', 'C cleanup 0'],
    ...['C effect 1', 'B.leaf effect 1', 'B effect 1', 'App effect gone=0', 'microtask'],
    ...['C layout cleanup 1', 'B.leaf layout cleanup 1', 'B layout cleanup 1'],
    ...['C layout 1', 'B.leaf layout 1', 'B layout 1', 'C cleanup 1', 'B.leaf cleanup 1'],
    ...['B cleanup 1', 'C effect 1', 'B.leaf effect 1', 'B effect 1', 'App effect gone=1'],
  ]);
});

test('React rejects uncovered effect behaviour with locations', async () => {
  const app = body =>
    `import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';\n${body}`;
  const fx = 'useEffect(() => { log.push(1); return () => { log.push(2); }; });';
  const cases = [
    // The effect function: inline, synchronous, no parameters, returns a cleanup or nothing.
    ['function f() {}\nexport function App() { useEffect(f); return <p>a</p>; }', 'E_EFFECT'],
    ['export function App() { useEffect(async () => {}); return <p>a</p>; }', 'E_EFFECT'],
    ['export function App() { useEffect((x: number) => {}); return <p>a</p>; }', 'E_EFFECT'],
    [
      'export function App() { useEffect((() => 1) as unknown as () => void); return <p>a</p>; }',
      'E_EFFECT',
    ],
    // Dependencies: an array literal of primitives, state or props, read while rendering.
    [
      'export function App() { const deps = [1]; useEffect(() => {}, deps); return <p>a</p>; }',
      'E_EFFECT',
    ],
    [
      'export function App() { const [n, setN] = useState(0); useEffect(() => {}, [...[n]]); return <p>a</p>; }',
      'E_EFFECT',
    ],
    [
      'export function App() { const o = { a: 1 }; useEffect(() => {}, [o]); return <p>a</p>; }',
      'E_EFFECT',
    ],
    [
      'export function App() { function f() {} useEffect(() => {}, [f]); return <p>a</p>; }',
      'E_EFFECT',
    ],
    [
      'const log: number[] = [];\nexport function App() { useEffect(() => {}, [log.length]); return <p>a</p>; }',
      'E_EFFECT',
    ],
    [
      'export function App() { const r = useRef(1); useEffect(() => {}, [r.current]); return <p>a</p>; }',
      'E_REF',
    ],
    // Hooks outside the top level of a component body.
    [
      'export function App() { function later() { useEffect(() => {}); } return <p onClick={later}>a</p>; }',
      'E_HOOK',
    ],
    [
      'function useTicker() { useEffect(() => {}); }\nexport function App() { return <p>a</p>; }',
      'E_HOOK',
    ],
    [
      'export function App() { const [n, setN] = useState(0); if (n) useEffect(() => {}); return <p>a</p>; }',
      'E_COMPONENT',
    ],
    // Layout effects: element refs in cleanups, microtasks.
    [
      `export function App() {
  const r = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => () => r.current?.focus());
  return <input ref={r} />;
}`,
      'E_REF',
    ],
    [
      'export function App() { useLayoutEffect(() => { queueMicrotask(() => {}); }); return <p>a</p>; }',
      'E_EFFECT',
    ],
    // Unmounts whose cleanups React orders by element position.
    [
      `const log: number[] = [];
function C() { ${fx} return <b>c</b>; }
export function App() {
  const [show, setShow] = useState(true);
  return <main><div><C /></div><div>{show && <C />}</div></main>;
}`,
      'E_EFFECT',
    ],
    [
      `const log: number[] = [];
function C() { ${fx} return <b>c</b>; }
export function App() {
  const [items, setItems] = useState([1, 2]);
  return <main><C /><ul>{items.map(i => <C key={i} />)}</ul></main>;
}`,
      'E_EFFECT',
    ],
    [
      `const log: number[] = [];
function C() { ${fx} return <b>c</b>; }
export function App() {
  const [items, setItems] = useState([1, 2]);
  return <main><C />{items.map(i => <C key={i} />)}</main>;
}`,
      'E_EFFECT',
    ],
    [
      `const log: number[] = [];
function C() { ${fx} return <b>c</b>; }
function Box({ children }: { children: ReactNode }) { return <div>{children}</div>; }
export function App() {
  const [show, setShow] = useState(true);
  return <Box>{show && <C />}</Box>;
}`,
      'E_EFFECT',
    ],
    // Children content is not re-rendered with the receiving component.
    [
      `const log: number[] = [];
function C() { ${fx} return <b>c</b>; }
function Box({ children }: { children: ReactNode }) { const [n, setN] = useState(0); return <div onClick={() => setN(n + 1)}>{children}</div>; }
export function App() { return <Box><C /></Box>; }`,
      'E_EFFECT',
    ],
  ];
  for (const [source, code] of cases)
    await react(
      `import { App } from './App.tsx';`,
      root => assert.rejects(collect(root).then(lower), failWith(code, 'App.tsx'), source),
      { 'App.tsx': app(source) },
    );
  // The same unmounts are exact where React's walk agrees: after the
  // components with cleanups in the same element, or in a list that is the
  // only child of its element.
  for (const template of [
    '<main><C />{show && <C />}</main>',
    '<main>{show && <C />}<div><C /></div></main>',
    '<main><ul>{[1, 2].map(i => <C key={i} />)}</ul><C /></main>',
  ])
    await react(
      `import { App } from './App.tsx';`,
      async root => assert.ok((await lower(await collect(root))).ir, template),
      {
        'App.tsx': app(`const log: number[] = [];
function C() { ${fx} return <b>c</b>; }
export function App() { const [show, setShow] = useState(true); return ${template}; }`),
      },
    );
});
