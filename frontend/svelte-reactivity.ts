// `SvelteMap` (svelte/reactivity), as bits-ui's Tabs uses it
// (docs/design/M6-LIBRARIES.md, "Svelte library features"): a Map whose
// reads are dependencies of the running effect, derived value or template.
//
// A SvelteMap of K to V is a class record of its own with one `raw`
// reactive field holding the map. Reads (`get`, `has`, `size`) read the
// field, so they depend on it; writes that change the map (`set` of a new
// key or a different value, `delete` of a present key, `clear` of a
// non-empty map) store a new map (a copy with the change: the map is never
// changed in place), which notifies. Svelte tracks keys one by one (a `set` of one key does not
// notify readers of another), so this notifies a superset of Svelte's
// readers: derived values and template bindings recompute and keep equal
// results, which is not observable (a derived value read by an effect
// notifies it only when its result changed); an effect reading a key or the
// size itself would run where Svelte's does not, so such a read made while a
// tracked effect runs (not in a derived value it reads) is reported at run
// time (`reactive.keyed-read`). Reads elsewhere (handlers, initialisation,
// untracked callbacks) depend on nothing and are exact.
//
// Iteration by `values()`, `entries()` and for-of (M6 overlays: bits-ui's
// scroll lock) reads every entry in Svelte too (its version and each key's
// source), so it depends on any change, as here: it is exact anywhere, also
// in effects.
//
// Rejected: constructor entries, `keys` (Svelte tracks only additions and
// removals there), `forEach`, spreads, `getOrInsert*`.
import ts from 'typescript';
import type { Expr, Fn, Source, Stmt, Type } from './ir.ts';
import type { Lowerer } from './language.ts';

const local = (i: number): Expr => ({ op: 'local', local: i });
const get = (object: Expr, field: number): Expr => ({ op: 'get', object, field });

/** SvelteMap records by key and value type, per program. */
const records = new WeakMap<Lowerer, Map<string, number>>();

/** Checks an import from svelte/reactivity: SvelteMap only (by name). */
export function svelteReactivityImport(
  stmt: ts.ImportDeclaration,
  fail: (n: ts.Node, code: string, message: string) => never,
): void {
  const clause = stmt.importClause;
  const named = clause?.namedBindings;
  if (!clause || clause.name || !named || !ts.isNamedImports(named))
    fail(stmt, 'E_CAPABILITY', 'Import SvelteMap from svelte/reactivity by name');
  for (const el of (named as ts.NamedImports).elements)
    if ((el.propertyName ?? el.name).text !== 'SvelteMap')
      fail(
        el,
        'E_CAPABILITY',
        `svelte/reactivity's ${(el.propertyName ?? el.name).text} is not covered (SvelteMap is)`,
      );
}

/** Whether `t` is svelte/reactivity's SvelteMap. */
function isSvelteMap(t: ts.Type): boolean {
  const sym = t.getSymbol();
  if (sym?.name !== 'SvelteMap') return false;
  const file = sym.declarations?.[0]?.getSourceFile().fileName ?? '';
  return /[\\/]node_modules[\\/]svelte[\\/]/.test(file);
}

/** The IR type of a SvelteMap type (TypeMapper hook), if `t` is one. */
export function svelteMapType(t: ts.Type, at: ts.Node, lower: Lowerer): Type | undefined {
  if (!isSvelteMap(t)) return undefined;
  const [k, v] = lower.checker.getTypeArguments(t as ts.TypeReference);
  if (!k || !v) return lower.fail(at, 'E_CLASS', 'SvelteMap needs its key and value types');
  return { record: svelteMapRecord(lower, lower.types.map(k, at), lower.types.map(v, at)) };
}

/** A function of the program: its index. */
function define(lower: Lowerer, f: Fn): number {
  const index = lower.reserve();
  lower.functions[index] = f;
  return index;
}

/** The record of SvelteMaps from `k` to `v`, created with its members. */
function svelteMapRecord(lower: Lowerer, k: Type, v: Type): number {
  let known = records.get(lower);
  if (!known) records.set(lower, (known = new Map()));
  const key = JSON.stringify([k, v]);
  const found = known.get(key);
  if (found !== undefined) return found;
  const record = lower.types.records.length;
  known.set(key, record);
  const self: Type = { record };
  const map: Type = { map: [k, v] };
  lower.types.records.push({
    name: 'ReactiveMap',
    class: true,
    fields: [{ name: 'map', type: map, reactive: 'raw' }],
  });
  const builtin = (name: string, args: Expr[], type: Type): Expr => ({
    op: 'builtin',
    name: `map.${name}`,
    args,
    type,
  });
  /** A read of the map (a dependency) and `value` of it (local 1 + params). */
  const reader = (
    name: string,
    params: { name: string; type: Type }[],
    result: Type,
    value: (m: Expr) => Expr,
  ) => {
    const f = define(lower, {
      name: `ReactiveMap.${name}`,
      params: [{ name: 'this', type: self }, ...params],
      locals: [],
      result,
      body: [
        // (Reported where a tracked effect reads a key or the size.)
        {
          op: 'expr',
          value: { op: 'builtin', name: 'reactive.keyed-read', args: [], type: 'void' },
        },
        { op: 'return', value: value(get(local(0), 0)) },
      ],
    });
    return f;
  };
  const getFn = reader('get', [{ name: 'key', type: k }], { maybe: v }, m =>
    builtin('get', [m, local(1)], { maybe: v }),
  );
  const hasFn = reader('has', [{ name: 'key', type: k }], 'boolean', m =>
    builtin('has', [m, local(1)], 'boolean'),
  );
  const sizeFn = reader('size', [], 'number', m => builtin('size', [m], 'number'));
  /**
   * Statements replacing the map (local 0's) by a copy of it without `skip`
   * (a key local, or none), in locals `copy` (the new map) and `each` (a
   * key), then running `then` before the copy is stored.
   */
  const replace = (copy: number, each: number, skip: number | undefined, then: Stmt[]): Stmt[] => [
    { op: 'let', local: copy, value: builtin('new', [], map) },
    {
      op: 'for-of',
      local: each,
      iterable: builtin('keys', [get(local(0), 0)], { array: k }),
      body: [
        ...(skip === undefined
          ? []
          : [
              {
                op: 'if',
                test: { op: 'eq', left: local(each), right: local(skip) },
                then: [{ op: 'continue' }],
              } as Stmt,
            ]),
        {
          op: 'expr',
          value: builtin(
            'set',
            [
              local(copy),
              local(each),
              {
                op: 'unwrap',
                value: builtin('get', [get(local(0), 0), local(each)], { maybe: v }),
              },
            ],
            map,
          ),
        },
      ],
    },
    ...then,
    {
      op: 'assign',
      target: { place: 'field', object: local(0), field: 0 },
      value: local(copy),
    },
  ];
  // Map.new is spelled `Map.new`, not `map.new`.
  const fixNew = (stmts: Stmt[]): Stmt[] =>
    JSON.parse(JSON.stringify(stmts).replaceAll('"name":"map.new"', '"name":"Map.new"'));
  // set(key, value): a new key or a different value replaces the map (so it
  // notifies, the map being a raw reactive field); returns the SvelteMap.
  const setFn = define(lower, {
    name: 'ReactiveMap.set',
    params: [
      { name: 'this', type: self },
      { name: 'key', type: k },
      { name: 'value', type: v },
    ],
    locals: [
      { name: 'copy', type: map },
      { name: 'each', type: k },
    ],
    result: self,
    body: [
      {
        op: 'if',
        test: {
          op: 'or',
          left: { op: 'not', arg: builtin('has', [get(local(0), 0), local(1)], 'boolean') },
          right: {
            op: 'ne',
            left: builtin('get', [get(local(0), 0), local(1)], { maybe: v }),
            right: { op: 'some', value: local(2) },
          },
        },
        then: fixNew(
          replace(3, 4, undefined, [
            { op: 'expr', value: builtin('set', [local(3), local(1), local(2)], map) },
          ]),
        ),
      },
      { op: 'return', value: local(0) },
    ],
  });
  // delete(key): a present key replaces the map without it.
  const deleteFn = define(lower, {
    name: 'ReactiveMap.delete',
    params: [
      { name: 'this', type: self },
      { name: 'key', type: k },
    ],
    locals: [
      { name: 'copy', type: map },
      { name: 'each', type: k },
    ],
    result: 'boolean',
    body: [
      {
        op: 'if',
        test: builtin('has', [get(local(0), 0), local(1)], 'boolean'),
        then: [
          ...fixNew(replace(2, 3, 1, [])),
          { op: 'return', value: { op: 'lit', value: true } },
        ],
      },
      { op: 'return', value: { op: 'lit', value: false } },
    ],
  });
  // clear(): a non-empty map is replaced by an empty one.
  const clearFn = define(lower, {
    name: 'ReactiveMap.clear',
    params: [{ name: 'this', type: self }],
    locals: [],
    result: 'void',
    body: [
      {
        op: 'if',
        test: {
          op: 'gt',
          left: builtin('size', [get(local(0), 0)], 'number'),
          right: { op: 'lit', value: 0 },
        },
        then: [
          {
            op: 'assign',
            target: { place: 'field', object: local(0), field: 0 },
            value: { op: 'builtin', name: 'Map.new', args: [], type: map },
          },
        ],
      },
    ],
  });
  // Iteration (not a checked reader: exact anywhere, see the header).
  const entry = lower.types.tupleRecord([k, v]);
  const valuesFn = define(lower, {
    name: 'ReactiveMap.values',
    params: [{ name: 'this', type: self }],
    locals: [],
    result: { array: v },
    body: [{ op: 'return', value: builtin('values', [get(local(0), 0)], { array: v }) }],
  });
  const entriesFn = define(lower, {
    name: 'ReactiveMap.entries',
    params: [{ name: 'this', type: self }],
    locals: [],
    result: { array: { record: entry } },
    body: [
      {
        op: 'return',
        value: builtin('entries', [get(local(0), 0)], { array: { record: entry } }),
      },
    ],
  });
  let iterators = iteration.get(lower);
  if (!iterators) iteration.set(lower, (iterators = new Map()));
  iterators.set(record, entriesFn);
  const methods: Record<string, number> = {
    values: valuesFn,
    entries: entriesFn,
    get: getFn,
    has: hasFn,
    set: setFn,
    delete: deleteFn,
    clear: clearFn,
  };
  const label = 'SvelteMap (svelte/reactivity)';
  lower.recordMembers.set(record, {
    read(name, object, at) {
      if (name !== 'size')
        return lower.fail(
          at,
          'E_MEMBER',
          `${label}: ${name} is not covered (get, has, set, delete, clear, size)`,
        );
      const call: Expr = { op: 'call', function: sizeFn, args: [object] };
      return call;
    },
    write(name, _object, _value, at) {
      return lower.fail(at, 'E_MEMBER', `${label}: ${name} cannot be assigned`);
    },
    call(name, object, node, b) {
      const fn = methods[name];
      if (fn === undefined)
        return lower.fail(
          node,
          'E_MEMBER',
          `${label}: ${name}() is not covered (get, has, set, delete, clear, size)`,
        );
      const want = lower.functions[fn].params.slice(1).map(p => p.type);
      if (node.arguments.length !== want.length)
        return lower.fail(node, 'E_CALL', `${label}: ${name} takes ${want.length} arguments`);
      const call: Expr = {
        op: 'call',
        function: fn,
        args: [object, ...node.arguments.map((a, i) => lower.coerce(a, b, want[i]))],
      };
      return call;
    },
  });
  return record;
}

const iteration = new WeakMap<Lowerer, Map<number, number>>();

/** for-of over a SvelteMap of record `t`: its entries (undefined for other types). */
export function svelteMapEntries(lower: Lowerer, t: Type, object: Expr): Expr | undefined {
  const fn =
    typeof t === 'object' && 'record' in t ? iteration.get(lower)?.get(t.record) : undefined;
  return fn === undefined ? undefined : { op: 'call', function: fn, args: [object] };
}

/** `new SvelteMap()`: an empty map (constructor entries are not covered). */
export function newSvelteMap(e: ts.NewExpression, lower: Lowerer): Expr | undefined {
  const t = lower.checker.getTypeAtLocation(e);
  if (!isSvelteMap(t)) return undefined;
  if (e.arguments?.length)
    return lower.fail(e, 'E_NEW', 'new SvelteMap() is covered without initial entries');
  const type = lower.types.of(e);
  if (typeof type !== 'object' || !('record' in type))
    return lower.fail(e, 'E_NEW', 'SvelteMap without a record type');
  const map = lower.types.records[type.record].fields[0].type;
  return {
    op: 'record',
    record: type.record,
    fields: [{ op: 'builtin', name: 'Map.new', args: [], type: map }],
  };
}
