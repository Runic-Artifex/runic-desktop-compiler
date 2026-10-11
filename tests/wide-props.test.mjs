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
