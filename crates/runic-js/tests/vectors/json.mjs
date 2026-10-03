// Generates tests/vectors/json.json: JSON.stringify / JSON.parse reference
// results from Node for family D (crates/runic-js/src/json.rs).
//
//   node crates/runic-js/tests/vectors/json.mjs
//
// Encoding (strings that are not well-formed UTF-16 cannot travel through
// JSON text that serde_json accepts, so they are written as code units):
//   string S   = "text" when well-formed, otherwise {"u16": [code units]}
//   value  V   = a flat preorder list of tokens (deep values would exceed
//                serde_json's nesting limit as trees):
//                ["null"] | ["bool", b] | ["num", N] | ["str", S]
//                | ["arr", n] followed by n values
//                | ["obj", n] followed by n times ["key", S] and a value
//                  (members in Object.keys order)
//   number N   = String(x), or "-0" for negative zero
//   indent I   = ["none"] | ["spaces", N] | ["text", S]
//
// Cases:
//   quote:     {"input": S, "output": S}                  JSON.stringify(string)
//   stringify: {"value": V, "indent": I, "output": S}
//   parse:     {"text": S, "result": V} or {"text": S, "error": "SyntaxError"}

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const enc = (s) => (s.isWellFormed() ? s : { u16: Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)) });
const num = (x) => (Object.is(x, -0) ? "-0" : String(x));

function encodeValue(v, tokens = []) {
  if (v === null) tokens.push(["null"]);
  else if (typeof v === "boolean") tokens.push(["bool", v]);
  else if (typeof v === "number") tokens.push(["num", num(v)]);
  else if (typeof v === "string") tokens.push(["str", enc(v)]);
  else if (Array.isArray(v)) {
    tokens.push(["arr", v.length]);
    for (const item of v) encodeValue(item, tokens);
  } else {
    const keys = Object.keys(v);
    tokens.push(["obj", keys.length]);
    for (const k of keys) {
      tokens.push(["key", enc(k)]);
      encodeValue(v[k], tokens);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------- strings
const strings = [
  "",
  "a",
  "hello world",
  '"',
  "\\",
  '\\"',
  "/",
  "\b\f\n\r\t",
  "\v",
  "\x7f",
  "\x80",
  "\xa0",
  "  ",
  "﻿",
  "￿",
  "é",
  "日本語",
  "😀",
  "a😀b",
  "\ud800",
  "\udbff",
  "\udc00",
  "\udfff",
  "\ud800\ud800",
  "\udc00\ud800",
  "a\ud800b",
  "\ud83d",
  "\ude00",
  "😀\ude00",
  "\ud83d😀",
  "x\udfffy퟿",
  "<script>",
  "'single'",
  "tab\there",
  "line\nbreak",
  "nul\0char",
];
for (let c = 0; c < 0x20; c++) strings.push(String.fromCharCode(c), `a${String.fromCharCode(c)}z`);
for (const c of [0x7e, 0x7f, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xfffe, 0xffff]) {
  strings.push(String.fromCharCode(c));
}
strings.push(Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join(""));

const quote = strings.map((s) => ({ input: enc(s), output: enc(JSON.stringify(s)) }));

// ---------------------------------------------------------------- stringify
const numbers = [
  0,
  -0,
  1,
  -1,
  0.1,
  0.1 + 0.2,
  1.5,
  -2.5,
  123.456,
  1e20,
  1e21,
  -1e21,
  1.5e21,
  1e-6,
  1e-7,
  1.2345e-7,
  5e-324,
  -5e-324,
  2.2250738585072014e-308,
  1.7976931348623157e308,
  2 ** 53,
  2 ** 53 + 2,
  -(2 ** 31),
  2 ** 32 - 1,
  12345678901234567890,
  NaN,
  Infinity,
  -Infinity,
];

const values = [
  null,
  true,
  false,
  ...numbers,
  ...strings.slice(0, 40),
  [],
  {},
  [[]],
  [{}],
  { a: [] },
  { a: {} },
  [1, 2, 3],
  [null, true, false, "x", 1.5, -0, NaN, Infinity],
  { a: 1, b: "two", c: null, d: true, e: [1, { f: [] }] },
  { "": "empty key", " ": "space", '"': "quote", "\n": "newline", "\ud800": "lone", "😀": "emoji" },
  { b: 1, a: 2, 2: "two", 1: "one", "-1": "neg", "01": "lead", 4294967294: "max", 4294967295: "notindex" },
  [[1, [2, [3, [4, [5]]]]], { x: { y: { z: {} } } }],
  { list: [{ id: 1, tags: ["a", "b"] }, { id: 2, tags: [] }], meta: { count: 2, ok: true } },
  Array.from({ length: 12 }, (_, i) => i * 1.25),
  "𐀀\udc00",
];
// Deep nesting.
let deep = 0;
for (let i = 0; i < 600; i++) deep = [deep];
values.push(deep);
let deepObj = "leaf";
for (let i = 0; i < 300; i++) deepObj = { k: deepObj, n: [i] };
values.push(deepObj);

const indents = [
  ["none", undefined],
  ["spaces", 0],
  ["spaces", -0],
  ["spaces", 1],
  ["spaces", 2],
  ["spaces", 4],
  ["spaces", 10],
  ["spaces", 11],
  ["spaces", 100],
  ["spaces", -1],
  ["spaces", 2.7],
  ["spaces", 0.9],
  ["spaces", 0.1],
  ["spaces", 5e-324],
  ["spaces", 9.99],
  ["spaces", 10.5],
  ["spaces", -0.5],
  ["spaces", NaN],
  ["spaces", Infinity],
  ["spaces", -Infinity],
  ["text", ""],
  ["text", " "],
  ["text", "\t"],
  ["text", "--"],
  ["text", "abc"],
  ["text", "0123456789"],
  ["text", "0123456789abcdef"],
  ["text", "123456789😀"],
  ["text", "\ud800"],
  ["text", "\n"],
];

const encodeIndent = ([kind, arg]) =>
  kind === "none" ? ["none"] : kind === "spaces" ? ["spaces", num(arg)] : ["text", enc(arg)];

const stringify = [];
for (const v of values) {
  // Huge structures only with a few indents to keep the file small.
  const isHuge = v === deep || v === deepObj;
  for (const ind of isHuge ? indents.slice(0, 2) : indents) {
    stringify.push({ value: encodeValue(v), indent: encodeIndent(ind), output: enc(JSON.stringify(v, null, ind[1])) });
  }
}

// ---------------------------------------------------------------- parse
const validTexts = [
  "null",
  "true",
  "false",
  "0",
  "-0",
  "1",
  "-1",
  "0.5",
  "-0.5",
  "1e5",
  "1E5",
  "1e+5",
  "1e-5",
  "1E+05",
  "1.0e0",
  "0e0",
  "-0e-0",
  "0.0",
  "-0.0",
  "1e21",
  "1e400",
  "-1e400",
  "1e-400",
  "-1e-400",
  "5e-324",
  "2e-324",
  "3e-324",
  "4.9406564584124654e-324",
  "2.4703282292062327e-324",
  "2.4703282292062328e-324",
  "1.7976931348623157e308",
  "1.7976931348623158e308",
  "1.7976931348623159e308",
  "9007199254740993",
  "12345678901234567890",
  "123456789012345678901234567890",
  "0.1000000000000000055511151231257827021181583404541015625",
  "0.30000000000000004",
  "2.2250738585072011e-308",
  "2.2250738585072012e-308",
  "9.999999999999999e22",
  "1." + "0".repeat(400) + "1",
  "0." + "0".repeat(400) + "1e400",
  "1" + "0".repeat(400) + "e-400",
  '""',
  '"abc"',
  '"\\""',
  '"\\\\"',
  '"\\/"',
  '"\\b\\f\\n\\r\\t"',
  '"\\u0000"',
  '"\\u001f"',
  '"\\u0041\\u00e9\\u00E9"',
  '"\\uD83D\\uDE00"',
  '"\\ud83d\\ude00"',
  '"\\ud800"',
  '"\\udc00"',
  '"\\ud800\\ud800"',
  '"\\udc00\\ud800"',
  '"\\ud800x"',
  '"\\ud800\\u0041"',
  '"😀"',
  '"\ud800"',
  '"\udc00\ud800"',
  '"\x7f"',
  '"  "',
  '"﻿"',
  '"é日本"',
  "[]",
  "{}",
  "[ ]",
  "{ }",
  " \t\n\r[ \t\n\r1 \t\n\r, \t\n\r2 \t\n\r] \t\n\r",
  '{"a":1}',
  '{ "a" : 1 , "b" : [ true , false , null ] }',
  '{"a":1,"b":2,"a":3}',
  '{"a":1,"b":2,"a":3,"b":4,"c":5}',
  '{"a":{"x":1},"a":[2]}',
  '{"b":1,"2":2,"1":3,"a":4,"0":5}',
  '{"b":1,"1":2,"b":3,"1":4}',
  '{"01":1,"1":2,"-1":3,"1.0":4,"1e0":5}',
  '{"4294967294":1,"4294967295":2,"4294967296":3,"0":4}',
  '{"10":1,"9":2,"100":3,"a":4,"":5}',
  '{"":1}',
  '{"__proto__":1,"constructor":2,"toString":3}',
  '{"__proto__":{"x":1}}',
  '{"\\u0061":1,"a":2}',
  '{"\\ud800":1,"\\udc00":2}',
  '{"\\u0030":1,"x":2}',
  "[[[[[]]]]]",
  '[{"a":[{"b":[{}]}]}]',
  '[1,"two",3.5,null,true,false,{},[]]',
  '{"list":[{"id":1,"tags":["a","b"]},{"id":2,"tags":[]}],"meta":{"count":2,"ok":true}}',
  "[" + "1,".repeat(200) + "1]",
  "[".repeat(512) + "]".repeat(512),
  "[".repeat(2000) + "]".repeat(2000),
  '{"a":'.repeat(512) + "0" + "}".repeat(512),
];

const invalidTexts = [
  "",
  " ",
  "\t\n\r ",
  "﻿",
  "﻿{}",
  "﻿null",
  " null",
  " null",
  "\vnull",
  "\fnull",
  "null\v",
  "nul",
  "nulll",
  "Null",
  "NULL",
  "tru",
  "True",
  "fals",
  "False",
  "undefined",
  "NaN",
  "Infinity",
  "-Infinity",
  "+1",
  "+0",
  "-",
  "--1",
  "- 1",
  "01",
  "00",
  "-01",
  "001.5",
  ".5",
  "-.5",
  "1.",
  "-1.",
  "1.e5",
  "1e",
  "1E",
  "1e+",
  "1e-",
  "1e+-1",
  "1ee1",
  "1.5.5",
  "0x10",
  "0X10",
  "0b1",
  "0o7",
  "1_000",
  "1 2",
  "1,2",
  "Infinity1",
  "'a'",
  "'",
  '"',
  '"abc',
  '"\\"',
  '"\\',
  '"\\u"',
  '"\\u1"',
  '"\\u12"',
  '"\\u123"',
  '"\\u123g"',
  '"\\uGGGG"',
  '"\\U0041"',
  '"\\x41"',
  '"\\a"',
  '"\\v"',
  '"\\0"',
  '"\\\'"',
  '"\\ "',
  '"\\\n"',
  '"\\u{41}"',
  '"a\nb"',
  '"a\tb"',
  '"a\rb"',
  '"\0"',
  '"\x1f"',
  '"abc"x',
  '"abc""def"',
  "[",
  "]",
  "{",
  "}",
  "[1",
  "[1,",
  "[1,]",
  "[,1]",
  "[,]",
  "[1,,2]",
  "[1 2]",
  "[1;2]",
  "[1]]",
  "[[1]",
  "[1}",
  "{]",
  '{"a"}',
  '{"a":}',
  '{"a" 1}',
  '{"a":1,}',
  '{,"a":1}',
  '{"a":1,,"b":2}',
  '{"a":1 "b":2}',
  '{"a":1;"b":2}',
  "{a:1}",
  "{'a':1}",
  "{1:1}",
  "{null:1}",
  '{"a":1}}',
  '{"a":1',
  '{"a"',
  '{"a":',
  '{"a',
  '{"a":1}{"b":2}',
  "[]]",
  "[][]",
  "{}{}",
  "{} {}",
  "null null",
  "true false",
  "1 // comment",
  "// comment\n1",
  "/* comment */ 1",
  "1 /* comment */",
  "[1, /* c */ 2]",
  "#1",
  "[1]\x00",
  "\x00",
  "[\ud800]",
  "\ud800",
  "1 ",
  "[1 ]",
  "[true,false,nul]",
  '{"a":tru}',
  "[01]",
  "[1.]",
  "[.1]",
  "[-]",
  "[+1]",
  '["a" "b"]',
  "[undefined]",
  '{"a":undefined}',
  "[NaN]",
  "[Infinity]",
  "new Date()",
  "function(){}",
  "`a`",
  "[".repeat(10),
  "]".repeat(10),
];

// Every proper prefix and some mutations of a few valid documents.
const seeds = [
  '{"a":[1,-2.5e+3,true,false,null,"x\\u0041\\n"],"b":{}}',
  '[{"k":"v"},[],0,-0.0e-0]',
  '"\\ud83d\\ude00\\t"',
  "-12.5E-3",
];
const generated = [];
for (const seed of seeds) {
  for (let i = 0; i < seed.length; i++) generated.push(seed.slice(0, i));
  const insert = [",", "]", "}", ":", '"', "\\", "0", "-", ".", "e", "'", "x", "\n", "\0", "\ud800"];
  for (let i = 0; i <= seed.length; i++) {
    for (const ch of insert) generated.push(seed.slice(0, i) + ch + seed.slice(i));
  }
  for (let i = 0; i < seed.length; i++) generated.push(seed.slice(0, i) + seed.slice(i + 1));
}

const seen = new Set();
const parse = [];
for (const text of [...validTexts, ...invalidTexts, ...generated]) {
  if (seen.has(text)) continue;
  seen.add(text);
  let result;
  try {
    result = { text: enc(text), result: encodeValue(JSON.parse(text)) };
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    result = { text: enc(text), error: "SyntaxError" };
  }
  parse.push(result);
}

const out = {
  generator: "crates/runic-js/tests/vectors/json.mjs",
  node: process.version,
  quote,
  stringify,
  parse,
};
const file = join(dirname(fileURLToPath(import.meta.url)), "json.json");
writeFileSync(file, JSON.stringify(out) + "\n");
const errors = parse.filter((c) => c.error).length;
console.log(
  `wrote ${file}: ${quote.length} quote, ${stringify.length} stringify, ${parse.length} parse (${errors} SyntaxError)`,
);
