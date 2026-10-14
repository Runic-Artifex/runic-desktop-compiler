// The embla-carousel 8.6.0 pack entry for `objectsMergeDeep`
// (frontend/packs/embla-carousel-8.6.0.ts): its calls lower to a merge
// directed by the arguments' types, validated here against the real
// function's results (conformance/packs/embla-carousel-8.6.0.json, generated
// by conformance/packs/embla-carousel.mjs). The program's package is a
// stand-in named embla-carousel@8.6.0 that holds the bundle's own text of
// the function and the helpers it calls (the pack recognises them by their
// source) and exports a generic wrapper typed as the pack's declaration
// override types `mergeOptions`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';
import { results } from '../conformance/packs/embla-carousel.mjs';

const lowered = root => collect(root).then(g => lower(g));
const committed = JSON.parse(readFileSync('conformance/packs/embla-carousel-8.6.0.json', 'utf8'));

/** The bundle's own text of the merge and the helpers it calls. */
function helpers(edit = s => s) {
  const bundle = readFileSync('node_modules/embla-carousel/esm/embla-carousel.esm.js', 'utf8');
  return ['isObject', 'objectKeys', 'objectsMergeDeep']
    .map(n => {
      const start = bundle.indexOf(`function ${n}(`);
      let depth = 0;
      for (let i = bundle.indexOf('{', start); ; i++) {
        if (bundle[i] === '{') depth++;
        else if (bundle[i] === '}' && --depth === 0) return edit(bundle.slice(start, i + 1));
      }
    })
    .join('\n');
}

/** A Svelte app whose package embla-carousel@`version` exports `merge`. */
async function withApp(app, run, { version = '8.6.0', edit } = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/embla-merge-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const files = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root') });\n",
      'runic.json': JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
      'App.svelte': app,
      'node_modules/embla-carousel/package.json': JSON.stringify({
        name: 'embla-carousel',
        version,
        type: 'module',
        sideEffects: false,
        exports: { '.': { types: './index.d.ts', default: './index.js' } },
      }),
      'node_modules/embla-carousel/index.js': `${helpers(edit)}\nexport function merge(a, b) {\n  return objectsMergeDeep(a, b || {});\n}\n`,
      'node_modules/embla-carousel/index.d.ts':
        'export declare function merge<A, B>(a: A, b?: B): A & NonNullable<B>;\n',
    };
    for (const [file, t] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), t);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const program = vectors =>
  [
    '<script lang="ts">',
    "  import { merge } from 'embla-carousel';",
    ...vectors.flatMap((v, i) => [
      `  type A${i} = ${v.A};`,
      `  type B${i} = ${v.B};`,
      `  const a${i}: A${i} = ${v.a};`,
      ...(v.b === null
        ? [`  const r${i} = merge(a${i});`]
        : [`  const b${i}: B${i} = ${v.b};`, `  const r${i} = merge(a${i}, b${i});`]),
    ]),
    '</script>',
    ...vectors.map(
      (v, i) =>
        `<i id="v${i}" data-v={\`${v.show.map(s => '${' + s.replaceAll('r.', `r${i}.`).replace(/\br\b/g, `r${i}`) + '}').join('|')}\`}></i>`,
    ),
  ].join('\n');

const byId = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n !== 'object') continue;
    if (n.attrs?.id === id) return n;
    const found = byId(n.children ?? [], id);
    if (found) return found;
  }
  return undefined;
};

test('the committed merge vectors are the results of the installed embla-carousel 8.6.0', () => {
  assert.deepEqual(committed.vectors, results);
});

test('objectsMergeDeep calls lowered by the pack agree with the real function on every vector', async () => {
  const vectors = committed.vectors.filter(v => !v.rejected);
  await withApp(program(vectors), async root => {
    const { ir } = await lowered(root);
    assert.ok(
      ir.meta.mappings.some(m => m.id === 'embla-carousel#objectsMergeDeep@8.6.0'),
      JSON.stringify(ir.meta.mappings),
    );
    const [step] = interpret(ir, []);
    vectors.forEach((v, i) =>
      assert.equal(byId(step.state.dom, `v${i}`).attrs['data-v'], v.expected, `${v.a} + ${v.b}`),
    );
  });
});

test('a merge over an object that may have a key with an undefined value is rejected, located', async () => {
  for (const v of committed.vectors.filter(x => x.rejected))
    await withApp(program([{ ...v, show: ['1'] }]), root =>
      assert.rejects(
        lowered(root),
        e =>
          (e instanceof Diagnostic && e.code === 'E_OBJECT') ||
          assert.fail(`expected E_OBJECT for ${v.b}, got ${e.code}: ${e.message}`),
      ),
    );
});

test('another version or another source of the merge rejects its calls, located', async () => {
  const v = committed.vectors[0];
  for (const options of [
    { version: '8.5.2' },
    { edit: s => s.replace('isObject(valueA) && isObject(valueB)', 'isObject(valueA)') },
  ])
    await withApp(
      program([v]),
      root =>
        assert.rejects(
          lowered(root),
          e =>
            (e instanceof Diagnostic &&
              ['E_PACK', 'E_SOURCE_VERSION'].includes(e.code) &&
              !!e.source) ||
            assert.fail(`expected a located rejection, got ${e.code}: ${e.message}`),
        ),
      options,
    );
});
