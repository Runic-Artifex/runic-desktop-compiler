// React rest props, spread attributes and ref props (M5 step 2): attribute
// bags gathered from every call site and coerced as React DOM sets
// attributes, listeners in rest props, ref objects passed to components, and
// the rejections. Behaviour against React in Chromium is checked by the
// conformance cases rest-props, rest-attrs-react, component-refs and
// component-refs-react.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A React app: `App.tsx` (with React's hooks and prop types imported) rendered by main.jsx. */
async function app(source, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/react-attrs-'));
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
      `import { useEffect, useRef, useState } from 'react';\nimport type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, RefObject } from 'react';\n${source}`,
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const byId = (step, id) => flat(step.state.dom).find(x => x.attrs.id === id);
const lowered = async root => (await lower(await collect(root))).ir;

test('Rest props reach the element through forwarding, with listeners', async () => {
  await app(
    `type ButtonProps = { variant?: string; className?: string; children?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>;
function Button({ variant = 'default', className = '', children, ...rest }: ButtonProps) {
  return <button className={\`btn \${variant} \${className}\`.trim()} type="button" {...rest}>{children}</button>;
}
function IconButton({ label, ...rest }: { label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button variant="ghost" {...rest}>{label}</Button>;
}
export function App() {
  const [count, setCount] = useState(0);
  const [log, setLog] = useState('');
  const title: string | undefined = count > 0 ? undefined : 'First';
  return (
    <main>
      <Button id="inc" onClick={() => setCount(c => c + 1)} aria-label="Increment" title={title}>Add</Button>
      <IconButton id="icon" label="Icon" disabled={count > 1} data-count={count} onClick={e => { const t = e.type; setLog(l => l + t + ' '); }} />
      <p id="log">{log}</p>
    </main>
  );
}`,
    async root => {
      const ir = await lowered(root);
      const button = ir.components.find(c => c.name === 'Button');
      assert.deepEqual(
        button.cells.find(c => c.prop === '...'),
        {
          name: 'rest',
          type: 'attrs',
          init: { op: 'attrs', items: [] },
          tracking: 'identity',
          readonly: true,
          prop: '...',
          source: button.cells.find(c => c.prop === '...').source,
        },
      );
      const steps = interpret(ir, [
        { kind: 'click', id: 'icon' },
        { kind: 'click', id: 'inc' },
        { kind: 'click', id: 'inc' },
        { kind: 'click', id: 'icon' },
      ]);
      assert.deepEqual(byId(steps[0], 'inc').attrs, {
        class: 'btn default',
        type: 'button',
        id: 'inc',
        'aria-label': 'Increment',
        title: 'First',
      });
      assert.deepEqual(byId(steps[0], 'icon').attrs, {
        class: 'btn ghost',
        type: 'button',
        id: 'icon',
        'data-count': '0',
      });
      // title={undefined} removes the attribute; disabled is present when true.
      assert.equal(byId(steps[2], 'inc').attrs.title, undefined);
      assert.equal(byId(steps[3], 'icon').attrs.disabled, '');
      // The disabled button gets no click.
      assert.deepEqual(
        steps.map(s => textOf(byId(s, 'log'))),
        ['', 'click ', 'click ', 'click ', 'click '],
      );
    },
  );
});

test('Rest props follow React DOM attribute rules', async () => {
  await app(
    `function Tag({ label, ...rest }: { label: string } & HTMLAttributes<HTMLSpanElement>) {
  return <span className="tag" {...rest} data-pos="own">{label}</span>;
}
export function App() {
  const [on, setOn] = useState(false);
  const n: number | null = on ? 0 : null;
  return (
    <main>
      <Tag id="tag" label="Tag" className={on ? 'on' : undefined} aria-pressed={on} data-on={on} data-flag lang={on} hidden={0} required="x" aria-level={n} tabIndex={-1} data-pos="rest" />
      <button id="toggle" onClick={() => setOn(!on)}>toggle</button>
    </main>
  );
}`,
    async root => {
      const steps = interpret(await lowered(root), [{ kind: 'click', id: 'toggle' }]);
      assert.deepEqual(byId(steps[0], 'tag').attrs, {
        id: 'tag',
        'aria-pressed': 'false',
        'data-on': 'false',
        'data-flag': 'true',
        required: '',
        tabindex: '-1',
        'data-pos': 'own',
      });
      assert.deepEqual(byId(steps[1], 'tag').attrs, {
        class: 'on',
        id: 'tag',
        'aria-pressed': 'true',
        'data-on': 'true',
        'data-flag': 'true',
        required: '',
        'aria-level': '0',
        tabindex: '-1',
        'data-pos': 'own',
      });
    },
  );
});

test('A ref passed to a component holds its element while mounted, through forwarding', async () => {
  await app(
    `type InputProps = { ref?: RefObject<HTMLInputElement | null> } & InputHTMLAttributes<HTMLInputElement>;
function Input({ ref, ...rest }: InputProps) {
  return <input ref={ref} type="text" {...rest} />;
}
function Labeled({ ref, ...rest }: InputProps) {
  return <div><Input ref={ref} {...rest} /></div>;
}
export function App() {
  const direct = useRef<HTMLInputElement | null>(null);
  const forwarded = useRef<HTMLInputElement | null>(null);
  const [shown, setShown] = useState(true);
  const [held, setHeld] = useState('');
  useEffect(() => {
    setHeld(String(direct.current !== null) + ' ' + String(forwarded.current !== null));
  }, [shown]);
  return (
    <main>
      {shown && <Input ref={direct} id="a" />}
      {shown && <Labeled ref={forwarded} id="b" />}
      <button id="focus" onClick={() => forwarded.current?.focus()}>focus</button>
      <button id="toggle" onClick={() => setShown(!shown)}>toggle</button>
      <p id="held">{held}</p>
    </main>
  );
}`,
    async root => {
      const steps = interpret(await lowered(root), [
        { kind: 'click', id: 'focus' },
        { kind: 'click', id: 'toggle' },
        { kind: 'click', id: 'toggle' },
      ]);
      assert.deepEqual(
        steps.map(s => textOf(byId(s, 'held'))),
        ['true true', 'true true', 'false false', 'true true'],
      );
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

const BUTTON = `function Button({ children, ...rest }: { children?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...rest}>{children}</button>; }\n`;

test('React rest props and ref props reject what they cannot lower, with locations', async () => {
  const cases = [
    // Spreads other than rest props, and rest props read by name.
    [
      'export function App() { const p = { id: "a" }; return <div {...p}>a</div>; }',
      'E_JSX',
      /rest props/,
    ],
    [
      'function Box({ ...rest }: HTMLAttributes<HTMLDivElement>) { return <div title={String(rest.id)}>a</div>; }\nexport function App() { return <Box id="a" />; }',
      'E_PROPS',
      /reading them by name/,
    ],
    [
      'function Box({ ...rest }: HTMLAttributes<HTMLDivElement>) { useEffect(() => {}, [rest]); const all = { rest }; return <div {...rest}>a</div>; }\nexport function App() { return <Box id="a" />; }',
      'E_PROPS',
      /reading them by name/,
    ],
    [
      'function Box({ id }: { id: string }) { return <div id={id}>a</div>; }\nfunction Outer({ ...rest }: HTMLAttributes<HTMLDivElement>) { return <Box id="x" {...rest} />; }\nexport function App() { return <Outer />; }',
      'E_PROPS',
      /takes no rest props/,
    ],
    // A forwarded bag that may hold a declared prop of the receiver.
    [
      'function Box({ title, ...rest }: { title?: string } & HTMLAttributes<HTMLDivElement>) { return <div title={title} {...rest}>a</div>; }\nfunction Outer({ ...rest }: HTMLAttributes<HTMLDivElement>) { return <Box {...rest} />; }\nexport function App() { return <Outer title="t" />; }',
      'E_PROPS',
      /declares; pass title explicitly/,
    ],
    // Values React sets by rules of their own.
    [
      `${BUTTON}export function App() { return <Button style={{ color: 'red' }}>a</Button>; }`,
      'E_JSX',
      /style in the rest props/,
    ],
    [
      `${BUTTON}export function App() { return <Button type="submit">a</Button>; }`,
      'E_PROPS',
      /rule of its own/,
    ],
    [
      `${BUTTON}export function App() { const [xs, setXs] = useState<number[]>([1, 2]); return <Button title={xs}>a</Button>; }`,
      'E_PROPS',
      /strings, numbers and booleans/,
    ],
    [
      `${BUTTON}export function App() { return <Button onclick="x">a</Button>; }`,
      'E_PROPS',
      /starting with "on"/,
    ],
    [
      `function Box({ ...rest }: HTMLAttributes<HTMLDivElement>) { return <div {...rest} />; }\nexport function App() { return <Box>text</Box>; }`,
      'E_PROPS',
      /children of Box go into its rest props/,
    ],
    // Listeners in rest props.
    [
      `${BUTTON}export function App() { return <Button onWheel={() => {}}>a</Button>; }`,
      'E_EVENT',
      /passive/,
    ],
    [
      `function Field({ ...rest }: InputHTMLAttributes<HTMLInputElement>) { return <input {...rest} />; }\nexport function App() { return <Field onChange={() => {}} />; }`,
      'E_EVENT',
      /onChange in the rest props/,
    ],
    [
      `${BUTTON}export function App() { return <Button onTouchStart={() => {}}>a</Button>; }`,
      'E_EVENT',
      /onTouchStart is unsupported/,
    ],
    [
      `function Box({ ...rest }: HTMLAttributes<HTMLButtonElement>) { return <button onClick={() => {}} {...rest}>a</button>; }\nexport function App() { return <Box onClick={() => {}} />; }`,
      'E_JSX',
      /both on the element/,
    ],
    // A click cancelled by a listener in rest props, around a checkbox whose onChange sets state.
    [
      `function Box({ children, ...rest }: { children?: ReactNode } & HTMLAttributes<HTMLDivElement>) { return <div {...rest}>{children}</div>; }\nexport function App() { const [c, setC] = useState(false); return <Box onClick={e => e.preventDefault()}><input type="checkbox" checked={c} onChange={e => setC(e.target.checked)} /></Box>; }`,
      'E_EVENT',
      /cancel the click on a checkbox/,
    ],
    [
      `${BUTTON}export function App() { const [n, setN] = useState(0); return <main><Button disabled={n > 0} onMouseEnter={() => setN(1)}>a</Button>{n}</main>; }`,
      'E_EVENT',
      /disabled/,
    ],
    [
      `${BUTTON}export function App() { const [n, setN] = useState(0); return <Button title={String(n)} onPointerEnter={() => setN(n + 1)}>a</Button>; }`,
      'E_EVENT',
      /rendered as text/,
    ],
    [
      `${BUTTON}export function App() { return <Button onMouseLeave={e => e.stopPropagation()}>a</Button>; }`,
      'E_EVENT',
      /one synthetic mouseleave/,
    ],
    [
      `function Box({ ...rest }: InputHTMLAttributes<HTMLInputElement>) { return <input type="checkbox" checked={true} onChange={() => {}} {...rest} />; }\nexport function App() { return <Box id="a" />; }`,
      'E_JSX',
      /checkboxes/,
    ],
    // Ref props.
    [
      `function Field({ ...rest }: InputHTMLAttributes<HTMLInputElement>) { return <input {...rest} />; }\nexport function App() { const r = useRef<HTMLInputElement | null>(null); return <Field ref={r} />; }`,
      'E_REF',
      /ref goes into the rest props/,
    ],
    [
      `function Field({ id }: { id: string }) { return <input id={id} />; }\nexport function App() { const r = useRef<HTMLInputElement | null>(null); return <Field id="a" ref={r} />; }`,
      'E_REF',
      /does not take a ref/,
    ],
    [
      `function Field({ ref }: { ref?: RefObject<HTMLInputElement | null> }) { return <input ref={ref} onClick={() => ref?.current} />; }\nexport function App() { const r = useRef<HTMLInputElement | null>(null); return <Field ref={r} />; }`,
      'E_REF',
      /attached to an element or passed on/,
    ],
    [
      `function Field({ ref }: { ref?: RefObject<HTMLInputElement | null> }) { return <input ref={ref} />; }\nexport function App() { return <Field ref={el => {}} />; }`,
      'E_REF',
      /Callback refs/,
    ],
    [
      `function Field({ ref }: { ref?: RefObject<HTMLInputElement | null> }) { return <input ref={ref} />; }\nexport function App() { const items = [1, 2]; const r = useRef<HTMLInputElement | null>(null); return <main>{items.map(i => <Field key={i} ref={r} />)}</main>; }`,
      'E_REF',
      /list items/,
    ],
  ];
  for (const [source, code, reason] of cases)
    await app(source, root =>
      assert.rejects(lowered(root), e => failWith(code)(e) && reason.test(e.message), source),
    );
});
