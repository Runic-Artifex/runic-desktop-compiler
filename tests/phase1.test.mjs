import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collect, hash } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { transition, validateIR, literal, evaluate } from '../compiler/ir.mjs';
import { generate } from '../compiler/codegen.mjs';
import {
  validateRule,
  validateCandidate,
  accept,
  loadRegistry,
  mappedExpression,
  repository,
} from '../compiler/mappings.mjs';
async function fixture(source, run, files = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/v2-'));
  try {
    await writeFile(
      path.join(root, 'runic.json'),
      JSON.stringify({ entry: 'main.jsx', title: 'V2' }),
    );
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>',
    );
    await writeFile(
      path.join(root, 'main.jsx'),
      `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';${source}\ncreateRoot(document.getElementById('root')).render(<App/>);`,
    );
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, file), text);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const analyze = root => collect(root).then(lower);
test('mixed replacement/updater queues retain captured values and produce one commit', async () => {
  await fixture(
    `const App=()=>{const[n,set]=useState(1);const[label,setLabel]=useState('a');const click=()=>{set(2);set(v=>v+1);set(Math.min(n+1,4));setLabel(v=>v==='a'?'b':'a');};return <button id="go" onClick={click}>{n} {label}</button>;}`,
    async root => {
      const { ir } = await analyze(root);
      assert.deepEqual(transition(ir, [1, 'a'], 0), [2, 'b']);
      assert.deepEqual(transition(ir, [3, 'b'], 0), [4, 'a']);
      assert.deepEqual(ir.states[1].domain.values, ['a', 'b']);
    },
  );
});
test('arrow composition and imported renamed helpers preserve all transitions', async () => {
  const variants = [
    `function App(){const[n,set]=useState(1);return <button id="go" onClick={()=>set(v=>bound(v+1,1,3))}>{n}</button>;}function bound(a,b,c){return Math.min(Math.max(a,b),c);}`,
    `import {clip as bound} from './helper.js';const Display=({n,go})=><button id="go" onClick={go}>{n}</button>;const App=()=>{const[n,set]=useState(1);const go=()=>set(v=>bound(v+1,1,3));return <Display n={n} go={go}/>;};`,
  ];
  const reports = [];
  for (const s of variants)
    reports.push(
      await fixture(
        s,
        async root => {
          const a = await analyze(root),
            b = await analyze(root);
          assert.equal(generate(a.ir), generate(b.ir));
          return a.edges;
        },
        { 'helper.js': 'export const clip=(x,lo,hi)=>Math.min(Math.max(x,lo),hi);' },
      ),
    );
  assert.deepEqual(reports[0], reports[1]);
});
test('enum states, controls, effects and resource boundaries fail explicitly', async () => {
  for (const [s, code] of [
    [
      `const App=()=>{const[x,set]=useState('a');return <button onClick={()=>set(2)}>{x}</button>;}`,
      'E_IR',
    ],
    [`const App=()=> <select><option>one</option></select>;`, 'E_CONTROL_UNSUPPORTED'],
    [`const helper=x=>{console.log(x);return x;};const App=()=> <p>{helper(1)}</p>;`, 'E_HELPER'],
    [
      `const App=()=>{const[x,set]=useState(1);return <button onClick={()=>set(v=>Math.min(v*1000000,2))}>{x}</button>;}`,
      'E_NUMBER',
    ],
  ])
    await fixture(s, root =>
      assert.rejects(
        () => analyze(root),
        e => e.code === code,
      ),
    );
});
test('malformed serialized IR never escapes as an implementation exception', async () => {
  const { ir } = await analyze('fixtures/smoke');
  const mutate = [
    x => (x.ui = null),
    x => (x.handlers[0].updates[0].value.args = null),
    x => (x.handlers[0].updates[0].value.args[0].left = null),
    x => (x.frontend = null),
    x => (x.assets = [{}]),
    x => (x.mappings = [{}]),
    x => (x.states[0].domain.values = [999]),
    x => (x.handlers[0].id = 99),
    x => (x.schema = 1),
    x => (x.extra = true),
    x => (x.irHash = '0'.repeat(64)),
  ];
  for (const f of mutate) {
    const broken = structuredClone(ir);
    f(broken);
    assert.throws(
      () => validateIR(broken),
      e => e.name === 'Diagnostic' && /^E_/.test(e.code),
    );
  }
});
test('mapping arguments removed by lowering still prove original evaluation domain', () => {
  const rule = validateRule({
    schema: 2,
    id: 'first',
    version: 1,
    matcher: { kind: 'pure-function', parameters: 2, body: { op: 'param', index: 0 } },
    lowering: { op: 'param', index: 0 },
    preconditions: {
      domain: 'finite-integer',
      maxAbs: 1000000,
      constantParameters: [],
      predicates: [],
      evaluation: 'pure-left-to-right',
    },
    capabilities: [],
    provenance: { mode: 'handwritten', provider: 'test', model: null, liveDiscovery: false },
    tests: { positive: [], negative: [], boundary: [] },
  });
  const overflow = {
    op: 'add',
    type: 'number',
    effect: 'pure',
    left: literal(1000000),
    right: literal(1),
  };
  assert.throws(
    () => evaluate(mappedExpression(rule, [literal(1), overflow]), []),
    e => e.code === 'E_NUMBER',
  );
});
test('frozen discovery and held-out source hashes survive unchanged rule reuse', async () => {
  const frozen = JSON.parse(await readFile('tests/data/phase1-frozen-inputs.json', 'utf8'));
  for (const f of frozen.apps) {
    const g = await collect('fixtures/' + f.app);
    assert.equal(g.hash, f.sourceHash);
    const { ir } = await lower(g);
    assert.equal(ir.mappings.length, 1);
    assert.equal(
      ir.mappings[0].sha256,
      hash(await readFile('tests/data/discovery-attempt-2-candidate.json')),
    );
  }
  for (const [helper, args, code] of [
    ['return Math.min(a+b,c)+1;', '1,1,3', 'E_MAPPING'],
    ['return Math.min(a+b,c);', '1,-1,3', 'E_MAPPING_PRECONDITION'],
  ])
    await fixture(`function step(a,b,c){${helper}}const App=()=> <p>{step(${args})}</p>;`, root =>
      assert.rejects(
        () => analyze(root),
        e => e.code === code,
      ),
    );
});
test('multi-rule acceptance is immutable and a failed rewrite preserves registry bytes', async () => {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/registry-'));
  const proof = path.join(root, 'proof.json');
  try {
    await accept('mappings/migrated-pure-clamp-v2.json', proof, { registryRoot: root });
    await accept(
      'tests/data/discovery-attempt-2-candidate.json',
      path.join(root, 'second-proof.json'),
      { registryRoot: root },
    );
    assert.equal((await loadRegistry(root)).length, 2);
    const before = await readFile(path.join(root, 'registry.lock.json'));
    const rule = JSON.parse(
      await readFile('tests/data/discovery-attempt-2-candidate.json', 'utf8'),
    );
    rule.tests.positive.push({ args: [0, 1, 3], expected: 1 });
    await writeFile(path.join(root, 'changed.json'), JSON.stringify(rule));
    await assert.rejects(
      () => accept(path.join(root, 'changed.json'), proof, { registryRoot: root }),
      e => e.code === 'E_RULE_VERSION',
    );
    assert.deepEqual(await readFile(path.join(root, 'registry.lock.json')), before);
    rule.lowering = { op: 'max', args: rule.lowering.args };
    rule.capabilities = ['integer-add', 'integer-max'];
    rule.version = 2;
    await writeFile(path.join(root, 'bad.json'), JSON.stringify(rule));
    await assert.rejects(
      () => accept(path.join(root, 'bad.json'), proof, { registryRoot: root }),
      e => e.code === 'E_RULE_DIFFERENTIAL',
    );
    assert.deepEqual(await readFile(path.join(root, 'registry.lock.json')), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('failed native build preserves an existing usable output directory', async () => {
  const root = await mkdtemp(path.resolve('.cache/tests/build-'));
  try {
    const out = path.join(root, 'out');
    await mkdir(out);
    await writeFile(path.join(out, 'runic-app'), 'previous binary');
    await writeFile(path.join(root, 'cargo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
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
test('overlapping validated but different lowerings diagnose ambiguity deterministically', async () => {
  const root = await mkdtemp(path.resolve('.cache/tests/overlap-'));
  try {
    await accept('mappings/migrated-pure-clamp-v2.json', path.join(root, 'a-proof.json'), {
      registryRoot: root,
    });
    const rule = JSON.parse(await readFile('mappings/migrated-pure-clamp-v2.json'));
    rule.id = 'alternate-clamp';
    rule.lowering = {
      op: 'max',
      args: [
        {
          op: 'min',
          args: [
            { op: 'param', index: 0 },
            { op: 'param', index: 2 },
          ],
        },
        { op: 'param', index: 1 },
      ],
    };
    const file = path.join(root, 'b.json');
    await writeFile(file, JSON.stringify(rule));
    await accept(file, path.join(root, 'b-proof.json'), { registryRoot: root });
    await fixture(
      'function clip(a,b,c){return Math.min(Math.max(a,b),c);}const App=()=> <p>{clip(2,1,3)}</p>;',
      app =>
        assert.rejects(
          () => collect(app).then(g => lower(g, { registryRoot: root })),
          e => e.code === 'E_MAPPING_AMBIGUOUS',
        ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('resource and cyclic metadata failures retain diagnostics', async () => {
  const { ir } = await analyze('fixtures/smoke');
  const broken = structuredClone(ir);
  broken.validation.domain = broken.validation;
  assert.throws(
    () => validateIR(broken),
    e => e.code === 'E_IR',
  );
  const domain = structuredClone(ir);
  domain.states[0].domain.values = [domain.states[0].domain];
  assert.throws(
    () => validateIR(domain),
    e => e.code === 'E_IR',
  );
  assert.throws(
    () => literal('x'.repeat(65537)),
    e => e.code === 'E_RESOURCE',
  );
  await fixture(
    `import './remote.css';const App=()=> <p>Hi</p>;`,
    root =>
      assert.rejects(
        () => collect(root),
        e => e.code === 'E_ASSET',
      ),
    {
      'remote.css':
        '@font-face{font-family:Remote;src:url("https://example.invalid/font.woff2") format("woff2");}',
    },
  );
});
