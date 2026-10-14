// React parity for M5 steps 2-6: style objects (react-dom setValueForStyles),
// focus events (onFocus/onBlur from focusin/focusout), controlled text areas
// and labels, and the rejections where React's semantics are not modelled.
// Behaviour against React in Chromium is checked by the conformance cases
// style-objects, focus, forms-react and theme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A React app: `App.tsx` (with React's hooks imported) rendered by main.jsx. */
async function app(source, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/react-parity-'));
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
      `import { useEffect, useRef, useState } from 'react';\nimport type { FocusEvent } from 'react';\n${source}`,
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lowered = async root => (await lower(await collect(root))).ir;
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const node = (step, id) => flat(step.state.dom).find(x => x.attrs.id === id);
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
/** Element `id`'s attribute `name` after each step. */
const attrs = (steps, id, name) => steps.map(s => node(s, id)?.attrs[name]);
const elements = (nodes, out = []) => {
  for (const n of nodes ?? []) {
    if (n.kind === 'element') out.push(n);
    for (const k of ['children', 'then', 'else', 'body']) elements(n[k], out);
  }
  return out;
};

test('Style objects: each key through the CSSOM, then only changed keys', async () => {
  await app(
    `export function App() {
  const [on, setOn] = useState(false);
  const [w, setW] = useState(10);
  // Untyped: the conditional's type (string | undefined), not undefined's.
  const color = on ? 'green' : undefined;
  return (
    <main>
      <button id="toggle" onClick={() => setOn(!on)}>t</button>
      <button id="wider" onClick={() => setW(w + 0.5)}>w</button>
      <p id="p" style={{ margin: on ? undefined : 4, padding: w, color, zIndex: 2, outlineWidth: 0, '--a': on ? ' x ' : null, fontWeight: on, textAlign: on ? '' : ' center ' }}>p</p>
    </main>
  );
}`,
    async root => {
      const ir = await lowered(root);
      const p = elements(ir.components[0].template).find(n => n.tag === 'p');
      assert.equal(p.styleText, undefined, 'properties only');
      assert.deepEqual(
        p.styles.map(s => s.name),
        [
          'margin',
          'padding',
          'color',
          'z-index',
          'outline-width',
          '--a',
          'font-weight',
          'text-align',
        ],
      );
      const steps = interpret(ir, [
        { kind: 'click', id: 'toggle' },
        { kind: 'click', id: 'wider' },
        { kind: 'click', id: 'toggle' },
      ]);
      assert.deepEqual(attrs(steps, 'p', 'style'), [
        'margin: 4px; padding: 10px; z-index: 2; outline-width: 0px; text-align: center;',
        // Removed keys go; new ones are appended (setProperty).
        'padding: 10px; z-index: 2; outline-width: 0px; color: green; --a: x;',
        'padding: 10.5px; z-index: 2; outline-width: 0px; color: green; --a: x;',
        'padding: 10.5px; z-index: 2; outline-width: 0px; margin: 4px; text-align: center;',
      ]);
    },
  );
});

test('onFocus and onBlur bubble (focusin, focusout); focus() runs them nested', async () => {
  await app(
    `export function App() {
  const [log, setLog] = useState<string[]>([]);
  const field = useRef<HTMLInputElement | null>(null);
  const add = (s: string) => setLog(l => [...l, s]);
  return (
    <main>
      <div onFocus={() => add('row-in')} onBlur={() => add('row-out')}>
        <button id="a" onFocus={() => add('a-focus')} onBlur={() => add('a-blur')} onClick={() => { add('click'); field.current?.focus(); add('after'); }}>A</button>
        <input id="field" ref={field} onFocus={(e: FocusEvent) => add('field ' + (e.relatedTarget !== null))} />
      </div>
      <p id="log">{log.join(' ')}</p>
    </main>
  );
}`,
    async root => {
      const ir = await lowered(root);
      const div = elements(ir.components[0].template).find(n => n.tag === 'div');
      assert.deepEqual(
        div.listeners.map(l => l.event),
        ['focusin', 'focusout'],
      );
      const steps = interpret(ir, [{ kind: 'click', id: 'a' }]);
      assert.equal(
        textOf(node(steps[1], 'log')),
        'a-focus row-in click a-blur row-out field true row-in after',
      );
    },
  );
});

test('Controlled text areas keep their text content equal to the value; labels use htmlFor', async () => {
  await app(
    `export function App() {
  const [notes, setNotes] = useState('one');
  const [fixed] = useState('fixed');
  return (
    <main>
      <label id="l" htmlFor="notes">Notes</label>
      <textarea id="notes" value={notes} onChange={e => setNotes(e.target.value)} />
      <textarea id="fixed" value={fixed} onChange={() => {}} />
    </main>
  );
}`,
    async root => {
      const ir = await lowered(root);
      const all = elements(ir.components[0].template);
      assert.deepEqual(all.find(n => n.tag === 'label').attrs.find(a => a.name === 'for').value, {
        op: 'lit',
        value: 'notes',
      });
      assert.deepEqual(
        all.find(n => n.tag === 'textarea').props.map(p => p.name),
        ['defaultValue', 'value'],
      );
      const steps = interpret(ir, [
        { kind: 'input', id: 'notes', value: 'one\ntwo' },
        { kind: 'input', id: 'fixed', value: 'fixed!' },
      ]);
      assert.deepEqual(
        steps.map(s => [node(s, 'notes').value, node(s, 'notes').children]),
        [
          ['one', ['one']],
          ['one\ntwo', ['one\ntwo']],
          ['one\ntwo', ['one\ntwo']],
        ],
      );
      // React restores a controlled value that nothing writes.
      assert.equal(node(steps[2], 'fixed').value, 'fixed');
    },
  );
});

test('focus() outside event handlers is accepted without focus listeners', async () => {
  await app(
    `export function App() {
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => { field.current?.focus(); }, []);
  return <input id="field" ref={field} />;
}`,
    async root => assert.ok(await lowered(root)),
  );
});

const failWith = code => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === 'App.tsx' &&
    e.source.line > 0 &&
    e.source.column > 0) ||
  assert.fail(
    `expected ${code} in App.tsx, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

test('React parity rejects what it does not model, with locations', async () => {
  const cases = [
    // Style strings make React throw; style objects must be inline with static keys.
    ['E_JSX', 'export function App() { return <p style="color: red">a</p>; }', /object/],
    [
      'E_JSX',
      "export function App() { const s = { color: 'red' }; return <p style={s}>a</p>; }",
      /inline/,
    ],
    [
      'E_JSX',
      "export function App() { const s = { color: 'red' }; return <p style={{ ...s }}>a</p>; }",
      /Spreads/,
    ],
    [
      'E_JSX',
      "export function App() { const k = 'color'; return <p style={{ [k]: 'red' }}>a</p>; }",
      /static names/,
    ],
    [
      'E_JSX',
      "export function App() { return <p style={{ WebkitTransform: 'none' }}>a</p>; }",
      /camelCase/,
    ],
    [
      'E_JSX',
      "export function App() { return <p style={{ webkitTransform: 'none' }}>a</p>; }",
      /vendor/,
    ],
    [
      'E_JSX',
      "export function App() { return <p style={{ cssText: 'color: red' }}>a</p>; }",
      /cssText/,
    ],
    [
      'E_JSX',
      "export function App() { return <p style={{ 'background-color': 'red' }}>a</p>; }",
      /camelCase/,
    ],
    [
      'E_JSX',
      'export function App() { const [a] = useState([1]); return <p style={{ width: a }}>a</p>; }',
      /Style value/,
    ],
    [
      'E_JSX',
      "function Box({ ...rest }) { return <div {...rest}>a</div>; }\nexport function App() { return <Box style={{ color: 'red' }} />; }",
      /rest props/,
    ],
    // Capture-phase handlers of kinds React does not run from its root here
    // (onFocusCapture and the others of root-dispatched kinds lower, IR
    // schedule.rootDispatch), and focus events' synthetic type and cancellation.
    ['E_EVENT', 'export function App() { return <div onScrollCapture={() => {}} />; }', /capture/],
    [
      'E_EVENT',
      'export function App() { return <input onChangeCapture={() => {}} />; }',
      /capture/,
    ],
    [
      'E_EVENT',
      "export function App() { const [t, setT] = useState(''); return <input onFocus={e => setT(e.type)} />; }",
      /type "focus"/,
    ],
    [
      'E_EVENT',
      'export function App() { return <input onBlur={e => e.preventDefault()} />; }',
      /cannot be cancelled/,
    ],
    // focus() from effects or timers runs focus listeners React renders apart.
    [
      'E_EVENT',
      'export function App() { const [n, setN] = useState(0); const f = useRef<HTMLInputElement | null>(null); useEffect(() => { f.current?.focus(); }, []); return <input ref={f} onFocus={() => setN(n + 1)} />; }',
      /outside event handlers/,
    ],
    [
      'E_EVENT',
      'export function App() { const [n, setN] = useState(0); const f = useRef<HTMLInputElement | null>(null); return <main><input ref={f} onFocus={() => setN(n + 1)} /><button onClick={() => setTimeout(() => f.current?.blur(), 0)}>b</button></main>; }',
      /outside event handlers/,
    ],
    // Text areas: children, uncontrolled defaults, nullable values.
    ['E_JSX', 'export function App() { return <textarea>text</textarea>; }', /value and onChange/],
    [
      'E_JSX',
      'export function App() { return <textarea defaultValue="a" />; }',
      /Uncontrolled text areas/,
    ],
    [
      'E_JSX',
      'export function App() { const [t, setT] = useState<string | undefined>(undefined); return <textarea value={t} onChange={e => setT(e.target.value)} />; }',
      /uncontrolled/,
    ],
  ];
  for (const [code, source, reason] of cases)
    await app(source, root =>
      assert.rejects(lowered(root), e => failWith(code)(e) && reason.test(e.message), source),
    );
});
