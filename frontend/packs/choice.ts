// Build-time evaluation over finite arguments (docs/design/M6-LIBRARIES.md#mapping-packs-d9).
//
// A pack whose functions are evaluated by running the real package in Node
// (tailwind-merge, tailwind-variants) lowers a call by enumerating the exact
// JavaScript values its arguments can take, calling the package once for each
// combination and selecting the result at runtime. The values form a choice
// tree: leaves are exact JavaScript values; inner nodes are IR tests that the
// program evaluates, in JavaScript's evaluation order, to reach the leaf that
// holds the values the arguments really have.
//
// An argument's choice comes from its syntax and, where the syntax ends, from
// its TypeScript type:
// - literals (strings, numbers, booleans, null, undefined), array and object
//   literals (static keys) of choices, and consts whose initialisers are such
//   literals;
// - `c ? a : b` (one test of c), `a && b`, `a || b`, `a ?? b` (b's choice is
//   used on the paths where a's value selects it);
// - calls of pack functions that offer a choice (nested twMerge, clsx,
//   variant functions, inlined wrappers);
// - any other expression whose type is boolean (one truthiness test) or a
//   union of string literals, booleans, null and undefined: the value is read
//   once and compared with each member. A value outside its declared type
//   (possible only through unsound casts) throws instead of selecting a
//   wrong result;
// - a component prop with a domain (frontend/domains.ts): the values its
//   instantiation sites pass, compared the same way; a call reading props
//   whose values depend on the site is enumerated once per site.
// Anything else (a plain `string`, numbers, objects) is open and rejected
// with E_PACK; pack modules explain the cheapest exact alternative.
import ts from 'typescript';
import type { Expr, Type } from '../ir.ts';
import type { FnBuilder, Lowerer } from '../language.ts';

export type Choice =
  | { kind: 'leaf'; value: unknown }
  /** A value outside its declared literal type: throws at runtime. */
  | { kind: 'outside' }
  | { kind: 'test'; test: Expr; then: Choice; else: Choice }
  | { kind: 'with'; local: number; value: Expr; body: Choice };

/** The most combinations one call may enumerate. */
export const LIMIT = 4096;

export const leaf = (value: unknown): Choice => ({ kind: 'leaf', value });

/** Replace every leaf by `f(value)` (f is called once per leaf). */
export function graft(c: Choice, f: (value: unknown) => Choice): Choice {
  switch (c.kind) {
    case 'leaf':
      return f(c.value);
    case 'outside':
      return c;
    case 'test':
      return { ...c, then: graft(c.then, f), else: graft(c.else, f) };
    case 'with':
      return { ...c, body: graft(c.body, f) };
  }
}

export function leaves(c: Choice): number {
  switch (c.kind) {
    case 'leaf':
    case 'outside':
      return 1;
    case 'test':
      return leaves(c.then) + leaves(c.else);
    case 'with':
      return leaves(c.body);
  }
}

/** Context of one pack call: where to report and how to name the pack. */
export interface Ctx {
  lower: Lowerer;
  b: FnBuilder;
  /** `tailwind-merge@3.7.0 pack` */
  label: string;
}

const fail = (ctx: Ctx, n: ts.Node, what: string): never =>
  ctx.lower.fail(n, 'E_PACK', `${ctx.label}: ${what}`);

function bounded(ctx: Ctx, n: ts.Node, c: Choice): Choice {
  const count = leaves(c);
  if (count > LIMIT)
    fail(
      ctx,
      n,
      `the arguments take ${count} combinations of values, more than the ${LIMIT} evaluated at build time`,
    );
  return c;
}

/** The choices of `items` in order, as one choice of arrays of their values. */
export function sequence(ctx: Ctx, at: ts.Node, items: Choice[]): Choice {
  let acc: Choice = leaf([]);
  for (const item of items)
    acc = bounded(
      ctx,
      at,
      graft(acc, done => graft(item, v => leaf([...(done as unknown[]), v]))),
    );
  return acc;
}

/** Pure tests can be dropped when both branches agree. */
function pure(e: Expr): boolean {
  switch (e.op) {
    case 'lit':
    case 'local':
    case 'cell':
    case 'global':
    case 'undefined':
    case 'null':
      return true;
    case 'not':
    case 'to-boolean':
      return pure(e.arg);
    case 'eq':
    case 'ne':
    case 'and':
    case 'or':
      return pure(e.left) && pure(e.right);
    case 'builtin':
      return e.name.startsWith('maybe.is-') && e.args.every(pure);
    default:
      return false;
  }
}

const outsideHelpers = new WeakMap<Lowerer, number>();

/** `pack$outside()`: throws for a value outside its declared literal type. */
function outside(lower: Lowerer): Expr {
  let index = outsideHelpers.get(lower);
  if (index === undefined) {
    index = lower.reserve();
    outsideHelpers.set(lower, index);
    lower.functions[index] = {
      name: 'pack$outside',
      params: [],
      locals: [],
      result: 'string',
      body: [
        {
          op: 'throw',
          value: {
            op: 'record',
            record: lower.errorRecord(),
            fields: [
              { op: 'lit', value: 'TypeError' },
              {
                op: 'lit',
                value:
                  'A value outside its declared literal type reached a call evaluated at build time',
              },
            ],
          },
        },
      ],
    };
  }
  return { op: 'call', function: index, args: [] };
}

/** The IR selecting a leaf's string at runtime. */
export function toExpr(ctx: Ctx, c: Choice, value: (v: unknown) => Expr): Expr {
  const memo = new Map<Choice, { e: Expr; key: string }>();
  const go = (c: Choice): { e: Expr; key: string } => {
    const known = memo.get(c);
    if (known) return known;
    let out: { e: Expr; key: string };
    switch (c.kind) {
      case 'leaf': {
        const e = value(c.value);
        out = { e, key: JSON.stringify(e) };
        break;
      }
      case 'outside': {
        const e = outside(ctx.lower);
        out = { e, key: JSON.stringify(e) };
        break;
      }
      case 'test': {
        const t = go(c.then);
        const f = go(c.else);
        if (t.key === f.key && pure(c.test)) out = t;
        else {
          const e: Expr = { op: 'cond', test: c.test, then: t.e, else: f.e };
          out = { e, key: JSON.stringify(e) };
        }
        break;
      }
      case 'with': {
        const body = go(c.body);
        const e: Expr = { op: 'with', local: c.local, value: c.value, body: body.e };
        out = { e, key: JSON.stringify(e) };
        break;
      }
    }
    memo.set(c, out);
    return out;
  };
  return go(c).e;
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

/** Pack call substitutions: a rest parameter standing for a call site's arguments. */
const restArgs = new WeakMap<Lowerer, Map<ts.Symbol, (readonly ts.Expression[])[]>>();

/** Evaluate `body` with `param` standing for the array of `args` (inlined wrappers). */
export function withRest<T>(
  lower: Lowerer,
  param: ts.Symbol,
  args: readonly ts.Expression[],
  body: () => T,
): T {
  let m = restArgs.get(lower);
  if (!m) restArgs.set(lower, (m = new Map()));
  let stack = m.get(param);
  if (!stack) m.set(param, (stack = []));
  stack.push(args);
  try {
    return body();
  } finally {
    stack.pop();
  }
}

const restOf = (
  lower: Lowerer,
  sym: ts.Symbol | undefined,
): readonly ts.Expression[] | undefined => {
  const stack = sym && restArgs.get(lower)?.get(sym);
  return stack?.length ? stack[stack.length - 1] : undefined;
};

/** The initialiser of a const that `id` names. */
function constInit(lower: Lowerer, id: ts.Identifier): ts.Expression | undefined {
  const decl = lower.symbol(id)?.valueDeclaration;
  if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isVariableDeclarationList(decl.parent) &&
    decl.parent.flags & ts.NodeFlags.Const
  )
    return decl.initializer;
  return undefined;
}

/**
 * A compile-time constant: literals, arrays and objects of them (static
 * keys) and consts bound to them; undefined (the result) if `e` is not one.
 */
export function staticValue(
  lower: Lowerer,
  e: ts.Expression,
  depth = 0,
): { value: unknown } | undefined {
  const node = skip(e);
  const K = ts.SyntaxKind;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { value: node.text };
  if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === K.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return { value: -Number(node.operand.text) };
  if (node.kind === K.TrueKeyword) return { value: true };
  if (node.kind === K.FalseKeyword) return { value: false };
  if (node.kind === K.NullKeyword) return { value: null };
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined' && !lower.binding(node)) return { value: undefined };
    const init = depth < 8 ? constInit(lower, node) : undefined;
    return init && staticValue(lower, init, depth + 1);
  }
  if (ts.isArrayLiteralExpression(node)) {
    const out: unknown[] = [];
    for (const el of node.elements) {
      if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) return undefined;
      const v = staticValue(lower, el, depth);
      if (!v) return undefined;
      out.push(v.value);
    }
    return { value: out };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const key = staticKey(p.name);
      if (key === undefined || key === '__proto__') return undefined;
      const v = staticValue(lower, p.initializer, depth);
      if (!v) return undefined;
      out[key] = v.value;
    }
    return { value: out };
  }
  return undefined;
}

function staticKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  return undefined;
}

const maybeOf = (t: Type): Type | undefined =>
  typeof t === 'object' && 'maybe' in t ? t.maybe : undefined;

/** The members of a finite TypeScript type, or undefined when it is open. */
function domain(type: ts.Type): unknown[] | undefined {
  const out: unknown[] = [];
  for (const t of type.isUnion() ? type.types : [type]) {
    if (t.flags & ts.TypeFlags.StringLiteral) out.push((t as ts.StringLiteralType).value);
    else if (t.flags & ts.TypeFlags.BooleanLiteral)
      out.push((t as unknown as { intrinsicName: string }).intrinsicName === 'true');
    else if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) out.push(undefined);
    else if (t.flags & ts.TypeFlags.Null) out.push(null);
    else return undefined;
  }
  return out;
}

/** Compare the value `v` (IR type `t`) with each member of `members`. */
function switchOn(ctx: Ctx, at: ts.Node, v: Expr, t: Type, members: unknown[]): Choice {
  const { b } = ctx;
  let read = v;
  let wrap = (c: Choice): Choice => c;
  if (!(v.op === 'local' || v.op === 'lit')) {
    const local = b.local('$pack', t);
    read = { op: 'local', local };
    wrap = body => ({ kind: 'with', local, value: v, body });
  }
  const inner = maybeOf(t);
  const plain = inner ?? t;
  const values = members.filter(m => m !== undefined && m !== null);
  const strings = values.filter((m): m is string => typeof m === 'string');
  const booleans = values.filter((m): m is boolean => typeof m === 'boolean');
  if (strings.length && booleans.length)
    fail(ctx, at, 'a value that is a string or a boolean is not covered');
  const of = (x: Expr): Choice => {
    if (plain === 'boolean') return { kind: 'test', test: x, then: leaf(true), else: leaf(false) };
    if (plain !== 'string' || !strings.length)
      return fail(ctx, at, `a value of type ${JSON.stringify(t)} is not covered`);
    let c: Choice = { kind: 'outside' };
    for (const s of [...strings].reverse())
      c = {
        kind: 'test',
        test: { op: 'eq', left: x, right: { op: 'lit', value: s } },
        then: leaf(s),
        else: c,
      };
    return c;
  };
  if (inner === undefined) return wrap(of(read));
  const nullish: Choice =
    members.includes(null) && members.includes(undefined)
      ? {
          kind: 'test',
          test: { op: 'builtin', name: 'maybe.is-null', args: [read], type: 'boolean' },
          then: leaf(null),
          else: leaf(undefined),
        }
      : leaf(members.includes(null) ? null : undefined);
  return wrap({
    kind: 'test',
    test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: 'boolean' },
    then: nullish,
    else: values.length ? of({ op: 'unwrap', value: read }) : { kind: 'outside' },
  });
}

/** The exact values `e` can take, as a choice (rejecting open values with E_PACK). */
export function valueChoice(ctx: Ctx, e: ts.Expression): Choice {
  const { lower, b } = ctx;
  const node = skip(e);
  const K = ts.SyntaxKind;
  const constant = staticValue(lower, node);
  if (constant) return leaf(constant.value);
  if (ts.isConditionalExpression(node)) {
    const test = lower.condition(node.condition, b);
    return bounded(ctx, node, {
      kind: 'test',
      test,
      then: valueChoice(ctx, node.whenTrue),
      else: valueChoice(ctx, node.whenFalse),
    });
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === K.AmpersandAmpersandToken ||
      op === K.BarBarToken ||
      op === K.QuestionQuestionToken
    ) {
      const left = valueChoice(ctx, node.left);
      let right: Choice | undefined;
      const rest = () => (right ??= valueChoice(ctx, node.right));
      return bounded(
        ctx,
        node,
        graft(left, v => {
          const takeRight =
            op === K.AmpersandAmpersandToken ? !!v : op === K.BarBarToken ? !v : v == null;
          return takeRight ? rest() : leaf(v);
        }),
      );
    }
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(el => {
      if (ts.isSpreadElement(el)) return fail(ctx, el, 'a spread in an array is not covered');
      if (ts.isOmittedExpression(el)) return fail(ctx, el, 'an array hole is not covered');
      return valueChoice(ctx, el);
    });
    return sequence(ctx, node, items);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const keys: string[] = [];
    const items: Choice[] = [];
    for (const p of node.properties) {
      if (ts.isShorthandPropertyAssignment(p)) {
        if (p.objectAssignmentInitializer)
          fail(ctx, p, 'a default in an object literal is not covered');
        keys.push(p.name.text);
        items.push(shorthandChoice(ctx, p));
      } else if (ts.isPropertyAssignment(p)) {
        const key = staticKey(p.name);
        if (key === undefined) fail(ctx, p.name, 'a computed key is not covered');
        if (key === '__proto__') fail(ctx, p.name, 'a __proto__ key is not covered');
        keys.push(key!);
        items.push(valueChoice(ctx, p.initializer));
      } else fail(ctx, p, 'a spread, method or accessor in an object literal is not covered');
    }
    return graft(sequence(ctx, node, items), vs => {
      // Evaluated in source order as the literal defines its properties.
      const o: Record<string, unknown> = {};
      keys.forEach((k, i) =>
        Object.defineProperty(o, k, {
          value: (vs as unknown[])[i],
          enumerable: true,
          writable: true,
          configurable: true,
        }),
      );
      return leaf(o);
    });
  }
  if (ts.isIdentifier(node)) {
    const sym = lower.checker.getSymbolAtLocation(node);
    const rest = restOf(lower, sym);
    if (rest) return argsChoice(ctx, node, rest);
    const members = sym && lower.domains?.values(sym);
    if (members) return domainChoice(ctx, node, members, () => lower.expr(node, b));
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const binding = lower.binding(node.expression);
    if (binding?.kind === 'pack' && binding.choice) return binding.choice(node, b, lower);
  }
  return typedChoice(
    ctx,
    node,
    lower.checker.getTypeAtLocation(node),
    () => lower.expr(node, b),
    ts.isIdentifier(node) ? lower.checker.getSymbolAtLocation(node) : undefined,
  );
}

/** `{ x }`: the value of the variable x. */
function shorthandChoice(ctx: Ctx, p: ts.ShorthandPropertyAssignment): Choice {
  const { lower, b } = ctx;
  const sym = lower.checker.getShorthandAssignmentValueSymbol(p);
  const rest = restOf(lower, sym);
  if (rest) return argsChoice(ctx, p, rest);
  const constant = staticValue(lower, p.name);
  if (constant) return leaf(constant.value);
  const binding = sym && lower.bindings.get(sym);
  if (!binding) return lower.fail(p, 'E_UNRESOLVED', `${p.name.text} is not a supported binding`);
  const read = () => lower.bindingExpr(binding, p.name, b, lower.types.of(p.name));
  const members = lower.domains?.values(sym);
  if (members) return domainChoice(ctx, p.name, members, read);
  return typedChoice(ctx, p.name, lower.checker.getTypeOfSymbolAtLocation(sym, p.name), read, sym);
}

/**
 * A prop that takes a finite set of values at its instantiation sites
 * (frontend/domains.ts): read once and compared with each value.
 */
function domainChoice(ctx: Ctx, node: ts.Node, members: unknown[], read: () => Expr): Choice {
  const scalar = members.every(
    m => m === undefined || m === null || typeof m === 'string' || typeof m === 'boolean',
  );
  if (!scalar)
    fail(
      ctx,
      node,
      `${node.getText()} takes values other than strings, booleans, null and undefined at its instantiation sites (${members.map(m => JSON.stringify(m) ?? 'undefined').join(', ')})`,
    );
  const v = read();
  const t = ctx.lower.irType(v, ctx.b);
  if (t === 'boolean' && members.length === 2 && members.every(m => typeof m === 'boolean'))
    return { kind: 'test', test: v, then: leaf(true), else: leaf(false) };
  return switchOn(ctx, node, v, t, members);
}

/** A value read once and compared with the members of its finite type. */
function typedChoice(
  ctx: Ctx,
  node: ts.Expression,
  type: ts.Type,
  read: () => Expr,
  sym?: ts.Symbol,
): Choice {
  const { lower, b } = ctx;
  const members = domain(type);
  const why = sym && lower.domains?.explain(sym);
  if (!members)
    return fail(
      ctx,
      node,
      `a value of type ${lower.checker.typeToString(type)} is not covered: the arguments of calls evaluated at build time must be compile-time constants or range over string literals, booleans, null and undefined${why ? `, and ${why}` : ' (an open string has no finite set of values)'}`,
    );
  if (members.every(m => typeof m === 'boolean') && members.length === 2) {
    const v = read();
    return {
      kind: 'test',
      test: lower.truthy(v, lower.irType(v, b)),
      then: leaf(true),
      else: leaf(false),
    };
  }
  const v = read();
  return switchOn(ctx, node, v, lower.irType(v, b), members);
}

/** An argument list, as one choice of arrays of the arguments' values. */
function argsChoice(ctx: Ctx, at: ts.Node, args: readonly ts.Expression[]): Choice {
  const items = args.map(a =>
    ts.isSpreadElement(a) ? fail(ctx, a, 'a spread argument is not covered') : valueChoice(ctx, a),
  );
  return sequence(ctx, at, items);
}

/**
 * A pack function evaluated at build time: the call's choice of results,
 * `evaluate` running the real package on each combination of argument values.
 */
export function evaluatedChoice(
  ctx: Ctx,
  node: ts.CallExpression,
  evaluate: (args: unknown[]) => unknown,
): Choice {
  // Props whose values depend on the instantiation site: one choice per
  // site, each over that site's values (frontend/domains.ts), selected by
  // the instance's site index, so that the combinations add up over the
  // sites instead of multiplying across all of them.
  const domains = ctx.lower.domains;
  const split = domains && !domains.site ? siteSplit(ctx.lower, node) : undefined;
  if (split !== undefined) {
    const read = domains!.siteRead(split, ctx.b);
    let out: Choice | undefined;
    for (let site = domains!.sites(split) - 1; site >= 0; site--) {
      domains!.site = { component: split, index: site };
      let body: Choice;
      try {
        body = evaluatedChoice(ctx, node, evaluate);
      } finally {
        domains!.site = undefined;
      }
      out =
        out === undefined
          ? body
          : {
              kind: 'test',
              test: { op: 'eq', left: read, right: { op: 'lit', value: site } },
              then: body,
              else: out,
            };
    }
    return bounded(ctx, node, out!);
  }
  return graft(argsChoice(ctx, node, node.arguments), vs => {
    try {
      return leaf(evaluate(vs as unknown[]));
    } catch (err) {
      return fail(ctx, node, `the package threw at build time: ${(err as Error).message}`);
    }
  });
}

/** A call whose results must be strings: the IR selecting them. */
export function stringCall(ctx: Ctx, node: ts.CallExpression, c: Choice): Expr {
  return toExpr(ctx, c, v =>
    typeof v === 'string'
      ? { op: 'lit', value: v }
      : fail(
          ctx,
          node,
          `the call can return ${v === undefined ? 'undefined' : typeof v}, not a string`,
        ),
  );
}

/**
 * The component whose site-dependent props (frontend/domains.ts) `node`
 * reads, including through the arguments an inlined wrapper's rest
 * parameter stands for; undefined when it reads none or the component has
 * one site.
 */
function siteSplit(lower: Lowerer, node: ts.Node): number | undefined {
  const domains = lower.domains!;
  let found: number | undefined;
  const visit = (n: ts.Node) => {
    if (found !== undefined) return;
    if (ts.isIdentifier(n)) {
      const sym =
        ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
          ? lower.checker.getShorthandAssignmentValueSymbol(n.parent)
          : lower.checker.getSymbolAtLocation(n);
      const rest = restOf(lower, sym);
      if (rest) rest.forEach(visit);
      const component = sym && domains.componentOf(sym);
      if (component !== undefined && domains.sites(component) > 1) found = component;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Context of a value-set analysis: no IR is built. */
export interface SetCtx {
  lower: Lowerer;
  label: string;
}

/** A key identifying a JavaScript value of a value set (structural). */
export function valueKey(v: unknown): string {
  if (v === undefined) return 'u';
  if (typeof v === 'number' && Object.is(v, -0)) return 'n-0';
  if (Array.isArray(v)) return `[${v.map(valueKey).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}:${valueKey(x)}`)
      .join(',')}}`;
  return `${typeof v}:${String(v)}`;
}

/** The distinct values of `values`, in order of first occurrence. */
export function distinct(values: unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const v of values) {
    const k = valueKey(v);
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen.values()];
}

/** Every combination of one value of each set, in order. */
function product(sets: unknown[][]): unknown[][] | undefined {
  let acc: unknown[][] = [[]];
  for (const set of sets) {
    const next: unknown[][] = [];
    for (const done of acc) for (const v of set) next.push([...done, v]);
    if (next.length > LIMIT) return undefined;
    acc = next;
  }
  return acc;
}

/**
 * The values `e` can take, without building IR: the same syntax and types
 * as `valueChoice`, with both branches of a test (a superset where tests
 * correlate), for the analysis of what props receive at their
 * instantiation sites (frontend/domains.ts). Undefined when `e` is open
 * (or takes more than LIMIT values).
 */
export function valueSet(ctx: SetCtx, e: ts.Expression): unknown[] | undefined {
  const { lower } = ctx;
  const node = skip(e);
  const K = ts.SyntaxKind;
  const constant = staticValue(lower, node);
  if (constant) return [constant.value];
  if (ts.isConditionalExpression(node)) {
    const a = valueSet(ctx, node.whenTrue);
    const b = a && valueSet(ctx, node.whenFalse);
    return b && distinct([...a!, ...b]);
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === K.AmpersandAmpersandToken ||
      op === K.BarBarToken ||
      op === K.QuestionQuestionToken
    ) {
      const left = valueSet(ctx, node.left);
      if (!left) return undefined;
      const out: unknown[] = [];
      for (const v of left) {
        const takeRight =
          op === K.AmpersandAmpersandToken ? !!v : op === K.BarBarToken ? !v : v == null;
        if (!takeRight) out.push(v);
        else {
          const right = valueSet(ctx, node.right);
          if (!right) return undefined;
          out.push(...right);
        }
      }
      return distinct(out);
    }
  }
  if (ts.isArrayLiteralExpression(node)) {
    const sets: unknown[][] = [];
    for (const el of node.elements) {
      if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) return undefined;
      const s = valueSet(ctx, el);
      if (!s) return undefined;
      sets.push(s);
    }
    return product(sets);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const keys: string[] = [];
    const sets: unknown[][] = [];
    for (const p of node.properties) {
      let s: unknown[] | undefined;
      if (ts.isShorthandPropertyAssignment(p) && !p.objectAssignmentInitializer) {
        keys.push(p.name.text);
        s = identifierSet(ctx, p.name, lower.checker.getShorthandAssignmentValueSymbol(p));
      } else if (ts.isPropertyAssignment(p)) {
        const key = staticKey(p.name);
        if (key === undefined || key === '__proto__') return undefined;
        keys.push(key);
        s = valueSet(ctx, p.initializer);
      }
      if (!s) return undefined;
      sets.push(s);
    }
    return product(sets)?.map(vs => {
      const o: Record<string, unknown> = {};
      keys.forEach((k, i) =>
        Object.defineProperty(o, k, {
          value: vs[i],
          enumerable: true,
          writable: true,
          configurable: true,
        }),
      );
      return o;
    });
  }
  if (ts.isIdentifier(node))
    return identifierSet(ctx, node, lower.checker.getSymbolAtLocation(node));
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const binding = lower.binding(node.expression);
    if (binding?.kind === 'pack') return binding.values?.(node, lower);
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const callee = node.expression;
    // A function of a build-time constant (bits-ui's
    // `dialogAttrs.getAttr(part, variant)`): called on each combination.
    if (
      ts.isIdentifier(callee.expression) &&
      lower.binding(callee.expression)?.kind === 'constant'
    ) {
      const member = lower.constantMember(callee);
      if (member && typeof member.value === 'function') {
        const object = (lower.binding(callee.expression) as { value: unknown }).value;
        const combos = argsSet(ctx, node.arguments);
        return (
          combos &&
          distinct(
            combos.map(args => (member.value as (...a: unknown[]) => unknown).apply(object, args)),
          )
        );
      }
    }
    const inlined = inlinedSet(ctx, node);
    if (inlined !== null) return inlined;
  }
  return typedSet(lower.checker.getTypeAtLocation(node));
}

/** Parameters standing for a call's arguments while its function is inlined (`inlinedSet`). */
const paramArgs = new Map<ts.Symbol, ts.Expression | 'undefined'>();
const inlining = new Set<ts.Node>();

/**
 * A method, or a function in a class field, returning one expression
 * (bits-ui's `getBitsAttr = (part) => dialogAttrs.getAttr(part, …)`):
 * the values of the expression with its parameters standing for the
 * arguments (`this` and the rest by their types); null where it is not one.
 */
function inlinedSet(ctx: SetCtx, node: ts.CallExpression): unknown[] | undefined | null {
  const { lower } = ctx;
  const checker = lower.checker;
  const callee = node.expression as ts.PropertyAccessExpression;
  const sym = checker.getSymbolAtLocation(callee.name);
  let decl = sym?.valueDeclaration;
  // A member a package's declaration file declares: its implementation.
  if (
    sym &&
    decl &&
    decl.getSourceFile().isDeclarationFile &&
    ts.isClassDeclaration(decl.parent) &&
    decl.parent.name
  ) {
    const cls = checker.getSymbolAtLocation(decl.parent.name);
    const impl = cls && lower.implementation?.(cls);
    decl = impl?.members?.get(sym.escapedName)?.valueDeclaration;
  }
  let fn: ts.FunctionLikeDeclaration | undefined;
  if (decl && ts.isPropertyDeclaration(decl) && decl.initializer) {
    const init = skip(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
  } else if (decl && ts.isMethodDeclaration(decl)) fn = decl;
  const body = fn?.body
    ? ts.isBlock(fn.body)
      ? fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0])
        ? fn.body.statements[0].expression
        : undefined
      : fn.body
    : undefined;
  if (!fn || !body) return null;
  if (fn.parameters.some(p => !ts.isIdentifier(p.name) || p.dotDotDotToken || p.initializer))
    return null;
  if (node.arguments.some(a => ts.isSpreadElement(a)) || inlining.has(fn)) return undefined;
  const bound: ts.Symbol[] = [];
  fn.parameters.forEach((p, i) => {
    const s = checker.getSymbolAtLocation(p.name);
    if (s) {
      paramArgs.set(s, node.arguments[i] ?? 'undefined');
      bound.push(s);
    }
  });
  inlining.add(fn);
  try {
    return valueSet(ctx, body);
  } finally {
    inlining.delete(fn);
    for (const b of bound) paramArgs.delete(b);
  }
}

/** Constants whose values are being computed (recursion guard). */
const derivedSeen = new Set<ts.Node>();

function identifierSet(
  ctx: SetCtx,
  node: ts.Identifier,
  sym: ts.Symbol | undefined,
): unknown[] | undefined {
  const { lower } = ctx;
  const arg = sym && paramArgs.get(sym);
  if (arg) return arg === 'undefined' ? [undefined] : valueSet(ctx, arg);
  const rest = restOf(lower, sym);
  if (rest) return argsSet(ctx, rest);
  const members = sym && lower.domains?.values(sym);
  if (members) return members;
  const constant = staticValue(lower, node);
  if (constant) return [constant.value];
  // A constant (also a derived value: bits-ui's `resolvedPreventScroll =
  // $derived(preventScroll ?? true)`): the values of its expression.
  const decl = sym?.valueDeclaration;
  if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    ts.isVariableDeclarationList(decl.parent) &&
    decl.parent.flags & ts.NodeFlags.Const &&
    decl.initializer &&
    !derivedSeen.has(decl)
  ) {
    let init: ts.Expression = skip(decl.initializer);
    if (
      ts.isCallExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === '$derived' &&
      init.arguments.length === 1
    )
      init = init.arguments[0];
    if (
      !ts.isCallExpression(init) ||
      !ts.isIdentifier(init.expression) ||
      !init.expression.text.startsWith('$')
    ) {
      derivedSeen.add(decl);
      try {
        const values = valueSet(ctx, init);
        if (values) return values;
      } finally {
        derivedSeen.delete(decl);
      }
    }
  }
  return typedSet(
    sym
      ? lower.checker.getTypeOfSymbolAtLocation(sym, node)
      : lower.checker.getTypeAtLocation(node),
  );
}

function typedSet(type: ts.Type): unknown[] | undefined {
  const members = domain(type);
  return members && distinct(members);
}

/** An argument list, as the set of the arrays of its arguments' values. */
function argsSet(ctx: SetCtx, args: readonly ts.Expression[]): unknown[][] | undefined {
  const sets: unknown[][] = [];
  for (const a of args) {
    if (ts.isSpreadElement(a)) return undefined;
    const s = valueSet(ctx, a);
    if (!s) return undefined;
    sets.push(s);
  }
  return product(sets);
}

/** The values of a call evaluated at build time over its arguments' value sets. */
export function evaluatedValues(
  ctx: SetCtx,
  node: ts.CallExpression,
  evaluate: (args: unknown[]) => unknown,
): unknown[] | undefined {
  const combos = argsSet(ctx, node.arguments);
  if (!combos) return undefined;
  const out: unknown[] = [];
  for (const args of combos) {
    try {
      out.push(evaluate(args));
    } catch {
      return undefined;
    }
  }
  return distinct(out);
}

/** The values of an inlined wrapper's call (its rest parameter standing for the arguments). */
export function wrapperValues(
  ctx: SetCtx,
  rest: ts.Symbol,
  args: readonly ts.Expression[],
  expr: ts.Expression,
): unknown[] | undefined {
  return withRest(ctx.lower, rest, args, () => valueSet(ctx, expr));
}
