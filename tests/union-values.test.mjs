// Union values (M6 unions, docs/IR.md `{"union": …}`): a union reached by
// values of several members the value model unites (numbers, strings,
// booleans, elements, one plain record) holds either, and every operation
// is the member's; the forms it cannot carry are rejected where they stand.
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
  const root = await mkdtemp(path.resolve('.cache/tests/union-values-'));
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
const shown = (step, id) => text(findDeep(step.state.dom, id));
function findDeep(nodes, id) {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const inner = findDeep(n.children, id);
    if (inner) return inner;
  }
  return undefined;
}

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

const values = `export function describe(value: string | null | number): string {
  if (typeof value === 'number') {
    value = value.toString();
  } else if (value === null) {
    value = 'Empty';
  } else {
    value = value.trim();
  }
  return '[' + value + ']';
}
export function size(v: string | { length: number }): number {
  return v.length;
}
export class Holder {
  value = $state<string | number>(1);
  get doubled(): number {
    return typeof this.value === 'number' ? this.value * 2 : this.value.length;
  }
  half(n: number): number {
    return n / 2;
  }
  get halved(): number {
    return typeof this.value === 'number' ? this.half(this.value) : -1;
  }
}
`;

test('a union reached by strings and numbers holds either, its operations those of the member', async () => {
  await withApp(
    {
      'values.svelte.ts': values,
      'App.svelte': `<script lang="ts">
  import { describe, size, Holder } from './values.svelte';
  let v = $state<string | number>(0);
  let sized = $state<string | { length: number }>('abc');
  const h = new Holder();
</script>

<button id="n" onclick={() => (v = 7)}>n</button>
<button id="s" onclick={() => { v = ' 7 '; h.value = 'four'; }}>s</button>
<p id="h">{h.doubled} {h.halved}</p>
<button id="o" onclick={() => (sized = { length: 9 })}>o</button>
<p id="t">{typeof v} {String(v)} {v === 7} {v === ' 7 '} {v ? 'y' : 'n'}</p>
<p id="p">{v + 1} {v < 10} {Number(v)}</p>
<p id="d">{describe(v)} {describe(null)} {size(sized)}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const json = JSON.stringify(ir);
      assert.ok(json.includes('{"union":["number","string"]}'), 'the IR union type');
      assert.ok(json.includes('"match-union"'), 'a dispatch on the member');
      const steps = interpret(ir, [
        { kind: 'click', id: 'n' },
        { kind: 'click', id: 's' },
        { kind: 'click', id: 'o' },
      ]);
      assert.equal(shown(steps[0], 't'), 'number 0 false false n');
      assert.equal(shown(steps[0], 'p'), '1 true 0');
      assert.equal(shown(steps[0], 'd'), '[0] [Empty] 3');
      assert.equal(shown(steps[0], 'h'), '2 0.5');
      assert.equal(shown(steps[2], 'h'), '4 -1');
      assert.equal(shown(steps[1], 't'), 'number 7 true false y');
      assert.equal(shown(steps[1], 'p'), '8 true 7');
      assert.equal(shown(steps[2], 't'), 'string  7  false true y');
      assert.equal(shown(steps[2], 'p'), ' 7 1 true 7');
      assert.equal(shown(steps[2], 'd'), '[7] [Empty] 3');
      assert.equal(shown(steps[3], 'd'), '[7] [Empty] 9');
    },
  );
});

test('an element or an object measured like one dispatches its method and instanceof by member', async () => {
  await withApp(
    {
      'anchor.svelte.ts': `export interface Measurable {
  getBoundingClientRect(): DOMRect;
}
export class Anchor {
  anchor = $state<HTMLElement | Measurable | null>(null);
  usePoint(x: number, y: number) {
    this.anchor = {
      getBoundingClientRect: () => ({ x, y, width: 0, height: 0, top: y, right: x, bottom: y, left: x }),
    };
  }
  useElement(el: HTMLElement) {
    this.anchor = el;
  }
  describe(): string {
    const a = this.anchor;
    if (a === null) return 'none';
    if (a instanceof HTMLElement) return 'element';
    return 'virtual ' + typeof a + ' ' + a.getBoundingClientRect().left;
  }
}
`,
      'App.svelte': `<script lang="ts">
  import { Anchor } from './anchor.svelte';
  const anchor = new Anchor();
  let el: HTMLElement | undefined = $state();
</script>

<button id="p" onclick={() => anchor.usePoint(12, 34)}>p</button>
<button id="e" bind:this={el} onclick={() => { if (el) anchor.useElement(el); }}>e</button>
<p id="a">{anchor.describe()}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      assert.ok(JSON.stringify(ir).includes('{"union":["element",{"record":'));
      const steps = interpret(ir, [
        { kind: 'click', id: 'p' },
        { kind: 'click', id: 'e' },
      ]);
      assert.equal(shown(steps[0], 'a'), 'none');
      assert.equal(shown(steps[1], 'a'), 'virtual object 12');
      assert.equal(shown(steps[2], 'a'), 'element');
    },
  );
});

test('loose equality of a union value is rejected where it stands', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let v = $state<string | number>(0);
</script>

<button id="s" onclick={() => (v = '0')}>s</button>
<p>{v == 0}</p>
`,
    },
    root => assert.rejects(lowered(root), failWith('E_OPERATOR', 'App.svelte', /Loose equality/)),
  );
});

test('a union reached by a string and an array stays rejected', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let v = $state<string | string[]>('a');
  const show = (x: string | string[]) => (typeof x === 'string' ? x : x.join(','));
</script>

<button id="s" onclick={() => (v = ['b', 'c'])}>s</button>
<p>{show(v)}</p>
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_TYPE_UNION', 'App.svelte', /outside the value model/),
      ),
  );
});
