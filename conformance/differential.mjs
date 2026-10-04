#!/usr/bin/env node
// Differential test of generated code against the reference interpreter (D8):
// seeded random event traces run through `runic-codegen interp` and through
// the native probe; DOM and cells must agree after every step.
//
//   node conformance/differential.mjs [fixture ...] [--traces N] [--length N] [--seed S] [--no-opt]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret, migrate } from '../compiler/codegen.mjs';
import { buildApp } from '../compiler/cli.mjs';
import { runProbe } from './harness/native.mjs';
import { canonical } from './harness/compare.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    traces: { type: 'string', default: '20' },
    length: { type: 'string', default: '25' },
    seed: { type: 'string', default: '1' },
    'no-opt': { type: 'boolean' },
  },
});

// Small deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = ['', 'a', 'Hello', 'ünï 😀', 'x'.repeat(256), 'x'.repeat(257), 'line\nbreak', ' ', 'Jell', '100', '-40', '1e3', ' 0x10 ', '3.25', 'NaN', '  milk'];

/** The harness action delivering each event kind (as `EventKind::action`). */
const ACTION = {
  click: 'click',
  change: 'click',
  pointerdown: 'click',
  pointerup: 'click',
  mousedown: 'click',
  mouseup: 'click',
  dblclick: 'dblclick',
  contextmenu: 'contextmenu',
  pointermove: 'hover',
  pointerenter: 'hover',
  pointerleave: 'hover',
  mousemove: 'hover',
  mouseenter: 'hover',
  mouseleave: 'hover',
  input: 'input',
  keydown: 'keydown',
  keyup: 'keydown',
  wheel: 'wheel',
};

/** Literal option values of selects in the program (for `choose`). */
const optionValues = new Set();

/** Actions that deliver an event some listener in the program handles (any component). */
function eventKinds(ir) {
  const kinds = new Set();
  const walk = nodes => {
    for (const n of nodes ?? []) {
      // Selects are chosen (a click would open a popup over other targets).
      if (n.tag === 'select' && n.listeners?.length) kinds.add('choose');
      else for (const l of n.listeners ?? []) kinds.add(ACTION[l.event]);
      if (n.tag === 'option')
        for (const a of n.attrs ?? []) if (a.name === 'value' && a.value.op === 'lit') optionValues.add(a.value.value);
      for (const k of ['children', 'then', 'else', 'body', 'fallback']) walk(n[k]);
      for (const s of n.slots ?? []) walk(s.body);
    }
  };
  for (const c of ir.components) walk(c.template);
  return kinds;
}

/** Interpreter VNode JSON → the canonical shape used for native snapshots. */
function fromInterp(node) {
  if (typeof node === 'string') return { text: node };
  const out = { tag: node.tag };
  if (Object.keys(node.attrs).length) out.attributes = Object.fromEntries(Object.entries(node.attrs).sort());
  if (node.checked) out.checked = true;
  if (node.value !== undefined) out.value = node.value;
  const children = node.children.map(fromInterp);
  if (children.length) out.children = children;
  return out;
}

/** Strip runtime-only state (focus, selection, disabled flag) from canonical native nodes. */
function semantic(node) {
  if ('text' in node) return node;
  const { focused, selection, disabled, readOnly, composing, ...rest } = node;
  if (rest.children) rest.children = rest.children.map(semantic);
  return rest;
}

const fixtures = positionals.length
  ? positionals
  : (await readdir(path.join(repo, 'fixtures'), { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(n => !['unsupported-effect'].includes(n));
const random = rng(Number(values.seed));
let failures = 0;
let steps = 0;
for (const fixture of fixtures) {
  const dir = fixture.includes('/') ? path.join(repo, fixture) : path.join(repo, 'fixtures', fixture);
  const { ir } = await lower(await collect(dir));
  const kinds = eventKinds(migrate(ir));
  const out = path.join(repo, '.cache/conformance/diff-bin', path.basename(fixture) + (values['no-opt'] ? '-no-opt' : ''));
  await buildApp(dir, { out, probe: true, noOpt: values['no-opt'] });
  const binary = path.join(out, 'runic-app');
  // Targets are chosen from the live DOM: the n-th element listening for the
  // event, resolved identically by the interpreter and the probe.
  const weights = [
    ['click', 0.6],
    ['input', 0.3],
    ['keydown', 0.1],
    ['dblclick', 0.1],
    ['contextmenu', 0.1],
    ['hover', 0.2],
    ['wheel', 0.1],
    ['choose', 0.2],
  ].filter(([k]) => kinds.has(k));
  const total = weights.reduce((a, [, w]) => a + w, 0);
  let fixtureFailures = 0;
  for (let t = 0; t < Number(values.traces); t++) {
    const actions = [];
    for (let i = 0; i < Number(values.length) && weights.length; i++) {
      let r = random() * total;
      const [kind] = weights.find(([, w]) => (r -= w) < 0) ?? weights.at(-1);
      const nth = Math.floor(random() * 1000);
      if (kind === 'input') actions.push({ kind, nth, value: TEXTS[Math.floor(random() * TEXTS.length)] });
      else if (kind === 'keydown') actions.push({ kind, nth, key: random() < 0.7 ? 'Enter' : 'Escape' });
      else if (kind === 'wheel') actions.push({ kind, nth, deltaX: 0, deltaY: random() < 0.5 ? 100 : -40 });
      else if (kind === 'choose') {
        const values = [...optionValues];
        actions.push({ kind, nth, value: values[Math.floor(random() * values.length)] });
      }
      else actions.push({ kind, nth });
    }
    const expected = interpret(ir, actions);
    const actual = runProbe(binary, { actions }).steps;
    for (let i = 0; i < expected.length; i++) {
      steps++;
      const want = {
        dom: expected[i].state.dom.map(n => semantic(canonical(fromInterp(n)))),
        cells: expected[i].state.cells,
        instances: expected[i].state.instances ?? [],
        document: expected[i].state.document ?? {},
      };
      const got = {
        dom: (canonical(actual[i].dom).children ?? []).map(semantic),
        cells: actual[i].cells,
        instances: actual[i].instances ?? [],
        document: actual[i].document ?? {},
      };
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        fixtureFailures++;
        if (fixtureFailures <= 3)
          console.log(`MISMATCH ${fixture} trace ${t} step ${i} ${JSON.stringify(actions[i - 1] ?? null)}\n  interp ${JSON.stringify(want).slice(0, process.env.DIFF_FULL ? undefined : 600)}\n  native ${JSON.stringify(got).slice(0, process.env.DIFF_FULL ? undefined : 600)}`);
        break;
      }
    }
  }
  failures += fixtureFailures;
  console.log(`${fixture.padEnd(20)} ${fixtureFailures ? 'FAIL' : 'ok'} (${values.traces} traces x ${values.length} actions)`);
}
console.log(JSON.stringify({ fixtures: fixtures.length, steps, failures, seed: Number(values.seed), optimize: !values['no-opt'] }));
process.exitCode = failures ? 1 : 0;
