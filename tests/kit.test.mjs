// SvelteKit apps (M6 step 8, docs/design/M6-SVELTEKIT.md): collection without
// running the app's Vite or Svelte configuration, the route manifest from Kit's
// own code, and located rejections of what the native router does not cover.
// Behaviour against a real Kit build in Chromium is checked by the conformance
// cases kit-hash, kit-routes and kit-routes-missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { generate } from '../compiler/codegen.mjs';

const FIXTURE = 'fixtures/kit-routes-svelte';

/**
 * A copy of the kit-routes fixture with `files` written (a function edits the
 * existing text, null deletes the file); `run` gets its root.
 */
async function withKit(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/kit-'));
  try {
    await cp(FIXTURE, root, {
      recursive: true,
      filter: src => !/[\\/](\.svelte-kit|build|node_modules)$/.test(src),
    });
    for (const [file, text] of Object.entries(files)) {
      const full = path.join(root, file);
      if (text === null) {
        await rm(full, { force: true });
        continue;
      }
      await mkdir(path.dirname(full), { recursive: true });
      const next = typeof text === 'function' ? text(await readFile(full, 'utf8')) : text;
      assert.notEqual(next, undefined);
      await writeFile(full, next);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Replaces `from` by `to` in a file's text, asserting that it occurs. */
const edit = (from, to) => text => {
  assert.ok(text.includes(from), `Replacement must match: ${from}`);
  return text.replace(from, to);
};

const failWith = (code, file, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    (!pattern || pattern.test(e.message))) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

const rejects = (files, code, file, pattern) =>
  withKit(files, root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      failWith(code, file, pattern),
    ),
  );

test('a Kit app lowers with the body and container attributes of app.html', async () => {
  const { ir } = await lower(await collect(FIXTURE));
  assert.deepEqual(ir.container, { style: 'display: contents' });
  assert.deepEqual(ir.body, { 'data-sveltekit-preload-data': 'off' });
  // The backend never sees framework names. String values are the app's own
  // data: Kit's announcer id, its data-sveltekit-* link options and log texts.
  const rust = generate(ir)
    .replace(/^(const|static) (TITLE|CSS|IR_HASH|BODY_ATTRS)\b.*$/gm, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.doesNotMatch(rust, /react|vue|svelte|\$state/i);
});

test('server code needs generation; hooks and service workers are rejected', async () => {
  // Server loads and endpoints are build-time data of `runic generate`
  // (tests/generate.test.mjs): without its record the build stops.
  await rejects(
    { 'src/routes/items/+page.server.ts': 'export const load = () => ({});\n' },
    'E_GENERATED',
    'runic.json',
  );
  await rejects(
    { 'src/routes/api/+server.ts': 'export const GET = () => new Response();\n' },
    'E_GENERATED',
    'runic.json',
  );
  await rejects(
    { 'src/hooks.server.ts': 'export const handle = ({ event, resolve }) => resolve(event);\n' },
    'E_KIT_HOOKS',
    'src/hooks.server.ts',
  );
  await rejects(
    { 'src/service-worker.ts': 'export {};\n' },
    'E_KIT_HOOKS',
    'src/service-worker.ts',
  );
});

test('svelte.config.js: only literal, covered options', async () => {
  await rejects(
    { 'svelte.config.js': edit("bundleStrategy: 'single'", "bundleStrategy: 'split'") },
    'E_KIT_CONFIG',
    'svelte.config.js',
    /bundleStrategy/,
  );
  await rejects(
    { 'svelte.config.js': edit('kit: {', 'kit: {\n    trailingSlash: "always",') },
    'E_KIT_CONFIG',
    'svelte.config.js',
  );
});

test('app.html: one body placeholder element, no scripts, preloading off', async () => {
  await rejects(
    { 'src/app.html': edit('%sveltekit.head%', '%sveltekit.head%<script>1</script>') },
    'E_KIT_HTML',
    'src/app.html',
  );
  await rejects(
    { 'src/app.html': edit('preload-data="off"', 'preload-data="hover"') },
    'E_KIT_PRELOAD',
    'src/app.html',
  );
});

test('route modules: satisfies instead of : PageLoad, page options, components', async () => {
  await rejects(
    {
      'src/routes/old/+page.ts': edit(
        'export function load',
        'export const csr = true;\nexport function load',
      ),
    },
    'E_KIT_LOAD',
    'src/routes/old/+page.ts',
  );
  await rejects(
    {
      'src/routes/items/[id=integer]/+page.ts': edit(
        'export const load = (async',
        'export const load: PageLoad = (async',
      ),
    },
    'E_KIT_LOAD',
    'src/routes/items/[id=integer]/+page.ts',
    /satisfies/,
  );
  await rejects(
    {
      'src/routes/(account)/settings/+page.svelte': null,
      'src/routes/(account)/settings/+page.ts': 'export const ssr = false;\n',
    },
    'E_KIT_ROUTES',
    'src/routes/(account)/settings/+page.ts',
  );
});

test('code the native router cannot honour is rejected where it is written', async () => {
  const layout = 'src/routes/+layout.svelte';
  await rejects(
    { [layout]: edit("import { page } from '$app/state';", "import { page } from '$app/stores';") },
    'E_KIT_IMPORT',
    layout,
  );
  await rejects(
    {
      [layout]: edit(
        'let navigations = $state(0);',
        "let navigations = $state(0);\n  $effect(() => document.addEventListener('click', () => {}));",
      ),
    },
    'E_KIT_LISTENER',
    layout,
  );
  await rejects(
    { [layout]: edit('<button id="goto-item3"', '<button autofocus id="goto-item3"') },
    'E_KIT_ATTRIBUTE',
    layout,
  );
  await rejects(
    { [layout]: edit('<a id="nav-old"', '<a data-sveltekit-preload-data="hover" id="nav-old"') },
    'E_KIT_PRELOAD',
    layout,
  );
  // error() and redirect() throw the router's errors.
  const item = 'src/routes/items/[id=integer]/+page.ts';
  await rejects(
    {
      [item]: edit(
        "if (params.id === '7') error(404, 'No item 7');",
        "try {\n    if (params.id === '7') error(404, 'No item 7');\n  } catch {\n    console.log('caught');\n  }",
      ),
    },
    'E_KIT_CATCH',
    item,
  );
  await rejects(
    {
      [layout]: edit(
        "onclick={() => goto('/items/3?tab=notes')}",
        'onclick={() => beforeNavigate(() => {})}',
      ),
    },
    'E_KIT_LIFECYCLE',
    layout,
  );
});
