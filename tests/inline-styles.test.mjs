// Inline styles get the CSS checks stylesheets get (runic_css::inline,
// docs/CONTRACT.md): a literal declaration a stylesheet would be rejected for
// is rejected at build time (E_CSS_PROPERTY at the element); one a stylesheet
// would report where its rule applies, and any value known only at run time,
// is reported when the style is set (the interpreter here, the runtime alike).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** An app of `files` for `framework`; `run` gets its root. */
async function withApp(framework, files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/inline-styles-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const entry = framework === 'svelte' ? 'main.js' : 'main.jsx';
    const all = {
      'index.html': `<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,
      'style.css':
        "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
      'runic.json': JSON.stringify({ framework, entry, title: 'T' }),
      ...(framework === 'svelte'
        ? {
            'main.js':
              "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
          }
        : {}),
      ...files,
    };
    for (const [file, text] of Object.entries(all)) await writeFile(path.join(root, file), text);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lowered = root => collect(root).then(g => lower(g));
const svelte = (app, run) => withApp('svelte', { 'App.svelte': app }, run);

/** The outcome of mounting and the actions: its unsupported report, if any. */
const reported = (ir, actions = []) => {
  let text;
  try {
    text = JSON.stringify(interpret(ir, actions).map(s => s.outcome));
  } catch (e) {
    // Reported at the mount.
    text = e.message;
  }
  return /unsupported: (the inline style declaration [^"\n]*)/.exec(text)?.[1];
};

test('literal inline declarations a stylesheet would be rejected for are rejected at build time', async () => {
  for (const [app, pattern] of [
    ['<div id="a" style="animation: spin 1s forwards">A</div>', /animation: spin 1s forwards/],
    ['<div id="a" style="color: red; filter: url(#f)">A</div>', /filter: url\(#f\)/],
    ['<div id="a" style:animation-timeline="scroll()">A</div>', /animation-timeline: scroll\(\)/],
    ['<p id="a" style="text-transform: full-width">A</p>', /text-transform: full-width/],
  ])
    await svelte(app, root =>
      assert.rejects(
        lowered(root),
        e =>
          (e instanceof Diagnostic &&
            e.code === 'E_CSS_PROPERTY' &&
            e.source?.file === 'App.svelte' &&
            pattern.test(e.message)) ||
          assert.fail(`${app}: ${e.code} ${e.message}`),
      ),
    );
});

test('inline declarations a stylesheet would report are reported when set', async () => {
  // Static: at mount (the interpreter surfaces what the mount reported with
  // the next action's outcome; the runtime reports it at the mount).
  const click = [{ kind: 'click', id: 'b' }];
  await svelte(
    '<div id="a" style="color: red; text-shadow: 0 1px 2px red">A</div><button id="b" onclick={() => {}}>B</button>',
    async root =>
      assert.match(
        reported((await lowered(root)).ir, click),
        /text-shadow: 0 1px 2px red \(Blitz does not paint text shadows\)/,
      ),
  );
  await svelte(
    '<div id="a" style="-webkit-text-stroke: 1px red">A</div><button id="b" onclick={() => {}}>B</button>',
    async root =>
      assert.match(
        reported((await lowered(root)).ir, click),
        /-webkit-text-stroke: 1px red \(Blitz's style engine \(Stylo\) does not support it\)/,
      ),
  );
  // Known only at run time: when the value is set, whatever its kind.
  await svelte(
    `<script lang="ts">let fill = $state('none');</script>
<div id="a" style:animation-fill-mode={fill}>A</div>
<button id="b" onclick={() => (fill = 'forwards')}>B</button>`,
    async root => {
      const { ir } = await lowered(root);
      assert.equal(reported(ir), undefined);
      assert.match(
        reported(ir, [{ kind: 'click', id: 'b' }]),
        /animation-fill-mode: forwards \(animation-fill-mode forwards and both are not supported\)/,
      );
    },
  );
  // React style objects.
  await withApp(
    'react',
    {
      'main.jsx': `import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
function App() {
  return (
    <>
      <div id="a" style={{ textShadow: '1px 1px red' }}>A</div>
      <button id="b" onClick={() => {}}>B</button>
    </>
  );
}
createRoot(document.getElementById('root')).render(<App />);
`,
    },
    async root =>
      assert.match(reported((await lowered(root)).ir, click), /text-shadow: 1px 1px red/),
  );
});

test('inline declarations verified equivalent are neither rejected nor reported', async () => {
  await svelte(
    '<div id="a" style="position: -webkit-sticky; position: sticky; top: 0; -moz-column-gap: 1px; column-gap: 2px; -webkit-tap-highlight-color: transparent; text-shadow: none; p-a-d-d-i-n-g: 2px">A</div><button id="b" onclick={() => {}}>B</button>',
    async root =>
      assert.equal(reported((await lowered(root)).ir, [{ kind: 'click', id: 'b' }]), undefined),
  );
  // A template building a number past its range (shadcn-svelte's progress
  // indicator with a value above its maximum): `translateX(--25%)`, which
  // Chromium drops too (measured, chromium-grammar.txt). A function Stylo
  // lacks stays reported.
  await svelte(
    `<script lang="ts">let value = $state(50); let size = $state('10px');</script>
<div id="a" style="transform: translateX(-{100 - value}%); width: {size}">A</div>
<button id="b" onclick={() => (value = 125)}>B</button>
<button id="c" onclick={() => (size = 'calc-size(auto, size)')}>C</button>`,
    async root => {
      const { ir } = await lowered(root);
      assert.equal(
        reported(ir, [
          { kind: 'click', id: 'b' },
          { kind: 'click', id: 'b' },
        ]),
        undefined,
      );
      assert.match(
        reported(ir, [{ kind: 'click', id: 'c' }]),
        /width: calc-size\(auto, size\) \(Blitz's style engine \(Stylo\) does not support it\)/,
      );
    },
  );
});
