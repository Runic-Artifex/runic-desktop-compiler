// Generates tests/vectors/style.json: svelte-toolbelt 0.10.6's cssToStyleObj
// (style-to-object 1.0.14, inline-style-parser 0.2.7) and mergeProps of
// style strings and objects, from the packages in Node, for
// crates/runic-js/src/style_parse.rs and attrs.rs.
//
//   node crates/runic-js/tests/vectors/style.mjs
//
// Cases:
//   parse: {"css": S, "entries": [[key, value], …]} or {"css": S, "error": message}
//   merge: {"a": style, "b": style, "result": string}, a style being a
//          string or {"object": [[key, value], …]}

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../../package.json'));
const { cssToStyleObj } = await import(
  require.resolve('svelte-toolbelt').replace(/index\.js$/, 'utils/css-to-style-obj.js')
);
const { mergeProps } = await import(require.resolve('svelte-toolbelt'));

const css = [
  '',
  'color: red',
  'color: red;',
  'pointer-events: auto; contain: layout style;',
  '  color :  red  ;  ; background: blue',
  'color: red; color: blue',
  '--bits-x: 1px; --Bits-Y: 2px',
  '-webkit-transition: none; -moz-appearance: none; -ms-flex: 1; -o-x: y',
  'background: url("a;b.png"); font-family: \'A;B\', serif',
  'background: url(a;b.png) no-repeat',
  'content: "a\\"b;c"; x: y',
  "content: 'it\\'s'; x: y",
  'content: "unterminated; x: y',
  '/* lead */ color: /* mid */ red /* tail */; x: y',
  'color/* c */: red',
  'color: red /* unterminated',
  '/* unterminated',
  'color red',
  'color: ; x: y',
  'grid-template-areas: "a b" "c d"',
  'transform: translate(1px, 2px) rotate(3deg); x: y',
  'a: b} c: d',
  '*zoom: 1; _height: 2px',
  'foo[bar]: 1; foo[BAR]: 2',
  'font-size: 12px !important',
  'margin:0;padding:0',
  '\n  color: red;\n  width: 10px\n',
  'WebkitX: y; fontSize: 1px; XMLHttp: 2; a-b-c: d; a_b: c; a.b: c; a/b: c',
  'background-color: rgb(1, 2, 3); line-height: 1.5',
  'x: y;;; ;z: w',
  'x: "multi\nline"; y: z',
  'x:  value ; y: z',
];
const parse = css.map(s => {
  try {
    return { css: s, entries: Object.entries(cssToStyleObj(s)) };
  } catch (e) {
    return { css: s, error: String(e.reason ?? e.message) };
  }
});

const styles = [
  'pointer-events: auto; contain: layout style;',
  'color: red; --x: 1px',
  { object: [['pointerEvents', 'auto'], ['color', 'blue']] },
  { object: [['--bits-y', '2px'], ['WebkitTransition', 'none']] },
  '',
];
const value = s => (typeof s === 'string' ? s : Object.fromEntries(s.object));
const merge = [];
for (const a of styles)
  for (const b of styles) {
    if (typeof a !== 'string' && typeof b !== 'string') continue;
    merge.push({ a, b, result: mergeProps({ style: value(a) }, { style: value(b) }).style });
  }

writeFileSync(join(here, 'style.json'), JSON.stringify({ parse, merge }, null, 1) + '\n');
console.log(`${parse.length} parse cases, ${merge.length} merge cases`);
