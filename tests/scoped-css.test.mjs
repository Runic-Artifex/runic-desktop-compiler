// Authored component CSS uses the shared guards before framework scoping.
// Vite compilation checks scoped admission without invoking native codegen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { collect, collectionPlugin, Diagnostic } from '../compiler/collect.mjs';
import { frontendTooling } from '../compiler/adapters/tooling.mjs';

async function component(framework, source, run, files = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/scoped-css-'));
  const config = { framework, entry: 'main.js', title: 'Scoped CSS' };
  const file = `App.${framework}`;
  try {
    await writeFile(path.join(root, 'runic.json'), JSON.stringify(config));
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
    );
    await writeFile(
      path.join(root, 'main.js'),
      framework === 'vue'
        ? `import { createApp } from 'vue'; import App from './${file}'; createApp(App).mount('#root');`
        : `import { mount } from 'svelte'; import App from './${file}'; mount(App, { target: document.getElementById('root') });`,
    );
    await writeFile(path.join(root, file), source);
    for (const [file, content] of Object.entries(files))
      await writeFile(path.join(root, file), content);
    return await run(root, config);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function compiledCSS(root, config) {
  const tooling = await frontendTooling(root, config);
  const modules = new Map();
  const bundled = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [collectionPlugin(root, modules, tooling), ...tooling.plugins],
    build: { write: false, minify: false },
  });
  assert.ok(modules.has(path.join(root, `App.${config.framework}`)));
  const css = bundled.output.find(
    output => output.type === 'asset' && output.fileName.endsWith('.css'),
  );
  assert.ok(css, 'the actual framework compiler emitted component CSS');
  return String(css.source);
}

function source(framework, selector) {
  return framework === 'vue'
    ? `<script setup>
const label = 'Name';
</script>

<template>
  <form novalidate><label>{{label}}<input required /></label></form>
</template>

<style scoped>
  label { color: black }
  ${selector} { color: red }
</style>`
    : `<script>
  const label = 'Name';
</script>

<form novalidate>
  <label>{label}<input required /></label>
</form>

<style>
  label { color: black }
  ${selector} { color: red }
</style>`;
}

for (const framework of ['vue', 'svelte']) {
  test(`${framework} scoped validity selectors reject at authored component coordinates`, async () => {
    for (const state of [
      'valid',
      'invalid',
      'user-valid',
      'user-invalid',
      'in-range',
      'out-of-range',
    ]) {
      for (const selector of [`input:${state}`, `form:has(input:${state})`]) {
        await component(framework, source(framework, selector), async root => {
          await assert.rejects(
            collect(root),
            error => {
              assert.ok(error instanceof Diagnostic);
              assert.equal(error.code, 'E_CSS');
              assert.deepEqual(error.source, { file: `App.${framework}`, line: 11, column: 3 });
              assert.ok(error.message.includes(`:${state}`));
              return true;
            },
            selector,
          );
        });
      }
    }
  });

  test(`${framework} supported scoped CSS compiles through the authored guards`, async () => {
    await component(framework, source(framework, 'input:focus'), async (root, config) => {
      const css = await compiledCSS(root, config);
      assert.match(css, /input[^{}]*:focus|input:focus[^{}]*/);
      assert.match(css, framework === 'vue' ? /data-v-/ : /svelte-/);
      assert.match(css, /color:\s*red/);
    });
  });
}

test('Vue checks later scoped blocks and same-line selectors at their authored offsets', async () => {
  const authored = `<template><input /></template>
<style>input { color: black }</style>

<style scoped>  input:invalid { color: red }</style>`;
  await component('vue', authored, root =>
    assert.rejects(collect(root), error => {
      assert.ok(error instanceof Diagnostic);
      assert.equal(error.code, 'E_CSS');
      assert.deepEqual(error.source, { file: 'App.vue', line: 4, column: 17 });
      return true;
    }),
  );
});

test('Vue scoped external validity CSS rejects at the actual stylesheet location', async () => {
  await component(
    'vue',
    `<template><form novalidate><input required /></form></template>
<style scoped src="./validity.css"></style>`,
    root =>
      assert.rejects(collect(root), error => {
        assert.ok(error instanceof Diagnostic);
        assert.equal(error.code, 'E_CSS');
        assert.deepEqual(error.source, { file: 'validity.css', line: 3, column: 5 });
        return true;
      }),
    { 'validity.css': 'input { color: black }\n\n    input:user-invalid { color: red }' },
  );
});

test('Vue supported scoped external CSS keeps its existing compilation admission', async () => {
  await component(
    'vue',
    `<template><input /></template>
<style scoped src="./supported.css"></style>`,
    async (root, config) => {
      const css = await compiledCSS(root, config);
      assert.match(css, /input[^{}]*:focus|input:focus[^{}]*/);
      assert.match(css, /data-v-/);
      assert.match(css, /color:\s*red/);
    },
    { 'supported.css': 'input:focus { color: red }' },
  );
});
