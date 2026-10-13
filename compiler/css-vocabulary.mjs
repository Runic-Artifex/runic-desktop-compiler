// The vocabulary of a CSS declaration value: its function names, dimension
// units and identifiers, lower-cased (runic_css::inline::vocabulary is the
// Rust twin, over cssparser's tokens). Used by the measured equivalence of
// declarations Stylo drops (compiler/collect.mjs, conformance/chromium-grammar.mjs).

// What a JavaScript number concatenated into a CSS numeric position becomes
// when it is negative after a written minus (`-{x}%` with x = -25 gives
// `--25%`), NaN, infinite, undefined or null: an identifier, never a number.
// `nan`, `infinity` and `-infinity` alone are calc() keywords, not artifacts.
export const ARTIFACT = /^(-?-\d|-?(nan|infinity|undefined|null)[a-z%]|undefined$|null$)/i;

const TOKEN =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#[\w-]+)|([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z_][\w-]*)?|(-?-?[a-z_\u0080-￿][\w\u0080-￿-]*|--[\w\u0080-￿-]*)(\()?/gi;

/** `{ functions, units, idents, artifacts }` of `value` (sets; artifacts: whether an ARTIFACT identifier occurs). */
export function vocabulary(value) {
  const out = { functions: new Set(), units: new Set(), idents: new Set(), artifacts: false };
  for (const m of value.matchAll(TOKEN)) {
    if (m[1] || m[2]) continue; // strings, hashes
    if (m[3] !== undefined) {
      if (m[4] && m[4] !== '%') out.units.add(m[4].toLowerCase());
      continue;
    }
    const name = m[5].toLowerCase();
    if (m[6]) out.functions.add(name);
    else if (ARTIFACT.test(name)) out.artifacts = true;
    else out.idents.add(name);
  }
  return out;
}
