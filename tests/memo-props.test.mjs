// Component props whose value changes module state (frontend/memo-props.ts):
// shadcn-svelte's CommandGroup `value={value ?? heading ?? `----${useId()}`}`
// over bits-ui's global id counter. Svelte computes such a prop once, in a
// derived value, when the child first reads it; the compiler models it where
// it can show the counter advances in Svelte's order, and rejects the rest.
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
  const root = await mkdtemp(path.resolve('.cache/tests/memo-props-'));
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
      // bits-ui's use-id.js, in a package compiled from source (svelte-sonner@1.2.1 stands in).
      'node_modules/svelte-sonner/package.json': JSON.stringify({
        name: 'svelte-sonner',
        version: '1.2.1',
        type: 'module',
        sideEffects: false,
        types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
      'node_modules/svelte-sonner/dist/index.d.ts':
        'export declare function useId(prefix?: string): string;\n',
      'node_modules/svelte-sonner/dist/index.js': `globalThis.testIdCounter ??= { current: 0 };
export function useId(prefix = 'bits') {
  globalThis.testIdCounter.current++;
  return \`\${prefix}-\${globalThis.testIdCounter.current}\`;
}
`,
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
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const byId = (step, id) => flat(step.state.dom).find(n => n.attrs.id === id);
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const failWith = pattern => e =>
  (e instanceof Diagnostic && e.code === 'E_REACTIVITY' && pattern.test(e.message)) ||
  assert.fail(`expected E_REACTIVITY ${pattern}, got ${e.code}: ${e.message}`);

/** The child: `value` declared with a default (`$.prop` reads it there), then its own id. */
const CHILD = `<script lang="ts">
  import { useId } from 'svelte-sonner';
  let { id, value = '' }: { id: string; value?: string } = $props();
  const own = useId();
</script>
<p {id}>{value} {own}</p>
`;

const group = (markup, script = '') => `<script lang="ts">
  import Child from './Child.svelte';
  import { useId } from 'svelte-sonner';
  let { label }: { label: string } = $props();
  ${script}
</script>
${markup}
`;

test('a prop computed by a call that advances a module counter takes the ids Svelte gives', async () => {
  await withApp(
    {
      'Child.svelte': CHILD,
      'Group.svelte': group('<Child id={label} value={`g-${useId()}`} />'),
      'App.svelte': `<script lang="ts">
  import Group from './Group.svelte';
  import { useId } from 'svelte-sonner';
  const ui = $state({ show: true });
  const top = useId();
</script>
<p id="top">{top}</p>
<Group label="a" />
{#if ui.show}<Group label="b" />{/if}
<button id="toggle" onclick={() => (ui.show = !ui.show)}>t</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'toggle' },
        { kind: 'click', id: 'toggle' },
      ]);
      const t = (i, id) => {
        const n = byId(steps[i], id);
        return n && text(n);
      };
      // App's id, then each group: its derived (computed at the child's
      // `$.prop`), then the child's own; a remounted group takes new ones.
      assert.equal(t(0, 'top'), 'bits-1');
      assert.equal(t(0, 'a'), 'g-bits-2 bits-3');
      assert.equal(t(0, 'b'), 'g-bits-4 bits-5');
      assert.equal(t(1, 'b'), undefined);
      assert.equal(t(2, 'a'), 'g-bits-2 bits-3');
      assert.equal(t(2, 'b'), 'g-bits-6 bits-7');
    },
  );
});

test('a fallback never taken (every site passes a present value) advances nothing', async () => {
  // shadcn-svelte's CommandGroup in combobox-groups: `heading={group.value}`
  // inside `{#each}`, a field TypeScript types as a string.
  await withApp(
    {
      'Child.svelte': CHILD,
      'Group.svelte': `<script lang="ts">
  import Child from './Child.svelte';
  import { useId } from 'svelte-sonner';
  let { heading }: { heading?: string } = $props();
</script>
<Child id={heading ?? 'none'} value={heading ?? \`----\${useId()}\`} />
`,
      'App.svelte': `<script lang="ts">
  import Group from './Group.svelte';
  const groups = [{ value: 'Americas' }, { value: 'Europe' }];
  const ui = $state({ n: 0 });
</script>
{#each groups as group (group.value)}<Group heading={group.value} />{/each}
<p>{ui.n}</p>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const [step] = interpret(ir, []);
      assert.equal(text(byId(step, 'Americas')), 'Americas bits-1');
      assert.equal(text(byId(step, 'Europe')), 'Europe bits-2');
    },
  );
});

test('a counter-advancing prop is rejected where Svelte computes it at another point', async () => {
  const app = `<script lang="ts">
  import Group from './Group.svelte';
  const ui = $state({ show: true });
</script>
<Group label="a" />
<button onclick={() => (ui.show = !ui.show)}>t</button>
`;
  const cases = [
    // Inside a block that renders again: Svelte's derived lives with the block.
    [
      group('{#each [1, 2] as k}<Child id={label + k} value={`g-${useId()}`} />{/each}'),
      CHILD,
      /inside a block that may render again/,
    ],
    // The child reads the prop lazily (no default): first read in its template.
    [
      group('<Child id={label} value={`g-${useId()}`} />'),
      CHILD.replace("value = ''", 'value'),
      /declares value without a default/,
    ],
    // The child advances the counter before declaring the prop.
    [
      group('<Child id={label} value={`g-${useId()}`} />'),
      `<script lang="ts">
  import { useId } from 'svelte-sonner';
  const own = useId();
  let { id, value = '' }: { id: string; value?: string } = $props();
</script>
<p {id}>{value} {own}</p>
`,
      /code before its declaration of value refers to the module state the value changes/,
    ],
    // The value also reads state: Svelte recomputes it when that changes.
    [
      group('<Child id={label} value={`${label}-${useId()}`} />'),
      CHILD,
      /globalThis.testIdCounter is mutated and read while rendering/,
    ],
    // A program without proxies tracks plain objects in derived values:
    // the counter would be a dependency.
    [
      group('<Child id={label} value={`g-${useId()}`} />'),
      CHILD,
      /a program without \$state or reactive class fields/,
      `<script lang="ts">\n  import Group from './Group.svelte';\n</script>\n<Group label="a" />\n`,
    ],
  ];
  for (const [g, child, pattern, root = app] of cases)
    await withApp({ 'Group.svelte': g, 'Child.svelte': child, 'App.svelte': root }, dir =>
      assert.rejects(lowered(dir), failWith(pattern)),
    );
});
