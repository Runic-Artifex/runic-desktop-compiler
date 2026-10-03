import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdtemp, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic, hash } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { render, transition } from '../compiler/ir.mjs';

const cache = new Map(),
  graph = framework => {
    if (!cache.has(framework)) cache.set(framework, collect('fixtures/modules-' + framework));
    return cache.get(framework);
  };
function edit(g, file, from, to) {
  const id = path.join(g.root, file),
    old = g.modules.get(id);
  assert.ok(old.code.includes(from), 'Replacement must match ' + file);
  const modules = new Map(g.modules),
    code = old.code.replace(from, to);
  modules.set(id, { ...old, code });
  return { ...g, modules, hash: hash(code) };
}
const failWith = (code, file) => e =>
  e instanceof Diagnostic &&
  e.code === code &&
  e.source?.file === file &&
  e.source.line > 0 &&
  e.source.column > 0;
test('all three frontends share transitive named module bindings and the pinned mapping', async () => {
  const results = [];
  for (const f of ['react', 'vue', 'svelte']) {
    const { ir, edges } = await lower(await graph(f));
    assert.equal(ir.schema, 3);
    assert.equal(edges.length, 64);
    assert.equal(ir.mappings.length, 1);
    assert.equal(ir.mappings[0].id, 'bounded-increase');
    assert.deepEqual(transition(ir, [1, 0, true], 1), [2, 1, true]);
    assert.deepEqual(transition(ir, [3, 2, false], 0), [3, 2, false]);
    assert.deepEqual(transition(ir, [3, 2, false], 2), [0, 0, false]);
    results.push({ hash: ir.validation.transitionHash, edges });
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  for (const file of ['base.ts', 'logic.ts', 'advance.js'])
    assert.equal(
      await readFile('fixtures/modules-react/' + file, 'utf8'),
      await readFile('fixtures/modules-svelte/' + file, 'utf8'),
    );
});
test('Vue and Svelte initialize immutable modules before setup and preserve original locations', async () => {
  for (const f of ['vue', 'svelte']) {
    const g = await graph(f),
      file = f === 'vue' ? 'App.vue' : 'App.svelte';
    const importLine =
      "import {advance as next, amount, ceiling, starting, heading} from './logic.ts';";
    let moved = edit(g, file, importLine, '');
    moved = edit(moved, file, '</script>', importLine + '\n</script>');
    assert.deepEqual((await lower(moved)).edges, (await lower(g)).edges);
    const changed = edit(g, 'logic.ts', 'starting=0', 'starting=1'),
      { ir } = await lower(changed);
    assert.equal(ir.states[0].initial, 1);
    const tree = render(
        ir,
        ir.states.map(s => s.initial),
      ),
      flat = n => [n, ...(n.children ?? []).flatMap(flat)];
    assert.equal(flat(tree).find(n => n.attrs?.id === 'initial').children[0].text, '1');
    assert.equal(ir.states[0].source.file, file);
    for (const filename of ['base.vue.ts', 'App.vue.ts']) {
      const modules = new Map(g.modules),
        base = path.join(g.root, 'base.ts'),
        renamed = path.join(g.root, filename);
      modules.set(renamed, { ...modules.get(base), id: renamed });
      modules.delete(base);
      const logic = path.join(g.root, 'logic.ts'),
        m = modules.get(logic);
      modules.set(logic, {
        ...m,
        code: m.code.replaceAll('./base.ts', './' + filename),
        imports: m.imports.map(e =>
          e.resolved === base ? { specifier: './' + filename, resolved: renamed } : e,
        ),
      });
      const withSuffix = (await lower({ ...g, modules })).ir;
      assert.equal(
        flat(withSuffix.ui).find(n => n.attrs?.id?.value === 'heading').children[0].parts[0].source
          .file,
        filename,
      );
      assert.equal(withSuffix.states[0].source.file, file);
    }
    await assert.rejects(
      () => lower(g, { registry: false }),
      e => failWith('E_MAPPING', file)(e) && e.discovery.source.file === 'advance.js',
    );
  }
});
test('module initialization rejects mutation, effects, forward const reads and unsupported exports', async () => {
  const cases = [
    ['export const starting=0;', 'export let starting=0;', 'E_MODULE_MUTATION'],
    ['export const starting=0;', 'console.log(1);export const starting=0;', 'E_MODULE_EFFECT'],
    ['export const starting=0;', 'export const starting=later;const later=0;', 'E_EXPRESSION'],
    ['export const starting=0;', 'export const starting=Date.now();', 'E_CALL'],
    ['export const starting=0;', 'export const starting={value:0};', 'E_EXPRESSION'],
    ['export const starting=0;', 'export const starting: number=0;', 'E_DECLARATION'],
    ['export const starting=0;', 'export default 0;', 'E_MODULE_EFFECT'],
    ['export {advance}', 'export *', 'E_MODULE_EXPORT'],
    ['export {limit as ceiling};', 'export {absent as ceiling};', 'E_MODULE_EXPORT'],
    ['import {LIMIT as maximum}', 'import * as maximum', 'E_IMPORT'],
    ['import {LIMIT as maximum}', 'import maximum', 'E_IMPORT'],
    ['import {LIMIT as maximum}', 'import type {LIMIT as maximum}', 'E_IMPORT'],
    ["import {LIMIT as maximum} from './base.ts';", "import './base.ts';", 'E_IMPORT'],
  ];
  for (const f of ['vue', 'svelte']) {
    const g = await graph(f);
    for (const [from, to, code] of cases)
      await assert.rejects(() => lower(edit(g, 'logic.ts', from, to)), failWith(code, 'logic.ts'));
  }
});
test('module helpers cannot capture values, shadow global Math, recurse or introduce effects', async () => {
  const original =
      'export function advance(value, amount, maximum){return Math.min(value+amount,maximum);}',
    cases = [
      'export function advance(value, amount, maximum){console.log(value);return Math.min(value+amount,maximum);}',
      'export async function advance(value, amount, maximum){return Math.min(value+amount,maximum);}',
      'export function advance(value=0, amount, maximum){return Math.min(value+amount,maximum);}',
      'const extra=1;export function advance(value, amount, maximum){return Math.min(value+extra,maximum);}',
      'const Math=0;export function advance(value, amount, maximum){return Math.min(value+amount,maximum);}',
      'export function advance(Math, amount, maximum){return Math.min(Math+amount,maximum);}',
      'export function advance(value, amount, maximum){return advance(value,amount,maximum);}',
    ];
  for (const f of ['vue', 'svelte']) {
    const g = await graph(f);
    for (const source of cases)
      await assert.rejects(
        () => lower(edit(g, 'advance.js', original, source)),
        failWith('E_HELPER', 'advance.js'),
      );
    await assert.rejects(
      () => lower(edit(g, 'advance.js', 'advance(value,', 'advance(value: number,')),
      failWith('E_PARSE', 'advance.js'),
    );
    await assert.rejects(
      () =>
        lower(
          edit(
            g,
            'logic.ts',
            'export const starting=0;',
            'export function typed(value: number){return value+1;}\nexport const starting=0;',
          ),
        ),
      failWith('E_HELPER', 'logic.ts'),
    );
    const arrow = await lower(
      edit(
        g,
        'advance.js',
        original,
        'export const advance=(value,amount,maximum)=>Math.min(value+amount,maximum);',
      ),
    );
    assert.equal(arrow.ir.validation.transitionHash, (await lower(g)).ir.validation.transitionHash);
    await assert.rejects(
      () => lower(edit(g, 'base.ts', 'STEP=1', 'STEP=0')),
      failWith('E_MAPPING_PRECONDITION', f === 'vue' ? 'App.vue' : 'App.svelte'),
    );
    const unmapped = edit(g, 'advance.js', 'value+amount', 'value*amount');
    await assert.rejects(
      () => lower(unmapped),
      e =>
        failWith('E_MAPPING', f === 'vue' ? 'App.vue' : 'App.svelte')(e) &&
        e.discovery.source.file === 'advance.js',
    );
  }
});
test('cyclic dependencies and missing named imports reject with their original import location', async () => {
  for (const f of ['vue', 'svelte']) {
    const g = await graph(f),
      id = path.join(g.root, 'base.ts'),
      modules = new Map(g.modules),
      base = modules.get(id);
    modules.set(id, {
      ...base,
      code: "import {starting} from './logic.ts';\n" + base.code,
      imports: [{ specifier: './logic.ts', resolved: path.join(g.root, 'logic.ts') }],
    });
    await assert.rejects(
      () => lower({ ...g, modules }),
      e => failWith('E_MODULE_CYCLE', 'base.ts')(e) && e.source.line === 1,
    );
    const file = f === 'vue' ? 'App.vue' : 'App.svelte';
    await assert.rejects(
      () => lower(edit(g, file, 'advance as next', 'absent as next')),
      failWith('E_MODULE_EXPORT', file),
    );
    const logic = path.join(g.root, 'logic.ts'),
      m = modules.get(logic);
    modules.set(logic, {
      ...m,
      imports: m.imports.map(e =>
        e.specifier === './advance.js'
          ? { ...e, resolved: path.resolve(g.root, '../outside.js') }
          : e,
      ),
    });
    modules.set(id, base);
    await assert.rejects(() => lower({ ...g, modules }), failWith('E_DEPENDENCY', 'logic.ts'));
  }
});
test('collection retains unused initialization and tracks transitive module source identity', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/modules-'));
  try {
    await cp('fixtures/modules-svelte', root, { recursive: true });
    const g = await collect(root),
      a = await lower(g);
    await writeFile(
      root + '/base.ts',
      (await readFile(root + '/base.ts', 'utf8')).replace('STEP=1', 'STEP=2'),
    );
    // Analysis consumes its immutable collected snapshot, even when disk changes.
    assert.deepEqual((await lower(g)).edges, a.edges);
    const changed = await collect(root),
      b = await lower(changed);
    assert.notEqual(changed.hash, g.hash);
    assert.notEqual(b.ir.validation.transitionHash, a.ir.validation.transitionHash);
    await writeFile(
      root + '/advance.js',
      (await readFile(root + '/advance.js', 'utf8')) +
        '\nconsole.log("unused initialization must not disappear");\n',
    );
    await assert.rejects(
      () => collect(root).then(lower),
      e => failWith('E_MODULE_EFFECT', 'advance.js')(e) && e.source.line === 3,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('Svelte rune modules and uncovered component composition remain outside ordinary modules', async () => {
  const g = await graph('svelte'),
    file = path.join(g.root, 'advance.js'),
    m = g.modules.get(file),
    id = path.join(g.root, 'advance.svelte.js'),
    modules = new Map(g.modules);
  modules.delete(file);
  modules.set(id, { ...m, id });
  const logic = path.join(g.root, 'logic.ts'),
    l = modules.get(logic);
  modules.set(logic, {
    ...l,
    code: l.code.replace('./advance.js', './advance.svelte.js'),
    imports: l.imports.map(e =>
      e.resolved === file ? { specifier: './advance.svelte.js', resolved: id } : e,
    ),
  });
  await assert.rejects(() => lower({ ...g, modules }), failWith('E_COMPOSITION', 'logic.ts'));
});
test('files without import/export markers still have ES module lexical scope', async () => {
  for (const f of ['vue', 'svelte']) {
    const g = await graph(f),
      modules = new Map(g.modules),
      base = path.join(g.root, 'base.ts'),
      logic = path.join(g.root, 'logic.ts');
    modules.set(base, { ...modules.get(base), code: 'const Math=0;const hidden=Math.min(1,3);' });
    modules.set(logic, {
      ...modules.get(logic),
      code: "import {} from './base.ts';export {advance} from './advance.js';export const amount=1;export const ceiling=3;export const starting=0;export const heading='Test';",
    });
    await assert.rejects(() => lower({ ...g, modules }), failWith('E_CALL', 'base.ts'));
    // An unrelated module's private declaration must not change the actual
    // standard Math binding used by the exported helper in advance.js.
    modules.set(base, { ...modules.get(base), code: 'const Math=0;' });
    assert.equal((await lower({ ...g, modules })).ir.validation.transitions, 64);
  }
});
test('component intrinsic calls respect later lexical declarations and function self names', async () => {
  for (const f of ['vue', 'svelte']) {
    const g = await graph(f),
      file = f === 'vue' ? 'App.vue' : 'App.svelte',
      capture = f === 'vue' ? 'const initial=n.value;' : 'const initial=n;';
    let later = edit(g, file, capture, 'const initial=Math.min(0,1);');
    later = edit(later, file, '</script>', 'const Math=0;\n</script>');
    await assert.rejects(() => lower(later), failWith('E_CALL', file));
    const named =
      f === 'vue'
        ? edit(
            g,
            file,
            'computed(()=>n.value)',
            'computed(function Math(){return Math.min(n.value,3);})',
          )
        : edit(g, file, '$derived(n)', '$derived.by(function Math(){return Math.min(n,3);})');
    await assert.rejects(() => lower(named), failWith('E_CALL', file));
  }
  const g = await graph('svelte');
  await assert.rejects(
    () =>
      lower(
        edit(
          g,
          'App.svelte',
          'onclick={toggle}',
          'onclick={() => {show=!show;const captured=Math.min(1,2);const Math=0;}}',
        ),
      ),
    failWith('E_CALL', 'App.svelte'),
  );
});
