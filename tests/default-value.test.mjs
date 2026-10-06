// An input's defaultValue from a spread and bind:value's start (M6:
// shadcn-svelte's Input in the Dialog demo): a nullish bound value takes
// the value the spread gave the input.
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
  const root = await mkdtemp(path.resolve('.cache/tests/default-value-'));
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

test('a spread defaultValue sets the value; a nullish binding adopts it', async () => {
  await withApp(
    {
      'Field.svelte': `<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  let { value = $bindable(), ...rest }: HTMLInputAttributes = $props();
</script>

<input bind:value {...rest} />
`,
      'App.svelte': `<script lang="ts">
  import Field from './Field.svelte';
  let name: string | undefined = $state();
  let kept: string | undefined = $state('kept');
</script>

<Field id="plain" defaultValue="Pedro" />
<Field id="bound" bind:value={name} defaultValue="Duarte" />
<Field id="set" bind:value={kept} defaultValue="ignored" />
<p id="out">{name ?? 'none'} {kept}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const [step] = interpret(ir, []);
      const dom = step.state.dom;
      assert.equal(byId(dom, 'plain').value, 'Pedro');
      assert.equal(byId(dom, 'plain').attrs.value, 'Pedro');
      assert.equal(byId(dom, 'plain').attrs.defaultvalue, undefined);
      assert.equal(byId(dom, 'bound').value, 'Duarte');
      assert.equal(byId(dom, 'set').value, 'kept');
      assert.equal(text(byId(dom, 'out')), 'Duarte kept');
    },
  );
});
