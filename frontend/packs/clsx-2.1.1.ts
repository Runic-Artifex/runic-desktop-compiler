// Mapping pack for clsx 2.1.1 (docs/design/M6-LIBRARIES.md#mapping-packs-d9).
//
// clsx(...args) joins the class names its arguments contribute with single
// spaces (dist/clsx.mjs):
//
//   toVal(x): strings and numbers as String(x); arrays: the non-empty toVal of
//   each truthy element, joined; other objects: the keys (for-in order) whose
//   values are truthy, joined; anything else ''.
//   clsx(...a): the non-empty toVal of each truthy argument, joined.
//
// Strings are not trimmed or split, so 'a ' and 'b' give 'a  b'. Each call
// lowers to IR string expressions over the arguments' values, evaluated
// left to right as JavaScript evaluates the arguments:
// - strings, nullable strings, numbers (truthy ones as String(n)), booleans
//   (which contribute nothing), null and undefined;
// - `a && b`, `a || b`, `c ? a : b` and `a ?? b` by their branches;
// - array literals and array values of these;
// - object literals with static keys (for-in order: array-index keys first,
//   ascending) whose values are tested for truthiness.
// Other shapes (object values, spreads, computed keys, functions, maps) are
// rejected with E_PACK. conformance/packs/clsx.mjs pins the semantics with
// vectors from the real package (tests/packs.test.mjs).
import ts from 'typescript';
import type { Expr, Fn, Local, Type } from '../ir.ts';
import type { FnBuilder, Lowerer } from '../language.ts';
import type { Pack } from '../packs.ts';

const STRING: Type = 'string';
const EMPTY: Expr = { op: 'lit', value: '' };

/** Allocates locals for `with` bindings in the function being built. */
interface Locals {
  local(name: string, type: Type): number;
}

const helpers = new WeakMap<
  Lowerer,
  { join?: number; emptyKey?: number; arrays: Map<string, number> }
>();
const helperState = (lower: Lowerer) => {
  let h = helpers.get(lower);
  if (!h) helpers.set(lower, (h = { arrays: new Map() }));
  return h;
};

const isLit = (e: Expr): e is { op: 'lit'; value: string } =>
  e.op === 'lit' && typeof e.value === 'string';

/** `a` and `b` joined as clsx joins: a space between two non-empty values. */
function join(lower: Lowerer, a: Expr, b: Expr): Expr {
  if (isLit(a) && a.value === '') return b;
  if (isLit(b) && b.value === '') return a;
  if (isLit(a) && isLit(b)) return { op: 'lit', value: `${a.value} ${b.value}` };
  const h = helperState(lower);
  if (h.join === undefined) {
    h.join = lower.reserve();
    const local = (i: number): Expr => ({ op: 'local', local: i });
    const empty = (i: number): Expr => ({ op: 'eq', left: local(i), right: EMPTY });
    lower.functions[h.join] = {
      name: 'clsx$join',
      params: [
        { name: 'acc', type: STRING },
        { name: 'x', type: STRING },
      ],
      locals: [],
      result: STRING,
      body: [
        { op: 'if', test: empty(1), then: [{ op: 'return', value: local(0) }] },
        { op: 'if', test: empty(0), then: [{ op: 'return', value: local(1) }] },
        {
          op: 'return',
          value: {
            op: 'concat',
            left: { op: 'concat', left: local(0), right: { op: 'lit', value: ' ' } },
            right: local(1),
          },
        },
      ],
    };
  }
  return { op: 'call', function: h.join, args: [a, b] };
}

/**
 * An empty object key whose value is `on`: toVal appends a key without
 * checking it, so a truthy '' adds a separator after a non-empty string.
 */
function emptyKey(lower: Lowerer, acc: Expr, on: Expr): Expr {
  const h = helperState(lower);
  if (h.emptyKey === undefined) {
    h.emptyKey = lower.reserve();
    const local = (i: number): Expr => ({ op: 'local', local: i });
    lower.functions[h.emptyKey] = {
      name: 'clsx$emptyKey',
      params: [
        { name: 'acc', type: STRING },
        { name: 'on', type: 'boolean' },
      ],
      locals: [],
      result: STRING,
      body: [
        {
          op: 'if',
          test: {
            op: 'and',
            left: local(1),
            right: { op: 'ne', left: local(0), right: EMPTY },
          },
          then: [
            {
              op: 'return',
              value: { op: 'concat', left: local(0), right: { op: 'lit', value: ' ' } },
            },
          ],
        },
        { op: 'return', value: local(0) },
      ],
    };
  }
  return { op: 'call', function: h.emptyKey, args: [acc, on] };
}

/** Values that can be read twice without evaluating anything again. */
const pure = (e: Expr): boolean =>
  e.op === 'lit' || e.op === 'local' || e.op === 'undefined' || e.op === 'null';

/** Bind `v` to a local unless it is pure, and build `body` over its reads. */
function bind(locals: Locals, v: Expr, t: Type, body: (read: Expr) => Expr): Expr {
  if (pure(v)) return body(v);
  const local = locals.local('$clsx', t);
  return { op: 'with', local, value: v, body: body({ op: 'local', local }) };
}

const maybeOf = (t: Type): Type | undefined =>
  typeof t === 'object' && 'maybe' in t ? t.maybe : undefined;
const arrayOf = (t: Type): Type | undefined =>
  typeof t === 'object' && 'array' in t ? t.array : undefined;

/** Value types the pack covers: strings, numbers, booleans, nullable ones and arrays of them. */
function covers(t: Type): boolean {
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  const inner = maybeOf(t) ?? arrayOf(t);
  return inner !== undefined && (inner === 'void' || covers(inner));
}

/**
 * toVal(v) of a value of IR type `t` when v is truthy, else '' (what the
 * value contributes as an argument or array element). Undefined when the
 * type is outside the pack.
 */
function valuePart(lower: Lowerer, locals: Locals, v: Expr, t: Type): Expr | undefined {
  if (!covers(t)) return undefined;
  if (t === 'string') return v;
  if (t === 'number')
    return bind(locals, v, t, x => ({
      op: 'cond',
      test: { op: 'to-boolean', arg: x },
      then: { op: 'to-string', arg: x },
      else: EMPTY,
    }));
  // Booleans contribute nothing (toVal(true) is ''); still evaluate them.
  if (t === 'boolean') return pure(v) ? EMPTY : bind(locals, v, t, () => EMPTY);
  const inner = maybeOf(t);
  if (inner !== undefined) {
    if (inner === 'string') return { op: 'nullish', left: v, right: EMPTY };
    if (inner === 'void') return pure(v) ? EMPTY : bind(locals, v, t, () => EMPTY);
    return bind(locals, v, t, x => ({
      op: 'cond',
      test: { op: 'builtin', name: 'maybe.is-nullish', args: [x], type: 'boolean' },
      then: EMPTY,
      else: valuePart(lower, locals, { op: 'unwrap', value: x }, inner)!,
    }));
  }
  return { op: 'call', function: arrayHelper(lower, arrayOf(t)!), args: [v] };
}

/** `clsx$array(xs)`: toVal of an array value with elements of (covered) type `element`. */
function arrayHelper(lower: Lowerer, element: Type): number {
  const h = helperState(lower);
  const key = JSON.stringify(element);
  const known = h.arrays.get(key);
  if (known !== undefined) return known;
  const params: Local[] = [{ name: 'xs', type: { array: element } }];
  const locals: Local[] = [];
  const alloc: Locals = {
    local(name, type) {
      locals.push({ name, type });
      return params.length + locals.length - 1;
    },
  };
  const acc = alloc.local('acc', STRING);
  const x = alloc.local('x', element);
  const index = lower.reserve();
  h.arrays.set(key, index);
  // Elements are tested for truthiness before toVal, as at the top level;
  // valuePart already yields '' for falsy values.
  const part = valuePart(lower, alloc, { op: 'local', local: x }, element)!;
  const fn: Fn = {
    name: 'clsx$array',
    params,
    locals,
    result: STRING,
    body: [
      { op: 'let', local: acc, value: EMPTY },
      {
        op: 'for-of',
        local: x,
        iterable: { op: 'local', local: 0 },
        body: [
          {
            op: 'assign',
            target: { place: 'local', local: acc },
            value: join(lower, { op: 'local', local: acc }, part),
          },
        ],
      },
      { op: 'return', value: { op: 'local', local: acc } },
    ],
  };
  lower.functions[index] = fn;
  return index;
}

const skip = (e: ts.Expression): ts.Expression => {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e)
    )
      e = e.expression;
    else return e;
  }
};

/** An array index key (for-in visits these first, in ascending order). */
const indexKey = (k: string): boolean => /^(0|[1-9]\d*)$/.test(k) && Number(k) < 2 ** 32 - 1;

/**
 * What a class value contributes: toVal(e) when e is truthy, else ''. Used
 * for clsx arguments and by packs whose components take clsx class values.
 */
export function classValue(e: ts.Expression, b: FnBuilder, lower: Lowerer): Expr {
  const node = skip(e);
  const K = ts.SyntaxKind;
  const reject = (n: ts.Node, what: string): never =>
    lower.fail(n, 'E_PACK', `clsx@2.1.1 pack: ${what} is not covered`);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { op: 'lit', value: node.text };
  if (ts.isNumericLiteral(node)) {
    const n = Number(node.text);
    return { op: 'lit', value: n ? String(n) : '' };
  }
  if (
    node.kind === K.TrueKeyword ||
    node.kind === K.FalseKeyword ||
    node.kind === K.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined' && !lower.binding(node))
  )
    return EMPTY;
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === K.AmpersandAmpersandToken)
      return {
        op: 'cond',
        test: lower.condition(node.left, b),
        then: classValue(node.right, b, lower),
        else: EMPTY,
      };
    if (op === K.BarBarToken || op === K.QuestionQuestionToken) {
      const left = lower.expr(node.left, b);
      const t = lower.irType(left, b);
      const ownPart = (x: Expr) =>
        valuePart(lower, b, x, t) ?? reject(node.left, `a value of type ${JSON.stringify(t)}`);
      // a ?? b on a value that is never nullish is a; || tests truthiness.
      if (op === K.QuestionQuestionToken && maybeOf(t) === undefined) return ownPart(left);
      return bind(b, left, t, x => ({
        op: 'cond',
        test:
          op === K.BarBarToken
            ? { op: 'to-boolean', arg: x }
            : {
                op: 'not',
                arg: { op: 'builtin', name: 'maybe.is-nullish', args: [x], type: 'boolean' },
              },
        then: ownPart(x),
        else: classValue(node.right, b, lower),
      }));
    }
  }
  if (ts.isConditionalExpression(node))
    return {
      op: 'cond',
      test: lower.condition(node.condition, b),
      then: classValue(node.whenTrue, b, lower),
      else: classValue(node.whenFalse, b, lower),
    };
  if (ts.isArrayLiteralExpression(node)) {
    let out: Expr = EMPTY;
    for (const el of node.elements) {
      if (ts.isSpreadElement(el)) reject(el, 'a spread in an array');
      if (ts.isOmittedExpression(el)) continue;
      out = join(lower, out, classValue(el, b, lower));
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries: { key: string; test: () => Expr; at: ts.Node }[] = [];
    for (const p of node.properties) {
      let key: string | undefined;
      let test: (() => Expr) | undefined;
      if (ts.isShorthandPropertyAssignment(p)) {
        if (p.objectAssignmentInitializer) reject(p, 'a default in an object literal');
        const id = p.name;
        key = id.text;
        // The value of `{ x }` is the variable x (not the property's symbol).
        test = () => {
          const sym = lower.checker.getShorthandAssignmentValueSymbol(p);
          const binding = sym && lower.bindings.get(sym);
          if (!binding)
            return lower.fail(p, 'E_UNRESOLVED', `${id.text} is not a supported binding`);
          const v = lower.bindingExpr(binding, id, b, lower.types.of(id));
          return lower.truthy(v, lower.irType(v, b));
        };
      } else if (ts.isPropertyAssignment(p)) {
        const name = p.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) key = name.text;
        else if (ts.isNumericLiteral(name)) key = String(Number(name.text));
        else if (ts.isNoSubstitutionTemplateLiteral(name)) key = name.text;
        if (key === undefined) reject(p.name, 'a computed or private key');
        // `__proto__: v` sets the prototype instead of a key.
        if (key === '__proto__' && !ts.isComputedPropertyName(name))
          reject(p.name, 'a __proto__ key');
        const init = p.initializer;
        test = () => lower.condition(init, b);
      } else reject(p, 'a spread, method or accessor in an object literal');
      if (entries.some(x => x.key === key)) reject(p, `the repeated key ${JSON.stringify(key)}`);
      entries.push({ key: key!, test: test!, at: p });
    }
    // for-in order: array-index keys ascending, then the others in order.
    const ordered = [
      ...entries.filter(x => indexKey(x.key)).sort((x, y) => Number(x.key) - Number(y.key)),
      ...entries.filter(x => !indexKey(x.key)),
    ];
    const reordered = ordered.some((x, i) => x !== entries[i]);
    // The values are evaluated in source order (constructing the object),
    // then tested in for-in order.
    const tests = new Map<(typeof entries)[number], Expr>();
    const bindings: { local: number; value: Expr }[] = [];
    for (const x of entries) {
      const test = x.test();
      if (reordered && !pure(test)) {
        const local = b.local('$clsxKey', 'boolean');
        bindings.push({ local, value: test });
        tests.set(x, { op: 'local', local });
      } else tests.set(x, test);
    }
    let out: Expr = EMPTY;
    for (const x of ordered)
      out =
        x.key === ''
          ? emptyKey(lower, out, tests.get(x)!)
          : join(lower, out, {
              op: 'cond',
              test: tests.get(x)!,
              then: { op: 'lit', value: x.key },
              else: EMPTY,
            });
    for (const { local, value } of bindings.reverse())
      out = { op: 'with', local, value, body: out };
    return out;
  }
  const v = lower.expr(node, b);
  const t = lower.irType(v, b);
  return (
    valuePart(lower, b, v, t) ??
    reject(
      node,
      `a value of type ${JSON.stringify(t)} (strings, numbers, booleans, nullable ones and arrays of them are)`,
    )
  );
}

export const clsxPack: Pack = {
  name: 'clsx',
  version: '2.1.1',
  module: import.meta.url,
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `clsx@2.1.1 pack covers the main module, not ${pkg.subpath}`;
    if (imported !== 'default' && imported !== 'clsx')
      return `clsx@2.1.1 pack covers clsx (named or default), not ${imported}`;
    return {
      kind: 'function',
      call(node, b, lower) {
        let out: Expr = EMPTY;
        for (const a of node.arguments) {
          if (ts.isSpreadElement(a))
            lower.fail(a, 'E_PACK', 'clsx@2.1.1 pack: spread arguments are not covered');
          out = join(lower, out, classValue(a, b, lower));
        }
        return out;
      },
    };
  },
};
