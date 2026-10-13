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

// Collect and lower: rejections of style rules are decided once the
// program's elements are known (skipUnmatchedRules).
const build = async root => lower(await collect(root), { images: false });

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
              build(root),
              e => e instanceof Diagnostic && e.code === expected && e.source?.file === 's.css',
            )
          : build(root),
      { 's.css': css },
    );
  await check('p:first-child + p { grid-template-columns: 1fr 2fr; opacity: .5 }', undefined);
  await check(
    '@font-face{font-family:R;src:url("https://example.invalid/f.woff2") format("woff2");}',
    'E_ASSET',
  );
});

test('CSS rejects unsupported validity states with stylesheet locations', async () => {
  const states = ['valid', 'invalid', 'user-valid', 'user-invalid', 'in-range', 'out-of-range'];
  for (const state of states) {
    const escaped = `\\${state.charCodeAt(0).toString(16)} ${state.slice(1)}`;
    for (const selector of [
      `input:${state}`,
      `form:is(:not(:has(input:${state.toUpperCase()})))`,
      `input:${escaped}`,
      `input:\\${state[0]}${state.slice(1)}`,
      `input:${[...state].map(c => '\\' + c.charCodeAt(0).toString(16).padStart(6, '0')).join('')}`,
    ]) {
      await react(
        'import "./s.css";function App(){return <form noValidate><input required/></form>;}',
        async root =>
          assert.rejects(
            build(root),
            e =>
              e instanceof Diagnostic &&
              e.code === 'E_CSS' &&
              e.source?.file === 's.css' &&
              e.source.line === 2 &&
              e.source.column === 1 &&
              e.message.includes(`:${state}`),
            selector,
          ),
        { 's.css': `p { color: red }\n${selector} { color: blue }` },
      );
    }
  }
});

test('CSS validity guard distinguishes classes and literal attribute values', async () => {
  await react(
    'import "./s.css";function App(){return <input className="valid"/>;}',
    // No rejection, not even one deferred to lowering (the class valid is
    // on an element).
    async root => assert.equal((await collect(root)).pendingRules, undefined),
    {
      's.css': String.raw`.valid, .invalid, .user-valid, .user-invalid, .in-range, .out-of-range,
      .valid-extra, .field\:valid, .\76 alid, .valid/* :invalid */, [data-state=":invalid"], [data-state=':user-invalid'],
      :is(.valid):not(.invalid):has(.in-range) { color: blue }`,
    },
  );
});

test('CSS transitions and keyframe animations are accepted where the runtime reproduces them', async () => {
  const check = (css, expected, line) =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root =>
        expected
          ? assert.rejects(
              build(root),
              e =>
                e instanceof Diagnostic &&
                e.code === expected &&
                e.source?.file === 's.css' &&
                (line === undefined || e.source.line === line),
            )
          : build(root),
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
  // Blitz generates the strings of `content` only.
  await check('p::before { content: "\\201C" } p::after { content: "" }', undefined);
  await check('p::before { content: open-quote }', 'E_CSS_PROPERTY', 1);
  await check('p::before { content: counter(item) ". " }', 'E_CSS_PROPERTY', 1);
  await check('p::after { content: " (" attr(href) ")" }', 'E_CSS_PROPERTY', 1);
});

test('CSS that Stylo drops is reported unless verified equivalent in Chromium', async () => {
  const check = (css, expected, line) =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root =>
        expected
          ? assert.rejects(
              build(root),
              e =>
                e instanceof Diagnostic &&
                e.code === expected &&
                e.source?.file === 's.css' &&
                (line === undefined || e.source.line === line),
            )
          : build(root),
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
  await check('p { color: red }\np { container-type: scroll-state }', 'E_CSS_PROPERTY', 2);
  await check('p { color: red }\np::before { line-clamp: 2 }', 'E_CSS_PROPERTY', 2);
  // `field-sizing` does not apply to pseudo-elements.
  await check('p { color: red }\np::before { field-sizing: content }', undefined);
  // A declaration Stylo drops from a rule with matchable selectors is a
  // guard the app reports once the selector matches an element.
  const guards = css =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root => (await collect(root)).styleGuards,
      { 's.css': css },
    );
  assert.deepEqual(
    (await guards('p { color: red }\n.a, .b > p { line-clamp: 2 }')).map(g => g.selector),
    ['.a, .b > p'],
  );
  // Blitz sizes text areas and text-like inputs by their content; the other
  // controls Chromium sizes are reported where the rule matches one, unless
  // a later rule fixes their size.
  const unsized =
    'select, input[type=search i], input[type=number i], input[type=password i], input[type=file i]';
  assert.deepEqual(
    (await guards('.a, .b > textarea { field-sizing: content }')).map(g => g.selector),
    [`.a:is(${unsized}), .b > textarea:is(${unsized})`],
  );
  assert.deepEqual(
    (await guards(':root { --s: content }\n.a { field-sizing: var(--s) }')).map(g => g.selector),
    [`.a:is(${unsized})`],
  );
  assert.deepEqual(
    (await guards('.a { field-sizing: content }\n.a { field-sizing: fixed }')).map(g => g.unless),
    ['.a'],
  );
  assert.match(
    (await guards('.a { field-sizing: content }'))[0].message,
    /field-sizing: content \(s\.css, line 1\) applies to a select, search, number, password or file input through \.a,/,
  );
  assert.deepEqual((await guards('.a { field-sizing: fixed }')) ?? [], []);
  assert.match(
    (await guards('p { -webkit-line-clamp: 2 }'))[0].message,
    /-webkit-line-clamp: 2 \(s\.css, line 1\)/,
  );
  // Grayscale font smoothing is what both renderers draw: no guard. Values
  // asking for subpixel or no antialiasing are reported where they apply.
  assert.deepEqual(
    (
      (await guards(
        '.antialiased { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale }',
      )) ?? []
    ).map(g => g.message),
    [],
  );
  assert.deepEqual(
    (
      await guards(
        '.a { -webkit-font-smoothing: subpixel-antialiased }\n.b { -webkit-font-smoothing: none }',
      )
    ).map(g => [g.selector, /-webkit-font-smoothing: (\S+) \(s\.css/.exec(g.message)?.[1]]),
    [
      ['.a', 'subpixel-antialiased'],
      ['.b', 'none'],
    ],
  );
  // Blitz breaks lines as Chromium 153 does for `balance`, `pretty` and
  // `stable` (greedy, as `auto`): no guard, except that a balancing or pretty
  // rule is reported where it reaches a text area, whose text Blitz breaks
  // greedily, also through a var().
  assert.deepEqual(
    (
      (await guards(
        '.b { text-wrap-style: stable }\n.c { text-wrap: nowrap }\n.e { text-wrap: wrap stable }',
      )) ?? []
    ).map(g => g.message),
    [],
  );
  assert.deepEqual(
    (
      await guards(
        '.a, h1 > p { text-wrap: balance }\n.b { text-wrap-style: balance }\n' +
          '.c { --w: balance }\n.d { text-wrap: var(--w) }',
      )
    ).map(g => [g.selector, /\(s\.css, line (\d)\) applies to a text area/.exec(g.message)?.[1]]),
    [
      ['.a:is(textarea), .a textarea, h1 > p:is(textarea), h1 > p textarea', '1'],
      ['.b:is(textarea), .b textarea', '2'],
      ['.d:is(textarea), .d textarea', '4'],
    ],
  );
  assert.deepEqual(
    (
      await guards(
        '.a { text-wrap: pretty }\n.c { --w: pretty }\n.d { text-wrap: var(--w) }\n' +
          '.e { text-wrap-style: pretty }',
      )
    ).map(g => [
      g.selector,
      /\(s\.css, line (\d)\) applies to a text area through .*, and (.*)$/
        .exec(g.message)
        ?.slice(1),
    ]),
    [
      [
        '.a:is(textarea), .a textarea',
        ['1', 'Blitz does not lay out text-wrap: pretty in the text of a text area'],
      ],
      [
        '.d:is(textarea), .d textarea',
        ['3', 'Blitz does not lay out text-wrap: pretty in the text of a text area'],
      ],
      [
        '.e:is(textarea), .e textarea',
        ['4', 'Blitz does not lay out text-wrap: pretty in the text of a text area'],
      ],
    ],
  );
  await check(
    'p { color: red }\ntextarea::placeholder { text-wrap: balance }',
    'E_CSS_PROPERTY',
    2,
  );
  await check('textarea::placeholder { text-wrap-style: pretty }', 'E_CSS_PROPERTY', 1);
  await check('p::before { text-wrap: pretty }', undefined);
  await check('p::before { text-wrap: balance; text-wrap-style: stable }', undefined);
  // Not where a later rule of at least its specificity sets the property
  // (`unless`); the legacy box's clamping and orientation not where its
  // `display: -webkit-box` is overridden. Scroll margins are recognized
  // by the patched Stylo and applied by Blitz's scrollIntoView primitive.
  const fields = gs => (gs ?? []).map(g => [g.selector, g.unless, g.when]);
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
  // Scroll padding is recognized, including logical properties and calc.
  assert.deepEqual(
    fields(
      await guards(
        ':root { --s: 0.25rem }\n.l { scroll-padding-block: calc(var(--s) * 2) }\n' +
          '.m { scroll-padding: 3px }\n.n { scroll-padding-inline: 1em }',
      ),
    ),
    [],
  );
});

test('CSS filter lists are accepted where the renderers draw them', async () => {
  const check = (css, expected, line) =>
    react(
      'import "./s.css";function App(){return <p>Hi</p>;}',
      async root =>
        expected
          ? assert.rejects(
              build(root),
              e =>
                e instanceof Diagnostic &&
                e.code === expected &&
                e.source?.file === 's.css' &&
                (line === undefined || e.source.line === line),
            )
          : build(root),
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
  // (In one rule: the custom property's url() is itself rejected at once.)
  await check('p { --f: url(#x); filter: var(--f, none) }', 'E_CSS_PROPERTY', 1);
  await check('p { backdrop-filter: url(#f) }', 'E_CSS_PROPERTY', 1);
});

test('a stylesheet split off by a dynamic import is rejected at the import', async () => {
  await react(
    `import './main.css';function App(){return <p>Hi</p>;}\nimport('./lazy.js');`,
    async root =>
      assert.rejects(collect(root), e => {
        assert.equal(e.code, 'E_CSS_ORDER');
        assert.match(e.message, /lazy\.js \(loaded by a dynamic import\(\)\)/);
        assert.deepEqual(e.source, { file: 'main.jsx', line: 2, column: 1 });
        return true;
      }),
    {
      'main.css': 'p{color:blue}',
      'lazy.js': "import './lazy.css';export const lazy = 1;",
      'lazy.css': 'p{color:red}',
    },
  );
});

test('fonts of a package stylesheet Tailwind CSS inlines are recorded from their files', async () => {
  // shadcn-svelte's app.css: `@import "@fontsource-variable/geist/index.css"`.
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/collect-'));
  const font = await readFile(
    'node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2',
  );
  const files = {
    'runic.json': JSON.stringify({
      framework: 'svelte',
      entry: 'main.js',
      title: 'T',
      tailwind: true,
    }),
    'index.html':
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
    'main.js':
      "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './app.css';\nmount(App, { target: document.getElementById('root') });\n",
    'App.svelte': '<p class="font-sans">Hi</p>\n',
    'app.css':
      '@import "tailwindcss";\n@import "fontpkg/index.css";\n@theme inline { --font-sans: "F", sans-serif; }\n',
    'node_modules/fontpkg/package.json': JSON.stringify({ name: 'fontpkg', version: '1.0.0' }),
    'node_modules/fontpkg/index.css':
      '@font-face { font-family: "F"; font-weight: 100 900; src: url(./files/f.woff2) format("woff2-variations"); }\n',
  };
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    await mkdir(path.join(root, 'node_modules/fontpkg/files'));
    await writeFile(path.join(root, 'node_modules/fontpkg/files/f.woff2'), font);
    const graph = await collect(root);
    const { createHash } = await import('node:crypto');
    assert.deepEqual(graph.assets, [
      {
        path: 'node_modules/fontpkg/files/f.woff2',
        sha256: createHash('sha256').update(font).digest('hex'),
        bytes: font.length,
        mime: 'font/woff2',
      },
    ]);
    assert.match(graph.css, /src: url\("data:font\/woff2;base64,/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
