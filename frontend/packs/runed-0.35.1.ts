// Mapping pack for runed 0.35.1 (docs/design/M6-LIBRARIES.md, "Library
// code"): the reactive utilities bits-ui uses.
//
// - `Context` (dist/utilities/context/context.js): `new Context(name)` as a
//   module constant is a context key of its own (a fresh `Symbol(name)`),
//   so a constant is the key's compile-time identity. `set(v)` is Svelte's
//   `setContext` (it returns `v`), `get()` its `getContext`, throwing
//   `Error('Context "<name>" not found')` when no component above set it.
//   The value type is the type of the values the program sets; all `set`
//   calls must agree. The IR built-ins `context.set`/`context.get` look up
//   the instance and the instances whose output contains it, nearest first.
// - `watch(source, effect, options?)` and `watch.pre`
//   (dist/utilities/watch/watch.svelte.js): an effect (`$effect`, or
//   `$effect.pre` for `watch.pre`) of the instance being created that reads
//   the sources (tracked), and from its second run on (from its first
//   without `lazy`) calls `effect(values, previousValues)` untracked and
//   returns its cleanup. A source is a getter or an array literal of
//   getters; with an array the values are passed element by element (the
//   callback destructures them, `([node, flag]) => …`) and the previous
//   values are not covered.
//
// Other exports (`watchOnce`, `IsMounted`, `ElementSize`, …) and shapes are
// rejected (E_PACK).
import ts from 'typescript';
import type { Expr, Local, Stmt, Type } from '../ir.ts';
import type { FnBuilder, Lowerer } from '../language.ts';
import type { Pack, PackFunction } from '../packs.ts';
import { maybeInner } from '../irtype.ts';
import { skipParens } from '../language.ts';

const LABEL = 'runed@0.35.1 pack';
const local = (i: number): Expr => ({ op: 'local', local: i });

let contexts = 0;

/** `const C = new Context(name)`: the methods of the context key. */
function contextConstant(
  node: ts.CallExpression | ts.NewExpression,
  name: string,
  lower: Lowerer,
): PackFunction {
  const [arg] = node.arguments ?? [];
  if (
    !ts.isNewExpression(node) ||
    !arg ||
    !ts.isStringLiteralLike(arg) ||
    node.arguments!.length > 1
  )
    lower.fail(node, 'E_PACK', `${LABEL}: new Context(name) with a string literal name`);
  const label = (arg as ts.StringLiteral).text;
  const key = `${label}#${++contexts}`;
  // The value type: what the program sets (every `C.set(v)`).
  const decl = node.parent;
  const sym =
    ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)
      ? lower.checker.getSymbolAtLocation(decl.name)
      : undefined;
  let type: Type | undefined;
  for (const sf of lower.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'set' &&
        ts.isIdentifier(n.expression.expression) &&
        lower.symbol(n.expression.expression) === sym &&
        n.arguments[0]
      ) {
        const t = lower.types.of(n.arguments[0]);
        if (type !== undefined && JSON.stringify(t) !== JSON.stringify(type))
          lower.fail(
            n,
            'E_PACK',
            `${LABEL}: context ${label} is set with values of different types`,
          );
        type = t;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const valueType = (at: ts.Node): Type =>
    type ?? lower.fail(at, 'E_PACK', `${LABEL}: context ${label} is never set`);
  let getter: number | undefined;
  return {
    kind: 'function',
    call: (n, _b, l) =>
      l.fail(n, 'E_PACK', `${LABEL}: ${name} is a context; call its set() or get()`),
    methods: {
      set(n, b, l) {
        if (n.arguments.length !== 1) l.fail(n, 'E_PACK', `${LABEL}: set takes the value`);
        const t = valueType(n);
        return {
          op: 'builtin',
          name: 'context.set',
          args: [{ op: 'lit', value: key }, l.coerce(n.arguments[0], b, t)],
          type: t,
        };
      },
      get(n, _b, l) {
        if (n.arguments.length) l.fail(n, 'E_PACK', `${LABEL}: get takes no arguments`);
        const t = valueType(n);
        if (getter === undefined) {
          // The value, or `Error('Context "<name>" not found')`.
          getter = l.reserve();
          const error: Expr = {
            op: 'record',
            record: l.errorRecord(),
            fields: [
              { op: 'lit', value: 'Error' },
              { op: 'lit', value: `Context "${label}" not found` },
            ],
          };
          l.functions[getter] = {
            name: `${name}.get`,
            params: [],
            locals: [{ name: 'value', type: { maybe: t } }],
            result: t,
            body: [
              {
                op: 'let',
                local: 0,
                value: {
                  op: 'builtin',
                  name: 'context.get',
                  args: [{ op: 'lit', value: key }],
                  type: { maybe: t },
                },
              },
              {
                op: 'if',
                test: {
                  op: 'builtin',
                  name: 'maybe.is-undefined',
                  args: [local(0)],
                  type: 'boolean',
                },
                then: [{ op: 'throw', value: error }],
              },
              { op: 'return', value: { op: 'unwrap', value: local(0) } },
            ],
          };
        }
        return { op: 'call', function: getter, args: [] };
      },
      // `getOr(fallback)`: the value, or the fallback when none is set.
      getOr(n, b, l) {
        if (n.arguments.length !== 1) l.fail(n, 'E_PACK', `${LABEL}: getOr takes the fallback`);
        const t = valueType(n);
        const found = b.local('$context', { maybe: t });
        const arg = skipParens(n.arguments[0]);
        // A nullish fallback makes the result nullable.
        const literal: Expr | undefined =
          arg.kind === ts.SyntaxKind.NullKeyword
            ? { op: 'null', type: { maybe: t } }
            : ts.isIdentifier(arg) && arg.text === 'undefined'
              ? { op: 'undefined', type: { maybe: t } }
              : undefined;
        const nullable =
          literal !== undefined || maybeInner(l.types.of(n.arguments[0])) !== undefined;
        const result: Type = nullable ? { maybe: t } : t;
        const read: Expr = local(found);
        return {
          op: 'with',
          local: found,
          value: {
            op: 'builtin',
            name: 'context.get',
            args: [{ op: 'lit', value: key }],
            type: { maybe: t },
          },
          body: {
            op: 'cond',
            test: { op: 'builtin', name: 'maybe.is-undefined', args: [read], type: 'boolean' },
            then: literal ?? l.coerce(n.arguments[0], b, result),
            else: nullable ? read : { op: 'unwrap', value: read },
          },
        } as Expr;
      },
      // `exists()`: whether a value is set.
      exists(n, _b, l) {
        if (n.arguments.length) l.fail(n, 'E_PACK', `${LABEL}: exists takes no arguments`);
        const t = valueType(n);
        return {
          op: 'not',
          arg: {
            op: 'builtin',
            name: 'maybe.is-undefined',
            args: [
              {
                op: 'builtin',
                name: 'context.get',
                args: [{ op: 'lit', value: key }],
                type: { maybe: t },
              },
            ],
            type: 'boolean',
          },
        };
      },
    },
  };
}

/** `watch(sources, effect, options?)` in phase `phase`. */
function watch(phase: 'pre' | 'post') {
  return (node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr => {
    const [source, effect, options] = node.arguments;
    const name = phase === 'pre' ? 'watch.pre' : 'watch';
    if (!source || !effect || node.arguments.length > 3)
      return lower.fail(node, 'E_PACK', `${LABEL}: ${name} takes sources, an effect and options`);
    let lazy = false;
    if (options) {
      const o = skipParens(options);
      const p = ts.isObjectLiteralExpression(o) ? o.properties : undefined;
      if (
        !p ||
        p.some(
          x =>
            !ts.isPropertyAssignment(x) ||
            !ts.isIdentifier(x.name) ||
            x.name.text !== 'lazy' ||
            ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(x.initializer.kind),
        )
      )
        lower.fail(options, 'E_PACK', `${LABEL}: ${name} options are { lazy: true | false }`);
      lazy = p!.some(
        x => (x as ts.PropertyAssignment).initializer.kind === ts.SyntaxKind.TrueKeyword,
      );
    }
    // The sources: one getter, or an array literal of getters.
    const src = skipParens(source);
    const getters = ts.isArrayLiteralExpression(src) ? [...src.elements] : [source];
    const tuple = ts.isArrayLiteralExpression(src);
    const values: { fn: Expr; type: Type }[] = getters.map(g => {
      if (ts.isSpreadElement(g)) return lower.fail(g, 'E_PACK', `${LABEL}: spread sources`);
      const f = lower.expr(g, b);
      const t = lower.irType(f, b);
      if (typeof t !== 'object' || !('fn' in t) || t.fn.params.length)
        return lower.fail(g, 'E_PACK', `${LABEL}: ${name} sources are getters without parameters`);
      return { fn: f, type: t.fn.result };
    });
    // The effect: called with the values (element by element for an array
    // of sources) and, for one source, the previous value.
    const e = skipParens(effect);
    if (!(ts.isArrowFunction(e) || ts.isFunctionExpression(e)))
      return lower.fail(effect, 'E_PACK', `${LABEL}: ${name} takes an inline effect function`);
    if (tuple && e.parameters.length > 1)
      lower.fail(
        e.parameters[1],
        'E_PACK',
        `${LABEL}: previous values of several sources are not covered`,
      );
    const single = values[0]?.type;
    const { index, builder } = lower.function(
      e,
      `${b.name}.${name}`,
      b,
      b.component,
      undefined,
      tuple
        ? undefined
        : [single, { maybe: maybeInner(single) ?? single }].slice(0, e.parameters.length),
      { tupleParams: tuple },
    );
    const cb = lower.functions[index];
    const result = cb.result;
    const cleanup = (t: Type) =>
      t === 'void' ||
      (typeof t === 'object' && 'fn' in t && !t.fn.params.length && t.fn.result === 'void') ||
      (typeof t === 'object' &&
        'maybe' in t &&
        typeof t.maybe === 'object' &&
        'fn' in t.maybe &&
        !t.maybe.fn.params.length);
    if (!cleanup(result))
      lower.fail(e, 'E_PACK', `${LABEL}: ${name} effects return nothing or a cleanup function`);
    const cbType: Type = { fn: { params: cb.params.map(p => p.type), result } };
    const runResult: Type =
      result === 'void' ? 'void' : maybeInner(result) ? result : { maybe: result };
    // The run function's captures: getters, the effect, `active`, the previous values.
    const captures: Local[] = [
      ...values.map((v, i) => ({
        name: `source${i}`,
        type: { fn: { params: [], result: v.type } } as Type,
      })),
      { name: 'effect', type: cbType },
      { name: 'active', type: 'boolean', boxed: true },
      ...(tuple
        ? []
        : [
            {
              name: 'previous',
              type: { maybe: maybeInner(single) ?? single } as Type,
              boxed: true,
            },
          ]),
    ];
    const k = values.length;
    const active = k + 1;
    const previous = k + 2;
    const locals: Local[] = values.map((v, i) => ({ name: `value${i}`, type: v.type }));
    const valueLocal = (i: number) => captures.length + i;
    const asPrevious = (v: Expr): Expr => (maybeInner(single) ? v : { op: 'some', value: v });
    const body: Stmt[] = [
      ...values.map((v, i): Stmt => ({
        op: 'let',
        local: valueLocal(i),
        value: { op: 'call-value', callee: local(i), args: [] },
      })),
      {
        op: 'if',
        test: { op: 'not', arg: local(active) },
        then: [
          {
            op: 'assign',
            target: { place: 'local', local: active },
            value: { op: 'lit', value: true },
          },
          ...(tuple
            ? []
            : [
                {
                  op: 'assign',
                  target: { place: 'local', local: previous },
                  value: asPrevious(local(valueLocal(0))),
                } as Stmt,
              ]),
          runResult === 'void'
            ? { op: 'return' }
            : { op: 'return', value: { op: 'undefined', type: runResult } },
        ],
      },
    ];
    const args: Expr[] = tuple
      ? values.map((_, i) => local(valueLocal(i)))
      : [local(valueLocal(0)), local(previous)].slice(0, cb.params.length);
    const call: Expr = {
      op: 'builtin',
      name: 'reactive.untrack-call',
      args: [local(k), ...args],
      type: result,
    };
    if (runResult === 'void') body.push({ op: 'expr', value: call });
    else {
      const out = locals.length;
      locals.push({ name: 'cleanup', type: runResult });
      body.push({
        op: 'let',
        local: valueLocal(out),
        value: result === runResult ? call : { op: 'some', value: call },
      });
    }
    if (!tuple)
      body.push({
        op: 'assign',
        target: { place: 'local', local: previous },
        value: asPrevious(local(valueLocal(0))),
      });
    if (runResult !== 'void')
      body.push({ op: 'return', value: local(valueLocal(locals.length - 1)) });
    const run = lower.reserve();
    lower.functions[run] = {
      name: `${b.name}.${name}$run`,
      captures,
      params: [],
      locals,
      result: runResult,
      body,
    };
    // Bind the getters, the effect and the state, then create the effect.
    const temps = [
      ...values.map((v, i) => ({ local: b.local(`$source${i}`, captures[i].type), value: v.fn })),
      {
        local: b.local('$effect', cbType),
        value: {
          op: 'closure',
          function: index,
          captures: builder.captureSources.map(c => c.local),
        } as Expr,
      },
      { local: b.local('$active', 'boolean', true), value: { op: 'lit', value: !lazy } as Expr },
      ...(tuple
        ? []
        : [
            {
              local: b.local('$previous', captures[previous].type, true),
              value: { op: 'undefined', type: captures[previous].type } as Expr,
            },
          ]),
    ];
    let out: Expr = {
      op: 'builtin',
      name: phase === 'pre' ? 'effect.pre' : 'effect.post',
      args: [{ op: 'closure', function: run, captures: temps.map(t => t.local) }],
      type: 'void',
    };
    for (const t of temps.reverse())
      out = { op: 'with', local: t.local, value: t.value, body: out };
    return out;
  };
}

export const runedPack: Pack = {
  name: 'runed',
  version: '0.35.1',
  module: import.meta.url,
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    switch (imported) {
      case 'Context':
        return {
          kind: 'function',
          call: (n, _b, l) =>
            l.fail(n, 'E_PACK', `${LABEL}: Context is supported as const C = new Context(name)`),
          constant: (node, name, lower) => contextConstant(node, name, lower),
        };
      case 'watch':
        return { kind: 'function', call: watch('post'), methods: { pre: watch('pre') } };
    }
    return `${LABEL} covers Context and watch (watch.pre), not ${imported}`;
  },
};
