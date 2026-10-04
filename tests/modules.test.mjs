// Library modules (M6 step 3, docs/design/M6-LIBRARIES.md#library-modules):
// `<script module>`, barrels and namespace tags, runic.json aliases, prop
// domains (the values class props receive from their instantiation sites),
// <svelte:element>, links, and the vendored shadcn-svelte sources. Rendering
// parity with Chromium is checked by the `shadcn-basics` conformance case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const FIXTURE = 'fixtures/shadcn-basics-svelte';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run, config = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/modules-'));
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
      'runic.json': JSON.stringify({
        framework: 'svelte',
        entry: 'main.js',
        title: 'T',
        ...config,
      }),
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
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const byId = (step, id) => flat(step.state.dom).find(n => n.attrs.id === id);
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));

/** Expects a diagnostic `code` located in `file` (and matching `pattern`). */
const failWith = (code, file, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    (!pattern || pattern.test(e.message))) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

const svelte = (script, markup = '') => `<script lang="ts">\n${script}\n</script>\n${markup}\n`;

test('the vendored shadcn-svelte sources are unmodified', () => {
  const vendor = JSON.parse(readFileSync(path.join(FIXTURE, 'vendor.json'), 'utf8'));
  const corpus = path.join('.cache/corpus', vendor.source);
  for (const [file, { upstream, sha256 }] of Object.entries(vendor.files)) {
    const bytes = readFileSync(path.join(FIXTURE, file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, file);
    // With the north-star checkout fetched (conformance/corpus/fetch.mjs),
    // the copy is byte-identical to the pinned upstream file.
    if (existsSync(path.join(corpus, upstream)))
      assert.deepEqual(bytes, readFileSync(path.join(corpus, upstream)), upstream);
  }
});

test("shadcn-svelte's Button, Badge and Card compile and select their classes per site", async () => {
  const { ir } = await lowered(FIXTURE);
  const names = ir.components.map(c => c.name);
  for (const n of ['button', 'badge', 'card', 'card-header', 'card-title', 'card-footer'])
    assert.ok(names.includes(n), n);
  assert.deepEqual(
    ir.meta.mappings.map(m => m.id),
    ['@lucide/svelte@1.52.0', 'clsx@2.1.1', 'cn@0.3.0', 'tailwind-variants@3.3.1'],
  );
  // Button has several sites: its class is selected by the site index.
  const button = ir.components.find(c => c.name === 'button');
  assert.ok(button.cells.some(c => c.prop === '$site'));
  // The real packages give the classes the program selects.
  const { tv } = await import('tailwind-variants');
  const { cn } = await import('cn');
  const source = readFileSync(
    path.join(FIXTURE, 'src/lib/registry/ui/button/button.svelte'),
    'utf8',
  );
  const config = source.slice(source.indexOf('tv(') + 3, source.indexOf('});') + 1);
  const buttonVariants = tv(new Function(`return ${config}`)());
  const steps = interpret(ir, [
    { kind: 'click', id: 'outline' },
    { kind: 'click', id: 'destructive' },
    { kind: 'click', id: 'secondary' },
  ]);
  const expect = (step, id, variant, size, className) =>
    assert.equal(
      byId(steps[step], id).attrs.class,
      cn(buttonVariants({ variant, size }), className),
      `${id} in step ${step}`,
    );
  expect(0, 'default', 'default', 'default', undefined);
  expect(0, 'card-submit', 'default', 'sm', 'w-full');
  expect(0, 'xs', 'outline', 'xs', undefined);
  expect(0, 'dynamic', 'default', 'default', undefined);
  expect(1, 'dynamic', 'outline', 'default', undefined);
  expect(2, 'dynamic', 'outline', 'default', 'w-40');
  expect(3, 'dynamic', 'outline', 'lg', 'w-40');
  // href turns Button into a link; Badge's <svelte:element> into <a> or <span>.
  assert.equal(byId(steps[0], 'as-link').tag, 'a');
  assert.equal(byId(steps[0], 'as-link').attrs.href, '#login');
  assert.equal(byId(steps[0], 'badge').tag, 'span');
  assert.equal(byId(steps[0], 'badge-link').tag, 'a');
  // Following a link: a fragment navigation (popstate, then hashchange).
  const nav = interpret(ir, [
    { kind: 'click', id: 'as-link' },
    { kind: 'click', id: 'as-link' },
  ]);
  assert.equal(text(byId(nav[1], 'navigation')), '1 1 #login');
  assert.equal(text(byId(nav[2], 'navigation')), '2 1 #login');
});

test('module scripts, barrels, namespace tags and aliases', async () => {
  const files = {
    'src/lib/ui/tag/tag.svelte': [
      '<script lang="ts" module>',
      "  export const TONES = ['plain', 'loud'] as const;",
      "  export function label(tone: 'plain' | 'loud') { return tone === 'loud' ? 'LOUD' : 'plain'; }",
      '</script>',
      '<script lang="ts">',
      // A type-only import through the alias: no module is loaded, the
      // type checker still reads the file.
      "  import type { Tone } from '$lib/ui/types';",
      "  let { tone = 'plain' }: { tone?: Tone } = $props();",
      '</script>',
      '<span class="tag">{label(tone)} {TONES.length}</span>',
    ].join('\n'),
    'src/lib/ui/types.ts': "export type Tone = 'plain' | 'loud';\n",
    'src/lib/ui/tag/index.ts':
      "import Root, { label } from './tag.svelte';\nexport { Root, Root as Tag, label };\nexport { default as Other } from './tag.svelte';\n",
    'src/lib/ui/index.ts':
      "export * from './tag/index.js';\nexport * as Tags from './tag/index.js';\n",
    'App.svelte': svelte(
      "import * as T from '$lib/ui/tag/index.js';\nimport { Tags, label } from '$lib/ui/index.js';",
      '<T.Root tone="loud" /><T.Tag /><Tags.Other /><p id="l">{label(\'loud\')}</p>',
    ),
  };
  await withApp(
    files,
    async root => {
      const { ir } = await lowered(root);
      const [step] = interpret(ir, []);
      assert.deepEqual(
        flat(step.state.dom)
          .filter(n => n.tag === 'span')
          .map(text),
        ['LOUD 2', 'plain 2', 'plain 2'],
      );
      assert.equal(text(byId(step, 'l')), 'LOUD');
    },
    { alias: { $lib: 'src/lib' } },
  );
  const rejected = [
    // A namespace's members are not values.
    [
      {
        ...files,
        'App.svelte': svelte("import * as T from '$lib/ui/tag/index.js';\nconst x = T;"),
      },
      'E_IMPORT',
      'App.svelte',
    ],
    // A tag naming no component of the namespace.
    [
      {
        ...files,
        'App.svelte': svelte("import * as T from '$lib/ui/tag/index.js';", '<T.Missing />'),
      },
      'E_TEMPLATE',
      'App.svelte',
    ],
    // Mutable module state in <script module>.
    [
      {
        ...files,
        'App.svelte': '<script lang="ts" module>\n  export let n = 1;\n</script>\n<p>{n}</p>\n',
      },
      'E_MODULE',
      'App.svelte',
    ],
  ];
  for (const [f, code, file] of rejected)
    await withApp(f, root => assert.rejects(lowered(root), failWith(code, file)), {
      alias: { $lib: 'src/lib' },
    });
  // Aliases are directories inside the application.
  await withApp(files, root => assert.rejects(collect(root), /alias/), {
    alias: { $lib: '../elsewhere' },
  });
});

test('class props take the values of their sites, enumerated per site', async () => {
  const utils = "export { cn } from 'cn';\n";
  const child = svelte(
    "import { cn } from './utils.ts';\nlet { class: className, tone = 'a' }: { class?: string; tone?: 'a' | 'b' } = $props();",
    "<i class={cn('p-2', tone === 'b' && 'p-4', className)}>{tone}</i>",
  );
  const app = svelte(
    "import Child from './Child.svelte';\nlet on = $state(false);",
    [
      '<button id="go" onclick={() => (on = !on)}>go</button>',
      '<Child class="p-8" />',
      '<Child tone="b" />',
      "<Child class={on ? 'px-1' : undefined} tone={on ? 'b' : 'a'} />",
    ].join('\n'),
  );
  await withApp({ 'utils.ts': utils, 'Child.svelte': child, 'App.svelte': app }, async root => {
    const { ir } = await lowered(root);
    const c = ir.components.find(x => x.name === 'Child');
    assert.ok(
      c.cells.some(x => x.prop === '$site'),
      'three sites: a site index',
    );
    assert.deepEqual(c.cells.find(x => x.prop === 'class').type, { maybe: 'string' });
    const steps = interpret(ir, [{ kind: 'click', id: 'go' }]);
    const classes = s =>
      flat(steps[s].state.dom)
        .filter(n => n.tag === 'i')
        .map(n => n.attrs.class);
    assert.deepEqual(classes(0), ['p-8', 'p-4', 'p-2']);
    assert.deepEqual(classes(1), ['p-8', 'p-4', 'p-4 px-1']);
  });
  // A prop the child writes takes values its sites do not pass: it stays open.
  const writes = svelte(
    "import { cn } from './utils.ts';\nlet { class: className }: { class?: string } = $props();",
    "<i class={cn('p-2', className)} onclick={() => (className = 'x')}></i>",
  );
  await withApp(
    {
      'utils.ts': utils,
      'Child.svelte': writes,
      'App.svelte': svelte("import Child from './Child.svelte';", '<Child class="p-1" />'),
    },
    root => assert.rejects(lowered(root), failWith('E_PACK', 'Child.svelte')),
  );
});

test('<svelte:element> and links need finite, supported values', async () => {
  const cases = [
    // An open tag.
    [
      svelte("let t = $state('div' as string);", '<svelte:element this={t}>x</svelte:element>'),
      'E_TEMPLATE',
    ],
    // A tag outside the HTML elements.
    [
      svelte(
        'let s = $state(false);',
        "<svelte:element this={s ? 'svg' : 'div'}>x</svelte:element>",
      ),
      'E_TEMPLATE',
    ],
    // An open href; the document top; a fragment naming an element.
    [svelte("let h = $state('#a' as string);", '<a href={h}>x</a>'), 'E_TEMPLATE'],
    [svelte('', '<a href="#top">x</a>'), 'E_TEMPLATE'],
    [svelte('', '<a href="#">x</a>'), 'E_TEMPLATE'],
    [svelte('', '<a href="/other">x</a>'), 'E_TEMPLATE'],
    [svelte('', '<a href="#here">x</a><p id="here">y</p>'), 'E_TEMPLATE'],
  ];
  for (const [source, code] of cases)
    await withApp({ 'App.svelte': source }, root =>
      assert.rejects(lowered(root), failWith(code, 'App.svelte')),
    );
  // Blitz never matches :target.
  await withApp(
    { 'App.svelte': svelte('', '<a href="#x">x</a>'), 'style.css': 'a:target { color: red; }\n' },
    root => assert.rejects(collect(root), e => e.code === 'E_CSS' && /:target/.test(e.message)),
  );
});
