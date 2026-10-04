// Mapping pack for cn 0.3.0 (docs/design/M6-LIBRARIES.md#mapping-packs-d9).
//
// `cn` (shadcn-ui/cn) is the class helper shadcn-svelte's registry installs
// as lib/utils.ts (`export { cn } from "cn"`) and its documentation site
// uses: clsx-style arguments (strings, arrays, objects of conditions)
// joined and merged by its own compiled Tailwind conflict tables, a drop-in
// replacement for `twMerge(clsx(...))`. Its `twMerge` and `twJoin` are the
// tailwind-merge-compatible variadic forms.
//
// Nothing is ported: as for tailwind-merge (frontend/packs/tailwind-merge-
// 3.7.0.ts), calls are evaluated at build time by the published package
// itself (frontend/packs/choice.ts) over the finite values of their
// arguments, and the program selects the result with the tests JavaScript
// evaluates. Class props passed through from a parent take the finite set
// of values their instantiation sites pass (frontend/domains.ts); open
// strings are rejected with E_PACK.
//
// Exports: cn, twMerge and twJoin (evaluated). Others (clsx, createEngine,
// the subpaths ./engine, ./tables, ./config, ./compiler, ./build, ./vite,
// ./next, ./lite) are rejected.
import type ts from 'typescript';
import type { Pack } from '../packs.ts';
import { evaluatedChoice, evaluatedValues, stringCall, type Ctx } from './choice.ts';
import { pinnedCheck, pinnedLoad } from './pinned.ts';

const VERSION = '0.3.0';
const LABEL = `cn@${VERSION} pack`;
/** The ESM entry Vite and Node import (`exports["."].import`) and what it loads. */
const ENTRY = 'dist/index.js';
const FILES = {
  [ENTRY]: '7f6b0ec6ac5e5a56ab6b7ad86c407e2cb378af13e3797ef72afbabc0fc264f6b',
  'dist/engine.js': '12b9100a63df437105988719f39890480eaafa2b09503e1ef43985205e177ad0',
  'dist/tables.js': 'b00020876adaf439a5e94ceaab105296a15d96712c95960e319f0a1f2dc60002',
};
const EXPORTS = new Set(['cn', 'twMerge', 'twJoin']);

type Fn = (...inputs: unknown[]) => string;

export const cnPack: Pack = {
  name: 'cn',
  version: VERSION,
  module: import.meta.url,
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    if (!EXPORTS.has(imported)) return `${LABEL} covers cn, twMerge and twJoin, not ${imported}`;
    const problem = pinnedCheck(pkg, FILES);
    if (problem) return problem;
    const fn = () => pinnedLoad<Record<string, Fn>>(pkg, ENTRY)[imported];
    const ctx = (b: Ctx['b'], lower: Ctx['lower']): Ctx => ({ lower, b, label: LABEL });
    const choice = (node: ts.CallExpression, b: Ctx['b'], lower: Ctx['lower']) =>
      evaluatedChoice(ctx(b, lower), node, args => fn()(...args));
    return {
      kind: 'function',
      inline: true,
      choice,
      values: (node, lower) =>
        evaluatedValues({ lower, label: LABEL }, node, args => fn()(...args)),
      call: (node, b, lower) => stringCall(ctx(b, lower), node, choice(node, b, lower)),
    };
  },
};
