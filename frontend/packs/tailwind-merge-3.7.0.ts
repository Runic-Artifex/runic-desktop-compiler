// Mapping pack for tailwind-merge 3.7.0 (docs/design/M6-LIBRARIES.md#mapping-packs-d9).
//
// twMerge(...classLists) joins its arguments as twJoin does (truthy strings
// and the truthy values of nested arrays, single spaces, no trimming) and
// resolves Tailwind class conflicts with the default configuration: of
// classes in one group (p-2 p-4, shadow-md shadow-inner) with the same
// modifiers, the last wins. The algorithm and its ~2,300-line configuration
// of class groups and validators are not ported. Calls are evaluated at
// build time by the published package itself (frontend/packs/choice.ts):
//
// - constant arguments: the call becomes the resulting string;
// - arguments ranging over finite sets of values (conditionals over
//   literals, `cond && 'x'`, values of literal-union types, clsx calls,
//   variant functions of tailwind-variants, nested twMerge calls): every
//   combination is merged at build time and the program selects the result
//   by the same tests JavaScript evaluates;
// - a prop passed through from a parent ranges over the values its
//   instantiation sites pass (frontend/domains.ts, prop domains);
// - other open strings are rejected with E_PACK. A native port would have
//   to reproduce the whole default configuration; the editor does not need
//   one (below).
//
// Exports: twMerge and twJoin (both evaluated). Wrappers such as shadcn's
// `cn(...inputs) { return twMerge(clsx(inputs)) }` are inlined at their call
// sites (packs.ts `bindPackWrapper`). Others (extendTailwindMerge,
// createTailwindMerge, getDefaultConfig, mergeConfigs, validators,
// fromTheme) are rejected.
//
// Measured use in the Translations Editor (runic-sdk
// apps/translations-editor/Frontend/src, 2026-10-04, svelte/compiler AST):
// - twMerge is called only by `cn` (src/lib/utils.ts); there are 141 calls
//   of `cn` (136 in shadcn wrappers under lib/components/ui, 5 in app code),
//   none in .ts files. Only 1 has all-constant arguments
//   (select-content.svelte:37).
// - Their 302 arguments: 144 string literals, 15 variant-function results
//   (finite: literal-union props), 4 `cond && 'literal'`, 3 conditionals
//   between literals, and 136 pass-through string props (134 `class` props
//   destructured as `className`, AppDialog's `bodyClass`, tooltip-content's
//   `arrowClasses`), one in each of 136 calls.
// - The other 5 calls (MessageList.svelte:112, 113, 180, sidebar.svelte:74,
//   select-content.svelte:37) are finite and covered, as are the 4 direct
//   variant-function calls in app code (tailwind-variants pack). The 136
//   calls with a pass-through prop are open strings and rejected. Without
//   that argument each of them would be finite. The values those props
//   receive are finite in the editor: the app passes 170 `class` values to
//   components (160 static strings, 4 variant-function calls, 3 `cn` calls
//   and 3 arrays, all over literals and booleans), and wrappers pass `cn`
//   results of their own finite arguments to inner wrappers. The cheapest
//   exact path is therefore to propagate the finite set of values each
//   component's string props receive from all instantiation sites (a
//   whole-program analysis in the shared language layer, not in this pack:
//   frontend/domains.ts, M6 step 3, Svelte); spreads onto components (97,
//   of which 9 on tv-wrapper components, e.g. bits-ui `{...props}` from
//   child snippets) have to be part of it (step 6).
import type ts from 'typescript';
import type { Pack } from '../packs.ts';
import { evaluatedChoice, evaluatedValues, stringCall, type Ctx } from './choice.ts';
import { pinnedCheck, pinnedLoad } from './pinned.ts';

const VERSION = '3.7.0';
const LABEL = `tailwind-merge@${VERSION} pack`;
/** The ESM bundle Vite and Node import (`exports["."].import`). */
const ENTRY = 'dist/bundle-mjs.mjs';
const FILES = { [ENTRY]: '4a952fc10c828632c608dd103b7d8bcab097d9c6f32bfc343a2d9e0822c86116' };

type TwMerge = (...classLists: unknown[]) => string;

export const tailwindMergePack: Pack = {
  name: 'tailwind-merge',
  version: VERSION,
  module: import.meta.url,
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    if (imported !== 'twMerge' && imported !== 'twJoin')
      return `${LABEL} covers twMerge and twJoin, not ${imported}`;
    const problem = pinnedCheck(pkg, FILES);
    if (problem) return problem;
    const fn = () => pinnedLoad<Record<string, TwMerge>>(pkg, ENTRY)[imported];
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
