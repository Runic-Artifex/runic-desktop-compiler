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

test('a bag key from a finite set of names: the entry of the name it evaluates to', async () => {
  await withApp(
    {
      'state.svelte.ts': `export class Root {
  variant: 'dialog' | 'alert' = $state('dialog');
  attr = (part: 'trigger' | 'content') =>
    this.variant === 'dialog'
      ? part === 'trigger' ? 'data-dialog-trigger' : 'data-dialog-content'
      : part === 'trigger' ? 'data-alert-trigger' : 'data-alert-content';
}
export class Trigger {
  root: Root;
  constructor(root: Root) {
    this.root = root;
  }
  props: Record<string, unknown> = $derived.by(() => ({ id: 't', [this.root.attr('trigger')]: '', title: 'x' }));
}
`,
      'App.svelte': `<script lang="ts">
  import { Root, Trigger } from './state.svelte';
  const root = new Root();
  const trigger = new Trigger(root);
</script>

<div {...trigger.props}></div>
<button id="b" onclick={() => (root.variant = 'alert')}>alert</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.deepEqual(byId(steps[0].state.dom, 't').attrs, {
        id: 't',
        'data-dialog-trigger': '',
        title: 'x',
      });
      assert.deepEqual(byId(steps[1].state.dom, 't').attrs, {
        id: 't',
        'data-alert-trigger': '',
        title: 'x',
      });
    },
  );
});

// shadcn-svelte's Item, Bubble and Marker: an object literal of the
// component's own attributes and its rest props is a bag (whatever the rest
// props' TypeScript type), spread onto an element or passed to a `child`
// snippet typed `Record<string, unknown>` or a svelte/elements interface;
// the children the rest props received render from the bag.
const ITEM = `<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  let {
    class: className,
    child,
    variant,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> & {
    child?: Snippet<[{ props: Record<string, unknown> }]>;
    variant?: string;
  } = $props();
  const mergedProps = $derived({
    class: className ? 'item ' + className : 'item',
    'data-slot': 'item',
    'data-variant': variant,
    title: 'default',
    ...restProps,
  });
</script>

{#if child}
  {@render child({ props: mergedProps })}
{:else}
  <div {...mergedProps}>{@render mergedProps.children?.()}</div>
{/if}
`;

test('an object literal of attributes and rest props is a bag: later entries win, children render', async () => {
  await withApp(
    {
      'Item.svelte': ITEM,
      'Link.svelte': `<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes } from 'svelte/elements';
  let { child, ...restProps }: HTMLAnchorAttributes & {
    child: Snippet<[{ props: HTMLAnchorAttributes }]>;
  } = $props();
  const attrs = $derived({ 'data-slot': 'link', ...restProps });
</script>

{@render child({ props: attrs })}
`,
      // No site passes children: the optional call renders nothing.
      'Plain.svelte': `<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  let { ...restProps }: HTMLAttributes<HTMLDivElement> = $props();
  const mergedProps = $derived({ 'data-slot': 'plain', ...restProps });
</script>

<div {...mergedProps}>{@render mergedProps.children?.()}</div>
`,
      'App.svelte': `<script lang="ts">
  import Item from './Item.svelte';
  import Link from './Link.svelte';
  import Plain from './Plain.svelte';
  let variant = $state('outline');
</script>

<Plain id="f" />
<Item id="g" />

<Item id="a">content a</Item>
<Item id="b" class="x" {variant} title="site" data-slot="override">content b</Item>
<Item id="c" title={undefined}>content c</Item>
<Item id="d">
  {#snippet child({ props })}<span {...props}>from the snippet</span>{/snippet}
</Item>
<Link id="e" title="t">
  {#snippet child({ props })}<span {...props}>link</span>{/snippet}
</Link>
<button id="go" onclick={() => (variant = 'muted')}>go</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const [start, clicked] = interpret(ir, [{ kind: 'click', id: 'go' }]);
      const dom = start.state.dom;
      assert.deepEqual(byId(dom, 'a').attrs, {
        class: 'item',
        'data-slot': 'item',
        title: 'default',
        id: 'a',
      });
      assert.equal(text(byId(dom, 'a')), 'content a');
      // The rest props come after the component's own entries: they win.
      assert.deepEqual(byId(dom, 'b').attrs, {
        class: 'item x',
        'data-slot': 'override',
        'data-variant': 'outline',
        title: 'site',
        id: 'b',
      });
      assert.equal(byId(clicked.state.dom, 'b').attrs['data-variant'], 'muted');
      // An undefined entry of a later spread removes the earlier one's attribute.
      assert.equal(byId(dom, 'c').attrs.title, undefined);
      assert.equal(text(byId(dom, 'c')), 'content c');
      assert.equal(byId(dom, 'd').tag, 'span');
      assert.equal(byId(dom, 'd').attrs.class, 'item');
      assert.equal(text(byId(dom, 'd')), 'from the snippet');
      assert.deepEqual(byId(dom, 'e').attrs, { 'data-slot': 'link', id: 'e', title: 't' });
      assert.deepEqual(byId(dom, 'f').attrs, { 'data-slot': 'plain', id: 'f' });
      assert.equal(text(byId(dom, 'f')), '');
      // Children other sites pass, not this one.
      assert.equal(text(byId(dom, 'g')), '');
    },
  );
});

test('a bag of rest props passed to a snippet is rejected where a site also passes children', async () => {
  await withApp(
    {
      'Item.svelte': ITEM,
      'App.svelte': `<script lang="ts">
  import Item from './Item.svelte';
</script>

<Item id="d">
  content
  {#snippet child({ props })}<span {...props}>from the snippet</span>{/snippet}
</Item>
`,
    },
    root =>
      assert.rejects(lowered(root), e => {
        failWith('E_TEMPLATE', /hold the snippet children/)(e);
        assert.equal(`${e.source?.file}:${e.source?.line}`, 'Item.svelte:23');
        return true;
      }),
  );
  // Children no site passes, called without `?.`: Svelte calls undefined.
  await withApp(
    {
      'Item.svelte': `<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  let { ...restProps }: HTMLAttributes<HTMLDivElement> = $props();
  const mergedProps = $derived({ 'data-slot': 'item', ...restProps });
</script>

<div {...mergedProps}>
  {@render mergedProps.children!()}
</div>
`,
      'App.svelte': `<script lang="ts">
  import Item from './Item.svelte';
</script>

<Item id="a" />
`,
    },
    root =>
      assert.rejects(lowered(root), e => {
        failWith('E_TEMPLATE', /snippet props of this component/)(e);
        assert.equal(`${e.source?.file}:${e.source?.line}`, 'Item.svelte:8');
        return true;
      }),
  );
});
