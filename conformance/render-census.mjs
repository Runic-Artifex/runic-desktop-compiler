#!/usr/bin/env node
// Render census of the shadcn-svelte component examples that lower: each
// example the example census (conformance/triage.mjs) lowers is built
// natively with probes and its first settled frame compared with Chromium's,
// with the conformance harness's capture, probe and comparison
// (harness/browser.mjs, harness/native.mjs, harness/compare.mjs) and its
// gates and tolerances. No interactions: the mount and the settled state.
//
//   node conformance/render-census.mjs [example ...] [--census FILE] [--out DIR]
//        [--triage DIR] [--jobs N] [--keep-shots] [--resume]
//
// Hosts: the census's own. The lowered examples of --census (default
// conformance/results/shadcn-svelte-census.json; its `lowered` list, or the
// `results` of a full census.json) are rerun through triage.mjs with
// --keep-lib into <out>/triage, which re-checks that they lower at this
// compiler and keeps their hosts (--triage DIR reuses such a run). An example
// that no longer lowers is `notLowered`.
//
// Images (the user authorised the fetch for this census): remote URLs are
// pinned in each host by the explicit `runic images` step (compiler/images.mjs
// fetchImages; one network fetch per URL, shared by the hosts of the run), and
// root-relative ones are copied from the directory the site serves them from,
// the corpus's docs/static/, into the host's static directory (public/, or
// static/ in a Kit host). A URL that cannot be pinned, or a file the site does
// not have, makes the example `incomplete`.
//
// Per example: `node compiler/cli.mjs build <host> --probe` (the probe build
// run.mjs uses: dev profile, CPU renderer, on the shared target under its
// lock) into .cache/conformance/bin/<example>, then Chromium's and the probe's
// states at viewport 800x600 with run.mjs's environment defaults, both on the
// virtual clock (as a case with `"clock": true`): the mount and, after the
// action `wait 0` (virtual time does not advance; what the program scheduled
// without delay runs, such as bits-ui Avatar's 0 ms image delay), the settled
// state, the first frame a user sees. compareTraces compares both states
// with pixels; the report details the settled one, and gates on both. The pixel gate is run.mjs's:
// whole-viewport mean error <= 3/255, plus the same tolerance over the region
// of `#demo`, the element the host mounts the example in (the census's
// stand-in for a case's pixel regions; it covers the example, so a small
// example cannot pass on the empty page around it). Geometry compares the
// elements with ids (run.mjs's 2 px).
//
// The census theme styles Button, Dialog, Field, Input and Label only (the
// site's other components take their rules from style-vega.css, which it
// lacks): each report lists the `cn-*` classes the example uses that the
// theme has no rule for, and the totals split the statuses by it.
//
// Statuses:
//   matches            every gate passed;
//   differs            a gate failed: the worst (semantics, then geometry, then
//                      pixels) with its element or region and numbers;
//   reportsUnsupported the app reported `runic: E_*` or `runic: unsupported`
//                      at run time (a probe stops at `unsupported`), with the
//                      report; a probe that completed keeps its comparison;
//   buildFailed        codegen or cargo failed, with the first error;
//   nativeFailed       the probe crashed or timed out (not a report), with
//                      the reason;
//   notLowered         the example no longer lowers (triage's status and code);
//   incomplete         a stage could not run (image pinning, Chromium, the
//                      Kit build), with the reason; never counted as passed.
//
// Evidence: <out>/reports/<example>.json (stages, timings, disk, the
// comparison's differences), <out>/logs/<example>.build.log and .probe.log,
// <out>/render-census.json (all results, clusters) and
// <out>/render-census-summary.json (the compact form committed under
// conformance/results/). After its comparison each example's binary,
// generated crate, screenshots, Vite cache, Kit build and host are removed
// (--keep-shots keeps the screenshots and the host). --resume skips the
// examples that already have a report.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  copyFileSync,
  globSync,
} from 'node:fs';
import { createBrowserHarness } from './harness/browser.mjs';
import { runProbe, probeFailureReason } from './harness/native.mjs';
import {
  compareTraces,
  GEOMETRY_TOLERANCE,
  PIXEL_MAE_TOLERANCE,
  canonical,
} from './harness/compare.mjs';
import { fetchImages } from '../compiler/images.mjs';
import { generate } from '../compiler/generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    census: { type: 'string', default: 'conformance/results/shadcn-svelte-census.json' },
    out: { type: 'string', default: 'artifacts/render-census' },
    triage: { type: 'string' },
    jobs: { type: 'string', default: '2' },
    'keep-shots': { type: 'boolean' },
    resume: { type: 'boolean' },
  },
});
const viewport = { width: 800, height: 600 };
/**
 * Both sides on the harness's virtual clock (browser.mjs's fake clock, the
 * probe's own): the mount, then `wait 0`, which runs what the program
 * scheduled without delay (bits-ui's Avatar loads its image after a 0 ms
 * delay). CSS animations are then at the same virtual time on both sides.
 */
const actions = [{ kind: 'wait', ms: 0 }];
const steps = ['mount', 'wait 0'];
const region = 'demo';
const strip = s => String(s).replace(/\u001b\[[0-9;]*m/g, '');
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

const out = path.resolve(repo, values.out);
if (!out.startsWith(path.join(repo, 'artifacts') + path.sep))
  throw new Error('--out must be under artifacts/');
for (const d of ['reports', 'logs', 'shots']) mkdirSync(path.join(out, d), { recursive: true });

// The examples: the census's lowered ones, or those named.
const census = JSON.parse(readFileSync(path.resolve(repo, values.census), 'utf8'));
const lowered =
  census.lowered ?? census.results.filter(r => r.status === 'lowered').map(r => r.example);
for (const name of positionals)
  if (!lowered.includes(name)) throw new Error(`${name} is not lowered in ${values.census}`);
let selected = positionals.length ? positionals : lowered;
if (values.resume)
  selected = selected.filter(n => !existsSync(path.join(out, 'reports', n + '.json')));

// Hosts: triage.mjs's, kept (--keep-lib), rerun at this compiler.
const triage = path.resolve(repo, values.triage ?? path.join(values.out, 'triage'));
if (!values.triage && selected.length) {
  const r = spawnSync(
    process.execPath,
    [
      path.join(here, 'triage.mjs'),
      '--keep-lib',
      '--out',
      path.relative(repo, triage),
      '--jobs',
      '4',
      ...selected,
    ],
    { cwd: repo, stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`triage.mjs exited ${r.status}`);
}
const fresh = new Map(
  JSON.parse(readFileSync(path.join(triage, 'census.json'), 'utf8')).results.map(r => [
    r.example,
    r,
  ]),
);
const manifest = JSON.parse(
  readFileSync(path.join(repo, 'conformance/corpus/north-star.json'), 'utf8'),
);
const source = manifest.sources.find(s => s.name === 'shadcn-svelte');
const siteStatic = path.join(repo, '.cache/corpus', source.name, source.target, 'static');

// The style classes: the site styles its components with `cn-*` classes whose
// rules are in registry/styles/style-vega.css (the default style); the census
// theme carries those of Button, Dialog, Field, Input and Label only. Each
// report records the `cn-*` classes the example's lib files use and those the
// host theme has no rule for: a component without its rules renders unstyled
// on both sides, so its comparison does not cover the site's look.
const cnClasses = text => new Set(text.match(/\.cn-[a-z0-9-]+/g)?.map(c => c.slice(1)) ?? []);
const vegaClasses = cnClasses(
  readFileSync(
    path.join(
      repo,
      '.cache/corpus',
      source.name,
      source.target,
      'src/lib/registry/styles/style-vega.css',
    ),
    'utf8',
  ),
);
function styleCoverage(dir) {
  const theme = cnClasses(readFileSync(path.join(dir, 'src/app.css'), 'utf8'));
  const used = new Set();
  for (const f of globSync('src/lib/**/*.{svelte,ts,js}', { cwd: dir }))
    for (const m of readFileSync(path.join(dir, f), 'utf8').matchAll(/\bcn-[a-z0-9-]+/g))
      if (vegaClasses.has(m[0])) used.add(m[0]);
  const unstyled = [...used].filter(c => !theme.has(c)).sort();
  return { used: used.size, unstyled };
}

/** One network fetch per URL for the run; each host's `runic images` reads it. */
const fetched = new Map();
const sharedFetch = (url, init) => {
  if (!fetched.has(url))
    fetched.set(
      url,
      fetch(url, init).then(async r => ({
        status: r.status,
        headers: [...r.headers],
        bytes: r.ok ? Buffer.from(await r.arrayBuffer()) : null,
      })),
    );
  return fetched
    .get(url)
    .then(c => new Response(c.bytes, { status: c.status, headers: c.headers }));
};

/** Pin the host's images; returns { pinned } or { incomplete: reason }. */
async function pinHostImages(dir, urls, kit) {
  const remote = urls.filter(u => /^https?:\/\//i.test(u));
  const local = urls.filter(u => u.startsWith('/') && !u.startsWith('//'));
  const pinned = { remote: [], local: [] };
  for (const url of local) {
    const rel = decodeURIComponent(url.split(/[?#]/)[0]).slice(1);
    const from = path.join(siteStatic, rel);
    if (!from.startsWith(siteStatic + path.sep) || !existsSync(from))
      return {
        incomplete: `the site serves no ${url}: ${path.relative(repo, siteStatic)} has no ${rel}`,
      };
    const to = path.join(dir, kit ? 'static' : 'public', rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    pinned.local.push({ url, from: path.relative(repo, from) });
  }
  if (remote.length) {
    try {
      await fetchImages(dir, {
        imageUrls: remote.map(url => ({ url, source: undefined })),
        fetch: sharedFetch,
      });
    } catch (e) {
      return { incomplete: `runic images: ${strip(e.message)}` };
    }
    pinned.remote = JSON.parse(readFileSync(path.join(dir, 'runic.images.json'), 'utf8')).images;
  }
  return { pinned };
}

/** du -sb of the paths that exist (bytes). */
function bytesOf(paths) {
  const present = paths.filter(p => existsSync(p));
  if (!present.length) return 0;
  const r = spawnSync('du', ['-scb', ...present], { encoding: 'utf8' });
  return Number(/(\d+)\s+total/.exec(r.stdout)?.[1] ?? 0);
}

/** `node compiler/cli.mjs build <dir> --probe`; the log keeps cargo's output. */
function build(dir, binDir, log) {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [path.join(repo, 'compiler/cli.mjs'), 'build', dir, '--probe', '--out', binDir],
      { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', status => {
      writeFileSync(log, stdout + '\n--- stderr\n' + stderr);
      resolve({ status, stdout, stderr: strip(stderr) });
    });
  });
}

/** The first error of a failed build: cargo's first `error`, else the diagnostic. */
function firstBuildError(stderr) {
  const lines = stderr.split('\n');
  const i = lines.findIndex(l => /^error(\[E\d+\])?:/.test(l));
  if (i >= 0) {
    const at = lines.slice(i + 1, i + 4).find(l => l.trim().startsWith('-->'));
    return { kind: 'cargo', message: lines[i], ...(at ? { at: at.trim().slice(4) } : {}) };
  }
  const json = stderr.slice(stderr.lastIndexOf('\n{') + 1);
  try {
    const d = JSON.parse(json);
    return {
      kind: 'diagnostic',
      code: d.code,
      message: strip(d.message).split('\n')[0],
      source: d.source ?? null,
    };
  } catch {
    return { kind: 'unknown', message: lines.filter(Boolean).at(-1) ?? '' };
  }
}

/** The app's run-time reports on stderr. */
const reportsOf = stderr => [
  ...new Set(
    strip(stderr)
      .split('\n')
      .filter(l => /^runic: (E_[A-Z_]+|unsupported)\b/.test(l)),
  ),
];

/** Bounding box (x, y, width, height) and share of the pixels differing by more than 3%. */
function diffRegion(a, b) {
  const r = spawnSync(
    'magick',
    [
      a,
      b,
      '-compose',
      'difference',
      '-composite',
      '-colorspace',
      'gray',
      '-threshold',
      '3%',
      '-format',
      '%@ %[fx:mean]',
      'info:',
    ],
    { encoding: 'utf8' },
  );
  const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+) ([0-9.e+-]+)/.exec(r.stdout);
  if (!m) return null;
  const share = Number(m[5]);
  if (share === 0) return { share: 0 };
  return { x: +m[3], y: +m[4], width: +m[1], height: +m[2], share: +share.toFixed(5) };
}

/** A short form of a DOM difference, and its cluster key. */
function describeDom(d) {
  const tag = n => (n && 'text' in n ? '#text' : (n?.tag ?? 'none'));
  if (d.at === 'document' || d.at === 'body') {
    const keys = [...new Set([...Object.keys(d.browser), ...Object.keys(d.native)])].filter(
      k => d.browser[k] !== d.native[k],
    );
    return {
      key: `${d.at} attributes ${keys.join(',')}`,
      at: d.at,
      browser: d.browser,
      native: d.native,
    };
  }
  const b = d.browser;
  const n = d.native;
  if (b && n && 'text' in b && 'text' in n)
    return { key: 'text', at: d.at, browser: b.text.slice(0, 120), native: n.text.slice(0, 120) };
  if (b && n && !('text' in b) && !('text' in n) && b.tag === n.tag && !b.children && !n.children) {
    // The element itself (children are diffed separately).
    const ab = b.attributes ?? {};
    const an = n.attributes ?? {};
    const attrs = [...new Set([...Object.keys(ab), ...Object.keys(an)])]
      .filter(k => ab[k] !== an[k])
      .sort();
    const props = ['disabled', 'focused', 'readOnly', 'checked', 'value', 'selection'].filter(
      k => JSON.stringify(b[k]) !== JSON.stringify(n[k]),
    );
    const diff = Object.fromEntries([
      ...attrs.map(k => [k, { browser: ab[k] ?? null, native: an[k] ?? null }]),
      ...props.map(k => [k, { browser: b[k] ?? null, native: n[k] ?? null }]),
    ]);
    return { key: `<${b.tag}> ${[...attrs, ...props].join(',')}`, at: d.at, diff };
  }
  return {
    key: `structure ${tag(b)} vs ${tag(n)}`,
    at: d.at,
    browser: b ? JSON.stringify(b).slice(0, 300) : null,
    native: n ? JSON.stringify(n).slice(0, 300) : null,
  };
}

/** The tag of the element with `id` in a snapshot's tree. */
function tagOf(step, id) {
  const visit = n => {
    if (!n || 'text' in n) return null;
    if (n.attributes?.id === id) return n.tag;
    for (const c of n.children ?? []) {
      const t = visit(c);
      if (t) return t;
    }
    return null;
  };
  return (
    visit(canonical(step.dom)) ??
    (step.portals ?? []).map(p => visit(canonical(p))).find(Boolean) ??
    null
  );
}

/** Whether a compared state fails a gate. */
const failing = st =>
  Boolean(
    st.missing ||
    st.dom.length ||
    st.focus ||
    st.host ||
    st.geometry.length ||
    !(st.pixelMAE <= PIXEL_MAE_TOLERANCE) ||
    Object.values(st.regionMAE ?? {}).some(m => m > PIXEL_MAE_TOLERANCE),
  );

/**
 * The comparison's differences in a bounded form, and the worst gate. The
 * detail is the settled state's (the last), unless only the mount differs.
 */
function summarise(cmp, b, n) {
  const first = cmp.steps.findIndex(failing);
  const k = failing(cmp.steps.at(-1)) || first < 0 ? cmp.steps.length - 1 : first;
  const s = cmp.steps[k];
  const r = {
    passed: cmp.passed,
    step: steps[k],
    failingSteps: cmp.steps.filter(failing).map(st => steps[st.index]),
  };
  if (s.missing) return { ...r, worst: { gate: 'semantics', key: `missing ${s.missing} state` } };
  const dom = s.dom.map(describeDom);
  if (b.errors?.length) r.browserErrors = b.errors.slice(0, 5);
  if (dom.length) r.dom = { count: dom.length, first: dom.slice(0, 12) };
  if (s.focus) r.focus = s.focus;
  if (s.host) r.host = s.host;
  const geometry = s.geometry
    .map(g => ({
      ...g,
      tag: tagOf(b.steps[k], g.id) ?? tagOf(n.steps[k], g.id),
      size: g.delta ? Math.max(...Object.values(g.delta).map(Math.abs)) : Infinity,
    }))
    .sort((x, y) => y.size - x.size);
  if (geometry.length)
    r.geometry = {
      count: geometry.length,
      worst: geometry.slice(0, 8).map(({ size, ...g }) => g),
    };
  r.pixels = { mae: s.pixelMAE, regionMAE: s.regionMAE?.[region] ?? null };
  const bs = b.steps[k].screenshotPath;
  const ns = n.steps[k].screenshotPath;
  if (bs && ns) r.pixels.diff = diffRegion(bs, ns);
  if (!cmp.passed.semantics) {
    const first = b.errors?.length
      ? { key: `Chromium ${b.errors[0].kind} error` }
      : dom.length
        ? dom[0]
        : s.focus
          ? { key: 'focus' }
          : { key: 'host effects' };
    r.worst = { gate: 'semantics', key: first.key, count: dom.length };
  } else if (!cmp.passed.geometry) {
    const g = geometry[0];
    const axes = g.delta
      ? Object.entries(g.delta)
          .filter(([, v]) => Math.abs(v) > GEOMETRY_TOLERANCE)
          .map(([k]) => k)
      : [g.browser ? 'absent natively' : 'absent in Chromium'];
    r.worst = {
      gate: 'geometry',
      key: `<${g.tag ?? '?'}> ${axes.join(',')}`,
      element: g.id,
      delta: g.delta ?? null,
      count: geometry.length,
    };
  } else if (!cmp.passed.pixels) {
    // Whether run.mjs's whole-viewport gate fails too, or only the region's.
    const which = s.pixelMAE > PIXEL_MAE_TOLERANCE ? 'viewport' : `#${region} only`;
    r.worst = {
      gate: 'pixels',
      key: which,
      mae: s.pixelMAE,
      regionMAE: s.regionMAE?.[region] ?? null,
      diff: r.pixels.diff,
    };
  }
  return r;
}

const browser = await createBrowserHarness();
const binRoot = path.join(repo, '.cache/conformance/bin');

async function renderOne(name) {
  const t0 = Date.now();
  const ms = {};
  const time = async (stage, f) => {
    const t = Date.now();
    try {
      return await f();
    } finally {
      ms[stage] = Date.now() - t;
    }
  };
  const t = fresh.get(name);
  const report = { example: name, ...(t?.kitHost ? { kitHost: true } : {}) };
  const dir = path.join(triage, 'hosts', name);
  const binDir = path.join(binRoot, name);
  const shots = path.join(out, 'shots', name);
  const owned = [
    binDir,
    shots,
    path.join(repo, '.cache/vite-references', name),
    path.join(repo, '.cache/conformance/kit', name),
  ];
  const finish = r => {
    Object.assign(report, r, { ms: { ...ms, total: Date.now() - t0 } });
    report.disk = { bytes: bytesOf([...owned, dir]) };
    if (!values['keep-shots']) {
      for (const p of owned) rmSync(p, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    } else rmSync(binDir, { recursive: true, force: true });
    writeFileSync(
      path.join(out, 'reports', name + '.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    return report;
  };
  if (!t) return finish({ status: 'incomplete', reason: 'no triage result' });
  if (t.status !== 'lowered')
    return finish({
      status: 'notLowered',
      reason: `${t.status}${t.code ? ' ' + t.code : ''}: ${(t.message ?? t.reason ?? '').split('\n')[0]}`,
    });
  if (!existsSync(dir)) return finish({ status: 'incomplete', reason: `no host at ${dir}` });
  report.style = styleCoverage(dir);

  // Images.
  if (t.imageUrls?.length) {
    const p = await time('images', () => pinHostImages(dir, t.imageUrls, Boolean(t.kitHost)));
    if (p.incomplete)
      return finish({ status: 'incomplete', stage: 'images', reason: p.incomplete });
    report.images = p.pinned;
  }
  // Generated inputs, as run.mjs prepares them (a Kit app's server code).
  const config = JSON.parse(readFileSync(path.join(dir, 'runic.json'), 'utf8'));
  if (
    config.generate?.length ||
    (config.kit === true && globSync('src/routes/**/+*server.{ts,js}', { cwd: dir }).length)
  )
    await generate(dir);

  // Native build.
  const b0 = await time('build', () =>
    build(dir, binDir, path.join(out, 'logs', name + '.build.log')),
  );
  if (b0.status !== 0) return finish({ status: 'buildFailed', error: firstBuildError(b0.stderr) });
  const binary = path.join(binDir, 'runic-app');
  const ir = JSON.parse(readFileSync(path.join(binDir, 'ir.json'), 'utf8'));
  const irText = JSON.stringify(ir);
  report.binaryBytes = bytesOf([binary]);

  // Chromium.
  const trackTitle = /"document\.set-title"/.test(irText);
  let b;
  try {
    b = await time('browser', () =>
      browser.run(dir, {
        viewport,
        actions,
        clock: true,
        trackTitle,
        out: path.join(shots, 'browser'),
      }),
    );
  } catch (e) {
    return finish({
      status: 'incomplete',
      stage: 'browser',
      reason: strip(e.message).split('\n').slice(0, 3).join(' '),
    });
  }

  // Native probe.
  let n;
  const tp = Date.now();
  try {
    n = runProbe(binary, {
      viewport,
      actions,
      visibleTargets: true,
      out: path.join(shots, 'native'),
      stderr: true,
    });
  } catch (e) {
    ms.probe = Date.now() - tp;
    if (e.code !== 'E_NATIVE_PROBE') throw e;
    writeFileSync(path.join(out, 'logs', name + '.probe.log'), e.stderr);
    const unsupported = /panicked at [^\n]*\n\s*unsupported: ([^\n]*)/.exec(strip(e.stderr));
    const reports = reportsOf(e.stderr);
    if (unsupported || reports.length)
      return finish({
        status: 'reportsUnsupported',
        reports: [...reports, ...(unsupported ? [`runic: unsupported: ${unsupported[1]}`] : [])],
        probeStopped: true,
      });
    return finish({ status: 'nativeFailed', reason: probeFailureReason(e) });
  }
  ms.probe = Date.now() - tp;
  if (n.stderr) writeFileSync(path.join(out, 'logs', name + '.probe.log'), n.stderr);
  report.mountUs = n.mountUs;

  // Comparison.
  const cmp = await time('compare', () =>
    compareTraces(b.steps, n.steps, { pixels: true, pixelRegions: [region] }),
  );
  if (b.errors?.length) cmp.passed.semantics = false;
  const comparison = summarise(cmp, b, n);
  const reports = reportsOf(n.stderr ?? '');
  if (reports.length) return finish({ status: 'reportsUnsupported', reports, comparison });
  const passed = Object.values(cmp.passed).every(v => v === true);
  return finish({ status: passed ? 'matches' : 'differs', comparison });
}

const queue = [...selected];
const t0 = Date.now();
let done = 0;
try {
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(4, Number(values.jobs))) }, async () => {
      while (queue.length) {
        const name = queue.shift();
        let r;
        try {
          r = await renderOne(name);
        } catch (e) {
          r = {
            example: name,
            status: 'incomplete',
            reason: `harness: ${strip(e.stack ?? e)
              .split('\n')
              .slice(0, 4)
              .join(' ')}`,
          };
          writeFileSync(
            path.join(out, 'reports', name + '.json'),
            JSON.stringify(r, null, 2) + '\n',
          );
        }
        done++;
        const detail =
          r.status === 'differs'
            ? `${r.comparison.worst.gate} ${r.comparison.worst.key}`
            : (r.reason ?? r.error?.message ?? r.reports?.[0] ?? '');
        console.log(
          `[${done}/${selected.length}] ${name} ${r.status} ${detail} (${Math.round((r.ms?.total ?? 0) / 1000)} s, ${Math.round((r.disk?.bytes ?? 0) / 2 ** 20)} MiB)`,
        );
      }
    }),
  );
} finally {
  await browser.close();
}

// The census of every report in <out>/reports (a resumed run included).
const results = globSync('*.json', { cwd: path.join(out, 'reports') })
  .map(f => JSON.parse(readFileSync(path.join(out, 'reports', f), 'utf8')))
  .sort((a, b) => a.example.localeCompare(b.example));
const statuses = [
  'matches',
  'differs',
  'reportsUnsupported',
  'buildFailed',
  'nativeFailed',
  'notLowered',
  'incomplete',
];
const totals = { examples: results.length };
for (const s of statuses) totals[s] = results.filter(r => r.status === s).length;
/** The cluster key of a result that did not match. */
const clusterKey = r => {
  if (r.status === 'differs') return `${r.comparison.worst.gate}: ${r.comparison.worst.key}`;
  if (r.status === 'reportsUnsupported')
    return r.reports
      .map(l =>
        l
          .replace(/^runic: (E_[A-Z_]+):.*$/, '$1')
          .replace(/^runic: unsupported: (.{0,80}).*$/, 'unsupported: $1'),
      )
      .sort()
      .join(' + ');
  if (r.status === 'buildFailed')
    return `${r.error.kind}: ${r.error.code ?? ''} ${r.error.message}`.slice(0, 160);
  return (r.reason ?? '').replace(/\d+/g, 'N').slice(0, 160);
};
const clusters = {};
for (const r of results.filter(r => r.status !== 'matches')) {
  const key = `${r.status} | ${clusterKey(r)}`;
  (clusters[key] ??= { status: r.status, key: clusterKey(r), count: 0, examples: [] }).count++;
  clusters[key].examples.push(r.example);
}
const timed = results.filter(r => r.ms?.build !== undefined);
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const compact = r => {
  const c = { example: r.example, status: r.status };
  if (r.kitHost) c.kitHost = true;
  if (r.status === 'differs') {
    const w = r.comparison.worst;
    c.worst = w;
    c.failingSteps = r.comparison.failingSteps;
    c.passed = r.comparison.passed;
    c.pixels = r.comparison.pixels;
  }
  if (r.status === 'reportsUnsupported') {
    c.reports = r.reports;
    if (r.comparison) c.passed = r.comparison.passed;
  }
  if (r.status === 'matches') c.pixels = r.comparison.pixels;
  if (r.error) c.error = r.error;
  if (r.reason) c.reason = r.reason;
  if (r.style) c.unstyled = r.style.unstyled;
  return c;
};
// The statuses of the examples whose `cn-*` classes the host theme all styles,
// and of those using classes it has no rule for.
const styled = r => r.style && !r.style.unstyled.length;
totals.byStyle = {
  themeStylesAllClasses: Object.fromEntries(
    statuses.map(s => [s, results.filter(r => r.status === s && styled(r)).length]),
  ),
  usesUnstyledClasses: Object.fromEntries(
    statuses.map(s => [s, results.filter(r => r.status === s && r.style && !styled(r)).length]),
  ),
};
const summary = {
  generated: 'node conformance/render-census.mjs',
  compiler:
    git('rev-parse', '--short', 'HEAD') +
    (git('status', '--porcelain', '--', 'compiler', 'frontend', 'crates', 'conformance')
      ? ' (modified)'
      : ''),
  census: values.census,
  corpus: { name: source.name, commit: source.commit },
  chromium: browser.browserVersion,
  viewport,
  renderer: 'cpu',
  build: 'node compiler/cli.mjs build <host> --probe (dev profile)',
  gates: {
    semantics:
      'DOM, document/body attributes, focus and host effects equal (compare.mjs canonical form); Chromium errors fail it',
    geometry: `elements with ids within ${GEOMETRY_TOLERANCE} px per coordinate`,
    pixels: `mean absolute error <= ${PIXEL_MAE_TOLERANCE}/255 over the viewport and over #${region}`,
  },
  totals,
  timing: {
    seconds: Math.round((Date.now() - t0) / 1000),
    medianMs: Object.fromEntries(
      ['images', 'build', 'browser', 'probe', 'compare', 'total'].map(k => [
        k,
        median(timed.map(r => r.ms[k]).filter(v => v !== undefined)),
      ]),
    ),
    medianDiskBytes: median(timed.map(r => r.disk.bytes)),
    medianBinaryBytes: median(timed.map(r => r.binaryBytes).filter(Boolean)),
  },
  clusters: Object.values(clusters).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  results: results.map(compact),
};
writeFileSync(
  path.join(out, 'render-census.json'),
  JSON.stringify({ ...summary, results }, null, 2) + '\n',
);
writeFileSync(
  path.join(out, 'render-census-summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log(JSON.stringify(totals));
for (const c of summary.clusters.slice(0, 30))
  console.log(`${String(c.count).padStart(4)}  ${c.status} | ${c.key}`);
