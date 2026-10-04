// M6 stage A: plain JavaScript/TypeScript classes in the shared language
// layer (frontend/classes.ts). Each case lowers a small Svelte app with
// local modules, validates it in the Rust backend and runs it in the
// reference interpreter; expected values follow ECMAScript semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { check, interpret } from '../compiler/codegen.mjs';

async function app(script, markup, files) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/classes-'));
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
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text);
  return root;
}

const MARKUP = '<button id="go" onclick={go}>go</button><p id="out">{out}</p>';

async function lowered(script, files = {}, markup = MARKUP) {
  const root = await app(script, markup, files);
  try {
    return (await lower(await collect(root))).ir;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Text of element #out after each action. */
async function run(script, files = {}, actions = [{ kind: 'click', id: 'go' }], markup = MARKUP) {
  const ir = await lowered(script, files, markup);
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
}

/** Lowering fails with `code` at `file:line:column`. */
async function rejects(script, code, at, files = {}, markup = MARKUP) {
  const root = await app(script, markup, files);
  try {
    await assert.rejects(
      collect(root).then(g => lower(g)),
      e => {
        assert.equal(e.code, code, e.message);
        if (at)
          assert.equal(`${e.source?.file}:${e.source?.line}:${e.source?.column}`, at, e.message);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const COUNTER = `export class Counter {
  count = 0;
  #step: number;
  label: string;
  constructor(step: number, readonly name: string) {
    this.#step = step;
    this.label = name + '!';
    this.click = this.click.bind(this);
  }
  get double(): number { return this.count * 2; }
  get value(): number { return this.count; }
  set value(v: number) { this.count = v; }
  click(): void { this.count += this.#step; }
  #twice(): void { this.click(); this.click(); }
  twice(): number { this.#twice(); return this.count; }
  static zero(): Counter { return new Counter(1, 'zero'); }
  static LIMIT = 10;
}
`;

test('classes: fields, #private members, accessors, statics, bound methods and instanceof', async () => {
  const out = await run(
    `import { Counter } from './counter';
     let out = $state('');
     function go() {
       const c = new Counter(2, 'c');
       const z = Counter.zero();
       const f = c.click;
       f(); f();
       c.value = 7;
       c.value += 1;
       z.click();
       out = \`\${c.count} \${c.double} \${c.twice()} \${c.label} \${c.name} \${z.count} \${Counter.LIMIT} \${c instanceof Counter} \${f === c.click}\`;
     }`,
    { 'counter.ts': COUNTER },
  );
  assert.deepEqual(out, ['', '8 16 12 c! c 1 10 true true']);
});

test('classes are nominal records with methods as functions taking the instance', async () => {
  const ir = await lowered(
    `import { Counter } from './counter';
     let out = $state('');
     function go() {
       const c = new Counter(2, 'c');
       const plain = { count: 1 };
       out = \`\${c.count} \${plain.count}\`;
     }`,
    { 'counter.ts': COUNTER },
  );
  const r = ir.records.findIndex(r => r.name === 'Counter');
  assert.equal(ir.records[r].class, true);
  // Parameter properties, declared fields, then fields the constructor creates.
  assert.deepEqual(
    ir.records[r].fields.map(f => f.name),
    ['name', 'count', '#step', 'label', 'click'],
  );
  // A plain object of the same shape is another record.
  assert.ok(ir.records.some((x, i) => i !== r && !x.class));
  const method = ir.functions.find(f => f?.name === 'Counter.twice');
  assert.deepEqual(method.params[0], { name: 'this', type: { record: r } });
  const ctor = ir.functions.find(f => f?.name === 'Counter.constructor');
  assert.deepEqual(ctor.result, { record: r });
  // The backend rejects plain-data built-ins on class instances.
  const keys = structuredClone(ir);
  keys.functions.push({
    name: 'keys',
    params: [{ name: 'c', type: { record: r } }],
    locals: [],
    result: { array: 'string' },
    body: [
      {
        op: 'return',
        value: {
          op: 'builtin',
          name: 'Object.keys',
          args: [{ op: 'local', local: 0 }],
          type: { array: 'string' },
        },
      },
    ],
  });
  assert.throws(() => check(keys), /class instances are not plain data/);
});

test('classes: arrow function fields, early field reads, callbacks and component-script classes', async () => {
  const out = await run(
    `let out = $state('');
     let seen = $state(0);
     class Stack {
       items: number[] = [];
       size = this.items.length;
       onPush: (n: number) => void;
       push = (n: number) => { this.items.push(n); this.size = this.items.length; this.onPush(n); };
       constructor(onPush: (n: number) => void) {
         this.onPush = onPush;
       }
       get top(): number | undefined { return this.items.at(-1); }
       each(f: (n: number) => void) { this.items.forEach(x => f(x * this.size)); }
     }
     const s = new Stack(n => { seen = n; });
     function go() {
       const p = s.push;
       p(3); p(4); s.push(5);
       let acc = '';
       s.each(v => { acc += v + ','; });
       out = \`\${s.size} \${s.top} \${seen} \${acc}\`;
     }`,
  );
  assert.deepEqual(out, ['', '3 5 5 9,12,15,']);
});

test('classes: optional chaining, bind of function values and closures over this in methods', async () => {
  const out = await run(
    `class Node {
       value: number;
       next: Node | null = null;
       constructor(value: number) { this.value = value; }
       get last(): Node { return this.next?.last ?? this; }
       append(v: number): Node { this.last.next = new Node(v); return this; }
       counter(): () => number { let n = 0; return () => { n += this.value; return n; }; }
       shout = (s: string): string => s.toUpperCase() + this.value;
     }
     let out = $state('');
     function go() {
       const list = new Node(1).append(2).append(3);
       const maybe: Node | undefined = list.next ?? undefined;
       const tick = list.counter();
       tick();
       const shout = list.shout.bind(list);
       out = \`\${list.last.value} \${maybe?.value} \${maybe?.next?.next?.value} \${tick()} \${shout('a')} \${shout === list.shout}\`;
     }`,
  );
  assert.deepEqual(out, ['', '3 2 undefined 2 A1 false']);
});

test('classes in JavaScript: JSDoc-typed and untyped methods specialised per call', async () => {
  const out = await run(
    `import { Tally } from './tally.js';
     let out = $state('');
     function go() {
       const t = new Tally(3);
       t.add(2);
       t.add(5);
       t.scale(2);
       out = \`\${t.total} \${t.count} \${t.mean()}\`;
     }`,
    {
      'tally.js': `export class Tally {
  /** @param {number} start */
  constructor(start) {
    this.total = start;
    this.count = 1;
  }
  /** @param {number} n */
  add(n) { this.total += n; this.count++; }
  scale(k) { this.total = this.total * k; }
  mean() { return this.total / this.count; }
}
`,
    },
  );
  assert.deepEqual(out, ['', '20 3 6.666666666666667']);
});

test('Svelte state holds class instances as they are (not proxied)', async () => {
  const out = await run(
    `class Point {
       x: number;
       y: number;
       constructor(x: number, y: number) { this.x = x; this.y = y; }
       get norm(): number { return Math.abs(this.x) + Math.abs(this.y); }
       moved(dx: number): Point { return new Point(this.x + dx, this.y); }
     }
     const raw = new Point(1, 2);
     let p = $state(raw);
     let out = $derived(\`\${p.x},\${p.y} \${p.norm} \${p === raw}\`);
     function go() { p = p.moved(2); }`,
  );
  assert.deepEqual(out, ['1,2 3 true', '3,2 5 false']);
});

test('classes: unsupported forms are rejected where they are written', async () => {
  const at = (line, column) => `App.svelte:${line}:${column}`;
  const go = `let out = $state(''); function go() { out = ''; }`;
  await rejects(`class A { x = 1 }\nclass B extends A { y = 2 }\n${go}`, 'E_CLASS', at(3, 9));
  await rejects(
    `class A { n = 1; m(): number { return this.n; } }\nlet out = $state('');\nfunction go() { const a = new A(); const f = a.m; out = String(f()); }`,
    'E_CLASS',
    at(4, 46),
  );
  await rejects(`class A {\n  n = $state(0);\n}\n${go}`, 'E_CLASS', at(3, 3));
  await rejects(
    `class A {\n  n = 1;\n  m(): number { return this.n; }\n  k = this.m();\n}\n${go}`,
    'E_CLASS',
    at(5, 7),
  );
  await rejects(
    `class A {\n  k = 2;\n  xs = [1, 2].map(x => x * this.k);\n}\n${go}`,
    'E_CLASS',
    at(4, 28),
  );
  await rejects(
    `class A { n = 1; }\nlet out = $state('');\nfunction go() { out = JSON.stringify(new A()); }`,
    'E_CLASS',
    at(4, 23),
  );
  await rejects(
    `class A { n = 1; }\nlet out = $state('');\nfunction go() { const o = { ...new A() }; out = String(o.n); }`,
    'E_CLASS',
    at(4, 29),
  );
  await rejects(
    `class A { n = 1; }\nlet out = $state('');\nfunction go() { const a: A = { n: 2 }; out = String(a.n); }`,
    'E_CLASS',
    at(4, 30),
  );
  await rejects(
    `class A { n = 1; toString() { return 'A'; } }\nlet out = $state('');\nfunction go() { out = \`\${new A()}\`; }`,
    'E_CLASS',
  );
  await rejects(
    `class A { get n(): number { return 1; } }\nlet out = $state('');\nfunction go() { const a = new A(); a.n = 2; }`,
    'E_CLASS',
    at(4, 36),
  );
  await rejects(`class A {\n  static n = 1;\n}\n${go}`, 'E_CLASS', at(3, 3));
  await rejects(
    `let out = $state('');\nconst a = new A();\nclass A { n = 1; }\nfunction go() { out = String(a.n); }`,
    'E_CLASS',
    at(3, 11),
  );
  await rejects(
    `class A {\n  n: number;\n  m: number;\n  constructor() { this.m = this.helper(); this.n = 1; }\n  helper(): number { return 2; }\n}\n${go}`,
    'E_CLASS',
    at(3, 3),
  );
  await rejects(
    `class A {\n  n = 1;\n  m(): () => number { return function () { return this.n; }; }\n}\n${go}`,
    'E_CLASS',
    at(4, 51),
  );
  await rejects(
    `class A { n = 1; }\nlet out = $state('');\nfunction go() { try { throw new A(); } catch (e) { out = String(e instanceof A); } }`,
    'E_CLASS',
  );
  await rejects(
    `let out = $state('');\nfunction go() { class A { n = 1; } out = String(new A().n); }`,
    'E_CLASS',
    at(3, 17),
  );
  await rejects(
    `class A { n = 1; m(k: number): number { return this.n + k; } }\nlet out = $state('');\nfunction go() { const a = new A(); const f = a.m.bind(a, 1); out = String(f()); }`,
    'E_CLASS',
    at(4, 46),
  );
  // A class instance in Svelte state that is mutated in place: not reactive.
  await rejects(
    `class A { n = 1; inc() { this.n++; } }\nlet a = $state(new A());\nfunction go() { a.inc(); }`,
    'E_REACTIVITY',
    undefined,
    {},
    '<button id="go" onclick={go}>go</button><p id="out">{a.n}</p>',
  );
  // Modules: generic classes and static field writes.
  await rejects(`import { Box } from './box';\n${go}`, 'E_CLASS', 'box.ts:1:18', {
    'box.ts': 'export class Box<T> { v: T; constructor(v: T) { this.v = v; } }\n',
  });
  await rejects(
    `import { touch } from './box';\nlet out = $state('');\nfunction go() { touch(); }`,
    'E_CLASS',
    'box.ts:1:20',
    { 'box.ts': 'export class Box { static n = 1; }\nexport function touch() { Box.n = 2; }\n' },
  );
});
