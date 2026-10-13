// $effect.root (M6: bits-ui's SharedState and keyboard tracking): effects that
// belong to a root, not to an instance, until the root is destroyed.
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
  const root = await mkdtemp(path.resolve('.cache/tests/effect-root-'));
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

test('$effect.root: its effects track state until the root is destroyed', async () => {
  await withApp(
    {
      // (The log is written untracked, as in case effect-root: push reads
      // the length, and an effect writing what it read runs again in
      // Svelte, case effect-self.)
      'log.svelte.ts': `import { untrack } from 'svelte';
export let log = $state<string[]>([]);
let count = $state(0);
function note(line: string) {
  untrack(() => {
    log.push(line);
  });
}
export function bump() {
  count++;
}
export function start(): () => void {
  return $effect.root(() => {
    $effect(() => {
      note('run ' + count);
      return () => {
        note('cleanup');
      };
    });
    return () => {
      note('root destroyed');
    };
  });
}
`,
      'App.svelte': `<script lang="ts">
  import { log, bump, start } from './log.svelte';
  let stop = start();
</script>

<p id="log">{log.join(', ')}</p>
<button id="bump" onclick={bump}>bump</button>
<button id="stop" onclick={() => stop()}>stop</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'bump' },
        { kind: 'click', id: 'stop' },
        { kind: 'click', id: 'bump' },
      ]);
      const t = i => text(byId(steps[i].state.dom, 'log'));
      assert.equal(t(0), 'run 0');
      assert.equal(t(1), 'run 0, cleanup, run 1');
      assert.equal(t(2), 'run 0, cleanup, run 1, cleanup, root destroyed');
      assert.equal(t(3), 'run 0, cleanup, run 1, cleanup, root destroyed');
    },
  );
});

test('an effect created while an effect runs is its child', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  const log: string[] = [];
  let count = $state(0);
  let shown = $state('');
  $effect(() => {
    const n = count;
    log.push('outer ' + n);
    $effect(() => {
      log.push('inner ' + n);
      return () => {
        log.push('inner cleanup ' + n);
      };
    });
  });
</script>

<p id="log">{shown}</p>
<button id="bump" onclick={() => count++}>bump</button>
<button id="show" onclick={() => (shown = log.join(', '))}>show</button>
`,
    },
    async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [
        { kind: 'click', id: 'show' },
        { kind: 'click', id: 'bump' },
        { kind: 'click', id: 'show' },
      ]);
      const t = i => text(byId(steps[i].state.dom, 'log'));
      assert.equal(t(1), 'outer 0, inner 0');
      assert.equal(t(3), 'outer 0, inner 0, inner cleanup 0, outer 1, inner 1');
    },
  );
});
