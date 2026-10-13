// svelte's setContext, getContext and hasContext with string literal keys
// or symbol constants, imported in modules (a component's `<script module>`:
// shadcn-svelte's toggle group shares its variant through
// `setContext("toggleGroup", props)`, its carousel through a key
// `const EMBLA_CAROUSEL_CONTEXT = Symbol("EMBLA_CAROUSEL_CONTEXT")`).
//
// A string key is one context program-wide (the IR key `string:<key>`,
// apart from runed's Context keys).
//
// A symbol key is a module constant `const K = Symbol()` or
// `Symbol("description")` (the global Symbol, at the top level of a module
// or a component's `<script module>`): the module initialises once, so the
// constant holds one symbol for the program's run, unequal to every other
// value, and Svelte's context map (a Map keyed by identity) finds a value
// under it only where a setContext was given that same constant. Its IR key
// is `symbol:<description or name>#<n>`, numbered per declaration in module
// order, so two constants never share a context, whatever their
// descriptions. The constant has no runtime value: every reference to it
// in the program's sources (followed through imports and re-exports) must
// be the key argument of a call of svelte's setContext, getContext or
// hasContext; any other use (comparisons, Map keys, `description`,
// `toString`, `String(K)`, template interpolation, symbol-keyed
// properties, passing it on) needs a symbol value and is rejected
// (`E_TYPE_UNSUPPORTED`) at the reference, as are `Symbol()` elsewhere
// (in functions or instance scripts, evaluated more than once),
// `Symbol.for` and the well-known symbols, whose type the value model
// rejects where they are lowered.
//
// Either key's value type is what the program sets: every
// `setContext(key, v)` must agree. `setContext` stores the value while an
// instance is created and returns it (`context.set`). `getContext(key)`
// finds the nearest value up the instance's parents; where no parent set
// one Svelte returns undefined: a call TypeScript types as nullable gives
// undefined there, one it types as the value (`getContext<Required<…>>`)
// throws RunicUnsupportedError, since the value type cannot hold undefined.
// `hasContext(key)` is whether getContext finds a value (rejected where the
// value type can hold undefined, which hasContext tells apart from no
// value). Other keys (other symbols, objects, computed strings), other
// svelte exports and the instance-script imports are rejected.
import ts from 'typescript';
import type { Expr, Type } from './ir.ts';
import { skipParens, type Binding, type FnBuilder, type Lowerer } from './language.ts';

const EXPORTS = ['setContext', 'getContext', 'hasContext'];
const CALLS = { setContext, getContext, hasContext } as const;

/**
 * Bind `import { setContext, getContext, hasContext } from 'svelte'` in a module; the
 * names in `elsewhere` are bound by the caller.
 */
export function svelteContextImport(
  stmt: ts.ImportDeclaration,
  lower: Lowerer,
  elsewhere: readonly string[] = [],
): void {
  const clause = stmt.importClause;
  const named = clause?.namedBindings;
  if (!clause || clause.name || !named || !ts.isNamedImports(named))
    lower.fail(stmt, 'E_CAPABILITY', `Import ${EXPORTS.join(', ')} from svelte by name`);
  for (const el of (named as ts.NamedImports).elements) {
    if (el.isTypeOnly) continue;
    const imported = (el.propertyName ?? el.name).text;
    if (elsewhere.includes(imported)) continue;
    if (!EXPORTS.includes(imported))
      lower.fail(
        el,
        'E_CAPABILITY',
        `svelte's ${imported} is not covered in modules (${EXPORTS.join(' and ')} with string literal or symbol constant keys are)`,
      );
    const sym = lower.checker.getSymbolAtLocation(el.name);
    if (!sym) lower.fail(el, 'E_CAPABILITY', `Cannot bind ${el.name.text}`);
    const binding: Binding = {
      kind: 'pack',
      label: `svelte's ${imported}`,
      call: CALLS[imported as keyof typeof CALLS],
    };
    lower.bindings.set(sym!, binding);
  }
}

/** A context key: the IR key and how diagnostics name it. */
interface Key {
  key: string;
  label: string;
}

/** The key an argument names (a string literal or a symbol key constant); undefined otherwise. */
function keyText(arg: ts.Expression | undefined, lower: Lowerer): Key | undefined {
  arg = arg && skipParens(arg);
  if (!arg) return undefined;
  if (ts.isStringLiteralLike(arg))
    return { key: `string:${arg.text}`, label: JSON.stringify(arg.text) };
  if (ts.isIdentifier(arg)) {
    const binding = lower.binding(arg);
    if (binding?.kind === 'symbol') return { key: binding.key, label: binding.name };
  }
  return undefined;
}

/** The key of a call: its first argument, a string literal or a symbol key constant. */
function keyOf(node: ts.CallExpression, lower: Lowerer, name: string): Key {
  return (
    keyText(node.arguments[0], lower) ??
    lower.fail(
      node,
      'E_CAPABILITY',
      `${name} is supported with a string literal key or a module constant Symbol(…)`,
    )
  );
}

/** The message for a use of a symbol key constant other than as a context key. */
export function symbolUseMessage(name: string): string {
  return `${name} is a symbol, supported only as the key of svelte's setContext, getContext and hasContext; this use needs symbol values, which are outside the value model`;
}

/** The number of symbol key constants declared so far (per program). */
const symbolCount = new WeakMap<Lowerer, number>();

/**
 * `const K = Symbol(description?)` at a module's top level (`d`, of a const
 * statement `lowerModules` lowers): binds `K` to its context key, after
 * checking that every reference to it is the key of a context call. False
 * where `d` is not such a declaration.
 */
export function symbolKeyConstant(d: ts.VariableDeclaration, lower: Lowerer): boolean {
  const init = d.initializer && skipParens(d.initializer);
  if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return false;
  if (init.expression.text !== 'Symbol') return false;
  const callee = lower.checker.getSymbolAtLocation(init.expression);
  const file = (callee?.valueDeclaration ?? callee?.declarations?.[0])?.getSourceFile();
  if (!file || !lower.program.isSourceFileDefaultLibrary(file)) return false;
  if (!ts.isIdentifier(d.name))
    lower.fail(d, 'E_TYPE_UNSUPPORTED', 'A Symbol(…) constant needs a plain name');
  const id = d.name as ts.Identifier;
  const [description, ...rest] = init.arguments;
  if (rest.length || (description && !ts.isStringLiteralLike(skipParens(description))))
    lower.fail(
      init,
      'E_TYPE_UNSUPPORTED',
      'Symbol(…) is supported with a string literal description or none',
    );
  const target = lower.checker.getSymbolAtLocation(id)!;
  checkSymbolUses(target, id, lower);
  const n = (symbolCount.get(lower) ?? 0) + 1;
  symbolCount.set(lower, n);
  const label = description ? (skipParens(description) as ts.StringLiteralLike).text : id.text;
  lower.bindings.set(target, { kind: 'symbol', key: `symbol:${label}#${n}`, name: id.text });
  return true;
}

/**
 * Check that every reference to the symbol constant `target` (declared by
 * `declared`) in the program's sources is the key argument of a call of
 * svelte's setContext, getContext or hasContext. Import and export
 * specifiers and type positions (`typeof K`) are not uses; the names the
 * constant is imported or re-exported under are followed.
 */
function checkSymbolUses(target: ts.Symbol, declared: ts.Identifier, lower: Lowerer): void {
  const { checker } = lower;
  const resolve = (s: ts.Symbol | undefined) =>
    s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  const sources = lower.program.getSourceFiles().filter(sf => !sf.isDeclarationFile);
  // The names it goes by: its own and those of the imports and exports
  // aliasing it (specifiers and default imports).
  const names = new Set([declared.text]);
  for (const sf of sources) {
    const visit = (n: ts.Node): void => {
      const alias =
        ts.isImportSpecifier(n) || ts.isExportSpecifier(n)
          ? n.name
          : ts.isImportClause(n)
            ? n.name
            : undefined;
      if (alias && resolve(checker.getSymbolAtLocation(alias)) === target) names.add(alias.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const contextKey = (id: ts.Identifier): boolean => {
    let arg: ts.Node = id;
    while (ts.isParenthesizedExpression(arg.parent)) arg = arg.parent;
    const call = arg.parent;
    return (
      ts.isCallExpression(call) &&
      call.arguments[0] === arg &&
      ts.isIdentifier(call.expression) &&
      EXPORTS.some(e => isSvelteExport(call.expression as ts.Identifier, e, lower))
    );
  };
  // (A class's `extends` expression is a value, though TypeScript's node for
  // it counts as a type node.)
  const inType = (n: ts.Node): boolean => {
    for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isExpressionWithTypeArguments(p) && ts.isClassLike(p.parent.parent)) return false;
      if (ts.isTypeNode(p)) return true;
    }
    return false;
  };
  for (const sf of sources) {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n !== declared && names.has(n.text)) {
        const p = n.parent;
        const s = ts.isShorthandPropertyAssignment(p)
          ? checker.getShorthandAssignmentValueSymbol(p)
          : checker.getSymbolAtLocation(n);
        if (
          !ts.isImportSpecifier(p) &&
          !ts.isExportSpecifier(p) &&
          !ts.isImportClause(p) &&
          resolve(s) === target &&
          !inType(n) &&
          !contextKey(n)
        )
          lower.fail(n, 'E_TYPE_UNSUPPORTED', symbolUseMessage(declared.text));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

/** The value types each key is set with (per program). */
const setTypes = new WeakMap<Lowerer, Map<string, Type | null>>();

/** The type every `setContext(key, v)` of the program sets. */
function valueType(key: Key, at: ts.Node, lower: Lowerer): Type {
  return (
    setType(key, lower) ?? lower.fail(at, 'E_CAPABILITY', `The context ${key.label} is never set`)
  );
}

/** The type every `setContext(key, v)` of the program sets; null where none does. */
function setType({ key, label }: Key, lower: Lowerer): Type | null {
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
          keyText(n.arguments[0], lower)?.key === key
        ) {
          const t = lower.types.of(n.arguments[1]);
          if (type !== undefined && JSON.stringify(t) !== JSON.stringify(type))
            lower.fail(
              n,
              'E_CAPABILITY',
              `The context ${label} is set with values of different types`,
            );
          type = t;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    known.set(key, type ?? null);
  }
  return known.get(key) ?? null;
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
    args: [{ op: 'lit', value: key.key }, lower.coerce(node.arguments[1], b, t)],
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
    args: [{ op: 'lit', value: key.key }],
    type: { maybe: t },
  };
  const here = lower.checker.getTypeAtLocation(node);
  if (lower.checker.getNonNullableType(here) !== here) return read;
  // The value type cannot hold Svelte's undefined: no parent set it.
  let getters = present.get(lower);
  if (!getters) present.set(lower, (getters = new Map()));
  let fn = getters.get(key.key);
  if (fn === undefined) {
    fn = lower.reserve();
    getters.set(key.key, fn);
    const value: Expr = { op: 'local', local: 0 };
    lower.functions[fn] = {
      name: `getContext:${key.label}`,
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
                    value: `getContext(${key.label}): no parent component set it, and its value type cannot hold undefined`,
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

/**
 * `hasContext(key)`: whether the instance or a parent set the key. Svelte
 * looks the key up in the same map as getContext, so it is whether
 * getContext finds a value, where the set value type cannot hold undefined
 * (a set undefined is a value to hasContext). A key nothing in the program
 * sets is never there.
 */
function hasContext(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr {
  if (node.arguments.length !== 1) lower.fail(node, 'E_CAPABILITY', 'hasContext takes a key');
  const key = keyOf(node, lower, 'hasContext');
  const t = setType(key, lower);
  void b;
  if (t === null) return { op: 'lit', value: false };
  if (typeof t === 'object' && 'maybe' in t)
    lower.fail(
      node,
      'E_CAPABILITY',
      `hasContext(${key.label}): the context is set with values that may be undefined, which hasContext tells apart from no value`,
    );
  return {
    op: 'not',
    arg: {
      op: 'builtin',
      name: 'maybe.is-undefined',
      args: [
        {
          op: 'builtin',
          name: 'context.get',
          args: [{ op: 'lit', value: key.key }],
          type: { maybe: t },
        },
      ],
      type: 'boolean',
    },
  };
}

/** The functions reading a context whose value must be present, by key (per program). */
const present = new WeakMap<Lowerer, Map<string, number>>();
