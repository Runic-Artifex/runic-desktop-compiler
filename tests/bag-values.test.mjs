// Attribute bags meeting component props (M6 overlays, bits-ui's Dialog through
// shadcn's wrappers): spreads onto components without rest props, the values
// a spread gives a prop (frontend/bags.ts `values`), numbers in style objects.
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
  const root = await mkdtemp(path.resolve('.cache/tests/bag-values-'));
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

const byId = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const found = byId(n.children, id);
    if (found) return found;
  }
  return undefined;
};

test('a spread onto a component without rest props: undeclared names are ignored', async () => {
  await withApp(
    {
      'Child.svelte': `<script lang="ts">
  let { label, id }: { label: string; id: string } = $props();
</script>

<p {id}>{label}</p>
`,
      'App.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  const bag = $derived({ ['data-x']: '1', label: 'from the bag', title: 't' });
</script>

<Child id="a" {...bag} label="explicit" />
<Child id="b" label="explicit" {...bag} />
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const [step] = interpret(ir, []);
      assert.equal(text(byId(step.state.dom, 'a')), 'explicit');
      assert.equal(text(byId(step.state.dom, 'b')), 'from the bag');
    },
  );
});

test('a prop takes the values a spread holds for it: mergeProps, rest props, snippet parameters', async () => {
  await withApp(
    {
      // shadcn's Button: its class evaluated at build time per site.
      'Btn.svelte': `<script lang="ts">
  import { cn } from 'cn';
  let { class: className, id, ...rest }: { class?: string; id: string; [key: string]: unknown } = $props();
</script>

<button {id} class={cn('btn', className)} {...rest}>b</button>
`,
      // bits-ui's DialogClose: its snippet receives its rest props merged with its own.
      'Holder.svelte': `<script lang="ts">
  import { mergeProps } from 'svelte-toolbelt';
  import type { Snippet } from 'svelte';
  let { child, ...rest }: { child: Snippet<[{ props: Record<string, unknown> }]>; [key: string]: unknown } = $props();
  const merged = $derived(mergeProps(rest, { ['data-holder']: '' }));
</script>

{@render child({ props: merged })}
`,
      'App.svelte': `<script lang="ts">
  import Btn from './Btn.svelte';
  import Holder from './Holder.svelte';
</script>

<Holder class="from-site">
  {#snippet child({ props })}<Btn id="a" class="base" {...props} />{/snippet}
</Holder>
<Holder>
  {#snippet child({ props })}<Btn id="b" class="base" {...props} />{/snippet}
</Holder>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const [step] = interpret(ir, []);
      assert.equal(byId(step.state.dom, 'a').attrs.class, 'btn from-site');
      assert.equal(byId(step.state.dom, 'b').attrs.class, 'btn base');
      assert.equal(byId(step.state.dom, 'b').attrs['data-holder'], '');
    },
  );
});

test('a number in a style object is printed as its string, as mergeProps prints styles', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  import { mergeProps } from 'svelte-toolbelt';
  let depth = $state(2);
  const props = $derived(
    mergeProps({ id: 'a' }, { ['data-layer']: '', style: { pointerEvents: 'auto', '--depth': depth } }),
  );
</script>

<div {...props}></div>
<button id="b" onclick={() => (depth += 0.5)}>more</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(byId(steps[0].state.dom, 'a').attrs.style, 'pointer-events: auto; --depth: 2;');
      assert.equal(
        byId(steps[1].state.dom, 'a').attrs.style,
        'pointer-events: auto; --depth: 2.5;',
      );
    },
  );
});
