// M5 platform surface (docs/design/M5-PLATFORM.md): event objects, window
// and document listeners, rest props and spread attributes. Behaviour
// against Chromium is checked by conformance/run.mjs (cases events,
// shortcuts, rest-props); these tests pin interpreter semantics and the
// rejections, with locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const graphs = new Map();
const graph = name => {
  if (!graphs.has(name)) graphs.set(name, collect('fixtures/' + name));
  return graphs.get(name);
};

/** The collected fixture with replacements in `file`. */
async function edits(name, file, pairs) {
  const g = await graph(name);
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

const rejects = async (g, code, file) =>
  assert.rejects(lower(g), e => {
    assert.ok(e instanceof Diagnostic, `expected a diagnostic, got ${e}`);
    assert.equal(e.code, code, e.message);
    assert.equal(e.source?.file, file, e.message);
    assert.ok(e.source.line > 0 && e.source.column > 0);
    return true;
  });

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const text = (step, id) =>
  textOf(flat(step.state.dom).find(n => n.attrs.id === id))
    .replace(/\s+/g, ' ')
    .trim();

test('event objects: propagation, target and currentTarget, cancellation, pointer and key sequences', async () => {
  const { ir } = await lower(await graph('events-svelte'));
  const steps = interpret(ir, [
    { kind: 'click', id: 'inner' },
    { kind: 'click', id: 'stop' },
    { kind: 'click', id: 'inner' },
    { kind: 'click', id: 'outer' },
    { kind: 'click', id: 'agree' },
    { kind: 'keydown', id: 'field', key: 'Shift+x' },
    { kind: 'hover', id: 'box' },
    { kind: 'dblclick', id: 'box' },
    { kind: 'contextmenu', id: 'box' },
    { kind: 'wheel', id: 'box', deltaX: 0, deltaY: 40 },
    { kind: 'keydown', id: 'enter', key: 'Enter' },
    { kind: 'keydown', id: 'enter', key: ' ' },
  ]);
  const last = steps.at(-1);
  assert.equal(
    text(last, 'log'),
    'inner outer inner outer keydown:Shift:ShiftLeft+shift keydown:x:KeyX+shift keyup:x:KeyX+shift keyup:Shift:ShiftLeft enter-click',
  );
  // Clicking #outer itself closes; the locked checkbox stays unchecked.
  assert.equal(text(last, 'state'), 'true false');
  // One enter (hover, then the double click on the same box), two clicks, one menu, a wheel.
  assert.equal(text(last, 'box'), 'Box 1 true 1 1 40');
});

test('window and document listeners: shortcuts, click outside, stopPropagation, listeners added mid-dispatch', async () => {
  const { ir } = await lower(await graph('shortcuts-svelte'));
  const steps = interpret(ir, [
    { kind: 'click', id: 'open' },
    { kind: 'click', id: 'panel' },
    { kind: 'keydown', id: 'field', key: 'Control+k' },
    { kind: 'keydown', id: 'field', key: 'q' },
    { kind: 'click', id: 'field' },
    { kind: 'click', id: 'open-late' },
  ]);
  const last = steps.at(-1);
  assert.equal(
    text(last, 'log'),
    'open document window:Control window:k document outside open-late document outside',
  );
  assert.equal(text(last, 'state'), 'false 1');
});

test('rest props: call-site attributes and listeners reach the element through two components', async () => {
  const { ir } = await lower(await graph('rest-svelte'));
  const button = ir.components.find(c => c.name === 'Button');
  assert.ok(JSON.stringify(button.template).includes('"spread"'));
  const steps = interpret(ir, [
    { kind: 'click', id: 'inc' },
    { kind: 'hover', id: 'icon' },
    { kind: 'click', id: 'icon' },
    { kind: 'click', id: 'toggle' },
    { kind: 'click', id: 'icon' },
  ]);
  const icon = s => flat(s.state.dom).find(n => n.attrs.id === 'icon').attrs;
  assert.deepEqual(icon(steps[1]), {
    class: 'btn ghost',
    'data-count': '1',
    id: 'icon',
    type: 'button',
  });
  assert.equal(icon(steps[4]).disabled, '');
  assert.equal(flat(steps[4].state.dom).find(n => n.attrs.id === 'inc').attrs.title, undefined);
  assert.equal(text(steps.at(-1), 'log'), 'enter click enter');
});

test('rejected: spreads other than rest props, rest props reaching declared props, unsupported listeners', async () => {
  await rejects(
    await edits('rest-svelte', 'App.svelte', [['<p id="state">', '<p {...{ a: 1 }} id="state">']]),
    'E_TEMPLATE',
    'App.svelte',
  );
  // IconButton forwards its rest props to Button, which declares `class`.
  await rejects(
    await edits('rest-svelte', 'App.svelte', [['label="Icon"', 'label="Icon" class="x"']]),
    'E_PROPS',
    'IconButton.svelte',
  );
  await rejects(
    await edits('rest-svelte', 'App.svelte', [
      ['aria-label="Increment"', 'onscroll={() => count++}'],
    ]),
    'E_EVENT',
    'App.svelte',
  );
  await rejects(
    await edits('shortcuts-svelte', 'App.svelte', [
      [
        "document.addEventListener('click', close)",
        "document.addEventListener('click', close, true)",
      ],
    ]),
    'E_EVENT',
    'App.svelte',
  );
});

test('forms: text areas take line breaks; labels activate their checkbox', async () => {
  const { ir } = await lower(await graph('forms-svelte'));
  const steps = interpret(ir, [
    { kind: 'input', id: 'notes', value: 'one\ntwo\nthree' },
    { kind: 'click', id: 'agree-label' },
    { kind: 'click', id: 'agree' },
    { kind: 'click', id: 'agree-label' },
  ]);
  assert.equal(text(steps[1], 'lines'), '3 lines');
  assert.deepEqual(
    steps.slice(2).map(s => text(s, 'state')),
    ['true', 'false', 'true'],
  );
});

test('layout reads and scrolling lower to element built-ins; unsupported shapes are rejected', async () => {
  const { ir } = await lower(await graph('measure-svelte'));
  const names = new Set();
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (v.op === 'builtin') names.add(v.name);
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(ir);
  for (const n of [
    'element.getBoundingClientRect',
    'element.offsetWidth',
    'element.set-scrollTop',
    'element.scrollBy',
    'element.scrollTo',
    'element.scrollIntoView',
    'window.innerWidth',
  ])
    assert.ok(names.has(n), n);
  // The interpreter has no layout: it throws rather than guessing.
  assert.throws(() => interpret(ir, []), /RunicLayoutError|needs the native layout/);
  for (const [from, to] of [
    ['list.scrollTo({ top: 0 })', "list.scrollTo({ top: 0, behavior: 'smooth' })"],
    [
      "mid.scrollIntoView({ block: 'nearest' })",
      "mid.scrollIntoView({ block: wide ? 'start' : 'end' })",
    ],
    ['list.scrollBy(0, 33.5)', 'list.scrollBy({ top: 1, extra: 2 } as ScrollToOptions)'],
  ])
    await rejects(
      await edits('measure-svelte', 'App.svelte', [[from, to]]),
      'E_CALL',
      'App.svelte',
    );
});
