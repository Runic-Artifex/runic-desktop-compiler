// Generates tailwind.json: the output of the real tailwind-merge 3.7.0,
// tailwind-variants 3.3.1 and clsx 2.1.1 (resolved from this repository's
// node_modules) for call shapes the tailwind mapping packs evaluate at build
// time (frontend/packs/tailwind-merge-3.7.0.ts, tailwind-variants-3.3.1.ts).
// tests/packs.test.mjs compiles every vector into a Svelte component (with
// `cn` and the variant functions in modules, as shadcn writes them), runs it
// in the reference interpreter and compares the strings, in two states of
// the variables (`a`, then `b` after one click): the build evaluated every
// combination, and the program has to select the right one.
//
// Run explicitly (never during builds): node conformance/packs/tailwind.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PINNED = { 'tailwind-merge': '3.7.0', 'tailwind-variants': '3.3.1', clsx: '2.1.1' };
for (const [name, version] of Object.entries(PINNED)) {
  // Some exports maps hide package.json: find it above the resolved entry.
  let dir = path.dirname(require.resolve(name));
  while (path.basename(dir) !== name) dir = path.dirname(dir);
  const info = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (info.version !== version) throw new Error(`${name} ${info.version} installed, ${version} expected`);
}
const { twMerge, twJoin } = await import('tailwind-merge');
const { tv } = await import('tailwind-variants');
const { clsx } = await import('clsx');

/** The variant functions, as module source (variants.ts) and evaluated here. */
export const variantsModule = `import { tv } from 'tailwind-variants';
export const button = tv({
  base: 'btn inline-flex rounded-md border px-4 py-2 text-sm',
  variants: {
    variant: { solid: 'bg-blue text-white', outline: 'bg-white text-blue', ghost: 'bg-transparent px-2' },
    size: { sm: 'px-2 py-1 text-xs', md: '', lg: 'px-6 py-3 text-lg' },
  },
  defaultVariants: { variant: 'solid', size: 'md' },
});
export const badge = tv({
  base: 'badge rounded-full px-3 py-1',
  variants: {
    active: { true: 'font-bold ring-2', false: 'font-normal' },
    tone: { warm: 'bg-orange-100', cool: 'bg-sky-100' },
  },
  compoundVariants: [{ active: true, tone: 'warm', class: 'ring-orange-500 px-5' }],
  defaultVariants: { active: false },
});
`;
export const utilsModule = `import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;
const { button, badge } = new Function(
  'tv',
  `${variantsModule.replace(/^import .*$/m, '').replace(/export const/g, 'const')}\nreturn { button, badge };`,
)(tv);
const cn = (...inputs) => twMerge(clsx(inputs));

export const variables = [
  { name: 'v', type: "'solid' | 'outline' | 'ghost'", a: "'solid'", b: "'ghost'" },
  { name: 's', type: "'sm' | 'md' | 'lg' | undefined", a: 'undefined', b: "'lg'" },
  { name: 'ns', type: "'sm' | 'lg' | null | undefined", a: 'null', b: 'undefined' },
  { name: 't', type: 'boolean', a: 'true', b: 'false' },
  { name: 'f', type: 'boolean', a: 'false', b: 'true' },
  { name: 'tone', type: "'warm' | 'cool' | null", a: 'null', b: "'cool'" },
  { name: 'o', type: "'solid' | 'outline' | 'ghost' | ''", a: "''", b: "'outline'" },
  { name: 'k', type: "'a' | 'b'", a: "'a'", b: "'b'" },
];

/** Argument lists (source text) in the packs' coverage. */
const shapes = [
  "twMerge('p-2', 'p-4')",
  "twMerge('px-2 py-1', t && 'p-3', f ? 'px-5' : 'py-6')",
  "twMerge(['m-1 p-1', [t && 'p-2', 'm-3']], f && 'm-2', null, undefined, false, '')",
  "twMerge('text-sm text-red-500', tone)",
  "twMerge('shadow-md', t && 'shadow-inner')",
  "twMerge(v === 'ghost' ? 'opacity-50' : 'opacity-100', !t && 'hidden', k === 'b' && 'block')",
  "twMerge(clsx('p-1', t && 'p-2', { 'p-3': f }), s)",
  "twMerge('  p-1 ', ' p-2  ')",
  "twJoin('p-2', t && 'p-4', tone, ['m-1', f && 'm-2'])",
  "cn('p-2', { 'p-4': t, 'm-1': f, 2: t }, [tone, 'x'])",
  "cn(button({ variant: v, size: s }), 'px-1')",
  "cn(cn('p-1', t && 'p-2'), f && 'p-3', t ? cn('m-1', tone) : 'm-2')",
  "cn(t === f && 'eq', o || 'none')",
  "button({ variant: o || v, size: 'sm' })",
  "button({ size: ns })",
  "button()",
  "button({ variant: v, class: t ? 'px-9' : undefined })",
  "button({ variant: 'ghost', className: ['rounded-none', f && 'px-0'] })",
  "badge({ active: t, tone })",
  "badge({ active: f, tone: tone ?? 'warm', className: 'ring-0' })",
  "badge({ active: t && f })",
];

const evaluate = state =>
  new Function(
    'twMerge',
    'twJoin',
    'clsx',
    'cn',
    'button',
    'badge',
    `${variables.map(v => `const ${v.name} = ${v[state]};`).join('\n')}\nreturn [${shapes.join(',\n')}];`,
  )(twMerge, twJoin, clsx, cn, button, badge);

const a = evaluate('a');
const b = evaluate('b');
export const vectors = shapes.map((call, i) => ({ call, a: a[i], b: b[i] }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.join(here, 'tailwind.json');
  writeFileSync(
    out,
    `${JSON.stringify({ versions: PINNED, variables, vectors }, null, 1)}\n`,
  );
  console.log(`${vectors.length} vectors → ${path.relative(process.cwd(), out)}`);
}
