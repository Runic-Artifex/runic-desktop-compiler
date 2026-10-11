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
  // Library base classes (mapping packs will provide them).
  await rejects(`class A extends Error { x = 1 }\n${go}`, 'E_CLASS', at(2, 17));
  await rejects(
    `class A { n = 1; m(): number { return this.n; } }\nlet out = $state('');\nfunction go() { const a = new A(); const f = a.m; out = String(f()); }`,
    'E_CLASS',
    at(4, 46),
  );
  // Runes outside the files Svelte compiles them in (stage B accepts them in components and .svelte.ts modules).
  await rejects(`import { A } from './a';\n${go}`, 'E_CLASS', 'a.ts:1:22', {
    'a.ts': 'export class A { n = $state(0); }\n',
  });
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
    `class A {\n  n: number;\n  m: number;\n  constructor() { this.m = this.helper(); this.n = 1; }\n  helper(): number { return 2; }\n}\nlet out = $state(''); function go() { out = String(new A().n); }`,
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
  // Modules: a generic class the program never instantiates with type
  // arguments (tests/generic-classes.test.mjs) and static field writes
  // through a subclass (which would give it a field of its own).
  await rejects(`import { Box } from './box';\n${go}`, 'E_CLASS', 'box.ts:1:14', {
    'box.ts': 'export class Box<T> { v: T; constructor(v: T) { this.v = v; } }\n',
  });
  await rejects(
    `import { touch } from './box';\nlet out = $state('');\nfunction go() { touch(); }`,
    'E_CLASS',
    'box.ts:3:27',
    {
      'box.ts':
        'export class Box { static n = 1; }\nexport class Sub extends Box {}\nexport function touch() { Sub.n = 2; }\n',
    },
  );
});

// M6 stage B: reactive class fields ($state, $state.raw, $derived and
// $derived.by). Expected console lines and values were checked against
// Svelte 5.57.1 (its client runtime running the same classes); the
// browser comparison is the `reactive-classes` conformance case.

/** Console lines of each step. */
async function logs(script, files = {}, actions = [{ kind: 'click', id: 'go' }], markup = MARKUP) {
  const ir = await lowered(script, files, markup);
  return interpret(ir, actions).map(s => (s.state.host?.console ?? []).map(l => l.text));
}

const clicks = (...ids) => ids.map(id => ({ kind: 'click', id }));
const buttons = ids =>
  ids.map(id => `<button id="${id}" onclick={${id}}>${id}</button>`).join('') +
  '<p id="out">{out}</p>';

const BOX = `export class Box {
  n = $state(0);
  nan = $state(NaN);
  obj = $state({ a: 1 });
  raw = $state.raw({ a: 1 });
  #hidden = $state(1);
  double = $derived(this.n * 2);
  parity = $derived.by(() => this.n % 2);
  later: number;
  sum = $derived(this.later + this.#hidden);
  constructor() {
    this.later = $state(10);
  }
  get hidden(): number { return this.#hidden; }
  bumpHidden(): void { this.#hidden += 1; }
}
export class Made {
  v = $state(1);
  seen = 0;
  constructor() {
    this.seen = this.read();
  }
  read(): number { return this.v; }
}
`;

test('reactive class fields lower to marked record fields and functions of the instance', async () => {
  const ir = await lowered(
    `import { Box } from './box.svelte.ts';\nconst b = new Box();\nlet out = $state('');\nfunction go() { out = String(b.double); }`,
    { 'box.svelte.ts': BOX },
  );
  const r = ir.records.findIndex(x => x.name === 'Box');
  const box = ir.records[r];
  assert.equal(box.class, true);
  const field = name => box.fields.find(f => f.name === name);
  assert.equal(field('n').reactive, 'state');
  assert.equal(field('raw').reactive, 'raw');
  assert.equal(field('#hidden').reactive, 'state');
  // A field the constructor assigns with $state.
  assert.equal(field('later').reactive, 'state');
  for (const name of ['double', 'parity', 'sum']) {
    const f = field(name);
    assert.equal(f.reactive, 'derived');
    const fn = ir.functions[f.derived];
    assert.deepEqual(
      fn.params.map(p => p.type),
      [{ record: r }],
    );
    assert.equal(fn.result, 'number');
  }
  // The constructor builds the instance without values for derived fields.
  const ctor = ir.functions.find(f => f.name === 'Box.constructor');
  const record = (function find(x) {
    if (Array.isArray(x)) return x.map(find).find(Boolean);
    if (x && typeof x === 'object')
      return x.op === 'record' && x.record === r ? x : Object.values(x).map(find).find(Boolean);
    return undefined;
  })(ctor.body);
  assert.equal(record.fields.length, box.fields.filter(f => f.reactive !== 'derived').length);
});

test('reactive class fields compare writes with === and proxy plain objects, as Svelte does', async () => {
  const ids = ['zero', 'nan', 'store', 'poke', 'three'];
  const out = await logs(
    `import { Box, Made } from './box.svelte.ts';
     const b = new Box();
     const made: Made[] = [];
     let out = $state('');
     $effect(() => { console.log(\`n \${b.n}\`); });
     $effect(() => { console.log(\`nan \${b.nan}\`); });
     $effect(() => { console.log(\`double \${b.double}\`); });
     $effect(() => {
       const m = new Made();
       made.push(m);
       console.log(\`made \${m.seen}\`);
     });
     function zero() { b.n = -0; console.log(\`1/n \${1 / b.n}\`); }
     function nan() { b.nan = NaN; }
     function store() {
       const o = { a: 2 };
       b.obj = o;
       b.raw = o;
       console.log(\`obj proxied \${b.obj !== o}, raw kept \${b.raw === o}\`);
     }
     function poke() { made[0].v = 5; }
     function three() { b.n = 3; }`,
    { 'box.svelte.ts': BOX },
    clicks(...ids),
    buttons(ids),
  );
  assert.deepEqual(out, [
    ['n 0', 'nan NaN', 'double 0', 'made 1'],
    // -0 === 0: no change, and the field keeps +0.
    ['1/n Infinity'],
    // NaN !== NaN: a change.
    ['nan NaN'],
    ['obj proxied true, raw kept true'],
    // The effect created that instance: its fields are not its dependencies.
    [],
    ['n 3', 'double 6'],
  ]);
});

test('derived class fields are computed when read, cached and cut off when their value stays', async () => {
  const ids = ['addTwo', 'add', 'first'];
  const out = await logs(
    `import { List } from './list.svelte.ts';
     const list = new List();
     let out = $state('');
     $effect(() => { console.log(\`parity \${list.parity}\`); });
     $effect(() => { console.log(\`label \${list.label}\`); });
     function add() { list.items.push('x'); }
     function addTwo() { list.items.push('y', 'z'); }
     function first() { out = list.first; }`,
    {
      'list.svelte.ts': `export class List {
  items = $state<string[]>([]);
  /** Throws while the list is empty: computed only when read. */
  first = $derived(this.items[0].toUpperCase());
  count = $derived(this.items.length);
  parity = $derived.by(() => (this.count % 2 === 0 ? 'even' : 'odd'));
  get label(): string { return \`\${this.count} \${this.parity}\`; }
}
`,
    },
    clicks('addTwo', 'add', 'first', 'addTwo'),
    buttons(ids),
  );
  assert.deepEqual(out, [
    ['parity even', 'label 0 even'],
    // 0 → 2: parity stays even, so only the label effect runs.
    ['label 2 even'],
    ['parity odd', 'label 3 odd'],
    [],
    // 3 → 5: odd again.
    ['label 5 odd'],
  ]);
});

test('reactive fields: #private state behind getters, constructor $state, $derived.by and component state', async () => {
  const out = await run(
    `import { Box } from './box.svelte.ts';
     let base = $state(100);
     class Local {
       clicks = $state(0);
       total = $derived(this.clicks + base);
     }
     const b = new Box();
     const local = new Local();
     let out = $derived(\`\${b.hidden} \${b.sum} \${b.parity} \${local.total}\`);
     function go() { b.bumpHidden(); b.later = 20; b.n = 1; local.clicks += 1; base = 200; }`,
    { 'box.svelte.ts': BOX },
  );
  assert.deepEqual(out, ['1 11 0 100', '2 22 1 201']);
});

test('deep state in a $state field is reactive through its proxies', async () => {
  const out = await run(
    `import { Store } from './store.svelte.ts';
     const store = new Store();
     let out = $derived(store.items.map(t => \`\${t.text}\${t.done ? '+' : '-'}\`).join(' '));
     function go() { store.add('a'); store.add('b'); store.toggle(store.items[0]); }`,
    {
      'store.svelte.ts': `export interface Todo { text: string; done: boolean }
export class Store {
  items = $state<Todo[]>([]);
  add(text: string): void { this.items.push({ text, done: false }); }
  toggle(todo: Todo): void { todo.done = !todo.done; }
}
`,
    },
  );
  assert.deepEqual(out, ['', 'a+ b-']);
});

test('reactive class fields: Svelte errors and observable timing are rejected where they are written', async () => {
  const go = `let out = $state(''); function go() { out = ''; }`;
  const at = (line, column) => `App.svelte:${line}:${column}`;
  // Writing reactive state from a derived value (Svelte throws state_unsafe_mutation).
  await rejects(
    `class A {\n  n = $state(0);\n  d = $derived.by(() => { this.n = 1; return 2; });\n}\nconst a = new A();\nlet out = $derived(String(a.d));\nfunction go() {}`,
    'E_REACTIVITY',
    at(4, 27),
  );
  // ... or from a template expression, through a method.
  await rejects(
    `class A {\n  n = $state(0);\n  touch(): number { this.n += 1; return this.n; }\n}\nconst a = new A();\nlet out = $state('');\nfunction go() {}`,
    'E_REACTIVITY',
    at(4, 21),
    {},
    '<button id="go" onclick={go}>go</button><p id="out">{a.touch()}</p>',
  );
  // A derived field that changes a value it did not create (how often it runs would show).
  await rejects(
    `class A {\n  log: string[] = [];\n  n = $state(0);\n  d = $derived.by(() => { this.log.push('x'); return this.n; });\n}\nconst a = new A();\nlet out = $derived(String(a.d));\nfunction go() {}`,
    'E_REACTIVITY',
    at(5, 27),
  );
  // Assigning a derived field (overriding a derived value).
  await rejects(
    `class A {\n  n = $state(0);\n  d = $derived(this.n + 1);\n}\nconst a = new A();\nlet out = $state('');\nfunction go() { a.d = 5; }`,
    'E_CLASS',
    at(8, 17),
  );
  // A derived field assigned in the constructor reading a constructor parameter.
  await rejects(
    `class A {\n  n = $state(0);\n  d: number;\n  constructor(k: number) {\n    this.d = $derived(this.n + k);\n  }\n}\n${go}`,
    'E_CLASS',
    at(6, 32),
  );
  // A reactive field assigned after the constructor uses this otherwise.
  await rejects(
    `class A {\n  n: number;\n  m = 1;\n  constructor() {\n    this.init();\n    this.n = $state(0);\n  }\n  init(): void {}\n}\n${go}`,
    'E_CLASS',
    at(7, 5),
  );
  // Raw state mutated in place is not reactive; nor is a plain field written later.
  await rejects(
    `class A {\n  items = $state.raw<number[]>([]);\n  add(): void { this.items.push(1); }\n}\nconst a = new A();\nfunction go() { a.add(); }`,
    'E_REACTIVITY',
    undefined,
    {},
    '<button id="go" onclick={go}>go</button><p id="out">{a.items.length}</p>',
  );
  await rejects(
    `class A {\n  n = $state(0);\n  plain = 0;\n  bump(): void { this.plain += 1; }\n}\nconst a = new A();\nfunction go() { a.bump(); }`,
    'E_REACTIVITY',
    undefined,
    {},
    '<button id="go" onclick={go}>go</button><p id="out">{a.plain}</p>',
  );
});

// M6 inheritance and class unions. Expected values are what JavaScript
// gives for the same classes (TypeScript's ES2023 emit, define semantics
// for fields), checked in Node.

const CHAIN = `const log: string[] = [];
function note(s: string): number {
  log.push(s);
  return log.length;
}
export function logged(): string {
  return log.join(',');
}
export class A {
  a = note('A.a');
  #p = note('A.#p');
  constructor(x: number) {
    note(\`A(\${x})\`);
  }
  get p(): number {
    return this.#p;
  }
  who(): string {
    return 'A';
  }
  hello(): string {
    return \`hello from \${this.who()}\`;
  }
  static make(): string {
    return 'made';
  }
  static K = 7;
}
export class B extends A {
  b = note('B.b');
  #p = note('B.#p');
  constructor(y: number) {
    note('B pre');
    super(y * 2);
    note(\`B(\${y})\`);
  }
  get bp(): number {
    return this.#p;
  }
  who(): string {
    return 'B:' + super.who();
  }
}
export class C extends B {
  c = note('C.c');
  who(): string {
    return 'C';
  }
}
`;

test('inheritance: construction order, prefix layout, overrides, super calls, private names per class and statics', async () => {
  const out = await run(
    `import { A, B, C, logged } from './chain';
     let out = $state('');
     function go() {
       const c = new C(5);
       const first = logged();
       out = \`\${first} | \${c.a} \${c.b} \${c.c} \${c.p} \${c.bp} | \${c.hello()} | \${new B(1).hello()} | \${C.make()} \${C.K} \${c instanceof A} \${c instanceof B}\`;
     }`,
    { 'chain.ts': CHAIN },
  );
  assert.deepEqual(out, [
    '',
    'B pre,A.a,A.#p,A(10),B.b,B.#p,B(5),C.c | 2 5 8 3 6 | hello from C | hello from B:A | made 7 true true',
  ]);
  const ir = await lowered(
    `import { A, B, C } from './chain';
     let out = $state('');
     function go() { const c = new C(5); const a: A = c; out = a.hello() + new B(1).hello(); }`,
    { 'chain.ts': CHAIN },
  );
  const rec = name => ir.records.findIndex(r => r.name === name);
  const [a, b, c] = ['A', 'B', 'C'].map(rec);
  // Subclass records start with their base's fields; a private name both declare is qualified.
  assert.deepEqual(
    ir.records[c].fields.map(f => f.name),
    ['a', '#p', 'b', 'B#p', 'c'],
  );
  assert.equal(ir.records[b].extends, a);
  assert.equal(ir.records[c].extends, b);
  // A's methods take any A (a class reference); a value typed A is one too.
  const hello = ir.functions.find(f => f?.name === 'A.hello');
  assert.deepEqual(hello.params[0].type, { class: a });
  const json = JSON.stringify(ir);
  assert.match(json, /"op":"upcast"/);
  assert.match(json, /"op":"match-class"/);
});

const SHAPES = `export abstract class Shape {
  abstract readonly kind: 'circle' | 'square';
  constructor(readonly name: string) {}
  abstract area(): number;
  get label(): string {
    return \`\${this.name}:\${this.area().toFixed(1)}\`;
  }
  scaled(k: number): number {
    return this.area() * k;
  }
}
export class Circle extends Shape {
  readonly kind = 'circle';
  constructor(public r: number) {
    super('circle');
  }
  area(): number {
    return 3 * this.r * this.r;
  }
}
export class Square extends Shape {
  readonly kind = 'square';
  constructor(public s: number) {
    super('square');
  }
  area(): number {
    return this.s * this.s;
  }
  grow(): void {
    this.s += 1;
  }
}
export function describe(s: Circle | Square): string {
  if (s.kind === 'circle') return \`r=\${s.r}\`;
  return \`s=\${s.s}\`;
}
export function biggest(shapes: Shape[]): Shape | undefined {
  let best: Shape | undefined = undefined;
  for (const s of shapes) if (!best || s.area() > best.area()) best = s;
  return best;
}
export function result(): string {
  const shapes: Shape[] = [new Circle(1), new Square(2), new Circle(2)];
  let grown = 0;
  for (const s of shapes)
    if (s instanceof Square) {
      s.grow();
      grown += s.s;
    }
  const one: Circle | Square = shapes[1] instanceof Square ? shapes[1] : new Square(9);
  const big = biggest(shapes);
  const same = big === shapes[2];
  return \`\${shapes.map(s => s.label).join(' ')} | \${grown} \${describe(one)} \${describe(new Circle(4))} | \${big?.name} \${same} \${shapes[0].scaled(2)} | \${shapes.map(s => s.kind).join(',')}\`;
}
`;

test('class references: abstract classes, unions of subclasses, dispatch, instanceof and discriminant narrowing', async () => {
  const out = await run(
    `import { result } from './shapes';
     let out = $state('');
     function go() { out = result(); }`,
    { 'shapes.ts': SHAPES },
  );
  assert.deepEqual(out, [
    '',
    'circle:3.0 square:9.0 circle:12.0 | 3 s=3 r=4 | circle true 6 | circle,square,circle',
  ]);
});

test('inheritance with reactive fields: $state and $derived in base and subclass, super calls and a class reference in state', async () => {
  const ids = ['go', 'swap'];
  const out = await logs(
    `import { Base, Derived } from './h.svelte.ts';
     let item: Base = $state(new Derived());
     let out = $state('');
     $effect(() => { console.log(\`summary \${item.summary}\`); });
     function go() { item.inc(); }
     function swap() { item = new Base(); }`,
    {
      'h.svelte.ts': `export class Base {
  count = $state(0);
  double = $derived(this.count * 2);
  get summary(): string { return \`\${this.describe()} \${this.double}\`; }
  describe(): string { return 'base'; }
  inc(): void { this.count += 1; }
}
export class Derived extends Base {
  extra = $state(10);
  total = $derived(this.count + this.extra);
  describe(): string { return \`derived \${this.total}\`; }
  inc(): void { super.inc(); this.extra += 1; }
}
`,
    },
    clicks('go', 'swap', 'go'),
    buttons(ids),
  );
  assert.deepEqual(out, [
    ['summary derived 10 0'],
    ['summary derived 12 2'],
    ['summary base 0'],
    ['summary base 2'],
  ]);
});

test('inheritance: a base constructor that uses this before subclass fields exist', async () => {
  // Allowed when the subclasses declare no fields: the override runs, as in JavaScript.
  const out = await run(
    `class P {
       n = 0;
       constructor() { this.bump(); }
       bump(): void { this.n += 1; }
     }
     class Q extends P {
       bump(): void { this.n += 10; }
     }
     let out = $state('');
     function go() { out = \`\${new P().n} \${new Q().n}\`; }`,
  );
  assert.deepEqual(out, ['', '1 10']);
  // Rejected where a subclass declares fields: they would not exist yet.
  await rejects(
    `class P {\n  n = 0;\n  constructor() { this.bump(); }\n  bump(): void { this.n += 1; }\n}\nclass Q extends P {\n  k = 5;\n  bump(): void { this.n += this.k; }\n}\nlet out = $state('');\nfunction go() { out = String(new Q().n); }`,
    'E_CLASS',
    'App.svelte:8:3',
  );
});

test('inheritance: unsupported forms are rejected where they are written', async () => {
  const at = (line, column) => `App.svelte:${line}:${column}`;
  const go = `let out = $state('');\nfunction go() { out = ''; }`;
  // Mixins and other base expressions.
  await rejects(`class A { n = 1; }\nclass B extends (A) {}\n${go}`, 'E_CLASS', at(3, 17));
  // this before super(…).
  await rejects(
    `class A { n = 1; }\nclass B extends A {\n  k: number;\n  constructor() {\n    this.k = 1;\n    super();\n  }\n}\n${go}`,
    'E_CLASS',
    at(6, 5),
  );
  // super.x of a field (fields are not on the prototype).
  await rejects(
    `class A { n = 1; }\nclass B extends A {\n  m(): number { return super.n; }\n}\nlet out = $state('');\nfunction go() { out = String(new B().m()); }`,
    'E_CLASS',
    at(4, 24),
  );
  // An abstract method called through super.
  await rejects(
    `abstract class A { abstract m(): number; }\nclass B extends A {\n  m(): number { return super.m(); }\n}\nlet out = $state('');\nfunction go() { out = String(new B().m()); }`,
    'E_CLASS',
    at(4, 24),
  );
  // A field declared again as a parameter property.
  await rejects(
    `import { B } from './b';\nlet out = $state('');\nfunction go() { out = String(new B(2).n); }`,
    'E_CLASS',
    'b.ts:3:15',
    {
      'b.ts':
        'class A { n = 1; }\nexport class B extends A {\n  constructor(public n: number) { super(); }\n}\n',
    },
  );
  // A component-script class extending a module class.
  await rejects(`import { A } from './a';\nclass B extends A {}\n${go}`, 'E_CLASS', at(3, 17), {
    'a.ts': 'export class A { n = 1; }\n',
  });
  // A field declared separately by the classes of a union, assigned through the union.
  await rejects(
    `class A { k = 1; }\nclass B { k = 2; }\nlet flip = $state(false);\nlet out = $state('');\nfunction go() { const x: A | B = flip ? new A() : new B(); x.k = 3; out = String(x.k); }`,
    'E_CLASS',
    at(6, 60),
  );
  // An array of a subclass used as an array of its base (it keeps its identity).
  await rejects(
    `class A { n = 1; }\nclass B extends A {}\nlet out = $state('');\nfunction go() { const bs: B[] = [new B()]; const as: A[] = bs; out = String(as.length); }`,
    'E_CLASS',
    at(5, 50),
  );
  // Binding a method that a subclass overrides, through the base type.
  await rejects(
    `class A { m(): number { return 1; } }\nclass B extends A { m(): number { return 2; } }\nlet out = $state('');\nfunction go() { const a: A = new B(); const f = a.m.bind(a); out = String(f()); }`,
    'E_CLASS',
    at(5, 49),
  );
});

test('inheritance: a base field declared again with an initialiser is set in construction order', async () => {
  // JavaScript defines the field again after super(…) returns, in its place
  // among the subclass's initialisers; the base's own initialisers and
  // methods see the base's value until then.
  const out = await run(
    `class A {
       n = 1;
       seen = this.n * 100;
       f = (): string => 'A' + this.n;
       g(): string { return this.f(); }
     }
     class B extends A {
       m = this.n + 1;
       n = 5;
       k = this.n * 10;
       f = (): string => 'B' + this.n;
     }
     class C extends B {
       n = 7;
     }
     let out = $state('');
     function go() {
       const b = new B();
       const c = new C();
       const a: A = c;
       out = \`\${b.seen} \${b.m} \${b.n} \${b.k} \${b.g()} \${new A().g()} \${c.n} \${c.k} \${a.g()}\`;
     }`,
  );
  assert.deepEqual(out, ['', '100 2 5 50 B5 A1 7 50 B7']);
  const at = (line, column) => `App.svelte:${line}:${column}`;
  const go = `let out = $state('');\nfunction go() { out = String(new B().n); }`;
  // An initialiser of a type the base field does not take.
  await rejects(
    `class A { n = 1; }\nclass B extends A {\n  n = 'two';\n}\n${go}`,
    'E_CLASS',
    at(4, 3),
  );
  // A reactive base field (an accessor in Svelte's output) or initialiser.
  await rejects(
    `class A { n = $state(1); }\nclass B extends A {\n  n = 2;\n}\n${go}`,
    'E_CLASS',
    at(4, 3),
  );
  await rejects(
    `class A { n = 1; }\nclass B extends A {\n  n = $state(2);\n}\n${go}`,
    'E_CLASS',
    at(4, 3),
  );
  // A base constructor that uses this before the field is set again.
  await rejects(
    `class A {\n  n = 1;\n  constructor() { this.bump(); }\n  bump(): void { this.n += 1; }\n}\nclass B extends A {\n  n = 5;\n}\n${go}`,
    'E_CLASS',
    at(8, 3),
  );
});

test('the backend validates class hierarchies, class references and their conversions', async () => {
  const ir = await lowered(
    `import { result } from './shapes';
     let out = $state('');
     function go() { out = result(); }`,
    { 'shapes.ts': SHAPES },
  );
  check(ir);
  const rec = name => ir.records.findIndex(r => r.name === name);
  const [shape, circle, square] = ['Shape', 'Circle', 'Square'].map(rec);
  assert.equal(ir.records[shape].abstract, true);
  /** A copy of the program with one function returning `body` (of type `result`) from `params`. */
  const withFn = (params, result, value, locals = []) => {
    const p = structuredClone(ir);
    p.functions.push({ name: 'probe', params, locals, result, body: [{ op: 'return', value }] });
    return p;
  };
  const arg = { op: 'local', local: 0 };
  // Upcasts widen; a narrowing "upcast" is rejected, as is a class reference of a class without subclasses.
  check(
    withFn(
      [{ name: 'c', type: { record: circle } }],
      { class: shape },
      { op: 'upcast', value: arg, type: { class: shape } },
    ),
  );
  assert.throws(
    () =>
      check(
        withFn(
          [{ name: 's', type: { class: shape } }],
          { record: circle },
          { op: 'upcast', value: arg, type: { record: circle } },
        ),
      ),
    /Upcast/,
  );
  assert.throws(
    () =>
      check(withFn([{ name: 'c', type: { class: circle } }], 'number', { op: 'lit', value: 1 })),
    /must be a class record with subclasses/,
  );
  assert.throws(
    () =>
      check(
        withFn([{ name: 'u', type: { classes: [square, circle] } }], 'number', {
          op: 'lit',
          value: 1,
        }),
      ),
    /ascending/,
  );
  // Downcasts narrow; match-class covers every class it can have, or has an else.
  check(
    withFn(
      [{ name: 's', type: { class: shape } }],
      { record: square },
      { op: 'downcast', value: arg, type: { record: square } },
    ),
  );
  const cases = [
    { record: circle, local: 1, body: { op: 'lit', value: 1 } },
    { record: square, local: 2, body: { op: 'lit', value: 2 } },
  ];
  const locals = [
    { name: 'c', type: { record: circle } },
    { name: 's', type: { record: square } },
  ];
  check(
    withFn(
      [{ name: 's', type: { class: shape } }],
      'number',
      { op: 'match-class', value: arg, cases },
      locals,
    ),
  );
  assert.throws(
    () =>
      check(
        withFn(
          [{ name: 's', type: { class: shape } }],
          'number',
          { op: 'match-class', value: arg, cases: cases.slice(1) },
          locals,
        ),
      ),
    /does not cover every class/,
  );
  // An abstract class is never constructed; a subclass record starts with its base's fields.
  const abstract = structuredClone(ir);
  abstract.functions.push({
    name: 'probe',
    params: [],
    locals: [],
    result: { record: shape },
    body: [
      { op: 'return', value: { op: 'record', record: shape, fields: [{ op: 'lit', value: 'x' }] } },
    ],
  });
  assert.throws(() => check(abstract), /Abstract class Shape is constructed/);
  const prefix = structuredClone(ir);
  prefix.records[circle].fields.reverse();
  assert.throws(() => check(prefix), /do not start with those of Shape/);
  // An assertion to a subclass is checked: a TypeError where the static type was unsound
  // (JavaScript throws one here too, calling the missing method).
  const out = await run(
    `import { Shape, Circle, Square } from './shapes';
     let out = $state('');
     function go() {
       const shapes: Shape[] = [new Circle(1), new Square(2)];
       const ok = shapes[1] as Square;
       ok.grow();
       try {
         const s = shapes[0] as unknown as Square;
         s.grow();
         out = 'grew';
       } catch (e) {
         out = \`\${ok.s} \${(e as Error).name}\`;
       }
     }`,
    { 'shapes.ts': SHAPES },
  );
  assert.deepEqual(out, ['', '3 TypeError']);
});

test('class references: overridden accessors with super, unions of unrelated classes, nullable instanceof and this results', async () => {
  const out = await run(
    `import { result } from './m';
     let out = $state('');
     function go() { out = result(); }`,
    {
      'm.ts': `class Base {
  #v = 1;
  get value(): number { return this.#v; }
  set value(v: number) { this.#v = v; }
  self(): this { return this; }
  tag(): string { return 'base'; }
}
class Doubler extends Base {
  set value(v: number) { super.value = v * 2; }
  get value(): number { return super.value + 0.5; }
  tag(): string { return 'doubler'; }
}
class Other {
  tag(): string { return 'other'; }
  value = 42;
}
export function result(): string {
  const xs: Base[] = [new Base(), new Doubler()];
  for (const x of xs) x.value = 3;
  const maybe: Base | undefined = xs.find(x => x.tag() === 'doubler');
  const none: Base | undefined = xs.find(x => x.tag() === 'none');
  const mixed: (Base | Other)[] = [xs[0], new Other(), xs[1]];
  return \`\${xs.map(x => x.value).join(' ')} | \${maybe instanceof Doubler} \${none instanceof Doubler} \${maybe instanceof Base} | \${mixed.map(m => \`\${m.tag()}=\${m.value}\`).join(' ')} | \${xs[1].self().tag()} \${xs[1].self() === xs[1]}\`;
}
`,
    },
  );
  assert.deepEqual(out, [
    '',
    '3 6.5 | true false true | base=3 other=42 doubler=6.5 | doubler true',
  ]);
});

test('late fields in base classes and subclasses, nullable base fields narrowed through class references', async () => {
  const script = `import { result } from './m';
     let out = $state('');
     function go() { out = result(); }`;
  const files = {
    'm.ts': `class Label {
  constructor(private read: () => string) {}
  text(): string { return this.read(); }
}
class Base {
  name: string;
  tag: Label;
  constructor(name: string) {
    this.name = name;
    this.tag = new Label(() => 'tag of ' + this.name);
  }
  who(): string { return 'base ' + this.name; }
}
class Plain extends Base {
  who(): string { return 'plain ' + this.tag.text(); }
}
class Root {
  name: string;
  opt?: number;
  constructor(name: string) { this.name = name; }
}
class Leaf extends Root {
  label: Label;
  constructor(name: string) {
    super(name);
    this.label = new Label(() => this.name + '?');
    this.opt = 2;
  }
}
export function result(): string {
  const bs: Base[] = [new Base('a'), new Plain('b')];
  const rs: Root[] = [new Root('c'), new Leaf('d')];
  let s = bs.map(b => \`\${b.who()}/\${b.tag.text()}\`).join(' ');
  for (const r of rs) {
    if (r.opt !== undefined) s += \` \${r.name}:\${r.opt + 1}\`;
    else s += \` \${r.name}:none\`;
    if (r instanceof Leaf) s += \` \${r.label.text()}\`;
  }
  return s;
}
`,
  };
  // Base.tag and Leaf.label are set after the instance exists: nullable in
  // the records (Plain's starts with Base's), unwrapped when read.
  const ir = await lowered(script, files);
  const field = (record, name) =>
    ir.records.find(r => r.name === record).fields.find(f => f.name === name).type;
  for (const [record, name] of [
    ['Base', 'tag'],
    ['Plain', 'tag'],
    ['Leaf', 'label'],
  ])
    assert.ok(field(record, name).maybe, `${record}.${name} is late`);
  const out = await run(script, files);
  assert.deepEqual(out, ['', 'base a/tag of a plain tag of b/tag of b c:none d:3 d?']);
});
