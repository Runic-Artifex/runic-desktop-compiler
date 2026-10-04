// Mapping pack for svelte-toolbelt 0.10.6 (docs/design/M6-LIBRARIES.md,
// "Library code"): the helpers bits-ui builds its components with. Their
// sources dispatch on runtime types (boxes are getter objects with symbol
// brands, `mergeProps` tests `typeof` per key), so they lower to IR
// constructs with the package's semantics instead of being compiled:
//
// - `boxWith(getter, setter?)` (dist/box/box-extras.svelte.js): a box is a
//   class record per value type: its getter, its setter (absent for a
//   readable box) and `current`, a derived field computing the getter (the
//   writable box's `$derived.by(getter)`). Reading `current` calls the
//   getter of a readable box and reads the derived value of a writable one;
//   assigning it calls the setter (a readable box has none: TypeError, as
//   assigning a getter-only property throws in strict code). The types
//   `ReadableBox<T>` and `WritableBox<T>` both map to the box record of T.
// - `mergeProps(...bags)` (dist/utils/merge-props.js): the IR built-in
//   `attrs.merge-props`, which implements the package's rules
//   (crates/runic-js/src/attrs.rs): event listeners compose (each runs
//   unless the event was cancelled), `class` values join as clsx joins
//   strings, `style` objects merge and become a style string, otherwise the
//   later defined value wins, and `hidden`/`disabled` false are removed.
// - `attachRef(ref, onChange?)` (dist/utils/attach-ref.js): a bag holding one
//   attachment that writes the element into the box or calls the setter,
//   then calls `onChange`; its cleanup does nothing while the element is
//   connected, otherwise writes null and calls `onChange(null)`.
//   Attachments run untracked (the package untracks `onChange`; writing the
//   box reads nothing).
// - `afterTick(fn)` (dist/utils/after-tick.js): `tick().then(fn)`.
// - `onDestroyEffect(fn)` (dist/utils/on-destroy-effect.svelte.js): an
//   effect of the instance being created whose cleanup calls `fn`.
//
// Other exports and argument shapes are rejected (E_PACK).
import ts from 'typescript';
import type { Expr, Fn, Local, Stmt, Type } from '../ir.ts';
import type { FnBuilder, Lowerer } from '../language.ts';
import type { Pack } from '../packs.ts';
import { emptyShape, union } from '../bags.ts';
import { maybeInner } from '../irtype.ts';

const LABEL = 'svelte-toolbelt@0.10.6 pack';
const local = (i: number): Expr => ({ op: 'local', local: i });
const fnType = (params: Type[], result: Type): Type => ({ fn: { params, result } });

/** Box records by value type, per program. */
const boxes = new WeakMap<Lowerer, Map<string, number>>();

/** The record of boxes holding values of type `t` (created with its members). */
export function boxRecord(lower: Lowerer, t: Type): number {
  let known = boxes.get(lower);
  if (!known) boxes.set(lower, (known = new Map()));
  const key = JSON.stringify(t);
  const found = known.get(key);
  if (found !== undefined) return found;
  const record = lower.types.records.length;
  known.set(key, record);
  const self: Type = { record };
  const derived = lower.reserve();
  lower.types.records.push({
    name: 'Box',
    class: true,
    fields: [
      { name: 'get', type: fnType([], t) },
      { name: 'set', type: { maybe: fnType([t], 'void') } },
      { name: 'current', type: t, reactive: 'derived', derived },
    ],
  });
  const get = (object: Expr, field: number): Expr => ({ op: 'get', object, field });
  lower.functions[derived] = {
    name: 'Box.current$derived',
    params: [{ name: 'this', type: self }],
    locals: [],
    result: t,
    body: [{ op: 'return', value: { op: 'call-value', callee: get(local(0), 0), args: [] } }],
  };
  const current = lower.reserve();
  lower.functions[current] = {
    name: 'Box.current',
    params: [{ name: 'box', type: self }],
    locals: [],
    result: t,
    body: [
      {
        op: 'if',
        test: {
          op: 'builtin',
          name: 'maybe.is-nullish',
          args: [get(local(0), 1)],
          type: 'boolean',
        },
        then: [{ op: 'return', value: { op: 'call-value', callee: get(local(0), 0), args: [] } }],
      },
      { op: 'return', value: get(local(0), 2) },
    ],
  };
  lower.recordMembers.set(record, {
    read(name, object, at) {
      if (name !== 'current') return lower.fail(at, 'E_PACK', `${LABEL}: boxes have current only`);
      return { op: 'call', function: current, args: [object] };
    },
    write(name, object, value, at, b) {
      if (name !== 'current') return lower.fail(at, 'E_PACK', `${LABEL}: boxes have current only`);
      const have = lower.irType(value, b);
      const v: Expr =
        maybeInner(t) && !maybeInner(have) && have !== 'void' ? { op: 'some', value } : value;
      return [
        {
          op: 'expr',
          value: {
            op: 'call-value',
            callee: { op: 'unwrap', value: get(object, 1) },
            args: [v],
          },
        },
      ];
    },
  });
  return record;
}

/** The value type of a box record, if `t` is one. */
function boxValue(lower: Lowerer, t: Type): Type | undefined {
  if (typeof t !== 'object' || !('record' in t)) return undefined;
  const r = lower.types.records[t.record];
  return lower.recordMembers.has(t.record) && r.name === 'Box' ? r.fields[2].type : undefined;
}

/** A function value lowered for a parameter of type `want` (a closure or an expression). */
function functionArg(e: ts.Expression, b: FnBuilder, lower: Lowerer, want: Type): Expr {
  const v = lower.expr(e, b);
  const have = lower.irType(v, b);
  // A function whose result is ignored, or taking fewer parameters.
  const adapted = lower.adaptFunction(v, have, want);
  if (adapted) return adapted;
  if (JSON.stringify(have) !== JSON.stringify(want))
    lower.fail(
      e,
      'E_PACK',
      `${LABEL}: expected a function of type ${JSON.stringify(want)}, found ${JSON.stringify(have)}`,
    );
  return v;
}

/** `boxWith(getter, setter?)`. */
function boxWith(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [getter, setter] = node.arguments;
  if (!getter || node.arguments.length > 2 || node.arguments.some(ts.isSpreadElement))
    return lower.fail(node, 'E_PACK', `${LABEL}: boxWith takes a getter and an optional setter`);
  const box = lower.types.of(node);
  const t = boxValue(lower, box);
  if (t === undefined) return lower.fail(node, 'E_PACK', `${LABEL}: boxWith's type is not a box`);
  const get = functionArg(getter, b, lower, fnType([], t));
  const set: Expr = setter
    ? { op: 'some', value: functionArg(setter, b, lower, fnType([t], 'void')) }
    : { op: 'undefined', type: { maybe: fnType([t], 'void') } };
  return { op: 'record', record: (box as { record: number }).record, fields: [get, set] };
}

/** `mergeProps(...bags)`. */
function mergeProps(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const args = node.arguments.map(a => {
    if (ts.isSpreadElement(a)) return lower.fail(a, 'E_PACK', `${LABEL}: spread arguments`);
    const v = lower.expr(a, b);
    if (lower.irType(v, b) !== 'attrs')
      lower.fail(a, 'E_PACK', `${LABEL}: mergeProps takes attribute bags (props objects)`);
    return v;
  });
  return { op: 'builtin', name: 'attrs.merge-props', args, type: 'attrs' };
}

/** A function of the program built here: captures, params and body. */
function define(lower: Lowerer, f: Omit<Fn, 'locals'> & { locals?: Local[] }): number {
  const index = lower.reserve();
  lower.functions[index] = { locals: [], ...f };
  return index;
}

/** `attachRef(ref, onChange?)`. */
function attachRef(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [ref, onChange] = node.arguments;
  if (!ref || node.arguments.length > 2)
    return lower.fail(node, 'E_PACK', `${LABEL}: attachRef takes a ref and an optional onChange`);
  const refValue = lower.expr(ref, b);
  const refType = lower.irType(refValue, b);
  const element: Type = { maybe: 'element' };
  const boxed = boxValue(lower, refType);
  if (boxed !== undefined && JSON.stringify(boxed) !== JSON.stringify(element))
    lower.fail(ref, 'E_PACK', `${LABEL}: attachRef takes a box of an element or null`);
  if (boxed === undefined && JSON.stringify(refType) !== JSON.stringify(fnType([element], 'void')))
    lower.fail(ref, 'E_PACK', `${LABEL}: attachRef takes a box or a setter of an element or null`);
  const changeType = fnType([element], 'void');
  const change = onChange ? functionArg(onChange, b, lower, changeType) : undefined;
  // Captures: [ref, onChange?]; the attachment's parameter is the element.
  const captures: Local[] = [
    { name: 'ref', type: refType },
    ...(change ? [{ name: 'onChange', type: changeType }] : []),
  ];
  const n = captures.length;
  /** Writes `value` (a maybe element) through the ref. */
  const write = (refLocal: number, value: Expr): Stmt =>
    boxed !== undefined
      ? {
          op: 'expr',
          value: {
            op: 'call-value',
            callee: { op: 'unwrap', value: { op: 'get', object: local(refLocal), field: 1 } },
            args: [value],
          },
        }
      : { op: 'expr', value: { op: 'call-value', callee: local(refLocal), args: [value] } };
  const notify = (changeLocal: number, value: Expr): Stmt[] =>
    change
      ? [{ op: 'expr', value: { op: 'call-value', callee: local(changeLocal), args: [value] } }]
      : [];
  const nothing: Expr = { op: 'null', type: element };
  // The cleanup: captures [element, ref, onChange?].
  const cleanup = define(lower, {
    name: 'attachRef$cleanup',
    captures: [{ name: 'node', type: 'element' }, ...captures],
    params: [],
    result: 'void',
    body: [
      {
        op: 'if',
        test: { op: 'builtin', name: 'element.isConnected', args: [local(0)], type: 'boolean' },
        then: [{ op: 'return' }],
      },
      write(1, nothing),
      ...notify(2, nothing),
    ],
  });
  const attach = define(lower, {
    name: 'attachRef$attachment',
    captures,
    params: [{ name: 'node', type: 'element' }],
    result: fnType([], 'void'),
    body: [
      write(0, { op: 'some', value: local(n) }),
      ...notify(1, { op: 'some', value: local(n) }),
      {
        op: 'return',
        value: {
          op: 'closure',
          function: cleanup,
          captures: [n, ...captures.map((_, i) => i)],
        },
      },
    ],
  });
  const refLocal = b.local('$ref', refType);
  const changeLocal = change ? b.local('$onChange', changeType) : undefined;
  let out: Expr = {
    op: 'attrs',
    items: [
      {
        attach: {
          op: 'closure',
          function: attach,
          captures: [refLocal, ...(changeLocal !== undefined ? [changeLocal] : [])],
        },
      },
    ],
  };
  if (change) out = { op: 'with', local: changeLocal!, value: change, body: out };
  return { op: 'with', local: refLocal, value: refValue, body: out };
}

/** `afterTick(fn)`: `tick().then(fn)`. */
function afterTick(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [fn] = node.arguments;
  if (!fn || node.arguments.length !== 1)
    return lower.fail(node, 'E_PACK', `${LABEL}: afterTick takes a function`);
  const f = lower.expr(fn, b);
  const t = lower.irType(f, b);
  if (typeof t !== 'object' || !('fn' in t) || t.fn.params.length)
    return lower.fail(fn, 'E_PACK', `${LABEL}: afterTick takes a function without parameters`);
  return {
    op: 'builtin',
    name: 'promise.then',
    args: [{ op: 'builtin', name: 'flush.tick', args: [], type: { promise: 'void' } }, f],
    type: { promise: t.fn.result === 'void' ? 'void' : t.fn.result },
  };
}

/** `onDestroyEffect(fn)`: an effect whose cleanup calls `fn`. */
function onDestroyEffect(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [fn] = node.arguments;
  if (!fn || node.arguments.length !== 1)
    return lower.fail(node, 'E_PACK', `${LABEL}: onDestroyEffect takes a function`);
  const f = functionArg(fn, b, lower, fnType([], 'void'));
  const cleanupType = fnType([], 'void');
  const cleanup = define(lower, {
    name: 'onDestroyEffect$cleanup',
    captures: [{ name: 'fn', type: cleanupType }],
    params: [],
    result: 'void',
    body: [{ op: 'expr', value: { op: 'call-value', callee: local(0), args: [] } }],
  });
  const run = define(lower, {
    name: 'onDestroyEffect$run',
    captures: [{ name: 'fn', type: cleanupType }],
    params: [],
    result: cleanupType,
    body: [{ op: 'return', value: { op: 'closure', function: cleanup, captures: [0] } }],
  });
  const tmp = b.local('$onDestroy', cleanupType);
  return {
    op: 'with',
    local: tmp,
    value: f,
    body: {
      op: 'builtin',
      name: 'effect.post',
      args: [{ op: 'closure', function: run, captures: [tmp] }],
      type: 'void',
    },
  };
}

export const svelteToolbeltPack: Pack = {
  name: 'svelte-toolbelt',
  version: '0.10.6',
  module: import.meta.url,
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    switch (imported) {
      case 'boxWith':
        return { kind: 'function', call: boxWith };
      case 'mergeProps':
        return {
          kind: 'function',
          call: mergeProps,
          shape: (node, of) => union(...node.arguments.map(of)),
        };
      case 'attachRef':
        return { kind: 'function', call: attachRef, shape: () => emptyShape() };
      case 'afterTick':
        return { kind: 'function', call: afterTick };
      case 'onDestroyEffect':
        return { kind: 'function', call: onDestroyEffect };
    }
    return `${LABEL} covers boxWith, mergeProps, attachRef, afterTick and onDestroyEffect, not ${imported}`;
  },
  type(t, at, lower) {
    // ReadableBox<T> and WritableBox<T> (dist/box/box-extras.svelte.d.ts):
    // a `current` property and the BoxSymbol brand.
    const checker = lower.checker;
    const brand = checker
      .getPropertiesOfType(t)
      .find(p => String(p.escapedName).startsWith('__@BoxSymbol@'));
    const file = brand?.declarations?.[0]?.getSourceFile().fileName ?? '';
    if (
      !brand ||
      !/[\\/]svelte-toolbelt[\\/]dist[\\/]box[\\/]box-extras\.svelte\.d\.ts$/.test(file)
    )
      return undefined;
    const current = t.getProperty('current');
    if (!current) return undefined;
    const value = lower.types.map(checker.getTypeOfSymbolAtLocation(current, at), at);
    return { record: boxRecord(lower, value) };
  },
};
