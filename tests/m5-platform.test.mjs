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

test('rest props reaching declared props (M6): a later spread entry overrides the explicit prop', async () => {
  // IconButton forwards its rest props to Button, which declares `class`
  // and `variant`; IconButton passes variant="ghost" before the spread.
  const { ir } = await lower(
    await edits('rest-svelte', 'App.svelte', [
      ['label="Icon"', 'label="Icon" class="x" variant={busy ? "outline" : undefined}'],
    ]),
  );
  const steps = interpret(ir, [{ kind: 'click', id: 'toggle' }]);
  const cls = s => flat(s.state.dom).find(n => n.attrs.id === 'icon').attrs.class;
  // An undefined entry still wins over the explicit value, and then the
  // prop takes its default.
  assert.deepEqual(steps.map(cls), ['btn default x', 'btn outline x']);
});

test('rejected: spreads of unsupported values, unsupported listeners', async () => {
  await rejects(
    // (An object literal spread is a bag of its entries; an array is no attribute value.)
    await edits('rest-svelte', 'App.svelte', [
      ['<p id="state">', '<p {...{ a: [1] }} id="state">'],
    ]),
    'E_ATTRS',
    'App.svelte',
  );
  await rejects(
    await edits('rest-svelte', 'App.svelte', [
      ['aria-label="Increment"', 'onpaste={() => count++}'],
    ]),
    'E_EVENT',
    'App.svelte',
  );
  await rejects(
    await edits('shortcuts-svelte', 'App.svelte', [
      [
        "document.addEventListener('click', close)",
        "document.addEventListener('click', close, { passive: true })",
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
      // (A union of alignments is covered, M6: a string is not.)
      "mid.scrollIntoView({ block: String(wide ? 'start' : 'end') })",
    ],
    ['list.scrollBy(0, 33.5)', 'list.scrollBy({ top: 1, extra: 2 } as ScrollToOptions)'],
  ])
    await rejects(
      await edits('measure-svelte', 'App.svelte', [[from, to]]),
      'E_CALL',
      'App.svelte',
    );
});

test('media query lists: change events after emulate and resize, in the rendering step', async () => {
  const { ir } = await lower(await graph('viewport-svelte'));
  const actions = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile('conformance/cases/media-events.json', 'utf8'),
  ).actions;
  const steps = interpret(ir, actions);
  // As Chromium logs it (conformance case media-events, 800x600).
  assert.equal(
    text(steps.at(-1), 'log'),
    'dark true change, resize, wide false, resize, wide true, dark false change, resize',
  );
  assert.equal(text(steps.at(-1), 'now'), 'false false false');
  await rejects(
    await edits('viewport-svelte', 'App.svelte', [
      ["dark.addEventListener('change', onDark)", "dark.addEventListener('input', onDark)"],
    ]),
    'E_EVENT',
    'App.svelte',
  );
});

test('window.setTimeout and the other window timer functions are the global ones', async () => {
  const plain = (await lower(await graph('timers-svelte'))).ir;
  const prefixed = (
    await lower(
      await edits('timers-svelte', 'App.svelte', [
        [
          "setTimeout(() => (log = log + ' 250'), 250);",
          "window.setTimeout(() => (log = log + ' 250'), 250);",
        ],
      ]),
    )
  ).ir;
  const names = ir => {
    const out = [];
    const walk = v => {
      if (!v || typeof v !== 'object') return;
      if (v.op === 'builtin') out.push(v.name);
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
    };
    walk(ir.components);
    return out;
  };
  assert.deepEqual(names(prefixed), names(plain));
});
