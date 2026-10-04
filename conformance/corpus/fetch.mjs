#!/usr/bin/env node
// Fetch the pinned corpus sources (north-star.json) into .cache/corpus/<name>
// at their exact commits. Idempotent; an explicit, networked operation that
// builds never run.
//
//   node conformance/corpus/fetch.mjs [name ...]
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(repo, 'conformance/corpus/north-star.json'), 'utf8'));
const wanted = process.argv.slice(2);
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
  return r.stdout.trim();
};
for (const source of manifest.sources) {
  if (wanted.length && !wanted.includes(source.name)) continue;
  const dir = path.join(repo, '.cache/corpus', source.name);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', source.repository);
  }
  if (spawnSync('git', ['cat-file', '-e', source.commit + '^{commit}'], { cwd: dir }).status !== 0)
    git(dir, 'fetch', '-q', '--depth', '1', 'origin', source.commit);
  git(dir, 'checkout', '-q', '--force', source.commit);
  console.log(`${source.name} ${git(dir, 'rev-parse', 'HEAD')} -> ${path.relative(repo, path.join(dir, source.target))}`);
}
