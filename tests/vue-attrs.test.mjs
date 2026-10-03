// Vue fallthrough attributes, v-bind="$attrs" / useAttrs() and component
// refs (docs/design/M5-PLATFORM.md, rest props). Behaviour against Chromium
// is checked by conformance/run.mjs (cases rest-props, component-refs); these
// tests pin the interpreter semantics, Vue's attribute coercion and class
// merging, and the rejections, with locations.
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
      code = code.replace(from, to);
    }
    modules.set(id, { ...g.modules.get(id), code });
    all += code;
  }
  return { ...g, modules, hash: hash(all) };
}

const rejects = async (g, code, file, message) =>
  assert.rejects(lower(g), e => {
    assert.ok(e instanceof Diagnostic, `expected a diagnostic, got ${e}`);
    assert.equal(e.code, code, e.message);
    assert.equal(e.source?.file, file, e.message);
    assert.ok(e.source.line > 0 && e.source.column > 0);
    if (message) assert.match(e.message, message);
    return true;
  });

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const byId = (step, id) => flat(step.state.dom).find(n => n.attrs.id === id);
const text = (step, id) => textOf(byId(step, id)).replace(/\s+/g, ' ').trim();
/** The DOM without whitespace-only text (Vue's compiler condenses it; Svelte keeps it). */
const dom = step => {
  const strip = nodes =>
    nodes
      .filter(n => typeof n !== 'string' || n.trim())
      .map(n => (typeof n === 'string' ? n : { ...n, children: strip(n.children) }));
  return strip(step.state.dom);
};

const restActions = [
  { kind: 'click', id: 'inc' },
  { kind: 'hover', id: 'icon' },
  { kind: 'click', id: 'icon' },
  { kind: 'click', id: 'toggle' },
  { kind: 'click', id: 'icon' },
  { kind: 'click', id: 'toggle' },
  { kind: 'click', id: 'icon' },
];

test('fallthrough: attributes and listeners reach the root element through two components, as in Svelte', async () => {
  const vue = interpret((await lower(await graph('rest-vue'))).ir, restActions);
  const svelte = interpret((await lower(await graph('rest-svelte'))).ir, restActions);
  assert.equal(vue.length, svelte.length);
  vue.forEach((step, i) => assert.deepEqual(dom(step), dom(svelte[i]), `step ${i}`));
  // A passed class joins the root's own; undefined removes an attribute.
  assert.deepEqual(byId(vue[0], 'toggle').attrs, {
    class: 'btn outline wide',
    id: 'toggle',
    type: 'button',
  });
  assert.equal(byId(vue[0], 'inc').attrs.title, 'First');
  assert.equal(byId(vue[4], 'inc').attrs.title, undefined);
  assert.equal(byId(vue[4], 'icon').attrs.disabled, '');
  // The disabled button still gets pointerenter, but no click.
  assert.equal(text(vue.at(-1), 'log'), 'enter click enter enter click');
});

test('fallthrough coercion follows runtime-dom: booleans as text, boolean properties, class merging', async () => {
  const g = await edits('rest-vue', {
    'App.vue': [
      [
        'aria-label="Increment"',
        ':aria-hidden="busy" :data-x="!busy" :hidden="busy" autofocus readonly :class="\'  a  \'"',
      ],
      // Equal classes are not joined (mergeProps).
      ['class="wide"', 'class="btn outline"'],
    ],
  });
  const steps = interpret((await lower(g)).ir, [{ kind: 'click', id: 'toggle' }]);
  assert.deepEqual(byId(steps[0], 'inc').attrs, {
    'aria-hidden': 'false',
    autofocus: '',
    class: 'btn default a',
    'data-x': 'true',
    id: 'inc',
    readonly: '',
    title: 'First',
    type: 'button',
  });
  assert.equal(byId(steps[0], 'toggle').attrs.class, 'btn outline');
  const after = byId(steps[1], 'inc').attrs;
  assert.equal(after['aria-hidden'], 'true');
  assert.equal(after['data-x'], 'false');
  assert.equal(after.hidden, '');

  // On a <div>, `disabled` is attribute text ("false"), not a property.
  const div = await edits('rest-vue', {
    'Button.vue': [
      [
        '<button :class="`btn ${variant}`" type="button"><slot /></button>',
        '<div :class="`btn ${variant}`"><slot /></div>',
      ],
    ],
  });
  const d = interpret((await lower(div)).ir, []);
  assert.equal(byId(d[0], 'icon').attrs.disabled, 'false');
});

test('v-bind="$attrs" merges with the attributes around it in source order', async () => {
  const g = await edits('rest-vue', {
    'Button.vue': [
      ['const {', 'defineOptions({ inheritAttrs: false });\nconst {'],
      ['<button :class', '<button v-bind="$attrs" :class'],
    ],
  });
  const steps = interpret((await lower(g)).ir, []);
  assert.equal(byId(steps[0], 'toggle').attrs.class, 'wide btn outline');
  assert.equal(byId(steps[0], 'icon').attrs['data-count'], '0');
  // inheritAttrs: false without v-bind: Vue applies nothing.
  const off = await edits('rest-vue', {
    'Button.vue': [['const {', 'defineOptions({ inheritAttrs: false });\nconst {']],
  });
  const plain = interpret((await lower(off)).ir, []);
  assert.deepEqual(byId(plain[0], 'inc'), undefined);
});

test('component refs reach the exposed element; null after unmount, set again on remount', async () => {
  const actions = [
    { kind: 'click', id: 'focus' },
    { kind: 'input', id: 'name', value: 'Ada' },
    { kind: 'click', id: 'toggle' },
    { kind: 'click', id: 'focus' },
    { kind: 'click', id: 'toggle' },
    { kind: 'click', id: 'focus' },
    { kind: 'input', id: 'name', value: 'Ada!' },
  ];
  const vue = interpret((await lower(await graph('comprefs-vue'))).ir, actions);
  const svelte = interpret((await lower(await graph('comprefs-svelte'))).ir, actions);
  vue.forEach((step, i) => assert.deepEqual(dom(step), dom(svelte[i]), `step ${i}`));
  assert.deepEqual(
    vue.map(s => text(s, 'state')),
    ['ref', 'ref', 'ref Ada', 'none Ada', 'none Ada', 'ref Ada', 'ref Ada', 'ref Ada!'],
  );
});

test('rejected: attributes Vue would drop, merge or set as properties; unsupported refs', async () => {
  // Several root nodes: Vue drops the attributes.
  await rejects(
    await edits('rest-vue', {
      'Button.vue': [['<slot /></button>', '<slot /></button><span>x</span>']],
    }),
    'E_ATTRS',
    'App.vue',
    /drops the attributes/,
  );
  // Style merging, listener modifiers, live properties, inline handlers.
  for (const [from, to, re] of [
    ['aria-label="Increment"', 'style="color: red"', /style/],
    ['@click="count++"', '@click.stop="count++"', /Modifiers/],
    ['aria-label="Increment"', ':value="title"', /property/],
    ['aria-label="Increment"', 'onfocus="go()"', /inline handler/],
    ['aria-label="Increment"', ':ariaLabel="title"', /lowercase/],
  ])
    await rejects(await edits('rest-vue', { 'App.vue': [[from, to]] }), 'E_ATTRS', 'App.vue', re);
  // A boolean property needs a boolean (Vue's coercion of other values differs).
  await rejects(
    await edits('rest-vue', { 'App.vue': [[':disabled="busy"', ':disabled="count"']] }),
    'E_ATTRS',
    'App.vue',
  );
  // `disabled` reaching a <button> (property) and a <p> (text).
  await rejects(
    await edits('rest-vue', {
      'IconButton.vue': [
        [
          '<Button variant="ghost" v-bind="$attrs">{{ label }}</Button>',
          '<div><Button variant="ghost" v-bind="$attrs">{{ label }}</Button><p v-bind="$attrs"></p></div>',
        ],
      ],
    }),
    'E_ATTRS',
    'App.vue',
    /boolean property/,
  );
  // IconButton forwards its attrs to Button, which declares `variant`.
  await rejects(
    await edits('rest-vue', { 'App.vue': [['label="Icon"', 'label="Icon" variant="x"']] }),
    'E_ATTRS',
    'App.vue',
    /declares/,
  );
  // A listener on the root element and in the attrs: Vue calls both.
  await rejects(
    await edits('rest-vue', {
      'Button.vue': [['type="button"', 'type="button" @click="() => {}"']],
    }),
    'E_ATTRS',
    'Button.vue',
  );
  // $attrs bound on the root as well as falling through to it.
  await rejects(
    await edits('rest-vue', {
      'Button.vue': [['<button :class', '<button v-bind="$attrs" :class']],
    }),
    'E_ATTRS',
    'Button.vue',
  );
  // Other objects, reading attrs by name.
  await rejects(
    await edits('rest-vue', {
      'App.vue': [['<p id="state">', '<p v-bind="{ id: 1 }" id="state">']],
    }),
    'E_TEMPLATE',
    'App.vue',
  );
  await rejects(
    await edits('comprefs-vue', {
      'Field.vue': [
        ['defineExpose({ input });', 'defineExpose({ input });\nconst n = attrs ? 1 : 0;'],
      ],
    }),
    'E_ATTRS',
    'Field.vue',
  );
  // Component refs need an exposed element of the instance, read outside attributes.
  await rejects(
    await edits('comprefs-vue', { 'Field.vue': [['defineExpose({ input });', '']] }),
    'E_REF',
    'App.vue',
  );
  await rejects(
    await edits('comprefs-vue', {
      'Field.vue': [['<input ref="input"', '<input v-if="value !== \'x\'" ref="input"']],
    }),
    'E_EXPOSE',
    'Field.vue',
  );
  await rejects(
    await edits('comprefs-vue', {
      'App.vue': [['<p id="state">', '<p id="state" :title="field ? \'a\' : \'b\'">']],
    }),
    'E_REF',
    'App.vue',
  );
  await rejects(
    await edits('comprefs-vue', {
      'App.vue': [
        [
          "useTemplateRef<InstanceType<typeof Field>>('field')",
          "useTemplateRef<HTMLInputElement>('field')",
        ],
      ],
    }),
    'E_REF',
    'App.vue',
  );
});
