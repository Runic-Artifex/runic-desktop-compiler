// Generates embla-carousel-8.6.0.json: the results of embla-carousel 8.6.0's
// own `objectsMergeDeep` (resolved from this repository's node_modules: the
// function, `isObject` and `objectKeys` taken from its ESM bundle, checked
// against the pack's pin) on the inputs below. The function is not exported,
// so it is evaluated from its source text here, never in a build.
// tests/embla-merge.test.mjs compiles every vector into a program whose
// package has the same function (the pack recognises it by its source),
// runs it in the reference interpreter and compares the results.
//
// Run explicitly (never during builds): node conformance/packs/embla-carousel.mjs
//
// Each vector gives TypeScript types `A` and `B` and JavaScript sources of
// the arguments (`b` null: the second argument is left out, as
// `mergeOptions(options)` does), and `show`: expressions over the result `r`
// whose values are compared. `rejected`: the program must be rejected (B's
// object has a key with an undefined value, which the merge would copy over
// A's value; the pack keeps A's value only where the key is absent and
// rejects programs where it may not be).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MERGE,
  MERGE_SHA256,
  normalizedSource,
  sourceHash,
  VERSION,
} from '../../frontend/packs/embla-carousel-8.6.0.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dir = path.dirname(require.resolve('embla-carousel/package.json'));
const info = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
if (info.version !== VERSION)
  throw new Error(`embla-carousel ${info.version} installed, ${VERSION} expected`);
const bundle = readFileSync(path.join(dir, 'esm/embla-carousel.esm.js'), 'utf8');
const names = [MERGE.name, ...MERGE.uses];
const source = normalizedSource(bundle, names);
if (!source || sourceHash(source) !== MERGE_SHA256)
  throw new Error(`the bundle's ${names.join(', ')} hash to ${source && sourceHash(source)}, the pack pins ${MERGE_SHA256}`);
// The function as the bundle declares it (its own text, not the printed one).
const text = names
  .map(n => {
    const start = bundle.indexOf(`function ${n}(`);
    let depth = 0;
    for (let i = bundle.indexOf('{', start); i < bundle.length; i++) {
      if (bundle[i] === '{') depth++;
      else if (bundle[i] === '}' && --depth === 0) return bundle.slice(start, i + 1);
    }
    throw new Error(`no end of ${n}`);
  })
  .join('\n');
const objectsMergeDeep = new Function(`${text}\nreturn ${MERGE.name};`)();

const OPT = `{ n?: number; m?: number }`;
export const vectors = [
  { A: '{ a: number; b: string }', a: "{ a: 1, b: 'x' }", B: '{ b?: string; c?: boolean }', b: '{ c: true }', show: ['r.a', 'r.b', 'r.c'] },
  { A: '{ a: number; b: string }', a: "{ a: 1, b: 'x' }", B: '{ b?: string; c?: boolean }', b: "{ b: 'y' }", show: ['r.a', 'r.b', 'r.c'] },
  { A: '{ a: number; b: string }', a: "{ a: 1, b: 'x' }", B: '{ b?: string; c?: boolean }', b: null, show: ['r.a', 'r.b'] },
  { A: '{ a: number; b: string }', a: "{ a: 1, b: 'x' }", B: '{ b?: string; c?: boolean }', b: '{}', show: ['r.a', 'r.b', 'r.c'] },
  { A: '{ n: { x: number; y: number } }', a: '{ n: { x: 1, y: 2 } }', B: '{ n?: { y?: number; z?: number } }', b: '{ n: { y: 5, z: 6 } }', show: ['r.n.x', 'r.n.y', 'r.n.z'] },
  { A: '{ n: { x: number; y: number } }', a: '{ n: { x: 1, y: 2 } }', B: '{ n?: { y?: number; z?: number } }', b: '{}', show: ['r.n.x', 'r.n.y', 'r.n.z'] },
  { A: '{ n: { x: number; y: number } }', a: '{ n: { x: 1, y: 2 } }', B: '{ n?: { y?: number; z?: number } }', b: '{ n: { z: 3 } }', show: ['r.n.x', 'r.n.y', 'r.n.z'] },
  { A: '{ d: { e: { f: number; g: string } } }', a: "{ d: { e: { f: 1, g: 'g' } } }", B: '{ d?: { e?: { f?: number } } }', b: '{ d: { e: { f: 9 } } }', show: ['r.d.e.f', 'r.d.e.g'] },
  { A: '{ xs: number[] }', a: '{ xs: [1, 2] }', B: '{ xs?: number[] }', b: '{ xs: [3] }', show: ['JSON.stringify(r.xs)'] },
  { A: '{ o: { x: number } | null }', a: '{ o: { x: 1 } }', B: '{ o?: { x: number } | null }', b: '{ o: null }', show: ['String(r.o)', 'r.o?.x'] },
  { A: '{ o: { x: number } | null }', a: '{ o: null }', B: '{ o?: { x: number } | null }', b: '{ o: { x: 2 } }', show: ['String(r.o === null)', 'r.o?.x'] },
  { A: '{ o: { x: number } | null }', a: '{ o: { x: 1 } }', B: '{ o?: { x: number } | null }', b: '{ o: { x: 2 } }', show: ['r.o?.x'] },
  { A: '{ f: () => string }', a: "{ f: () => 'a' }", B: '{ f?: () => string }', b: "{ f: () => 'b' }", show: ['r.f()'] },
  {
    A: `{ bp: { [k: string]: ${OPT} } }`,
    a: "{ bp: { '(min-width: 1px)': { n: 1 }, x: { m: 1 } } }",
    B: `{ bp?: { [k: string]: ${OPT} } }`,
    b: "{ bp: { '(min-width: 1px)': { m: 2 }, '1': { n: 3 } } }",
    show: ["Object.keys(r.bp).join(',')", "r.bp['(min-width: 1px)'].n", "r.bp['(min-width: 1px)'].m", "r.bp['x'].m", "r.bp['1'].n"],
  },
  {
    A: `{ bp: { [k: string]: ${OPT} } }`,
    a: '{ bp: { b: { n: 1 } } }',
    B: `{ bp?: { [k: string]: ${OPT} } }`,
    b: '{}',
    show: ["Object.keys(r.bp).join(',')", "r.bp['b'].n"],
  },
  { A: '{ a?: number; c: number }', a: '{ a: undefined, c: 1 }', B: '{ a?: number }', b: '{ a: 2 }', show: ['r.a', 'r.c'] },
  { A: '{ a?: number; c: number }', a: '{ a: undefined, c: 1 }', B: '{ a?: number }', b: '{}', show: ['r.a', 'r.c'] },
  { A: '{ a?: number; c: number }', a: '{ c: 1 }', B: '{ a?: number }', b: '{ a: 2 }', show: ['r.a', 'r.c'] },
  {
    A: `{ align: string; loop: boolean; duration: number; breakpoints: { [k: string]: { loop?: boolean } } }`,
    a: "{ align: 'center', loop: false, duration: 25, breakpoints: {} }",
    B: `{ align?: string; loop?: boolean; breakpoints?: { [k: string]: { loop?: boolean } } }`,
    b: "{ align: 'start', breakpoints: { '(min-width: 768px)': { loop: true } } }",
    show: ['r.align', 'r.loop', 'r.duration', "Object.keys(r.breakpoints).join(',')", "r.breakpoints['(min-width: 768px)'].loop"],
  },
  { A: '{ a: number }', a: '{ a: 1 }', B: '{ a?: number }', b: '{ a: undefined }', rejected: true },
  { A: '{ n: { x: number } }', a: '{ n: { x: 1 } }', B: '{ n?: { x?: number } }', b: '{ n: { x: undefined } }', rejected: true },
];

/** The value of each `show` expression over `r`, as a string. */
export function shown(r, show) {
  return show.map(s => String(new Function('r', `return (${s});`)(r))).join('|');
}

export const results = vectors.map(v => {
  const a = new Function(`return (${v.a});`)();
  const b = v.b === null ? undefined : new Function(`return (${v.b});`)();
  const r = objectsMergeDeep(a, b || {});
  return v.rejected ? { ...v, rejected: true } : { ...v, expected: shown(r, v.show) };
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(here, `embla-carousel-${VERSION}.json`);
  writeFileSync(
    out,
    JSON.stringify({ package: 'embla-carousel', version: VERSION, function: MERGE.name, sha256: MERGE_SHA256, vectors: results }, null, 1) + '\n',
  );
  console.log(`wrote ${results.length} vectors to ${path.relative(process.cwd(), out)}`);
}
