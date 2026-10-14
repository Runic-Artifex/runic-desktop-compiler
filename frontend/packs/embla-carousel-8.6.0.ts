// Mapping pack entry for a helper inside embla-carousel 8.6.0, which is
// compiled from source (frontend/sources.ts; docs/design/M6-SCRIPT-DOM.md,
// slice 4). Every options merge of the carousel and its plugins goes through
// `objectsMergeDeep` (esm/embla-carousel.esm.js):
//
//   function objectsMergeDeep(objectA, objectB) {
//     return [objectA, objectB].reduce((mergedObjects, currentObject) => {
//       objectKeys(currentObject).forEach(key => {
//         const valueA = mergedObjects[key];
//         const valueB = currentObject[key];
//         const areObjects = isObject(valueA) && isObject(valueB);
//         mergedObjects[key] = areObjects ? objectsMergeDeep(valueA, valueB) : valueB;
//       });
//       return mergedObjects;
//     }, {});
//   }
//
// with `isObject(x)`: `Object.prototype.toString.call(x) === '[object
// Object]'` and `objectKeys`: `Object.keys`. So the result is a new plain
// object with A's own keys, then B's other own keys; a key of both takes B's
// value, or where both values are plain objects their merge. Nested values
// are shared, not copied. The body (reduce over untyped objects, a
// prototype's toString) is not lowered: a call lowers to a merge directed by
// the arguments' static types (`mergeCall`):
//
// - plain records (not class instances, not tuples) merge field by field;
//   maps standing for dictionary objects merge key by key (a program that
//   also builds a JavaScript Map of the merged type is rejected at the
//   merge: a Map is not merged, `[object Map]`); every other value
//   (primitives, arrays, functions, elements, null) is taken from B;
// - B's field that may be undefined keeps A's value where it is undefined,
//   under the program-wide check record spreads make (an object of B's type
//   has the key with an undefined value nowhere: `Lowerer.spreadField`);
// - the result has the type the call's context gives (the declaration
//   override types `mergeOptions` as `TypeA & NonNullable<TypeB>`); a field
//   it lacks, or one it requires where a side may lack it, is rejected;
// - a position where either side may be a class instance or a union holding
//   a record (whether both are plain objects is then known only at run
//   time) is rejected.
//
// The entry is pinned to the package's exact version and to the SHA-256 of
// the normalized source (TypeScript's printer, comments removed) of the
// function and the two helpers it calls; a mismatch rejects each call,
// located. conformance/packs/embla-carousel.mjs generates vectors from the
// real function; tests/embla-merge.test.mjs runs them in the interpreter.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import type { Expr, Stmt, Type } from '../ir.ts';
import { skipParens, type FnBuilder, type Lowerer } from '../language.ts';
import { maybeInner } from '../irtype.ts';
import { sameType } from '../types.ts';

export const VERSION = '8.6.0';
/** The function a helper entry stands for, and those it calls (hashed with it). */
export const MERGE = { name: 'objectsMergeDeep', uses: ['isObject', 'objectKeys'] };
/** SHA-256 of `normalizedSource(bundle, [MERGE.name, ...MERGE.uses])` of 8.6.0's ESM bundle. */
export const MERGE_SHA256 = '9e2cb9e7cc48b273f401c6028e038285ad952977359edc41a15698dd97861bb3';

const parsed = new Map<string, ts.SourceFile>();

/**
 * The printed declarations of the top-level functions `names` of JavaScript
 * module `code`, comments removed, one per line; undefined where one is
 * missing.
 */
export function normalizedSource(code: string, names: string[]): string | undefined {
  let sf = parsed.get(code);
  if (!sf) {
    parsed.clear();
    sf = ts.createSourceFile('m.js', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    parsed.set(code, sf);
  }
  const printer = ts.createPrinter({ removeComments: true });
  const out: string[] = [];
  for (const n of names) {
    const d = sf.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === n);
    if (!d) return undefined;
    out.push(printer.printNode(ts.EmitHint.Unspecified, d, sf));
  }
  return out.join('\n');
}

export const sourceHash = (s: string) => createHash('sha256').update(s).digest('hex');

/** The pack module (hashed into the program's `meta.mappings`). */
export const MODULE = import.meta.url;

const BOOLEAN: Type = 'boolean';
const LABEL = 'embla-carousel@8.6.0 pack (objectsMergeDeep)';

type Value = { e: Expr; t: Type };

const isEmptyObject = (e: ts.Expression) => {
  const x = skipParens(e);
  return ts.isObjectLiteralExpression(x) && x.properties.length === 0;
};

/** Dictionary merge functions, per map type (`dictionaryMerge`). */
const dictionaries = new WeakMap<Lowerer, Map<string, number>>();

/** A call of `objectsMergeDeep(a, b)`: the merge of `a` and `b` (above). */
export function mergeCall(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const fail = (at: ts.Node, why: string): never => lower.fail(at, 'E_PACK', `${LABEL}: ${why}`);
  if (node.arguments.length !== 2 || node.arguments.some(ts.isSpreadElement))
    fail(node, 'the merge takes two objects');
  const records = lower.types.records;
  const plain = (t: Type): t is { record: number } =>
    typeof t === 'object' && 'record' in t && !records[t.record].class && !records[t.record].tuple;
  const dictionary = (t: Type): t is { map: [Type, Type] } =>
    typeof t === 'object' && 'map' in t && t.map[0] === 'string';
  /** Whether values of `t` may be plain objects (null and undefined are not). */
  const objectLike = (t: Type): boolean | 'unknown' => {
    const s = maybeInner(t) ?? t;
    if (plain(s) || dictionary(s)) return true;
    if (typeof s !== 'object') return s === 'dyn' || s === 'attrs' ? 'unknown' : false;
    if ('class' in s || 'classes' in s || 'map' in s) return 'unknown';
    if ('record' in s) return records[(s as { record: number }).record].tuple ? false : 'unknown';
    if ('union' in s) return s.union.some(m => objectLike(m) !== false) ? 'unknown' : false;
    return false;
  };
  const local = (i: number): Expr => ({ op: 'local', local: i });
  const test = (name: string, e: Expr): Expr => ({
    op: 'builtin',
    name: `maybe.${name}`,
    args: [e],
    type: BOOLEAN,
  });
  /** Allocates a local of the function being built (the caller, or a helper). */
  let alloc = (name: string, t: Type): number => b.local(name, t);
  const bind = (name: string, v: Value, body: (read: Value) => Expr): Expr => {
    if (v.e.op === 'local') return body(v);
    const l = alloc(name, v.t);
    return { op: 'with', local: l, value: v.e, body: body({ e: local(l), t: v.t }) };
  };

  /** `v` as a value of type `want` (same values, another static type). */
  const convert = (v: Value, want: Type): Expr => {
    if (sameType(v.t, want)) return v.e;
    const wi = maybeInner(want);
    const ti = maybeInner(v.t);
    if (wi !== undefined && ti === undefined) return { op: 'some', value: convert(v, wi) };
    // A nullish value where the declared result (TypeScript's intersection)
    // has none: reported where it happens.
    if (wi === undefined && ti !== undefined)
      return bind('$value', v, r => ({
        op: 'cond',
        test: test('is-nullish', r.e),
        then: lower.unsupportedValue(
          'embla$mergeNullish',
          want,
          "a merge giving a nullish value where the merge's declared type has none",
        ),
        else: convert({ e: { op: 'unwrap', value: r.e }, t: ti }, want),
      }));
    if (wi !== undefined && ti !== undefined)
      return bind('$value', v, r => ({
        op: 'cond',
        test: test('is-null', r.e),
        then: { op: 'null', type: want },
        else: {
          op: 'cond',
          test: test('is-undefined', r.e),
          then: { op: 'undefined', type: want },
          else: { op: 'some', value: convert({ e: { op: 'unwrap', value: r.e }, t: ti }, wi) },
        },
      }));
    if (plain(v.t) && plain(want)) {
      // (Where the declared result type and a value's type differ in their
      // keys, as an intersection's may for one side's value: reported where
      // that value is taken.)
      const from0 = records[v.t.record];
      const to0 = records[want.record];
      const missing =
        from0.fields.find(f => !to0.fields.some(g => g.name === f.name))?.name ??
        to0.fields.find(
          g => maybeInner(g.type) === undefined && !from0.fields.some(f => f.name === g.name),
        )?.name;
      if (missing !== undefined)
        return lower.unsupportedValue(
          'embla$mergeKeys',
          want,
          `a merge taking a value whose key ${missing} the merge's declared type does not hold so`,
        );
      return bind('$value', v, r => {
        const from = records[(r.t as { record: number }).record];
        const to = records[want.record];
        return {
          op: 'record',
          record: want.record,
          fields: to.fields.map(g => {
            const i = from.fields.findIndex(f => f.name === g.name);
            if (i >= 0)
              return convert(
                { e: { op: 'get', object: r.e, field: i }, t: from.fields[i].type },
                g.type,
              );
            return { op: 'undefined', type: g.type };
          }),
        };
      });
    }
    if (lower.widens(v.t, want)) return v.e;
    return fail(
      node,
      `a value of type ${JSON.stringify(v.t)} where the merge's result type has ${JSON.stringify(want)}`,
    );
  };

  /** The merge of two present plain records or dictionaries, as type `want`. */
  const merge = (want: Type, a: Value, c: Value): Expr => {
    if (dictionary(a.t) && dictionary(c.t)) {
      if (!sameType(a.t, c.t) || !sameType(a.t, want))
        fail(node, 'dictionaries of different types are merged');
      return { op: 'call', function: dictionaryMerge(a.t), args: [a.e, c.e] };
    }
    if (!plain(a.t) || !plain(c.t) || !plain(want))
      return fail(node, 'a plain object merged with a dictionary');
    const ra = records[a.t.record];
    const rc = records[c.t.record];
    const rw = records[want.record];
    for (const f of [...ra.fields, ...rc.fields])
      if (!rw.fields.some(g => g.name === f.name))
        fail(node, `the merge's result type lacks the key ${f.name}, which a value has`);
    return bind('$a', a, ar =>
      bind('$b', c, cr => ({
        op: 'record',
        record: want.record,
        fields: rw.fields.map(g => {
          const i = ra.fields.findIndex(f => f.name === g.name);
          const k = rc.fields.findIndex(f => f.name === g.name);
          const va: Value | undefined =
            i >= 0 ? { e: { op: 'get', object: ar.e, field: i }, t: ra.fields[i].type } : undefined;
          const vc: Value | undefined =
            k >= 0 ? { e: { op: 'get', object: cr.e, field: k }, t: rc.fields[k].type } : undefined;
          const value = field(g.type, va, vc, g.name);
          if (!vc || maybeInner(vc.t) === undefined || !va) return value;
          // B's field keeps A's value where it is undefined: B's objects
          // never have the key with an undefined value (checked program-
          // wide). The result is then undefined only where A's is: where A
          // never has the key so either (A's field is never undefined, or the
          // result shares B's record and A's objects are checked too), it
          // lacks the key there.
          const rb = (c.t as { record: number }).record;
          lower.spreadField(rb, g.name, node);
          if (want.record === rb)
            lower.spreadField((a.t as { record: number }).record, g.name, node);
          return maybeInner(va.t) === undefined || want.record === rb
            ? lower.absentField(value)
            : value;
        }),
      })),
    );
  };

  /** A key's value: A's `a`, B's `c` (either may lack the key). */
  const field = (want: Type, a: Value | undefined, c: Value | undefined, key: string): Expr => {
    if (!a && !c) {
      if (maybeInner(want) === undefined)
        fail(node, `the merge's result type requires the key ${key}, which no value has`);
      return { op: 'undefined', type: want };
    }
    if (!c) return convert(a!, want);
    if (!a) return convert(c, want);
    const oa = objectLike(a.t);
    const oc = objectLike(c.t);
    if ((oa === 'unknown' && oc !== false) || (oc === 'unknown' && oa !== false))
      fail(
        node,
        `whether both values of the key ${key} are plain objects is known only at run time (class instances, maps or unions of objects)`,
      );
    const both = oa === true && oc === true;
    const ia = maybeInner(a.t);
    const ic = maybeInner(c.t);
    return bind('$a', a, ar =>
      bind('$b', c, cr => {
        // B's value where it is defined (and not merged), else A's.
        const defined = (): Expr => convert(cr, want);
        const taken = (): Expr => {
          if (!both) return defined();
          const wi = maybeInner(want) ?? want;
          const merged = (x: Expr, y: Expr): Expr => {
            const m = merge(wi, { e: x, t: ia ?? a.t }, { e: y, t: ic ?? c.t });
            return maybeInner(want) !== undefined ? { op: 'some', value: m } : m;
          };
          const ua: Expr = ia !== undefined ? { op: 'unwrap', value: ar.e } : ar.e;
          const uc: Expr = ic !== undefined ? { op: 'unwrap', value: cr.e } : cr.e;
          let out = merged(ua, uc);
          // A null B is taken; a nullish A gives B's value.
          if (ic !== undefined)
            out = {
              op: 'cond',
              test: test('is-null', cr.e),
              then:
                maybeInner(want) !== undefined
                  ? { op: 'null', type: want }
                  : lower.unsupportedValue(
                      'embla$mergeNull',
                      want,
                      `a merge taking a null value of the key ${key}, where the merge's declared type has none`,
                    ),
              else: out,
            };
          if (ia !== undefined)
            out = { op: 'cond', test: test('is-nullish', ar.e), then: defined(), else: out };
          return out;
        };
        if (ic === undefined) return taken();
        return {
          op: 'cond',
          test: test('is-undefined', cr.e),
          then: convert(ar, want),
          else: taken(),
        };
      }),
    );
  };

  /**
   * A function merging two dictionaries of map type `t` (a copy of A, then
   * each of B's keys in its own-key order: merged where both values are
   * plain records, else B's value).
   */
  const dictionaryMerge = (t: { map: [Type, Type] }): number => {
    let m = dictionaries.get(lower);
    if (!m) dictionaries.set(lower, (m = new Map()));
    const key = JSON.stringify(t);
    const known = m.get(key);
    if (known !== undefined) return known;
    lower.dictionaryMerged(t, node);
    const index = lower.reserve();
    m.set(key, index);
    const v = t.map[1];
    const vi = maybeInner(v) ?? v;
    const ov = objectLike(v);
    if (ov === 'unknown')
      fail(node, 'dictionary values that may be class instances, maps or unions of objects');
    const [A, B, R, K, VA, VB] = [0, 1, 2, 3, 4, 5];
    const get = (map: number): Expr => ({
      op: 'builtin',
      name: 'map.get',
      args: [local(map), local(K)],
      type: { maybe: vi },
    });
    // (Typed as the map's value: `map.get` of a present key.)
    const value = (x: Expr): Expr => (maybeInner(v) !== undefined ? x : { op: 'unwrap', value: x });
    const set = (e: Expr): Stmt => ({
      op: 'expr',
      value: { op: 'builtin', name: 'map.set', args: [local(R), local(K), e], type: t },
    });
    const helperLocals: { name: string; type: Type }[] = [
      { name: 'r', type: t },
      { name: 'k', type: 'string' },
      { name: 'va', type: { maybe: vi } },
      { name: 'vb', type: { maybe: vi } },
    ];
    const outer = alloc;
    alloc = (name, type) => {
      helperLocals.push({ name, type });
      return 2 + helperLocals.length - 1;
    };
    let put: Stmt[];
    if (ov === true) {
      const fresh = (): Expr =>
        merge(
          vi,
          { e: { op: 'unwrap', value: local(VA) }, t: vi },
          { e: { op: 'unwrap', value: local(VB) }, t: vi },
        );
      put = [
        {
          op: 'if',
          test: {
            op: 'or',
            left: test('is-nullish', local(VA)),
            right: test('is-nullish', local(VB)),
          },
          then: [set(value(local(VB)))],
          else: [set(maybeInner(v) !== undefined ? { op: 'some', value: fresh() } : fresh())],
        },
      ];
    } else put = [set(value(local(VB)))];
    alloc = outer;
    lower.functions[index] = {
      name: 'embla$mergeDictionary',
      params: [
        { name: 'a', type: t },
        { name: 'b', type: t },
      ],
      locals: helperLocals,
      result: t,
      body: [
        {
          op: 'let',
          local: R,
          value: { op: 'builtin', name: 'Map.new', args: [local(A)], type: t },
        },
        {
          op: 'for-of',
          local: K,
          iterable: {
            op: 'builtin',
            name: 'map.dictionary-keys',
            args: [local(B)],
            type: { array: 'string' },
          },
          body: [
            { op: 'let', local: VA, value: get(R) },
            { op: 'let', local: VB, value: get(B) },
            ...put,
          ],
        },
        { op: 'return', value: local(R) },
      ],
    };
    return index;
  };

  // The arguments, evaluated in order: A, then B (`x || {}`: nothing where
  // `x` is nullish; a literal `{}`: nothing).
  const [x, y] = node.arguments;
  const av = lower.expr(x, b);
  const at = lower.irType(av, b);
  if (!plain(at) && !dictionary(at)) fail(x, 'the first object is a plain object or a dictionary');
  let yb = skipParens(y);
  let orEmpty = false;
  if (
    ts.isBinaryExpression(yb) &&
    yb.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
    isEmptyObject(yb.right)
  ) {
    orEmpty = true;
    yb = skipParens(yb.left);
  }
  // The result's type: the function's result where the call is returned,
  // else the call's own (both from the declaration override).
  let want: Type | undefined;
  let up: ts.Node = node;
  while (ts.isParenthesizedExpression(up.parent)) up = up.parent;
  if (ts.isReturnStatement(up.parent) || (ts.isArrowFunction(up.parent) && up.parent.body === up))
    want = b.result;
  want ??= lower.types.tryMap(lower.checker.getTypeAtLocation(node), node);
  if (want === undefined) return fail(node, "the merge's result needs a static type");
  const result = want;
  const onlyA = (): Expr => convert({ e: av, t: at }, result);
  if (isEmptyObject(yb)) return onlyA();
  const bv = lower.expr(yb, b);
  const bt = lower.irType(bv, b);
  const bi = maybeInner(bt);
  // (An argument left out of a generic call: nothing.)
  if (bi === 'void' && orEmpty) return bind('$mergeB', { e: bv, t: bt }, () => onlyA());
  if (bi !== undefined && !orEmpty) fail(y, 'the second object may be nullish');
  const inner = bi ?? bt;
  if (!plain(inner) && !dictionary(inner))
    fail(y, 'the second object is a plain object or a dictionary');
  return bind('$mergeA', { e: av, t: at }, a =>
    bind('$mergeB', { e: bv, t: bt }, c => {
      const both = merge(
        result,
        a,
        bi !== undefined ? { e: { op: 'unwrap', value: c.e }, t: bi } : c,
      );
      if (bi === undefined) return both;
      return {
        op: 'cond',
        test: test('is-nullish', c.e),
        then: convert(a, result),
        else: both,
      };
    }),
  );
}
