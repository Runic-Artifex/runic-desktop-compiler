import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectRenderingSources } from '../conformance/harness/sources.mjs';

const candidate = path.dirname(fileURLToPath(import.meta.url));
function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
const git = (cwd, args) => command('git', args, cwd);

async function fixture() {
  const directory = await mkdtemp(path.join(candidate, '.fixture-'));
  const cargoHome = path.join(directory, '.cargo');
  const root = path.join(directory, 'compiler');
  const repositories = new Map(),
    packages = [];
  const createRepo = async (repository, names) => {
    await mkdir(repository, { recursive: true });
    git(repository, ['init', '--quiet']);
    await writeFile(path.join(repository, 'README'), 'fixture\n');
    for (const name of names) {
      const folder = path.join(repository, name);
      await mkdir(folder, { recursive: true });
      await writeFile(
        path.join(folder, 'Cargo.toml'),
        `[package]\nname = "${name}"\nversion = "0.1.0"\n`,
      );
    }
    git(repository, ['add', 'README', ...names]);
    // Use the configured signer, so signature checks are exercised rather than stubbed.
    git(repository, ['commit', '--quiet', '-S', '-m', 'Provenance test fixture']);
    const revision = git(repository, ['rev-parse', 'HEAD']);
    assert.equal(git(repository, ['log', '-1', '--format=%G?', revision]), 'G');
    return revision;
  };
  try {
    await mkdir(path.join(cargoHome, 'git/checkouts'), { recursive: true });
    const compilerRevision = await createRepo(root, ['compiler-fixture']);
    packages.push({
      id: 'compiler-fixture',
      name: 'compiler-fixture',
      source: null,
      manifest_path: path.join(root, 'compiler-fixture/Cargo.toml'),
    });
    for (const [family, names] of [
      ['blitz', ['blitz-dom', 'blitz-traits']],
      ['parley', ['parley', 'fontique']],
      ['stylo', ['stylo', 'selectors']],
      ['vello', ['vello_cpu', 'vello_common']],
      ['anyrender', ['anyrender']],
      ['taffy', ['taffy']],
    ]) {
      let canonical = path.join(directory, family);
      const sourceRepo = family === 'parley' ? path.join(directory, 'parley-source') : canonical;
      const revision = await createRepo(sourceRepo, names);
      if (family === 'parley') {
        canonical += '.git';
        command('git', ['clone', '--quiet', '--bare', sourceRepo, canonical], directory);
      }
      const physical = path.join(cargoHome, 'git/checkouts', family, revision.slice(0, 7));
      await mkdir(path.dirname(physical), { recursive: true });
      command('git', ['clone', '--quiet', canonical, physical], directory);
      await writeFile(path.join(physical, '.cargo-ok'), '');
      const origin = pathToFileURL(canonical).href;
      repositories.set(family, { canonical, physical, revision, origin, names });
      for (const name of names)
        packages.push({
          id: `${name}@${revision}`,
          name,
          source: `git+${origin}?rev=${revision}#${revision}`,
          manifest_path: path.join(physical, name, 'Cargo.toml'),
        });
    }
    const metadata = {
      workspace_root: root,
      packages,
      resolve: { nodes: packages.map(pkg => ({ id: pkg.id, deps: [] })) },
    };
    return {
      directory,
      cargoHome,
      root,
      metadata,
      repositories,
      compilerRevision,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('resolved identities, exact five anchors, bare origin and additional Git sources', async () => {
  const f = await fixture();
  try {
    const result = await collectRenderingSources(f.root, f);
    assert.equal(result.source.length, 5);
    assert.equal(result.resolvedGitSources.length, 6);
    const parley = result.source.find(
      source => source.origin === f.repositories.get('parley').origin,
    );
    assert.equal(parley.repository, path.join(f.directory, 'parley'));
    assert.equal(parley.physicalRepository, f.repositories.get('parley').physical);
    assert.equal(parley.signature, 'G');
    assert.equal(parley.packages.length, 2);
    assert.deepEqual(parley.untracked, []);
    assert.deepEqual(
      parley.cargoCacheMarkers.map(marker => [marker.file, marker.size]),
      [['.cargo-ok', 0]],
    );
    for (const source of result.resolvedGitSources) assert.equal(source.signature, 'G');
    const legacy = structuredClone(f.metadata);
    for (const pkg of legacy.packages)
      if (
        [
          'blitz-dom',
          'blitz-traits',
          'parley',
          'fontique',
          'stylo',
          'selectors',
          'vello_cpu',
          'vello_common',
        ].includes(pkg.name)
      )
        pkg.source = null;
    const legacyResult = await collectRenderingSources(f.root, { ...f, metadata: legacy });
    assert.equal(legacyResult.source.length, 5);
    assert.equal(legacyResult.resolvedGitSources.length, 2);
    // Marker lookalikes outside Cargo's real checkout directory are source dirtiness.
    await writeFile(path.join(f.root, '.cargo-ok'), '');
    await writeFile(
      path.join(f.repositories.get('blitz').physical, 'unexpected.rs'),
      'real dirtiness',
    );
    const dirty = await collectRenderingSources(f.root, f);
    assert.equal(
      dirty.source.find(source => source.repository === f.root).untracked[0][0],
      '.cargo-ok',
    );
    assert.equal(
      dirty.source.find(source => source.origin === f.repositories.get('blitz').origin)
        .untracked[0][0],
      'unexpected.rs',
    );
    await writeFile(path.join(f.repositories.get('parley').physical, '.cargo-ok'), 'tampered');
    await assert.rejects(collectRenderingSources(f.root, f), /Invalid Cargo cache marker/);
  } finally {
    await f.close();
  }
});

test('real checkout HEAD mismatch and untrusted exact commits fail', async () => {
  const f = await fixture();
  try {
    const physical = f.repositories.get('blitz').physical;
    await writeFile(path.join(physical, 'README'), 'changed\n');
    git(physical, ['add', 'README']);
    git(physical, ['commit', '--quiet', '--no-gpg-sign', '-m', 'Different physical checkout']);
    await assert.rejects(collectRenderingSources(f.root, f), /differs from physical HEAD/);
    git(physical, ['reset', '--hard', f.repositories.get('blitz').revision]);
    await writeFile(path.join(f.root, 'README'), 'unsigned compiler\n');
    git(f.root, ['add', 'README']);
    git(f.root, ['commit', '--quiet', '--no-gpg-sign', '-m', 'Unsigned compiler']);
    await assert.rejects(collectRenderingSources(f.root, f), /has signature N/);
  } finally {
    await f.close();
  }
});

test('missing anchors, mixed revisions, unknown sources and unresolved graph fail', async () => {
  const f = await fixture();
  try {
    const missing = structuredClone(f.metadata);
    missing.packages = missing.packages.filter(pkg => pkg.name !== 'stylo');
    missing.resolve.nodes = missing.resolve.nodes.filter(node => !node.id.startsWith('stylo@'));
    await assert.rejects(
      collectRenderingSources(f.root, { ...f, metadata: missing }),
      /Missing source anchor stylo/,
    );
    const unknown = structuredClone(f.metadata);
    unknown.packages.find(pkg => pkg.name === 'stylo').source = 'unreviewed+origin';
    await assert.rejects(
      collectRenderingSources(f.root, { ...f, metadata: unknown }),
      /Unknown source resolution/,
    );
    const mismatched = structuredClone(f.metadata);
    mismatched.packages.find(pkg => pkg.name === 'parley').source = mismatched.packages
      .find(pkg => pkg.name === 'parley')
      .source.replace('?rev=', '?branch=');
    await assert.rejects(
      collectRenderingSources(f.root, { ...f, metadata: mismatched }),
      /matching exact revision/,
    );
    await assert.rejects(
      collectRenderingSources(f.root, { ...f, metadata: { ...f.metadata, resolve: null } }),
      /Full Cargo metadata/,
    );
    const unknownNode = structuredClone(f.metadata);
    unknownNode.resolve.nodes.push({ id: 'not-in-packages' });
    await assert.rejects(
      collectRenderingSources(f.root, { ...f, metadata: unknownNode }),
      /Unknown resolved package/,
    );
    const unknownDependency = structuredClone(f.metadata);
    unknownDependency.resolve.nodes[0].deps = [{ pkg: 'not-in-graph' }];
    await assert.rejects(
      collectRenderingSources(f.root, { ...f, metadata: unknownDependency }),
      /Unknown resolved dependency/,
    );
    // A second actual signed revision of a required origin is rejected, even
    // when the anchor itself still resolves to the first revision.
    const stylo = f.repositories.get('stylo');
    await writeFile(path.join(stylo.canonical, 'README'), 'next signed revision\n');
    git(stylo.canonical, ['add', 'README']);
    git(stylo.canonical, ['commit', '--quiet', '-S', '-m', 'Second signed source revision']);
    const revision = git(stylo.canonical, ['rev-parse', 'HEAD']);
    const second = path.join(f.cargoHome, 'git/checkouts/stylo/second');
    command('git', ['clone', '--quiet', stylo.canonical, second], f.directory);
    const mixed = structuredClone(f.metadata);
    const extra = {
      name: 'selectors',
      id: `selectors@${revision}`,
      source: `git+${stylo.origin}?rev=${revision}#${revision}`,
      manifest_path: path.join(second, 'selectors/Cargo.toml'),
    };
    mixed.packages.push(extra);
    mixed.resolve.nodes.push({ id: extra.id });
    await assert.rejects(
      collectRenderingSources(f.root, { ...f, metadata: mixed }),
      /Mixed required source identity/,
    );
  } finally {
    await f.close();
  }
});

test('Runic-Artifex GitHub origins resolve to the local fork checkout that pushes to them', async () => {
  const f = await fixture();
  try {
    const blitz = f.repositories.get('blitz');
    const github = structuredClone(f.metadata);
    for (const pkg of github.packages)
      if (pkg.source)
        pkg.source = pkg.source.replace(blitz.origin, 'https://github.com/Runic-Artifex/blitz');
    const options = { ...f, metadata: github, forksDir: f.directory };
    await assert.rejects(collectRenderingSources(f.root, options), /remote origin|No such remote/);
    git(blitz.canonical, ['remote', 'add', 'origin', 'git@github.com:Runic-Artifex/blitz.git']);
    const result = await collectRenderingSources(f.root, options);
    const group = result.source.find(
      source => source.origin === 'https://github.com/Runic-Artifex/blitz',
    );
    assert.equal(group.repository, blitz.canonical);
    assert.equal(group.revision, blitz.revision);
    git(blitz.canonical, ['remote', 'set-url', 'origin', 'git@github.com:Someone/blitz.git']);
    await assert.rejects(collectRenderingSources(f.root, options), /does not push to/);
    const foreign = structuredClone(github);
    for (const pkg of foreign.packages)
      if (pkg.source) pkg.source = pkg.source.replace('Runic-Artifex/blitz', 'DioxusLabs/blitz');
    await assert.rejects(
      collectRenderingSources(f.root, { ...options, metadata: foreign }),
      /Unreviewed Git origin/,
    );
  } finally {
    await f.close();
  }
});

test('executor invokes locked offline full metadata in rendering root', async () => {
  const f = await fixture();
  try {
    const calls = [];
    const execute = (program, args, options) => {
      if (program === 'cargo') {
        calls.push({ args, cwd: options.cwd });
        return { status: 0, stdout: JSON.stringify(f.metadata) };
      }
      return spawnSync(program, args, { ...options, encoding: 'utf8' });
    };
    const result = await collectRenderingSources(f.root, { cargoHome: f.cargoHome, execute });
    assert.equal(result.source.length, 5);
    assert.deepEqual(calls, [
      { args: ['metadata', '--locked', '--offline', '--format-version', '1'], cwd: f.root },
    ]);
  } finally {
    await f.close();
  }
});
