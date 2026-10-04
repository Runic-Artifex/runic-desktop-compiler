#!/usr/bin/env node
// Conformance runner: original framework in headless Chromium vs the native
// application, per case, fixture and viewport.
//
//   node conformance/run.mjs [case-name ...] [--pixels] [--release] [--no-opt] [--out DIR]
//                            [--renderer cpu|gpu] [--gpu-adapter lavapipe|system]
//
// `--renderer gpu` builds the fixtures with the GPU renderer (D12) whatever
// runic.json selects, and the probe draws its screenshots with it: by default
// on Mesa's software Vulkan driver (lavapipe) from the locked shell, with
// `--gpu-adapter system` on the adapter wgpu picks from the host's drivers.
// The gates and tolerances are the same.
//
// Exit codes: 0 all gates passed, 1 a failure, 2 incomplete (a stage could
// not run). Reports: <out>/report.json and one file per run.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBrowserHarness } from './harness/browser.mjs';
import { buildProbe, runProbe } from './harness/native.mjs';
import { compareTraces } from './harness/compare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pixels: { type: 'boolean' },
    release: { type: 'boolean' },
    'no-opt': { type: 'boolean' },
    out: { type: 'string' },
    quiet: { type: 'boolean' },
    renderer: { type: 'string' },
    'gpu-adapter': { type: 'string' },
  },
});
const renderer = values.renderer;
if (renderer !== undefined && !['cpu', 'gpu'].includes(renderer)) throw new Error('--renderer takes cpu or gpu');
const gpuAdapter = renderer === 'gpu' ? (values['gpu-adapter'] ?? 'lavapipe') : undefined;
if (values['gpu-adapter'] && renderer !== 'gpu') throw new Error('--gpu-adapter needs --renderer gpu');

/** Expand shorthands identically for both sides. */
function expand(actions) {
  return actions.map(a => (a.repeat ? { ...a, text: a.text.repeat(a.repeat), repeat: undefined } : a));
}

async function loadCases(names) {
  const dir = path.join(here, 'cases');
  const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
  const cases = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    if (names.length && !names.includes(name)) continue;
    cases.push({ name, ...JSON.parse(await readFile(path.join(dir, f), 'utf8')) });
  }
  if (names.length && cases.length !== names.length) throw new Error('Unknown case in: ' + names.join(', '));
  return cases;
}

const out = path.resolve(values.out ?? path.join(repo, 'artifacts/conformance', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(out, { recursive: true });
const cases = await loadCases(positionals);
const browser = await createBrowserHarness();
const binaries = new Map();
const runs = [];
let incomplete = false;
try {
  for (const c of cases) {
    const viewports = (c.viewports ?? [[800, 600], [420, 600]]).map(([width, height]) => ({ width, height }));
    const actions = expand(c.actions);
    for (const fixture of c.fixtures) {
      const dir = fixture.includes('/') ? path.join(repo, fixture) : path.join(repo, 'fixtures', fixture);
      if (!binaries.has(fixture)) binaries.set(fixture, await buildProbe(dir, { release: values.release, noOpt: values['no-opt'], renderer }));
      const { binary, ir } = binaries.get(fixture);
      for (const viewport of viewports) {
        const label = `${c.name}/${fixture}/${viewport.width}x${viewport.height}`;
        const shots = path.join(out, 'shots', c.name, fixture, `${viewport.width}x${viewport.height}`);
        const run = { case: c.name, fixture, viewport, irHash: ir.irHash };
        try {
          // Chromium's real clock is observable without the fake clock, so a
          // program reading the wall clock (Date.now, new Date()) needs it.
          const fakeClock = c.clock === true || actions.some(a => a.kind === 'wait');
          if (!fakeClock && /"clock\.(date|now)"/.test(JSON.stringify(ir)))
            throw new Error(
              'The program reads the clock (Date.now(), new Date(), performance.now()), which Chromium shows in real time: give the case "clock": true or a wait action',
            );
          // The case's environment: localStorage, time zone and locale, start
          // URL, clipboard text, random seed.
          const env = {
            storage: c.storage,
            timezone: c.timezone,
            locale: c.locale,
            url: c.url,
            clipboard: c.clipboard,
            seed: c.seed,
          };
          const b = await browser.run(dir, { viewport, actions, ...env, clock: fakeClock, out: values.pixels ? path.join(shots, 'browser') : path.join(out, 'tmp') });
          const n = runProbe(binary, { viewport, actions, ...env, visibleTargets: true, gpuAdapter, out: values.pixels ? path.join(shots, 'native') : undefined });
          if (n.renderer) run.renderer = n.renderer;
          run.browser = { framework: b.framework, browserVersion: browser.browserVersion, errors: b.errors };
          run.mountUs = n.mountUs;
          const cmp = compareTraces(b.steps, n.steps, { pixels: values.pixels, pixelRegions: c.pixelRegions });
          Object.assign(run, cmp);
          if (b.errors?.length) run.passed.semantics = false;
          // A documented known gap is reported as such, never as a pass.
          for (const [gate, reason] of Object.entries(c.knownGaps ?? {}))
            if (run.passed[gate] === false) {
              run.passed[gate] = 'known-gap';
              run.knownGap = { ...(run.knownGap ?? {}), [gate]: reason };
            }
        } catch (e) {
          run.error = String(e.stack ?? e);
          run.passed = { semantics: null, geometry: null, pixels: null };
          incomplete = true;
        }
        runs.push(run);
        const flag = v => (v === null ? '-' : v === 'known-gap' ? 'GAP' : v ? 'ok' : 'FAIL');
        if (!values.quiet)
          console.log(
            `${label.padEnd(48)} semantics ${flag(run.passed.semantics)}  geometry ${flag(run.passed.geometry)}` +
              (values.pixels ? `  pixels ${flag(run.passed.pixels)}` : '') +
              (run.error ? `  ERROR ${run.error.split('\n')[0]}` : ''),
          );
        await writeFile(path.join(out, `${c.name}--${path.basename(fixture)}--${viewport.width}x${viewport.height}.json`), JSON.stringify(run, null, 2) + '\n');
      }
    }
  }
} finally {
  await browser.close();
}
const gate = key => {
  const vals = runs.map(r => r.passed[key]);
  if (vals.includes(null)) return 'incomplete';
  if (vals.includes(false)) return 'failed';
  return vals.includes('known-gap') ? 'passed-with-known-gaps' : 'passed';
};
const summary = {
  schema: 1,
  runs: runs.length,
  browserVersion: browser.browserVersion,
  ...(renderer ? { renderer } : {}),
  ...(gpuAdapter ? { gpuAdapters: [...new Set(runs.map(r => r.renderer?.adapter).filter(Boolean))] } : {}),
  gates: { semantics: gate('semantics'), geometry: gate('geometry'), ...(values.pixels ? { pixels: gate('pixels') } : {}) },
  knownGaps: runs
    .filter(r => r.knownGap)
    .map(r => ({ run: `${r.case}/${r.fixture}/${r.viewport.width}x${r.viewport.height}`, ...r.knownGap })),
  failures: runs
    .filter(r => r.error || Object.values(r.passed).some(v => v === false))
    .map(r => `${r.case}/${r.fixture}/${r.viewport.width}x${r.viewport.height}`),
};
await writeFile(path.join(out, 'report.json'), JSON.stringify({ summary, runs }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
console.log('Report:', path.relative(repo, path.join(out, 'report.json')));
const gates = Object.values(summary.gates);
process.exitCode = gates.includes('failed') ? 1 : incomplete || gates.includes('incomplete') ? 2 : 0;
