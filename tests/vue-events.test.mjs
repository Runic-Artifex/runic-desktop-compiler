// Vue events (M5): handler forms, compiler-dom's event modifiers, window and
// document listeners, and rejections. Behaviour against Vue in Chromium is
// checked by the conformance cases events-vue and shortcuts; these tests pin
// the adapter's decisions through the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** The IR of a Vue app: App.vue from `script` and `template`, plus `files`. */
async function vue(script, template, files = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/vue-events-'));
  try {
    await writeFile(path.join(root, 'style.css'), 'p { margin: 0; }\n');
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
    );
    await writeFile(
      path.join(root, 'main.js'),
      "import { createApp } from 'vue';\nimport App from './App.vue';\nimport './style.css';\ncreateApp(App).mount('#root');\n",
    );
    await writeFile(
      path.join(root, 'runic.json'),
      JSON.stringify({ framework: 'vue', entry: 'main.js', title: 'T' }),
    );
    await writeFile(
      path.join(root, 'App.vue'),
      `<script setup lang="ts">\n${script}\n</script>\n<template>\n${template}\n</template>\n`,
    );
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text);
    return (await lower(await collect(root))).ir;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A collected fixture with `from` replaced by `to` in `file`. */
async function edit(name, file, from, to) {
  const g = await collect('fixtures/' + name);
  const id = path.join(g.root, file);
  const m = g.modules.get(id);
  assert.ok(m.code.includes(from), `Replacement must match in ${name}: ${from}`);
  const code = m.code.replace(from, to);
  const modules = new Map(g.modules);
  modules.set(id, { ...m, code });
  return { ...g, modules, hash: hash(code) };
}

const failWith = (code, file) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    e.source.column > 0) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
/** The text of element `id` after each step. */
const textsOf = (steps, id) =>
  steps.map(s => {
    const n = flat(s.state.dom).find(x => x.attrs.id === id);
    return n ? textOf(n) : undefined;
  });
/** What each step appended to the text of `id`. */
const appended = (steps, id) => {
  const t = textsOf(steps, id);
  return t.slice(1).map((x, i) => x.slice(t[i].length).trim());
};

const LOG = 'const log = ref<string[]>([]);\nfunction add(s: string) {\n  log.value.push(s);\n}';

test('Vue modifiers resolve as compiler-dom does', async () => {
  const { resolveModifiers, listenedEvent } = await import('../frontend/adapters/vue.ts');
  // left/right are arrow keys on keyboard events and mouse buttons elsewhere;
  // unknown modifiers are key names (also .native outside compat builds).
  assert.deepEqual(resolveModifiers('keydown', ['left', 'ctrl', 'enter', 'once']), {
    keys: ['left', 'enter'],
    guards: ['ctrl'],
    options: ['once'],
  });
  assert.deepEqual(resolveModifiers('click', ['left', 'right', 'middle', 'enter', 'native']), {
    keys: ['enter', 'native'],
    guards: ['left', 'right', 'middle'],
    options: [],
  });
  assert.equal(listenedEvent('click', ['right']), 'contextmenu');
  assert.equal(listenedEvent('click', ['middle', 'stop']), 'mouseup');
  assert.equal(listenedEvent('click', ['right', 'middle']), 'contextmenu');
  assert.equal(listenedEvent('mousedown', ['right']), 'mousedown');
  assert.equal(listenedEvent('keyup', ['right']), 'keyup');
});

test('Vue event fixtures agree with Svelte in the interpreter', async () => {
  const events = [
    { kind: 'click', id: 'inner' },
    { kind: 'click', id: 'stop' },
    { kind: 'click', id: 'inner' },
    { kind: 'click', id: 'outer' },
    { kind: 'click', id: 'agree' },
    { kind: 'click', id: 'lock' },
    { kind: 'click', id: 'agree' },
    { kind: 'keydown', id: 'field', key: 'a' },
    { kind: 'keydown', id: 'field', key: 'x' },
    { kind: 'keydown', id: 'field', key: 'Shift+ArrowLeft' },
    { kind: 'click', id: 'keep' },
    { kind: 'hover', id: 'box' },
    { kind: 'hover', id: 'log' },
    { kind: 'dblclick', id: 'box' },
    { kind: 'contextmenu', id: 'box' },
    { kind: 'wheel', id: 'box', deltaX: 0, deltaY: 100 },
    { kind: 'click', id: 'late' },
    { kind: 'wait', ms: 10 },
    { kind: 'keydown', id: 'enter', key: 'Enter' },
    { kind: 'keydown', id: 'enter', key: 'Space' },
  ];
  const shortcuts = [
    { kind: 'click', id: 'open' },
    { kind: 'click', id: 'panel' },
    { kind: 'click', id: 'field' },
    { kind: 'keydown', id: 'field', key: 'a' },
    { kind: 'keydown', id: 'field', key: 'q' },
    { kind: 'keydown', id: 'field', key: 'Control+k' },
    { kind: 'click', id: 'open' },
    { kind: 'keydown', id: 'open', key: 'Escape' },
    { kind: 'click', id: 'open-late' },
    { kind: 'click', id: 'open' },
    { kind: 'click', id: 'state' },
  ];
  for (const [name, actions, ids] of [
    ['events', events, ['state', 'log', 'box', 'stop', 'lock']],
    ['shortcuts', shortcuts, ['state', 'log']],
  ]) {
    const v = interpret((await lower(await collect(`fixtures/${name}-vue`))).ir, actions);
    const s = interpret((await lower(await collect(`fixtures/${name}-svelte`))).ir, actions);
    for (const id of ids) assert.deepEqual(textsOf(v, id), textsOf(s, id), `${name} #${id}`);
    if (name === 'shortcuts')
      // The click opening the panel late is closed by the listener its watcher added.
      assert.deepEqual(appended(v, 'log').slice(8), [
        'open-late document outside',
        'open',
        'document outside',
      ]);
  }
});

test('Vue handlers take the event as a value in every form', async () => {
  const ir = await vue(
    `import { ref } from 'vue';\n${LOG}\nfunction typed(e: MouseEvent) {\n  add('typed:' + e.button);\n}\n// @ts-ignore untyped parameter\nfunction untyped(e) {\n  add('untyped:' + e.type);\n}\nfunction none() {\n  add('none');\n}`,
    `<main><button id="a" @click="add($event.type)">A</button><button id="b" @click="typed">B</button><button id="c" @click="(e: MouseEvent) => add('arrow:' + e.type)">C</button><button id="d" @click="(e) => add('self:' + (e.target === e.currentTarget))">D</button><button id="e" @click="untyped">E</button><button id="f" @click="none">F</button><input id="g" type="text" aria-label="G" @input="add('value:' + $event.target.value)" /><p id="log">{{ log.join(' ') }}</p></main>`,
  );
  const steps = interpret(ir, [
    ...['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ kind: 'click', id })),
    { kind: 'input', id: 'g', value: 'hi' },
  ]);
  assert.deepEqual(appended(steps, 'log'), [
    'click',
    'typed:0',
    'arrow:click',
    'self:true',
    'untyped:click',
    'none',
    'value:hi',
  ]);
});

test('Optional chaining on a never-nullish value cast to a nullable type', async () => {
  // e.target is an element during the dispatch; the cast only widens its type.
  const ir = await vue(
    `import { ref } from 'vue';\n${LOG}\nfunction key(e: KeyboardEvent) {\n  if (e.key === 'Enter') (e.target as HTMLInputElement | null)?.blur();\n}`,
    `<main><input id="a" type="text" aria-label="A" @keydown="key" @blur="add('blur')" /><p id="log">{{ log.join(' ') }}</p></main>`,
  );
  const steps = interpret(ir, [
    { kind: 'keydown', id: 'a', key: 'x' },
    { kind: 'keydown', id: 'a', key: 'Enter' },
  ]);
  assert.deepEqual(appended(steps, 'log'), ['', 'blur']);
});

test('Vue modifier guards follow withModifiers and withKeys', async () => {
  const ir = await vue(
    `import { ref } from 'vue';\n${LOG}`,
    `<main @click="add('main')"><input id="keys" type="text" aria-label="Keys" @keydown.ctrl="add('ctrl:' + $event.key)" @keydown.exact="add('exact:' + $event.key)" @keydown.ctrl.k.prevent="add('ctrl-k')" @keydown.page-down="add('page-down')" @keydown.PageDown="add('never')" @keydown.left="add('arrow-left')" @keydown.delete="add('delete')" @keydown.middle="add('middle-key')" @keyup.space="add('space-up')" /><input id="text" type="text" aria-label="Text" @input.ctrl="add('input-ctrl')" @input.exact.right.enter="add('input')" /><button id="btn" @click.left="add('left')" @click.right="add('right')" @click.middle="add('middle')" @click.enter="add('enter')" @contextmenu="add('menu:' + $event.button)">Button</button><div id="pane" @click.self.stop="add('self-stop')"><span id="child">Child</span></div><div id="pane2" @click.stop.self="add('stop-self')"><span id="child2">Child2</span></div><p id="log">{{ log.join(' ') }}</p></main>`,
  );
  // Facts checked against Vue 3.5.43 in Chromium 153 (see the report of the events step).
  const steps = interpret(ir, [
    { kind: 'keydown', id: 'keys', key: 'a' },
    { kind: 'keydown', id: 'keys', key: 'Control+k' },
    { kind: 'keydown', id: 'keys', key: 'PageDown' },
    { kind: 'keydown', id: 'keys', key: 'ArrowLeft' },
    { kind: 'keydown', id: 'keys', key: 'Backspace' },
    { kind: 'keydown', id: 'keys', key: 'Space' },
    { kind: 'input', id: 'text', value: 'x' },
    { kind: 'click', id: 'btn' },
    { kind: 'contextmenu', id: 'btn' },
    { kind: 'click', id: 'child' },
    { kind: 'click', id: 'pane' },
    { kind: 'click', id: 'child2' },
    { kind: 'click', id: 'pane2' },
  ]);
  assert.deepEqual(appended(steps, 'log'), [
    'exact:a middle-key',
    'ctrl:Control middle-key ctrl:k ctrl-k middle-key',
    'exact:PageDown page-down middle-key',
    'exact:ArrowLeft arrow-left middle-key',
    'exact:Backspace delete middle-key',
    'exact:  middle-key space-up',
    'input',
    'left enter main',
    'right menu:2',
    'main',
    'self-stop',
    '',
    'stop-self',
  ]);
  // @click.right listens to contextmenu, @click.middle to mouseup.
  const elements = nodes => nodes.flatMap(n => [n, ...elements(n.children ?? [])]);
  const button = elements(ir.components[ir.root].template).find(n =>
    n.attrs?.some(a => a.name === 'id' && a.value.value === 'btn'),
  );
  assert.deepEqual(
    button.listeners.map(l => l.event),
    ['click', 'contextmenu', 'mouseup'],
  );
});

test('Vue window listeners follow onMounted and onUnmounted', async () => {
  const child = `<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
const props = defineProps<{ note: (s: string) => void }>();
function onKey(e: KeyboardEvent) {
  props.note('child:' + e.key);
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>
<template><p id="child">Child</p></template>
`;
  const ir = await vue(
    `import { ref } from 'vue';\nimport Child from './Child.vue';\n${LOG}\nconst show = ref(true);`,
    `<main><Child v-if="show" :note="add" /><button id="toggle" @click="show = !show">Toggle</button><input id="k" type="text" aria-label="K" /><p id="log">{{ log.join(' ') }}</p></main>`,
    { 'Child.vue': child },
  );
  const steps = interpret(ir, [
    { kind: 'keydown', id: 'k', key: 'a' },
    { kind: 'click', id: 'toggle' },
    { kind: 'keydown', id: 'k', key: 'b' },
    { kind: 'click', id: 'toggle' },
    { kind: 'keydown', id: 'k', key: 'c' },
  ]);
  assert.deepEqual(appended(steps, 'log'), ['child:a', '', '', '', 'child:c']);
});

test('Vue rejects uncovered event behaviour with locations', async () => {
  const script = `import { ref } from 'vue';\n${LOG}\nfunction stopAll(e: MouseEvent) {\n  e.stopImmediatePropagation();\n}\nfunction count(n: number) {\n  add('n' + n);\n}`;
  const cases = [
    ['<button id="b" @click.once="add(\'x\')">B</button>', 'E_EVENT'],
    ['<button id="b" @click.capture="add(\'x\')">B</button>', 'E_EVENT'],
    ['<div id="b" @wheel.passive="add(\'x\')">B</div>', 'E_EVENT'],
    ['<button id="b" @scroll="add(\'x\')">B</button>', 'E_EVENT'],
    ['<button id="b" @[log[0]]="add(\'x\')">B</button>', 'E_EVENT'],
    ['<button id="b" v-on="{ click: stopAll }">B</button>', 'E_EVENT'],
    ['<button id="b" @click="count">B</button>', 'E_EVENT'],
    // Vue's invoker skips later listeners of the element after stopImmediatePropagation.
    ['<button id="b" @click="stopAll" @click.left="add(\'x\')">B</button>', 'E_EVENT'],
    [
      '<button id="b" @click="(e) => e.stopImmediatePropagation()" @click.left="add(\'x\')">B</button>',
      'E_EVENT',
    ],
    // Templates resolve other globals on the instance, where they are undefined.
    ['<button id="b" @click="setTimeout(() => add(\'x\'), 0)">B</button>', 'E_TEMPLATE'],
    [
      '<button id="b" @click="window.addEventListener(\'click\', stopAll)">B</button>',
      'E_TEMPLATE',
    ],
    ['<p id="b">{{ localStorage.getItem("k") }}</p>', 'E_TEMPLATE'],
  ];
  for (const [markup, code] of cases)
    await assert.rejects(
      vue(script, `<main>${markup}<p id="log">{{ log.join(' ') }}</p></main>`),
      failWith(code, 'App.vue'),
      markup,
    );
  // The last listener may stop immediate propagation; allowed globals work.
  const ir = await vue(
    script,
    `<main><button id="b" @click.left="add('first')" @click="stopAll">B</button><p id="log">{{ log.join(' ') }}</p><p id="max">{{ Math.max(1, 2) }}</p></main>`,
  );
  assert.deepEqual(appended(interpret(ir, [{ kind: 'click', id: 'b' }]), 'log'), ['first']);
  // Modifiers on component listeners apply to the emitted arguments in Vue.
  await assert.rejects(
    lower(await edit('components-vue', 'App.vue', '@remove="remove"', '@remove.stop="remove"')),
    failWith('E_TEMPLATE', 'App.vue'),
  );
});
