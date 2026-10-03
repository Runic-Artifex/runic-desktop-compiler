#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, copyFile, readFile, rename, mkdtemp, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { collect, Diagnostic } from './collect.mjs';
import { lower } from './frontend.mjs';
import { emit, targetDir } from './codegen.mjs';
import { discover } from './discovery.mjs';
import { validateCandidate, accept, repository } from './mappings.mjs';

const cliEntry = process.argv[1] === new URL(import.meta.url).pathname;
const { values, positionals } = parseArgs({
  args: cliEntry ? process.argv.slice(2) : [],
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    model: { type: 'string' },
    constraints: { type: 'string' },
    feedback: { type: 'string' },
    'no-opt': { type: 'boolean' },
    'no-mappings': { type: 'boolean' },
    probe: { type: 'boolean' },
    release: { type: 'boolean' },
    replay: { type: 'boolean' },
    codex: { type: 'boolean' },
    provider: { type: 'string' },
    port: { type: 'string' },
    json: { type: 'boolean' },
  },
});
const [command, app] = positionals;
export async function buildApp(app, options = {}) {
  const graph = await collect(app),
    { ir } = await lower(graph, { registry: !options.noMappings });
  if (!(ir.assets ?? ir.styles.assets).some(a => a.mime === 'font/woff2'))
    throw new Diagnostic(
      'E_FONT',
      'Native builds require a local bundled WOFF2 font referenced by CSS; system font fallback is outside the contract',
      ir.ui?.source,
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
  // One build at a time per cargo target directory (shared across worktrees).
  const lockPath = path.join(targetDir, '.runic-build.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST')
      throw new Diagnostic('E_BUILD_BUSY', 'Another build owns the shared Cargo output');
    throw e;
  }
  const stage = await mkdtemp(
    path.join(path.dirname(out), '.' + path.basename(out) + '-building-'),
  );
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
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
          rust: '1.98.1',
          blitz: '89e5e615aea649a1a9630c526956aa3d90a3afa7',
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
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
async function main() {
  if (!command || !app) {
    console.log(
      'runic-compiler analyze|build|discover <app>\nrunic-compiler scan <project-dir>\nrunic-compiler validate|accept <candidate.json>\nOptions: --out PATH --no-opt --no-mappings --release --probe --replay --codex --model MODEL --constraints FILE --feedback FILE --provider EXEC --port PORT --json',
    );
    return;
  }
  if (command === 'validate') {
    console.log(JSON.stringify(await validateCandidate(app), null, 2));
    return;
  }
  if (command === 'accept') {
    console.log(
      JSON.stringify(await accept(app, values.out ? path.resolve(values.out) : undefined), null, 2),
    );
    return;
  }
  if (command === 'build') {
    const r = await buildApp(app, {
      out: values.out,
      noOpt: values['no-opt'],
      noMappings: values['no-mappings'],
      release: values.release,
      probe: values.probe,
    });
    console.log(
      JSON.stringify({ executable: path.join(r.out, 'runic-app'), validation: r.ir.validation }),
    );
    return;
  }
  if (command === 'scan') {
    const { scan, formatScan } = await import('./scan.mjs');
    const report = await scan(app);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatScan(report));
    return;
  }
  const graph = await collect(app);
  if (command === 'discover') {
    console.log(
      JSON.stringify(
        await discover(graph, path.resolve(values.out ?? 'artifacts/discovery'), {
          replay: values.replay,
          provider: values.provider,
          codex: values.codex,
          model: values.model,
          registry: !values['no-mappings'],
          constraints: values.constraints
            ? JSON.parse(await readFile(values.constraints, 'utf8'))
            : null,
          feedback: values.feedback ? JSON.parse(await readFile(values.feedback, 'utf8')) : null,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'analyze') {
    const { ir } = await lower(graph, { registry: !values['no-mappings'] });
    const out = values.out ?? `artifacts/analysis/${path.basename(graph.root)}/ir.json`;
    await mkdir(path.dirname(out), { recursive: true });
    const { irHash, ...schema4 } = ir;
    await writeFile(out, JSON.stringify(ir.schema === 4 ? schema4 : ir, null, 2) + '\n');
    console.log(
      JSON.stringify(
        values.json
          ? ir
          : {
              ir: out,
              sourceHash: ir.sourceHash,
              validation: ir.validation,
              mappings: ir.mappings,
            },
        null,
        2,
      ),
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
