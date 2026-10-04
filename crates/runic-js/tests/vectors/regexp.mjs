// Generates tests/vectors/regexp.json: RegExp construction, exec/test with
// lastIndex, and the String methods taking a RegExp (replace, replaceAll,
// match, matchAll, search, split) as computed by the running JavaScript
// engine. Deterministic for a given Node version.
//
//   node crates/runic-js/tests/vectors/regexp.mjs
//
// Values use the encoding of string.mjs ({"s": k} strings from a table of
// UTF-16 code units, {"n": …} numbers, {"u": 1}, {"null": 1}, {"b": …},
// {"a": […]}), plus:
//   match     {"m": [captures], "index": n, "groups": [[name, value]] | null}
//   throw     {"throw": "SyntaxError", "message": "..."}
// Each case records the result and `lastIndex` afterwards ("li").

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const units = s => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

const stringTable = [];
const stringIds = new Map();
function enc(v) {
  if (v === undefined) return { u: 1 };
  if (v === null) return { null: 1 };
  if (typeof v === 'string') {
    if (!stringIds.has(v)) {
      stringIds.set(v, stringTable.length);
      stringTable.push(units(v));
    }
    return { s: stringIds.get(v) };
  }
  if (typeof v === 'boolean') return { b: v };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { n: 'NaN' };
    if (v === Infinity) return { n: 'Infinity' };
    if (v === -Infinity) return { n: '-Infinity' };
    if (Object.is(v, -0)) return { n: '-0' };
    return { n: v };
  }
  if (Array.isArray(v) && 'index' in v) {
    return {
      m: Array.from(v, enc),
      index: v.index,
      input: enc(v.input),
      groups: v.groups === undefined ? null : Object.entries(v.groups).map(([k, x]) => [k, enc(x)]),
    };
  }
  if (Array.isArray(v)) return { a: v.map(enc) };
  throw new Error(`cannot encode ${v}`);
}

const cases = [];
function record(op, args, fn) {
  let r;
  let li;
  try {
    const out = fn();
    r = enc(out.r);
    li = out.li;
  } catch (e) {
    if (!(e instanceof SyntaxError || e instanceof TypeError)) throw e;
    r = { throw: e.name, message: e.message };
  }
  const c = { op, args: args.map(enc), r };
  if (li !== undefined) c.li = enc(li);
  cases.push(c);
}

// ---------------------------------------------------------------------------
// Corpus.

const patterns = [
  // Plain and classes.
  ['a', ''],
  ['a', 'g'],
  ['a', 'y'],
  ['a', 'gy'],
  ['a', 'i'],
  ['a', 'gi'],
  ['abc', ''],
  ['b', 'g'],
  ['[a-c]+', 'g'],
  ['[^a-c]', 'g'],
  ['\\d+', 'g'],
  ['\\w+', 'g'],
  ['\\s+', 'g'],
  ['\\W', 'g'],
  ['\\D+', ''],
  ['\\S+', 'g'],
  ['.', 'g'],
  ['.', 'gs'],
  ['.', 'gu'],
  ['.', 'gsu'],
  ['[\\s\\S]', 'g'],
  ['[^]', 'g'],
  ['[]', 'g'],
  // Anchors and boundaries.
  ['^a', 'g'],
  ['^a', 'gm'],
  ['a$', 'gm'],
  ['$', 'g'],
  ['^', 'gm'],
  ['^$', 'gm'],
  ['\\b', 'g'],
  ['\\B', 'g'],
  ['\\bfoo\\b', 'g'],
  ['\\b\\w', 'gi'],
  ['\\b\\w', 'giu'],
  // Quantifiers and empty matches.
  ['a*', 'g'],
  ['a*?', 'g'],
  ['a+?', 'g'],
  ['a{2}', 'g'],
  ['a{1,2}', 'g'],
  ['a{2,}', ''],
  ['x*', 'g'],
  ['x*', 'gu'],
  ['', ''],
  ['', 'g'],
  ['', 'gu'],
  ['(?:)', 'g'],
  ['|a', 'g'],
  ['a|', 'g'],
  ['(a)|b', 'g'],
  ['(a)?b', 'g'],
  ['(a*)*b', ''],
  ['(a|ab)(c|bcd)(d*)', ''],
  ['(z)((a+)?(b+)?(c))*', ''],
  ['(.)\\1', 'g'],
  ['(a)|\\1b', 'g'],
  // Groups and names.
  ['(\\d+)-(\\d+)', 'g'],
  ['(?<y>\\d{4})-(?<m>\\d\\d)', ''],
  ['(?<y>\\d{4})-(?<m>\\d\\d)', 'g'],
  ['(?<a>x)|(?<b>y)', 'g'],
  ['(?<a>x)|(?<a>y)', 'g'],
  ['(?<w>\\w)\\k<w>', 'g'],
  ['(?:a(b)?)+', ''],
  ['(?<first>[a-z]+) (?<last>[a-z]+)', 'i'],
  ['(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)', ''],
  // Lookaround.
  ['(?<=\\$)\\d+', 'g'],
  ['(?<!\\$)\\d+', 'g'],
  ['(?<=(\\d)(\\d))x', ''],
  ['(?<=a+)b', 'g'],
  ['(?=(a+))a*b\\1', ''],
  ['(?!a)\\w', 'g'],
  ['a(?=b)', 'g'],
  ['(?<=^|,)[^,]*', 'g'],
  ['(?<=\\b)o', 'g'],
  // Case folding.
  ['ß', 'i'],
  ['SS', 'i'],
  ['ſ', 'i'],
  ['s', 'gi'],
  ['s', 'giu'],
  ['k', 'gi'],
  ['k', 'giu'],
  ['\\u212A', 'i'],
  ['\\u212A', 'iu'],
  ['σ', 'gi'],
  ['Σ', 'giu'],
  ['İ', 'gi'],
  ['i', 'giu'],
  ['[a-z]+', 'gi'],
  ['[A-Z]+', 'giu'],
  ['\\w', 'giu'],
  ['[^\\W]', 'giu'],
  // Unicode.
  ['\\p{L}+', 'gu'],
  ['\\p{Lu}', 'gu'],
  ['\\P{L}+', 'gu'],
  ['\\p{Script=Greek}+', 'gu'],
  ['[\\p{L}_][\\p{L}\\p{N}_-]*', 'gu'],
  ['[^\\p{L}\\p{N}]+', 'gu'],
  ['\\p{Emoji_Presentation}', 'gu'],
  ['\\u{1F600}', 'gu'],
  ['\\uD83D\\uDE00', 'g'],
  ['\\uD83D\\uDE00+', ''],
  ['\\uD83D', 'g'],
  ['\\uD83D', 'gu'],
  ['\\uDE00', 'g'],
  ['\\uDE00', 'gu'],
  ['[😀-😂]', 'gu'],
  ['[\\uD800-\\uDFFF]', 'g'],
  ['[\\uD800-\\uDFFF]', 'gu'],
  ['😀', 'g'],
  ['^.$', 'u'],
  ['^.$', ''],
  ['\\S', 'gu'],
  // d flag.
  ['(b)', 'd'],
  ['a', 'dg'],
  // Annex B syntax.
  [']', 'g'],
  ['{', 'g'],
  ['a{', 'g'],
  ['a{1', ''],
  ['}', ''],
  ['\\c', ''],
  ['\\cJ', ''],
  ['[\\b]', 'g'],
  ['\\8', ''],
  ['\\1(a)', ''],
  ['\\2(a)', ''],
  ['\\01', ''],
  ['[\\d-z]', 'g'],
  ['\\k<x>', ''],
  ['\\p{L}', ''],
  ['\\a', ''],
  ['(?=a)*', ''],
  ['x{2,1', ''],
  // Line terminators and slashes.
  ['\\n', 'g'],
  ['a.b', ''],
  ['a.b', 's'],
  ['/', 'g'],
  ['[/]', ''],
  ['\n', ''],
  ['\\\n', ''],
  // Modifiers.
  ['(?i:a)b', 'g'],
  ['(?-i:a)b', 'gi'],
  // Patterns of the Translations Editor.
  ['[^\\p{L}\\p{N}]+', 'u'],
  ['^[A-Za-z_][A-Za-z0-9_]*$', ''],
  ['\\{[A-Za-z_][A-Za-z0-9_]*\\}', ''],
  ['^=', ''],
  ['^\\s*\\.(?:input|local|match)\\b', 'm'],
  ['^\\/+', ''],
  ['^\\s*\\*\\s+\\{\\{([\\s\\S]*?)\\}\\}\\s*$', 'mu'],
  ['^\\s*one\\s+\\{\\{([\\s\\S]*?)\\}\\}\\s*$', 'mu'],
  ['\\{\\$([\\p{L}_][\\p{L}\\p{N}_-]*)(?:\\s+:[^}]*)?\\}', 'gu'],
  ['^-?(0|[1-9][0-9]*)$', ''],
  ['^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$', ''],
  ['^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'i'],
  ['^\\d{4}-\\d{2}-\\d{2}$', ''],
  ['^\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,7})?$', ''],
  ['(Z|[+-]\\d{2}:\\d{2})$', ''],
  ['^(-)?(?:(\\d+)\\.)?(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,7}))?$', ''],
];

// Invalid patterns and flags (construction only).
const invalid = [
  ['(', ''],
  ['(', 'u'],
  [')', ''],
  ['a**', ''],
  ['+', ''],
  ['*', 'u'],
  ['?', ''],
  ['[b-a]', ''],
  ['\\', ''],
  ['(?<a>x)(?<a>y)', ''],
  ['a{2,1}', ''],
  ['\\k<x>', 'u'],
  ['(?<1>x)', ''],
  ['[', ''],
  ['\\p{Foo}', 'u'],
  ['x{', 'u'],
  [']', 'u'],
  ['{', 'u'],
  ['\\c', 'u'],
  ['\\8', 'u'],
  ['\\01', 'u'],
  ['\\a', 'u'],
  ['[\\d-z]', 'u'],
  ['(?=a)*', 'u'],
  ['(?<=a)*', ''],
  ['\\u{110000}', 'u'],
  ['(?<a', ''],
  ['(?', ''],
  ['(?x)', ''],
  ['a{1,2', 'u'],
  ['(?<a>', ''],
  ['(?<a>x', ''],
  ['[a-', ''],
  ['a{99999999999}', ''],
  ['\\u{', 'u'],
  ['\\p', 'u'],
  ['\\p{', 'u'],
  ['\\P{Lu', 'u'],
  ['(?<=x', ''],
  ['[\\b-a]', ''],
  ['\\k', 'u'],
  ['\\k<a', 'u'],
  ['(?<a>a)\\k<b>', ''],
  ['[a-\\d]', 'u'],
  ['a{,5}', 'u'],
  ['\\-', 'u'],
  ['(?:', ''],
  ['(*)', ''],
  ['a|*', ''],
  ['((a)', ''],
  ['a)b(', ''],
  ['(?i-i:a)', ''],
  ['(?ii:a)', ''],
  ['\\cA\\c1', 'u'],
  ['\\00', 'u'],
  ['\\1', 'u'],
  ['a', 'gg'],
  ['a', 'uv'],
  ['a', 'x'],
  ['a', 'G'],
  ['a', 'gimsuyd '],
];

const strings = [
  '',
  'a',
  'aa',
  'aaa',
  'ab',
  'abc',
  'aab',
  'ba',
  'xaxa',
  'abcabc',
  'b',
  'bc',
  'aabaac',
  'zaacbbbcac',
  'foo bar foo',
  'Foo foo FOO',
  '12-34 56-78',
  '$12 34 $5',
  '2024-05 and 1999-12',
  'John Smith',
  'a,b,,c,',
  ',a,',
  'a\nb\nc',
  '\n\n',
  'line1\r\nline2',
  'a.b a\nb',
  'x y\tz',
  'Straße STRASSE strasse',
  'ſ s S',
  'K k K',
  'ΣΑΣ σας',
  'İi ıI',
  'Ǆǅǆ',
  '😀',
  'a😀b😀',
  '😀😁😂😃',
  '\ud83d',
  '\ude00',
  'a\ud83db',
  '\ude00\ud83d',
  'x\ud83d😀y',
  '😀\ude00',
  '日本語 テキスト',
  'αβγ abc ДЖ',
  'hello_world-2 x',
  '{name}',
  'Hello {name}, you have {count} items',
  '{$user} has {$n :number} files',
  '{$café_1} {$ x}',
  '.input {$x :number}\n.match $x',
  '  .local $y = {1}',
  '/a/b//c',
  '==x',
  '=',
  '* {{fallback}}',
  '  one   {{only one}}  ',
  '-0',
  '42',
  '-17.25',
  '007',
  '3.',
  '0f8fad5b-d9cb-469f-a165-70867728950e',
  '0F8FAD5B-D9CB-469F-A165-70867728950E',
  '2024-01-31',
  '12:34:56',
  '12:34:56.1234567',
  '2024-01-31T10:00:00Z',
  '2024-01-31T10:00:00+02:00',
  '1.02:03:04.5',
  '-02:03:04',
  ']{}',
  '\\',
  'a{1',
  '\u000a',
  '\b',
  '\u0001',
  "$&$`$'$$$1$<n>$",
];

const lastIndexes = [0, 1, 2, 3, 5, -1, 1.5, NaN, 100, 2 ** 53, Infinity];

const templates = [
  '[$&]',
  '$1',
  '$2|$1',
  '$$',
  '$`',
  "$'",
  '<$<y>/$<m>>',
  '$<a>$<b>',
  '$0',
  '$00',
  '$01',
  '$10',
  '$11',
  '$12',
  '$99',
  '$<',
  '$<x',
  '$',
  'x$',
  '$<nope>',
  '-$&-$1-',
];

for (const [p, f] of [...patterns, ...invalid]) {
  record('new', [p, f], () => {
    const re = new RegExp(p, f);
    return {
      r: [
        re.source,
        re.flags,
        String(re),
        re.global,
        re.ignoreCase,
        re.multiline,
        re.dotAll,
        re.unicode,
        re.unicodeSets,
        re.sticky,
        re.hasIndices,
      ],
    };
  });
}

// Each pattern runs over a deterministic sample of the strings; the
// operations and their extra arguments rotate through their corpora.
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
let step = 11;
while (gcd(step, strings.length) !== 1) step++;
const sample = pi =>
  Array.from({ length: 16 }, (_, j) => strings[(pi * 5 + j * step) % strings.length]);
patterns.forEach(([p, f], pi) => {
  sample(pi).forEach((s, si) => {
    const k = pi + si;
    for (const li of [0, lastIndexes[k % lastIndexes.length]]) {
      record('exec', [p, f, s, li], () => {
        const re = new RegExp(p, f);
        re.lastIndex = li;
        return { r: re.exec(s), li: re.lastIndex };
      });
    }
    record('test', [p, f, s, 1], () => {
      const re = new RegExp(p, f);
      re.lastIndex = 1;
      return { r: re.test(s), li: re.lastIndex };
    });
    record('match', [p, f, s, 2], () => {
      const re = new RegExp(p, f);
      re.lastIndex = 2;
      return { r: s.match(re), li: re.lastIndex };
    });
    record('matchAll', [p, f, s, 1], () => {
      const re = new RegExp(p, f);
      re.lastIndex = 1;
      return { r: [...s.matchAll(re)], li: re.lastIndex };
    });
    record('search', [p, f, s, 3], () => {
      const re = new RegExp(p, f);
      re.lastIndex = 3;
      return { r: s.search(re), li: re.lastIndex };
    });
    const limit = [undefined, 2, undefined, 0, 1][k % 5];
    record('split', [p, f, s, limit], () => {
      const re = new RegExp(p, f);
      re.lastIndex = 1;
      return { r: s.split(re, limit), li: re.lastIndex };
    });
    const t = templates[k % templates.length];
    const methods = f.includes('g') || si === 0 ? ['replace', 'replaceAll'] : ['replace'];
    for (const method of methods) {
      record(method, [p, f, s, t, 1], () => {
        const re = new RegExp(p, f);
        re.lastIndex = 1;
        return { r: s[method](re, t), li: re.lastIndex };
      });
    }
    // Function replacements record their arguments.
    const fnMethod = methods[k % methods.length];
    record(fnMethod + 'Fn', [p, f, s, 1], () => {
      const re = new RegExp(p, f);
      re.lastIndex = 1;
      const calls = [];
      const r = s[fnMethod](re, (...args) => {
        const named = typeof args.at(-1) === 'object';
        const plain = named ? args.slice(0, -1) : args;
        calls.push(plain.slice(0, -1));
        return `<${calls.length}:${plain[0]}@${plain.at(-2)}>`;
      });
      return { r: [r, calls], li: re.lastIndex };
    });
  });
});

// Case-insensitive matching, exhaustively over every code point with a case
// mapping (and what it maps to): for each such character c and each mode,
// the other characters of the universe that /c/i and /[c]/i match.
const universe = new Set();
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = String.fromCodePoint(cp);
  const related = [c.toUpperCase(), c.toLowerCase()].filter(x => x !== c && [...x].length === 1);
  if (related.length) {
    universe.add(cp);
    for (const r of related) universe.add(r.codePointAt(0));
  }
}
const chars = [...universe].sort((a, b) => a - b);
const haystack = chars.map(cp => String.fromCodePoint(cp)).join('\n');
const hex = cp =>
  cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
const icase = [];
for (const flags of ['gi', 'giu']) {
  for (const cp of chars) {
    // Without u, astral characters are two code units: skip them.
    if (flags === 'gi' && cp > 0xffff) continue;
    for (const [kind, source] of [
      ['char', hex(cp)],
      ['class', `[${hex(cp)}]`],
    ]) {
      const pattern = flags === 'gi' ? source.replace(/\\u\{(\w+)\}/, (_, h) => `\\u${h}`) : source;
      const found = [];
      for (const m of haystack.matchAll(new RegExp(pattern, flags))) {
        const other = m[0].codePointAt(0);
        if (other !== cp) found.push(other);
      }
      if (found.length) icase.push([flags, kind, cp, found]);
    }
  }
}

// Character classes and class escapes over the same universe (plus ASCII
// and the space characters): the indices of the universe characters each
// matches, as runs [start, length].
const classUniverse = [
  ...new Set([...Array.from({ length: 128 }, (_, i) => i), 0xa0, 0x2028, 0xfeff, ...chars]),
]
  .filter(cp => cp !== 10)
  .sort((a, b) => a - b);
const classHay = classUniverse.map(cp => String.fromCodePoint(cp)).join('\n');
const classPatterns = [
  '\\w',
  '\\W',
  '[\\w]',
  '[\\W]',
  '[^\\w]',
  '[^\\W]',
  '\\s',
  '\\S',
  '[\\S]',
  '[^\\S]',
  '\\d',
  '\\D',
  '[\\D]',
  '[^\\D]',
  '[^a]',
  '[^s]',
  '[^k]',
  '[^\\u017f]',
  '[a-z]',
  '[^a-z]',
  '[\\u0100-\\u017f]',
  '[^\\W\\d]',
  '[\\w\\u017f]',
  '.',
  '\\bx|\\B.',
  '[\\u2100-\\u214f]',
  '[^\\u2100-\\u214f]',
  '\\p{Lu}',
  '\\P{Lu}',
  '[\\p{Lu}]',
  '[\\P{Lu}]',
  '[^\\p{Lu}]',
  '[^\\P{Lu}]',
  '\\p{Ll}',
  '[^\\P{Ll}\\d]',
  '\\p{L}',
  '[\\W\\d]',
  '[^\\W_]',
  '(.)\\1',
];
const classes = [];
for (const flags of ['g', 'gi', 'gu', 'giu']) {
  for (const p of classPatterns) {
    const hits = new Set();
    for (const m of classHay.matchAll(new RegExp(p, flags)))
      if (m[0] !== '\n' && m[0] !== '') hits.add(m[0].codePointAt(0));
    const runs = [];
    classUniverse.forEach((cp, i) => {
      if (!hits.has(cp)) return;
      const last = runs.at(-1);
      if (last && last[0] + last[1] === i) last[1]++;
      else runs.push([i, 1]);
    });
    classes.push([p, flags, runs]);
  }
}

const counts = {};
for (const c of cases) counts[c.op] = (counts[c.op] ?? 0) + 1;
counts.icase = icase.length;
counts.classes = classes.length;

const lines = [];
lines.push('{');
lines.push(`"generator": "crates/runic-js/tests/vectors/regexp.mjs",`);
lines.push(`"node": ${JSON.stringify(process.version)},`);
lines.push(`"unicode": ${JSON.stringify(process.versions.unicode)},`);
lines.push(`"counts": ${JSON.stringify(counts)},`);
lines.push(`"icaseUniverse": ${JSON.stringify(chars)},`);
lines.push(`"icase": [\n${icase.map(e => JSON.stringify(e)).join(',\n')}\n],`);
lines.push(`"classUniverse": ${JSON.stringify(classUniverse)},`);
lines.push(`"classes": [\n${classes.map(e => JSON.stringify(e)).join(',\n')}\n],`);
lines.push(`"strings": [\n${stringTable.map(u => JSON.stringify(u)).join(',\n')}\n],`);
lines.push(`"cases": [\n${cases.map(c => JSON.stringify(c)).join(',\n')}\n]`);
lines.push('}');
const path = join(dirname(fileURLToPath(import.meta.url)), 'regexp.json');
writeFileSync(path, lines.join('\n') + '\n');
console.log(`wrote ${cases.length} cases to ${path}`);
console.log(counts);
