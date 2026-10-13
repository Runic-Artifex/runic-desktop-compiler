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
// - `box(initial)` (dist/box/box.svelte.js): a writable box over a `$state`
//   of its own (a class record with one reactive field).
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
// - `onMountEffect(fn)` (dist/utils/on-mount-effect.svelte.js): an effect of
//   the instance being created running `fn` untracked, its result (a cleanup
//   or nothing) the effect's cleanup.
// - `afterSleep(ms, cb)` (dist/utils/after-sleep.js): `setTimeout(cb, ms)`.
// - `executeCallbacks(...callbacks)` (dist/utils/execute-callbacks.js): a
//   function calling each callback that is a function with its arguments.
//   Its parameters are the expected function type's (an `on()` listener
//   takes the event), else the longest callback's; each callback's
//   parameters are a prefix of them (JavaScript ignores the extra
//   arguments). Undefined callbacks are skipped. A spread array of
//   callbacks (`executeCallbacks(...list)`) is copied when the call is made
//   and its callbacks run in order.
// - `composeHandlers(...handlers)` (dist/utils/compose-handlers.js): a
//   listener calling each handler (skipping undefined ones) with the event
//   until the event is cancelled. Boxes of handlers are rejected.
// - `contains(parent, child)` (dist/utils/dom.js): false unless both are
//   elements, else `parent.contains(child)` (no shadow roots exist).
// - `new DOMContext(box)` (dist/utils/dom-context.svelte.js): a record of the
//   element box whose setTimeout and clearTimeout are the window's.
// - `srOnlyStyles` (dist/utils/sr-only-styles.js): a constant style object,
//   folded where it is spread into a bag's style object.
//
// Other exports and argument shapes are rejected (E_PACK).
import ts from 'typescript';
import type { Expr, Fn, Local, Stmt, Type } from '../ir.ts';
import { skipParens, type FnBuilder, type Lowerer } from '../language.ts';
import { reportPresentArgs, type Pack } from '../packs.ts';
import { ABSENT, emptyShape, mayHold, union, type Shape } from '../bags.ts';
import { maybeInner } from '../irtype.ts';

const LABEL = 'svelte-toolbelt@0.10.6 pack';
const local = (i: number): Expr => ({ op: 'local', local: i });
const fnType = (params: Type[], result: Type): Type => ({ fn: { params, result } });

/** Box records by value type, per program. */
const boxes = new WeakMap<Lowerer, Map<string, number>>();

/**
 * What the program passes box setters, per program: `setters` maps the
 * function of each setter written inline (`boxWith(get, (v) => …)`, so the
 * box holds the only reference to it) to its box record, and `absent` holds
 * the box records some code may assign a nullish value to (`current = x`
 * of a nullable `x`, attachRef's null). A setter whose record is not in
 * `absent` is only ever called with present values.
 */
const setterArgs = new WeakMap<Lowerer, { setters: Map<number, number>; absent: Set<number> }>();
const settersOf = (lower: Lowerer) => {
  let s = setterArgs.get(lower);
  if (!s) {
    const created = { setters: new Map<number, number>(), absent: new Set<number>() };
    setterArgs.set(lower, (s = created));
    reportPresentArgs(lower, fn => {
      const record = created.setters.get(fn);
      return record !== undefined && !created.absent.has(record);
    });
  }
  return s;
};

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
      if (v.op !== 'some' && maybeInner(t)) settersOf(lower).absent.add(record);
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
  // An inline function whose parameters TypeScript types wider than the
  // value model (a setter of a union TypeScript infers from a prop a
  // discriminant narrowed): the wanted parameter types.
  const fn = skipParens(e);
  const untyped =
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    typeof want === 'object' &&
    'fn' in want &&
    fn.parameters.length === want.fn.params.length &&
    fn.parameters.some(
      p => lower.types.tryMap(lower.checker.getTypeAtLocation(p), p) === undefined,
    );
  const v = untyped
    ? lower.closure(
        fn as ts.ArrowFunction,
        b,
        'closure',
        (want as { fn: { params: Type[] } }).fn.params,
      )
    : lower.expr(e, b);
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

/**
 * `srOnlyStyles` (dist/utils/sr-only-styles.js): a style object, spread into
 * the style objects of attribute bags (bits-ui's hidden inputs).
 * tests/bits.test.mjs checks it against the package.
 */
export const SR_ONLY_STYLES: Readonly<Record<string, string>> = Object.freeze({
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: '0',
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  borderWidth: '0',
  transform: 'translateX(-100%)',
});

/** `boxWith(getter, setter?)`. */
function boxWith(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [getter, setter] = node.arguments;
  if (!getter || node.arguments.length > 2 || node.arguments.some(ts.isSpreadElement))
    return lower.fail(node, 'E_PACK', `${LABEL}: boxWith takes a getter and an optional setter`);
  // A box of a value TypeScript types `any` or wider than the value model (a
  // prop typed from its sites, or narrowed by a discriminant): the getter's
  // result type.
  const current = lower.checker.getTypeAtLocation(node).getProperty('current');
  const currentType = current && lower.checker.getTypeOfSymbolAtLocation(current, node);
  const untyped =
    currentType &&
    (currentType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
      lower.types.tryMap(currentType, node) === undefined);
  let box: Type;
  if (untyped) {
    const g = lower.expr(getter, b);
    const gt = lower.irType(g, b);
    if (typeof gt !== 'object' || !('fn' in gt) || gt.fn.params.length)
      return lower.fail(getter, 'E_PACK', `${LABEL}: boxWith takes a getter`);
    box = { record: boxRecord(lower, gt.fn.result) };
  } else box = lower.types.of(node);
  const t = boxValue(lower, box);
  if (t === undefined) return lower.fail(node, 'E_PACK', `${LABEL}: boxWith's type is not a box`);
  const get = functionArg(getter, b, lower, fnType([], t));
  // A readable box where one of the nullable type is expected (bits-ui's
  // `value: boxWith(() => value)` for an option `ReadableBox<string |
  // undefined>`): the box of the nullable type, its getter wrapping the value.
  // (Also for an optional option, bits-ui's Command `onStateChange?:
  // ReadableBox<((state) => void) | undefined>`.)
  const context = lower.checker.getContextualType(node);
  const mapped = context && lower.types.tryMap(context, node);
  const wanted = mapped && (maybeInner(mapped) ?? mapped);
  const wt = wanted && boxValue(lower, wanted);
  if (!setter && wt && maybeInner(wt) && JSON.stringify(maybeInner(wt)) === JSON.stringify(t)) {
    const getType = fnType([], t);
    const widen = define(lower, {
      name: 'boxWith$widen',
      captures: [{ name: 'get', type: getType }],
      params: [],
      result: wt,
      body: [
        {
          op: 'return',
          value: { op: 'some', value: { op: 'call-value', callee: local(0), args: [] } },
        },
      ],
    });
    const tmp = b.local('$get', getType);
    return {
      op: 'with',
      local: tmp,
      value: get,
      body: {
        op: 'record',
        record: (wanted as { record: number }).record,
        fields: [
          { op: 'closure', function: widen, captures: [tmp] },
          { op: 'undefined', type: { maybe: fnType([wt], 'void') } },
        ],
      },
    };
  }
  // A readable box given to an option whose boxes hold nothing (bits-ui's
  // trigger options' `payload: ReadableBox<unknown>`, which no trigger
  // passes): a box of nothing, its getter keeping a null as null and
  // anything else as undefined (the census found only those reach it).
  const slot = optionDeclaration(node, lower);
  const unknownCurrent = (() => {
    const cur = context?.getProperty('current');
    return !!cur && !!(lower.checker.getTypeOfSymbol(cur).flags & ts.TypeFlags.Unknown);
  })();
  if (!setter && unknownCurrent && slot && lower.unions.nothingInBoxes(slot)) {
    const getType = fnType([], t);
    const nothing: Type = { maybe: 'void' };
    const read = define(lower, {
      name: 'boxWith$nothing',
      captures: [{ name: 'get', type: getType }],
      params: [],
      locals: [{ name: 'value', type: t }],
      result: nothing,
      body: [
        { op: 'let', local: 1, value: { op: 'call-value', callee: local(0), args: [] } },
        {
          op: 'return',
          value: {
            op: 'cond',
            test: { op: 'builtin', name: 'maybe.is-null', args: [local(1)], type: 'boolean' },
            then: { op: 'null', type: nothing },
            else: { op: 'undefined', type: nothing },
          },
        },
      ],
    });
    const tmp = b.local('$get', getType);
    return {
      op: 'with',
      local: tmp,
      value: get,
      body: {
        op: 'record',
        record: boxRecord(lower, nothing),
        fields: [
          { op: 'closure', function: read, captures: [tmp] },
          { op: 'undefined', type: { maybe: fnType([nothing], 'void') } },
        ],
      },
    };
  }
  const record = (box as { record: number }).record;
  const setFn = setter && functionArg(setter, b, lower, fnType([t], 'void'));
  const inline =
    setter &&
    (ts.isArrowFunction(skipParens(setter)) || ts.isFunctionExpression(skipParens(setter)));
  if (setFn && inline && setFn.op === 'closure')
    settersOf(lower).setters.set(setFn.function, record);
  const set: Expr = setFn
    ? { op: 'some', value: setFn }
    : { op: 'undefined', type: { maybe: fnType([t], 'void') } };
  return { op: 'record', record, fields: [get, set] };
}

/** The declaration of the option property an object literal gives `node` to. */
function optionDeclaration(node: ts.Expression, lower: Lowerer): ts.Declaration | undefined {
  const p = node.parent;
  if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.parent)) return undefined;
  const ctx = lower.checker.getContextualType(p.parent);
  const prop = ctx && lower.checker.getPropertyOfType(ctx, p.name.getText());
  const target = (prop as unknown as { target?: ts.Symbol })?.target ?? prop;
  return target?.valueDeclaration ?? target?.declarations?.[0];
}

/** State records (one reactive `$state` field) by value type, per program. */
const states = new WeakMap<Lowerer, Map<string, number>>();

/** The record holding a `$state` value of type `t`. */
function stateRecord(lower: Lowerer, t: Type): number {
  let known = states.get(lower);
  if (!known) states.set(lower, (known = new Map()));
  const key = JSON.stringify(t);
  const found = known.get(key);
  if (found !== undefined) return found;
  const record = lower.types.records.length;
  known.set(key, record);
  lower.types.records.push({
    name: 'BoxState',
    class: true,
    fields: [{ name: 'value', type: t, reactive: 'state' }],
  });
  return record;
}

/**
 * `box(initial)` (dist/box/box.svelte.js): a writable box over its own
 * `$state`: the getter reads it, the setter writes it (the box of the
 * declared or contextual type: `box(null)` for a `WritableBox<string | null>`).
 */
function box(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [initial] = node.arguments;
  if (node.arguments.length > 1 || (initial && ts.isSpreadElement(initial)))
    return lower.fail(node, 'E_PACK', `${LABEL}: box takes an initial value`);
  const context = lower.checker.getContextualType(node);
  // (Or the type expected where TypeScript cannot say: `const floating = simpleBox(null)`.)
  const wanted = (context && lower.types.tryMap(context, node)) ?? lower.expected.get(node);
  const box = wanted && boxValue(lower, wanted) !== undefined ? wanted : lower.types.of(node);
  const t = boxValue(lower, box);
  if (t === undefined) return lower.fail(node, 'E_PACK', `${LABEL}: box's type is not a box`);
  const state = stateRecord(lower, t);
  const stateType: Type = { record: state };
  // (The box's type is what an initial value TypeScript types too narrowly
  // takes: `simpleBox([])` of a box of an array.)
  if (initial) lower.expected.set(skipParens(initial), t);
  const value: Expr = initial
    ? initial.kind === ts.SyntaxKind.NullKeyword && maybeInner(t)
      ? { op: 'null', type: t }
      : lower.coerce(initial, b, t)
    : { op: 'undefined', type: t };
  const getter = define(lower, {
    name: 'box$get',
    captures: [{ name: 'state', type: stateType }],
    params: [],
    result: t,
    body: [{ op: 'return', value: { op: 'get', object: local(0), field: 0 } }],
  });
  const setter = define(lower, {
    name: 'box$set',
    captures: [{ name: 'state', type: stateType }],
    params: [{ name: 'v', type: t }],
    result: 'void',
    body: [
      { op: 'assign', target: { place: 'field', object: local(0), field: 0 }, value: local(1) },
    ],
  });
  const tmp = b.local('$box', stateType);
  return {
    op: 'with',
    local: tmp,
    value: { op: 'record', record: state, fields: [value] },
    body: {
      op: 'record',
      record: (box as { record: number }).record,
      fields: [
        { op: 'closure', function: getter, captures: [tmp] },
        { op: 'some', value: { op: 'closure', function: setter, captures: [tmp] } },
      ],
    },
  };
}

/**
 * `boxFrom(value)` (dist/box/box-extras.svelte.js): a box as it is, a
 * function as `boxWith(value)`, anything else as `simpleBox(value)`,
 * decided by the value's type.
 */
function boxFrom(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [value] = node.arguments;
  if (!value || node.arguments.length !== 1 || ts.isSpreadElement(value))
    return lower.fail(node, 'E_PACK', `${LABEL}: boxFrom takes a value`);
  const t = lower.types.typeOrUndefined(value);
  if (t !== undefined && boxValue(lower, t) !== undefined) return lower.expr(value, b);
  if (typeof t === 'object' && 'fn' in t) return boxWith(node, b, lower);
  return box(node, b, lower);
}

/** DOMContext records, per program. */
const domContexts = new WeakMap<Lowerer, number>();

/**
 * The record of `DOMContext` (dist/utils/dom-context.svelte.js): its
 * element box. `setTimeout` and `clearTimeout` are the window's timers,
 * `getActiveElement()` the document's active element (its root node is
 * the document: no shadow roots exist), typed `HTMLElement | null` as
 * declared; its other members (queries in its root node) are not covered.
 */
function domContextRecord(lower: Lowerer): number {
  const known = domContexts.get(lower);
  if (known !== undefined) return known;
  const record = lower.types.records.length;
  domContexts.set(lower, record);
  const element: Type = { record: boxRecord(lower, { maybe: 'element' }) };
  lower.types.records.push({
    name: 'DOMContext',
    class: true,
    fields: [{ name: 'element', type: element }],
  });
  const covered = `${LABEL}: DOMContext covers setTimeout, clearTimeout and getActiveElement`;
  lower.recordMembers.set(record, {
    read(name, _object, at) {
      return lower.fail(at, 'E_PACK', `${covered}, not ${name}`);
    },
    write(name, _object, _value, at) {
      return lower.fail(at, 'E_PACK', `${covered}; ${name} cannot be assigned`);
    },
    call(name, _object, node, b) {
      if (name === 'getActiveElement' && !node.arguments.length)
        return {
          op: 'some',
          value: {
            op: 'nullish',
            left: { op: 'builtin', name: 'focus.current', args: [], type: { maybe: 'element' } },
            right: { op: 'builtin', name: 'document.body', args: [], type: 'element' },
          },
        };
      if (name !== 'setTimeout' && name !== 'clearTimeout')
        return lower.fail(node, 'E_PACK', `${covered}, not ${name}()`);
      return lower.hostCall(name, node, b)!;
    },
  });
  return record;
}

/**
 * `new DOMContext(element)` of an element box, or of a getter, which the
 * constructor wraps as `boxWith(element)`.
 */
function newDomContext(node: ts.NewExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [element] = node.arguments ?? [];
  if (!element || node.arguments!.length !== 1)
    return lower.fail(node, 'E_PACK', `${LABEL}: new DOMContext takes the element's box`);
  const record = domContextRecord(lower);
  const want = lower.types.records[record].fields[0].type;
  if (lower.checker.getTypeAtLocation(element).getCallSignatures().length) {
    const t: Type = { maybe: 'element' };
    const fn = skipParens(element);
    const get =
      ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)
        ? lower.closure(fn, b, 'closure', [], t)
        : functionArg(element, b, lower, fnType([], t));
    return {
      op: 'record',
      record,
      fields: [
        {
          op: 'record',
          record: (want as { record: number }).record,
          fields: [get, { op: 'undefined', type: { maybe: fnType([t], 'void') } }],
        },
      ],
    };
  }
  const v = lower.expr(element, b);
  if (JSON.stringify(lower.irType(v, b)) !== JSON.stringify(want))
    return lower.fail(
      element,
      'E_PACK',
      `${LABEL}: new DOMContext takes a box of an element or null`,
    );
  return { op: 'record', record, fields: [v] };
}

/**
 * The values `mergeProps(...bags)` gives `key` where at most one bag may
 * hold it (dist/utils/merge-props.js): the first bag's as they are (the
 * result starts as a copy of it); a later bag's as merged into an absent
 * value, where it holds the key (`class`: `clsx(undefined, b)`, as null
 * and undefined are class values: a string's text, "" for null and
 * undefined; a value of another name replaces the absent one, undefined
 * included; event handlers, functions and `style`, which the result prints,
 * stay open). `hidden` and `disabled` set to false are then deleted.
 * Several bags holding it: open.
 */
function mergedValues(
  node: ts.CallExpression,
  key: string,
  of: (e: ts.Expression) => Shape,
  values: (e: ts.Expression) => unknown[] | undefined,
): unknown[] | undefined {
  const holding = node.arguments.flatMap((a, i) => (mayHold(of(a), key) ? [i] : []));
  if (!holding.length) return [ABSENT];
  if (holding.length > 1 || node.arguments.some(a => ts.isSpreadElement(a))) return undefined;
  if (key === 'style') return undefined;
  const [i] = holding;
  let v = values(node.arguments[i]);
  if (v && i > 0 && key.startsWith('on')) return undefined;
  if (v && i > 0 && key === 'class')
    v = v.every(x => x === ABSENT || x === undefined || x === null || typeof x === 'string')
      ? v.map(x => (x === ABSENT ? ABSENT : typeof x === 'string' ? x : ''))
      : undefined;
  return key === 'hidden' || key === 'disabled' ? v?.map(x => (x === false ? ABSENT : x)) : v;
}

/** `mergeProps(...bags)`. */
function mergeProps(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const args = node.arguments.map(a => {
    if (ts.isSpreadElement(a)) return lower.fail(a, 'E_PACK', `${LABEL}: spread arguments`);
    // An object literal is a bag of its entries (`{ type }`, `{ ...restProps }`).
    const literal = skipParens(a);
    if (ts.isObjectLiteralExpression(literal)) return lower.bagLiteral(literal, b);
    // (A plain record, as a spread takes it: bits-ui's tooltip content
    // merges its `floatingProps`, a derived object literal.)
    const v = lower.bagValue(a, b);
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
  let refValue = lower.expr(ref, b);
  let refType = lower.irType(refValue, b);
  const element: Type = { maybe: 'element' };
  const boxed = boxValue(lower, refType);
  // A setter with a result (bits-ui's menubar trigger `(v) =>
  // (state.triggerNode = v)`): attachRef calls it for its effect, the
  // result discarded.
  if (boxed === undefined) {
    const adapted = lower.adaptFunction(refValue, refType, fnType([element], 'void'));
    if (adapted) {
      refValue = adapted;
      refType = fnType([element], 'void');
    }
  }
  if (boxed !== undefined && JSON.stringify(boxed) !== JSON.stringify(element))
    lower.fail(ref, 'E_PACK', `${LABEL}: attachRef takes a box of an element or null`);
  if (boxed === undefined && JSON.stringify(refType) !== JSON.stringify(fnType([element], 'void')))
    lower.fail(ref, 'E_PACK', `${LABEL}: attachRef takes a box or a setter of an element or null`);
  // (It writes null through the box's setter.)
  if (boxed !== undefined) settersOf(lower).absent.add((refType as { record: number }).record);
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

/** `afterSleep(ms, cb)`: `setTimeout(cb, ms)` (the arguments evaluated in order). */
function afterSleep(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [ms, cb] = node.arguments;
  if (!ms || !cb || node.arguments.length !== 2)
    return lower.fail(node, 'E_PACK', `${LABEL}: afterSleep takes a delay and a function`);
  const delay = b.local('$ms', 'number');
  const f = b.local('$cb', fnType([], 'void'));
  return {
    op: 'with',
    local: delay,
    value: lower.coerce(ms, b, 'number'),
    body: {
      op: 'with',
      local: f,
      value: functionArg(cb, b, lower, fnType([], 'void')),
      body: {
        op: 'builtin',
        name: 'timer.timeout',
        args: [local(f), local(delay)],
        type: 'number',
      },
    },
  };
}

/** `executeCallbacks(...callbacks)` (see the header). */
function executeCallbacks(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const fnOf = (t: Type) => {
    const inner = maybeInner(t) ?? t;
    return typeof inner === 'object' && 'fn' in inner ? inner.fn : undefined;
  };
  // Each argument: a callback, or a spread array of callbacks (copied when
  // executeCallbacks is called, as its rest parameter is).
  const args = node.arguments.map(a => {
    if (ts.isSpreadElement(a)) {
      const array = lower.expr(a.expression, b);
      const type = lower.irType(array, b);
      const item = typeof type === 'object' && 'array' in type ? type.array : undefined;
      if (item === undefined || !fnOf(item))
        lower.fail(a, 'E_PACK', `${LABEL}: executeCallbacks takes arrays of functions spread`);
      return {
        value: {
          op: 'builtin',
          name: 'array.slice',
          args: [array, { op: 'lit', value: 0 }],
          type,
        } as Expr,
        type,
        callback: item!,
        spread: true,
      };
    }
    const value = lower.functionOf(lower.expr(a, b), b);
    const type = lower.irType(value, b);
    if (!fnOf(type)) lower.fail(a, 'E_PACK', `${LABEL}: executeCallbacks takes functions`);
    return { value, type, callback: type, spread: false };
  });
  const expected = lower.expected.get(node);
  const longest = args
    .map(a => fnOf(a.callback)!.params)
    .reduce((a, p) => (p.length > a.length ? p : a), [] as Type[]);
  const params = typeof expected === 'object' && 'fn' in expected ? expected.fn.params : longest;
  const same = (a: Type, c: Type) => JSON.stringify(a) === JSON.stringify(c);
  args.forEach((a, i) => {
    const p = fnOf(a.callback)!.params;
    if (p.length > params.length || !p.every((x, j) => same(x, params[j])))
      lower.fail(
        node.arguments[i],
        'E_PACK',
        `${LABEL}: executeCallbacks' callbacks take the first of the same parameters`,
      );
  });
  const n = args.length;
  const locals: Local[] = [];
  /** Calls callback `callee` of type `t` (skipped when undefined). */
  const call = (callee: Expr, t: Type): Stmt => {
    const callArgs = fnOf(t)!.params.map((_, j) => local(n + j));
    if (!maybeInner(t)) return { op: 'expr', value: { op: 'call-value', callee, args: callArgs } };
    return {
      op: 'if',
      test: {
        op: 'not',
        arg: { op: 'builtin', name: 'maybe.is-nullish', args: [callee], type: 'boolean' },
      },
      then: [
        {
          op: 'expr',
          value: { op: 'call-value', callee: { op: 'unwrap', value: callee }, args: callArgs },
        },
      ],
    };
  };
  const body: Stmt[] = args.map((a, i): Stmt => {
    if (!a.spread) return call(local(i), a.type);
    const item = n + params.length + locals.length;
    locals.push({ name: 'callback', type: a.callback });
    return { op: 'for-of', local: item, iterable: local(i), body: [call(local(item), a.callback)] };
  });
  const run = define(lower, {
    name: 'executeCallbacks$run',
    captures: args.map((a, i) => ({ name: `callback${i}`, type: a.type })),
    params: params.map((type, j) => ({ name: `arg${j}`, type })),
    locals,
    result: 'void',
    body,
  });
  const temps = args.map(a => b.local('$callback', a.type));
  let out: Expr = { op: 'closure', function: run, captures: temps };
  for (let i = n - 1; i >= 0; i--)
    out = { op: 'with', local: temps[i], value: args[i].value, body: out };
  return out;
}

/** `composeHandlers(...handlers)` (see the header). */
function composeHandlers(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const values = node.arguments.map(a => {
    if (ts.isSpreadElement(a))
      return lower.fail(a, 'E_PACK', `${LABEL}: composeHandlers takes the handlers one by one`);
    return lower.functionOf(lower.expr(a, b), b);
  });
  const types = values.map(v => lower.irType(v, b));
  const ok = (t: Type) => {
    const inner = maybeInner(t) ?? t;
    return (
      typeof inner === 'object' &&
      'fn' in inner &&
      (inner.fn.params.length === 0 ||
        (inner.fn.params.length === 1 && inner.fn.params[0] === 'event'))
    );
  };
  types.forEach((t, i) => {
    if (!ok(t))
      lower.fail(
        node.arguments[i],
        'E_PACK',
        `${LABEL}: composeHandlers takes functions of the event (or of nothing)`,
      );
  });
  const n = values.length;
  const event = local(n);
  const body: Stmt[] = [];
  types.forEach((t, i) => {
    const inner = (maybeInner(t) ?? t) as { fn: { params: Type[] } };
    const args = inner.fn.params.length ? [event] : [];
    const callee: Expr = maybeInner(t) ? { op: 'unwrap', value: local(i) } : local(i);
    const call: Stmt[] = [
      {
        op: 'if',
        test: { op: 'builtin', name: 'event.defaultPrevented', args: [event], type: 'boolean' },
        then: [{ op: 'return' }],
      },
      { op: 'expr', value: { op: 'call-value', callee, args } },
    ];
    body.push(
      ...(maybeInner(t)
        ? [
            {
              op: 'if',
              test: {
                op: 'not',
                arg: { op: 'builtin', name: 'maybe.is-nullish', args: [local(i)], type: 'boolean' },
              },
              then: call,
            } as Stmt,
          ]
        : call),
    );
  });
  const run = define(lower, {
    name: 'composeHandlers$run',
    captures: types.map((type, i) => ({ name: `handler${i}`, type })),
    params: [{ name: 'e', type: 'event' }],
    result: 'void',
    body,
  });
  const temps = types.map(t => b.local('$handler', t));
  let out: Expr = { op: 'closure', function: run, captures: temps };
  for (let i = n - 1; i >= 0; i--)
    out = { op: 'with', local: temps[i], value: values[i], body: out };
  return out;
}

/** `contains(parent, child)` (see the header). */
function contains(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [parent, child] = node.arguments;
  if (!parent || !child || node.arguments.length !== 2)
    return lower.fail(node, 'E_PACK', `${LABEL}: contains takes a parent and a child`);
  const p = lower.expr(parent, b);
  const c = lower.expr(child, b);
  const pl = b.local('$parent', lower.irType(p, b));
  const cl = b.local('$child', lower.irType(c, b));
  return {
    op: 'with',
    local: pl,
    value: p,
    body: {
      op: 'with',
      local: cl,
      value: c,
      body: lower.maybeElementTest(local(pl), b, parent, x =>
        lower.maybeElementTest(local(cl), b, child, y => ({
          op: 'builtin',
          name: 'element.contains',
          args: [x, y],
          type: 'boolean',
        })),
      ),
    },
  };
}

/** `onMountEffect(fn)`: an effect running `fn` untracked, its result the cleanup. */
function onMountEffect(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [fn] = node.arguments;
  const f = fn && node.arguments.length === 1 ? lower.expr(fn, b) : undefined;
  const t = f && lower.irType(f, b);
  const cleanup = fnType([], 'void');
  const result =
    typeof t === 'object' && 'fn' in t && !t.fn.params.length ? t.fn.result : undefined;
  const same = (x: Type | undefined, y: Type) => JSON.stringify(x) === JSON.stringify(y);
  if (
    !f ||
    !t ||
    result === undefined ||
    !(same(result, 'void') || same(result, cleanup) || same(result, { maybe: cleanup }))
  )
    return lower.fail(
      node,
      'E_PACK',
      `${LABEL}: onMountEffect takes a function without parameters returning a cleanup or nothing`,
    );
  const call: Expr = {
    op: 'builtin',
    name: 'reactive.untrack-call',
    args: [local(0)],
    type: result,
  };
  const run = define(lower, {
    name: 'onMountEffect$run',
    captures: [{ name: 'fn', type: t }],
    params: [],
    result,
    body: same(result, 'void') ? [{ op: 'expr', value: call }] : [{ op: 'return', value: call }],
  });
  const tmp = b.local('$onMount', t);
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
      case 'box':
      // simpleBox(initial) (dist/box/box-extras.svelte.js): a `$state` behind
      // a getter and a setter, as box(initial).
      case 'simpleBox':
        return { kind: 'function', call: box };
      case 'boxFrom':
        return { kind: 'function', call: boxFrom };
      case 'mergeProps':
        return {
          kind: 'function',
          call: mergeProps,
          shape: (node, of) => union(...node.arguments.map(of)),
          keyValues: mergedValues,
        };
      case 'attachRef':
        return { kind: 'function', call: attachRef, shape: () => emptyShape() };
      case 'afterTick':
        return { kind: 'function', call: afterTick };
      case 'onDestroyEffect':
        return { kind: 'function', call: onDestroyEffect };
      case 'onMountEffect':
        return { kind: 'function', call: onMountEffect };
      case 'afterSleep':
        return { kind: 'function', call: afterSleep };
      case 'executeCallbacks':
        return { kind: 'function', call: executeCallbacks };
      case 'composeHandlers':
        return { kind: 'function', call: composeHandlers };
      case 'contains':
        return { kind: 'function', call: contains };
      case 'srOnlyStyles':
        return { kind: 'constant', value: SR_ONLY_STYLES };
      // styleToString(style) (dist/utils/style.js): the style object's
      // `name: value;` text (`attrs.style-text`).
      case 'styleToString':
        return {
          kind: 'function',
          call: (n, b, l) => {
            const [arg] = n.arguments;
            if (!arg || n.arguments.length !== 1 || !ts.isObjectLiteralExpression(skipParens(arg)))
              return l.fail(n, 'E_PACK', `${LABEL}: styleToString takes a style object literal`);
            return {
              op: 'builtin',
              name: 'attrs.style-text',
              args: [l.styleValue(skipParens(arg) as ts.ObjectLiteralExpression, b)],
              type: 'string',
            };
          },
        };
      // getWindow(node) and getDocument(node) (dist/utils/dom.js): the
      // window and the document (an element's owner document is the
      // document, its default view the window). Their uses are the host's
      // (Lowerer.hostName); they are not values.
      case 'getWindow':
      case 'getDocument':
        return {
          kind: 'function',
          call: (n, _b, l) =>
            l.fail(
              n,
              'E_PACK',
              `${LABEL}: ${imported}(node) is the ${imported === 'getWindow' ? 'window' : 'document'}: use its members (${imported}(node).addEventListener(…)) or a const naming it`,
            ),
        };
      case 'DOMContext':
        return {
          kind: 'function',
          call: (n, _b, l) =>
            l.fail(n, 'E_PACK', `${LABEL}: DOMContext is a class (new DOMContext(box))`),
          construct: newDomContext,
        };
    }
    return `${LABEL} covers box, simpleBox, boxFrom, boxWith, mergeProps, attachRef, afterTick, afterSleep, executeCallbacks, composeHandlers, contains, onMountEffect, onDestroyEffect, srOnlyStyles, styleToString, getWindow, getDocument and DOMContext, not ${imported}`;
  },
  type(t, at, lower) {
    // DOMContext (dist/utils/dom-context.svelte.d.ts).
    const sym = t.getSymbol();
    if (
      sym?.name === 'DOMContext' &&
      /[\\/]svelte-toolbelt[\\/]dist[\\/]utils[\\/]dom-context\.svelte\.d\.ts$/.test(
        sym.declarations?.[0]?.getSourceFile().fileName ?? '',
      )
    )
      return { record: domContextRecord(lower) };
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
