// Empty array literals, which TypeScript types `never[]` (no value model
// type): a union with another array member reached by fresh `[]` literals
// takes that member (frontend/unions.ts, bits-ui's SafePolygon
// `#transitTargets`), and a function whose result no code reads returns
// nothing (frontend/language.ts `declare`, bits-ui's Slider
// `handleDefaultValue`). Shared `never[]` values and results that are read
// stay rejected.
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
  const root = await mkdtemp(path.resolve('.cache/tests/empty-arrays-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
      'style.css':
        "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
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

/** Expects a diagnostic `code` located in `file` (and matching `pattern`). */
const failWith = (code, file, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    (!pattern || pattern.test(e.message))) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

/** The text of `#id` after each of `clicks`. */
async function shown(root, id, clicks) {
  const { ir } = await lowered(root);
  const steps = interpret(
    ir,
    clicks.map(c => ({ kind: 'click', id: c })),
  );
  return steps.map(s => text(s.state.dom.find(n => typeof n !== 'string' && n.attrs.id === id)));
}

// SafePolygon in small: a field starting as `[]`, assigned a filtered
// array or `[]`, and one only empty literals reach (it takes the first
// array member).
test('a union of never[] and another array type reached by fresh empty literals takes the array member', async () => {
  await withApp(
    {
      'tracker.svelte.ts': `export class Tracker {
  #targets: never[] | string[] = [];
  #last: never[] | string[] = [];
  pick(all: string[], on: boolean): void {
    this.#targets = on ? all.filter(x => x !== 'b') : [];
    this.#last = [];
  }
  get shown(): string {
    let joined = '';
    for (const t of this.#targets) joined += t;
    return joined + '|' + this.#targets.length + '|' + this.#last.length;
  }
}
`,
      'App.svelte': `<script lang="ts">
  import { Tracker } from './tracker.svelte';
  const t = new Tracker();
  let out = $state(t.shown);
</script>

<button id="on" onclick={() => { t.pick(['a', 'b', 'c'], true); out = t.shown; }}>on</button>
<button id="off" onclick={() => { t.pick(['a'], false); out = t.shown; }}>off</button>
<p id="o">{out}</p>
`,
    },
    async root =>
      assert.deepEqual(await shown(root, 'o', ['on', 'off']), ['|0|0', 'ac|2|0', '|0|0']),
  );
});

test('an empty literal still counts as an array where a value of another kind reaches the union', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let v = $state<string | string[]>('none');
</script>

<button id="b" onclick={() => (v = [])}>b</button>
<p>{typeof v === 'string' ? v : v.length}</p>
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_TYPE_UNION', 'App.svelte', /several members.*string\[\] at/),
      ),
  );
});

test('a never[] value that is not a fresh literal is not taken as another array', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const none: never[] = [];
  let v = $state<never[] | string[]>(none);
</script>

<button id="b" onclick={() => (v = ['x'])}>b</button>
<p>{v.length}</p>
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        e =>
          (e instanceof Diagnostic &&
            e.source?.file === 'App.svelte' &&
            ((e.code === 'E_TYPE_UNION' && /several members/.test(e.message)) ||
              (e.code === 'E_TYPE_UNSUPPORTED' && /type never/.test(e.message)))) ||
          assert.fail(`${e.code} ${JSON.stringify(e.source)}: ${e.message}`),
      ),
  );
});

// bits-ui's Slider in small: `handleDefaultValue()` returns `[]` or a
// number, and every call discards it.
const defaults = (use, kind) => ({
  'App.svelte': `<script lang="ts">
  let { kind = '${kind}' }: { kind?: string } = $props();
  let value = $state<number | undefined>(undefined);
  let runs = $state(0);
  function handleDefaultValue() {
    runs += 1;
    if (value !== undefined) return;
    if (kind === 'single') return 1;
    return [];
  }
  ${use}
</script>

<button id="b" onclick={() => { handleDefaultValue(); value = 2; handleDefaultValue(); }}>b</button>
<p id="o">{runs}</p>
`,
});

test('a function whose result no code reads returns nothing, its returns evaluated', async () => {
  await withApp(defaults('handleDefaultValue();', 'multiple'), async root =>
    assert.deepEqual(await shown(root, 'o', ['b']), ['1', '3']),
  );
});

test('a function returning an empty literal whose result is read stays rejected', async () => {
  await withApp(defaults('const first = handleDefaultValue();', 'multiple'), root =>
    assert.rejects(lowered(root), failWith('E_TYPE_UNSUPPORTED', 'App.svelte', /type never/)),
  );
});
