// Generates cn-0.3.0.json: the output of the real cn 0.3.0 (resolved from
// this repository's node_modules) for call shapes the cn mapping pack
// evaluates at build time (frontend/packs/cn-0.3.0.ts), over the variables
// and variant functions of the tailwind vectors (tailwind.mjs).
// tests/packs.test.mjs compiles every vector into a Svelte component (cn
// imported through a local module that re-exports it, as shadcn-svelte's
// lib/utils.ts does), runs it in the reference interpreter in two states of
// the variables and compares the strings.
//
// Run explicitly (never during builds): node conformance/packs/cn.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variables, variantsModule } from './tailwind.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PINNED = { cn: '0.3.0', 'tailwind-variants': '3.3.1' };
for (const [name, version] of Object.entries(PINNED)) {
  let dir = path.dirname(require.resolve(name));
  while (path.basename(dir) !== name) dir = path.dirname(dir);
  const info = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (info.version !== version) throw new Error(`${name} ${info.version} installed, ${version} expected`);
}
const { cn, twMerge, twJoin } = await import('cn');
const { tv } = await import('tailwind-variants');

/** shadcn-svelte's lib/utils.ts (its registry's, unmodified). */
export const utilsModule = 'export { cn } from "cn";\n';

const { button, badge } = new Function(
  'tv',
  `${variantsModule.replace(/^import .*$/m, '').replace(/export const/g, 'const')}\nreturn { button, badge };`,
)(tv);

/** Argument lists (source text) in the pack's coverage. */
const shapes = [
  "cn('p-2', 'p-4')",
  "cn('px-2 py-1', t && 'p-3', f ? 'px-5' : 'py-6')",
  "cn(['m-1 p-1', [t && 'p-2', 'm-3']], f && 'm-2', null, undefined, false, '')",
  "cn('text-sm text-red-500', tone)",
  "cn('shadow-md', t && 'shadow-inner')",
  "cn('p-2', { 'p-4': t, 'm-1': f, 2: t }, [tone, 'x'])",
  "cn(button({ variant: v, size: s }), 'px-1')",
  "cn(cn('p-1', t && 'p-2'), f && 'p-3', t ? cn('m-1', tone) : 'm-2')",
  "cn(t === f && 'eq', o || 'none')",
  "cn('  p-1 ', ' p-2  ')",
  "cn(badge({ active: t, tone }), k === 'b' && 'ring-0')",
  "twMerge('p-2 text-sm', t && 'p-4', ['m-1', f && 'm-2'])",
  "twJoin('p-2', t && 'p-4', tone, ['m-1', f && 'm-2'])",
];

const evaluate = state =>
  new Function(
    'cn',
    'twMerge',
    'twJoin',
    'button',
    'badge',
    `${variables.map(v => `const ${v.name} = ${v[state]};`).join('\n')}\nreturn [${shapes.join(',\n')}];`,
  )(cn, twMerge, twJoin, button, badge);

const a = evaluate('a');
const b = evaluate('b');
export const vectors = shapes.map((call, i) => ({ call, a: a[i], b: b[i] }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.join(here, 'cn-0.3.0.json');
  writeFileSync(out, `${JSON.stringify({ versions: PINNED, variables, vectors }, null, 1)}\n`);
  console.log(`${vectors.length} vectors → ${path.relative(process.cwd(), out)}`);
}
