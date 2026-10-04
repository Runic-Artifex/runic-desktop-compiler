// Vue parity for M5 steps 2–6 (docs/design/M5-PLATFORM.md): :class and
// :style bindings, focus events, text areas and labels with :value and
// v-model, and the document element. Behaviour against Chromium is checked by
// conformance/run.mjs (cases class-directives, style-directives, focus,
// forms-vue, theme); these tests pin the interpreter semantics, Vue's
// normalizeClass / normalizeStyle / patchStyle, the re-render restore of text
// controls, and the rejections, with locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';
import { parseStringStyle, stringifyStyle } from '../frontend/adapters/vue.ts';

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
const byId = (step, id) => flat(step.state.dom).find(n => n.attrs.id === id);
const nodes = (program, pred) => {
  const out = [];
  const walk = list => {
    for (const n of list ?? []) {
      if (pred(n)) out.push(n);
      walk(n.children);
      walk(n.then);
      walk(n.else);
      walk(n.body);
      for (const s of n.slots ?? []) walk(s.body);
    }
  };
  for (const c of program.components) walk(c.template);
  return out;
};

test('normalizeClass: objects, arrays and strings joined with a static class in source order', async () => {
  const steps = interpret((await lower(await graph('fixtures/classes-vue'))).ir, [
    { kind: 'click', id: 'toggle' },
    { kind: 'click', id: 'base' },
    { kind: 'click', id: 'other' },
  ]);
  const classes = i =>
    Object.fromEntries(
      ['bare', 'fixed', 'dynamic', 'list'].map(id => [id, byId(steps[i], id).attrs.class]),
    );
  // A false object gives an empty (present) class; the parser condensed the
  // static class; strings keep inner whitespace and are trimmed.
  assert.deepEqual(classes(0), {
    bare: '',
    fixed: 'fixed text off',
    dynamic: 'card  wide other',
    list: 'wide other card fixed',
  });
  assert.deepEqual(classes(1), {
    bare: 'on',
    fixed: 'fixed text on',
    dynamic: 'card  wide on other',
    list: 'on wide other card fixed',
  });
  // A nullable string joins once it is set (trimmed).
  assert.equal(classes(2).list, 'on extra wide other card fixed');
  assert.deepEqual(classes(3), {
    bare: 'on',
    fixed: 'fixed text on',
    dynamic: 'card on on',
    list: 'on extra wide fixed',
  });
});

test('component tags: a static and a dynamic class are one normalized fallthrough class', async () => {
  const g = await edits('fixtures/rest-vue', {
    'App.vue': [['class="wide"', 'class="wide" :class="{ busy, idle: !busy }"']],
  });
  const { ir } = await lower(g);
  const steps = interpret(ir, [{ kind: 'click', id: 'toggle' }]);
  assert.equal(byId(steps[0], 'toggle').attrs.class, 'btn outline wide idle');
  assert.equal(byId(steps[1], 'toggle').attrs.class, 'btn outline wide busy');
});

test('parseStringStyle and stringifyStyle follow @vue/shared', () => {
  assert.deepEqual(
    [...parseStringStyle('color: red; background: url(a;b) /* x; y */;  PADDING:6px; color: blue')],
    [
      ['color', 'blue'],
      ['background', 'url(a;b)'],
      ['PADDING', '6px'],
    ],
  );
  assert.equal(
    stringifyStyle(
      new Map([
        ['PADDING', '2px'],
        ['--x', 'A'],
        ['marginTop', '1px'],
      ]),
    ),
    'p-a-d-d-i-n-g:2px;--x:A;margin-top:1px;',
  );
});

test('inline styles: patchStyle through the CSSOM, static HTML text where Vue stringifies', async () => {
  const { ir } = await lower(await graph('fixtures/styles-vue'));
  // Static styles of stringified content are the compiler's text; others are CSSOM properties.
  const spans = nodes(ir, n => n.tag === 'span');
  assert.deepEqual(
    spans.map(n => n.attrs.find(a => a.name === 'style').value.value),
    ['color:RED;', 'font-weight:700;', 'color:green;', 'p-a-d-d-i-n-g:2px;', 'margin-left:2px;'],
  );
  const mixed = nodes(ir, n => n.attrs?.some(a => a.name === 'id' && a.value.value === 'mixed'))[0];
  assert.equal(mixed.styleUpdate, 'replace');
  assert.deepEqual(
    mixed.styles.map(s => s.name),
    ['margin-left', 'color', 'padding', '--accent', 'border-color', 'border'],
  );
  const steps = interpret(ir, [
    { kind: 'click', id: 'color' },
    { kind: 'click', id: 'base' },
    { kind: 'click', id: 'color' },
  ]);
  const style = (i, id) => byId(steps[i], id).attrs.style;
  assert.equal(style(0, 'directive'), 'color: rgb(32, 80, 160); width: 120px;');
  assert.equal(style(0, 'text'), 'margin: 4px; padding: 6px;');
  assert.equal(style(0, 'static'), 'color: red; margin-top: 4px;');
  assert.equal(
    style(0, 'both'),
    'border: 1px solid rgb(82, 102, 91); background-color: rgb(223, 231, 240);',
  );
  assert.equal(style(0, 'important'), 'color: rgb(32, 80, 160) !important; opacity: 0.6;');
  // A nullish value removes its property; the shorthand set after border-color resets it.
  assert.equal(style(1, 'directive'), 'width: 120px;');
  assert.equal(style(1, 'important'), 'color: gray; opacity: 0.6;');
  assert.equal(
    style(1, 'mixed'),
    'margin-left: 2px; padding: 1px; --accent: #dfe7f0; border: 1px solid;',
  );
  // A text replaces the declarations (cssText).
  assert.equal(style(2, 'text'), 'padding: 2px; color: green;');
  assert.equal(
    style(3, 'mixed'),
    'margin-left: 2px; padding: 1px; --accent: #dfe7f0; border: 1px solid; color: rgb(32, 80, 160);',
  );
});

test('a text style: cssText when it changes, an empty text stays when it becomes nullish', async () => {
  const g = await edits('fixtures/styles-vue', {
    'App.vue': [
      [
        "const tone = ref('#dfe7f0');",
        "const tone = ref('#dfe7f0');\nconst plain = ref<string | null>('');\nfunction cycle() {\n  if (plain.value === '') plain.value = null;\n  else if (plain.value === null) plain.value = 'color: blue';\n  else plain.value = '';\n}",
      ],
      [
        '<p id="text" :style="base">Text</p>',
        '<p id="text" :style="base">Text</p><p id="plain" :style="plain" @click="cycle">Plain</p>',
      ],
    ],
  });
  const steps = interpret((await lower(g)).ir, [
    { kind: 'click', id: 'plain' },
    { kind: 'click', id: 'plain' },
    { kind: 'click', id: 'plain' },
  ]);
  assert.deepEqual(
    steps.map(s => byId(s, 'plain').attrs.style),
    ['', '', 'color: blue;', ''],
  );
});

test('focus events: listeners with modifiers and relatedTarget, focus() running them nested', async () => {
  const { ir } = await lower(await graph('fixtures/focus-vue'));
  const steps = interpret(ir, [{ kind: 'click', id: 'a' }]);
  assert.equal(
    flat(steps[1].state.dom)
      .find(n => n.attrs.id === 'log')
      .children.join(''),
    'a-focus row-in a-click a-blur row-out field-focus true row-in a-after',
  );
});

test('text controls: Vue patches :value and v-model values at every re-render, checkboxes when they change', async () => {
  const { ir } = await lower(await graph('fixtures/forms-vue'));
  const app = ir.components.find(c => c.name === 'App');
  const render = app.effects.find(e => e.render);
  assert.equal(render.phase, 'pre');
  assert.equal(render.deps.kind, 'tracked');
  assert.deepEqual(
    nodes(ir, n => n.restore === 'render').map(n => n.attrs.find(a => a.name === 'id').value.value),
    ['notes', 'name', 'fixed', 'memo'],
  );
  const steps = interpret(ir, [
    { kind: 'input', id: 'fixed', value: 'fixed!' },
    { kind: 'input', id: 'memo', value: '?' },
    { kind: 'click', id: 'frozen' },
    { kind: 'click', id: 'other' },
    { kind: 'input', id: 'notes', value: 'a\nb\nc' },
  ]);
  const live = (i, id) => byId(steps[i], id).value;
  // Typed without a listener: the value stays until a re-render restores it.
  assert.equal(live(2, 'fixed'), 'fixed!');
  assert.equal(live(2, 'memo'), '?');
  assert.equal(live(4, 'fixed'), 'fixed');
  assert.equal(live(4, 'memo'), '');
  assert.equal(byId(steps[4], 'frozen').checked, true);
  // The text area's :value is also its value attribute.
  assert.equal(byId(steps[4], 'memo').attrs.value, '');
  assert.equal(live(5, 'notes'), 'a\nb\nc');
  assert.equal(byId(steps[5], 'lines').children.join(''), '3 lines');
});

test('a re-render needs a read: state the template does not read restores nothing', async () => {
  const g = await edits('fixtures/forms-vue', {
    'App.vue': [
      ['const other = ref(0);', 'const other = ref(0);\nconst unread = ref(0);'],
      [
        '<button id="other" @click="other++">',
        '<button id="unread" @click="unread++">Unread</button><button id="other" @click="other++">',
      ],
    ],
  });
  const steps = interpret((await lower(g)).ir, [
    { kind: 'input', id: 'fixed', value: 'fixed!' },
    { kind: 'click', id: 'unread' },
    { kind: 'click', id: 'other' },
  ]);
  assert.equal(byId(steps[2], 'fixed').value, 'fixed!');
  assert.equal(byId(steps[3], 'fixed').value, 'fixed');
});

test('rejections: class and style values Runic cannot normalize as Vue does', async () => {
  await rejects(
    await edits('fixtures/classes-vue', {
      'App.vue': [
        [
          'const extra = ref<string | null>(null);',
          "const extra = ref<string | null>(null);\nconst names = ref(['a']);",
        ],
        ['<p id="bare" :class="{ on }">', '<p id="bare" :class="names">'],
      ],
    }),
    'E_TEMPLATE',
    'App.vue',
    /class values by reference/,
  );
  await rejects(
    await edits('fixtures/styles-vue', {
      'App.vue': [['{ backgroundColor: tone }', '{ WebkitTransform: tone }']],
    }),
    'E_TEMPLATE',
    'App.vue',
    /vendor prefix/,
  );
  await rejects(
    await edits('fixtures/styles-vue', {
      'App.vue': [['{ backgroundColor: tone }', '{ filter: tone }']],
    }),
    'E_TEMPLATE',
    'App.vue',
    /WebkitFilter/,
  );
  await rejects(
    await edits('fixtures/styles-vue', {
      'App.vue': [["'padding: 1px /* a; b */'", 'base']],
    }),
    'E_TEMPLATE',
    'App.vue',
    /dynamic style text in a :style array/,
  );
  await rejects(
    await edits('fixtures/styles-vue', {
      'App.vue': [
        ['<p id="text" :style="base">', '<p id="text" style="color: red" :style="base">'],
      ],
    }),
    'E_TEMPLATE',
    'App.vue',
    /dynamic style text with a static style/,
  );
  await rejects(
    await edits('fixtures/forms-vue', {
      'App.vue': [
        [
          '<textarea id="memo" aria-label="Memo" :value="memo">',
          '<textarea id="memo" aria-label="Memo" :value="memo" :style="{ width: `${other}px` }">',
        ],
      ],
    }),
    'E_TEMPLATE',
    'App.vue',
    /text area/,
  );
});

test('rejections: text controls whose re-render restore Runic cannot reproduce', async () => {
  await rejects(
    await edits('fixtures/forms-vue', {
      'App.vue': [['v-model="notes"', 'v-model.trim="notes"']],
    }),
    'E_TEMPLATE',
    'App.vue',
    /v-model modifiers/,
  );
  await rejects(
    await edits('fixtures/forms-vue', {
      'App.vue': [['v-model="notes"', 'v-model="notes" @input="other++"']],
    }),
    'E_EVENT',
    'App.vue',
    /separate listeners/,
  );
  await rejects(
    await edits('fixtures/forms-vue', {
      'App.vue': [
        [
          '<input id="name" type="text" :value="name" @input="name = $event.target.value" />',
          '<input id="name" type="number" v-model="name" />',
        ],
      ],
    }),
    'E_TEMPLATE',
    'App.vue',
    /type="number"/,
  );
  // A parent passing a new object re-renders the child in Vue.
  await rejects(
    await edits('examples/todomvc-vue', {
      'TodoItem.vue': [
        [
          '<span :id="`title-${todo.id}`">{{ todo.title }}</span>',
          '<input :id="`edit-${todo.id}`" type="text" :value="todo.title" />',
        ],
      ],
    }),
    'E_TEMPLATE',
    'TodoItem.vue',
    /prop todo/,
  );
  // Template expressions run again in the render effect: no side effects.
  await rejects(
    await edits('fixtures/forms-vue', {
      'App.vue': [
        [
          'const other = ref(0);',
          'const other = ref(0);\nconst seen: string[] = [];\nfunction mark(s: string) {\n  seen.push(s);\n  return s;\n}',
        ],
        [
          '<p id="state">{{ agreed }} {{ name }}</p>',
          '<p id="state">{{ agreed }} {{ mark(name) }}</p>',
        ],
      ],
    }),
    'E_TEMPLATE',
    'App.vue',
    /side effects/,
  );
  // Slot content is patched by the child's render.
  await rejects(
    await edits('fixtures/slots-vue', {
      'App.vue': [
        [
          '<p id="plain-body">Picked {{ picked }}</p></Card>',
          '<p id="plain-body">Picked {{ picked }}</p><input id="slotted" type="text" :value="note" /></Card>',
        ],
      ],
    }),
    'E_TEMPLATE',
    'App.vue',
    /slot/,
  );
});

test('a nullish branch of a template conditional takes the conditional type', async () => {
  const g = await edits('fixtures/styles-vue', {
    'App.vue': [
      [
        '<p id="static" style="color: RED; margin-top: 4px">',
        `<p id="static" :style="{ color: width > 130 ? 'red' : undefined }" :title="width > 130 ? null : 'narrow'">`,
      ],
    ],
  });
  const { ir } = await lower(g);
  const steps = interpret(ir, [{ kind: 'click', id: 'wider' }]);
  assert.deepEqual(
    steps.map(s => [byId(s, 'static').attrs.style, byId(s, 'static').attrs.title]),
    [
      [undefined, 'narrow'],
      ['color: red;', undefined],
    ],
  );
});
