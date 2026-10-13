// Parameters with defaults (`function f(x: number, y = x + 1)`) in the shared
// language layer: a caller may leave such a parameter out or pass undefined,
// so its type in the function's IR parameter list and in function types is
// nullable (`maybe<T>`), and the body binds its name to the argument or the
// default. The default is evaluated when the call runs, only for undefined
// (null is kept), left to right, and may read the parameters before it;
// across direct calls, function values (also of types taking fewer
// arguments), callbacks, methods, constructors and `super(…)`. The expected
// values are Node's, running the same module (TypeScript stripped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const ENTRY = {
  svelte: [
    'main.js',
    "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
  ],
  react: [
    'main.jsx',
    "import { createRoot } from 'react-dom/client';\nimport App from './App.tsx';\nimport './style.css';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  ],
};

/** An app of `framework` with `files`; `run` gets its root. */
async function withApp(framework, files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/defaults-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const [entry, main] = ENTRY[framework];
    const all = {
      'index.html': `<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,
      [entry]: main,
      'style.css':
        "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
      'runic.json': JSON.stringify({ framework, entry, title: 'T' }),
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

const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const find = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const f = find(n.children, id);
    if (f) return f;
  }
};

/** The text of #out after mounting and after each of `clicks` clicks on #go. */
async function outputs(framework, files, clicks) {
  return withApp(framework, files, async root => {
    const { ir } = await lower(await collect(root));
    const steps = interpret(
      ir,
      Array.from({ length: clicks }, () => ({ kind: 'click', id: 'go' })),
    );
    return { ir, out: steps.map(s => text(find(s.state.dom, 'out'))) };
  });
}

// The shared module: every form, typed TypeScript that Node can strip.
const LOGIC = `export function f(x: number, y: number = x + 1, z = y * 2): string {
  return x + ',' + y + ',' + z;
}
function g(a: string | null = 'd'): string {
  return String(a);
}
function obj({ a, b }: { a: number; b: string } = { a: 1, b: 'q' }, c = a): string {
  return b + a + c;
}
class Acc {
  total: number;
  constructor(start = 10) {
    this.total = start;
  }
  add(x: number, times = 1): number {
    this.total += x * times;
    return this.total;
  }
}
class Sub extends Acc {
  constructor(start = 5) {
    super(start + 1);
  }
}
class Sub2 extends Acc {
  constructor() {
    super();
  }
}
const asValue: (x: number) => string = f;
const optional: (x: number, y?: number) => string = f;
function apply(fn: (x: number, y?: number) => string, x: number): string {
  return fn(x) + '/' + fn(x, x);
}
export function run(k: number): string {
  const log: string[] = [];
  const note = (s: string): number => {
    log.push(s);
    return s.length;
  };
  const h = (n: number = note('h' + k)): number => n;
  const local: (x: number) => string = f;
  return [
    f(k),
    f(k, undefined),
    f(k, 5),
    f(k, 5, 0),
    g(),
    g(null),
    g(undefined),
    String(h()),
    String(h(3)),
    String(h()),
    log.join('|'),
    obj(),
    obj({ a: k, b: 'z' }),
    obj(undefined, 7),
    String(new Acc().total),
    String(new Acc().add(k)),
    String(new Acc(1).add(2, 3)),
    String(new Acc(undefined).add(1, undefined)),
    String(new Sub().total),
    String(new Sub(k).add(1)),
    String(new Sub2().total),
    asValue(k),
    optional(k),
    optional(k, 7),
    local(k),
    apply(f, k),
    apply((x, y = 100) => x + ':' + y, k),
    [1, 2].map((v, i = 9) => v + i).join(),
  ].join(' ');
}
`;

/** Node's values of `run(k)` for k = 1, 2, 3. */
async function expected() {
  await mkdir('.cache/tests', { recursive: true });
  const dir = await mkdtemp(path.resolve('.cache/tests/defaults-node-'));
  try {
    await writeFile(path.join(dir, 'logic.ts'), LOGIC);
    const { run } = await import(pathToFileURL(path.join(dir, 'logic.ts')).href);
    return [1, 2, 3].map(run);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('defaults apply for undefined only, at call time, left to right (Svelte and React)', async () => {
  const want = await expected();
  // (A sanity check of the expectations: JavaScript's own rules.)
  assert.match(want[0], /^1,2,4 1,2,4 1,5,10 1,5,0 d null d 2 3 2 h1\|h1 q11 z11 q17 /);
  const svelte = await outputs(
    'svelte',
    {
      'logic.ts': LOGIC,
      'App.svelte': `<script lang="ts">
  import { run } from './logic.ts';
  let k = $state(1);
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out">{run(k)}</p>
`,
    },
    2,
  );
  assert.deepEqual(svelte.out, want);
  // The IR: a nullable parameter, its name a local of the declared type.
  const fn = svelte.ir.functions.find(x => x.name === 'f');
  assert.deepEqual(
    fn.params.map(p => p.type),
    ['number', { maybe: 'number' }, { maybe: 'number' }],
  );
  assert.deepEqual(
    fn.locals.slice(0, 2).map(l => [l.name, l.type]),
    [
      ['y', 'number'],
      ['z', 'number'],
    ],
  );
  const react = await outputs(
    'react',
    {
      'logic.ts': LOGIC,
      'App.tsx': `import { useState } from 'react';
import { run } from './logic.ts';
export default function App() {
  const [k, setK] = useState(1);
  return (
    <main>
      <button id="go" onClick={() => setK(k + 1)}>go</button>
      <p id="out">{run(k)}</p>
    </main>
  );
}
`,
    },
    2,
  );
  assert.deepEqual(react.out, want);
});

test('a callback given to a pack takes its default where the pack passes undefined', async () => {
  // runed's watch passes the previous value, undefined on the first run.
  const { out } = await outputs(
    'svelte',
    {
      'App.svelte': `<script lang="ts">
  import { watch } from 'runed';
  let k = $state(1);
  let out = $state('');
  watch(
    () => k,
    (now: number, before: number = -1) => {
      out = out + now + '<' + before + ' ';
    },
  );
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out">{out}</p>
`,
    },
    2,
  );
  assert.deepEqual(out, ['1<-1 ', '1<-1 2<1 ', '1<-1 2<1 3<2 ']);
});

test('untyped JavaScript: a left-out argument takes the default TypeScript types', async () => {
  // Specialised per call site: `scale(3)` passes undefined for `by`.
  const { out } = await outputs(
    'svelte',
    {
      'scale.js': `export function scale(x, by = 2, label = 'x' + by) {
  return label + '=' + x * by;
}
`,
      'App.svelte': `<script lang="ts">
  import { scale } from './scale.js';
  let k = $state(1);
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out">{[scale(k), scale(k, undefined), scale(k, 5), scale(k, 5, 'y')].join(' ')}</p>
`,
    },
    1,
  );
  // JavaScript's values.
  const scale = (x, by = 2, label = 'x' + by) => label + '=' + x * by;
  assert.deepEqual(
    out,
    [1, 2].map(k => [scale(k), scale(k, undefined), scale(k, 5), scale(k, 5, 'y')].join(' ')),
  );
});

test('options spread over defaults are passed where optional options are expected', async () => {
  // bits-ui's formatter `part(dateObj, type, options = {})`: the spread of
  // its default options and the given ones, whose fields are always
  // present, passed for an optional parameter of the options type (a view
  // of those fields, the present ones as nullable values).
  const LOGIC2 = `type Opts = { timeZone?: string };
interface Format {
  year?: string;
  month?: string;
}
const defaults = { year: 'numeric', month: 'long' };
function toParts(options?: Format): string {
  return (options?.year ?? '-') + (options?.month ?? '-');
}
export function part(options: Opts = {}): string {
  const opts = { ...defaults, ...options, month: options.timeZone ?? 'long' };
  return toParts(opts);
}
`;
  const { out } = await outputs(
    'svelte',
    {
      'logic.ts': LOGIC2,
      'App.svelte': `<script lang="ts">
  import { part } from './logic.ts';
  let k = $state(1);
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out">{[part(), part({ timeZone: 'UTC' + k })].join(' ')}</p>
`,
    },
    1,
  );
  assert.deepEqual(out, ['numericlong numericUTC1', 'numericlong numericUTC2']);
});

test('a method called through an untyped receiver is passed undefined for parameters it leaves out', async () => {
  // Untyped JavaScript specialised per call site: `c.bump()` of a Counter.
  class Counter {
    n = 0;
    bump(by = 1, times) {
      this.n += by * (times ?? 1);
      return this.n;
    }
  }
  const twice = c => c.bump() + ',' + c.bump(5) + ',' + c.bump(2, 3);
  const { out } = await outputs(
    'svelte',
    {
      'counter.ts': `export class Counter {
  n = 0;
  bump(by = 1, times?: number): number {
    this.n += by * (times ?? 1);
    return this.n;
  }
}
`,
      'twice.js': `export function twice(c) {
  return c.bump() + ',' + c.bump(5) + ',' + c.bump(2, 3);
}
`,
      'App.svelte': `<script lang="ts">
  import { Counter } from './counter.ts';
  import { twice } from './twice.js';
  let k = $state(1);
  function view(k: number): string {
    const s: string = twice(new Counter());
    return k + ':' + s;
  }
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out">{view(k)}</p>
`,
    },
    1,
  );
  assert.deepEqual(out, [`1:${twice(new Counter())}`, `2:${twice(new Counter())}`]);
});

/** Expects lowering of the Svelte app to fail with `code` at `line` of App.svelte. */
const rejects = (files, code, line, pattern) =>
  withApp('svelte', files, root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e =>
        (e instanceof Diagnostic &&
          e.code === code &&
          e.source?.file === 'App.svelte' &&
          e.source.line === line &&
          pattern.test(e.message)) ||
        assert.fail(`${e.code} ${JSON.stringify(e.source)}: ${e.message}`),
    ),
  );

test('a default reading its own or a later parameter is rejected (a ReferenceError in JavaScript)', async () => {
  await rejects(
    {
      'App.svelte': `<script lang="ts">
  // @ts-expect-error: b is read before it is initialised
  function bad(a: number = b, b: number = 1): number {
    return a + b;
  }
</script>
<p id="out">{bad()}</p>
`,
    },
    'E_FUNCTION',
    3,
    /reads b before it is initialised/,
  );
  // A function in the default would read the later parameter when it is
  // called (valid JavaScript): not covered, rejected with what it is.
  await rejects(
    {
      'App.svelte': `<script lang="ts">
  function later(a: () => number = () => b, b: number = 1): number {
    return a() + b;
  }
</script>
<p id="out">{later()}</p>
`,
    },
    'E_FUNCTION',
    2,
    /A function in the default refers to b, a parameter after it/,
  );
});
