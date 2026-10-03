// Generates array.json: Array.prototype, Map and Set behaviour recorded from
// the JavaScript engine running this script (Node). tests/array.rs replays
// every case against runic-js and compares results and receiver post-states.
//
// Run: node crates/runic-js/tests/vectors/array.mjs
//
// Value encoding (lossless, also for NaN, -0 and lone surrogates):
//   number            -> String(x), "-0" for negative zero
//   string            -> {"s": "..."} when well formed, else {"su": [code units]}
//   boolean / null    -> true, false / null
//   undefined         -> {"u": 1}
//   array             -> [...], a hole -> {"hole": 1}
//   original element  -> {"ref": i} (an array identical to input element i)
//   the receiver      -> {"receiver": 1}
//   thrown error      -> {"throw": [name, message]}
// Argument descriptors additionally use {"absent": 1} (argument omitted),
// {"spread": [...]} (an array argument to concat) and {"spread_receiver": 1}.
//
// Callbacks are named; tests/array.rs maps each name to an equivalent Rust
// closure. Comparators are only applied to inputs on which they are
// consistent, because the order is implementation-defined otherwise.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ABSENT = { absent: true };
const ref = i => ({ ref: i });
const spread = items => ({ spread: items });
const SPREAD_SELF = { spreadSelf: true };

function enc(v, orig = []) {
  if (v === undefined) return { u: 1 };
  if (v === null) return null;
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    return v.isWellFormed()
      ? { s: v }
      : { su: Array.from({ length: v.length }, (_, i) => v.charCodeAt(i)) };
  }
  if (Array.isArray(v)) {
    const i = orig.indexOf(v);
    if (i >= 0) return { ref: i };
    const out = [];
    for (let k = 0; k < v.length; k++) out.push(k in v ? enc(v[k], orig) : { hole: 1 });
    return out;
  }
  throw new Error(`cannot encode ${v}`);
}

function encArg(a, orig) {
  if (a === ABSENT) return { absent: 1 };
  if (a === SPREAD_SELF) return { spread_receiver: 1 };
  if (a && typeof a === 'object' && 'ref' in a) return { ref: a.ref };
  if (a && typeof a === 'object' && 'spread' in a)
    return { spread: a.spread.map(x => encArg(x, orig)) };
  return enc(a, orig);
}

function resolveArg(a, orig, receiver) {
  if (a === ABSENT) return undefined;
  if (a === SPREAD_SELF) return receiver;
  if (a && typeof a === 'object' && 'ref' in a) return orig[a.ref];
  if (a && typeof a === 'object' && 'spread' in a)
    return a.spread.map(x => resolveArg(x, orig, receiver));
  if (Array.isArray(a)) return a.slice(); // a fresh array value (nested element type)
  return a;
}

function encResult(r, orig, receiver) {
  return r === receiver ? { receiver: 1 } : enc(r, orig);
}

function encThrow(e) {
  return { throw: [e.name, e.message] };
}

// Inputs --------------------------------------------------------------------------

/** Element type -> input arrays (copied fresh for each case). */
const INPUTS = {
  num: [
    [],
    [1],
    [1, 2, 3],
    [3, 1, 2, 10, 20, 1],
    [NaN, 0, -0, 1, NaN],
    [-1, -0, 0, Infinity, -Infinity, 2],
    [5, 4, 3, 2, 1, 0],
    [1.5, 2.5, 1e21, 1e-7, -3, 3],
  ],
  str: [
    [],
    ['a'],
    ['b', 'a', 'c'],
    ['10', '9', '1', '', 'A', 'a'],
    ['\u{1F600}', '\uD83D', '\uDE00', '￿', 'z', 'é'],
    ['x', 'x', 'y', 'x'],
  ],
  mnum: [
    [],
    [undefined],
    [null],
    [3, null, undefined, 1, NaN, -0, undefined, 0],
    [undefined, 2, null, 10, null],
  ],
  mstr: [[], ['o', null, 'a', undefined, 'nz', 'nul', 'null', '', undefined]],
  bool: [[], [true, false, true, false]],
  nested: [[], [[1, 2], [3], [], [1, 2]], [[10], [9], [1, 1], [2], []]],
};

/** A value of each element type (for set, push, fill, with, ...). */
const SAMPLE = { num: 7, str: 'q', mnum: null, mstr: undefined, bool: false, nested: [7] };
const SAMPLE2 = { num: 8, str: '\uD800', mnum: 8, mstr: 'r', bool: true, nested: [] };

/** Search values per type (indexOf, lastIndexOf, includes). */
const SEARCH = {
  num: [1, 2, 3, NaN, 0, -0, 100],
  str: ['a', 'x', '', '\uD83D', '\u{1F600}'],
  mnum: [null, undefined, NaN, 0, 2],
  mstr: [null, undefined, '', 'nul'],
  bool: [true, false],
  nested: [ref(0), ref(3), [1, 2]],
};

const REL = [ABSENT, 0, 1, -1, -2, 2, 10, -10, NaN, 1.5, -1.5, Infinity, -Infinity, null, -0];
const REL_SMALL = [ABSENT, 1, -1];
const END = [ABSENT, 1, -1, 3, 10, -10, NaN, Infinity, null];
const FROM = [ABSENT, 1, -1, -10, 10, NaN, Infinity, -Infinity, 1.5, null];
const INDEX = [
  0,
  1,
  2,
  -1,
  -2,
  1.5,
  -1.5,
  NaN,
  10,
  -10,
  -0,
  Infinity,
  -Infinity,
  4294967295,
  4294967294,
];

// Callbacks -------------------------------------------------------------------------

/** Predicates (find, findIndex, findLast, findLastIndex, some, every, filter). */
const PREDICATES = {
  idx_odd: () => (x, i) => i % 2 === 1,
  never: () => () => false,
  always: () => () => true,
  throw_at_1: () => (x, i) => {
    if (i === 1) throw new RangeError('boom');
    return false;
  },
  // Mutating callbacks (only for methods that copy elements, see array_ops.rs).
  push_at_0: type => (x, i, arr) => {
    if (i === 0) arr.push(resolveArg(SAMPLE[type], [], arr));
    return i % 2 === 0 && i > 0;
  },
  pop_each: () => (x, i, arr) => {
    arr.pop();
    return true;
  },
};
const TYPE_PREDICATES = {
  num: { gt2: x => x > 2, even: x => x % 2 === 0, is_nan: x => x !== x, truthy: x => x },
  str: { long: x => x.length > 1, empty: x => x.length === 0, truthy: x => x },
  mnum: { nullish: x => x == null, truthy: x => x, is_null: x => x === null },
  mstr: { nullish: x => x == null, truthy: x => x },
  bool: { id: x => x, not: x => !x },
  nested: { nonempty: x => x.length > 0, first_gt1: x => x[0] > 1 },
};
const MUTATING = new Set(['push_at_0', 'pop_each', 'clobber']);

/** map callbacks. */
const MAPPERS = {
  num: {
    double: x => x * 2,
    neg: x => -x,
    plus_i: (x, i) => x + i,
    to_str: x => String(x),
    throw_at_1: (x, i) => {
      if (i === 1) throw new RangeError('boom');
      return x;
    },
  },
  str: { bang: x => x + '!', len: x => x.length },
  mnum: { or_zero: x => x ?? 0, is_null: x => x === null },
  mstr: { or_empty: x => x ?? '' },
  bool: { not: x => !x },
  nested: { len: x => x.length, first: x => x[0], same: x => x },
};

/** flatMap callbacks. */
const FLAT_MAPPERS = {
  num: { dup: x => [x, x], keep_even: x => (x % 2 === 0 ? [x] : []), idx: (x, i) => [i] },
  str: { dup: x => [x, x] },
  mnum: { dup: x => [x, x] },
  nested: { same: x => x, dup: x => [x, x] },
};

/** reduce / reduceRight callbacks with their initial value. */
const REDUCERS = {
  num: {
    sum: [(acc, x) => acc + x, 0],
    sub: [(acc, x) => acc - x, 100],
    digits: [(acc, x, i) => acc * 10 + i, 0],
    cat_str: [(acc, x) => acc + String(x) + ';', ''],
    throw_at_1: [
      (acc, x, i) => {
        if (i === 1) throw new RangeError('boom');
        return acc;
      },
      0,
    ],
  },
  str: { cat: [(acc, x) => acc + x, '<'], lensum: [(acc, x) => acc + x.length, 0] },
  mnum: { count_null: [(acc, x) => acc + (x === null ? 1 : 0), 0] },
  mstr: { cat_nullish: [(acc, x) => acc + String(x) + '|', ''] },
  bool: { count_true: [(acc, x) => acc + (x ? 1 : 0), 0] },
  nested: { total: [(acc, x) => acc + x.length, 0] },
};

/** reduce without an initial value. */
const FIRST_REDUCERS = {
  num: {
    sum: (acc, x) => acc + x,
    sub: (acc, x) => acc - x,
    max: (acc, x) => Math.max(acc, x),
    throw_at_1: (acc, x, i) => {
      if (i === 1) throw new RangeError('boom');
      return acc;
    },
    push_at_1: (acc, x, i, arr) => {
      if (i === 1) arr.push(100);
      return acc + x;
    },
  },
  str: { cat: (acc, x) => acc + x },
  mnum: { first_nonnull: (acc, x) => acc ?? x },
  mstr: { first_nonnull: (acc, x) => acc ?? x },
  bool: { and: (acc, x) => acc && x },
  nested: { longer: (acc, x) => (x.length > acc.length ? x : acc) },
};

const noNaN = a => a.every(x => x === x);
const allFinite = a => a.every(x => Number.isFinite(x));
/** Comparators: [factory(receiver), applicable(input)]. */
const COMPARATORS = {
  num: {
    asc: [() => (a, b) => a - b, noNaN],
    desc: [() => (a, b) => b - a, noNaN],
    nan: [() => () => NaN, () => true],
    zero: [() => () => 0, () => true],
    mod3: [() => (a, b) => (a % 3) - (b % 3), allFinite],
    throws_on_3: [
      () => (a, b) => {
        if (a === 3 || b === 3) throw new TypeError('three');
        return a - b;
      },
      a => noNaN(a) && a.includes(3) && a.length > 1,
    ],
    clobber: [
      arr => (a, b) => {
        arr[0] = -999;
        return a - b;
      },
      a => noNaN(a) && a.length > 1,
    ],
    reads: [arr => (a, b) => (a - b) * (arr.length > 0 ? 1 : -1), noNaN],
  },
  str: {
    cu: [() => (a, b) => (a < b ? -1 : a > b ? 1 : 0), () => true],
    rev_cu: [() => (a, b) => (a < b ? 1 : a > b ? -1 : 0), () => true],
    by_len: [() => (a, b) => a.length - b.length, () => true],
  },
  mnum: {
    nulls_first: [() => (a, b) => (a === null ? 0 : 1) - (b === null ? 0 : 1), () => true],
    desc_null_low: [() => (a, b) => (b ?? -1) - (a ?? -1), a => noNaN(a.filter(x => x != null))],
  },
  mstr: {
    cu_string: [
      () => (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
      () => true,
    ],
  },
  bool: { false_first: [() => (a, b) => (a ? 1 : 0) - (b ? 1 : 0), () => true] },
  nested: {
    by_len: [() => (a, b) => a.length - b.length, () => true],
    by_first: [() => (a, b) => (a[0] ?? 0) - (b[0] ?? 0), () => true],
  },
};

// Case generation -------------------------------------------------------------------

const cases = [];

/**
 * Runs `method` on a fresh copy of input `n` of `type`, recording the result
 * (or the thrown error) and the receiver's post-state.
 */
function record(type, n, op, args, run, extra = {}) {
  const input = INPUTS[type][n].map(x => (Array.isArray(x) ? x.slice() : x));
  const orig = input.slice();
  const receiver = input;
  const resolved = args.map(a => resolveArg(a, orig, receiver));
  let result;
  try {
    result = encResult(run(receiver, resolved), orig, receiver);
  } catch (e) {
    result = encThrow(e);
  }
  cases.push({
    id: cases.length,
    type,
    input: n,
    op,
    args: args.map(a => encArg(a, orig)),
    ...extra,
    result,
    after: enc(receiver, orig),
  });
}

function trimAbsent(args) {
  const out = args.slice();
  while (out.length > 0 && out[out.length - 1] === ABSENT) out.pop();
  return out;
}
function call(type, n, op, name, args, extra) {
  const trimmed = trimAbsent(args);
  record(type, n, op, args, (r, resolved) => r[name](...resolved.slice(0, trimmed.length)), extra);
}

const TYPES = Object.keys(INPUTS);
const inputsOf = type => INPUTS[type].map((_, n) => n);

for (const type of TYPES) {
  const all = inputsOf(type);
  for (const n of all) {
    const len = INPUTS[type][n].length;
    // Full argument grids: index arithmetic on lengths 0, 3 and 6; searches
    // on inputs with duplicates, NaN, -0 and infinities.
    const full = type === 'num' && [0, 2, 6].includes(n);
    const searchFull = type === 'num' && [2, 3, 4, 5].includes(n);
    for (const sep of [ABSENT, ',', '', ' - ', null, '\uD83D'])
      call(type, n, 'join', 'join', [sep]);
    for (const i of type === 'num' ? INDEX : [0, 1, -1, 1.5, 10, -0]) {
      record(type, n, 'get', [i], r => r[i]);
      call(type, n, 'at', 'at', [i]);
    }
    for (const i of [...new Set([0, len - 1, len, len + 1, -1, 1.5, -0, NaN, 4294967295])]) {
      record(type, n, 'set', [i, SAMPLE[type]], (r, [idx, v]) => {
        r[idx] = v;
        return undefined;
      });
    }
    for (const items of [[], [SAMPLE[type]], [SAMPLE[type], SAMPLE2[type]]]) {
      call(type, n, 'push', 'push', items);
      call(type, n, 'unshift', 'unshift', items);
    }
    for (const op of ['pop', 'shift', 'reverse']) call(type, n, op, op, []);
    call(type, n, 'to_reversed', 'toReversed', []);
    for (const start of full ? REL : REL_SMALL) {
      for (const end of full ? END : REL_SMALL) call(type, n, 'slice', 'slice', [start, end]);
    }
    if (type !== 'num' || full) {
      const starts = full ? [0, 1, -1, -2, 10, -10, NaN, 1.5, -Infinity, -0] : [1, -1];
      const counts = full ? [ABSENT, 0, 1, 2, 10, -1, NaN, null, 1.5] : [ABSENT, 1];
      for (const start of starts) {
        for (const count of counts) {
          const many = full ? [SAMPLE[type], SAMPLE2[type], SAMPLE[type]] : [SAMPLE[type]];
          const itemSets = count === ABSENT ? [[]] : [[], many];
          for (const items of itemSets) call(type, n, 'splice', 'splice', [start, count, ...items]);
        }
      }
    }
    const concatArgs = [
      [],
      [spread([])],
      [spread([SAMPLE[type], SAMPLE2[type]])],
      [SPREAD_SELF],
      [spread([SAMPLE[type]]), SPREAD_SELF, spread([SAMPLE2[type]])],
    ];
    if (type !== 'nested')
      concatArgs.push([SAMPLE[type]], [SAMPLE[type], spread([SAMPLE2[type]]), SAMPLE2[type]]);
    for (const args of concatArgs) call(type, n, 'concat', 'concat', args);
    // References must name an element of this input.
    for (const v of SEARCH[type].filter(
      v => !(v && typeof v === 'object' && 'ref' in v) || v.ref < len,
    )) {
      for (const from of searchFull ? FROM : [ABSENT, 1, -1]) {
        call(type, n, 'index_of', 'indexOf', [v, from]);
        call(type, n, 'last_index_of', 'lastIndexOf', [v, from]);
        call(type, n, 'includes', 'includes', [v, from]);
      }
    }
    for (const start of full ? REL : REL_SMALL) {
      for (const end of full ? [ABSENT, 2, -1, 10, NaN, -10, null] : [ABSENT, -1]) {
        call(type, n, 'fill', 'fill', [SAMPLE[type], start, end]);
      }
    }
    for (const i of type === 'num' ? INDEX : [0, -1, 1, 10, NaN])
      call(type, n, 'with', 'with', [i, SAMPLE[type]]);
    if (type === 'nested') call(type, n, 'flat', 'flat', []);

    // Callbacks.
    const preds = {
      ...Object.fromEntries(Object.keys(PREDICATES).map(k => [k, PREDICATES[k](type)])),
    };
    for (const [k, f] of Object.entries(TYPE_PREDICATES[type])) preds[k] = f;
    const predOps = [
      ['find', 'find', true],
      ['find_index', 'findIndex', false],
      ['find_last', 'findLast', true],
      ['find_last_index', 'findLastIndex', false],
      ['some', 'some', false],
      ['every', 'every', false],
      ['filter', 'filter', true],
    ];
    for (const [op, name, copies] of predOps) {
      for (const [cb, f] of Object.entries(preds)) {
        if (MUTATING.has(cb) && !copies) continue;
        // find visits removed indices with undefined (documented deviation).
        if (cb === 'pop_each' && op === 'find') continue;
        record(type, n, op, [], r => r[name](f), { cb });
      }
    }
    for (const [cb, f] of Object.entries(MAPPERS[type] ?? {}))
      record(type, n, 'map', [], r => r.map(f), { cb });
    for (const [cb, f] of Object.entries(FLAT_MAPPERS[type] ?? {})) {
      record(type, n, 'flat_map', [], r => r.flatMap(f), { cb });
    }
    for (const cb of ['log', 'throw_at_1']) {
      record(
        type,
        n,
        'for_each',
        [],
        r => {
          const log = [];
          r.forEach((x, i) => {
            if (cb === 'throw_at_1' && i === 1) throw new RangeError('boom');
            log.push([x, i]);
          });
          return log;
        },
        { cb },
      );
    }
    for (const [cb, [f, init]] of Object.entries(REDUCERS[type] ?? {})) {
      record(type, n, 'reduce', [init], r => r.reduce(f, init), { cb });
      record(type, n, 'reduce_right', [init], r => r.reduceRight(f, init), { cb });
    }
    for (const [cb, f] of Object.entries(FIRST_REDUCERS[type] ?? {})) {
      record(type, n, 'reduce_first', [], r => r.reduce(f), { cb });
    }
    call(type, n, 'sort', 'sort', []);
    call(type, n, 'to_sorted', 'toSorted', []);
    for (const [cb, [make, applicable]] of Object.entries(COMPARATORS[type] ?? {})) {
      if (!applicable(INPUTS[type][n])) continue;
      record(type, n, 'sort', [], r => r.sort(make(r)), { cb });
      record(type, n, 'to_sorted', [], r => r.toSorted(make(r)), { cb });
    }
  }
}

// Map and Set -------------------------------------------------------------------------

/** Keys of each key type; `ref` keys are arrays from a pool, by identity. */
const POOL = [[0], [0], [1]];
const collections = [];

function replay(kind, ktype, init, steps, extra = {}) {
  const coll = kind === 'map' ? new Map(init) : new Set(init);
  const results = steps.map(([op, ...args]) => {
    const r = op === 'size' ? coll.size : coll[op](...args);
    if (op === 'keys' || op === 'values') return enc([...r], POOL);
    return r === coll ? { receiver: 1 } : enc(r, POOL);
  });
  collections.push({
    id: collections.length,
    kind,
    ktype,
    init:
      kind === 'map'
        ? init.map(([k, v]) => [enc(k, POOL), enc(v, POOL)])
        : init.map(k => enc(k, POOL)),
    steps: steps.map(([op, ...args]) => [op, ...args.map(a => enc(a, POOL))]),
    ...extra,
    results,
  });
}

const all = kind => (kind === 'map' ? [['size'], ['keys'], ['values']] : [['size'], ['values']]);
const mapAll = all('map');
const setAll = all('set');

replay(
  'map',
  'num',
  [],
  [['get', 1], ['has', 1], ['delete', 1], ['size'], ['keys'], ['clear'], ['size']],
);
replay(
  'map',
  'num',
  [
    [1, 10],
    [2, 20],
    [1, 11],
  ],
  [...mapAll, ['get', 1], ['get', 3]],
);
replay(
  'map',
  'num',
  [
    [NaN, 1],
    [0, 2],
  ],
  [
    ['get', NaN],
    ['has', -0],
    ['get', -0],
    ['set', -0, 3],
    ['set', 5, 4],
    ['set', NaN, 5],
    ...mapAll,
    ['delete', 0],
    ['delete', 0],
    ...mapAll,
    ['set', 0, 6],
    ...mapAll,
  ],
);
replay(
  'map',
  'num',
  [],
  [
    ['set', 3, 1],
    ['set', 1, 2],
    ['set', 2, 3],
    ['delete', 1],
    ['set', 1, 4],
    ['set', 3, 5],
    ...mapAll,
    ['clear'],
    ...mapAll,
    ['clear'],
    ['set', 9, 9],
    ...mapAll,
  ],
);
replay('map', 'num', [[-0, 1]], [...mapAll, ['has', 0]], { deviation: 'negzero-key' });
replay(
  'map',
  'str',
  [
    ['a', 1],
    ['b', 2],
    ['\uD83D', 3],
    ['', 4],
  ],
  [
    ['get', 'a'],
    ['get', '\uD83D'],
    ['get', '😀'],
    ['has', ''],
    ['delete', 'b'],
    ['set', 'b', 5],
    ['set', 'a', 6],
    ...mapAll,
  ],
);
replay(
  'map',
  'ref',
  [
    [POOL[0], 1],
    [POOL[1], 2],
  ],
  [
    ['get', POOL[0]],
    ['get', POOL[1]],
    ['get', POOL[2]],
    ['set', POOL[2], 3],
    ['delete', POOL[0]],
    ['set', POOL[0], 4],
    ...mapAll,
  ],
);
replay(
  'set',
  'num',
  [3, 1, NaN, 3, NaN, 0, -0, 2],
  [
    ...setAll,
    ['has', NaN],
    ['has', -0],
    ['add', 1],
    ['add', 4],
    ['delete', 3],
    ['delete', 3],
    ['add', 3],
    ...setAll,
    ['clear'],
    ...setAll,
    ['add', 5],
    ...setAll,
  ],
);
replay('set', 'num', [-0], [...setAll, ['has', 0], ['add', 0], ...setAll], {
  deviation: 'negzero-key',
});
replay('set', 'num', [], [['has', 1], ['delete', 1], ['clear'], ...setAll]);
replay(
  'set',
  'str',
  ['b', 'a', 'b', '\uDE00', ''],
  [
    ...setAll,
    ['has', '\uDE00'],
    ['has', 'c'],
    ['delete', 'b'],
    ['add', 'b'],
    ['add', 'a'],
    ...setAll,
  ],
);
replay(
  'set',
  'ref',
  [POOL[0], POOL[1], POOL[0]],
  [...setAll, ['has', POOL[2]], ['add', POOL[2]], ['delete', POOL[0]], ...setAll],
);

const out = join(dirname(fileURLToPath(import.meta.url)), 'array.json');
// One case per line keeps the committed file diffable.
const lines = items => items.map(c => JSON.stringify(c)).join(',\n');
const inputs = Object.fromEntries(
  Object.entries(INPUTS).map(([t, list]) => [t, list.map(a => enc(a))]),
);
writeFileSync(
  out,
  `{"generator": "crates/runic-js/tests/vectors/array.mjs", "node": ${JSON.stringify(process.version)},
"inputs": ${JSON.stringify(inputs)},
"pool": ${JSON.stringify(POOL.map(a => enc(a)))},
"cases": [
${lines(cases)}
],
"collections": [
${lines(collections)}
]}
`,
);
console.log(
  `wrote ${cases.length} array cases and ${collections.length} collection cases to ${out}`,
);
