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
  if (!graphs.has(name)) graphs.set(name, collect('fixtures/' + name));
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
    ['export const starting=0;', 'export const starting=Date.now();', 'E_UNRESOLVED'],
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
      '$effect(() => console.log(n)); const initial=n;',
      'E_STATEMENT',
    ],
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
      '{#key show}<p id="details">Visible</p>{/key}',
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
      'E_TEMPLATE',
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
    ['const discarded=Date.now();function App(){return <p>Hi</p>;}', 'E_UNRESOLVED'],
    ['import {useEffect} from "react";function App(){return <p>Hi</p>;}', 'E_CAPABILITY'],
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
    ['function C({children}){return <b>a</b>;}function App(){return <p><C/></p>;}', 'E_PROPS'],
    [
      'function C({n}){return <p>{n>0&&<C n={n-1}/>}</p>;}function App(){return <C n={2}/>;}',
      'E_COMPONENT',
    ],
    ['function C(){return <b>a</b>;}function App(){return <C>child</C>;}', 'E_COMPONENT'],
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
