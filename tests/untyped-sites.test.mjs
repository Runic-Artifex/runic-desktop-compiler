// Values typed `any` that the program types statically (M6, shadcn-svelte's
// Calendar, InputOTP, Sonner and Checkbox examples): host types that
// declaration files name (@types/node's timer handle, lib.dom's autofill
// tokens), aliases of svelte's `Component`, the unused default of a prop
// typed by its sites, and properties a source package's declaration file
// types `any`, typed by the values the program gives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/untyped-sites-'));
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

const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const byId = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const found = byId(n.children, id);
    if (found) return found;
  }
  return undefined;
};

/** Lowering `files` fails with `code` at `at` (file:line:column). */
async function rejects(files, code, at) {
  await withApp(files, root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e => {
        assert.equal(e.code, code, e.message);
        assert.equal(`${e.source?.file}:${e.source?.line}:${e.source?.column}`, at, e.message);
        return true;
      },
    ),
  );
}

test("host types declaration files name: @types/node's timer handle, lib.dom's autofill tokens", async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  let handle: NodeJS.Timeout | undefined = $state(undefined);
  let fill: HTMLInputAttributes['autocomplete'] = $state('one-time-code');
  function start() {
    if (handle !== undefined) clearTimeout(handle);
    handle = setTimeout(() => {}, 1000);
    fill = 'section-a shipping postal-code';
  }
</script>

<button id="go" onclick={start}>go</button>
<p id="h">{handle === undefined ? 'none' : 'set'}</p>
<input id="i" autocomplete={fill} />
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const [start, clicked] = interpret(ir, [{ kind: 'click', id: 'go' }]);
      assert.equal(text(byId(start.state.dom, 'h')), 'none');
      assert.equal(byId(start.state.dom, 'i').attrs.autocomplete, 'one-time-code');
      assert.equal(text(byId(clicked.state.dom, 'h')), 'set');
      assert.equal(
        byId(clicked.state.dom, 'i').attrs.autocomplete,
        'section-a shipping postal-code',
      );
    },
  );
});

test("an alias of svelte's Component is a component value", async () => {
  await withApp(
    {
      'Icon.svelte': '<p id="icon">icon</p>\n',
      'App.svelte': `<script lang="ts">
  import type { Component } from 'svelte';
  import Icon from './Icon.svelte';
  type AnyComponent = Component<any, any, string>;
  let shown: AnyComponent | undefined = $state(undefined);
</script>

<button id="go" onclick={() => (shown = Icon)}>go</button>
{#if shown}
  {@const Shown = shown}
  <Shown />
{/if}
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const [start, clicked] = interpret(ir, [{ kind: 'click', id: 'go' }]);
      assert.equal(byId(start.state.dom, 'icon'), undefined);
      assert.equal(text(byId(clicked.state.dom, 'icon')), 'icon');
    },
  );
});

const CHILD = `<script lang="ts">
  let { name = undefined, id }: { name?: any; id: string } = $props();
</script>

<p {id}>{name}</p>
`;

test('the default of a prop typed by its sites is not lowered where every site passes it', async () => {
  await withApp(
    {
      'Child.svelte': CHILD,
      'App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  let n = $state('b');
</script>

<Child id="a" name="first" />
<Child id="b" name={n} />
<button id="go" onclick={() => (n += '!')}>go</button>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const [start, clicked] = interpret(ir, [{ kind: 'click', id: 'go' }]);
      assert.equal(text(byId(start.state.dom, 'a')), 'first');
      assert.equal(text(byId(start.state.dom, 'b')), 'b');
      assert.equal(text(byId(clicked.state.dom, 'b')), 'b!');
    },
  );
});

/**
 * A source package (svelte-sonner at its pinned version, standing in for
 * bits-ui's PinInput) whose declaration file types `label` and the boxed
 * `pattern` (svelte-toolbelt's `ReadableBoxedValues<{ pattern: any }>`)
 * `any`; `js` and `dts` are added to its module.
 */
function pkg(js = '', dts = '') {
  return {
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
    'node_modules/svelte-sonner/dist/index.js': `import { boxWith } from 'svelte-toolbelt';
export class Holder {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
}
export function make(label, pattern) {
    return new Holder({ label, pattern: boxWith(() => pattern) });
}
${js}`,
    'node_modules/svelte-sonner/dist/index.d.ts': `import type { ReadableBox, ReadableBoxedValues } from 'svelte-toolbelt';
export interface HolderOpts extends ReadableBoxedValues<{
    pattern: any;
}> {
    label: any;
}
export declare class Holder {
    opts: HolderOpts;
    constructor(opts: HolderOpts);
}
export declare function make(label: string, pattern: string | null): Holder;
${dts}`,
  };
}

const USE = `<script lang="ts">
  import { make } from 'svelte-sonner';
  const h = make('hi', null);
</script>

<p id="l">{h.opts.label.toUpperCase()}</p>
<p id="p">{h.opts.pattern.current ?? 'none'}</p>
`;

test("a property a source package's declaration file types any takes the type of the values given it", async () => {
  await withApp({ ...pkg(), 'App.svelte': USE }, async root => {
    const { ir } = await lower(await collect(root));
    const [start] = interpret(ir, []);
    assert.equal(text(byId(start.state.dom, 'l')), 'HI');
    assert.equal(text(byId(start.state.dom, 'p')), 'none');
  });
});

test('a property typed any stays any where a value may come from elsewhere or values differ', async () => {
  // (Rejected at the field holding the options, as before.)
  const at = 'node_modules/svelte-sonner/dist/index.js:3:5';
  // Values of two types.
  await rejects(
    {
      ...pkg(
        'export function count(n) {\n    return new Holder({ label: n, pattern: boxWith(() => null) });\n}\n',
        'export declare function count(n: number): Holder;\n',
      ),
      'App.svelte': USE,
    },
    'E_TYPE_UNSUPPORTED',
    at,
  );
  // A spread into a literal of the options.
  await rejects(
    {
      ...pkg(
        'export function copy(o) {\n    return new Holder({ ...o });\n}\n',
        'export declare function copy(o: HolderOpts): Holder;\n',
      ),
      'App.svelte': USE,
    },
    'E_TYPE_UNSUPPORTED',
    at,
  );
  // A compound write.
  await rejects(
    {
      ...pkg(
        "export function bump(h) {\n    h.opts.label += '!';\n}\n",
        'export declare function bump(h: Holder): void;\n',
      ),
      'App.svelte': USE,
    },
    'E_TYPE_UNSUPPORTED',
    at,
  );
  // Options of another type passed where the options are expected.
  await rejects(
    {
      ...pkg(
        'export function wrap(o) {\n    return new Holder(o);\n}\n',
        'export declare function wrap(o: { label: unknown; pattern: ReadableBox<unknown> }): Holder;\n',
      ),
      'App.svelte': USE,
    },
    'E_TYPE_UNSUPPORTED',
    at,
  );
});
