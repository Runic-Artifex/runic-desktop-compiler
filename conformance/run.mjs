#!/usr/bin/env node
// Conformance runner: original framework in headless Chromium vs the native
// application, per case, fixture and viewport.
//
//   node conformance/run.mjs [case-name ...] [--pixels] [--release] [--no-opt] [--out DIR]
//                            [--renderer cpu|gpu] [--gpu-adapter lavapipe|system]
//                            [--fixture NAME ...] [--retain-snapshots]
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
import { checkExpectedText } from './harness/expectations.mjs';
import { generate } from '../compiler/generate.mjs';
import { globSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pixels: { type: 'boolean' },
    'retain-snapshots': { type: 'boolean' },
    release: { type: 'boolean' },
    'no-opt': { type: 'boolean' },
    out: { type: 'string' },
    quiet: { type: 'boolean' },
    renderer: { type: 'string' },
    'gpu-adapter': { type: 'string' },
    fixture: { type: 'string', multiple: true },
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
if (values.fixture) {
  const available = new Set(cases.flatMap(c => c.fixtures));
  for (const name of values.fixture) {
    if (!available.has(name)) throw new Error(`Unknown fixture in selected cases: ${name}`);
  }
}
const browser = await createBrowserHarness();
const binaries = new Map();
/** Fixtures whose generated inputs this run made. */
const generated = new Set();
/**
 * A fixture's generated inputs (runic.json `generate`, a SvelteKit app's server
 * code), made once per run with `runic generate` before either side builds:
 * builds never run generators (compiler/generate.mjs).
 */
async function prepare(dir) {
  if (generated.has(dir)) return;
  generated.add(dir);
  const config = JSON.parse(readFileSync(path.join(dir, 'runic.json'), 'utf8'));
  const server = config.kit === true && globSync('src/routes/**/+*server.{ts,js}', { cwd: dir }).length > 0;
  if (config.generate?.length || server) await generate(dir);
}
const runs = [];
let incomplete = false;
// Bind retained observations to the generated inputs and executable actually
// consumed by this capture. A later cache rebuild must not replace provenance.
function captureBuild(binary) {
  const directory = path.dirname(binary);
  const files = [
    'runic-app', 'ir.json', 'build.json', 'Cargo.toml', 'Cargo.lock',
    'src/main.rs', 'src/app.rs',
    ...globSync('assets/**/*', { cwd: directory, nodir: true }).sort(),
  ].map(name => {
    const file = path.join(directory, name), bytes = readFileSync(file);
    return { path: path.relative(repo, file), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { schema: 1, files, metadata: JSON.parse(readFileSync(path.join(directory, 'build.json'), 'utf8')) };
}
try {
  for (const c of cases) {
    const viewports = (c.viewports ?? [[800, 600], [420, 600]]).map(([width, height]) => ({ width, height }));
    const actions = expand(c.actions);
    for (const fixture of c.fixtures) {
      if (values.fixture && !values.fixture.includes(fixture)) continue;
      const dir = fixture.includes('/') ? path.join(repo, fixture) : path.join(repo, 'fixtures', fixture);
      await prepare(dir);
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
          // document.title is a host effect of programs that set it (M6).
          const trackTitle = /"document\.set-title"/.test(JSON.stringify(ir));
          const b = await browser.run(dir, { viewport, actions, ...env, clock: fakeClock, trackTitle, out: values.pixels ? path.join(shots, 'browser') : path.join(out, 'tmp') });
          const capturedBuild = values['retain-snapshots'] ? captureBuild(binary) : undefined;
          const n = runProbe(binary, { viewport, actions, ...env, visibleTargets: true, gpuAdapter, out: values.pixels ? path.join(shots, 'native') : undefined });
          if (values['retain-snapshots']) {
            if (JSON.stringify(capturedBuild) !== JSON.stringify(captureBuild(binary)))
              throw new Error('Native executable or generated inputs changed during capture');
            run.nativeBuild = capturedBuild;
            const observations = path.join('observations', `${c.name}--${path.basename(fixture)}--${viewport.width}x${viewport.height}`);
            await mkdir(path.join(out, observations), { recursive: true });
            run.observations = { browser: path.join(observations, 'browser.json'), native: path.join(observations, 'native.json') };
            await writeFile(path.join(out, run.observations.browser), JSON.stringify(b, null, 2) + '\n');
            await writeFile(path.join(out, run.observations.native), JSON.stringify(n, null, 2) + '\n');
          }
          if (n.renderer) run.renderer = n.renderer;
          run.browser = { framework: b.framework, browserVersion: browser.browserVersion, errors: b.errors };
          run.mountUs = n.mountUs;
          const cmp = compareTraces(b.steps, n.steps, { pixels: values.pixels, pixelRegions: c.pixelRegions });
          Object.assign(run, cmp);
          if (c.expectedText !== undefined) {
            run.textExpectations = {
              browser: checkExpectedText(b.steps, c.expectedText),
              native: checkExpectedText(n.steps, c.expectedText),
            };
            if (!run.textExpectations.browser.passed || !run.textExpectations.native.passed)
              run.passed.semantics = false;
          }
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
