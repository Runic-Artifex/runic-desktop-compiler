import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = data => createHash('sha256').update(data).digest('hex');
const anchors = ['blitz-dom', 'parley', 'stylo', 'vello_cpu'];
const sorted = values => [...values].sort();
const fullCommit = value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

// Rendering provenance comes from Cargo's locked resolved graph. No build is run.
// execute(command, args, options) may be supplied; its result follows spawnSync.
export async function collectRenderingSources(root, options = {}) {
  const execute = options.execute ?? ((command, args, settings) =>
    spawnSync(command, args, { ...settings, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const run = async (command, args, cwd = root) => {
    const result = await execute(command, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0 || result.error)
      throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr ?? result.error ?? ''}`);
    return result.stdout;
  };
  const git = (repository, args) => run('git', ['-C', repository, ...args]);
  const metadata = options.metadata ?? JSON.parse(await run('cargo', [
    'metadata', '--locked', '--offline', '--format-version', '1',
  ]));
  if (!Array.isArray(metadata.packages) || !Array.isArray(metadata.resolve?.nodes))
    throw new Error('Full Cargo metadata with a resolved dependency graph is required');
  if (await realpath(metadata.workspace_root) !== await realpath(root))
    throw new Error('Cargo metadata workspace differs from rendering root');
  const byID = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
  if (byID.size !== metadata.packages.length) throw new Error('Duplicate Cargo package IDs');
  const packages = metadata.resolve.nodes.map(node => {
    const pkg = byID.get(node.id);
    if (!pkg) throw new Error(`Unknown resolved package ${node.id}`);
    return pkg;
  });
  if (new Set(packages.map(pkg => pkg.id)).size !== packages.length)
    throw new Error('Duplicate resolved package nodes');
  const resolvedIDs = new Set(packages.map(pkg => pkg.id));
  for (const node of metadata.resolve.nodes)
    for (const dependency of node.deps ?? [])
      if (!resolvedIDs.has(dependency.pkg))
        throw new Error(`Unknown resolved dependency ${dependency.pkg}`);

  const cargoHome = options.cargoHome ?? process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo');
  const checkoutDirectory = await realpath(path.join(cargoHome, 'git/checkouts')).catch(() => null);
  const physicalMemo = new Map();
  const inspect = async repository => {
    if (physicalMemo.has(repository)) return physicalMemo.get(repository);
    const revision = (await git(repository, ['rev-parse', 'HEAD'])).trim();
    if (!fullCommit(revision)) throw new Error(`Invalid Git HEAD in ${repository}`);
    const physicalRepository = await realpath(repository);
    const diffSHA256 = digest(await git(repository, ['diff', 'HEAD', '--binary']));
    const names = sorted((await git(repository, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0').filter(Boolean));
    const untracked = [], cargoCacheMarkers = [];
    for (const name of names) {
      const file = path.join(repository, name);
      if (name === '.cargo-ok' && checkoutDirectory &&
          physicalRepository.startsWith(checkoutDirectory + path.sep)) {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size !== 0)
          throw new Error(`Invalid Cargo cache marker ${file}`);
        cargoCacheMarkers.push({ file: name, size: 0, sha256: digest(await readFile(file)) });
      } else untracked.push([name, digest(await readFile(file))]);
    }
    const result = { physicalRepository, revision, diffSHA256, untracked, cargoCacheMarkers };
    physicalMemo.set(repository, result);
    return result;
  };
  const rootOf = async manifest =>
    (await git(path.dirname(manifest), ['rev-parse', '--show-toplevel'])).trim();
  const verifySignature = async (repository, revision) => {
    const signature = (await git(repository, ['log', '-1', '--format=%G?', revision])).trim();
    if (signature !== 'G') throw new Error(`Commit ${revision} in ${repository} has signature ${signature}`);
    return signature;
  };

  const groups = new Map(), packageGroup = new Map();
  for (const pkg of packages) {
    if (typeof pkg.source === 'string' && (pkg.source.startsWith('registry+') || pkg.source.startsWith('sparse+')))
      continue;
    const physicalRoot = await rootOf(pkg.manifest_path);
    const state = await inspect(physicalRoot);
    let origin = null, repository = state.physicalRepository, revision = state.revision;
    let signature;
    if (pkg.source === null) {
      signature = await verifySignature(physicalRoot, revision);
    } else if (typeof pkg.source === 'string' && pkg.source.startsWith('git+')) {
      const url = new URL(pkg.source.slice(4));
      revision = url.hash.slice(1);
      const requested = url.searchParams.get('rev');
      if (!fullCommit(revision) || requested !== revision ||
          [...url.searchParams.keys()].some(key => key !== 'rev') ||
          url.searchParams.getAll('rev').length !== 1)
        throw new Error(`Git source lacks one matching exact revision: ${pkg.source}`);
      if (state.revision !== revision)
        throw new Error(`Resolved revision ${revision} differs from physical HEAD ${state.revision}`);
      url.hash = ''; url.search = '';
      if (url.protocol !== 'file:') throw new Error(`Unreviewed Git origin ${url.href}`);
      origin = url.href;
      const canonical = fileURLToPath(url);
      const bare = (await git(canonical, ['rev-parse', '--is-bare-repository'])).trim() === 'true';
      repository = bare ? canonical.replace(/\.git$/, '') :
        (await git(canonical, ['rev-parse', '--show-toplevel'])).trim();
      signature = await verifySignature(canonical, revision);
    } else throw new Error(`Unknown source resolution for ${pkg.id}: ${pkg.source}`);
    const key = JSON.stringify([repository, origin, revision, state.physicalRepository]);
    if (!groups.has(key)) groups.set(key, {
      repository, ...state, origin, revision, signature, packages: [],
    });
    groups.get(key).packages.push(pkg.id);
    packageGroup.set(pkg.id, key);
  }
  for (const group of groups.values()) group.packages.sort();
  const compilerRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  const compilerState = await inspect(compilerRoot);
  const compilerGroups = [...groups.values()].filter(group =>
    group.origin === null && group.physicalRepository === compilerState.physicalRepository);
  if (compilerGroups.length !== 1) throw new Error('Compiler workspace source is missing or ambiguous');
  const selected = [compilerGroups[0]];
  for (const anchor of anchors) {
    const matching = packages.filter(pkg => pkg.name === anchor);
    const keys = new Set(matching.map(pkg => packageGroup.get(pkg.id)));
    if (!matching.length || keys.has(undefined)) throw new Error(`Missing source anchor ${anchor}`);
    if (keys.size !== 1) throw new Error(`Mixed source revisions or checkouts for ${anchor}`);
    selected.push(groups.get([...keys][0]));
  }
  if (new Set(selected.map(group => group.repository)).size !== 5)
    throw new Error('Expected five distinct logical rendering sources');
  // A required origin cannot contain a second revision or physical checkout.
  for (const required of selected) {
    if ([...groups.values()].filter(group => group.repository === required.repository).length !== 1)
      throw new Error(`Mixed required source identity ${required.repository}`);
  }
  const order = (a, b) => a.repository < b.repository ? -1 : a.repository > b.repository ? 1 :
    JSON.stringify(a).localeCompare(JSON.stringify(b));
  return {
    source: selected.sort(order),
    resolvedGitSources: [...groups.values()].filter(group => group.origin !== null).sort(order),
  };
}
