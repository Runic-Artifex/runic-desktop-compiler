// Script DOM (M6, docs/design/M6-SCRIPT-DOM.md), slice 1: the document and
// the window as values (nullable documents), nodes script creates and their
// ownership next to the nodes the framework renders, text and attribute
// writes, and the body's content before the container. The interpreter runs
// each program; the native runtime is checked against Chromium by the
// conformance case `script-dom-announcer`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/script-dom-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root') });\n",
      'runic.json': JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
      ...files,
    };
    for (const [file, text] of Object.entries(all)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lowered = root => collect(root).then(g => lower(g));
const failWith = (code, pattern) => e =>
  (e instanceof Diagnostic && e.code === code && (!pattern || pattern.test(e.message))) ||
  assert.fail(`expected ${code}, got ${e.code}: ${e.message}`);
const builtins = ir => {
  const names = new Set();
  const walk = x => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      if (x.op === 'builtin') names.add(x.name);
      Object.values(x).forEach(walk);
    }
  };
  walk(ir);
  return names;
};
const byId = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n !== 'object') continue;
    if (n.attrs?.id === id) return n;
    const found = byId(n.children ?? [], id);
    if (found) return found;
  }
  return undefined;
};
const text = n => (typeof n === 'string' ? n : (n.children ?? []).map(text).join(''));

test('a document that may be null is a value; script nodes go before the container', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  function region(doc: Document | null): HTMLElement | null {
    if (!doc) return null;
    const found = doc.querySelector('[data-region]');
    if (found) return found;
    const div = doc.createElement('DIV');
    div.setAttribute('data-region', '');
    div.role = 'log';
    div.ariaLive = 'polite';
    div.ariaLabel = null;
    div.style.cssText = 'color: red;  width: 1px';
    doc.body.insertBefore(div, doc.body.firstChild);
    return div;
  }
  let out = $state('');
  region(null);
  function run() {
    const a = region(document);
    const b = region(document);
    if (a && b) {
      const line = document.createElement('p');
      line.innerText = 'one\\ntwo';
      a.appendChild(line);
      out = (a === b) + ':' + a.textContent + ':' + a.childElementCount;
    }
  }
</script>
<button id="b" onclick={run}>run</button><p id="out">{out}</p>`,
    },
    async root => {
      const { ir } = await lowered(root);
      const used = builtins(ir);
      for (const b of [
        'document.node',
        'document.createElement',
        'element.insertBefore',
        'element.firstChild',
        'element.style-set-text',
        'element.set-innerText',
        'element.removeAttribute',
      ])
        assert.ok(used.has(b), b);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(steps[0].state.preceding, undefined);
      const after = steps[1].state;
      assert.equal(text(byId(after.dom, 'out')), 'true:onetwo:1');
      assert.deepEqual(after.preceding, [
        {
          tag: 'div',
          attrs: {
            'aria-live': 'polite',
            'data-region': '',
            role: 'log',
            style: 'color: red; width: 1px;',
          },
          children: [
            {
              tag: 'p',
              attrs: {},
              children: ['one', { tag: 'br', attrs: {}, children: [] }, 'two'],
            },
          ],
        },
      ]);
    },
  );
});

test('script owns the children of an element the template renders without children', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let host = $state<HTMLElement | null>(null);
  let n = 0;
  function add() {
    if (!host) return;
    const p = document.createElement('p');
    p.className = 'line';
    n += 1;
    p.id = 'l' + n;
    p.textContent = 'line ' + n;
    host.insertBefore(p, host.firstChild);
  }
  function clear() { host?.replaceChildren(); }
  function drop() { host?.firstChild?.remove(); }
</script>
<button id="add" onclick={add}>add</button><button id="clear" onclick={clear}>clear</button>
<button id="drop" onclick={drop}>drop</button><div id="host" bind:this={host}></div>`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'add' },
        { kind: 'click', id: 'add' },
        { kind: 'click', id: 'drop' },
        { kind: 'click', id: 'add' },
        { kind: 'click', id: 'clear' },
      ]);
      const lines = s => (byId(s.state.dom, 'host').children ?? []).map(c => c.attrs.id);
      assert.deepEqual(steps.map(lines), [[], ['l1'], ['l2', 'l1'], ['l1'], ['l3', 'l1'], []]);
      assert.equal(byId(steps[2].state.dom, 'l2').attrs.class, 'line');
    },
  );
});

// Slice 2: text, comment and fragment nodes, traversal, insertions,
// cloning, classList and dataset.
test('fragments, text and comment nodes, traversal and ChildNode insertions', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let host = $state<HTMLElement | null>(null);
  let out = $state('');
  function run() {
    if (!host) return;
    const f = document.createDocumentFragment();
    const c = document.createComment('c');
    f.append('a', c, document.createTextNode('b'));
    host.append(f);
    c.after('x');
    c.before(document.createElement('i'));
    host.lastChild?.replaceWith('z');
    const kinds = Array.from(host.childNodes).map(n => n.nodeType).join(',');
    out = kinds + ' ' + f.childNodes.length + ' ' + host.textContent + ' ' + (c instanceof Text) + (c instanceof Comment) + ' ' + host.children.length;
  }
</script>
<button id="b" onclick={run}>run</button><p id="out">{out}</p><div id="host" bind:this={host}></div>`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(text(byId(steps[1].state.dom, 'out')), '3,1,8,3,3 0 axz falsetrue 1');
      // (The comment is left out of the snapshot.)
      assert.deepEqual(byId(steps[1].state.dom, 'host').children, [
        'a',
        { tag: 'i', attrs: {}, children: [] },
        'xz',
      ]);
    },
  );
});

test('classList and dataset on script and rendered elements, cloneNode', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let host = $state<HTMLElement | null>(null);
  let tpl = $state<HTMLElement | null>(null);
  let out = $state('');
  function run() {
    if (!host || !tpl) return;
    const s = document.createElement('span');
    s.className = ' a  b ';
    s.classList.add('c');
    const t = s.classList.toggle('a');
    s.dataset.someKey = 'v';
    tpl.classList.add('on');
    const copy = tpl.cloneNode(true);
    host.append(s, copy);
    out = s.className + ' ' + t + ' ' + s.getAttribute('data-some-key') + ' ' + tpl.classList.contains('on');
  }
</script>
<button id="b" onclick={run}>run</button><p id="out">{out}</p>
<p id="tpl" data-k="1" bind:this={tpl}>t<b>b</b></p><div id="host" bind:this={host}></div>`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(text(byId(steps[1].state.dom, 'out')), 'b c false v true');
      assert.equal(byId(steps[1].state.dom, 'tpl').attrs.class, 'on');
      const kids = byId(steps[1].state.dom, 'host').children;
      assert.deepEqual(kids[1], {
        tag: 'p',
        attrs: { class: 'on', 'data-k': '1', id: 'tpl' },
        children: ['t', { tag: 'b', attrs: {}, children: ['b'] }],
      });
    },
  );
});

test('live lists are read where used', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let host = $state<HTMLElement | null>(null);
  function run() {
    if (!host) return;
    const list = host.childNodes;
    host.append('x');
    host.textContent = String(list.length);
  }
</script>
<button onclick={run}>run</button><div bind:this={host}></div>`,
    },
    async root => assert.rejects(lowered(root), failWith('E_MEMBER', /live list/)),
  );
});

test("script changing the framework's child lists needs the native DOM", async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let box = $state<HTMLElement | null>(null);
  function run() { box?.appendChild(document.createElement('span')); }
</script>
<button id="b" onclick={run}>run</button><div bind:this={box}><p>framework</p></div>`,
    },
    async root => {
      const { ir } = await lowered(root);
      // (The runtime reports it unsupported; the interpreter has no DOM for it.)
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.match(JSON.stringify(steps.at(-1)), /RunicLayoutError|native DOM/);
    },
  );
});

test('createElement takes a literal tag of the static elements', async () => {
  for (const [tag, ok] of [
    ["'section'", true],
    ["'input'", false],
    ["'img'", false],
    ['name', false],
  ])
    await withApp(
      {
        'App.svelte': `<script lang="ts">
  let name = $state('div');
  function run() { document.createElement(${tag}); }
</script>
<button onclick={run}>run</button>`,
      },
      async root =>
        ok
          ? assert.ok(builtins((await lowered(root)).ir).has('document.createElement'))
          : assert.rejects(lowered(root), failWith('E_CALL', /createElement takes a literal tag/)),
    );
});

test('innerText is written, not read', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let el = $state<HTMLElement | null>(null);
  let out = $state('');
  function run() { if (el) out = el.innerText; }
</script>
<button onclick={run}>run</button><p bind:this={el}>{out}</p>`,
    },
    async root => assert.rejects(lowered(root), failWith('E_MEMBER', /Reading innerText/)),
  );
});
