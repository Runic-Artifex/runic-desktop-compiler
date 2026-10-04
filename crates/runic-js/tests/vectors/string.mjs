// Generates tests/vectors/string.json: expected results of String.prototype
// methods (family B, docs/design/M2-VALUES.md) computed by the running
// JavaScript engine over an adversarial corpus. Deterministic: rerunning with
// the same Node/ICU version produces an identical file.
//
//   node crates/runic-js/tests/vectors/string.mjs
//
// Encoding (lossless for lone surrogates and special numbers):
//   string    {"s": k}, where `strings[k]` holds the UTF-16 code units
//             (deduplicated; keeps the file small)
//   number    {"n": 1.5 | "NaN" | "Infinity" | "-Infinity" | "-0"}
//   undefined {"u": 1}
//   null      {"null": 1}
//   boolean   {"b": true}
//   array     {"a": [encoded values]}
//   throw     {"throw": "RangeError", "message": "..."}

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

const stringTable = [];
const stringIds = new Map();
function enc(v) {
  if (v === undefined) return { u: 1 };
  if (v === null) return { null: 1 };
  if (typeof v === "string") {
    if (!stringIds.has(v)) {
      stringIds.set(v, stringTable.length);
      stringTable.push(units(v));
    }
    return { s: stringIds.get(v) };
  }
  if (typeof v === "boolean") return { b: v };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { n: "NaN" };
    if (v === Infinity) return { n: "Infinity" };
    if (v === -Infinity) return { n: "-Infinity" };
    if (Object.is(v, -0)) return { n: "-0" };
    return { n: v };
  }
  if (Array.isArray(v)) return { a: v.map(enc) };
  throw new Error(`cannot encode ${v}`);
}

// Deterministic PRNG (mulberry32).
let seed = 0x5eed_b0b;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const cases = [];
function record(method, args, fn) {
  let result;
  try {
    result = enc(fn());
  } catch (e) {
    result = { throw: e.name, message: e.message };
  }
  cases.push({ m: method, args: args.map(enc), r: result });
}

// ---------------------------------------------------------------------------
// Corpus.

const WS = "\t\v\f                　﻿\n\r  ";

const strings = [
  "",
  "a",
  "A",
  "abc",
  "abcabc",
  "aaaa",
  "abab",
  "Hello, World!",
  "The quick brown fox jumps over the lazy dog",
  "0123456789",
  "  padded  ",
  "\t\n x \r\n",
  WS,
  WS + "mid" + WS,
  "᠎x᠎",
  "​x​",
  "\u0085x\u0085",
  "﻿bom﻿",
  "ÄÖÜäöüß",
  "straße",
  "İstanbul",
  "ıIiİ",
  "ǅǄǆ",
  "ﬁﬂﬀﬃ",
  "ŉ",
  "ΣΑΣ",
  "ὈΔΥΣΣΕΎΣ",
  "ΐΰ",
  "ᾀᾳῳ",
  "😀",
  "a😀b",
  "😀😀",
  "👨‍👩‍👧",
  "\ud83d",
  "\ude00",
  "a\ud83db",
  "\ude00\ud83d",
  "x\ud83d😀y",
  "é",
  "Aȩ́Z",
  "𐐀𐐨𐐁",
  "𞤀𞤢",
  "日本語のテキスト",
  "한국어",
  "$&$`$'$$$1$<n>$",
  "a$b$$c",
  "a,b,,c,",
  ",,,",
  "a--b--c",
  "mississippi",
  "\u0000\u0001￿",
];

const searches = [
  "", "a", "b", "c", "ab", "abc", "bc", "x", "zz", " ", ",", "--", "ss", "issi",
  "😀", "\ud83d", "\ude00", "ß", "SS", "é", "́", "$", "Σ", "aaaa", "aa",
  "Hello", "World!", "dog", "日本",
];

const positions = [
  undefined, NaN, 0, -0, 0.5, -0.5, 0.9999999, 1, 1.5, 1.9, -1, -1.5, -1.9, 2, 3, 4, 5, 7, 10, 42, 100,
  -2, -3, -5, -100, Infinity, -Infinity, 2 ** 31, 2 ** 32, 2 ** 32 + 1, -(2 ** 32), 1e21, -1e21,
  4294967295, 4294967296.5, Number.MAX_SAFE_INTEGER, 2 ** 53 + 2, Number.MIN_VALUE, -Number.MIN_VALUE,
];
const numbers = positions.filter((p) => p !== undefined);

// ---------------------------------------------------------------------------
// Character access: every string at every numeric position.

const charPositions = [NaN, 0, -0, 0.5, -0.5, 1, 1.9, -1, -1.9, 2, 3, 5, 10, 42, -2, -5, -100, Infinity, -Infinity, 2 ** 32, 1e21, -Number.MIN_VALUE];
for (const s of strings) {
  for (const i of [...charPositions, s.length - 1, s.length, -s.length, -s.length - 1]) {
    record("at", [s, i], () => s.at(i));
    record("index", [s, i], () => s[i]);
    record("charAt", [s, i], () => s.charAt(i));
    record("charCodeAt", [s, i], () => s.charCodeAt(i));
    record("codePointAt", [s, i], () => s.codePointAt(i));
  }
}

// Substrings: start × end over a sample.
for (const s of strings) {
  for (const a of [0, 1, -1, 2, -2, NaN, Infinity, -Infinity]) {
    record("slice", [s, a, undefined], () => s.slice(a));
    record("substring", [s, a, undefined], () => s.substring(a));
  }
  for (let k = 0; k < 14; k++) {
    const a = pick(numbers);
    const b = pick(positions);
    record("slice", [s, a, b], () => s.slice(a, b));
    record("substring", [s, a, b], () => s.substring(a, b));
  }
}

// Searching: every string × search without a position, plus sampled positions.
const searchMethods = {
  indexOf: (s, t, p) => s.indexOf(t, p),
  lastIndexOf: (s, t, p) => s.lastIndexOf(t, p),
  includes: (s, t, p) => s.includes(t, p),
  startsWith: (s, t, p) => s.startsWith(t, p),
  endsWith: (s, t, p) => s.endsWith(t, p),
};
for (const [name, fn] of Object.entries(searchMethods)) {
  for (const s of strings) {
    for (let k = 0; k < 12; k++) {
      const t = pick(searches);
      record(name, [s, t, undefined], () => fn(s, t, undefined));
    }
    // A search for a substring of s itself, so that matches are common.
    for (let k = 0; k < 8; k++) {
      const a = Math.floor(rand() * (s.length + 1));
      const b = a + Math.floor(rand() * (s.length - a + 1));
      const t = s.slice(a, b);
      const p = pick(positions);
      record(name, [s, t, p], () => fn(s, t, p));
    }
    for (let k = 0; k < 8; k++) {
      const t = pick(searches);
      const p = pick(positions);
      record(name, [s, t, p], () => fn(s, t, p));
    }
  }
}

// Trimming: every corpus string, plus an exhaustive table (see `trimTable`).
const trimMethods = { trim: (s) => s.trim(), trimStart: (s) => s.trimStart(), trimEnd: (s) => s.trimEnd() };
const trimInputs = [...strings, WS + WS, "x" + WS, WS + "x", "\ud800" + WS, WS + "\udc00 ", "　、"];
for (const [name, fn] of Object.entries(trimMethods)) {
  for (const s of trimInputs) record(name, [s], () => fn(s));
}
// Every code unit the engine trims; the Rust test checks all 65536 units.
const trimTable = [];
for (let u = 0; u <= 0xffff; u++) {
  const c = String.fromCharCode(u);
  if ((c + "x" + c).trim() === "x") trimTable.push(u);
}

// Case conversion over strings with context. The exhaustive per-code-point
// comparison lives in `caseTable` below.
const caseInputs = [...strings];
const sigmaContext = ["", "A", "α", "1", " ", "'", ".", "́", "A'", "Á", "­", "\ud800", "A\ud800", "😀", "𐐀", "ʰ", "ǅ", "Σ"];
for (const before of sigmaContext) {
  for (const after of sigmaContext) caseInputs.push(before + "Σ" + after);
}
caseInputs.push("ΣΣΣ", "ΑΣ ΑΣ.", "ΑΣ́Α", "Α\ud83dΣ", "Σ\ude00Α", "ΑΣ😀Α", "ΑΣ𐐀", "İ̇", "İ", "ʼN", "ǰ̌");
for (const s of caseInputs) {
  record("toUpperCase", [s], () => s.toUpperCase());
  record("toLowerCase", [s], () => s.toLowerCase());
}

// Padding.
const fillers = [undefined, null, "", " ", "*", "ab", "abc", "😀", "\ud83d", "-=", "0123456789"];
const padLengths = [NaN, -1, -Infinity, 0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 16.9, 20, "s+1", "s+2"];
for (const s of strings) {
  for (let k = 0; k < 16; k++) {
    let n = pick(padLengths);
    if (n === "s+1") n = s.length + 1;
    else if (n === "s+2") n = s.length + 2;
    const f = pick(fillers);
    record("padStart", [s, n, f], () => s.padStart(n, f));
    record("padEnd", [s, n, f], () => s.padEnd(n, f));
  }
}

// Repetition, including RangeErrors.
const counts = [0, -0, 0.5, -0.5, -0.9999, 1, 1.5, 2, 3, 4.9, 7, NaN, -1, -1.5, Infinity, -Infinity, 2 ** 29, 2 ** 40];
for (const s of strings) {
  for (const n of counts) record("repeat", [s, n], () => s.repeat(n));
}

// Splitting.
const separators = [undefined, null, "", ",", "a", "b", "ab", "--", "ss", " ", "😀", "\ud83d", "\ude00", "x", "aaaa", "aa", "Σ"];
const limits = [undefined, 0, -0, 1, 2, 3, 1.5, -1, NaN, Infinity, -Infinity, 2 ** 32, 2 ** 32 + 1, -(2 ** 32) + 2, 4294967295];
for (const s of strings) {
  for (const sep of separators) record("split", [s, sep, undefined], () => s.split(sep));
  for (let k = 0; k < 8; k++) {
    const sep = pick(separators);
    const lim = pick(limits);
    record("split", [s, sep, lim], () => s.split(sep, lim));
  }
}

// Replacing.
const replacements = ["", "X", "[$&]", "$$", "$`", "$'", "<$`|$&|$'>", "$", "$1", "$01", "$10", "$99", "$0", "$<n>", "$<", "$$&", "$$$", "a$", "😀", "\ud83d"];
const replaceMethods = { replace: (s, p, r) => s.replace(p, r), replaceAll: (s, p, r) => s.replaceAll(p, r) };
for (const [name, fn] of Object.entries(replaceMethods)) {
  for (const s of strings) {
    for (const p of ["", "a", "b", "ss", "😀", "\ud83d", "$", "Σ", "zz"]) record(name, [s, p, "<$&>"], () => fn(s, p, "<$&>"));
    for (let k = 0; k < 10; k++) {
      const p = rand() < 0.5 ? pick(searches) : s.slice(Math.floor(rand() * (s.length + 1)), Math.floor(rand() * (s.length + 1)));
      const r = pick(replacements);
      record(name, [s, p, r], () => fn(s, p, r));
    }
  }
}

// Concatenation.
for (const s of strings) {
  for (let k = 0; k < 6; k++) {
    const others = Array.from({ length: Math.floor(rand() * 4) }, () => pick(strings));
    record("concat", [s, others], () => s.concat(...others));
  }
  record("concat", [s, ["\ude00"]], () => s.concat("\ude00"));
}

// Comparison (`<` and `>`: code-unit order). `localeCompare` collates with
// ICU; its vectors come from Chromium (intl.mjs).
const compareInputs = [...strings, "B", "b", "a\u0000", "ab", "\ud800", "￿", "😀a", ""];
for (const a of compareInputs) {
  for (const b of compareInputs) {
    if (rand() < 0.4 || a === b) {
      const order = () => (a < b ? -1 : a > b ? 1 : 0);
      record("compare", [a, b], order);
    }
  }
}

// String.fromCharCode.
const charCodes = [0, 65, 0x7f, 0xff, 0x100, 0xd800, 0xdc00, 0xffff, 0x10000, 0x10041, -1, -65535, 65.9, -0.5, NaN, Infinity, -Infinity, 2 ** 32 + 66, -(2 ** 53), 1e21, 4294967295, 0x1f600];
for (const c of charCodes) record("fromCharCode", [[c]], () => String.fromCharCode(c));
for (let k = 0; k < 300; k++) {
  const args = Array.from({ length: Math.floor(rand() * 5) }, () => (rand() < 0.5 ? pick(charCodes) : Math.floor(rand() * 0x20000) - 0x8000));
  record("fromCharCode", [args], () => String.fromCharCode(...args));
}

// String iterator.
for (const s of [...strings, ...caseInputs.slice(strings.length, strings.length + 60)]) {
  record("codePoints", [s], () => [...s]);
}
for (let k = 0; k < 300; k++) {
  const s = Array.from({ length: Math.floor(rand() * 6) }, () => pick(["a", "😀", "\ud83d", "\ude00", "𐀀", "􏿿", "é"])).join("");
  record("codePoints", [s], () => [...s]);
}

// ---------------------------------------------------------------------------
// Exhaustive case table: every code point whose single-code-point
// toUpperCase/toLowerCase is not itself. Code points absent here map to
// themselves.

const caseTable = { upper: [], lower: [] };
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = String.fromCodePoint(cp);
  const u = c.toUpperCase();
  const l = c.toLowerCase();
  if (u !== c) caseTable.upper.push([cp, units(u)]);
  if (l !== c) caseTable.lower.push([cp, units(l)]);
}

const counts_ = {};
for (const c of cases) counts_[c.m] = (counts_[c.m] ?? 0) + 1;

const out = {
  generator: "crates/runic-js/tests/vectors/string.mjs",
  node: process.version,
  unicode: process.versions.unicode,
  icu: process.versions.icu,
  counts: counts_,
  trimTable,
  caseTable,
  cases,
};
const lines = [];
lines.push("{");
for (const key of ["generator", "node", "unicode", "icu", "counts", "trimTable"]) lines.push(`${JSON.stringify(key)}: ${JSON.stringify(out[key])},`);
lines.push(`"caseTable": {`);
lines.push(`"upper": [\n${caseTable.upper.map((e) => JSON.stringify(e)).join(",\n")}\n],`);
lines.push(`"lower": [\n${caseTable.lower.map((e) => JSON.stringify(e)).join(",\n")}\n]`);
lines.push("},");
lines.push(`"strings": [\n${stringTable.map((u) => JSON.stringify(u)).join(",\n")}\n],`);
lines.push(`"cases": [\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]`);
lines.push("}");
const path = join(dirname(fileURLToPath(import.meta.url)), "string.json");
writeFileSync(path, lines.join("\n") + "\n");
console.log(`wrote ${cases.length} cases (${caseTable.upper.length} upper, ${caseTable.lower.length} lower mappings) to ${path}`);
console.log(counts_);
