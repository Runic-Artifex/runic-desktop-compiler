// React and Vue parity for selects and radio buttons (M5 step 3,
// docs/design/M5-PLATFORM.md): React DOM's updateOptions and
// restoreControlledState, Vue's vModelSelect and vModelRadio, and the
// rejections where their semantics are not modelled, with locations.
// Behaviour against Chromium is checked by the conformance cases
// select-react, select-vue, select-popup, radio and radio-react.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A React app: `App.tsx` (with React's hooks imported) rendered by main.jsx. */
async function app(source, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/controls-parity-'));
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
      `import React from 'react';import {createRoot} from 'react-dom/client';import { App } from './App.tsx';\ncreateRoot(document.getElementById('root')).render(<App/>);`,
    );
    await writeFile(
      path.join(root, 'App.tsx'),
      `import { useEffect, useState } from 'react';\n${source}`,
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lowered = async root => (await lower(await collect(root))).ir;
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const byId = (step, id) => flat(step.state.dom).find(x => x.attrs.id === id);

const failWith = (code, file) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    e.source.column > 0) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

test('React selects: a value no option has shows the first enabled option', async () => {
  await app(
    `export function App() {
  const [v, setV] = useState('c');
  const [log, setLog] = useState<string[]>([]);
  return (
    <main>
      <select id="s" value={v} onChange={e => { const x = e.target.value; setLog(l => [...l, x]); }}>
        <option value="a" disabled>A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>
      <button id="bad" onClick={() => setV('z')}>z</button>
      <p id="log">{log.join(' ')}</p>
    </main>
  );
}`,
    async root => {
      const ir = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'choose', id: 's', value: 'b' },
        { kind: 'click', id: 'bad' },
      ]);
      // The handler sees the picked value; the select is restored to the state.
      assert.deepEqual(
        steps.map(s => byId(s, 's').value),
        ['c', 'c', 'b'],
      );
      assert.equal(byId(steps[1], 'log').children.join(''), 'b');
    },
  );
});

test('React selects and radio buttons: rejections with locations', async () => {
  const cases = [
    [
      'E_JSX',
      "export function App() { const [v, setV] = useState(['a']); return <select multiple value={v} onChange={() => {}}><option>a</option></select>; }",
      /Multiple selects/,
    ],
    [
      'E_JSX',
      'export function App() { return <select defaultValue="a"><option>a</option></select>; }',
      /defaultValue/,
    ],
    [
      'E_JSX',
      "export function App() { const [v] = useState('a'); return <select value={v}><option>a</option></select>; }",
      /needs an onChange/,
    ],
    [
      'E_JSX',
      "export function App() { const [v, setV] = useState<string | undefined>('a'); return <select value={v} onChange={e => setV(e.target.value)}><option>a</option></select>; }",
      /uncontrolled/,
    ],
    [
      'E_JSX',
      "export function App() { const [v, setV] = useState('a'); return <select value={v} onChange={e => setV(e.target.value)}><option selected>a</option></select>; }",
      /use value on the select/,
    ],
    [
      'E_TEMPLATE',
      "export function App() { const [v, setV] = useState('a'); return <select value={v} onChange={e => setV(e.target.value)}>x<option>a</option></select>; }",
      /Text inside <select>/,
    ],
    [
      'E_TEMPLATE',
      "function Opt() { return <option>a</option>; }\nexport function App() { const [v, setV] = useState('a'); return <select value={v} onChange={e => setV(e.target.value)}><Opt /></select>; }",
      /own template/,
    ],
    [
      'E_EVENT',
      "export function App() { const [v, setV] = useState('a'); return <select value={v} onChange={e => { e.preventDefault(); setV(e.target.value); }}><option>a</option></select>; }",
      /cannot be cancelled/,
    ],
    [
      'E_EVENT',
      "export function App() { const [v, setV] = useState('a'); useEffect(() => { window.addEventListener('input', () => {}); }, []); return <select value={v} onChange={e => setV(e.target.value)}><option>a</option></select>; }",
      /input listeners in a program with controlled selects/,
    ],
    [
      'E_JSX',
      'export function App() { const [v] = useState(\'a\'); return <input type="radio" name="g" checked={v === \'a\'} />; }',
      /needs an onChange/,
    ],
    [
      'E_JSX',
      'export function App() { return <input type="radio" name="g" onChange={() => {}} />; }',
      /Radio buttons must be controlled/,
    ],
    [
      'E_TEMPLATE',
      "export function App() { const [v, setV] = useState('a'); const n = 'g'; return <input type=\"radio\" name={n} checked={v === 'a'} onChange={() => setV('a')} />; }",
      /literal name/,
    ],
    [
      'E_TEMPLATE',
      "export function App() { const [v, setV] = useState('a'); return <main><input type=\"radio\" name=\"g\" checked={v === 'a'} onChange={() => setV('a')} /><input type=\"radio\" name=\"g\" checked={v !== 'a'} onChange={() => setV('b')} /></main>; }",
      /comparing a value with its own string literal/,
    ],
    [
      'E_TEMPLATE',
      "export function App() { const [v, setV] = useState('a'); return <main><input type=\"radio\" name=\"g\" checked={v === 'a'} onChange={() => setV('a')} /><input type=\"radio\" name=\"g\" checked={v === 'a'} onChange={() => setV('a')} /></main>; }",
      /have the value "a"/,
    ],
    [
      'E_TEMPLATE',
      "export function App() { const [v, setV] = useState('a'); const [w, setW] = useState('a'); return <main><input type=\"radio\" name=\"g\" checked={v === 'a'} onChange={() => setV('a')} /><input type=\"radio\" name=\"g\" checked={w === 'b'} onChange={() => setW('b')} /></main>; }",
      /compare the same value/,
    ],
    [
      'E_TEMPLATE',
      "export function App() { const [v, setV] = useState('a'); return <main>{['a', 'b'].map(x => <input key={x} type=\"radio\" name=\"g\" checked={v === x} onChange={() => setV(x)} />)}</main>; }",
      /in a list/,
    ],
    [
      'E_TEMPLATE',
      "function Pick() { const [v, setV] = useState('a'); return <input type=\"radio\" name=\"g\" checked={v === 'a'} onChange={() => setV('a')} />; }\nexport function App() { return <main><Pick /><Pick /></main>; }",
      /more than one instance/,
    ],
    [
      'E_EVENT',
      "export function App() { const [v, setV] = useState('a'); return <input type=\"radio\" name=\"g\" checked={v === 'a'} onClick={e => e.preventDefault()} onChange={() => setV('a')} />; }",
      /checkbox or radio button whose onChange updates state/,
    ],
    [
      'E_EVENT',
      'export function App() { const [v, setV] = useState(\'a\'); const [n, setN] = useState(0); return <label onClick={e => { e.preventDefault(); setN(n + 1); }}><input type="radio" name="g" checked={v === \'a\'} onChange={() => {}} />{n}</label>; }',
      /cancel the click on a radio button and updates state/,
    ],
  ];
  for (const [code, source, reason] of cases)
    await app(source, root =>
      assert.rejects(
        lowered(root),
        e => failWith(code, 'App.tsx')(e) && (reason.test(e.message) || assert.fail(e.message)),
        source,
      ),
    );
});

const graphs = new Map();
const graph = dir => {
  if (!graphs.has(dir)) graphs.set(dir, collect(dir));
  return graphs.get(dir);
};

/** The collected project with replacements per file: { file: [[from, to], …] }. */
async function edits(dir, files) {
  const g = await graph(dir);
  const modules = new Map(g.modules);
  let all = '';
  for (const [file, pairs] of Object.entries(files)) {
    const id = path.join(g.root, file);
    let code = g.modules.get(id).code;
    for (const [from, to] of pairs) {
      assert.ok(code.includes(from), `Replacement must match in ${file}: ${from}`);
      code = code.replace(from, to);
    }
    modules.set(id, { ...g.modules.get(id), code });
    all += code;
  }
  return { ...g, modules, hash: hash(all) };
}

const rejects = async (g, code, message) =>
  assert.rejects(
    lower(g),
    e => failWith(code, 'App.vue')(e) && (message.test(e.message) || assert.fail(e.message)),
  );

test('Vue selects: v-model assigns the chosen option; a value no option has shows none', async () => {
  const { ir } = await lower(await graph('fixtures/select-vue'));
  const steps = interpret(ir, [
    { kind: 'choose', id: 'unit', value: 'minute' },
    { kind: 'click', id: 'bad' },
    { kind: 'choose', id: 'fixed', value: 'c' },
    { kind: 'click', id: 'extra' },
  ]);
  assert.deepEqual(
    steps.map(s => byId(s, 'unit').value),
    ['hour', 'minute', '', '', ''],
  );
  // A :value nothing writes keeps the choice until the component re-renders.
  assert.deepEqual(
    steps.map(s => byId(s, 'fixed').value),
    ['b', 'b', 'b', 'c', 'b'],
  );
});

test('Vue selects and radio buttons: rejections with locations', async () => {
  await rejects(
    await edits('fixtures/radio-vue', {
      'App.vue': [['value="s" v-model="size"', 'value="s" :checked="size === \'s\'"']],
    }),
    'E_TEMPLATE',
    /:checked on a radio button/,
  );
  await rejects(
    await edits('fixtures/radio-vue', {
      'App.vue': [['name="size" value="s" v-model="size"', 'name="size" v-model="size"']],
    }),
    'E_TEMPLATE',
    /needs a value/,
  );
  await rejects(
    await edits('fixtures/radio-vue', {
      'App.vue': [[`:value="'xl'"`, ':value="size"']],
    }),
    'E_TEMPLATE',
    /string literal/,
  );
  await rejects(
    await edits('fixtures/radio-vue', {
      'App.vue': [['value="m" v-model="size"', 'value="s" v-model="size"']],
    }),
    'E_TEMPLATE',
    /have the value "s"/,
  );
  await rejects(
    await edits('fixtures/radio-vue', {
      'App.vue': [[`@change="log.push('s')"`, `@change="size = 'm'"`]],
    }),
    'E_EVENT',
    /may write size/,
  );
  await rejects(
    await edits('fixtures/radio-vue', {
      'App.vue': [
        ["import { ref } from 'vue';", "import { ref, watch } from 'vue';"],
        ['const locked = ref(false);', 'const locked = ref(false);\nwatch(locked, () => {});'],
      ],
    }),
    'E_EVENT',
    /watchers or lifecycle hooks/,
  );
  await rejects(
    await edits('fixtures/radio-vue', {
      'App.vue': [
        ["import { ref } from 'vue';", "import { ref, watch } from 'vue';"],
        [
          'const locked = ref(false);',
          "const locked = ref(false);\nwatch(locked, () => { size.value = 'm'; });",
        ],
      ],
    }),
    'E_EFFECT',
    /may write size/,
  );
  await rejects(
    await edits('fixtures/select-vue', {
      'App.vue': [["const unit = ref('hour');", 'const unit = ref(1);']],
    }),
    'E_TEMPLATE',
    /string target/,
  );
  await rejects(
    await edits('fixtures/select-vue', {
      'App.vue': [
        [
          '<select id="fixed" aria-label="Fixed" :value="fixed">',
          '<select id="fixed" aria-label="Fixed" value="b">',
        ],
      ],
    }),
    'E_TEMPLATE',
    /static value on a select/,
  );
  await rejects(
    await edits('fixtures/select-vue', {
      'App.vue': [['<option value="a">A</option>', '<option :value="1">A</option>']],
    }),
    'E_TEMPLATE',
    /:value on an option takes a string/,
  );
  await rejects(
    await edits('fixtures/select-vue', {
      'App.vue': [
        [
          '<option value="a">A</option>',
          '<option value="a">A</option> <option value="z">Z</option>',
        ],
      ],
    }),
    'E_TEMPLATE',
    /Text inside <select>/,
  );
  await rejects(
    await edits('fixtures/radio-vue', {
      'App.vue': [
        [
          'if (locked.value) e.preventDefault();',
          "if (locked.value) e.preventDefault();\n  log.value.push('g');",
        ],
      ],
    }),
    'E_EVENT',
    /cancel the click on a radio button and writes state/,
  );
});
