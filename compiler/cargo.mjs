#!/usr/bin/env node
// Cargo on the shared target: `node compiler/cargo.mjs test --offline --workspace`
// runs cargo with CARGO_TARGET_DIR set to RUNIC_TARGET_DIR, under the build
// lock, after cleaning another working tree's build of the workspace crates.
import { spawnSync } from 'node:child_process';
import { repository, targetDir } from './codegen.mjs';
import { withSharedTarget } from './target.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node compiler/cargo.mjs <cargo arguments>');
  process.exit(2);
}
const status = await withSharedTarget(
  () =>
    spawnSync('cargo', args, {
      cwd: repository,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: 'inherit',
    }).status,
);
process.exit(status ?? 1);
