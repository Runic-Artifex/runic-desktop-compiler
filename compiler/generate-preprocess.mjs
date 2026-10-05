// A preprocess generation step (compiler/generate.mjs), run in its own
// process with the app as working directory: svelte.config.js's
// `preprocess` list over the files a glob names, each output written as
// `<out>/<file>.svelte`. This is the only place where the compiler imports
// the app's svelte.config.js (docs/design/M6-SVELTEKIT.md, phase 2); builds
// read it as literals and use the recorded outputs.
//
//   node compiler/generate-preprocess.mjs <app> <glob> <out>
import path from 'node:path';
import { createRequire } from 'node:module';
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [root, pattern, out] = process.argv.slice(2);
const require = createRequire(path.join(root, 'runic.json'));
const compiler = await import(pathToFileURL(require.resolve('svelte/compiler')).href);
const preprocess = compiler.preprocess ?? compiler.default.preprocess;
const config = (await import(pathToFileURL(path.join(root, 'svelte.config.js')).href)).default;
if (!Array.isArray(config.preprocess) && typeof config.preprocess !== 'object') {
  console.error('svelte.config.js has no preprocess');
  process.exit(1);
}
const files = globSync(pattern, { cwd: root })
  .map(f => f.split(path.sep).join('/'))
  .sort();
if (!files.length) {
  console.error(`No files match ${pattern}`);
  process.exit(1);
}
for (const file of files) {
  const filename = path.join(root, file);
  const result = await preprocess(readFileSync(filename, 'utf8'), config.preprocess, { filename });
  const target = path.join(out, file + '.svelte');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, result.code);
}
