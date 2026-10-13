// An array literal of primitives of several types joined at once
// (`[count, label, done].join(' ')`): an IR array holds one type, so the
// join is lowered as JavaScript computes it (the elements in order, then the
// separator, `,` where it is left out or undefined; ToString per element,
// null and undefined as the empty string). Such a literal used otherwise is
// rejected at its element (it produced invalid IR before, E_IR). The expected
// values are Node's, running the same code (TypeScript stripped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files`; `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/join-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
      'style.css':
        "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
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
const find = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const f = find(n.children, id);
    if (f) return f;
  }
};

const LOGIC = `export function view(n: number): string {
  const log: string[] = [];
  const note = (s: string): string => {
    log.push(s);
    return s;
  };
  const label: string = 'x' + n;
  const missing: number | undefined = n > 2 ? n : undefined;
  const none: string | null = n > 1 ? null : 'set';
  return [
    [n, label, n > 1].join(' '),
    [n, label, missing, none, null, undefined].join('/'),
    [n, 'a'].join(),
    [label, n * 1.5, -0, NaN, true].join(undefined),
    [note('a' + n), n, note('b')].join(note('-')),
    log.join(''),
  ].join(' | ');
}
`;

test('a literal of several primitive types joined at once is joined as in JavaScript', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const dir = await mkdtemp(path.resolve('.cache/tests/join-node-'));
  let expected;
  try {
    await writeFile(path.join(dir, 'logic.ts'), LOGIC);
    const { view } = await import(pathToFileURL(path.join(dir, 'logic.ts')).href);
    expected = [1, 2, 3].map(view);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const got = await withApp(
    {
      'logic.ts': LOGIC,
      'App.svelte': `<script lang="ts">
  import { view } from './logic.ts';
  let n = $state(1);
</script>
<button id="go" onclick={() => (n = n + 1)}>go</button>
<p id="out">{view(n)}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, [
        { kind: 'click', id: 'go' },
        { kind: 'click', id: 'go' },
      ]);
      return steps.map(s => text(find(s.state.dom, 'out')));
    },
  );
  assert.deepEqual(got, expected);
});

test('such a literal used otherwise is rejected at its element', async () => {
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  let n = $state(1);
  const label: string = 'x';
  function view(n: number): string {
    const xs = [n, label];
    return String(xs.length);
  }
</script>
<p id="out">{view(n)}</p>
`,
    },
    root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        e =>
          (e instanceof Diagnostic &&
            e.code === 'E_ARRAY' &&
            e.source?.file === 'App.svelte' &&
            e.source.line === 5 &&
            /an array holds values of one type/.test(e.message)) ||
          assert.fail(`${e.code} ${JSON.stringify(e.source)}: ${e.message}`),
      ),
  );
});
