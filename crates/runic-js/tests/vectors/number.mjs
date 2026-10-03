// Generates crates/runic-js/tests/vectors/number.json: expected results of the
// family A built-ins (Number, Math, numeric operators) computed by Node.
//
//   node crates/runic-js/tests/vectors/number.mjs
//
// Encoding (so that NaN, ±Infinity and -0 survive JSON and parsing is exact):
// - number: its JavaScript ToString, except "-0" for negative zero. Rust's
//   `str::parse::<f64>` reads these strings correctly rounded.
// - string argument: a JSON string, or {"u": [code units]} if it contains lone
//   surrogates.
// - optional argument (`Maybe<f64>`): null for `null`, "undefined" for
//   `undefined`, otherwise a number.
// - result: a number, a boolean, a string, or {"throws": "<error name>"}.
// Each case is [[...args], result] or [[...args], result, "exact"]; "exact"
// marks transcendental cases that must match bit for bit (special values and
// exactly representable results).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Deterministic PRNG (xorshift128+ over BigInt), seeded per function.

function rng(seed) {
  let s0 = BigInt(seed) * 0x9e3779b97f4a7c15n + 0x2545f4914f6cdd1dn;
  let s1 = BigInt(seed) * 0xbf58476d1ce4e5b9n + 0x94d049bb133111ebn;
  const mask = (1n << 64n) - 1n;
  s0 &= mask;
  s1 &= mask;
  const next64 = () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23n) & mask;
    x ^= x >> 17n;
    x ^= y ^ (y >> 26n);
    s1 = x;
    return (s0 + s1) & mask;
  };
  for (let i = 0; i < 8; i++) next64();
  const view = new DataView(new ArrayBuffer(8));
  const r = {
    u64: next64,
    // uniform in [0, 1)
    float: () => Number(next64() >> 11n) / 2 ** 53,
    int: (lo, hi) => lo + Math.floor(r.float() * (hi - lo + 1)),
    pick: xs => xs[r.int(0, xs.length - 1)],
    bool: () => (next64() & 1n) === 1n,
    // any double, from a uniformly random bit pattern
    bits: () => {
      view.setBigUint64(0, next64());
      return view.getFloat64(0);
    },
  };
  return r;
}

const num = x => (Object.is(x, -0) ? '-0' : String(x));
const isWellFormed = s => s.isWellFormed();
const str = s =>
  isWellFormed(s) ? s : { u: Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)) };
const maybe = x => (x === null ? null : x === undefined ? 'undefined' : num(x));
const value = v =>
  typeof v === 'number' ? num(v) : typeof v === 'boolean' ? v : typeof v === 'string' ? v : v;
function call(f) {
  try {
    return value(f());
  } catch (e) {
    return { throws: e.name };
  }
}

// ---------------------------------------------------------------------------
// Inputs

const P = n => 2 ** n;
const edgeNumbers = [
  0,
  -0,
  NaN,
  Infinity,
  -Infinity,
  1,
  -1,
  0.5,
  -0.5,
  1.5,
  -1.5,
  2.5,
  -2.5,
  3.5,
  -3.5,
  0.49999999999999994,
  -0.49999999999999994,
  0.5000000000000001,
  -0.5000000000000001,
  P(52),
  P(52) - 0.5,
  -(P(52) - 0.5),
  P(52) + 1,
  P(53),
  P(53) - 1,
  -(P(53) - 1),
  P(53) + 2,
  P(54),
  P(31),
  P(31) - 1,
  -P(31),
  -P(31) - 1,
  P(32),
  P(32) - 1,
  P(32) + 1,
  -P(32),
  P(32) + 0.5,
  P(33) + 5,
  -P(33) - 5,
  P(63),
  P(64),
  P(64) + P(12),
  -P(70),
  1e20,
  1e21,
  -1e21,
  999999999999999900000,
  1e21 - 65536 * 2,
  1.7976931348623157e308,
  -1.7976931348623157e308,
  5e-324,
  -5e-324,
  1e-323,
  2.2250738585072014e-308,
  2.225073858507201e-308,
  1e-310,
  1.005,
  1.45,
  8.345,
  1.255,
  9.995,
  99.995,
  0.615,
  10.235,
  1.0049999999999999,
  2.675,
  0.1,
  0.2,
  0.3,
  0.1 + 0.2,
  1 / 3,
  2 / 3,
  -1 / 3,
  Math.PI,
  -Math.PI,
  Math.E,
  Math.LN2,
  Math.SQRT2,
  Math.SQRT1_2,
  Math.PI / 2,
  Math.PI / 4,
  (3 * Math.PI) / 4,
  123.456,
  -123.456,
  1e-7,
  1e-6,
  0.000001,
  0.0000001,
  1.5e-7,
  1e-10,
  1e100,
  1e300,
  1e-300,
  1e308,
  255,
  256,
  4095,
  65535,
  0.000123,
  123456789,
  1234.5678,
  0.00001,
  5e-7,
  4.35,
  0.05,
  0.005,
  0.0005,
  0.25,
  0.125,
  0.75,
  7,
  10,
  100,
  1000,
  1e15,
  1e16,
  1e17,
  4.5,
  5.5,
  -4.5,
  9.5,
  0.95,
  0.995,
  1.25,
  42,
  -42,
  1e-5,
  2 ** -1022,
  2 ** -1023,
  2 ** -1074 * 3,
  2 ** 1023,
  2 ** 1000 * 1.5,
  1 + 2 ** -52,
  1 - 2 ** -53,
  -1 - 2 ** -52,
  6.02214076e23,
  6.62607015e-34,
  0.30000000000000004,
];

function randomNumbers(seed, count) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = i % 8;
    let x;
    if (k === 0) x = r.bits();
    else if (k === 1) x = (r.float() - 0.5) * 20;
    else if (k === 2) x = r.int(-1e7, 1e7) / 10 ** r.int(0, 6);
    else if (k === 3) x = r.int(-1e6, 1e6) + r.int(0, 15) / 16;
    else if (k === 4) x = (r.bool() ? -1 : 1) * r.float() * 10 ** r.int(-20, 25);
    else if (k === 5) x = (r.bool() ? -1 : 1) * 2 ** r.int(-1074, 1023) * (1 + r.int(0, 3) / 4);
    else if (k === 6) x = r.int(-(2 ** 31) - 10, 2 ** 32 + 10);
    else x = ((r.bool() ? -1 : 1) * (r.int(0, 999999) + 0.5)) / 10 ** r.int(0, 8);
    if (Number.isNaN(x) && !r.bool()) x = r.float();
    out.push(x);
  }
  return out;
}

const numbers = (seed, count) => [...edgeNumbers, ...randomNumbers(seed, count)];

// Strings for StringToNumber / parseFloat / parseInt.
const whitespace = [
  ' ',
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  '　',
  '﻿',
];
const notWhitespace = ['\u0085', '᠎', '​', '\u0000', '\u001f', '\ud800', '\udc00', 'x'];
const fixedStrings = [
  '',
  ' ',
  '   ',
  '\t\n',
  ...whitespace,
  ...notWhitespace.map(c => c + '1'),
  ...whitespace.map(w => w + '12' + w),
  ...notWhitespace.map(c => '1' + c),
  '0',
  '-0',
  '+0',
  '-0.0',
  '00',
  '007',
  '0.0',
  '.0',
  '0.',
  '1',
  '+1',
  '-1',
  '++1',
  '+-1',
  '--1',
  '1.',
  '.5',
  '-.5',
  '+.5',
  '.',
  '+.',
  '-.',
  'e5',
  '1e',
  '1e+',
  '1e-',
  '1e5',
  '1E5',
  '1e+5',
  '1e-5',
  '1.e5',
  '.5e1',
  '1.5e-3',
  '1e1000',
  '-1e1000',
  '1e-1000',
  '1e-400',
  '1e400',
  'Infinity',
  '+Infinity',
  '-Infinity',
  'infinity',
  'INFINITY',
  'Infinityx',
  ' Infinity ',
  'Infinit',
  '-Infinity1',
  'inf',
  'NaN',
  'nan',
  '0x',
  '0x1',
  '0X1F',
  '0xff',
  '0xFfAa',
  '0x1g',
  '0xg',
  '-0x10',
  '+0x10',
  '0x-1',
  ' 0x10 ',
  '0o',
  '0o17',
  '0O17',
  '0o8',
  '0b',
  '0b101',
  '0B11',
  '0b2',
  '-0b1',
  '0x1.5',
  '0x1e2',
  '1_000',
  '1,000',
  '1 000',
  '1n',
  '12abc',
  'abc',
  '0.1.2',
  '1e5.5',
  '1e05',
  '1e+05',
  '١٢',
  '１２',
  '0.0000001',
  '123456789012345678901234567890',
  '9007199254740993',
  '9007199254740995',
  '9007199254740992.5',
  '2.4703282292062327e-324',
  '2.4703282292062328e-324',
  '4.9406564584124654e-324',
  '1.7976931348623157e308',
  '1.7976931348623158e308',
  '1.7976931348623159e308',
  '2.2250738585072011e-308',
  '2.2250738585072012e-308',
  '0x20000000000001',
  '0x20000000000003',
  '0x20000000000002',
  '0x200000000000010',
  '0x200000000000011',
  '0x2000000000000100001',
  '0x1fffffffffffff',
  '0x' + 'f'.repeat(256),
  '0x' + 'f'.repeat(257),
  '0x1' + '0'.repeat(255),
  '0x' + 'f'.repeat(300),
  '0b' + '1'.repeat(54),
  '0b1' + '0'.repeat(52) + '1' + '0'.repeat(10) + '1',
  '0o' + '7'.repeat(30),
  '1' + '0'.repeat(400),
  '0.' + '0'.repeat(400) + '1',
  '0.' + '0'.repeat(330) + '1e330',
  '1' + '0'.repeat(320) + 'e-320',
  '1e' + '9'.repeat(30),
  '1e-' + '9'.repeat(30),
  '0e' + '9'.repeat(30),
  '0'.repeat(500) + '1',
  '123e',
  '123e+',
  '12e3 ',
  '  12e3',
  '-  1',
  '- 1',
  '1 2',
  '0x 1',
  '0 x1',
  '-Infinityx',
  '+-Infinity',
  '1.5x',
  '.e1',
  '-.e1',
  '5.e-1',
  '0.5e+1x',
  '3.14159abc',
  '  -0.0e5  ',
  '1e+5e5',
  '0.1234567890123456789012345678901234567890',
  '1.7976931348623157e+308',
];

function randomStrings(seed, count) {
  const r = rng(seed);
  const frags = [
    () => r.pick(whitespace),
    () => r.pick(notWhitespace),
    () => r.pick(['+', '-']),
    () => String(r.int(0, 999999)),
    () => '0'.repeat(r.int(1, 4)),
    () => '.',
    () => r.pick(['e', 'E']),
    () => r.pick(['e', 'E']) + r.pick(['', '+', '-']) + r.int(0, 400),
    () => r.pick(['0x', '0X', '0o', '0O', '0b', '0B']),
    () => r.pick(['Infinity', 'Inf', 'NaN']),
    () => r.pick(['a', 'f', 'F', 'z', 'Z', 'g', '_', 'n', '9', '7', '1']),
    () => r.int(0, 2 ** 31).toString(r.int(2, 36)),
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = i % 4;
    if (k === 0) {
      let s = '';
      for (let j = r.int(1, 5); j > 0; j--) s += r.pick(frags)();
      out.push(s);
    } else if (k === 1) {
      const x = r.pick(randomNumbers(seed + i, 8));
      const forms = [
        () => String(x),
        () => x.toExponential(r.int(0, 20)),
        () => x.toFixed(r.int(0, 30)),
        () => x.toPrecision(r.int(1, 30)),
        () => (Number.isFinite(x) ? Math.abs(Math.trunc(x)).toString(16) : String(x)),
      ];
      let s = r.pick(forms)();
      if (r.bool()) s = r.pick(whitespace) + s;
      if (r.bool()) s = s + r.pick(whitespace);
      out.push(s);
    } else if (k === 2) {
      // long decimal strings near rounding boundaries
      let s = String(r.int(1, 9));
      for (let j = r.int(15, 40); j > 0; j--) s += String(r.int(0, 9));
      if (r.bool()) s = s.slice(0, r.int(1, s.length - 1)) + '.' + s.slice(r.int(1, s.length - 1));
      if (r.bool()) s += 'e' + r.int(-330, 310);
      out.push(r.bool() ? s : '-' + s);
    } else {
      // long hex strings exercising round-to-even and sticky bits
      let s = '0x' + r.pick(['1', '2', '3', 'f']);
      for (let j = r.int(12, 30); j > 0; j--)
        s += r.pick(['0', '8', 'f', '1', r.int(0, 15).toString(16)]);
      out.push(s);
    }
  }
  return out;
}

function parseIntStrings(seed, count) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const radix = r.int(2, 36);
    const k = i % 4;
    let s;
    if (k === 0) s = r.int(0, 2 ** 31).toString(radix);
    else if (k === 1) {
      // long strings: beyond 2^53 and the 20-significant-digit approximation limit
      s = r.int(1, radix - 1).toString(radix);
      for (let j = r.int(10, 60); j > 0; j--) s += r.int(0, radix - 1).toString(radix);
      if (r.bool()) s = s.toUpperCase();
    } else if (k === 2) {
      s =
        r.pick(['', ' ', '\t', '　', '﻿']) +
        r.pick(['', '+', '-']) +
        r.pick(['', '0x', '0X', '0', '00']) +
        r.int(0, 2 ** 40).toString(r.pick([10, 16, 36])) +
        r.pick(['', 'z', '.5', ' 1', 'e3', 'g', '_1']);
    } else {
      s = r.pick(randomStrings(seed + i, 4));
    }
    out.push(s);
  }
  return out;
}

const radixValues = [
  undefined,
  null,
  0,
  -0,
  1,
  2,
  3,
  7,
  8,
  10,
  11,
  16,
  32,
  35,
  36,
  37,
  -1,
  -16,
  NaN,
  Infinity,
  -Infinity,
  16.9,
  2.5,
  36.99,
  37.5,
  1.99,
  P(32) + 16,
  P(32) + 1,
  -P(32) + 10,
  P(31) + 16,
  4294967312.7,
];

// ---------------------------------------------------------------------------
// Cases

const out = {};
let seed = 1;
const unary = (name, f, xs = numbers(seed++, 400)) => {
  out[name] = xs.map(x => [[num(x)], call(() => f(x))]);
};
const binary = (name, f, pairs) => {
  out[name] = pairs.map(([a, b]) => [[num(a), num(b)], call(() => f(a, b))]);
};
function pairs(seedValue, count, extraB = []) {
  const r = rng(seedValue);
  const a = numbers(seedValue, count);
  const special = [0, -0, NaN, Infinity, -Infinity, 1, -1, 0.5, -0.5, 2, -2, 3, 31, 32, 33, 1e300];
  const res = [];
  for (const x of special) for (const y of special) res.push([x, y]);
  for (const x of a) res.push([x, r.pick(a)]);
  for (const x of a.slice(0, 120)) res.push([x, r.pick([...special, ...extraB])]);
  for (const y of a.slice(0, 120)) res.push([r.pick(special), y]);
  return res;
}

// Existing helpers (regression check).
unary('number_to_string', x => String(x));
binary('min2', (a, b) => Math.min(a, b), pairs(seed++, 150));
binary('max2', (a, b) => Math.max(a, b), pairs(seed++, 150));
binary('same_value', (a, b) => Object.is(a, b), [
  ...pairs(seed++, 100),
  [NaN, NaN],
  [0, -0],
  [-0, -0],
]);

// Conversions.
{
  const strings = [...fixedStrings, ...randomStrings(seed++, 600)];
  out.string_to_number = strings.map(s => [[str(s)], call(() => Number(s))]);
  out.parse_float = strings.map(s => [[str(s)], call(() => parseFloat(s))]);
  const r = rng(seed++);
  const intStrings = [...fixedStrings, ...parseIntStrings(seed++, 700)];
  out.parse_int = [];
  for (const s of intStrings) {
    const radix =
      r.int(0, 3) === 0 ? r.pick(radixValues) : r.pick([undefined, 10, 16, r.int(2, 36)]);
    out.parse_int.push([[str(s), maybe(radix)], call(() => parseInt(s, radix))]);
  }
  // Every radix on long strings (approximation algorithm for non power-of-two radixes).
  const r2 = rng(seed++);
  for (let radix = 2; radix <= 36; radix++) {
    for (let i = 0; i < 12; i++) {
      let s = r2.int(1, radix - 1).toString(radix);
      for (let j = r2.int(5, 80); j > 0; j--) s += r2.int(0, radix - 1).toString(radix);
      out.parse_int.push([[s, num(radix)], call(() => parseInt(s, radix))]);
    }
  }
  for (const radix of radixValues) {
    for (const s of ['0x1f', '1f', 'z', '10', '-0', '  -0x0', '0b11', '777']) {
      out.parse_int.push([[s, maybe(radix)], call(() => parseInt(s, radix))]);
    }
  }
}

unary('is_integer', Number.isInteger);
unary('is_safe_integer', Number.isSafeInteger);
unary('to_int32', x => x | 0, [
  ...numbers(seed++, 400),
  ...randomNumbers(seed++, 200).map(x => x * 2 ** 40),
]);
unary('to_uint32', x => x >>> 0, [
  ...numbers(seed++, 400),
  ...randomNumbers(seed++, 200).map(x => x * 2 ** 40),
]);

// Formatting.
{
  const xs = numbers(seed++, 500);
  const r = rng(seed++);
  const digitArgs = [
    0,
    1,
    2,
    3,
    5,
    10,
    17,
    20,
    25,
    50,
    100,
    101,
    -1,
    -0.5,
    0.9,
    100.9,
    NaN,
    Infinity,
    -Infinity,
    -0,
  ];
  out.to_fixed = [];
  out.to_exponential = [];
  out.to_precision = [];
  out.to_string_radix = [];
  for (const x of xs) {
    for (let k = 0; k < 3; k++) {
      const f = k === 0 ? r.int(0, 20) : r.int(0, 3) === 0 ? r.pick(digitArgs) : r.int(0, 100);
      out.to_fixed.push([[num(x), num(f)], call(() => x.toFixed(f))]);
    }
    for (let k = 0; k < 3; k++) {
      const choice = r.int(0, 5);
      const f =
        choice === 0
          ? undefined
          : choice === 1
            ? r.pick([null, ...digitArgs])
            : r.int(0, choice === 2 ? 100 : 20);
      out.to_exponential.push([[num(x), maybe(f)], call(() => x.toExponential(f))]);
    }
    for (let k = 0; k < 3; k++) {
      const choice = r.int(0, 5);
      const p =
        choice === 0
          ? undefined
          : choice === 1
            ? r.pick([null, ...digitArgs])
            : r.int(1, choice === 2 ? 100 : 21);
      out.to_precision.push([[num(x), maybe(p)], call(() => x.toPrecision(p))]);
    }
    for (let k = 0; k < 2; k++) {
      const radix =
        r.int(0, 6) === 0 ? r.pick([10, 1, 37, 0, NaN, Infinity, 2.9, 36.5, -2, 16]) : r.int(2, 36);
      out.to_string_radix.push([[num(x), num(radix)], call(() => x.toString(radix))]);
    }
  }
  // Rounding ties and carries.
  for (const x of [
    0.5, 1.5, 2.5, -2.5, 0.05, 0.15, 0.25, 0.35, 1.005, 9.995, 99.5, 999.5, 0.0005, 5e-7, 9.5e-7,
  ]) {
    for (const f of [0, 1, 2, 3, 20]) {
      out.to_fixed.push([[num(x), num(f)], call(() => x.toFixed(f))]);
      out.to_exponential.push([[num(x), num(f)], call(() => x.toExponential(f))]);
      if (f > 0) out.to_precision.push([[num(x), num(f)], call(() => x.toPrecision(f))]);
    }
  }
  // Exact powers of two and fractions in every radix.
  for (const x of [
    0.5,
    0.1,
    1 / 3,
    Math.PI,
    255.5,
    -255.5,
    1e21,
    2 ** 60 + 2 ** 10,
    1e-7,
    5e-324,
    1.7976931348623157e308,
    0.999999999999,
  ]) {
    for (let radix = 2; radix <= 36; radix++) {
      out.to_string_radix.push([[num(x), num(radix)], call(() => x.toString(radix))]);
    }
  }
}

// Operators.
binary('pow', (a, b) => a ** b, [
  ...pairs(seed++, 300, [0.5, -0.5, 1 / 3, 1023, 1024, -1074, -1075, 52, 53, 0.1]),
  ...[2, 3, 10, 0.5, -2, 7].flatMap(a =>
    [-1100, -1074, -20, -3, -1, 0, 1, 2, 3, 10, 52, 53, 100, 1023, 1024].map(b => [a, b]),
  ),
]);
binary('rem', (a, b) => a % b, pairs(seed++, 300, [P(53), 1e-300, 0.1, 7, -7, 2 ** -1074]));
const bitPairs = () => pairs(seed++, 250, [32, 33, 63, 64, -1, P(32) + 3, 0.9, -0.9]);
binary('bit_and', (a, b) => a & b, bitPairs());
binary('bit_or', (a, b) => a | b, bitPairs());
binary('bit_xor', (a, b) => a ^ b, bitPairs());
unary('bit_not', a => ~a);
binary('shl', (a, b) => a << b, bitPairs());
binary('shr', (a, b) => a >> b, bitPairs());
binary('ushr', (a, b) => a >>> b, bitPairs());

// Math, exact functions.
unary('math_round', Math.round, [
  ...numbers(seed++, 400),
  -0.5000000000000001,
  -1.5,
  -0.7,
  -1,
  P(52) + 0.5,
  P(52) - 1.5,
  -(P(52) + 1),
  4503599627370495.5,
  -4503599627370495.5,
  0.5 - 2 ** -54,
]);
unary('math_sign', Math.sign);
unary('math_trunc', Math.trunc);
unary('math_floor', Math.floor);
unary('math_ceil', Math.ceil);
unary('math_abs', Math.abs);
unary('math_sqrt', Math.sqrt);
unary('math_clz32', Math.clz32);
unary('math_fround', Math.fround, [
  ...numbers(seed++, 400),
  3.4028234663852886e38,
  3.4028235677973366e38,
  3.402823669209385e38,
  1.401298464324817e-45,
  7.006492321624085e-46,
  7.006492321624087e-46,
  1.1754943508222875e-38,
  16777217,
  16777219,
  1 + 2 ** -24,
  1 + 2 ** -24 + 2 ** -50,
]);
binary('math_imul', Math.imul, pairs(seed++, 300, [P(32) - 1, P(31), 0xffffffff, 65537]));
{
  const r = rng(seed++);
  const xs = numbers(seed++, 150);
  const lists = [
    [],
    [0],
    [-0],
    [NaN],
    [Infinity],
    [-Infinity],
    [0, -0],
    [-0, 0],
    [NaN, Infinity],
    [Infinity, NaN],
    [-Infinity, NaN],
    [NaN, 1],
    [3, 4],
    [1e300, 1e300],
    [1e-300, 1e-300],
    [5e-324, 5e-324],
    [1, 1, 1, 1],
    [3, 4, 12],
    [1.7976931348623157e308, 1.7976931348623157e308],
    [-3],
    [0.1, 0.2, 0.3],
    [-0, -0],
    [1, 2, NaN, 3],
  ];
  for (let i = 0; i < 350; i++) {
    const n = r.int(0, 6);
    lists.push(Array.from({ length: n }, () => r.pick(xs)));
  }
  for (const [name, f] of [
    ['math_hypot', Math.hypot],
    ['math_min', Math.min],
    ['math_max', Math.max],
  ]) {
    out[name] = lists.map(xs => [[xs.map(num)], call(() => f(...xs))]);
  }
}

// Math, transcendental functions (≤ 1 ulp; "exact" cases must match bit for bit).
const exactSpecials = [0, -0, NaN, Infinity, -Infinity];
function transcendental(name, f, exactInputs, domain) {
  const r = rng(seed++);
  const random = randomNumbers(seed++, 250);
  const local = Array.from({ length: 200 }, () => domain(r));
  const cases = [];
  for (const x of [...exactSpecials, ...exactInputs])
    cases.push([[num(x)], call(() => f(x)), 'exact']);
  for (const x of [...edgeNumbers, ...random, ...local]) cases.push([[num(x)], call(() => f(x))]);
  out[name] = cases;
}
const sym = lim => r => (r.float() * 2 - 1) * lim;
const pos = lim => r => r.float() * lim;
transcendental(
  'math_cbrt',
  Math.cbrt,
  [1, -1, 8, -8, 27, 64, 1000, -1e-9, 0.125, 1e15, 2 ** 300, 2 ** -300],
  sym(1e6),
);
transcendental('math_exp', Math.exp, [1000, -1000, 710, -746], sym(50));
transcendental('math_expm1', Math.expm1, [1000, -1000, -50], sym(5));
transcendental('math_log', Math.log, [1, -1, -Infinity], pos(100));
transcendental('math_log1p', Math.log1p, [-1, -2, 5e-324], sym(1));
transcendental('math_log2', Math.log2, [1, 2, 4, 1024, 0.5, 2 ** -1074, 2 ** 1023, -1], pos(1e6));
transcendental('math_log10', Math.log10, [1, 10, 100, 1000, 1e10, 1e22, 0.1, -1], pos(1e6));
transcendental('math_sin', Math.sin, [5e-324, -5e-324], sym(10));
transcendental('math_cos', Math.cos, [], sym(10));
transcendental('math_tan', Math.tan, [5e-324], sym(3));
transcendental('math_asin', Math.asin, [1, -1, 2, -2, 1.0000000000000002], sym(1));
transcendental('math_acos', Math.acos, [1, 2, -2], sym(1));
transcendental('math_atan', Math.atan, [5e-324], sym(10));
transcendental('math_sinh', Math.sinh, [1000, -1000, 5e-324], sym(20));
transcendental('math_cosh', Math.cosh, [1000, -1000], sym(20));
transcendental('math_tanh', Math.tanh, [100, -100, 5e-324], sym(5));
transcendental('math_asinh', Math.asinh, [5e-324, 1e-300], sym(100));
transcendental(
  'math_acosh',
  Math.acosh,
  [1, 0.5, -1, 0.9999999999999999],
  r => 1 + r.float() * 100,
);
transcendental('math_atanh', Math.atanh, [1, -1, 2, -2, 5e-324], sym(1));
{
  // atan2: quadrant and zero rules are exact.
  const specials = [
    0,
    -0,
    1,
    -1,
    Infinity,
    -Infinity,
    NaN,
    5e-324,
    -5e-324,
    1.7976931348623157e308,
  ];
  const cases = [];
  for (const y of specials)
    for (const x of specials) cases.push([[num(y), num(x)], call(() => Math.atan2(y, x)), 'exact']);
  const r = rng(seed++);
  const xs = numbers(seed++, 200);
  for (let i = 0; i < 400; i++) {
    const y = i % 2 ? r.pick(xs) : sym(10)(r);
    const x = i % 2 ? r.pick(xs) : sym(10)(r);
    cases.push([[num(y), num(x)], call(() => Math.atan2(y, x))]);
  }
  out.math_atan2 = cases;
}

// ---------------------------------------------------------------------------

const lines = ['{', `  "node": ${JSON.stringify(process.version)},`, '  "cases": {'];
const names = Object.keys(out);
names.forEach((name, i) => {
  lines.push(`    ${JSON.stringify(name)}: [`);
  const cases = out[name];
  cases.forEach((c, j) =>
    lines.push(`      ${JSON.stringify(c)}${j + 1 < cases.length ? ',' : ''}`),
  );
  lines.push(`    ]${i + 1 < names.length ? ',' : ''}`);
});
lines.push('  }', '}', '');
writeFileSync(join(here, 'number.json'), lines.join('\n'));
console.log(names.map(n => `${n}: ${out[n].length}`).join('\n'));
