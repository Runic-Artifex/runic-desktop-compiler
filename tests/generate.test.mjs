// SvelteKit phase 2 (docs/design/M6-SVELTEKIT.md): `runic generate` runs the
// app's declared generators (pinned tools, recorded hashes) and evaluates its
// server code into data tables; builds only check the record. The kit-docs
// fixture runs the shadcn-svelte site's velite and mdsx configurations and
// its previews preprocessor over three of its markdown pages. Behaviour
// against the fixture's Kit build in Chromium: cases kit-docs and
// kit-docs-narrow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { generate, RECORD } from '../compiler/generate.mjs';
import { parseHtml } from '../frontend/html-fragments.ts';
import { interpret } from '../compiler/codegen.mjs';

const FIXTURE = 'fixtures/kit-docs-svelte';

/** A copy of the fixture without its generated inputs; `run` gets its root. */
async function withCopy(run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/kit-docs-'));
  try {
    await cp(FIXTURE, root, {
      recursive: true,
      filter: src =>
        !/[\\/](\.svelte-kit|\.runic|\.velite|__registry__|build|node_modules)$/.test(src),
    });
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const failWith = (code, file, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    (!pattern || pattern.test(e.message))) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('the vendored shadcn-svelte sources are unmodified; componentPreviews is the site’s', () => {
  const vendor = JSON.parse(readFileSync(path.join(FIXTURE, 'vendor.json'), 'utf8'));
  const corpus = path.join('.cache/corpus', vendor.source);
  for (const [file, { upstream, sha256: hash }] of Object.entries(vendor.files)) {
    const bytes = readFileSync(path.join(FIXTURE, file));
    assert.equal(sha256(bytes), hash, file);
    if (existsSync(path.join(corpus, upstream)))
      assert.deepEqual(bytes, readFileSync(path.join(corpus, upstream)), upstream);
  }
  const site = path.join(corpus, 'docs/svelte.config.js');
  if (existsSync(site)) {
    const fn = text => text.slice(text.indexOf('/**\n * Detects the `name`'));
    assert.equal(
      fn(readFileSync(path.join(FIXTURE, 'svelte.config.js'), 'utf8')),
      fn(readFileSync(site, 'utf8')),
    );
  }
});

test('generate records the steps and server data; builds check the record and never run steps', async () => {
  await withCopy(async root => {
    // Without generation the build stops at runic.json, and runs nothing.
    await assert.rejects(collect(root), failWith('E_GENERATED', 'runic.json', /missing/));
    assert.ok(!existsSync(path.join(root, '.velite')));
    assert.ok(!existsSync(path.join(root, 'src/__registry__')));

    const record = await generate(root);
    assert.deepEqual(
      record.steps.map(s => s.name),
      ['registry', 'content', 'markdown'],
    );
    const markdown = record.steps[2];
    assert.ok(markdown.tools.some(t => t.name === 'mdsx' && t.version === '0.0.7'));
    assert.ok('svelte.config.js' in markdown.inputs && 'mdsx.config.js' in markdown.inputs);
    assert.ok('.runic/generate/markdown/content/components/toggle.md.svelte' in markdown.outputs);
    const server = JSON.parse(
      await readFile(path.join(root, '.runic/generate/server.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(server.fetch), [
      '/api/block/separator',
      '/api/block/tabs',
      '/api/block/toggle',
    ]);
    assert.deepEqual(server.nodes['src/routes/+layout.server.ts'].table[0].data.nav[0], {
      title: 'Separator',
      href: '/docs/components/separator',
    });

    // The program: component values for the glob's pages and previews,
    // {@html} fragments parsed at build time, the data tables.
    const { ir } = await lower(await collect(root));
    assert.ok(ir.records.some(r => r.name === 'Component' && r.class));
    assert.ok(ir.fragments.length > 0);
    const html = [];
    const walk = v => {
      if (!v || typeof v !== 'object') return;
      if (v.kind === 'html') html.push(v);
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
    };
    walk(ir.components);
    assert.ok(html.some(n => n.value.op === 'lit'));
    assert.ok(html.some(n => n.value.op !== 'lit' && n.fragments.length > 0));

    // A changed input makes a step stale; the build runs nothing.
    const before = await readFile(path.join(root, RECORD), 'utf8');
    const output = await readFile(path.join(root, '.velite/components.json'), 'utf8');
    await writeFile(
      path.join(root, 'content/components/toggle.md'),
      (await readFile(path.join(root, 'content/components/toggle.md'), 'utf8')) + '\nMore.\n',
    );
    await assert.rejects(
      collect(root),
      failWith(
        'E_GENERATED',
        'runic.json',
        /content is stale \(input content\/components\/toggle\.md changed\)/,
      ),
    );
    assert.equal(await readFile(path.join(root, RECORD), 'utf8'), before);
    assert.equal(await readFile(path.join(root, '.velite/components.json'), 'utf8'), output);

    // So does a changed output, or a changed tool pin.
    await generate(root);
    await writeFile(
      path.join(root, '.velite/components.json'),
      output.replace('Toggle', 'Toggles'),
    );
    await assert.rejects(
      collect(root),
      failWith('E_GENERATED', 'runic.json', /output \.velite\/components\.json changed/),
    );
    await generate(root);
    const config = JSON.parse(await readFile(path.join(root, 'runic.json'), 'utf8'));
    config.generate[1].tools = ['velite@0.3.0'];
    await writeFile(path.join(root, 'runic.json'), JSON.stringify(config, null, 2));
    await assert.rejects(
      collect(root),
      failWith('E_GENERATED', 'runic.json', /velite is 0\.3\.1, the step pins 0\.3\.0/),
    );
  });
});

test('server code that is not prerendered, unfetched endpoints and form actions are rejected', async () => {
  await withCopy(async root => {
    await writeFile(
      path.join(root, 'src/routes/+layout.server.ts'),
      (await readFile(path.join(root, 'src/routes/+layout.server.ts'), 'utf8')).replace(
        'export const prerender = true;',
        'export const prerender = false;',
      ),
    );
    await assert.rejects(
      generate(root),
      failWith('E_KIT_SERVER', 'src/routes/+layout.server.ts', /not prerendered/),
    );
  });
  await withCopy(async root => {
    await mkdir(path.join(root, 'src/routes/api/other'), { recursive: true });
    await writeFile(
      path.join(root, 'src/routes/api/other/+server.ts'),
      'export const GET = () => new Response("x");\n',
    );
    await generate(root);
    await assert.rejects(
      collect(root),
      failWith('E_KIT_SERVER', 'src/routes/api/other/+server.ts', /no server/),
    );
  });
  await withCopy(async root => {
    await writeFile(
      path.join(root, 'src/routes/docs/[...slug]/+page.server.ts'),
      (await readFile(path.join(root, 'src/routes/docs/[...slug]/+page.server.ts'), 'utf8')) +
        '\nexport const actions = {};\n',
    );
    await generate(root);
    await assert.rejects(
      collect(root),
      failWith('E_KIT_SERVER', 'src/routes/docs/[...slug]/+page.server.ts', /Form actions/),
    );
  });
});

test('{@html} fragments hold static, non-interactive content only', () => {
  assert.deepEqual(parseHtml('<span style="color:red">a</span>\n<b>b</b>'), [
    { tag: 'span', attrs: [['style', 'color:red']], children: [{ text: 'a' }] },
    { text: '\n' },
    { tag: 'b', children: [{ text: 'b' }] },
  ]);
  for (const bad of [
    '<a href="#x">x</a>',
    '<script>x</script>',
    '<button>x</button>',
    '<span onclick="x()">x</span>',
    '<svg></svg>',
  ])
    assert.throws(() => parseHtml(bad), /unsupported|outside/, bad);
});

test('{@html} of a constant: the parsed fragment, rendered and removed with its block', async () => {
  const g = await collect('fixtures/counter-svelte');
  const id = path.join(g.root, 'App.svelte');
  const code = g.modules
    .get(id)
    .code.replace(
      '{#if show}<p id="details">Visible</p>{/if}',
      '{#if show}<p id="details">{@html \'<span class="x">a</span> <b>b&amp;c</b>\'}</p>{/if}',
    );
  const modules = new Map(g.modules);
  modules.set(id, { ...g.modules.get(id), code });
  const { ir } = await lower({ ...g, modules });
  assert.deepEqual(ir.fragments, [
    {
      html: '<span class="x">a</span> <b>b&amp;c</b>',
      nodes: [
        { tag: 'span', attrs: [['class', 'x']], children: [{ text: 'a' }] },
        { text: ' ' },
        { tag: 'b', children: [{ text: 'b&c' }] },
      ],
    },
  ]);
  const steps = interpret(ir, [
    { kind: 'click', id: 'toggle' },
    { kind: 'click', id: 'toggle' },
  ]);
  const find = (nodes, id) => {
    for (const n of nodes) {
      if (typeof n === 'string') continue;
      if (n.attrs?.id === id) return n;
      const f = find(n.children ?? [], id);
      if (f) return f;
    }
    return undefined;
  };
  assert.deepEqual(find(steps[0].state.dom, 'details').children, [
    { tag: 'span', attrs: { class: 'x' }, children: ['a'] },
    ' ',
    { tag: 'b', attrs: {}, children: ['b&c'] },
  ]);
  assert.equal(find(steps[1].state.dom, 'details'), undefined);
  assert.ok(find(steps[2].state.dom, 'details'));
});
