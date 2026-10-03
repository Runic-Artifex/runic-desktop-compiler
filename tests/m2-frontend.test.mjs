// M2: the TypeScript frontend on the shared language layer.
// Each case lowers a small Svelte component, validates it in the Rust
// backend and runs it in the reference interpreter. Expected values were
// checked against the real Svelte runtime where noted in the examples'
// conformance cases; here they follow ECMAScript semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

async function app(script, markup) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/m2-'));
  await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), { recursive: true });
  await writeFile(
    path.join(root, 'style.css'),
    "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
  );
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
  );
  await writeFile(
    path.join(root, 'main.js'),
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
  );
  await writeFile(
    path.join(root, 'runic.json'),
    JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
  );
  await writeFile(
    path.join(root, 'App.svelte'),
    `<script lang="ts">\n${script}\n</script>\n${markup}\n`,
  );
  return root;
}

/** Text of element #out after each action. */
async function run(
  script,
  actions = [{ kind: 'click', id: 'go' }],
  markup = '<button id="go" onclick={go}>go</button><p id="out">{out}</p>',
) {
  const root = await app(script, markup);
  try {
    const { ir } = await lower(await collect(root));
    const steps = interpret(ir, actions);
    const text = node => (typeof node === 'string' ? node : node.children.map(text).join(''));
    const find = (nodes, id) => {
      for (const n of nodes) {
        if (typeof n === 'string') continue;
        if (n.attrs.id === id) return n;
        const f = find(n.children, id);
        if (f) return f;
      }
    };
    return steps.map(s =>
      s.state.dom.error
        ? 'ERROR ' + s.state.dom.error
        : text(find(s.state.dom, 'out') ?? { children: [] }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejects(script, code, markup = '<p>x</p>') {
  const root = await app(script, markup);
  try {
    await assert.rejects(
      collect(root).then(g => lower(g)),
      e => e.code === code || assert.fail(`expected ${code}, got ${e.code}: ${e.message}`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('optional chaining short-circuits and narrows', async () => {
  const out = await run(
    `interface Inner { b: number; label?: string }
     interface Outer { inner?: Inner }
     let o = $state<Outer>({});
     let out = $state('');
     function go() {
       const before = o.inner?.b;
       o = { inner: { b: 2 } };
       const after = o.inner?.b ?? -1;
       out = \`\${before === undefined} \${after} \${o.inner?.label?.toUpperCase() ?? 'none'} \${o.inner?.label?.length}\`;
     }`,
  );
  assert.deepEqual(out, ['', 'true 2 none undefined']);
});

test('closures capture variables by reference', async () => {
  const out = await run(
    `let out = $state('');
     function counter() {
       let n = 0;
       const inc = () => { n += 1; return n; };
       inc(); inc();
       return { inc, read: () => n };
     }
     function go() {
       const c = counter();
       const fns: (() => number)[] = [];
       for (const k of [1, 2, 3]) fns.push(() => k * 10);
       out = \`\${c.inc()} \${c.read()} \${fns.map(f => f()).join(',')}\`;
     }`,
  );
  assert.deepEqual(out, ['', '3 3 10,20,30']);
});

test('switch fallthrough, labelled loops and exceptions', async () => {
  const out = await run(
    `let out = $state('');
     function kind(n: number): string {
       let s = '';
       switch (n) {
         case 1: s += 'one';
         case 2: s += 'two'; break;
         default: s += 'many';
         case 3: s += 'three';
       }
       return s;
     }
     function risky(n: number): number {
       if (n > 2) throw new RangeError('too big: ' + n);
       return n * 2;
     }
     function go() {
       const parts: string[] = [];
       outer: for (let i = 0; i < 4; i++) {
         for (let j = 0; j < 4; j++) {
           if (j === 2) continue outer;
           if (i === 3) break outer;
           parts.push(\`\${i}\${j}\`);
         }
       }
       let caught = '';
       let cleanup = 0;
       for (const n of [1, 5]) {
         try { caught += risky(n); } catch (e) { caught += '!' + e.message; } finally { cleanup++; }
       }
       out = [kind(1), kind(2), kind(3), kind(9), parts.join(' '), caught, String(cleanup)].join('|');
     }`,
  );
  assert.deepEqual(out, ['', 'onetwo|two|three|manythree|00 01 10 11 20 21|2!too big: 5|2']);
});

test('strings, numbers and destructuring', async () => {
  const out = await run(
    `let out = $state('');
     function go() {
       const s = '  Hello, Wörld 😀  ';
       const t = s.trim();
       const [first, second = 'x'] = t.split(', ');
       const { length } = t;
       const n = Number('  42.5 ');
       const parts: string[] = [first.toUpperCase(), second.slice(0, 3), String(length), String(t.indexOf('😀')),
              (n * 2).toFixed(1), String(parseInt('0x1f')), (0.1 + 0.2).toString(), 'ab'.padStart(5, '-'),
              'a-b-c'.replaceAll('-', '+'), \`\${1 / 0} \${-0} \${NaN}\`];
       out = parts.join('|');
     }`,
  );
  assert.deepEqual(out, [
    '',
    'HELLO|Wör|15|13|85.0|31|0.30000000000000004|---ab|a+b+c|Infinity 0 NaN',
  ]);
});

test('arrays, maps, sets, JSON and deep state', async () => {
  const out = await run(
    `interface Item { name: string; qty: number; tags: string[] }
     let items = $state<Item[]>([{ name: 'b', qty: 2, tags: ['x'] }, { name: 'a', qty: 5, tags: [] }]);
     let out = $state('');
     function go() {
       items.push({ name: 'c', qty: 1, tags: ['y', 'z'] });
       items[0].qty += 10;
       const byName = [...items].sort((p, q) => p.name.localeCompare(q.name)).map(i => i.name);
       const counts = new Map<string, number>();
       for (const i of items) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
       const unique = new Set(items.flatMap(i => i.tags));
       const json = JSON.stringify(items[2]);
       const back: Item = JSON.parse(json);
       out = \`\${byName.join('')}|\${items.reduce((s, i) => s + i.qty, 0)}|\${counts.size}|\${unique.has('z')}|\${json}|\${back.tags.length}|\` +
             \`\${items.findIndex(i => i.qty > 10)}|\${items.some(i => i.name === 'q')}\`;
     }`,
    undefined,
    '<button id="go" onclick={go}>go</button><p id="out">{out}</p><p id="count">{items.length}</p>',
  );
  assert.deepEqual(out, ['', 'abc|18|3|true|{"name":"c","qty":1,"tags":["y","z"]}|2|0|false']);
});

test('uncovered constructs are rejected with diagnostics', async () => {
  await rejects(`let x: any = $state(1);`, 'E_TYPE_UNSUPPORTED');
  await rejects(`let c = $state(0); $effect.root(() => { c; });`, 'E_STATEMENT');
  await rejects(`let xs = $state([1]);`, 'E_TEMPLATE', '{@html "<b>x</b>"}');
  await rejects(`let r = $state(/a/);`, 'E_TYPE_UNSUPPORTED');
  await rejects(`import { tick } from 'svelte';`, 'E_CAPABILITY');
});
