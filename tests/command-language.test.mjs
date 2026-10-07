// What bits-ui's Command needed of the language layer (M6, case
// bits-command): template snippets, a component instance bound where
// nothing reads it, props typed through bindings that forward them, `??`
// decided by the values the sites pass, nullable keys of maps and sets,
// templates reading one field of state
// beside a map that changes, CSS.escape, and script writing attributes
// (native only). The interpreter runs each program.
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
  const root = await mkdtemp(path.resolve('.cache/tests/command-language-'));
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
/** The texts of the top-level elements (whitespace between them left out). */
const texts = dom => dom.filter(n => typeof n !== 'string').map(text);
const failWith = (code, pattern) => e =>
  (e instanceof Diagnostic && e.code === code && (!pattern || pattern.test(e.message))) ||
  assert.fail(`expected ${code}, got ${e.code}: ${e.message}`);

test('template snippets render where {@render} names them; hoisted before whitespace is trimmed', async () => {
  await withApp(
    {
      'App.svelte': `{#snippet Label()}
  <b>label</b>
{/snippet}

<div id="d">{@render Label()}<i>rest</i></div>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const { dom } = interpret(ir, [])[0].state;
      // No text before the element: the snippet and the whitespace after it go.
      assert.equal(typeof dom[0], 'object');
      assert.equal(text(dom[0]), 'labelrest');
    },
  );
  await withApp(
    {
      'App.svelte':
        '<script lang="ts"></script>\n\n{#snippet Row(n: number)}<b>{n}</b>{/snippet}\n<p>x</p>\n',
    },
    async root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        failWith('E_TEMPLATE', /take no parameters/),
      ),
  );
});

test('a component instance bound where nothing reads it is left out; read, it is not covered', async () => {
  const files = read => ({
    'Child.svelte': '<p>child</p>\n',
    'Mid.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  let { api = $bindable(null) }: { api?: Child | null } = $props();
</script>

<Child bind:this={api} />
${read ? '<p>{api === null}</p>\n' : ''}`,
    'App.svelte': `<script lang="ts">
  import Mid from './Mid.svelte';
</script>

<Mid />
`,
  });
  await withApp(files(false), async root => {
    const { ir } = await lower(await collect(root));
    assert.deepEqual(texts(interpret(ir, [])[0].state.dom), ['child']);
  });
  await withApp(files(true), async root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e => e instanceof Diagnostic,
    ),
  );
});

test('a prop typed wider than the value model takes the type its forwarding binding passes on', async () => {
  await withApp(
    {
      'Inner.svelte': `<script lang="ts">
  let { value = $bindable() }: { value?: any } = $props();
</script>

<input id="i" bind:value />
`,
      'Mid.svelte': `<script lang="ts">
  import Inner from './Inner.svelte';
  let { value = $bindable() }: { value?: any } = $props();
</script>

<Inner bind:value />
`,
      'App.svelte': `<script lang="ts">
  import Mid from './Mid.svelte';
  let v = $state('');
</script>

<Mid bind:value={v} />
<p>[{v}]</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [{ kind: 'input', id: 'i', value: 'set' }]);
      assert.equal(texts(steps[1].state.dom).at(-1), '[set]');
    },
  );
});

test('?? of a prop every site passes a value: the fallback is never evaluated', async () => {
  const files = passes => ({
    'Group.svelte': `<script lang="ts">
  let { value, heading }: { value?: string; heading?: string } = $props();
</script>

<p>{value ?? heading ?? crypto.randomUUID()}</p>
`,
    'App.svelte': `<script lang="ts">
  import Group from './Group.svelte';
</script>

<Group heading="Suggestions" />
<Group ${passes ? 'heading="Settings"' : ''} />
`,
  });
  await withApp(files(true), async root => {
    const { ir } = await lower(await collect(root));
    assert.deepEqual(texts(interpret(ir, [])[0].state.dom), ['Suggestions', 'Settings']);
    assert.ok(!JSON.stringify(ir).includes('random'));
  });
  // A site without a heading: rendering there reads randomness.
  await withApp(files(false), async root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      failWith('E_REACTIVITY', /Randomness/),
    ),
  );
});

test('a nullable key of a map or set whose keys are never nullish is not held', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const scores = new Map<string, number>();
  scores.set('a', 1);
  const seen = new Set<string>(['a']);
  let out = $state('');
  function check(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const key = el.getAttribute('data-key');
    const missing = el.getAttribute('data-missing');
    // @ts-ignore -- bits-ui's untyped JavaScript passes \`string | null\`.
    out = String(scores.get(key)) + ' ' + String(scores.get(missing)) + ' ' + seen.has(key) + ' ' + seen.has(missing);
  }
</script>

<button id="b" data-key="a" onclick={check}>{out}</button>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(text(steps[1].state.dom[0]), '1 undefined true false');
    },
  );
});

test('templates reading one field of state are not exposed to a map beside it that changes', async () => {
  const app = read => ({
    'App.svelte': `<script lang="ts">
  class Root {
    state = $state({ search: '', items: new Map<string, number>() });
    type(v: string) {
      this.state.search = v;
      this.state.items.set(v, v.length);
    }
  }
  const root = new Root();
</script>

<button id="b" onclick={() => root.type('se')}>{${read}}</button>
`,
  });
  await withApp(app('root.state.search'), async root => {
    const { ir } = await lower(await collect(root));
    const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
    assert.equal(text(steps[1].state.dom[0]), 'se');
  });
  // Reading the map itself: its changes do not update the view.
  await withApp(app('root.state.items.size'), async root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      failWith('E_REACTIVITY', /Map or Set|mutated in place/),
    ),
  );
});

test('CSS.escape escapes as Chromium does', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const out = [CSS.escape('a b#c'), CSS.escape('1x'), CSS.escape('-'), CSS.escape('é.ü')].join('|');
</script>

<p>{out}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      assert.equal(text(interpret(ir, [])[0].state.dom[0]), 'a\\ b\\#c|\\31 x|\\-|é\\.ü');
    },
  );
});

test('script writing an attribute is native only: the interpreter reports it incomplete', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let el: HTMLElement | undefined = $state();
  $effect(() => {
    el?.setAttribute('data-value', 'x');
  });
</script>

<div bind:this={el}>x</div>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      assert.ok(JSON.stringify(ir).includes('"element.setAttribute"'));
      assert.throws(() => interpret(ir, []), /RunicLayoutError|needs the native DOM/);
    },
  );
});
