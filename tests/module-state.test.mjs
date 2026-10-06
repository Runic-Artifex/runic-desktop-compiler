// Module state (M6: bits-ui's scroll lock and keyboard tracking): module-level
// `let` variables, `$state` ones reactive as Svelte's module state.
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
  const root = await mkdtemp(path.resolve('.cache/tests/module-state-'));
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

test('module variables: plain, $state (reactive) and untyped JavaScript ones', async () => {
  await withApp(
    {
      'ids.ts': `let count = 0;
export function nextId(): string {
  count += 1;
  return 'id-' + count;
}
`,
      'keyboard.svelte.ts': `let usingKeyboard = $state(false);
export class Keyboard {
  get current() {
    return usingKeyboard;
  }
  set current(v: boolean) {
    usingKeyboard = v;
  }
}
`,
      'lock.js': `let cleanupTimeoutId = null;
let scheduledAt = null;
export function schedule() {
  cleanupTimeoutId = 7;
  scheduledAt = 'now';
}
export function status() {
  return String(cleanupTimeoutId) + ' ' + String(scheduledAt);
}
`,
      'App.svelte': `<script lang="ts">
  import { nextId } from './ids';
  import { Keyboard } from './keyboard.svelte';
  import { schedule, status } from './lock.js';
  const a = nextId();
  const b = nextId();
  const keyboard = new Keyboard();
  let lock = $state('');
</script>

<p id="ids">{a} {b}</p>
<p id="kb">{keyboard.current}</p>
<p id="lock">{lock}</p>
<button id="toggle" onclick={() => (keyboard.current = !keyboard.current)}>t</button>
<button id="schedule" onclick={() => { lock = status(); schedule(); lock += ' / ' + status(); }}>s</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'toggle' },
        { kind: 'click', id: 'schedule' },
      ]);
      const t = (i, id) => text(byId(steps[i].state.dom, id));
      assert.equal(t(0, 'ids'), 'id-1 id-2');
      assert.equal(t(0, 'kb'), 'false');
      assert.equal(t(1, 'kb'), 'true');
      assert.equal(t(2, 'lock'), 'null null / 7 now');
    },
  );
});

test('a template reading a plain module variable that changes is rejected (E_REACTIVITY)', async () => {
  await withApp(
    {
      'ids.ts': `let count = 0;
export function bump(): void {
  count += 1;
}
export function current(): number {
  return count;
}
`,
      'App.svelte': `<script lang="ts">
  import { bump, current } from './ids';
</script>

<p>{current()}</p>
<button onclick={bump}>b</button>
`,
    },
    root => assert.rejects(lowered(root), failWith('E_REACTIVITY')),
  );
});
