// <form> (M6 overlays, shadcn's dialog-demo wraps its dialog in one): it renders;
// canceled submission is modelled; uncanceled defaults and reset are reported
// where button activation would perform them.
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
  const root = await mkdtemp(path.resolve('.cache/tests/form-'));
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

const APP = `<script lang="ts">
  let n = $state(0);
</script>

<form>
  <p id="out">{n}</p>
  <button id="plain" type="button" onclick={() => n++}>plain</button>
  <button id="submit" onclick={() => n++}><span id="inner">save</span></button>
  <button id="reset" type="reset">reset</button>
  <button id="cancelled" type="submit" onclick={e => e.preventDefault()}>cancelled</button>
</form>
`;

test('a form renders; its buttons of type button act as elsewhere', async () => {
  await withApp({ 'App.svelte': APP }, async root => {
    const { ir } = await lowered(root);
    const steps = interpret(ir, [
      { kind: 'click', id: 'plain' },
      { kind: 'click', id: 'cancelled' },
    ]);
    assert.equal(steps[0].state.dom[0].tag, 'form');
    assert.equal(text(steps[2].state.dom[0].children.find(c => c.attrs?.id === 'out')), '1');
  });
});

test('uncanceled submission defaults and reset by a button remain unsupported', async () => {
  for (const id of ['submit', 'inner', 'reset'])
    await withApp({ 'App.svelte': APP }, async root => {
      const { ir } = await lowered(root);
      const steps = interpret(ir, [{ kind: 'click', id }]);
      assert.deepEqual(
        steps[1].outcome,
        {
          rejected: {
            code: 'E_THROW',
            message:
              id === 'reset'
                ? 'RunicUnsupportedError: form reset'
                : 'RunicUnsupportedError: uncanceled form submission (navigation, form data or dialog default)',
          },
        },
        id,
      );
    });
});
