// Generates clsx-2.1.1.json: the output of the real clsx 2.1.1 (resolved
// from this repository's node_modules) for call shapes the clsx mapping pack
// lowers (frontend/packs/clsx-2.1.1.ts). tests/packs.test.mjs compiles every
// vector into a Svelte component, runs it in the reference interpreter and
// compares the class strings, in two states of the variables (`a`, then `b`
// after one click).
//
// Run explicitly (never during builds): node conformance/packs/clsx.mjs
//
// Variables are given as TypeScript types and JavaScript source literals.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const VERSION = '2.1.1';
// clsx's exports map hides package.json: read it next to dist/.
const main = require.resolve('clsx');
const info = JSON.parse(readFileSync(path.join(path.dirname(main), '..', 'package.json'), 'utf8'));
if (info.name !== 'clsx') throw new Error(`unexpected package layout at ${main}`);
if (info.version !== VERSION) throw new Error(`clsx ${info.version} installed, ${VERSION} expected`);
const { clsx } = await import('clsx');

export const variables = [
  { name: 's', type: 'string', a: "'foo'", b: "''" },
  { name: 'e', type: 'string', a: "''", b: "' sp '" },
  { name: 'n', type: 'string | null', a: 'null', b: "'bar baz'" },
  { name: 'u', type: 'string | undefined', a: 'undefined', b: "'u'" },
  { name: 't', type: 'boolean', a: 'true', b: 'false' },
  { name: 'f', type: 'boolean', a: 'false', b: 'true' },
  { name: 'z', type: 'number', a: '0', b: '3.5' },
  { name: 'k', type: 'number', a: '7', b: 'NaN' },
  { name: 'm', type: 'number', a: '-0', b: '1e21' },
  { name: 'nn', type: 'number | null', a: 'null', b: '12' },
  { name: 'xs', type: 'string[]', a: "['a', '', 'b']", b: '[]' },
  { name: 'ys', type: '(string | null)[]', a: "[null, 'q']", b: "['r', null, '']" },
  { name: 'ns', type: 'number[]', a: '[0, 1, NaN]', b: '[2, -0]' },
  { name: 'bs', type: 'boolean[]', a: '[true]', b: '[false, true]' },
  { name: 'nested', type: 'string[][]', a: "[['x', ''], []]", b: "[['y'], [' ']]" },
];

/** Argument lists (source text) in the pack's coverage. */
const shapes = [
  "'a'",
  "'a', 'b'",
  "'  a ', ' b  '",
  "''",
  "' '",
  "'a', ' ', 'b'",
  's, e, n, u',
  "t && 'yes', f && 'no'",
  "t ? 'on' : 'off', f ? s : n",
  "{ a: t, b: f, 'c d': true }",
  '{ b: t, 1: t, a: t, 0: f, 10: true, 4294967295: t, 4294967294: t }',
  '{ s, t, k, z }',
  "{ a: s, b: e, c: n, d: nn, e: xs }",
  "{ a: t, '': t, b: f }",
  "{ '': t, a: t }",
  "{ ' ': t, a: f }",
  "['x', ['y', [f && 'z', 'w']], []]",
  "[{ x: t }, [{ y: f, z: t }], {}]",
  'z, k, m, 1.5, 0',
  'nn',
  'xs, ys',
  'ns',
  'bs',
  'nested',
  'null, undefined, true, false',
  "s || 'fallback', e || 'fb2', n ?? 'nul', u ?? s",
  "k && 'num', z && 'zero', k || 'never', z || 'zero-or'",
  '[], {}',
  '`t-${k}`, `${s}${e}`',
  "clsx('inner', t && 'x'), 'outer'",
  "e, e, 'a', e",
  '[s, n, [u, k]], { x: k, y: z, z: nn }',
  "'a', 1e21, -0, NaN",
  "{ 'is-on': t && f, b: s, c: !t }",
  "t && ['p', { q: f }], f && { never: true }",
  "s ? 'has-s' : { empty: t }",
  "nn ?? 'none', u || n || 'last'",
  "[xs, ns, bs], [ys]",
];

const names = variables.map(v => v.name);
const evaluate = (args, state) => {
  const values = variables.map(v => Function(`return (${v[state]})`)());
  return Function('clsx', ...names, `return clsx(${args});`)(clsx, ...values);
};
export const vectors = shapes.map(args => ({ args, a: evaluate(args, 'a'), b: evaluate(args, 'b') }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.join(here, `clsx-${VERSION}.json`);
  writeFileSync(
    out,
    JSON.stringify({ package: 'clsx', version: VERSION, variables, vectors }, null, 1) + '\n',
  );
  console.log(`${vectors.length} vectors → ${path.relative(process.cwd(), out)}`);
}
