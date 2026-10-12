// Native side of the conformance harness: builds a fixture with the `probe`
// feature through the normal compiler path and runs scripted action traces.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../compiler/cli.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Build `fixture` with probes into .cache/conformance/bin/<name>; `renderer`
 * overrides the one runic.json selects (`gpu` builds go to <name>-gpu).
 */
export async function buildProbe(fixture, { release = false, noOpt = false, renderer } = {}) {
  const name =
    path.basename(path.resolve(fixture)) + (noOpt ? '-no-opt' : '') + (renderer === 'gpu' ? '-gpu' : '');
  const out = path.join(repo, '.cache/conformance/bin', name);
  const { ir } = await buildApp(fixture, { out, probe: true, release, noOpt, renderer });
  const build = JSON.parse(await readFile(path.join(out, 'build.json'), 'utf8'));
  return { binary: path.join(out, 'runic-app'), ir, build };
}

/**
 * The environment of a probe: GPU builds draw their screenshots on Mesa's
 * software Vulkan driver (lavapipe) from the locked shell by default, so that
 * results do not depend on the machine's GPU; `system` lets wgpu choose
 * among the host's drivers. CPU builds ignore it.
 */
export function gpuEnvironment(gpuAdapter) {
  const env = { ...process.env };
  if (gpuAdapter === 'lavapipe') {
    if (!process.env.RUNIC_LAVAPIPE_ICD)
      throw new Error('RUNIC_LAVAPIPE_ICD is not set: run inside the locked shell (nix develop)');
    env.VK_ICD_FILENAMES = process.env.RUNIC_LAVAPIPE_ICD;
    delete env.VK_DRIVER_FILES;
    delete env.WGPU_ADAPTER_NAME;
    env.WGPU_BACKEND = 'vulkan';
  } else if (gpuAdapter !== undefined && gpuAdapter !== 'system')
    throw new Error(`Unknown GPU adapter ${gpuAdapter}: lavapipe or system`);
  return env;
}

/**
 * Run the probe binary; returns { mountUs, steps: [{ action, dom, focused, geometry, ... }] },
 * with `stderr` (the app's run-time reports, `runic: E_*`) when `stderr` is set.
 */
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
    gpuAdapter,
    stderr = false,
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
    env: gpuEnvironment(gpuAdapter),
    input: JSON.stringify(actions),
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    timeout: 120_000,
  });
  if (r.status !== 0) {
    const error = new Error(`Native probe failed (${r.status ?? r.signal ?? r.error?.code}):\n${r.stderr}`);
    Object.assign(error, {
      code: 'E_NATIVE_PROBE',
      status: r.status,
      signal: r.signal,
      spawnError: r.error?.code,
      stderr: r.stderr ?? '',
    });
    throw error;
  }
  const trace = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  return stderr ? { ...trace, stderr: r.stderr } : trace;
}

/** A short reason for a failed native probe: its exit and the panic, if any. */
export function probeFailureReason(error) {
  const exit = `exit ${error.status ?? error.signal ?? 'unknown'}${error.spawnError ? ` (${error.spawnError})` : ''}`;
  const lines = error.stderr.split('\n');
  const i = lines.findIndex(line => line.includes(' panicked at '));
  if (i >= 0)
    return `${exit}, panicked at ${lines[i].split(' panicked at ')[1].replace(/:$/, '')}: ${lines[i + 1]?.trim() ?? ''}`;
  const last = lines.map(line => line.trim()).filter(Boolean).at(-1);
  return last ? `${exit}: ${last}` : exit;
}
