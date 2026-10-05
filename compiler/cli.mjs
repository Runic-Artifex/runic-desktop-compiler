#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, copyFile, readFile, rename, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { collect, Diagnostic } from './collect.mjs';
import { lower } from './frontend.mjs';
import { emit, targetDir, repository } from './codegen.mjs';
import { withSharedTarget } from './target.mjs';

const cliEntry = process.argv[1] === new URL(import.meta.url).pathname;

/** The Blitz repository and revision the workspace pins (Cargo.toml). */
async function blitzRevision() {
  const manifest = await readFile(path.join(repository, 'Cargo.toml'), 'utf8');
  const pin = /^blitz-dom = \{ git = "([^"]+)", rev = "([0-9a-f]+)"/m.exec(manifest);
  if (!pin) throw new Diagnostic('E_BUILD', 'Cargo.toml does not pin blitz-dom to a git revision');
  return `${pin[1]}@${pin[2]}`;
}
const { values, positionals } = parseArgs({
  args: cliEntry ? process.argv.slice(2) : [],
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    'no-opt': { type: 'boolean' },
    probe: { type: 'boolean' },
    release: { type: 'boolean' },
    renderer: { type: 'string' },
    json: { type: 'boolean' },
  },
});
const [command, app] = positionals;
export async function buildApp(app, options = {}) {
  const graph = await collect(app);
  // The renderer runic.json selects, unless the build overrides it
  // (conformance runs of GPU builds: `--renderer gpu`).
  if (options.renderer !== undefined) {
    if (!['cpu', 'gpu'].includes(options.renderer))
      throw new Diagnostic('E_CONFIG', 'The renderer must be "cpu" or "gpu"');
    graph.config = { ...graph.config, renderer: options.renderer };
  }
  const { ir } = await lower(graph);
  if (!ir.styles.assets.some(a => a.mime === 'font/woff2'))
    throw new Diagnostic(
      'E_FONT',
      'Native builds require a local bundled WOFF2 font referenced by CSS; system font fallback is outside the contract',
      undefined,
    );
  const out = path.resolve(
    options.out ?? `artifacts/${path.basename(graph.root)}${options.noOpt ? '-no-opt' : ''}`,
  );
  if (!process.env.IN_NIX_SHELL)
    throw new Diagnostic(
      'E_ENV',
      'Build inside the locked project shell: nix develop . -c node compiler/cli.mjs build ...',
    );
  if (!['artifacts', '.cache'].some(p => out.startsWith(path.join(repository, p) + path.sep)))
    throw new Diagnostic('E_OUTPUT', 'Build outputs must be under artifacts/ or .cache/');
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(targetDir, { recursive: true });
  return withSharedTarget(() => buildInto(ir, graph, out, options));
}

async function buildInto(ir, graph, out, options) {
  const stage = await mkdtemp(
    path.join(path.dirname(out), '.' + path.basename(out) + '-building-'),
  );
  try {
    emit(ir, stage, !options.noOpt);
    // Offline: the copied workspace lock pins every dependency; cargo only adds
    // the generated package itself.
    const result = spawnSync(
      'cargo',
      [
        'build',
        '--offline',
        '--manifest-path',
        path.join(stage, 'Cargo.toml'),
        '--bin',
        'runic-app',
        ...(options.release ? ['--release'] : []),
        ...(options.probe ? ['--features', 'probe'] : []),
      ],
      { cwd: repository, env: { ...process.env, CARGO_TARGET_DIR: targetDir }, stdio: 'inherit' },
    );
    if (result.status !== 0)
      throw new Diagnostic('E_BUILD', 'Rust build failed; see Cargo diagnostics');
    const binary = path.join(stage, 'runic-app');
    const temporary = path.join(stage, 'runic-app.installing');
    await copyFile(
      path.join(targetDir, options.release ? 'release' : 'debug', 'runic-app'),
      temporary,
    );
    const rpath = spawnSync('patchelf', ['--print-rpath', temporary], { encoding: 'utf8' });
    if (rpath.status !== 0)
      throw new Diagnostic('E_PACKAGE', 'Cannot inspect native runtime paths');
    const patch = spawnSync('patchelf', [
      '--set-rpath',
      rpath.stdout
        .trim()
        .split(':')
        .filter(p => p.startsWith('/nix/store/'))
        .join(':'),
      temporary,
    ]);
    if (patch.status !== 0)
      throw new Diagnostic('E_PACKAGE', 'Cannot normalize native runtime paths');
    await rename(temporary, binary);
    await writeFile(
      path.join(stage, 'build.json'),
      JSON.stringify(
        {
          sourceHash: graph.hash,
          irHash: ir.irHash,
          optimize: !options.noOpt,
          profile: options.release ? 'release' : 'dev',
          lto: process.env.CARGO_PROFILE_RELEASE_LTO ?? 'off',
          codegenUnits: 1,
          probe: Boolean(options.probe),
          renderer: ir.renderer ?? 'cpu',
          rust: '1.98.1',
          blitz: await blitzRevision(),
        },
        null,
        2,
      ) + '\n',
    );
    const backup = out + '.previous-' + process.pid;
    let replaced = false;
    try {
      await rename(out, backup);
      replaced = true;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      await rename(stage, out);
    } catch (e) {
      if (replaced) await rename(backup, out);
      throw e;
    }
    if (replaced) await rm(backup, { recursive: true, force: true });
    return { out, ir };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
async function main() {
  if (!command || !app) {
    console.log(
      'runic-compiler analyze|build <app>\nrunic-compiler scan <project-dir>\nOptions: --out PATH --no-opt --release --probe --renderer cpu|gpu --json',
    );
    return;
  }
  if (command === 'build') {
    const r = await buildApp(app, {
      out: values.out,
      noOpt: values['no-opt'],
      release: values.release,
      probe: values.probe,
      renderer: values.renderer,
    });
    console.log(JSON.stringify({ executable: path.join(r.out, 'runic-app') }));
    return;
  }
  if (command === 'scan') {
    const { scan, formatScan } = await import('./scan.mjs');
    const report = await scan(app);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatScan(report));
    return;
  }
  const graph = await collect(app);
  if (command === 'analyze') {
    const { ir } = await lower(graph);
    const out = values.out ?? `artifacts/analysis/${path.basename(graph.root)}/ir.json`;
    await mkdir(path.dirname(out), { recursive: true });
    const { irHash, ...body } = ir;
    await writeFile(out, JSON.stringify(body, null, 2) + '\n');
    console.log(
      JSON.stringify(values.json ? body : { ir: out, sourceHash: ir.meta.sourceHash }, null, 2),
    );
    return;
  }
  throw new Diagnostic('E_COMMAND', `Unknown command ${command}`);
}
// Importable build helper without running the CLI parser's dispatch.
if (cliEntry)
  main().catch(error => {
    console.error(
      JSON.stringify(
        error instanceof Diagnostic
          ? error.toJSON()
          : { code: 'E_INTERNAL', message: error.message, stack: error.stack },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
