// Svelte actions (`use:`, M6 script DOM slice 4; docs/design/M6-SCRIPT-DOM.md)
// and generic function members. The interpreter runs fixture
// actions-update-svelte as conformance case `actions-update` runs it in
// Chromium: update runs when what the value reads changes, deep inside a
// proxy it is or holds at its top level (Svelte 5's deep_read_state, the
// `heap.deep-read` built-in), and not for a proxy inside a plain object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { generate, interpret } from '../compiler/codegen.mjs';

const lowered = root => collect(root).then(g => lower(g));
const byId = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n !== 'object') continue;
    if (n.attrs?.id === id) return n;
    const found = byId(n.children ?? [], id);
    if (found) return found;
  }
  return undefined;
};
const text = n => (typeof n === 'string' ? n : (n.children ?? []).map(text).join(''));

test('an action runs once, updates on deep changes of proxies it reads, and is destroyed', async () => {
  const { ir } = await lowered(path.resolve('fixtures/actions-update-svelte'));
  const { actions } = JSON.parse(readFileSync('conformance/cases/actions-update.json', 'utf8'));
  const steps = interpret(ir, actions);
  const at = (i, id, attr) => byId(steps[i].state.dom, id)?.attrs[attr];
  assert.equal(at(0, 'proxy', 'data-init'), '0 0');
  assert.equal(at(0, 'proxy', 'data-update'), undefined);
  // Deep inside the proxy value: a nested field, then a top-level one.
  assert.equal(at(1, 'proxy', 'data-update'), '1: 0 1');
  assert.equal(at(2, 'proxy', 'data-update'), '2: 1 1');
  // A proxy a plain object holds at its top level.
  assert.equal(at(3, 'holds', 'data-update'), '1: 1');
  // A proxy inside a plain object inside the value: not read.
  assert.equal(at(4, 'plain', 'data-update'), undefined);
  // A primitive: when it changes, not when the same value is set again;
  // before the component's own bindings update (the old text).
  assert.equal(at(5, 'counted', 'data-update'), '1: 1 (counted 0)');
  assert.equal(at(6, 'counted', 'data-update'), '1: 1 (counted 0)');
  assert.equal(at(7, 'counted', 'data-update'), '2: 2 (counted 1)');
  // No content before the actions and no bindings before their components:
  // the order is Svelte's, nothing is reported.
  assert.ok(steps.every(s => !s.outcome?.rejected));
  // Unrelated state.
  assert.equal(at(8, 'proxy', 'data-update'), '2: 1 1');
  // Destroyed with its component; created again with a new value.
  assert.equal(byId(steps[9].state.dom, 'proxy'), undefined);
  assert.equal(text(byId(steps[9].state.dom, 'destroyed')), 'destroyed 1');
  assert.equal(at(11, 'proxy', 'data-init'), '1 2');
  assert.equal(at(12, 'proxy', 'data-update'), '1: 1 3');
});

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/actions-'));
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
    for (const [file, t] of Object.entries(all)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), t);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a generic function member of a record has a field per instantiation the program calls', async () => {
  await withApp(
    {
      'groups.ts': `export type Grouping = { group: <T>(items: T[]) => T[][] };
export function grouping(size: number): Grouping {
  function group<T>(items: T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }
  const self: Grouping = { group };
  return self;
}
`,
      'App.svelte': `<script lang="ts">
  import { grouping } from './groups.ts';
  const g = grouping(2);
  let out = $state('');
  function run() {
    const { group } = g;
    const a = g.group([1, 2, 3]);
    const b = group(['x', 'y', 'z']);
    out = JSON.stringify(a) + JSON.stringify(b);
  }
</script>
<button id="b" onclick={run}>run</button><p id="out">{out}</p>`,
    },
    async root => {
      const { ir } = await lowered(root);
      const record = ir.records.find(r => r.fields.some(f => f.name.startsWith('group#')));
      assert.deepEqual(
        record.fields.map(f => f.name),
        ['group#0', 'group#1'],
      );
      const steps = interpret(ir, [{ kind: 'click', id: 'b' }]);
      assert.equal(text(byId(steps[1].state.dom, 'out')), '[[1,2],[3]][["x","y"],["z"]]');
    },
  );
});

test('a generic member used as a value is rejected, located', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  type Grouping = { group: <T>(items: T[]) => T[][] };
  function make(): Grouping {
    function group<T>(items: T[]): T[][] { return [items]; }
    return { group };
  }
  const g = make();
  let out = $state('');
  function run() {
    const { group } = g;
    const f = group;
    out = String(f([1]).length);
  }
</script>
<button id="b" onclick={run}>run</button><p id="out">{out}</p>`,
    },
    root =>
      assert.rejects(
        lowered(root),
        e =>
          (e instanceof Diagnostic &&
            ['E_FUNCTION', 'E_TYPE_UNSUPPORTED'].includes(e.code) &&
            e.source?.file === 'App.svelte') ||
          assert.fail(`expected a located rejection, got ${e.code}: ${e.message}`),
      ),
  );
});

test("an action's update in a pass that also updates content Svelte runs before it is reported", async () => {
  // Svelte runs the update's render effect after the blocks and components
  // before the action and before the bindings of the templates enclosing
  // its component (Chromium: it sees the new kid and blk, the old texts of
  // parent-before, own and parent-after); the IR runs it before its
  // instance's template update (gap: schedule.bindingsLast).
  await withApp(
    {
      'Kid.svelte': `<script lang="ts">let { count }: { count: number } = $props();</script><b id="kid">{count}</b>`,
      'Ord.svelte': `<script lang="ts">
  import Kid from './Kid.svelte';
  let { count }: { count: number } = $props();
  function act(node: HTMLElement, v: number) {
    return { update(n: number) { node.setAttribute('data-seen', node.textContent ?? ''); } };
  }
</script>
<div id="ord" use:act={count}><Kid {count} /><span id="own">{count}</span></div>`,
      'Plain.svelte': `<script lang="ts">
  let { count }: { count: number } = $props();
  function act(node: HTMLElement, v: number) {
    return { update(n: number) { node.setAttribute('data-seen', node.textContent ?? ''); } };
  }
</script>
<p id="plain" use:act={count}>{count}</p>`,
      'App.svelte': `<script lang="ts">
  import Ord from './Ord.svelte';
  import Plain from './Plain.svelte';
  let count = $state(0);
  let other = $state(0);
</script>
<Plain count={other} /><p id="before">{count}</p><Ord {count} /><button id="inc" onclick={() => count++}>inc</button><button id="other" onclick={() => other++}>other</button>`,
    },
    async root => {
      const { ir } = await lowered(root);
      const orders = [];
      const walk = v => {
        if (!v || typeof v !== 'object') return;
        if (v.op === 'builtin' && v.name === 'effect.after-content')
          orders.push(v.args.map(a => a.value));
        for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
      };
      walk(ir.functions);
      // Ord: a component before its action, a binding before it in App;
      // Plain: neither.
      assert.deepEqual(orders.sort(), [
        [false, false],
        [true, true],
      ]);
      const [, other] = interpret(ir, [{ kind: 'click', id: 'other' }]);
      assert.ok(!other.outcome?.rejected, JSON.stringify(other.outcome));
      assert.equal(byId(other.state.dom, 'plain').attrs['data-seen'], '0');
      const [, inc] = interpret(ir, [{ kind: 'click', id: 'inc' }]);
      assert.match(inc.outcome?.rejected?.message ?? '', /effect\.after-content/);
      assert.match(generate(ir), /let a0 = true; let a1 = true; cx\.after_content\(a0, a1\)/);
    },
  );
});
