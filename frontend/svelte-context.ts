// svelte's setContext and getContext with string literal keys, imported in
// modules (a component's `<script module>`: shadcn-svelte's toggle group
// shares its variant through `setContext("toggleGroup", props)`).
//
// A string key is one context program-wide (the IR key `string:<key>`,
// apart from runed's Context keys). Its value type is what the program
// sets: every `setContext(key, v)` must agree. `setContext` stores the
// value while an instance is created and returns it (`context.set`).
// `getContext(key)` finds the nearest value up the instance's parents; where
// no parent set one Svelte returns undefined: a call TypeScript types as
// nullable gives undefined there, one it types as the value
// (`getContext<Required<…>>`) throws RunicUnsupportedError, since the value
// type cannot hold undefined. Other keys (symbols, objects, computed
// strings), other svelte exports and the instance-script imports are
// rejected.
import ts from 'typescript';
import type { Expr, Type } from './ir.ts';
import { skipParens, type Binding, type FnBuilder, type Lowerer } from './language.ts';

const EXPORTS = ['setContext', 'getContext'];

/** Bind `import { setContext, getContext } from 'svelte'` in a module. */
export function svelteContextImport(stmt: ts.ImportDeclaration, lower: Lowerer): void {
  const clause = stmt.importClause;
  const named = clause?.namedBindings;
  if (!clause || clause.name || !named || !ts.isNamedImports(named))
    lower.fail(stmt, 'E_CAPABILITY', 'Import setContext and getContext from svelte by name');
  for (const el of (named as ts.NamedImports).elements) {
    if (el.isTypeOnly) continue;
    const imported = (el.propertyName ?? el.name).text;
    if (!EXPORTS.includes(imported))
      lower.fail(
        el,
        'E_CAPABILITY',
        `svelte's ${imported} is not covered in modules (${EXPORTS.join(' and ')} with string literal keys are)`,
      );
    const sym = lower.checker.getSymbolAtLocation(el.name);
    if (!sym) lower.fail(el, 'E_CAPABILITY', `Cannot bind ${el.name.text}`);
    const binding: Binding = {
      kind: 'pack',
      label: `svelte's ${imported}`,
      call: imported === 'setContext' ? setContext : getContext,
    };
    lower.bindings.set(sym!, binding);
  }
}

/** The key of a call: its first argument, a string literal. */
function keyOf(node: ts.CallExpression, lower: Lowerer, name: string): string {
  const arg = node.arguments[0] && skipParens(node.arguments[0]);
  if (!arg || !ts.isStringLiteralLike(arg))
    lower.fail(node, 'E_CAPABILITY', `${name} is supported with a string literal key`);
  return (arg as ts.StringLiteralLike).text;
}

/** The value types each key is set with (per program). */
const setTypes = new WeakMap<Lowerer, Map<string, Type | null>>();

/** The type every `setContext(key, v)` of the program sets. */
function valueType(key: string, at: ts.Node, lower: Lowerer): Type {
  let known = setTypes.get(lower);
  if (!known) setTypes.set(lower, (known = new Map()));
  if (!known.has(key)) {
    let type: Type | undefined;
    for (const sf of lower.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          isSvelteExport(n.expression, 'setContext', lower) &&
          n.arguments.length === 2 &&
          ts.isStringLiteralLike(skipParens(n.arguments[0])) &&
          (skipParens(n.arguments[0]) as ts.StringLiteralLike).text === key
        ) {
          const t = lower.types.of(n.arguments[1]);
          if (type !== undefined && JSON.stringify(t) !== JSON.stringify(type))
            lower.fail(
              n,
              'E_CAPABILITY',
              `The context "${key}" is set with values of different types`,
            );
          type = t;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    known.set(key, type ?? null);
  }
  return known.get(key) ?? lower.fail(at, 'E_CAPABILITY', `The context "${key}" is never set`);
}

/** Whether `id` names svelte's export `name`. */
function isSvelteExport(id: ts.Identifier, name: string, lower: Lowerer): boolean {
  const sym = lower.checker.getSymbolAtLocation(id);
  if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) return false;
  const target = lower.checker.getAliasedSymbol(sym);
  const file = target.declarations?.[0]?.getSourceFile().fileName ?? '';
  return target.name === name && /[\\/]node_modules[\\/]svelte[\\/]/.test(file);
}

function setContext(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  if (node.arguments.length !== 2)
    lower.fail(node, 'E_CAPABILITY', 'setContext takes a key and a value');
  const key = keyOf(node, lower, 'setContext');
  const t = valueType(key, node, lower);
  return {
    op: 'builtin',
    name: 'context.set',
    args: [{ op: 'lit', value: `string:${key}` }, lower.coerce(node.arguments[1], b, t)],
    type: t,
  };
}

function getContext(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  if (node.arguments.length !== 1) lower.fail(node, 'E_CAPABILITY', 'getContext takes a key');
  const key = keyOf(node, lower, 'getContext');
  const t = valueType(key, node, lower);
  const read: Expr = {
    op: 'builtin',
    name: 'context.get',
    args: [{ op: 'lit', value: `string:${key}` }],
    type: { maybe: t },
  };
  const here = lower.checker.getTypeAtLocation(node);
  if (lower.checker.getNonNullableType(here) !== here) return read;
  // The value type cannot hold Svelte's undefined: no parent set it.
  let getters = present.get(lower);
  if (!getters) present.set(lower, (getters = new Map()));
  let fn = getters.get(key);
  if (fn === undefined) {
    fn = lower.reserve();
    getters.set(key, fn);
    const value: Expr = { op: 'local', local: 0 };
    lower.functions[fn] = {
      name: `getContext:${key}`,
      params: [],
      locals: [{ name: 'value', type: { maybe: t } }],
      result: t,
      body: [
        { op: 'let', local: 0, value: read },
        {
          op: 'if',
          test: { op: 'builtin', name: 'maybe.is-undefined', args: [value], type: 'boolean' },
          then: [
            {
              op: 'throw',
              value: {
                op: 'record',
                record: lower.errorRecord(),
                fields: [
                  { op: 'lit', value: 'RunicUnsupportedError' },
                  {
                    op: 'lit',
                    value: `getContext("${key}"): no parent component set it, and its value type cannot hold undefined`,
                  },
                ],
              },
            },
          ],
        },
        { op: 'return', value: { op: 'unwrap', value } },
      ],
    };
  }
  void b;
  return { op: 'call', function: fn, args: [] };
}

/** The functions reading a context whose value must be present, by key (per program). */
const present = new WeakMap<Lowerer, Map<string, number>>();
