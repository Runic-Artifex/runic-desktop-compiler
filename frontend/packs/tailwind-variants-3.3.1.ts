// Mapping pack for tailwind-variants 3.3.1 (docs/design/M6-LIBRARIES.md#mapping-packs-d9).
//
// `const button = tv({ base, variants, defaultVariants, compoundVariants })`
// defines a variant function; `button({ variant, size, class })` returns
// the base classes, the classes of the selected variants (a missing or
// undefined value selects the default variant; null selects none) and the
// compound variants that match, merged by the copy of tailwind-merge that
// tailwind-variants bundles (dist/index.js, `src/internal/merge`, enabled by
// default). That bundled merge is not tailwind-merge 3.7.0: of 178,774
// comparisons over the editor's class strings below, 48 differ, all on
// `shadow-inner`, which 3.7.0 groups with the other shadow-* classes.
//
// Nothing is ported: the config must be a compile-time constant (literals,
// arrays and objects of them, consts bound to them), the real package
// builds the variant function at build time, and each call is evaluated by
// it (frontend/packs/choice.ts) over the finite values of its argument:
// constants become the resulting string; literal-union props, booleans and
// conditionals over literals enumerate every combination, and the program
// selects the result at runtime. The const has no runtime value; using the
// variant function other than in a direct call (its `variants`, `base`, …
// properties, passing it) is rejected, as are configs with `slots`,
// `compoundSlots` or `extend` (a different result shape), a second config
// argument, and non-constant configs. Open strings (a `class` prop passed
// through from a parent) are rejected with E_PACK.
//
// Measured use in the Translations Editor (runic-sdk
// apps/translations-editor/Frontend/src, 2026-10-04):
// - 11 tv definitions, all `{ base, variants, defaultVariants }` with string
//   classes (no compoundVariants, slots, extend or boolean variants); 10 sit
//   in `<script module>`, input-group-button's in the instance script.
// - 19 variant-function calls: 15 in wrappers (13 pass literal-union props as
//   shorthands, toggle-group-item passes `ctx.variant || variant` and
//   `ctx.size || size`, also literal unions) and 4 in app code (3 constant,
//   1 conditional between two literals). One passes `class`, a constant.
//   All are finite: 134 combinations over all definitions (each variant
//   key or undefined).
// - The bundled merge agrees with tailwind-merge 3.7.0 on all 134
//   combinations' class lists. Over the superset of 422 distinct class
//   strings the editor writes (tv outputs, literals, static `class` values)
//   and all 178,084 ordered pairs of them, the 48 disagreements all involve
//   `shadow-inner`; the editor's two `shadow-inner` classes never meet
//   another shadow class in the same merge (one is a <Textarea> class merged
//   by `cn` with a base without shadow classes, one a plain <div> class).
//   Evaluating each package for its own calls makes the pack exact either
//   way.
import ts from 'typescript';
import type { Pack, PackFunction } from '../packs.ts';
import { evaluatedChoice, staticValue, stringCall, type Ctx } from './choice.ts';
import { pinnedCheck, pinnedLoad } from './pinned.ts';

const VERSION = '3.3.1';
const LABEL = `tailwind-variants@${VERSION} pack`;
const ENTRY = 'dist/index.js';
const FILES = {
  [ENTRY]: 'cafd92d6ed98754ee4c89b2015935c57d473ca654867ca0fb65918957785839e',
  'dist/chunk-SUL6UUW2.js': 'e6f1f6dc0ff8187a3f3f6fff94cf77086d2e08bab997e36edba166c75d8b2254',
  'dist/chunk-OYFAXDFZ.js': '1f874dd408070761a2342c17e49f6ead41943e9a6092c9ace6df3f4af2e1910b',
};
const KEYS = new Set(['base', 'variants', 'defaultVariants', 'compoundVariants']);

type Tv = (config: unknown) => (...args: unknown[]) => unknown;

export const tailwindVariantsPack: Pack = {
  name: 'tailwind-variants',
  version: VERSION,
  module: import.meta.url,
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    if (imported !== 'tv') return `${LABEL} covers tv, not ${imported}`;
    const problem = pinnedCheck(pkg, FILES);
    if (problem) return problem;
    const tv = () => pinnedLoad<{ tv: Tv }>(pkg, ENTRY).tv;
    return {
      kind: 'function',
      call: (node, _b, lower) =>
        lower.fail(node, 'E_PACK', `${LABEL}: assign tv(...) to a const and call that`),
      constant(node, name, lower): PackFunction {
        const fail = (n: ts.Node, what: string): never =>
          lower.fail(n, 'E_PACK', `${LABEL}: ${what}`);
        const [arg, more] = node.arguments;
        if (!arg) fail(node, 'tv() needs a config');
        if (more) fail(more, 'a second (merge) config argument is not covered');
        const config = staticValue(lower, arg);
        if (!config || typeof config.value !== 'object' || config.value === null)
          fail(arg, 'the config must be a compile-time constant object literal');
        for (const key of Object.keys(config!.value as object))
          if (!KEYS.has(key))
            fail(
              arg,
              `the config key ${key} is not covered (base, variants, defaultVariants and compoundVariants are)`,
            );
        let variants: (...args: unknown[]) => unknown;
        try {
          variants = tv()(config!.value);
        } catch (err) {
          return fail(arg, `tv() threw at build time: ${(err as Error).message}`);
        }
        const ctx = (b: Ctx['b'], l: Ctx['lower']): Ctx => ({
          lower: l,
          b,
          label: `${LABEL} (${name})`,
        });
        const choice = (n: ts.CallExpression, b: Ctx['b'], l: Ctx['lower']) =>
          evaluatedChoice(ctx(b, l), n, args => variants(...args));
        return {
          kind: 'function',
          inline: true,
          choice,
          call: (n, b, l) => stringCall(ctx(b, l), n, choice(n, b, l)),
        };
      },
    };
  },
};
