// The shared cargo target directory: one build at a time, and never one that
// links another working tree's build of this workspace's crates.
import { spawnSync } from 'node:child_process';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Diagnostic } from './collect.mjs';
import { repository, targetDir } from './codegen.mjs';

/**
 * Run `fn` holding the target's build lock (shared across worktrees: later
 * builds queue; a lock left by a dead process is reclaimed), with the target
 * claimed for this working tree.
 */
export async function withSharedTarget(fn) {
  const lockPath = path.join(targetDir, '.runic-build.lock');
  const lock = await acquire(lockPath, Number(process.env.RUNIC_BUILD_WAIT_MS ?? 30 * 60_000));
  try {
    await claim();
    return await fn();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/**
 * Cargo identifies this workspace's crates by their path relative to the
 * workspace, so working trees sharing the target share their artifacts: a
 * tree whose sources are older than another tree's build would link that
 * build (and its compile-time paths). The target records the last tree that
 * built into it; another tree first cleans the workspace crates, in both
 * profiles. Dependencies (Blitz, Stylo, ...) stay shared.
 */
async function claim() {
  const stamp = path.join(targetDir, '.runic-source');
  const last = await readFile(stamp, 'utf8').catch(() => '');
  if (last === repository) return;
  const cargo = args =>
    spawnSync('cargo', args, {
      cwd: repository,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      encoding: 'utf8',
    });
  const manifest = ['--offline', '--manifest-path', path.join(repository, 'Cargo.toml')];
  const metadata = cargo(['metadata', '--no-deps', '--format-version', '1', ...manifest]);
  if (metadata.status !== 0)
    throw new Diagnostic('E_BUILD', 'Cannot list the workspace crates:\n' + metadata.stderr);
  const packages = JSON.parse(metadata.stdout).packages.flatMap(p => ['-p', p.name]);
  for (const profile of [[], ['--release']]) {
    const r = cargo(['clean', ...manifest, ...profile, ...packages]);
    if (r.status !== 0)
      throw new Diagnostic('E_BUILD', 'Cannot clean the workspace crates:\n' + r.stderr);
  }
  await writeFile(stamp, repository);
}

async function acquire(lockPath, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return handle;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let owner;
    try {
      owner = JSON.parse(await readFile(lockPath, 'utf8')).pid;
    } catch {
      owner = undefined; // being written; retry
    }
    if (owner !== undefined && !alive(owner)) {
      await rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() > deadline)
      throw new Diagnostic('E_BUILD_BUSY', 'Another build owns the shared Cargo output');
    await new Promise(r => setTimeout(r, 500));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
