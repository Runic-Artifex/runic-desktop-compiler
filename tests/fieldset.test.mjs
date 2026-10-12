// <fieldset> and <legend>: Blitz lays out and paints the rendered legend as
// Chromium does (conformance/run.mjs, case fieldset, checks it). A
// fieldset's `disabled` disables its descendant controls, which the runtime
// does not model: every framework rejects it at its source, including
// through spreads that may hold it, and the IR validator rejects it too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { check, interpret } from '../compiler/codegen.mjs';

const graphs = new Map();
const graph = name => {
  if (!graphs.has(name)) graphs.set(name, collect('fixtures/' + name));
  return graphs.get(name);
};

/** The collected fixture with replacements per file: { file: [[from, to], …] }. */
async function edits(name, files) {
  const g = await graph(name);
  const modules = new Map(g.modules);
  let all = '';
  for (const [file, pairs] of Object.entries(files)) {
    const id = path.join(g.root, file);
    let code = g.modules.get(id).code;
    for (const [from, to] of pairs) {
      assert.ok(code.includes(from), `Replacement must match in ${file}: ${from}`);
      code = code.split(from).join(to);
    }
    modules.set(id, { ...g.modules.get(id), code });
    all += code;
  }
  return { ...g, modules, hash: hash(all) };
}

const rejects = (g, code, file, message) =>
  assert.rejects(lower(g), e => {
    assert.ok(e instanceof Diagnostic, `expected a diagnostic, got ${e}`);
    assert.equal(e.code, code, e.message);
    assert.equal(path.basename(e.source?.file ?? ''), file, e.message);
    assert.ok(e.source.line > 0 && e.source.column > 0);
    assert.match(e.message, message);
    return true;
  });

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const byId = (step, id) => flat(step.state.dom).find(n => n.attrs.id === id);

const OWN = /^disabled on <fieldset> are not supported/;
const SPREAD = /^Spread attributes that may hold disabled on <fieldset> are not supported/;

test('Svelte: fieldsets and legends lower, with shadcn-svelte rest spreads', async () => {
  const { ir } = await lower(await graph('fieldset-svelte'));
  check(ir);
  const steps = interpret(ir, [{ kind: 'click', id: 'toggle' }]);
  assert.equal(byId(steps[0], 'field-set').tag, 'fieldset');
  assert.equal(byId(steps[0], 'field-set').attrs.class, 'field-set sm');
  assert.equal(byId(steps[0], 'field-legend').attrs['data-variant'], 'legend');
  // {#if} removes the rendered legend.
  assert.equal(byId(steps[0], 'sized-legend').tag, 'legend');
  assert.equal(byId(steps[1], 'sized-legend'), undefined);
});

test('Svelte: disabled on a fieldset is rejected where it is written', async () => {
  await rejects(
    await edits('fieldset-svelte', {
      'App.svelte': [['<fieldset id="plain">', '<fieldset id="plain" disabled={clicks > 0}>']],
    }),
    'E_TEMPLATE',
    'App.svelte',
    OWN,
  );
  // Through FieldSet's rest props: the spread may hold it.
  await rejects(
    await edits('fieldset-svelte', {
      'App.svelte': [['<FieldSet id="label-set">', '<FieldSet id="label-set" disabled>']],
    }),
    'E_TEMPLATE',
    'FieldSet.svelte',
    SPREAD,
  );
});

/** rest-react's and rest-vue's Button rendering a fieldset. */
const reactFieldset = (app = []) =>
  edits('rest-react', {
    'Button.tsx': [
      ['<button', '<fieldset'],
      ['</button>', '</fieldset>'],
      [' type="button"', ''],
    ],
    ...(app.length ? { 'App.tsx': app } : {}),
  });
const vueFieldset = (app = []) =>
  edits('rest-vue', {
    'Button.vue': [
      [
        '<button :class="`btn ${variant}`" type="button"><slot /></button>',
        '<fieldset :class="`btn ${variant}`"><legend>Group</legend><slot /></fieldset>',
      ],
    ],
    ...(app.length ? { 'App.vue': app } : {}),
  });

test('React and Vue: fieldsets and legends lower; disabled is rejected, also through rest props', async () => {
  // Without the disabled that App passes to IconButton, which forwards it to Button.
  for (const g of [
    await reactFieldset([['          disabled={busy}\n', '']]),
    await vueFieldset([[' :disabled="busy"', '']]),
  ]) {
    const { ir } = await lower(g);
    check(ir);
    const [step] = interpret(ir, []);
    assert.equal(byId(step, 'inc').tag, 'fieldset');
  }
  await rejects(
    await edits('rest-react', {
      'Button.tsx': [['{children}', '{children}<fieldset disabled />']],
    }),
    'E_JSX',
    'Button.tsx',
    OWN,
  );
  // Forwarded: IconButton's rest props reach Button's.
  await rejects(await reactFieldset(), 'E_JSX', 'Button.tsx', SPREAD);
  await rejects(
    await reactFieldset([
      ['          disabled={busy}\n', ''],
      ['aria-label="Increment"', 'aria-label="Increment" disabled'],
    ]),
    'E_JSX',
    'Button.tsx',
    SPREAD,
  );
  await rejects(
    await edits('rest-vue', {
      'Button.vue': [['<slot />', '<slot /><fieldset :disabled="false" />']],
    }),
    'E_TEMPLATE',
    'Button.vue',
    OWN,
  );
  await rejects(await vueFieldset(), 'E_TEMPLATE', 'Button.vue', SPREAD);
  await rejects(
    await vueFieldset([
      [' :disabled="busy"', ''],
      ['aria-label="Increment"', 'aria-label="Increment" disabled'],
    ]),
    'E_TEMPLATE',
    'Button.vue',
    SPREAD,
  );
});

test('the validator rejects disabled on a fieldset', async () => {
  const { ir } = await lower(await graph('fieldset-svelte'));
  const copy = structuredClone(ir);
  const find = nodes => {
    for (const n of nodes ?? []) {
      if (n.tag === 'fieldset') return n;
      for (const k of ['children', 'then', 'else', 'body', 'fallback']) {
        const found = find(n[k]);
        if (found) return found;
      }
    }
  };
  find(copy.components.flatMap(c => c.template)).attrs.push({
    name: 'disabled',
    value: { op: 'lit', value: '' },
  });
  assert.throws(
    () => check(copy),
    e => e.code === 'E_IR' && /disabled on <fieldset> is unsupported/.test(e.message),
  );
});
