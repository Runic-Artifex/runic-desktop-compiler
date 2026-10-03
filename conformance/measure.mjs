#!/usr/bin/env node
// Startup and size budget: release builds (no probe), stripped binary size and
// time to first presented frame on a private Xvfb display.
//
//   node conformance/measure.mjs [fixture ...] [--runs N] [--renderer cpu|gpu]
//
// Two timings per run: `processMs` (spawn to exit after the first frame,
// including dynamic loading) and `firstFrameMs` (in-process, from `main`).
// Xvfb has no GPU; the GPU renderer runs on Mesa lavapipe there, so its
// timings are functional checks, not performance results.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../compiler/cli.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: 'string', default: '7' } },
});
const fixtures = positionals.length
  ? positionals
  : (await readdir(path.join(repo, 'fixtures'), { withFileTypes: true }))
      .filter(d => d.isDirectory() && !['incompatible', 'unsupported-effect'].includes(d.name))
      .map(d => d.name);

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const display = ':' + (90 + Math.floor(Math.random() * 100));
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 700));
const results = [];
try {
  for (const fixture of fixtures) {
    const out = path.join(repo, '.cache/conformance/release', fixture);
    await buildApp(path.join(repo, 'fixtures', fixture), { out, release: true });
    const binary = path.join(out, 'runic-app');
    const bytes = (await stat(binary)).size;
    const processMs = [];
    const firstFrameMs = [];
    for (let i = 0; i < Number(values.runs); i++) {
      const t = performance.now();
      const r = spawnSync(binary, ['--x11'], {
        env: { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', RUNIC_EXIT_AFTER_FIRST_FRAME: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      const elapsed = performance.now() - t;
      const m = r.stderr.match(/RUNIC_FIRST_FRAME_US ([0-9.]+)/);
      if (r.status !== 0 || !m) throw new Error(`${fixture}: no first frame (${r.status}):\n${r.stderr}`);
      processMs.push(elapsed);
      firstFrameMs.push(Number(m[1]) / 1000);
    }
    const row = {
      fixture,
      bytes,
      mib: +(bytes / 1048576).toFixed(2),
      processMs: +median(processMs).toFixed(1),
      firstFrameMs: +median(firstFrameMs).toFixed(1),
      runs: processMs.length,
    };
    results.push(row);
    console.log(`${fixture.padEnd(18)} ${String(row.mib).padStart(6)} MiB  process ${String(row.processMs).padStart(6)} ms  first frame ${String(row.firstFrameMs).padStart(6)} ms`);
  }
} finally {
  xvfb.kill();
}
const host = spawnSync('uname', ['-srm'], { encoding: 'utf8' }).stdout.trim();
const report = { schema: 1, date: new Date().toISOString(), host, display: 'Xvfb 1024x768x24', renderer: 'cpu', results };
const dir = path.join(repo, 'artifacts/conformance');
await mkdir(dir, { recursive: true });
const file = path.join(dir, `measure-${report.date.replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify(report, null, 2) + '\n');
console.log('Report:', path.relative(repo, file));
