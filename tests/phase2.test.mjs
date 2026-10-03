import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collect, hash } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { validateIR, migrateIR, transition, render, validateText } from '../compiler/ir.mjs';
import { generate } from '../compiler/codegen.mjs';

const cache = new Map();
const analyze = app => {
  if (!cache.has(app))
    cache.set(
      app,
      collect(app).then(g => lower(g)),
    );
  return cache.get(app);
};
const clone = ir => {
  const c = structuredClone(ir);
  delete c.irHash;
  delete c.validation;
  return c;
};
const nodes = n => [n, ...(n.children ?? []).flatMap(nodes)];
test('a framework-free IR uses the same validator and Rust backend', () => {
  const ir = {
    schema: 3,
    sourceHash: hash('independent'),
    frontend: { adapter: 'semantic', version: 1, packages: {}, tools: {} },
    title: 'Independent',
    states: [],
    handlers: [],
    ui: {
      id: 'u0',
      kind: 'element',
      tag: 'p',
      attrs: {},
      children: [
        {
          id: 'u1',
          kind: 'text',
          parts: [{ op: 'literal', type: 'string', effect: 'pure', value: 'Hello' }],
        },
      ],
    },
    css: '',
    assets: [],
    mappings: [],
    capabilities: ['dom'],
    provenance: [],
  };
  validateIR(ir);
  ir.irHash = hash(ir);
  const rust = generate(ir);
  assert.match(rust, /Hello/);
  assert.doesNotMatch(rust, /react|vue|useState|createRoot/);
});
test('schema 2 artifacts validate and explicitly migrate without changing transitions', async () => {
  const { ir } = await analyze('fixtures/smoke'),
    old = clone(ir);
  old.schema = 2;
  old.frontend = { react: '19.3.0', vite: '8.3.2', typescript: '5.9.3' };
  old.handlers.forEach(h => delete h.kind);
  const before = validateIR(old),
    migrated = migrateIR(old);
  assert.equal(migrated.schema, 3);
  assert.deepEqual(validateIR(migrated).edges, before.edges);
  assert.equal(old.schema, 2);
  assert.match(generate(old), /pub fn dispatch/);
});
test('adapters preserve React snapshots and Vue immediate reads and captures', async () => {
  const r = await analyze('fixtures/counter-react'),
    v = await analyze('fixtures/counter-vue');
  assert.deepEqual(transition(r.ir, [1, 0, 0, true], 0), [3, 1, 1, true]);
  assert.deepEqual(transition(v.ir, [1, 0, 0, true], 0), [3, 1, 3, true]);
  assert.deepEqual(transition(r.ir, [3, 1, 1, true], 1), [3, 1, 1, true]);
  assert.deepEqual(transition(v.ir, [3, 1, 3, true], 1), [3, 1, 3, true]);
  assert.equal(r.ir.schema, v.ir.schema);
  assert.equal(v.ir.frontend.packages.vue, '3.5.43');
  assert.doesNotMatch(
    generate(v.ir).replace(/^pub const (TITLE|CSS):.*$/gm, ''),
    /react|vue|\.value|computed\(/,
  );
});
test('typed editors validate all UTF16 length classes and preserve arbitrary allowed content', async () => {
  for (const app of ['editor-react', 'editor-vue']) {
    const { ir, edges } = await analyze('fixtures/' + app);
    assert.equal(edges.length, 0);
    assert.equal(ir.validation.reachableStates, 257 * 8);
    assert.match(ir.validation.domain, /length-quotient-v1/);
    for (const value of [
      '',
      'é',
      '😀',
      'e\u0301',
      '日本語',
      '<&"',
      'a'.repeat(256),
      '😀'.repeat(128),
    ]) {
      const s = transition(ir, ['', false, false, true], 0, value);
      assert.equal(s[0], value);
      const tree = nodes(render(ir, s));
      assert.equal(tree.find(n => n.attrs?.id === 'preview').children[0].text, value);
      assert.equal(tree.find(n => n.attrs?.id === 'count').children[0].text, String(value.length));
      assert.deepEqual(transition(ir, s, 1), ['', false, false, true]);
    }
    assert.deepEqual(transition(ir, ['before', true, false, true], 0, 'after'), [
      'before',
      true,
      false,
      true,
    ]);
    assert.deepEqual(transition(ir, ['before', false, true, true], 0, 'after'), [
      'before',
      false,
      true,
      true,
    ]);
    assert.throws(
      () => transition(ir, ['', false, false, true], 0),
      e => e.code === 'E_TEXT_PAYLOAD',
    );
    assert.throws(
      () => transition(ir, ['', false, false, true], 1, 'bad'),
      e => e.code === 'E_TEXT_PAYLOAD',
    );
  }
  for (const value of ['\ud800', 'x\n', 'x\t', '\0', 'a'.repeat(257), '😀'.repeat(129), null, 4])
    assert.throws(
      () => validateText(value),
      e => e.code === 'E_TEXT_PAYLOAD',
    );
});
test('text proof rejects content-dependent predicates and malformed payload uses', async () => {
  const { ir } = await analyze('fixtures/editor-react');
  const nonempty = clone(ir),
    clear = nodes(nonempty.ui).find(n => n.attrs?.id?.value === 'clear');
  clear.attrs.disabled.right.value = 'different';
  assert.throws(
    () => validateIR(nonempty),
    e => e.code === 'E_TEXT_OPERATION',
  );
  const payload = clone(ir);
  nodes(payload.ui).find(n => n.attrs?.id?.value === 'count').children[0].parts[0] = {
    op: 'payload',
    type: 'string',
    effect: 'pure',
  };
  assert.throws(
    () => validateIR(payload),
    e => e.code === 'E_IR',
  );
  const domain = clone(ir);
  domain.states[0].domain.maxUtf16 = 512;
  assert.throws(
    () => validateIR(domain),
    e => e.code === 'E_IR',
  );
  const control = clone(ir);
  nodes(control.ui).find(n => n.tag === 'input').attrs.value.slot = 1;
  assert.throws(
    () => validateIR(control),
    e => e.code === 'E_IR' || e.code === 'E_TEXT_CONTROL',
  );
});
test('Vue unsupported effects, lifecycle, directives and shadowed globals produce diagnostics', async () => {
  await mkdir('.cache/tests', { recursive: true });
  for (const [from, to, expected] of [
    ['const n=ref(1);', "const n=ref(1);console.log('effect');", 'E_EFFECT'],
    ['{ref,computed}', '{ref,computed,onMounted}', 'E_CAPABILITY'],
    ['@click="toggle"', '@click.prevent="toggle"', 'E_TEMPLATE'],
    ['const n=ref(1);', 'const Math=0;const n=ref(1);', 'E_CALL'],
  ]) {
    const root = await mkdtemp(path.resolve('.cache/tests/vue-'));
    try {
      await cp('fixtures/counter-vue', root, { recursive: true });
      const file = path.join(root, 'App.vue');
      await writeFile(file, (await readFile(file, 'utf8')).replace(from, to));
      await assert.rejects(
        () => collect(root).then(lower),
        e => e.code === expected,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('Vue boolean interpolation lowers an explicit string operation', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/vue-text-'));
  try {
    await cp('fixtures/counter-vue', root, { recursive: true });
    const file = path.join(root, 'App.vue');
    await writeFile(file, (await readFile(file, 'utf8')).replace('{{label}}', '{{show}}'));
    const { ir } = await collect(root).then(g => lower(g, { registry: false }));
    const value = nodes(render(ir, [1, 0, 0, true])).find(n => n.attrs?.id === 'value');
    assert.equal(value.children[0].text, 'true');
    assert.match(generate(ir), /s\.s3\)\.to_string/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
