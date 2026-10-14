// Language rules embla-carousel's bundle needs (M6 script DOM, slice 4;
// docs/design/M6-SCRIPT-DOM.md), checked on application code against Node
// running the same module: a constant naming a function declaration of its
// block is that function (embla's `const reInit = reActivate`, before the
// `let`s the function reads); `d || {}` of a nullable dictionary object is
// the dictionary or an empty one (`options.breakpoints || {}`);
// `window.matchMedia` as a function value (`queries.map(ownerWindow.matchMedia)`),
// whose query, computed at run time, is reported unsupported where it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app with `files`; `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/embla-language-'));
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

const LOGIC = `export function factory(start: number) {
  const reset = restart;
  let count = start;
  let seen: string[] = [];
  function restart(to: number): number {
    seen.push('r' + to);
    count = to;
    return bump();
  }
  function bump(): number {
    count = count + 1;
    return count;
  }
  const self = { reset, bump, log: () => seen.join(',') };
  return self;
}
export function keys(d?: { [key: string]: number }): string {
  const m = d || {};
  return Object.keys(m).join(',') + '=' + Object.values(m).join(',');
}
export function run(k: number): string {
  const f = factory(k);
  const a = f.bump();
  const b = f.reset(10 * k);
  return [a, b, f.bump(), f.log(), keys(), keys({ x: k, y: 2 })].join(' ');
}
`;

test('a constant naming a function, `d || {}` of a dictionary and matchMedia as a value', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const dir = await mkdtemp(path.resolve('.cache/tests/embla-language-node-'));
  let want;
  try {
    await writeFile(path.join(dir, 'logic.ts'), LOGIC);
    const { run } = await import(pathToFileURL(path.join(dir, 'logic.ts')).href);
    want = [1, 2].map(run);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(want[0], '2 11 12 r10 = x,y=1,2');
  const out = await withApp(
    {
      'logic.ts': LOGIC,
      'App.svelte': `<script lang="ts">
  import { run } from './logic.ts';
  let k = $state(1);
  const queries = ['(min-width: 1px)', '(max-width: 1px)'];
  const lists = $derived(k > 1 ? queries.map(window.matchMedia) : []);
</script>
<button id="go" onclick={() => (k = k + 1)}>go</button>
<p id="out">{run(k)}</p>
<p id="media">{lists.length} {window.matchMedia('(min-width: 1px)').matches}</p>
`,
    },
    async root => {
      const { ir } = await lower(await collect(root));
      const steps = interpret(ir, []);
      const value = ir.functions.find(f => f.name === 'matchMedia');
      return {
        out: text(find(steps[0].state.dom, 'out')),
        media: text(find(steps[0].state.dom, 'media')),
        value: JSON.stringify(value.body),
      };
    },
  );
  assert.equal(out.out, want[0]);
  assert.equal(out.media, '0 true');
  // (The function value's query is known at run time only: reported there.)
  assert.match(out.value, /"op":"call"/);
});
