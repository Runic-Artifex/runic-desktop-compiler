// Props and values typed wider than their values (M6: shadcn-svelte's
// InputGroup.Input and Input): `string & {}` in a union of literals holds
// strings, and a prop typed `any` that is only bound to a child's prop
// takes that prop's type.
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
  const root = await mkdtemp(path.resolve('.cache/tests/wide-props-'));
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

test('a primitive intersected with {} is the primitive, also in a union', async () => {
  await withApp(
    {
      'Kind.svelte': `<script lang="ts">
  type Kind = 'text' | 'email' | (string & {});
  let { kind, id }: { kind?: Kind; id: string } = $props();
</script>

<p {id}>{kind ?? 'none'}</p>
`,
      'App.svelte': `<script lang="ts">
  import Kind from './Kind.svelte';
  let n: number & {} = $state(3);
  let custom: string & {} = 'tel';
</script>

<Kind id="a" kind="email" />
<Kind id="b" kind={custom} />
<Kind id="c" />
<button id="go" onclick={() => (n += 1)}>go</button>
<p id="n">{n + 1}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const [start, clicked] = interpret(ir, [{ kind: 'click', id: 'go' }]);
      const dom = start.state.dom;
      assert.equal(text(byId(dom, 'a')), 'email');
      assert.equal(text(byId(dom, 'b')), 'tel');
      assert.equal(text(byId(dom, 'c')), 'none');
      assert.equal(text(byId(dom, 'n')), '4');
      assert.equal(text(byId(clicked.state.dom, 'n')), '5');
    },
  );
  // A branded intersection is not one: it keeps its own (unsupported) record.
  await rejects(
    {
      'App.svelte': `<script lang="ts">
  type Id = string & { readonly brand: 'id' };
  let id = $state('x' as Id);
</script>

<p>{id}</p>
`,
    },
    'E_TYPE_UNSUPPORTED',
    'App.svelte:3:7',
  );
});

const FIELD = `<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  let { value = $bindable(), ...rest }: HTMLInputAttributes = $props();
</script>

<input bind:value {...rest} />
`;

test('a prop typed any that is only bound to a child prop takes its type', async () => {
  await withApp(
    {
      'Field.svelte': FIELD,
      'Wrapper.svelte': `<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import Field from './Field.svelte';
  let { value = $bindable(), ...props }: ComponentProps<typeof Field> = $props();
</script>

<Field bind:value {...props} />
<p id="echo">{value ?? 'none'}</p>
`,
      'App.svelte': `<script lang="ts">
  import Wrapper from './Wrapper.svelte';
</script>

<Wrapper id="w" />
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const [start, typed] = interpret(ir, [{ kind: 'input', id: 'w', value: 'hey' }]);
      assert.equal(text(byId(start.state.dom, 'echo')), 'none');
      assert.equal(text(byId(typed.state.dom, 'echo')), 'hey');
    },
  );
  // Also bound to an element: rejected, as before.
  await rejects(
    {
      'Field.svelte': FIELD,
      'Wrapper.svelte': `<script lang="ts">
  import Field from './Field.svelte';
  let { value = $bindable() }: { value?: any } = $props();
</script>

<Field bind:value />
<input type="number" bind:value />
`,
      'App.svelte': `<script lang="ts">
  import Wrapper from './Wrapper.svelte';
</script>

<Wrapper />
`,
    },
    'E_TYPE_UNION',
    'Wrapper.svelte:3:9',
  );
  // Bound to a child prop that never holds undefined (Svelte rejects
  // binding undefined to a prop with a fallback): rejected.
  await rejects(
    {
      'Num.svelte': `<script lang="ts">
  let { value = $bindable(0) }: { value?: number } = $props();
</script>

<p>{value}</p>
`,
      'Wrapper.svelte': `<script lang="ts">
  import Num from './Num.svelte';
  let { value = $bindable() }: { value?: any } = $props();
</script>

<Num bind:value />
`,
      'App.svelte': `<script lang="ts">
  import Wrapper from './Wrapper.svelte';
</script>

<Wrapper />
`,
    },
    'E_TYPE_UNION',
    'Wrapper.svelte:3:9',
  );
});

// (The class is lowered with the component: local modules lower before
// the props' sites are known, bits-ui's package modules where used.)
const PIN = `<script lang="ts">
  import { boxWith, type ReadableBox } from 'svelte-toolbelt';
  import { noop } from './noop.ts';
  let { onComplete = noop, id }: { onComplete?: (...args: any[]) => void; id: string } = $props();
  interface Opts {
    onComplete: ReadableBox<(...args: any[]) => void>;
  }
  class Pin {
    opts: Opts;
    done = $state(0);
    constructor(opts: Opts) {
      this.opts = opts;
    }
    fill(value: string) {
      this.opts.onComplete.current(value);
      this.done++;
    }
  }
  const pin = new Pin({ onComplete: boxWith(() => onComplete) });
</script>

<button {id} onclick={() => pin.fill('1234')}>{pin.done}</button>
`;
const PIN_FILES = {
  'noop.ts': 'export function noop() {}\n',
  'Wrapper.svelte': `<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import Pin from './Pin.svelte';
  let { ...rest }: ComponentProps<typeof Pin> = $props();
</script>

<Pin {...rest} />
`,
  'App.svelte': `<script lang="ts">
  import Wrapper from './Wrapper.svelte';
</script>

<Wrapper id="a" />
`,
};

test('a prop typed wider than the value model that no site passes has its default type', async () => {
  // bits-ui's PinInput `onComplete = noop` under shadcn-svelte's InputOTP:
  // the prop, and the box option given its getter, hold only the default.
  await withApp({ ...PIN_FILES, 'Pin.svelte': PIN }, async root => {
    const { ir } = await lower(await collect(root));
    const [start, clicked] = interpret(ir, [{ kind: 'click', id: 'a' }]);
    assert.equal(text(byId(start.state.dom, 'a')), '0');
    assert.equal(text(byId(clicked.state.dom, 'a')), '1');
  });
  // The component also writes it: its values do not all come from the
  // default, rejected where it is declared.
  await rejects(
    {
      ...PIN_FILES,
      'Pin.svelte': PIN.replace(
        '</script>',
        `  export function reset(f: (...args: any[]) => void) {
    onComplete = f;
  }
</script>`,
      ),
    },
    'E_TYPE_UNION',
    'Pin.svelte:4:9',
  );
  // An extra argument whose evaluation may have an effect is not dropped:
  // the call keeps TypeScript's parameters, outside the value model.
  await rejects(
    {
      ...PIN_FILES,
      'Pin.svelte': PIN.replace(
        'this.opts.onComplete.current(value);',
        'this.opts.onComplete.current(this.bump(value));',
      ).replace(
        '    fill(value: string) {',
        `    bump(value: string): string {
      this.done++;
      return value;
    }
    fill(value: string) {`,
      ),
    },
    'E_TYPE_UNSUPPORTED',
    'Pin.svelte:19:7',
  );
});
