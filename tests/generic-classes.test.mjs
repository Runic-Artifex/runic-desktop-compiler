// Generic classes (M6 overlays: bits-ui's TimeoutFn<T>), lowered per program
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
  const root = await mkdtemp(path.resolve('.cache/tests/generic-classes-'));
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
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const failWith = (code, pattern) => e =>
  (e instanceof Diagnostic && e.code === code && (!pattern || pattern.test(e.message))) ||
  assert.fail(`expected ${code}, got ${e.code}: ${e.message}`);

const TIMEOUT = `class TimeoutFn {
    #interval: number;
    #cb: () => void;
    #timer: number | null = null;
    constructor(cb: () => void, interval: number) {
      this.#cb = cb;
      this.#interval = interval;
      this.stop = this.stop.bind(this);
      this.start = this.start.bind(this);
    }
    #clear() {
      if (this.#timer !== null) {
        window.clearTimeout(this.#timer);
        this.#timer = null;
      }
    }
    stop(): void {
      this.#clear();
    }
    start(...args: []): void {
      this.#clear();
      this.#timer = window.setTimeout(() => {
        this.#timer = null;
        this.#cb(...args);
      }, this.#interval);
    }
  }`;

const app = cls => `<script lang="ts">
  ${cls}
  let count = $state(0);
  const t = new TimeoutFn(() => {
    count++;
  }, 10);
</script>

<button id="a" onclick={() => t.start()}>{count}</button>
<button id="b" onclick={() => { const f = t.stop; f(); }}>stop</button>
<button id="c" onclick={() => { const f = t.start; f(); }}>start</button>
`;

const run = async (cls, check) =>
  withApp({ 'App.svelte': app(cls) }, async root => {
    const { ir } = await lowered(root);
    const steps = interpret(ir, [
      { kind: 'click', id: 'a' },
      { kind: 'wait', ms: 20 },
      { kind: 'click', id: 'c' },
      { kind: 'click', id: 'b' },
      { kind: 'wait', ms: 20 },
      { kind: 'click', id: 'a' },
      { kind: 'click', id: 'a' },
      { kind: 'wait', ms: 20 },
    ]);
    check(steps.map(s => (s.state.dom.error ? s.state.dom.error : text(s.state.dom[0]))));
  });

test('a class rebinding its methods, rest parameters of an empty tuple, spread calls', async () => {
  await run(TIMEOUT, texts =>
    assert.deepEqual(texts, ['0', '0', '1', '1', '1', '1', '1', '1', '2']),
  );
});

/** bits-ui's TimeoutFn as its declarations type it. */
const GENERIC = TIMEOUT.replace(
  'class TimeoutFn {',
  'class TimeoutFn<T extends (...args: any[]) => any> {',
)
  .replace('#cb: () => void;', '#cb: T;')
  .replace('constructor(cb: () => void,', 'constructor(cb: T,')
  .replace('start(...args: []): void', 'start(...args: Parameters<T> | []): void');

test('a generic class takes the one instantiation of the program', async () => {
  assert.notEqual(GENERIC, TIMEOUT);
  await run(GENERIC, texts =>
    assert.deepEqual(texts, ['0', '0', '1', '1', '1', '1', '1', '1', '2']),
  );
});

test('a second instantiation of a generic class is rejected where it is written', async () => {
  await withApp(
    {
      'App.svelte': app(GENERIC).replace(
        '</script>',
        '  const other = new TimeoutFn((n: number) => {}, 5);\n</script>',
      ),
    },
    root => assert.rejects(lowered(root), failWith('E_CLASS', /one instantiation per program/)),
  );
});
