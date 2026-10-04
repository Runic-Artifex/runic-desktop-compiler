// Bridge to the Rust backend (crates/runic-codegen): it validates schema 4 IR
// (migrating older schemas), runs the reference interpreter and generates the
// application crate.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Diagnostic } from './collect.mjs';
import { fileURLToPath } from 'node:url';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The shared cargo target directory (worktrees may point several trees at one). */
export const targetDir = path.resolve(
  process.env.RUNIC_TARGET_DIR ?? path.join(repository, 'target'),
);

let built = false;
// runic-codegen does not depend on Blitz, so each working tree builds it into
// its own small target: worktrees sharing `targetDir` cannot overwrite each
// other's backend between its build and its use.
const codegenTarget = path.resolve(
  process.env.RUNIC_CODEGEN_TARGET_DIR ?? path.join(repository, '.cache/codegen-target'),
);

/** Build (incrementally) and return the path of the `runic-codegen` binary. */
export function codegenBinary() {
  const binary = path.join(codegenTarget, 'debug', 'runic-codegen');
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
      { env: { ...process.env, CARGO_TARGET_DIR: codegenTarget }, encoding: 'utf8' },
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
    // Schema 4 has no irHash field (the hash is passed separately).
    const { irHash, ...body } = ir;
    writeFileSync(file, JSON.stringify(ir.schema === 4 ? body : ir));
    return f(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The build-time CSS oracle (runic_css::check): the rules Stylo, with Blitz's
 * preferences, drops from `css` (`{line, column, message}`) and the indexes of
 * the `declarations` (`[name, value]`) it does not parse.
 */
export function cssCheck(css, declarations) {
  return withIR({ css, declarations }, file => JSON.parse(run(['css-check', file])));
}

/** Validate `ir` in the Rust backend (the authoritative schema); throws its diagnostic. */
export function check(ir) {
  return withIR(ir, file => JSON.parse(run(['check', file])));
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

/**
 * Run `actions` through the reference interpreter in a case's environment
 * (localStorage items, time zone and locale, start URL, clipboard text,
 * random seed).
 */
export function interpret(ir, actions, { storage, timezone, locale, url, clipboard, seed } = {}) {
  return withIR(ir, file => {
    const extra = storage ? ['--storage', JSON.stringify(storage)] : [];
    if (timezone) extra.push('--timezone', timezone);
    if (locale) extra.push('--locale', locale);
    if (url !== undefined) extra.push('--url', url);
    if (clipboard !== undefined) extra.push('--clipboard', clipboard);
    if (seed !== undefined) extra.push('--seed', String(seed));
    const r = spawnSync(codegenBinary(), ['interp', file, ...extra], {
      input: JSON.stringify(actions),
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    if (r.status !== 0) throw new Diagnostic('E_BACKEND', 'Interpreter failed: ' + r.stderr);
    return JSON.parse(r.stdout);
  });
}
