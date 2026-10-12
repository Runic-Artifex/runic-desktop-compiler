// Stylesheet rules no element can match (docs/CONTRACT.md, rules no element
// can match): a rejected rule is left out of the shipped stylesheet and
// reported where the program's elements (runic_ir::facts) prove that no
// element can ever match it (runic_css::unmatched); otherwise its rejection
// stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';

const FONT =
  "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n";

/** Lower a Svelte app of `files` (App.svelte the root) with `css` after the font. */
async function lowerApp(files, css) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/unmatched-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
      'style.css': FONT + css,
      'runic.json': JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
      ...files,
    };
    for (const [file, text] of Object.entries(all)) await writeFile(path.join(root, file), text);
    return await lower(await collect(root), { images: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 'skipped' where the rule `selector { content: counter(n) }` is left out, else the rejection's code. */
async function decide(files, selector) {
  try {
    const { ir, skippedRules = [] } = await lowerApp(
      files,
      `${selector} { content: counter(n) }\n`,
    );
    assert.equal(skippedRules.length, 1, selector);
    assert.ok(!ir.styles.css.includes('counter(n)'), selector);
    return 'skipped';
  } catch (e) {
    if (e.code !== 'E_CSS_PROPERTY') throw e;
    assert.deepEqual(e.source, { file: 'style.css', line: 2, column: selector.length + 4 });
    return e.code;
  }
}

test('a rule whose class no element has is left out of the stylesheet and reported', async () => {
  const { ir, skippedRules } = await lowerApp(
    { 'App.svelte': '<p class="card">x</p>\n' },
    '.card { color: red }\n.step::before { content: counter(step) }\n',
  );
  assert.deepEqual(
    skippedRules.map(r => [r.selector, r.file, r.line, r.code, r.reason]),
    [['.step::before', 'style.css', 3, 'E_CSS_PROPERTY', 'no element has the class step']],
  );
  assert.ok(!ir.styles.css.includes('.step'));
  assert.match(ir.styles.css, /\.card \{ color: red \}/);
  // The safety net: an element matching it after all is reported unsupported.
  assert.deepEqual(
    ir.styles.guards.map(g => g.selector),
    ['.step'],
  );
});

test('a class from a known set of dynamic values is checked', async () => {
  const app = {
    'App.svelte':
      "<script>\n  let on = $state(false);\n</script>\n<button class={on ? 'step' : 'idle'} onclick={() => (on = !on)}>x</button>\n",
  };
  assert.equal(await decide(app, '.step::before'), 'E_CSS_PROPERTY');
  assert.equal(await decide(app, '.idle::after'), 'E_CSS_PROPERTY');
  assert.equal(await decide(app, '.other::before'), 'skipped');
});

test('a class written from a value of any text disables class proofs', async () => {
  const app = {
    'App.svelte':
      "<script>\n  let v = $state('');\n</script>\n<input bind:value={v} />\n<p class={v}>x</p>\n",
  };
  assert.equal(await decide(app, '.other::before'), 'E_CSS_PROPERTY');
  // Other facts still hold.
  assert.equal(await decide(app, 'h1::before'), 'skipped');
  assert.equal(await decide(app, '[data-line]::before'), 'skipped');
});

test(':not(), :is(), attribute selectors and pseudo-elements', async () => {
  const app = { 'App.svelte': '<p class="card" data-state="open">x</p>\n' };
  for (const [selector, expected] of [
    // :not() and :has() never prove a rule unmatchable.
    ['.card:not(.step)::before', 'E_CSS_PROPERTY'],
    [':not(.card)::before', 'E_CSS_PROPERTY'],
    // :is()/:where() only where every argument is unmatchable.
    [':is(.step, .other)::before', 'skipped'],
    [':where(.step, .card)::before', 'E_CSS_PROPERTY'],
    // Attribute names and values.
    ['[data-state=open]::before', 'E_CSS_PROPERTY'],
    ['[data-state^=op]::before', 'E_CSS_PROPERTY'],
    ['[data-state=closed]::before', 'skipped'],
    ['[data-line]::before', 'skipped'],
    // A pseudo-element counts through its originating element, in any
    // compound of the selector.
    ['.card::after', 'E_CSS_PROPERTY'],
    ['.step .card::after', 'skipped'],
    ['p, .step::before', 'E_CSS_PROPERTY'],
  ])
    assert.equal(await decide(app, selector), expected, selector);
});

test("a component's rest props spread on an element", async () => {
  const app = {
    'Child.svelte': '<script>\n  let { ...rest } = $props();\n</script>\n<div {...rest}>c</div>\n',
    'App.svelte':
      '<script>\n  import Child from "./Child.svelte";\n</script>\n<Child class="from-parent" data-kind="x" />\n',
  };
  assert.equal(await decide(app, '.from-parent::before'), 'E_CSS_PROPERTY');
  assert.equal(await decide(app, '[data-kind=x]::before'), 'E_CSS_PROPERTY');
  assert.equal(await decide(app, '[data-kind=y]::before'), 'skipped');
  assert.equal(await decide(app, '.never::before'), 'skipped');
});
