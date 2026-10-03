// Bridge to the Rust backend (crates/runic-codegen). The JS adapters still
// emit schema 3 IR; `runic-codegen` migrates it to schema 4, validates it and
// generates the application crate.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Diagnostic } from './collect.mjs';
import { repository } from './mappings.mjs';

/** The shared cargo target directory (worktrees may point several trees at one). */
export const targetDir = path.resolve(
  process.env.RUNIC_TARGET_DIR ?? path.join(repository, 'target'),
);

let built = false;
/** Build (incrementally) and return the path of the `runic-codegen` binary. */
export function codegenBinary() {
  const binary = path.join(targetDir, 'debug', 'runic-codegen');
  if (!built) {
    const r = spawnSync(
      'cargo',
      [
        'build',
        '--offline',
        '--quiet',
        '-p',
        'runic-codegen',
        '--manifest-path',
        path.join(repository, 'Cargo.toml'),
      ],
      { env: { ...process.env, CARGO_TARGET_DIR: targetDir }, encoding: 'utf8' },
    );
    if (r.status !== 0)
      throw new Diagnostic('E_BUILD', 'Cannot build runic-codegen:\n' + (r.stderr || r.error));
    built = true;
  }
  return binary;
}

function run(args) {
  const r = spawnSync(codegenBinary(), args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) {
    let d;
    try {
      d = JSON.parse(r.stderr.trim().split('\n').at(-1));
    } catch {
      throw new Diagnostic('E_BACKEND', 'runic-codegen failed: ' + (r.stderr || r.error));
    }
    throw new Diagnostic(d.code, d.message, d.source);
  }
  return r.stdout;
}

function withIR(ir, f) {
  const dir = mkdtempSync(path.join(tmpdir(), 'runic-ir-'));
  try {
    const file = path.join(dir, 'ir.json');
    writeFileSync(file, JSON.stringify(ir));
    return f(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write the generated application crate for `ir` into `out`. */
export function emit(ir, out, optimize = true) {
  withIR(ir, file =>
    run([
      'emit',
      file,
      out,
      '--runtime',
      path.join(repository, 'crates/runic-runtime'),
      '--lock',
      path.join(repository, 'Cargo.lock'),
      '--hash',
      ir.irHash ?? '',
      ...(optimize ? [] : ['--no-opt']),
    ]),
  );
  writeFileSync(path.join(out, 'ir.json'), JSON.stringify(ir, null, 2) + '\n');
  return out;
}

/** The generated `app.rs` for `ir` (used by tests to compare backends' inputs). */
export function generate(ir, optimize = true) {
  return withIR(ir, (file, dir) => {
    emit(ir, path.join(dir, 'crate'), optimize);
    return readFileSync(path.join(dir, 'crate/src/app.rs'), 'utf8');
  });
}

/** The schema 4 form of `ir` (migrated and validated by the Rust backend). */
export function migrate(ir) {
  return withIR(ir, file => JSON.parse(run(['migrate', file])));
}

/** Run `actions` through the reference interpreter. */
export function interpret(ir, actions) {
  return withIR(ir, file => {
    const r = spawnSync(codegenBinary(), ['interp', file], {
      input: JSON.stringify(actions),
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    if (r.status !== 0) throw new Diagnostic('E_BACKEND', 'Interpreter failed: ' + r.stderr);
    return JSON.parse(r.stdout);
  });
}
