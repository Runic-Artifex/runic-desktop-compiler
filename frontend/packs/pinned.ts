// Running a package at build time (docs/design/M6-LIBRARIES.md#mapping-packs-d9):
// packs that evaluate calls in Node load the application's own copy of the
// package (the directory its import resolved to) after checking that every
// file they load is byte-identical to the published version the pack was
// written and validated against. A patched or rebuilt copy is rejected, so
// a build never evaluates code other than the pinned package.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PackageRef } from '../packs.ts';

const require = createRequire(import.meta.url);
const checked = new Map<string, string | undefined>();

/**
 * Undefined when the files (path relative to the package → SHA-256) in
 * `pkg.dir` are the pinned ones, else why not.
 */
export function pinnedCheck(pkg: PackageRef, files: Record<string, string>): string | undefined {
  const key = `${pkg.dir}\0${JSON.stringify(files)}`;
  if (checked.has(key)) return checked.get(key);
  let problem: string | undefined;
  for (const [file, sha256] of Object.entries(files)) {
    let actual: string;
    try {
      actual = createHash('sha256')
        .update(readFileSync(path.join(pkg.dir, file)))
        .digest('hex');
    } catch {
      problem = `${pkg.name}@${pkg.version} has no ${file}`;
      break;
    }
    if (actual !== sha256) {
      problem = `${pkg.name}@${pkg.version} differs from the published package (${file} has SHA-256 ${actual}, the pack evaluates ${sha256})`;
      break;
    }
  }
  checked.set(key, problem);
  return problem;
}

/** The module `entry` of a checked package, loaded once. */
export function pinnedLoad<T>(pkg: PackageRef, entry: string): T {
  return require(path.join(pkg.dir, entry)) as T;
}
