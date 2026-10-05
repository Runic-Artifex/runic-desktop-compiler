// Mapping pack for @floating-ui/dom 1.7.4 (with @floating-ui/core 1.7.3 and
// @floating-ui/utils 0.2.10; docs/design/M6-OVERLAYS.md, "Decisions after
// step 1"): bits-ui's floating layer positions its content with
// `computePosition`, the middleware `offset`, `shift` (`limitShift`),
// `flip`, `size`, `arrow`, `hide` and custom middleware, and `autoUpdate`.
//
// - The positioning is native: `computePosition` is the built-in
//   `floating.compute`, which runs runic_js::floating (a port of core 1.7.3
//   validated by vectors computed with the real package) over the runtime's
//   port of dom 1.7.4's platform; every `await` of the JavaScript is a
//   microtask, so custom middleware and size's `apply` run when they would.
// - Middleware are records of runic_ir::floating's shapes: a factory call
//   builds one with its kind and options (an options record of every
//   middleware's options, the ones not given undefined, which are the
//   middleware's defaults). A custom middleware is an object literal with a
//   `name` and an `fn` (`{ name, options, fn(state) { … } }`, as bits-ui's
//   `transformOrigin` writes it); its `options` are not part of the record
//   (core never reads them; the program may not either), and its data is a
//   record of the keys its `fn` returns, all nullable, shared by all custom
//   middleware of the program.
// - `middlewareData` is a record of the six middleware's data and one entry
//   per custom middleware name; the platform object (`state.platform`) and
//   resets from custom middleware are not covered.
// - `autoUpdate(reference, floating, update, options)` is
//   floating-ui-dom-1.7.4/auto-update.ts, a port compiled with the program.
//
// Rejected (E_PACK): the other exports (`detectOverflow`, `autoPlacement`,
// `inline`, `platform`, `getOverflowAncestors`), options given as functions of
// the state (`Derivable`), `rootBoundary` rectangles, virtual elements.
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Expr, RecordType, Type } from '../ir.ts';
import { skipParens, type FnBuilder, type Lowerer } from '../language.ts';
import type { Pack } from '../packs.ts';
import { maybeInner } from '../irtype.ts';

const LABEL = '@floating-ui/dom@1.7.4 pack';
const N: Type = 'number';
const S: Type = 'string';
const B: Type = 'boolean';
const maybe = (t: Type): Type => ({ maybe: t });
const record = (r: number): Type => ({ record: r });

/** The options record's fields (runic_ir::floating::OPTIONS), in order. */
const OPTIONS: [string, Type][] = [
  ['value', maybe(N)],
  ['mainAxisOffset', maybe(N)],
  ['crossAxisOffset', maybe(N)],
  ['alignmentAxis', maybe(N)],
  ['mainAxis', maybe(B)],
  ['crossAxis', maybe(B)],
  ['crossAxisAlignment', maybe(B)],
  ['limiter', 'void'], // the limiter record (set below)
  ['padding', maybe(N)],
  ['paddingSides', 'void'], // the partial sides record (set below)
  ['boundary', maybe({ array: 'element' })],
  ['rootBoundary', maybe(S)],
  ['elementContext', maybe(S)],
  ['altBoundary', maybe(B)],
  ['fallbackPlacements', maybe({ array: S })],
  ['fallbackStrategy', maybe(S)],
  ['fallbackAxisSideDirection', maybe(S)],
  ['flipAlignment', maybe(B)],
  ['apply', 'void'], // (applyState) => void (set below)
  ['element', maybe('element')],
  ['strategy', maybe(S)],
];
const field = (name: string) => OPTIONS.findIndex(o => o[0] === name);

const KIND = { custom: 0, offset: 1, shift: 2, flip: 3, size: 4, arrow: 5, hide: 6 } as const;

interface Records {
  rect: number;
  elementRects: number;
  elements: number;
  sideObject: number;
  middlewareData: number;
  customData: number;
  customNames: string[];
  state: number;
  applyState: number;
  ret: number;
  position: number;
  limiter: number;
  paddingSides: number;
  options: number;
  middleware: number;
}

const programs = new WeakMap<Lowerer, Records>();

/** A custom middleware literal: `{ name: "…", options?, fn(state) { … } }`. */
function customMiddleware(
  e: ts.ObjectLiteralExpression,
): { name: string; fn: ts.FunctionLikeDeclaration } | undefined {
  let name: string | undefined;
  let fn: ts.FunctionLikeDeclaration | undefined;
  for (const p of e.properties) {
    const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
    if (key === 'name' && ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer))
      name = p.initializer.text;
    else if (key === 'fn' && ts.isMethodDeclaration(p)) fn = p;
    else if (
      key === 'fn' &&
      ts.isPropertyAssignment(p) &&
      (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))
    )
      fn = p.initializer;
    else if (key !== 'options') return undefined;
  }
  return name !== undefined && fn ? { name, fn } : undefined;
}

/** The object literals a function returns. */
function returnedObjects(fn: ts.FunctionLikeDeclaration): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const add = (e: ts.Expression | undefined) => {
    const x = e && skipParens(e);
    if (x && ts.isObjectLiteralExpression(x)) out.push(x);
  };
  if (fn.body && !ts.isBlock(fn.body)) add(fn.body as ts.Expression);
  const visit = (n: ts.Node) => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) add(n.expression);
    ts.forEachChild(n, visit);
  };
  if (fn.body && ts.isBlock(fn.body)) fn.body.statements.forEach(visit);
  return out;
}

/** The program's floating records, created on first use. */
function records(lower: Lowerer, at: ts.Node): Records {
  const known = programs.get(lower);
  if (known) return known;
  const push = (name: string, fields: [string, Type][]): number => {
    lower.types.records.push({
      name,
      fields: fields.map(([n, type]) => ({ name: n, type })),
    } as RecordType);
    const r = lower.types.records.length - 1;
    lower.types.packageRecords.add(r);
    return r;
  };
  // Custom middleware of the program: their names, and the keys their `fn`s
  // return as data (one record for all, every key nullable).
  const names: string[] = [];
  const keys = new Map<string, Type>();
  for (const sf of lower.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const custom = customMiddleware(n);
        if (custom) {
          if (Object.values(KIND).length && Object.keys(KIND).includes(custom.name))
            lower.fail(n, 'E_PACK', `${LABEL}: a custom middleware named ${custom.name}`);
          if (!names.includes(custom.name)) names.push(custom.name);
          for (const r of returnedObjects(custom.fn))
            for (const p of r.properties) {
              if (!(p.name && ts.isIdentifier(p.name) && p.name.text === 'data')) continue;
              const data = ts.isPropertyAssignment(p) ? skipParens(p.initializer) : undefined;
              if (!data || !ts.isObjectLiteralExpression(data))
                lower.fail(p, 'E_PACK', `${LABEL}: custom middleware data is an object literal`);
              for (const q of (data as ts.ObjectLiteralExpression).properties) {
                const key = q.name && ts.isIdentifier(q.name) ? q.name.text : undefined;
                if (!key || !(ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)))
                  lower.fail(q, 'E_PACK', `${LABEL}: custom middleware data has static keys`);
                const t = lower.checker.getBaseTypeOfLiteralType(
                  lower.checker.getTypeAtLocation(q.name!),
                );
                const mapped = lower.types.tryMap(t, q);
                if (mapped === undefined)
                  lower.fail(q, 'E_PACK', `${LABEL}: the type of custom middleware data ${key}`);
                const inner = maybeInner(mapped!) ?? mapped!;
                const was = keys.get(key!);
                if (was !== undefined && JSON.stringify(was) !== JSON.stringify(inner))
                  lower.fail(q, 'E_PACK', `${LABEL}: custom middleware data ${key} of two types`);
                keys.set(key!, inner);
              }
            }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const rect = push('Rect', [
    ['x', N],
    ['y', N],
    ['width', N],
    ['height', N],
  ]);
  const elementRects = push('ElementRects', [
    ['reference', record(rect)],
    ['floating', record(rect)],
  ]);
  const elements = push('Elements', [
    ['reference', 'element'],
    ['floating', 'element'],
  ]);
  const sideObject = push('SideObject', [
    ['top', N],
    ['right', N],
    ['bottom', N],
    ['left', N],
  ]);
  const offsetData = push('OffsetData', [
    ['x', N],
    ['y', N],
    ['placement', S],
  ]);
  const shiftEnabled = push('ShiftEnabled', [
    ['x', B],
    ['y', B],
  ]);
  const shiftData = push('ShiftData', [
    ['x', N],
    ['y', N],
    ['enabled', record(shiftEnabled)],
  ]);
  const flipOverflow = push('FlipOverflow', [
    ['placement', S],
    ['overflows', { array: N }],
  ]);
  const flipData = push('FlipData', [
    ['index', maybe(N)],
    ['overflows', maybe({ array: record(flipOverflow) })],
  ]);
  const sizeData = push('SizeData', []);
  const arrowData = push('ArrowData', [
    ['x', maybe(N)],
    ['y', maybe(N)],
    ['centerOffset', maybe(N)],
    ['alignmentOffset', maybe(N)],
  ]);
  const hideData = push('HideData', [
    ['referenceHiddenOffsets', maybe(record(sideObject))],
    ['referenceHidden', maybe(B)],
    ['escapedOffsets', maybe(record(sideObject))],
    ['escaped', maybe(B)],
  ]);
  const customData = push(
    'MiddlewareCustomData',
    [...keys].map(([k, t]) => [k, maybe(t)] as [string, Type]),
  );
  const middlewareData = push('MiddlewareData', [
    ['offset', maybe(record(offsetData))],
    ['shift', maybe(record(shiftData))],
    ['flip', maybe(record(flipData))],
    ['size', maybe(record(sizeData))],
    ['arrow', maybe(record(arrowData))],
    ['hide', maybe(record(hideData))],
    ...names.map(n => [n, maybe(record(customData))] as [string, Type]),
  ]);
  const stateFields: [string, Type][] = [
    ['x', N],
    ['y', N],
    ['initialPlacement', S],
    ['placement', S],
    ['strategy', S],
    ['middlewareData', record(middlewareData)],
    ['rects', record(elementRects)],
    ['elements', record(elements)],
  ];
  const state = push('MiddlewareState', stateFields);
  const applyState = push('SizeApplyState', [
    ...stateFields,
    ['availableWidth', N],
    ['availableHeight', N],
  ]);
  const ret = push('MiddlewareReturn', [
    ['x', maybe(N)],
    ['y', maybe(N)],
    ['data', maybe(record(customData))],
  ]);
  const position = push('ComputePositionReturn', [
    ['x', N],
    ['y', N],
    ['placement', S],
    ['strategy', S],
    ['middlewareData', record(middlewareData)],
  ]);
  const limiter = push('LimitShiftOptions', [
    ['offset', maybe(N)],
    ['offsetMainAxis', maybe(N)],
    ['offsetCrossAxis', maybe(N)],
    ['mainAxis', maybe(B)],
    ['crossAxis', maybe(B)],
  ]);
  const paddingSides = push('PaddingSides', [
    ['top', maybe(N)],
    ['right', maybe(N)],
    ['bottom', maybe(N)],
    ['left', maybe(N)],
  ]);
  const options = push(
    'MiddlewareOptions',
    OPTIONS.map(([n, t]): [string, Type] => [
      n,
      n === 'limiter'
        ? maybe(record(limiter))
        : n === 'paddingSides'
          ? maybe(record(paddingSides))
          : n === 'apply'
            ? maybe({ fn: { params: [record(applyState)], result: 'void' } })
            : t,
    ]),
  );
  const middleware = push('Middleware', [
    ['name', S],
    ['kind', N],
    ['options', record(options)],
    ['fn', maybe({ fn: { params: [record(state)], result: record(ret) } })],
  ]);
  const out: Records = {
    rect,
    elementRects,
    elements,
    sideObject,
    middlewareData,
    customData,
    customNames: names,
    state,
    applyState,
    ret,
    position,
    limiter,
    paddingSides,
    options,
    middleware,
  };
  programs.set(lower, out);
  // Custom middleware literals become middleware records.
  lower.recordLiterals.set(middleware, (e, b) => customLiteral(lower, out, e, b));
  // Reading a middleware's members other than its name is not covered.
  lower.recordMembers.set(middleware, {
    read(name, object, node) {
      if (name === 'name') return { op: 'get', object, field: 0 };
      return lower.fail(node, 'E_PACK', `${LABEL}: a middleware's ${name} is not covered`);
    },
    write(name, _object, _value, node) {
      return lower.fail(node, 'E_PACK', `${LABEL}: a middleware's ${name} cannot be assigned`);
    },
  });
  void at;
  return out;
}

/** An options record with `given` fields (the others undefined). */
function optionsRecord(r: Records, lower: Lowerer, given: Map<string, Expr>): Expr {
  const fields = lower.types.records[r.options].fields;
  return {
    op: 'record',
    record: r.options,
    fields: fields.map(f => given.get(f.name) ?? { op: 'undefined', type: f.type }),
  };
}

/** A middleware record of `kind` named `name` with options `given`. */
function middlewareRecord(
  r: Records,
  lower: Lowerer,
  name: string,
  kind: number,
  given: Map<string, Expr>,
): Expr {
  return {
    op: 'record',
    record: r.middleware,
    fields: [
      { op: 'lit', value: name },
      { op: 'lit', value: kind },
      optionsRecord(r, lower, given),
      { op: 'undefined', type: lower.types.records[r.middleware].fields[3].type },
    ],
  };
}

/** `{ name, options, fn(state) { … } }` as a middleware record. */
function customLiteral(
  lower: Lowerer,
  r: Records,
  e: ts.ObjectLiteralExpression,
  b: FnBuilder,
): Expr {
  const custom = customMiddleware(e);
  if (!custom)
    return lower.fail(
      e,
      'E_PACK',
      `${LABEL}: a custom middleware is { name: "…", options, fn(state) { … } }`,
    );
  for (const p of e.properties)
    if (
      p.name &&
      ts.isIdentifier(p.name) &&
      p.name.text === 'options' &&
      !(
        ts.isShorthandPropertyAssignment(p) ||
        ts.isIdentifier(skipParens((p as ts.PropertyAssignment).initializer))
      )
    )
      lower.fail(
        p,
        'E_PACK',
        `${LABEL}: custom middleware options are a name (core never reads them)`,
      );
  const fnType = lower.types.records[r.middleware].fields[3].type;
  const want = maybeInner(fnType)!;
  lower.expected.set(custom.fn, want);
  const f = want as { fn: { params: Type[]; result: Type } };
  const closure = lower.closure(custom.fn, b, `${custom.name}.fn`, f.fn.params, f.fn.result);
  return {
    op: 'record',
    record: r.middleware,
    fields: [
      { op: 'lit', value: custom.name },
      { op: 'lit', value: KIND.custom },
      optionsRecord(r, lower, new Map()),
      { op: 'some', value: closure },
    ],
  };
}

/** The type of option `name` in the options record. */
const optionType = (r: Records, lower: Lowerer, name: string): Type =>
  lower.types.records[r.options].fields[field(name)].type;

/**
 * The entries of an options object literal (spreads of records give their
 * fields), in evaluation order, each bound to a temporary; later keys win.
 */
function entries(
  lower: Lowerer,
  arg: ts.Expression,
  b: FnBuilder,
): {
  values: Map<
    string,
    {
      node: ts.Node;
      expr?: ts.Expression;
      method?: ts.MethodDeclaration;
      value?: Expr;
      type?: Type;
    }
  >;
} {
  const values = new Map<
    string,
    {
      node: ts.Node;
      expr?: ts.Expression;
      method?: ts.MethodDeclaration;
      value?: Expr;
      type?: Type;
    }
  >();
  const o = skipParens(arg);
  if (!ts.isObjectLiteralExpression(o))
    return lower.fail(arg, 'E_PACK', `${LABEL}: options are an object literal`);
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) {
      const v = lower.expr(p.expression, b);
      const t = lower.irType(v, b);
      if (!(typeof t === 'object' && 'record' in t))
        return lower.fail(p, 'E_PACK', `${LABEL}: options spread records`);
      const tmp = b.local('$options', t);
      lower.types.records[t.record].fields.forEach((f, j) =>
        values.set(f.name, {
          node: p,
          value: { op: 'get', object: { op: 'local', local: tmp }, field: j },
          type: f.type,
        }),
      );
      values.set(`\0tmp${tmp}`, { node: p, value: v, type: t });
      continue;
    }
    const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
    if (!key) return lower.fail(p, 'E_PACK', `${LABEL}: options have static keys`);
    if (ts.isPropertyAssignment(p)) values.set(key, { node: p, expr: p.initializer });
    else if (ts.isShorthandPropertyAssignment(p)) values.set(key, { node: p, expr: p.name });
    // A method (`apply({ availableHeight }) { … }`): a function value.
    else if (ts.isMethodDeclaration(p)) values.set(key, { node: p, method: p });
    else return lower.fail(p, 'E_PACK', `${LABEL}: option ${key} is a value`);
  }
  return { values };
}

/** Lower the options of a middleware factory call into its options' given fields. */
function lowerOptions(
  lower: Lowerer,
  r: Records,
  kind: keyof typeof KIND,
  arg: ts.Expression | undefined,
  b: FnBuilder,
  node: ts.Node,
): { given: Map<string, Expr>; temps: { local: number; value: Expr }[] } {
  const given = new Map<string, Expr>();
  const temps: { local: number; value: Expr }[] = [];
  if (!arg) {
    if (kind === 'offset') given.set('value', { op: 'some', value: { op: 'lit', value: 0 } });
    if (kind === 'arrow') lower.fail(node, 'E_PACK', `${LABEL}: arrow takes options`);
    return { given, temps };
  }
  // offset(number).
  if (kind === 'offset' && !ts.isObjectLiteralExpression(skipParens(arg))) {
    given.set('value', lower.coerce(arg, b, maybe(N)));
    return { given, temps };
  }
  const { values } = entries(lower, arg, b);
  // Bind spread sources first (their temporaries are named in values).
  for (const [k, v] of values)
    if (k.startsWith('\0tmp')) temps.push({ local: Number(k.slice(4)), value: v.value! });
  const set = (
    target: string,
    v: {
      node: ts.Node;
      expr?: ts.Expression;
      method?: ts.MethodDeclaration;
      value?: Expr;
      type?: Type;
    },
  ) => {
    const want = optionType(r, lower, target);
    if (v.method) {
      const fn = maybeInner(want) ?? want;
      if (typeof fn !== 'object' || !('fn' in fn))
        return lower.fail(v.node, 'E_PACK', `${LABEL}: option ${target} is not a function`);
      const closure = lower.closure(v.method, b, target, fn.fn.params, fn.fn.result);
      given.set(target, maybeInner(want) ? { op: 'some', value: closure } : closure);
      return;
    }
    if (v.expr) {
      lower.expected.set(skipParens(v.expr), maybeInner(want) ?? want);
      given.set(target, lower.coerce(v.expr, b, want));
      return;
    }
    const have = v.type!;
    if (JSON.stringify(have) === JSON.stringify(want)) given.set(target, v.value!);
    else if (JSON.stringify(maybe(have)) === JSON.stringify(want))
      given.set(target, { op: 'some', value: v.value! });
    else lower.fail(v.node, 'E_PACK', `${LABEL}: option ${target} of type ${JSON.stringify(have)}`);
  };
  const overflowKeys = ['padding', 'boundary', 'rootBoundary', 'elementContext', 'altBoundary'];
  const allowed: Record<keyof typeof KIND, string[]> = {
    custom: [],
    offset: ['mainAxis', 'crossAxis', 'alignmentAxis'],
    shift: ['mainAxis', 'crossAxis', 'limiter', ...overflowKeys],
    flip: [
      'mainAxis',
      'crossAxis',
      'fallbackPlacements',
      'fallbackStrategy',
      'fallbackAxisSideDirection',
      'flipAlignment',
      ...overflowKeys,
    ],
    size: ['apply', ...overflowKeys],
    arrow: ['element', 'padding'],
    hide: ['strategy', ...overflowKeys],
  };
  for (const [key, v] of values) {
    if (key.startsWith('\0')) continue;
    if (!allowed[kind].includes(key))
      lower.fail(v.node, 'E_PACK', `${LABEL}: ${kind} option ${key} is not covered`);
    if (kind === 'offset')
      set({ mainAxis: 'mainAxisOffset', crossAxis: 'crossAxisOffset' }[key] ?? key, v);
    else if (
      key === 'crossAxis' &&
      kind === 'flip' &&
      v.expr &&
      ts.isStringLiteralLike(skipParens(v.expr))
    ) {
      if ((skipParens(v.expr) as ts.StringLiteral).text !== 'alignment')
        lower.fail(v.node, 'E_PACK', `${LABEL}: flip crossAxis is a boolean or 'alignment'`);
      given.set('crossAxisAlignment', { op: 'some', value: { op: 'lit', value: true } });
    } else if (key === 'limiter') given.set('limiter', limiterValue(lower, r, v.expr, v.node, b));
    else if (key === 'padding') {
      const t = v.expr ? lower.types.typeOrUndefined(v.expr) : v.type;
      if (t === N || maybeInner(t ?? 'void') === N) set('padding', v);
      else if (v.expr && ts.isObjectLiteralExpression(skipParens(v.expr)))
        given.set('paddingSides', { op: 'some', value: sides(lower, r, v.expr, b) });
      else lower.fail(v.node, 'E_PACK', `${LABEL}: padding is a number or an object literal`);
    } else if (key === 'boundary') {
      const x = v.expr && skipParens(v.expr);
      if (x && ts.isStringLiteralLike(x)) {
        if (x.text !== 'clippingAncestors')
          lower.fail(v.node, 'E_PACK', `${LABEL}: boundary 'clippingAncestors' or elements`);
      } else set('boundary', v);
    } else if (key === 'rootBoundary') {
      const x = v.expr && skipParens(v.expr);
      if (!x || !ts.isStringLiteralLike(x) || !['viewport', 'document'].includes(x.text))
        lower.fail(v.node, 'E_PACK', `${LABEL}: rootBoundary 'viewport' or 'document'`);
      set('rootBoundary', v);
    } else set(key, v);
  }
  return { given, temps };
}

/** A partial side object literal as the padding sides record. */
function sides(lower: Lowerer, r: Records, e: ts.Expression, b: FnBuilder): Expr {
  const o = skipParens(e) as ts.ObjectLiteralExpression;
  const given = new Map<string, Expr>();
  for (const p of o.properties) {
    const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
    if (!key || !['top', 'right', 'bottom', 'left'].includes(key) || !ts.isPropertyAssignment(p))
      return lower.fail(p, 'E_PACK', `${LABEL}: padding sides are top, right, bottom, left`);
    given.set(key, lower.coerce(p.initializer, b, maybe(N)));
  }
  return {
    op: 'record',
    record: r.paddingSides,
    fields: ['top', 'right', 'bottom', 'left'].map(
      k => given.get(k) ?? ({ op: 'undefined', type: maybe(N) } as Expr),
    ),
  };
}

/** `limitShift(options?)`, `undefined`, or a conditional of them, as the limiter option. */
function limiterValue(
  lower: Lowerer,
  r: Records,
  e: ts.Expression | undefined,
  at: ts.Node,
  b: FnBuilder,
): Expr {
  const t = maybe(record(r.limiter));
  const x = e && skipParens(e);
  if (!x) return lower.fail(at, 'E_PACK', `${LABEL}: the limiter is limitShift()`);
  if (x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined'))
    return { op: 'undefined', type: t };
  if (ts.isConditionalExpression(x))
    return {
      op: 'cond',
      test: lower.condition(x.condition, b),
      then: limiterValue(lower, r, x.whenTrue, at, b),
      else: limiterValue(lower, r, x.whenFalse, at, b),
    };
  if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) {
    const binding = lower.binding(x.expression);
    if (binding?.kind === 'pack' && binding.label.startsWith('limitShift'))
      return { op: 'some', value: limitShift(lower, r, x, b) };
  }
  return lower.fail(x, 'E_PACK', `${LABEL}: the limiter is limitShift() (or undefined)`);
}

/** `limitShift(options?)` as a limiter record. */
function limitShift(lower: Lowerer, r: Records, node: ts.CallExpression, b: FnBuilder): Expr {
  const [arg] = node.arguments;
  const given = new Map<string, Expr>();
  if (arg) {
    const o = skipParens(arg);
    if (!ts.isObjectLiteralExpression(o))
      return lower.fail(arg, 'E_PACK', `${LABEL}: limitShift options are an object literal`);
    for (const p of o.properties) {
      const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
      if (!key || !ts.isPropertyAssignment(p))
        return lower.fail(p, 'E_PACK', `${LABEL}: limitShift options have static keys`);
      if (key === 'mainAxis' || key === 'crossAxis')
        given.set(key, lower.coerce(p.initializer, b, maybe(B)));
      else if (key === 'offset') {
        const v = skipParens(p.initializer);
        if (ts.isObjectLiteralExpression(v)) {
          for (const q of v.properties) {
            const k = q.name && ts.isIdentifier(q.name) ? q.name.text : undefined;
            if (!k || !['mainAxis', 'crossAxis'].includes(k) || !ts.isPropertyAssignment(q))
              return lower.fail(
                q,
                'E_PACK',
                `${LABEL}: limitShift offset is { mainAxis, crossAxis }`,
              );
            given.set(
              k === 'mainAxis' ? 'offsetMainAxis' : 'offsetCrossAxis',
              lower.coerce(q.initializer, b, maybe(N)),
            );
          }
        } else given.set('offset', lower.coerce(p.initializer, b, maybe(N)));
      } else return lower.fail(p, 'E_PACK', `${LABEL}: limitShift option ${key} is not covered`);
    }
  }
  const names = ['offset', 'offsetMainAxis', 'offsetCrossAxis', 'mainAxis', 'crossAxis'];
  return {
    op: 'record',
    record: r.limiter,
    fields: names.map(
      (n, i) =>
        given.get(n) ??
        ({ op: 'undefined', type: lower.types.records[r.limiter].fields[i].type } as Expr),
    ),
  };
}

/** A middleware factory (`offset(…)`, `shift(…)`, …). */
function factory(kind: Exclude<keyof typeof KIND, 'custom'>) {
  return (node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr => {
    if (node.arguments.length > 1 || node.arguments.some(ts.isSpreadElement))
      return lower.fail(node, 'E_PACK', `${LABEL}: ${kind} takes options`);
    const [arg] = node.arguments;
    if (arg) {
      const t = lower.checker.getTypeAtLocation(arg);
      if (t.getCallSignatures().length)
        return lower.fail(
          arg,
          'E_PACK',
          `${LABEL}: options computed from the state are not covered`,
        );
    }
    const r = records(lower, node);
    const { given, temps } = lowerOptions(lower, r, kind, arg, b, node);
    let out = middlewareRecord(r, lower, kind, KIND[kind], given);
    for (const t of temps.reverse())
      out = { op: 'with', local: t.local, value: t.value, body: out };
    return out;
  };
}

/** `computePosition(reference, floating, { middleware, placement, strategy })`. */
function computePosition(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const [reference, floating, options] = node.arguments;
  if (!reference || !floating || node.arguments.length > 3)
    return lower.fail(node, 'E_PACK', `${LABEL}: computePosition takes two elements and options`);
  const r = records(lower, node);
  let middleware: Expr = { op: 'array', type: { array: record(r.middleware) }, items: [] };
  let placement: Expr = { op: 'lit', value: 'bottom' };
  let strategy: Expr = { op: 'lit', value: 'absolute' };
  if (options) {
    const o = skipParens(options);
    if (!ts.isObjectLiteralExpression(o))
      return lower.fail(
        options,
        'E_PACK',
        `${LABEL}: computePosition options are an object literal`,
      );
    for (const p of o.properties) {
      const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
      const value = ts.isPropertyAssignment(p)
        ? p.initializer
        : ts.isShorthandPropertyAssignment(p)
          ? p.name
          : undefined;
      if (!key || !value)
        return lower.fail(p, 'E_PACK', `${LABEL}: computePosition options have static keys`);
      if (key === 'middleware') {
        const m = record(r.middleware);
        lower.expected.set(skipParens(value), { array: m });
        middleware = lower.coerce(value, b, { array: m });
        // Middleware that may be absent (\`Array<Middleware | null |
        // undefined | false>\`): computePosition skips falsy entries
        // (\`middleware.filter(Boolean)\`).
        const mt = lower.irType(middleware, b);
        if (JSON.stringify(mt) === JSON.stringify({ array: { maybe: m } })) {
          const keep = lower.reserve();
          lower.functions[keep] = {
            name: 'floating$present',
            params: [{ name: 'm', type: { maybe: m } }],
            locals: [],
            result: 'boolean',
            body: [
              {
                op: 'return',
                value: {
                  op: 'not',
                  arg: {
                    op: 'builtin',
                    name: 'maybe.is-nullish',
                    args: [{ op: 'local', local: 0 }],
                    type: 'boolean',
                  },
                },
              },
            ],
          };
          const unwrap = lower.reserve();
          lower.functions[unwrap] = {
            name: 'floating$middleware',
            params: [{ name: 'm', type: { maybe: m } }],
            locals: [],
            result: m,
            body: [{ op: 'return', value: { op: 'unwrap', value: { op: 'local', local: 0 } } }],
          };
          middleware = {
            op: 'builtin',
            name: 'array.map',
            args: [
              {
                op: 'builtin',
                name: 'array.filter',
                args: [middleware, { op: 'closure', function: keep, captures: [] }],
                type: { array: { maybe: m } },
              },
              { op: 'closure', function: unwrap, captures: [] },
            ],
            type: { array: m },
          };
        }
      } else if (key === 'placement') placement = lower.coerce(value, b, S);
      else if (key === 'strategy') strategy = lower.coerce(value, b, S);
      else return lower.fail(p, 'E_PACK', `${LABEL}: computePosition option ${key} is not covered`);
    }
  }
  return {
    op: 'builtin',
    name: 'floating.compute',
    args: [
      lower.coerce(reference, b, 'element'),
      lower.coerce(floating, b, 'element'),
      middleware,
      placement,
      strategy,
    ],
    type: { promise: record(r.position) },
  };
}

/** The port of autoUpdate (floating-ui-dom-1.7.4/auto-update.ts). */
const AUTO_UPDATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'floating-ui-dom-1.7.4/auto-update.ts',
);

/** `autoUpdate(reference, floating, update, options?)`: the port's function. */
function autoUpdate(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  const sf = lower.program.getSourceFile(AUTO_UPDATE);
  const module = sf && lower.checker.getSymbolAtLocation(sf);
  const sym = module && lower.checker.getExportsOfModule(module).find(s => s.name === 'autoUpdate');
  const binding = sym && lower.bindingOf(sym);
  if (binding?.kind !== 'function')
    return lower.fail(node, 'E_PACK', `${LABEL}: the autoUpdate port is not part of the program`);
  return { op: 'call', function: binding.fn, args: lower.callArgs(node, b) };
}

/** The pack's record for floating-ui's type `t`, if it is one. */
function packType(t: ts.Type, at: ts.Node, lower: Lowerer): Type | undefined {
  // `Readonly<MiddlewareData>` (bits-ui's useFloating) is the type itself.
  const of = t.aliasTypeArguments?.[0];
  if (t.aliasSymbol?.name === 'Readonly' && of) return packType(of, at, lower);
  // Declared by floating-ui (its aliases are mapped types: `Prettify<…>`).
  const decls = [
    ...(t.aliasSymbol?.declarations ?? []),
    ...(t.getSymbol()?.declarations ?? []),
    ...(t.isIntersection() ? t.types.flatMap(m => m.getSymbol()?.declarations ?? []) : []),
  ];
  const ours = decls.some(d =>
    /[\\/]node_modules[\\/]@floating-ui[\\/](core|dom|utils)[\\/]/.test(d.getSourceFile().fileName),
  );
  if (!ours) return undefined;
  const props = new Set(lower.checker.getPropertiesOfType(t).map(p => p.name));
  const has = (...names: string[]) => names.every(n => props.has(n));
  const exactly = (...names: string[]) => props.size === names.length && has(...names);
  const r = (): Records => records(lower, at);
  const state = [
    'x',
    'y',
    'initialPlacement',
    'placement',
    'strategy',
    'middlewareData',
    'elements',
    'rects',
  ];
  if (exactly('name', 'options', 'fn')) return record(r().middleware);
  if (has(...state) && has('availableWidth', 'availableHeight')) return record(r().applyState);
  if (has(...state)) return record(r().state);
  const name = (t.aliasSymbol ?? t.getSymbol())?.name;
  if (name === 'MiddlewareData') return record(r().middlewareData);
  // The built-in middleware's data (MiddlewareData's entries, in order
  // offset, shift, flip, size, arrow, hide).
  const entry = (i: number): Type =>
    maybeInner(lower.types.records[r().middlewareData].fields[i].type)!;
  const inner = (t: Type, i: number): Type => {
    const f = lower.types.records[(t as { record: number }).record].fields[i].type;
    return maybeInner(f) ?? f;
  };
  const booleanProp = (n: string) =>
    !!(lower.checker.getTypeOfSymbol(t.getProperty(n)!).flags & ts.TypeFlags.BooleanLike);
  if (exactly('x', 'y', 'placement')) return entry(0);
  if (exactly('x', 'y', 'enabled')) return entry(1);
  if (exactly('x', 'y') && booleanProp('x')) return inner(entry(1), 2);
  if (exactly('index', 'overflows')) return entry(2);
  if (exactly('placement', 'overflows')) {
    const list = inner(entry(2), 1) as { array: Type };
    return list.array;
  }
  if (has('centerOffset')) return entry(4);
  if (has('referenceHidden') || has('escaped')) return entry(5);
  if (name === 'MiddlewareReturn') return record(r().ret);
  if (exactly('x', 'y', 'placement', 'strategy', 'middlewareData')) return record(r().position);
  if (exactly('reference', 'floating') && name === 'ElementRects') return record(r().elementRects);
  if (exactly('reference', 'floating')) return record(r().elements);
  if (exactly('x', 'y', 'width', 'height')) return record(r().rect);
  if (exactly('top', 'right', 'bottom', 'left')) return record(r().sideObject);
  return undefined;
}

export const floatingUiDomPack: Pack = {
  name: '@floating-ui/dom',
  version: '1.7.4',
  module: import.meta.url,
  // autoUpdate's port (a module of its own; the package's is one bundle).
  ports: [{ module: 'runic-port/auto-update.js', file: AUTO_UPDATE }],
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    switch (imported) {
      case 'computePosition':
        return { kind: 'function', call: computePosition };
      case 'autoUpdate':
        return { kind: 'function', call: autoUpdate };
      case 'offset':
      case 'shift':
      case 'flip':
      case 'size':
      case 'arrow':
      case 'hide':
        return { kind: 'function', call: factory(imported) };
      // getOverflowAncestors(element): its scrolling ancestor elements (the
      // window and visual viewport that end floating-ui's list are not
      // elements: only the autoUpdate port, which knows, imports it).
      case 'getOverflowAncestors':
        return {
          kind: 'function',
          call: (n, b, l) => {
            const [el] = n.arguments;
            if (!el || n.arguments.length !== 1)
              return l.fail(n, 'E_PACK', `${LABEL}: getOverflowAncestors takes an element`);
            return {
              op: 'builtin',
              name: 'floating.overflow-ancestors',
              args: [l.coerce(el, b, 'element')],
              type: { array: 'element' },
            };
          },
        };
      case 'limitShift':
        return {
          kind: 'function',
          call: (n, _b, l) =>
            l.fail(n, 'E_PACK', `${LABEL}: limitShift() is a shift option (limiter)`),
        };
    }
    return `${LABEL} covers computePosition, autoUpdate, offset, shift, limitShift, flip, size, arrow and hide, not ${imported}`;
  },
  type: packType,
};
