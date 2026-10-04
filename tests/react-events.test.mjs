// React event props (M5 step 1): event objects, handler forms, per-render
// function identity for window and document listeners, and the rejections
// where React DOM's dispatch differs from the IR's event model. Behaviour
// against React in Chromium is checked by the conformance cases events and
// shortcuts.
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
  const root = await mkdtemp(path.resolve('.cache/tests/react-events-'));
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
      `import { useEffect, useLayoutEffect, useRef, useState } from 'react';\nimport type { ChangeEvent, KeyboardEvent as KeyEvent, MouseEvent as PointerLike } from 'react';\n${source}`,
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
/** The text of element `id` after each step. */
const texts = (steps, id) =>
  steps.map(s => {
    const n = flat(s.state.dom).find(x => x.attrs.id === id);
    return n && n.children.map(textOf).join('');
  });
const lowered = async root => (await lower(await collect(root))).ir;

test('React handlers take the event: inline, named functions and callback props', async () => {
  await app(
    `function Child({ onPick }: { onPick: (e: PointerLike) => void }) {
  return <button id="pick" onClick={onPick}>pick</button>;
}
export function App() {
  const [log, setLog] = useState('');
  function onKey(e: KeyEvent) {
    const entry = e.type + ':' + e.key + ' ';
    setLog(l => l + entry);
  }
  return (
    <main>
      <input id="field" onKeyDown={onKey} onKeyUp={onKey} />
      <Child onPick={e => { const t = e.type; setLog(l => l + t + ' '); }} />
      <div id="box" onDoubleClick={() => setLog(l => l + 'dbl ')} onContextMenu={e => { e.preventDefault(); const entry = 'menu ' + e.defaultPrevented + ' '; setLog(l => l + entry); }}>box</div>
      <p id="log">{log}</p>
    </main>
  );
}`,
    async root => {
      const steps = interpret(await lowered(root), [
        { kind: 'keydown', id: 'field', key: 'a' },
        { kind: 'click', id: 'pick' },
        { kind: 'dblclick', id: 'box' },
        { kind: 'contextmenu', id: 'box' },
      ]);
      assert.deepEqual(texts(steps, 'log').slice(1), [
        'keydown:a keyup:a ',
        'keydown:a keyup:a click ',
        'keydown:a keyup:a click dbl ',
        'keydown:a keyup:a click dbl menu true ',
      ]);
    },
  );
});

test('React pointer enter and leave update state rendered as text', async () => {
  await app(
    `export function App() {
  const [inside, setInside] = useState(false);
  const [hovers, setHovers] = useState(0);
  return (
    <main>
      <div id="box" onPointerEnter={() => { setHovers(h => h + 1); setInside(true); }} onPointerLeave={() => setInside(false)}>
        {hovers} {String(inside)}
      </div>
      <p id="other">other</p>
    </main>
  );
}`,
    async root => {
      const steps = interpret(await lowered(root), [
        { kind: 'hover', id: 'box' },
        { kind: 'hover', id: 'other' },
        { kind: 'hover', id: 'box' },
      ]);
      assert.deepEqual(texts(steps, 'box'), ['0 false', '1 true', '1 false', '2 true']);
    },
  );
});

test('React move handlers update state shown in paint-only style properties', async () => {
  // A colour changes no layout, hit testing or focus: when React renders it
  // (after the input, or with the next click) is unobservable, as for text.
  await app(
    `export function App() {
  const [over, setOver] = useState(-1);
  return (
    <main>
      {[0, 1].map(i => (
        <div key={i} id={'cell-' + i} style={{ width: 40, backgroundColor: over === i ? '#ccc' : 'transparent', color: over === i ? 'red' : 'black' }} onMouseMove={() => setOver(i)}>
          {i}
        </div>
      ))}
    </main>
  );
}`,
    async root => {
      const ir = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'hover', id: 'cell-1' },
        { kind: 'hover', id: 'cell-0' },
      ]);
      const styles = steps.map(
        s => flat(s.state.dom).find(x => x.attrs.id === 'cell-0')?.attrs.style,
      );
      assert.deepEqual(styles, [
        'width: 40px; background-color: transparent; color: black;',
        'width: 40px; background-color: transparent; color: black;',
        'width: 40px; background-color: rgb(204, 204, 204); color: red;',
      ]);
    },
  );
});

test('A component function added and removed by one effect is one object per render', async () => {
  // Each click re-runs the effect: its cleanup must remove the function
  // object the previous run added, or every key would count once more.
  await app(
    `export function App() {
  const [n, setN] = useState(0);
  const [keys, setKeys] = useState(0);
  function onKey(e: KeyboardEvent) {
    if (e.key === 'a') setKeys(k => k + 1);
  }
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n]);
  return (
    <main>
      <button id="more" onClick={() => setN(n + 1)}>{n}</button>
      <input id="field" />
      <p id="keys">{keys}</p>
    </main>
  );
}`,
    async root => {
      const steps = interpret(await lowered(root), [
        { kind: 'click', id: 'more' },
        { kind: 'click', id: 'more' },
        { kind: 'keydown', id: 'field', key: 'a' },
        { kind: 'keydown', id: 'field', key: 'a' },
      ]);
      assert.deepEqual(texts(steps, 'keys').slice(3), ['1', '2']);
    },
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

test('React rejects event semantics it cannot model, with locations', async () => {
  const cases = [
    // Passive wheel listener: no preventDefault, scrolling before dispatch.
    [
      'export function App() { const [d, setD] = useState(0); return <div onWheel={() => setD(1)}>{d}</div>; }',
      /passive/,
    ],
    // Unsupported event props and handler forms.
    [
      'export function App() { return <div onMouseOver={() => {}}>a</div>; }',
      /onMouseOver is unsupported/,
    ],
    [
      'export function App() { function h(a: number, b: number) {} return <button onClick={h}>a</button>; }',
      /no parameter or the event/,
    ],
    [
      'export function App() { const [n, setN] = useState(0); return <button onClick={n}>a</button>; }',
      /must be functions/,
    ],
    // React drops onMouseMove and onMouseEnter of disabled controls.
    [
      'export function App() { const [n, setN] = useState(0); return <button disabled onMouseEnter={() => setN(1)}>{n}</button>; }',
      /disabled/,
    ],
    // One synthetic enter/leave event for all elements: target, propagation, cancellation.
    [
      'export function App() { return <div onMouseEnter={e => e.stopPropagation()}>a</div>; }',
      /one synthetic mouseenter/,
    ],
    [
      'export function App() { const [t, setT] = useState(false); return <div onPointerLeave={e => setT(e.target === e.currentTarget)}>{String(t)}</div>; }',
      /one synthetic pointerleave/,
    ],
    [
      'export function App() { return <div onPointerEnter={e => e.preventDefault()}>a</div>; }',
      /one synthetic pointerenter/,
    ],
    // onChange: a change event made from input, or from the click.
    [
      "export function App() { const [t, setT] = useState(''); return <input value={t} onChange={e => setT(e.type)} />; }",
      /text input/,
    ],
    [
      'export function App() { const [c, setC] = useState(false); return <input type="checkbox" checked={c} onChange={e => { e.preventDefault(); setC(e.target.checked); }} />; }',
      /checkbox or radio button calls e.preventDefault/,
    ],
    [
      'export function App() { const [c, setC] = useState(false); return <input type="checkbox" checked={c} onChange={e => { e.stopPropagation(); setC(e.target.checked); }} />; }',
      /checkbox or radio button calls e.stopPropagation/,
    ],
    // A cancelled checkbox click whose onChange sets state (on the box or an ancestor).
    [
      'export function App() { const [c, setC] = useState(false); return <input type="checkbox" checked={c} onClick={e => e.preventDefault()} onChange={e => setC(e.target.checked)} />; }',
      /cancel the click on a checkbox/,
    ],
    [
      'export function App() { const [c, setC] = useState(false); return <div onClick={e => e.preventDefault()}><input type="checkbox" checked={c} onChange={e => setC(e.target.checked)} /></div>; }',
      /cancel the click on a checkbox/,
    ],
    // Synthetic events have no stopImmediatePropagation; currentTarget is null after the listener.
    [
      'export function App() { return <button onClick={e => (e as unknown as Event).stopImmediatePropagation()}>a</button>; }',
      /stopImmediatePropagation/,
    ],
    [
      "export function App() { const [s, setS] = useState(''); return <button onClick={e => queueMicrotask(() => setS(String(e.currentTarget === null)))}>{s}</button>; }",
      /currentTarget/,
    ],
    [
      "export function App() { const [s, setS] = useState(''); return <button onClick={async e => { await Promise.resolve(0); setS(String(e.currentTarget === null)); }}>{s}</button>; }",
      /currentTarget/,
    ],
    [
      "export function App() { const [s, setS] = useState(''); return <button onClick={e => setS(x => x + e.defaultPrevented)}>{s}</button>; }",
      /updater/,
    ],
    // Continuous events: React renders their updates after the input.
    [
      'export function App() { const [n, setN] = useState(0); return <div onPointerMove={() => setTimeout(() => setN(1), 0)}>{n}</div>; }',
      /timer/,
    ],
    [
      'export function App() { const [n, setN] = useState(0); return <div title={String(n)} onPointerEnter={() => setN(n + 1)}>a</div>; }',
      /rendered as text/,
    ],
    [
      'export function App() { const [n, setN] = useState(0); return <main><div onMouseEnter={() => setN(1)}>a</div><button onClick={() => setN(n + 1)}>{n}</button></main>; }',
      /rendered as text/,
    ],
    // Inline style properties other than paint-only colours can change layout.
    [
      'export function App() { const [n, setN] = useState(0); return <div style={{ width: n }} onMouseMove={() => setN(n + 1)}>a</div>; }',
      /rendered as text/,
    ],
    [
      'export function App() { const [n, setN] = useState(0); return <main>{n > 0 && <b>x</b>}<div onMouseLeave={() => setN(1)}>a</div></main>; }',
      /rendered as text/,
    ],
    [
      'export function App() { const [n, setN] = useState(0); useEffect(() => {}); return <div onPointerEnter={() => setN(1)}>{n}</div>; }',
      /without dependencies/,
    ],
    [
      'function Row({ onHover }: { onHover: () => void }) { return <div onMouseEnter={() => onHover()}>a</div>; }\nexport function App() { const [n, setN] = useState(0); return <main><Row onHover={() => setN(1)} />{n}</main>; }',
      /function value/,
    ],
    // Window and document listeners for continuous events.
    [
      'export function App() { useEffect(() => { const f = () => {}; window.addEventListener("mousemove", f); return () => window.removeEventListener("mousemove", f); }, []); return <p>a</p>; }',
      /mousemove/,
    ],
    // Component functions are created per render: add and remove them in one effect.
    [
      'export function App() { function onKey() {} useEffect(() => { window.addEventListener("keydown", onKey); }, []); return <button onClick={() => window.removeEventListener("keydown", onKey)}>a</button>; }',
      /one effect/,
    ],
    [
      'export function App() { const [n, setN] = useState(0); function onKey() {} useEffect(() => { window.addEventListener("keydown", onKey); }, []); useEffect(() => () => window.removeEventListener("keydown", onKey), [n]); return <p>{n}</p>; }',
      /several effects/,
    ],
  ];
  for (const [source, reason] of cases)
    await app(source, root =>
      assert.rejects(lowered(root), e => failWith('E_EVENT')(e) && reason.test(e.message), source),
    );
});
