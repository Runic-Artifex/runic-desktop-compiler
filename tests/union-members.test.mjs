// Unions narrowed by the values that reach them (frontend/unions.ts, gap V1):
// classes counted as one member, branches decided through getter boxes and
// constants, the census of a package function's union taken once the prop
// domains exist, and the unions that stay rejected.
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
  const root = await mkdtemp(path.resolve('.cache/tests/unions-'));
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

// bits-ui's Calendar value in small: one state class for the single and the
// multiple picker, its option `type` a getter box of the component's prop,
// the multiple branch under a constant testing `this.opts.type.current`, and
// a function of the nullable union testing `Array.isArray(v) && v.length`
// (bits-ui's `getDefaultDate`). (In the component's script: app modules are
// lowered before the prop domains exist, so a union met there is counted
// without the tests they decide.)
const picker = sites => ({
  'Pick.svelte': `<script lang="ts">
  import { boxWith, type ReadableBox } from 'svelte-toolbelt';

  class Day {
    label: string;
    constructor(label: string) {
      this.label = label;
    }
  }
  class Moment {
    label: string;
    hour: number;
    constructor(label: string, hour: number) {
      this.label = label;
      this.hour = hour;
    }
  }
  type Value = Day | Moment | (Day | Moment)[];
  type PickerOpts = { type: ReadableBox<'single' | 'multiple'> };

  function describe(v: Value | undefined): string {
    if (Array.isArray(v) && v.length) return \`\${v.length} picked\`;
    if (v && !Array.isArray(v)) return v.label;
    return 'none';
  }

  class Picker {
    value = $state<Value | undefined>(undefined);
    opts: PickerOpts;
    constructor(opts: PickerOpts) {
      this.opts = opts;
    }
    pick(next: Day | Moment) {
      const multiple = this.opts.type.current === 'multiple';
      if (multiple) {
        const prev = this.value;
        this.value = Array.isArray(prev) ? [...prev, next] : [next];
      } else {
        this.value = next;
      }
    }
  }

  let { type, id }: { type: 'single' | 'multiple'; id: string } = $props();
  const picker = new Picker({ type: boxWith(() => type) });
</script>

<button id="{id}-d" onclick={() => picker.pick(new Day('mon'))}>d</button>
<button id="{id}-m" onclick={() => picker.pick(new Moment('tue', 9))}>m</button>
<p id="{id}-t">{describe(picker.value)}</p>
`,
  'App.svelte': `<script lang="ts">
  import Pick from './Pick.svelte';
</script>

${sites}
`,
});

test('a union reached by several classes only takes their union, the other branch decided through a getter box and a constant', async () => {
  await withApp(picker('<Pick type="single" id="p" />'), async root => {
    const { ir } = await lowered(root);
    const steps = interpret(ir, [
      { kind: 'click', id: 'p-d' },
      { kind: 'click', id: 'p-m' },
    ]);
    const shown = s =>
      text(steps[s].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'p-t'));
    assert.equal(shown(0), 'none');
    assert.equal(shown(1), 'mon');
    assert.equal(shown(2), 'tue');
  });
});

test('a union reached by classes and an array stays rejected where a multiple picker exists', async () => {
  await withApp(picker('<Pick type="single" id="p" />\n<Pick type="multiple" id="q" />'), root =>
    assert.rejects(
      lowered(root),
      failWith('E_TYPE_UNION', 'Pick.svelte', /outside the value model.*\[\]/),
    ),
  );
});

test('a union reached by a class and a string stays rejected', async () => {
  await withApp(
    {
      'state.svelte.ts': `export class Day {
  constructor(readonly label: string) {}
}
export type Value = Day | string;
export function describe(v: Value): string {
  return typeof v === 'string' ? v : v.label;
}
`,
      'App.svelte': `<script lang="ts">
  import { Day, describe } from './state.svelte';
  let v = $state<Day | string>('none');
</script>

<button id="b" onclick={() => (v = new Day('mon'))}>b</button>
<p>{describe(v)}</p>
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_TYPE_UNION', 'state.svelte.ts', /outside the value model/),
      ),
  );
});

test('an instance of a class that only has the shape of a member counts as its own class', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  class Day {
    label: string;
    constructor(label: string) {
      this.label = label;
    }
  }
  class Note {
    label: string;
    constructor(label: string) {
      this.label = label;
    }
  }
  let v = $state<Day | string>('none');
  function show(x: Day | string): string {
    return typeof x === 'string' ? x : x.label;
  }
</script>

<button id="b" onclick={() => (v = new Note('mon'))}>b</button>
<p>{show(v)}</p>
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        failWith('E_TYPE_UNION', 'App.svelte', /outside the value model.*Note at/),
      ),
  );
});

// bits-ui's floating layer anchor in small (the context menu): the union
// `HTMLElement | Measurable` types both an option holding the trigger
// element and the root's anchor holding the virtual element. The census
// narrows a union type program-wide, so per-member compilation cannot
// separate the slots; the IR union (M6 unions) holds either member in every
// slot, and the method call dispatches on the member held.
test('a union whose members reach different slots of one instance holds either', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  type Measurable = { getBoundingClientRect: () => DOMRect };
  type Anchor = HTMLElement | Measurable;
  let el = $state<HTMLElement | null>(null);
  const virtual: Measurable = {
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 0, height: 0, top: 2, right: 1, bottom: 2, left: 1 }),
  };
  const opts: { ref: Anchor | null } = { ref: null };
  let anchor = $state<Anchor | null>(null);
</script>

<div bind:this={el}>x</div>
<button id="b" onclick={() => { opts.ref = el; anchor = virtual; }}>b</button>
<p id="p">{anchor ? anchor.getBoundingClientRect().x : 0}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      assert.ok(JSON.stringify(ir).includes('{"union":["element",{"record":'));
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      const p = s =>
        text(steps[s].state.dom.find(n => typeof n !== 'string' && n.attrs.id === 'p'));
      assert.equal(p(0), '0');
      assert.equal(p(1), '1');
    },
  );
});
