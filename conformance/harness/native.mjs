// Native side of the conformance harness: builds a fixture with the `probe`
// feature through the normal compiler path and runs scripted action traces.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../compiler/cli.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Build `fixture` with probes into .cache/conformance/bin/<name>. */
export async function buildProbe(fixture, { release = false, noOpt = false } = {}) {
  const name = path.basename(path.resolve(fixture)) + (noOpt ? '-no-opt' : '');
  const out = path.join(repo, '.cache/conformance/bin', name);
  const { ir } = await buildApp(fixture, { out, probe: true, release, noOpt });
  const build = JSON.parse(await readFile(path.join(out, 'build.json'), 'utf8'));
  return { binary: path.join(out, 'runic-app'), ir, build };
}

/** Run the probe binary; returns { mountUs, steps: [{ action, dom, focused, geometry, ... }] }. */
export function runProbe(
  binary,
  {
    viewport = { width: 800, height: 600 },
    actions = [],
    out,
    storage,
    timezone,
    locale,
    url,
    clipboard,
    seed,
    visibleTargets,
    hiddenTargets,
  } = {},
) {
  const args = ['--probe', '--width', String(viewport.width), '--height', String(viewport.height)];
  if (out) args.push('--out', out);
  if (storage) args.push('--storage', JSON.stringify(storage));
  // The case's host environment (docs/design/M5-PLATFORM.md).
  if (timezone) args.push('--timezone', timezone);
  if (locale) args.push('--locale', locale);
  if (url !== undefined) args.push('--url', url);
  if (clipboard !== undefined) args.push('--clipboard', clipboard);
  if (seed !== undefined) args.push('--seed', String(seed));
  // Browser comparisons: pointer targets must be fully visible (Playwright
  // would scroll them into view first, which the probe does not model).
  if (visibleTargets) args.push('--visible-targets');
  // Differential traces end before a pointer action at a hidden target.
  if (hiddenTargets === 'stop') args.push('--hidden-targets', 'stop');
  const r = spawnSync(binary, args, {
    input: JSON.stringify(actions),
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`Native probe failed (${r.status ?? r.signal}):\n${r.stderr}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
}
