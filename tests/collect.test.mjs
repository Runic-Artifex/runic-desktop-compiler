// The Vite collector and the build command: HTML/CSS/asset policy, parse
// diagnostics and atomic output replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { repository } from '../compiler/codegen.mjs';

async function react(source, run, files = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/collect-'));
  try {
    await writeFile(
      path.join(root, 'runic.json'),
      JSON.stringify({ entry: 'main.jsx', title: 'T' }),
    );
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>',
    );
    await writeFile(
      path.join(root, 'main.jsx'),
      `import React from 'react';import {createRoot} from 'react-dom/client';${source}\ncreateRoot(document.getElementById('root')).render(<App/>);`,
    );
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('inline HTML scripts are rejected', async () => {
  await react('function App(){return <p>Hi</p>;}', async root => {
    const file = path.join(root, 'index.html');
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        '</body>',
        '<script>window.sideEffect=1;</script></body>',
      ),
    );
    await assert.rejects(collect(root), e => e.code === 'E_HTML');
  });
});

test('CSS keeps entry import order', async () => {
  const files = { 'a.css': 'body{color:red}', 'b.css': 'body{color:blue}' };
  const css = order =>
    react(
      `${order.map(f => `import "./${f}";`).join('')}function App(){return <p>Hi</p>;}`,
      async root => (await collect(root)).css,
      files,
    );
  const ba = await css(['b.css', 'a.css']);
  assert.ok(ba.indexOf('blue') < ba.indexOf('red'));
  const ab = await css(['a.css', 'b.css']);
  assert.ok(ab.indexOf('red') < ab.indexOf('blue'));
});

test('CSS accepts ordinary properties and selectors but not remote assets', async () => {
  const check = (css, expected) =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root =>
        expected
          ? assert.rejects(
              collect(root),
              e => e instanceof Diagnostic && e.code === expected && e.source?.file === 's.css',
            )
          : collect(root),
      { 's.css': css },
    );
  await check('p:first-child + p { grid-template-columns: 1fr 2fr; opacity: .5 }', undefined);
  await check(
    '@font-face{font-family:R;src:url("https://example.invalid/f.woff2") format("woff2");}',
    'E_ASSET',
  );
});

test('CSS transitions and keyframe animations are accepted where the runtime reproduces them', async () => {
  const check = (css, expected, line) =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root =>
        expected
          ? assert.rejects(
              collect(root),
              e =>
                e instanceof Diagnostic &&
                e.code === expected &&
                e.source?.file === 's.css' &&
                (line === undefined || e.source.line === line),
            )
          : collect(root),
      { 's.css': css },
    );
  await check(
    '@keyframes spin { to { transform: rotate(360deg) } }\n' +
      '@keyframes enter { from { opacity: var(--enter-opacity, 0) } }\n' +
      'p { transition: color 150ms ease, background-color 150ms; animation: spin 1s linear infinite }\n' +
      'b { animation: enter .2s ease-out .1s backwards; transition-property: transform; transition-duration: .3s }',
    undefined,
  );
  // Stylo discards a finished animation on the next restyle: no forwards fill,
  // also not through a custom property the stylesheet sets anywhere.
  await check('p { color: red }\np { animation: spin 1s forwards }', 'E_CSS_PROPERTY', 2);
  await check('p { animation-fill-mode: both }', 'E_CSS_PROPERTY', 1);
  await check(
    '@property --fill { syntax: "*"; inherits: false; initial-value: none; }\n' +
      'p { animation: spin 1s var(--fill, none) }\n.keep { --fill: forwards }',
    'E_CSS_PROPERTY',
    2,
  );
  await check(
    '@property --fill { syntax: "*"; inherits: false; initial-value: none; }\np { animation: spin 1s var(--fill, none) }',
    undefined,
  );
  await check('p { transition: display 1s allow-discrete }', 'E_CSS_PROPERTY', 1);
  await check('p { animation-timeline: scroll() }', 'E_CSS_PROPERTY', 1);
  await check('@starting-style { p { opacity: 0 } }', 'E_CSS', 1);
});

test('CSS that Stylo drops is reported unless verified equivalent in Chromium', async () => {
  const check = (css, expected, line) =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root =>
        expected
          ? assert.rejects(
              collect(root),
              e =>
                e instanceof Diagnostic &&
                e.code === expected &&
                e.source?.file === 's.css' &&
                (line === undefined || e.source.line === line),
            )
          : collect(root),
      { 's.css': css },
    );
  // Accepted: cascade layers, registered properties, @supports, :has(),
  // modern colours, and drops verified equivalent in Chromium.
  await check(
    '@layer base, components;\n@layer base { p { color: oklch(0.5 0.1 200) } }\n' +
      '@property --tw-x { syntax: "<length>"; inherits: false; initial-value: 0px; }\n' +
      '@supports (color: color-mix(in oklab, red, blue)) { p { color: color-mix(in oklab, red 50%, blue) } }\n' +
      'p:has(> b) { color: red }\np::-webkit-scrollbar { display: none }\n' +
      '@media (prefers-reduced-motion: reduce) { p { color: red } }\n' +
      'p { -webkit-tap-highlight-color: transparent; resize: none }\n' +
      '.c { container: card / inline-size }\n.d { container-type: size }\n' +
      '@container card (width > 10px) { p { color: blue } }\n@container (min-width: 20rem) { p { color: red } }',
    undefined,
  );
  // Reported, with the line of the rule or declaration.
  await check('p { color: red }\n@container style(--x: 1) { p { color: blue } }', 'E_CSS', 2);
  await check('p { color: red }\n.c { container-type: scroll-state }', 'E_CSS_PROPERTY', 2);
  await check('p { color: red }\np::before { field-sizing: content }', 'E_CSS_PROPERTY', 2);
  // A declaration Stylo drops from a rule with matchable selectors is a
  // guard the app reports once the selector matches an element.
  const guards = css =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root => (await collect(root)).styleGuards,
      { 's.css': css },
    );
  assert.deepEqual(
    (await guards('p { color: red }\n.a, .b > p { field-sizing: content }')).map(g => g.selector),
    ['.a, .b > p'],
  );
  assert.match(
    (await guards('p { -webkit-line-clamp: 2 }'))[0].message,
    /-webkit-line-clamp: 2 \(s\.css, line 1\)/,
  );
  // Not where a later rule of at least its specificity sets the property
  // (`unless`); the legacy box's clamping and orientation not where its
  // `display: -webkit-box` is overridden; scroll margins only for an
  // element scrolled into view.
  const fields = gs => gs.map(g => [g.selector, g.unless, g.when]);
  assert.deepEqual(
    fields(
      await guards(
        '.a { -webkit-line-clamp: 1; -webkit-box-orient: vertical; display: -webkit-box }\n' +
          '.a { display: flex }\n.b { scroll-margin-top: 4px }',
      ),
    ),
    [
      ['.a', '.a', undefined],
      ['.a', '.a', undefined],
      ['.a', '.a', undefined],
      ['.b', undefined, 'scroll-target'],
    ],
  );
  // (A later rule of lower specificity overrides nothing.)
  assert.deepEqual(
    fields(
      await guards('.x .a { display: -webkit-box; -webkit-line-clamp: 1 }\n.a { display: flex }'),
    ),
    [
      ['.x .a', undefined, undefined],
      ['.x .a', undefined, undefined],
    ],
  );
  // Scroll paddings only for a target scrolled into view inside their
  // container, with the padding in pixels where the stylesheet gives a
  // length (through a custom property declared once, rem as 16px).
  assert.deepEqual(
    fields(
      await guards(
        ':root { --s: 0.25rem }\n.l { scroll-padding-block: calc(var(--s) * 2) }\n' +
          '.m { scroll-padding: 3px }\n.n { scroll-padding-inline: 1em }',
      ),
    ),
    [
      ['.l', undefined, 'scroll-container:block:8'],
      ['.m', undefined, 'scroll-container:both:3'],
      ['.n', undefined, 'scroll-container:inline:'],
    ],
  );
});

test('CSS filter lists are accepted where the renderers draw them', async () => {
  const check = (css, expected, line) =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root =>
        expected
          ? assert.rejects(
              collect(root),
              e =>
                e instanceof Diagnostic &&
                e.code === expected &&
                e.source?.file === 's.css' &&
                (line === undefined || e.source.line === line),
            )
          : collect(root),
      { 's.css': css },
    );
  await check(
    'p { filter: blur(2px) brightness(1.2) contrast(80%) grayscale(1) hue-rotate(90deg) invert(.5) opacity(.4) saturate(2) sepia(1) }\n' +
      'b { filter: drop-shadow(2px 4px 6px rgb(0 0 0 / .5)) drop-shadow(red 1px 1px); transition: filter .2s }\n' +
      '@keyframes glow { to { filter: brightness(1.5) } }\ni { filter: none }\n' +
      'u { backdrop-filter: blur(8px) saturate(1.5); -webkit-backdrop-filter: blur(8px) saturate(1.5) }',
    undefined,
  );
  // Tailwind's composition through custom properties: every value is checked.
  await check(
    ':root { --drop-shadow-md: 0 3px 3px rgb(0 0 0 / 0.12) }\n' +
      '.a { --tw-blur: blur(8px); filter: var(--tw-blur,) var(--tw-drop-shadow,) }\n' +
      '.b { --tw-drop-shadow: drop-shadow(var(--drop-shadow-md)) }\n' +
      '.c { --tw-drop-shadow: drop-shadow(0 1px 1px var(--tw-drop-shadow-color, rgb(0 0 0 / .05))) }\n' +
      '.d { --tw-drop-shadow-color: oklch(63.7% 0.237 25.331) }',
    undefined,
  );
  // SVG filter references; drop shadows in currentColor are drawn in the
  // element's color (the Blitz fork).
  await check('p { color: red }\np { filter: url(#f) }', 'E_CSS_PROPERTY', 2);
  await check(
    'p { filter: drop-shadow(2px 2px 4px) }\nb { filter: blur(1px) drop-shadow(currentColor 2px 2px) }\n' +
      '.a { --c: currentColor }\n.b { filter: drop-shadow(1px 1px var(--c, red)) }',
    undefined,
  );
  await check('.a { --f: url(#x) }\n.b { filter: var(--f, none) }', 'E_CSS_PROPERTY', 2);
  await check('p { backdrop-filter: url(#f) }', 'E_CSS_PROPERTY', 1);
});

test('malformed Svelte source reports a located parse error', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/svelte-'));
  try {
    await cp('fixtures/counter-svelte', root, { recursive: true });
    const file = path.join(root, 'App.svelte');
    const source = await readFile(file, 'utf8');
    await writeFile(file, source.replace('<script>', "<script>\nimport './style.css';"));
    const g = await collect(root);
    assert.ok(g.modules.get(file).imports.some(e => e.specifier === './style.css'));
    assert.equal((await lower(g)).ir.meta.frontend.adapter, 'svelte');
    await writeFile(file, source.replace('{/if}', ''));
    await assert.rejects(
      collect(root),
      e => e instanceof Diagnostic && e.code === 'E_PARSE' && e.source.file === 'App.svelte',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed native build preserves the existing output directory', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/build-'));
  try {
    const out = path.join(root, 'out');
    await mkdir(out);
    await writeFile(path.join(out, 'runic-app'), 'previous binary');
    // Only the application build fails; the backend itself still builds.
    const cargo = spawnSync('sh', ['-c', 'command -v cargo'], { encoding: 'utf8' }).stdout.trim();
    await writeFile(
      path.join(root, 'cargo'),
      `#!/bin/sh\ncase "$*" in *runic-app*) exit 1;; esac\nexec ${cargo} "$@"\n`,
      { mode: 0o755 },
    );
    const run = spawnSync(
      process.execPath,
      ['compiler/cli.mjs', 'build', 'fixtures/smoke', '--out', out],
      {
        cwd: repository,
        env: { ...process.env, PATH: root + ':' + process.env.PATH },
        encoding: 'utf8',
      },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /E_BUILD/);
    assert.equal(await readFile(path.join(out, 'runic-app'), 'utf8'), 'previous binary');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
