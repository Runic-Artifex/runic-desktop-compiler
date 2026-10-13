// Classes of a package compiled from source that the program does not reach
// (frontend/package-modules.ts `unreachedClassOf`): bits-ui's Calendar root
// context is declared `RangeCalendarRootState | CalendarRootState` for both
// calendars, and a program without a RangeCalendar never reaches
// range-calendar.svelte.js, so only CalendarRootState values reach it. Also
// the follow-ons on the Calendar's path: a prop default that is undefined
// (`minValue = undefined`) keeps the prop optional in a discriminated props
// member, and the document as a value that may be null (bits-ui's
// `getAnnouncer(doc: Document | null)`) is rejected where the program needs
// its type, not at the compiler's host declarations (frontend/dom.d.ts).
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
  const root = await mkdtemp(path.resolve('.cache/tests/unreached-classes-'));
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
function findDeep(nodes, id) {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const inner = findDeep(n.children, id);
    if (inner) return inner;
  }
  return undefined;
}
const shown = (step, id) => text(findDeep(step.state.dom, id));

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

/**
 * A source package (svelte-sonner at its pinned version, standing in for
 * bits-ui) shaped as bits-ui's calendars: a single root and a range root in
 * their own modules, whose declarations type the single root's `create` (as
 * bits-ui types the context both calendars share) by both classes, the
 * range class imported for its type only. The barrel re-exports both.
 */
const ROOTS_PACKAGE = {
  'node_modules/svelte-sonner/package.json': JSON.stringify({
    name: 'svelte-sonner',
    version: '1.2.1',
    type: 'module',
    sideEffects: false,
    svelte: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', svelte: './dist/index.js', default: './dist/index.js' },
    },
  }),
  'node_modules/svelte-sonner/dist/index.js':
    'export { SingleRoot } from "./single.svelte.js";\nexport { RangeRoot } from "./range.svelte.js";\n',
  'node_modules/svelte-sonner/dist/index.d.ts':
    'export { SingleRoot } from "./single.svelte.js";\nexport { RangeRoot } from "./range.svelte.js";\n',
  'node_modules/svelte-sonner/dist/single.svelte.js': `export class SingleRoot {
    count = $state(0);
    static create() {
        return new SingleRoot();
    }
    static none() {
        return null;
    }
    increment() {
        this.count += 1;
    }
}
`,
  'node_modules/svelte-sonner/dist/single.svelte.d.ts': `import type { RangeRoot } from "./range.svelte.js";
export declare class SingleRoot {
    count: number;
    static create(): RangeRoot | SingleRoot;
    static none(): RangeRoot | null;
    increment(): void;
}
`,
  'node_modules/svelte-sonner/dist/range.svelte.js': `export class RangeRoot {
    count = $state(0);
    static create() {
        return new RangeRoot();
    }
    increment() {
        this.count += 2;
    }
}
`,
  'node_modules/svelte-sonner/dist/range.svelte.d.ts': `export declare class RangeRoot {
    count: number;
    static create(): RangeRoot;
    increment(): void;
}
`,
};

test('a class whose package module the program does not reach holds nothing in a union', async () => {
  await withApp(
    {
      ...ROOTS_PACKAGE,
      'App.svelte': `<script lang="ts">
  import { SingleRoot } from 'svelte-sonner';
  const root = SingleRoot.create();
</script>
<button id="inc" onclick={() => root.increment()}>{root.count}</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'inc' },
        { kind: 'click', id: 'inc' },
      ]);
      assert.deepEqual(
        steps.map(s => shown(s, 'inc')),
        ['0', '1', '2'],
      );
    },
  );
});

test('where the program reaches both modules, the union holds instances of both classes', async () => {
  await withApp(
    {
      ...ROOTS_PACKAGE,
      'App.svelte': `<script lang="ts">
  import { SingleRoot, RangeRoot } from 'svelte-sonner';
  let range = $state(false);
  const roots = [SingleRoot.create(), RangeRoot.create() as RangeRoot | SingleRoot];
  const root = $derived(roots[range ? 1 : 0]);
</script>
<button id="inc" onclick={() => root.increment()}>{root.count}</button>
<button id="switch" onclick={() => (range = !range)}>switch</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'inc' },
        { kind: 'click', id: 'switch' },
        { kind: 'click', id: 'inc' },
        { kind: 'click', id: 'switch' },
      ]);
      // Each instance keeps its class: the range root counts by two.
      assert.deepEqual(
        steps.map(s => shown(s, 'inc')),
        ['0', '1', '0', '2', '1'],
      );
    },
  );
});

test('a union of such a class and null holds null only', async () => {
  await withApp(
    {
      ...ROOTS_PACKAGE,
      'App.svelte': `<script lang="ts">
  import { SingleRoot } from 'svelte-sonner';
  const none = SingleRoot.none();
</script>
<p id="none">{none === null ? 'null' : 'other'}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      assert.equal(shown(interpret(ir, [])[0], 'none'), 'null');
    },
  );
});

test('a value typed only by a class the program does not reach is rejected, naming its module', async () => {
  await withApp(
    {
      ...ROOTS_PACKAGE,
      'node_modules/svelte-sonner/dist/other.js':
        'export function other() {\n    throw new Error("unreachable");\n}\n',
      'node_modules/svelte-sonner/dist/other.d.ts':
        'import type { RangeRoot } from "./range.svelte.js";\nexport declare function other(): RangeRoot;\n',
      'node_modules/svelte-sonner/dist/index.js':
        ROOTS_PACKAGE['node_modules/svelte-sonner/dist/index.js'] +
        'export { other } from "./other.js";\n',
      'node_modules/svelte-sonner/dist/index.d.ts':
        ROOTS_PACKAGE['node_modules/svelte-sonner/dist/index.d.ts'] +
        'export { other } from "./other.js";\n',
      'App.svelte': `<script lang="ts">
  import { other } from 'svelte-sonner';
  let shown = $state(false);
</script>
<button id="b" onclick={() => (shown = other().count > 0)}>{shown}</button>
`,
    },
    root =>
      assert.rejects(
        lowered(root),
        failWith(
          'E_CLASS',
          'node_modules/svelte-sonner/dist/other.js',
          /RangeRoot has no instances .*svelte-sonner\/dist\/range\.svelte\.js/,
        ),
      ),
  );
});

test('a prop default that is undefined keeps the prop optional in a discriminated member', async () => {
  await withApp(
    {
      'Picker.svelte': `<script lang="ts">
  type Props =
    | { type: 'single'; id: string; min?: number; label?: string }
    | { type: 'multiple'; id: string; min?: number; label?: string };
  let { id, type, min = undefined, label = $bindable(undefined) }: Props = $props();
</script>
<p {id}>{type} {min === undefined ? 'no min' : \`min \${min}\`} {label ?? 'no label'}</p>
`,
      'App.svelte': `<script lang="ts">
  import Picker from './Picker.svelte';
</script>
<Picker id="a" type="single" />
<Picker id="b" type="single" min={3} label="x" />
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const [step] = interpret(ir, []);
      assert.equal(shown(step, 'a'), 'single no min no label');
      assert.equal(shown(step, 'b'), 'single min 3 x');
    },
  );
});

// (`x ?? y` of a prop that is present wherever it has a value: the value,
// unless a site leaves it out and its default is undefined itself.)
test('a prop whose default is undefined stays nullish where a site leaves it out', async () => {
  await withApp(
    {
      'Label.svelte': `<script lang="ts">
  let { id, label = undefined, title = $bindable() }: { id: string; label?: string; title?: string } = $props();
</script>
<p {id}>{label ?? 'no label'} {title ?? 'no title'}</p>
`,
      'App.svelte': `<script lang="ts">
  import Label from './Label.svelte';
</script>
<Label id="a" />
<Label id="b" label="x" title="y" />
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const [step] = interpret(ir, []);
      assert.equal(shown(step, 'a'), 'no label no title');
      assert.equal(shown(step, 'b'), 'x y');
    },
  );
});
