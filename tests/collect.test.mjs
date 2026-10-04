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

test('CSS accepts ordinary properties and selectors but not time-based behaviour or remote assets', async () => {
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
  await check('p { transition: color 1s }', 'E_CSS_PROPERTY');
  await check('@keyframes spin { from { color: red } }', 'E_CSS');
  await check(
    '@font-face{font-family:R;src:url("https://example.invalid/f.woff2") format("woff2");}',
    'E_ASSET',
  );
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
      'p { -webkit-tap-highlight-color: transparent; resize: none }',
    undefined,
  );
  // Reported, with the line of the rule or declaration.
  await check('p { color: red }\n@container (width > 10px) { p { color: blue } }', 'E_CSS', 2);
  await check('p { color: red }\np { field-sizing: content }', 'E_CSS_PROPERTY', 2);
  await check('p { -webkit-line-clamp: 2 }', 'E_CSS_PROPERTY', 1);
  await check('p { filter: blur(2px) }', 'E_CSS_PROPERTY', 1);
  await check('p { backdrop-filter: blur(2px) }', 'E_CSS_PROPERTY', 1);
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
