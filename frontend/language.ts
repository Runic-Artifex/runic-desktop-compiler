// Shared lowering of TypeScript/JavaScript statements and expressions to IR
// schema 4 (docs/design/M2-VALUES.md). Framework adapters supply only the
// semantics of their reactive bindings through `Hooks`.
import ts from 'typescript';
import path from 'node:path';
import {
  EVENT_KINDS,
  type EventKind,
  type Expr,
  type Fn,
  type Global,
  type Local,
  type Place,
  type Stmt,
  type Type,
} from './ir.ts';
import { sameType, TypeMapper, type Fail } from './types.ts';
import {
  builtinType,
  ELEMENT_METRICS,
  EVENT_MEMBERS,
  irType,
  maybeInner,
  WINDOW_METRICS,
} from './irtype.ts';
import { DOM } from './program.ts';
import { asyncBody, isAsync } from './async.ts';
import { allCertain, analyze, literalParts, syntaxError, type RegexInfo } from './regexp.ts';

export type Binding =
  | { kind: 'local'; owner: FnBuilder; local: number }
  /** A field (path) of a local's record, e.g. a destructured list item. */
  | { kind: 'member'; owner: FnBuilder; local: number; path: number[] }
  | { kind: 'cell'; cell: number }
  /** `stable`: one function object per instance (script-level functions of Svelte and Vue, module functions). */
  | { kind: 'function'; fn: number; stable?: boolean }
  /** A function with untyped parameters: specialised per call-site argument types. */
  | {
      kind: 'generic';
      decl: ts.FunctionLikeDeclaration;
      name: string;
      component: number | undefined;
      specs: Map<string, number>;
    }
  | { kind: 'derived'; fn: number }
  | { kind: 'value'; expr: Expr }
  /** A ref object: `x.value` (Vue) or `x.<field>` (React `current`) reads and writes the cell. */
  | { kind: 'ref'; cell: number; field?: string }
  /** A Vue computed (`x.value` calls the derived function). */
  | { kind: 'computed'; fn: number }
  /** A component's props object (inlined components): member reads are values. */
  | { kind: 'props'; values: Map<string, Expr> }
  /** A handler's event parameter. */
  | { kind: 'event'; handler: FnBuilder };

/** The member of a ref object that holds its value (`value` unless the binding names one). */
const refField = (b: { field?: string }): string => b.field ?? 'value';

export interface Hooks {
  /** The expression reading `cell` in `ctx` (read mode is framework semantics). */
  readCell(cell: number, ctx: FnBuilder, node: ts.Node): Expr;
  /** The IR type of `cell` (for narrowing at use sites). */
  cellType(cell: number): Type;
  /** Statements writing `value` to `cell` (immediate in Svelte/Vue, queued in React). */
  writeCell?(cell: number, value: Expr, ctx: FnBuilder, node: ts.Node): Stmt[];
  /** Adapter intrinsics (runes, setters). Return undefined to use the default lowering. */
  call?(node: ts.CallExpression, ctx: FnBuilder, lower: Lowerer): Expr | undefined;
  /** Statement-level intrinsics (e.g. React setters). */
  statement?(node: ts.Expression, ctx: FnBuilder, lower: Lowerer): Stmt[] | undefined;
}

/** Builds one IR function (or handler body) and its local index space. */
export type HandlerEvent = EventKind;

export class FnBuilder {
  readonly captures: Local[] = [];
  readonly params: Local[] = [];
  readonly locals: Local[] = [];
  /** Outer (owner, local) → capture index, for closures. */
  readonly captureOf = new Map<string, number>();
  readonly captureSources: { owner: FnBuilder; local: number }[] = [];
  /** Labels of enclosing loops: [label, isRealLoop]. */
  readonly loops: {
    label: string;
    real: boolean;
    /** A loop of an async state machine: `break`/`continue` jump to states. */
    jump?: { break: Stmt[]; continue: Stmt[] };
  }[] = [];
  /** In an async state machine: `return` settles the function's promise. */
  asyncReturn?: (e: ts.Expression | undefined, node: ts.Node) => Stmt[];
  private labelCounter = 0;

  readonly name: string;
  readonly parent: FnBuilder | undefined;
  readonly component: number | undefined;
  /** Symbols captured and mutated somewhere: their locals are boxed. */
  readonly boxed: Set<ts.Symbol>;
  /** The event of a handler builder. */
  readonly event: HandlerEvent | undefined;
  /** A local holding the event object, for the handler and closures inside it. */
  eventLocal: number | undefined;
  /** The declared result type of a function builder (its returns convert to it). */
  result: Type | undefined;
  /** A template builder (its expressions are evaluated on every update; no body). */
  template = false;
  /**
   * Function values hoisted into this root builder (`Lowerer.hoistFunctionValues`):
   * function index → the local holding its one function object for this invocation.
   */
  readonly functionValues = new Map<number, number>();

  constructor(
    name: string,
    parent: FnBuilder | undefined,
    component: number | undefined,
    boxed: Set<ts.Symbol>,
    event: boolean | HandlerEvent,
  ) {
    this.name = name;
    this.parent = parent;
    this.component = component;
    this.boxed = boxed;
    this.event = event === true ? 'input' : event === false ? undefined : event;
  }

  // Provisional local indices: params and locals count from 0; captures,
  // discovered while the body is lowered, are -1, -2, ... The final IR index
  // space is [...captures, ...params, ...locals] (see `final`).
  local(name: string, type: Type, boxed = false): number {
    this.locals.push({ name, type, ...(boxed ? { boxed } : {}) });
    return this.params.length + this.locals.length - 1;
  }
  param(name: string, type: Type, boxed = false): number {
    if (this.locals.length) throw new Error('parameters must precede locals');
    this.params.push({ name, type, ...(boxed ? { boxed } : {}) });
    return this.params.length - 1;
  }
  private slot(index: number): Local {
    return index < 0 ? this.captures[-index - 1] : [...this.params, ...this.locals][index];
  }
  typeOf(index: number): Type {
    return this.slot(index).type;
  }
  final(index: number): number {
    return index < 0 ? -index - 1 : index + this.captures.length;
  }
  label(prefix: string) {
    return `${prefix}${++this.labelCounter}`;
  }
  /** Local index in this function for `local` of `owner`, capturing through closures. */
  resolve(owner: FnBuilder, local: number): number {
    if (owner === this) return local;
    if (!this.parent) throw new Error('unresolved capture');
    const key = `${owner.name}#${local}#${ownerId(owner)}`;
    const known = this.captureOf.get(key);
    if (known !== undefined) return known;
    const outer = this.parent.resolve(owner, local);
    const l = owner.slot(local);
    this.captures.push({ name: l.name, type: l.type, ...(l.boxed ? { boxed: true } : {}) });
    this.captureSources.push({ owner: this.parent, local: outer });
    const index = -this.captures.length;
    this.captureOf.set(key, index);
    return index;
  }
}
const ids = new WeakMap<FnBuilder, number>();
let nextId = 0;
const ownerId = (f: FnBuilder) => {
  if (!ids.has(f)) ids.set(f, ++nextId);
  return ids.get(f);
};

const BOOLEAN: Type = 'boolean';
const NUMBER: Type = 'number';
const STRING: Type = 'string';

export class Lowerer {
  readonly functions: Fn[] = [];
  /** Module constants shared by all components (program globals). */
  readonly globals: Global[] = [];
  readonly bindings = new Map<ts.Symbol, Binding>();
  /**
   * Component functions are created once per instance (Svelte and Vue
   * scripts run once); otherwise once per render (React).
   */
  stableFunctions = false;
  /**
   * With per-render functions (React): a component function used as a value
   * is one function object per invocation of the outermost function around
   * the use (an effect, a handler, a component function; their nested
   * closures share it), so that `addEventListener(f)` and a cleanup's
   * `removeEventListener(f)` see the same object, as within one React render.
   * Template expressions still create one object per evaluation.
   */
  hoistFunctionValues = false;
  /** Types of hoisted function-value locals, completed by `settleFunctionValues`. */
  private readonly hoistedTypes: { fn: number; type: { fn: { params: Type[]; result: Type } } }[] =
    [];

  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly types: TypeMapper;
  readonly hooks: Hooks;
  readonly fail: Fail;
  readonly sourceOf: (node: ts.Node) => { file: string; line: number; column: number } | undefined;

  constructor(
    program: ts.Program,
    checker: ts.TypeChecker,
    types: TypeMapper,
    hooks: Hooks,
    fail: Fail,
    sourceOf: (node: ts.Node) => { file: string; line: number; column: number } | undefined,
  ) {
    this.program = program;
    this.checker = checker;
    this.types = types;
    this.hooks = hooks;
    this.fail = fail;
    this.sourceOf = sourceOf;
  }

  symbol(node: ts.Node): ts.Symbol | undefined {
    const s = this.checker.getSymbolAtLocation(node);
    return s && s.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(s) : s;
  }

  /** Symbols in `body` that are captured by nested functions and assigned anywhere. */
  analyseCaptures(body: ts.Node): Set<ts.Symbol> {
    const declaredIn = new Map<ts.Symbol, ts.Node>();
    const captured = new Set<ts.Symbol>();
    const mutated = new Set<ts.Symbol>();
    const fnOf = (n: ts.Node): ts.Node | undefined => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent)
        if (ts.isFunctionLike(p)) return p;
      return undefined;
    };
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
        const s = ts.isIdentifier(n.name) ? this.checker.getSymbolAtLocation(n.name) : undefined;
        if (s) declaredIn.set(s, fnOf(n) ?? body);
      }
      if (ts.isIdentifier(n)) {
        const s = this.checker.getSymbolAtLocation(n);
        if (s) {
          const isTarget =
            (ts.isBinaryExpression(n.parent) &&
              n.parent.left === n &&
              isAssignmentOperator(n.parent.operatorToken.kind)) ||
            ((ts.isPrefixUnaryExpression(n.parent) || ts.isPostfixUnaryExpression(n.parent)) &&
              [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
                n.parent.operator,
              ));
          if (isTarget) mutated.add(s);
          const home = declaredIn.get(s);
          if (home && fnOf(n) !== home) captured.add(s);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return new Set([...captured].filter(s => mutated.has(s)));
  }

  // -------------------------------------------------------------------------
  // Functions

  /** Reserve a function index (hoisting: bindings exist before bodies are lowered). */
  reserve(): number {
    this.functions.push(undefined as unknown as Fn);
    return this.functions.length - 1;
  }

  /** Lower a function-like declaration into a new (or reserved) IR function. */
  function(
    decl: ts.FunctionLikeDeclaration,
    name: string,
    parent: FnBuilder | undefined,
    component: number | undefined,
    reserved?: number,
    paramTypes?: Type[],
    /** Array-pattern parameters of tuple type take one parameter per element (callers pass them separately). */
    options?: { tupleParams?: boolean },
  ): { index: number; builder: FnBuilder } {
    const boxed = this.analyseCaptures(decl);
    for (const s of parent?.boxed ?? []) boxed.add(s);
    // An async function's state machine shares its parameters across steps.
    const async = isAsync(decl);
    if (async)
      for (const p of decl.parameters) {
        const sym = ts.isIdentifier(p.name) && this.checker.getSymbolAtLocation(p.name);
        if (sym) boxed.add(sym);
      }
    const b = new FnBuilder(name, parent, component, boxed, false);
    const index = reserved ?? this.reserve();
    // Captures are discovered while lowering the body; params are added first
    // in a separate list, so indices are fixed up by `finish`.
    const sig = this.checker.getSignatureFromDeclaration(decl);
    if (!sig) this.fail(decl, 'E_FUNCTION', 'Cannot resolve the function signature');
    const paramDecls = decl.parameters;
    const pending: {
      symbol?: ts.Symbol;
      type: Type;
      name: string;
      initializer?: ts.Expression;
    }[] = [];
    for (const p of paramDecls) {
      if (p.dotDotDotToken) this.fail(p, 'E_FUNCTION', 'Rest parameters are planned for later');
      if (options?.tupleParams && ts.isArrayBindingPattern(p.name)) {
        const pattern = p.name;
        const tuple = this.checker.getTypeAtLocation(p);
        if (!this.checker.isTupleType(tuple))
          this.fail(p, 'E_FUNCTION', 'Array parameter patterns destructure tuples here');
        const elements = this.checker.getTypeArguments(tuple as ts.TypeReference);
        if (pattern.elements.length > elements.length)
          this.fail(p, 'E_FUNCTION', 'More names than tuple elements');
        elements.forEach((t, i) => {
          const el = pattern.elements[i];
          const named = el && !ts.isOmittedExpression(el) ? el : undefined;
          if (named && (named.dotDotDotToken || named.initializer || !ts.isIdentifier(named.name)))
            this.fail(named, 'E_FUNCTION', 'Tuple parameters destructure into plain names');
          pending.push({
            symbol: named && this.checker.getSymbolAtLocation(named.name),
            type: this.types.map(t, named ?? p),
            name: named ? (named.name as ts.Identifier).text : `$${i}`,
          });
        });
        continue;
      }
      const type =
        paramTypes?.[pending.length] ?? this.types.map(this.checker.getTypeAtLocation(p), p);
      if (!ts.isIdentifier(p.name))
        this.fail(p, 'E_FUNCTION', 'Destructured parameters are planned for later');
      // An overridden parameter type also holds where the parameter is read.
      const given = paramTypes?.[pending.length];
      const symbol = this.checker.getSymbolAtLocation(p.name);
      if (given && symbol) this.types.override(symbol, given);
      pending.push({
        symbol: this.checker.getSymbolAtLocation(p.name),
        type,
        name: p.name.text,
        initializer: p.initializer,
      });
    }
    const tsResult = sig!.getReturnType();
    let result: Type =
      tsResult.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
        ? 'void'
        : this.types.map(tsResult, decl);
    // A function expression where a void-returning function is expected
    // (a listener, a callback): its value is never observed.
    // (Not under `satisfies`, which keeps the expression's own type.)
    let holder: ts.Node = decl.parent;
    while (ts.isParenthesizedExpression(holder)) holder = holder.parent;
    const expected =
      (ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) &&
      !async &&
      !ts.isSatisfiesExpression(holder)
        ? this.checker.getContextualType(decl)?.getCallSignatures()
        : undefined;
    const voidContext =
      expected?.length === 1 && !!(expected[0].getReturnType().flags & ts.TypeFlags.Void);
    if (voidContext) result = 'void';
    // Body lowering may add captures; params/locals are appended after, so we
    // lower into a staging builder and rebase indices at the end.
    if (voidContext || !(tsResult.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
      b.result = result;
    const lowered = this.withParams(b, pending, () => {
      if (!async) return this.functionBody(decl, b);
      if (!(typeof result === 'object' && 'promise' in result))
        return this.fail(decl, 'E_ASYNC', 'An async function needs a Promise result type');
      return asyncBody(this, decl, b, result.promise);
    });
    if (!voidContext && tsResult.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      result = this.returnType(lowered, b);
    lowered.unshift(...this.hoistedLets(b));
    const body = remapLocals(lowered, i => b.final(i));
    const fn: Fn = {
      name,
      ...(component !== undefined ? { component } : {}),
      ...(b.captures.length ? { captures: b.captures } : {}),
      params: b.params,
      locals: b.locals,
      result,
      body,
      ...(this.sourceOf(decl) ? { source: this.sourceOf(decl) } : {}),
    };
    this.functions[index] = fn;
    return { index, builder: b };
  }

  /** The type of the values returned by a lowered body (untyped functions). */
  private returnType(body: Stmt[], b: FnBuilder): Type {
    let found: Type | undefined;
    const visit = (stmts: Stmt[]) => {
      for (const s of stmts) {
        if (s.op === 'return' && s.value && !found) found = this.irType(s.value, b);
        for (const v of Object.values(s))
          if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'op' in v[0])
            visit(v as Stmt[]);
        if (s.op === 'try') {
          if (s.catch) visit(s.catch.body);
          if (s.finally) visit(s.finally);
        }
      }
    };
    visit(body);
    return found ?? 'void';
  }

  /** Params are registered as locals of the builder before the body is lowered. */
  private withParams(
    b: FnBuilder,
    pending: { symbol?: ts.Symbol; type: Type; name: string; initializer?: ts.Expression }[],
    lower: () => Stmt[],
  ): Stmt[] {
    // Lower once to discover captures without registering anything else.
    const params: { index: number; p: (typeof pending)[number] }[] = [];
    for (const p of pending) {
      const index = b.param(p.name, p.type, !!p.symbol && b.boxed.has(p.symbol));
      params.push({ index, p });
      if (p.symbol) this.bindings.set(p.symbol, { kind: 'local', owner: b, local: index });
    }
    const body: Stmt[] = [];
    for (const { index, p } of params) {
      if (p.initializer) {
        // Default parameter: if (param === undefined) param = default.
        body.push({
          op: 'if',
          test: {
            op: 'builtin',
            name: 'maybe.is-undefined',
            args: [{ op: 'local', local: index }],
            type: BOOLEAN,
          },
          then: [
            {
              op: 'assign',
              target: { place: 'local', local: index },
              value: this.expr(p.initializer, b),
            },
          ],
        });
      }
    }
    body.push(...lower());
    return body;
  }

  private functionBody(decl: ts.FunctionLikeDeclaration, b: FnBuilder): Stmt[] {
    if (!decl.body) this.fail(decl, 'E_FUNCTION', 'Function without body');
    if (ts.isBlock(decl.body!)) return this.block(decl.body.statements, b);
    // Expression-bodied arrow.
    const e = decl.body as ts.Expression;
    const custom = this.hooks.statement?.(skipParens(e), b, this);
    if (custom) return custom;
    if (this.isStatementLike(e))
      return [...this.statement(ts.factory.createExpressionStatement(e), b, e)];
    const value = this.expr(e, b);
    if (b.result === 'void' && this.irType(value, b) !== 'void') return [{ op: 'expr', value }];
    return [{ op: 'return', value }];
  }

  /** Assignments and update expressions used for their effect. */
  isStatementLike(e: ts.Expression): boolean {
    e = skipParens(e);
    return (
      (ts.isBinaryExpression(e) && isAssignmentOperator(e.operatorToken.kind)) ||
      ((ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(e.operator)) ||
      ts.isVoidExpression(e)
    );
  }

  /**
   * Lower an inline event handler (arrow/function expression) into handler
   * locals and body. Its first parameter is the event object.
   */
  /** The builder of a component template; its locals are the template locals. */
  template(component: number): FnBuilder {
    const b = new FnBuilder('template', undefined, component, new Set(), false);
    b.template = true;
    return b;
  }

  /**
   * Lower an inline event handler. Inside a template scope (`parent`), values
   * it captures (list items) become handler params, passed by the listener as
   * `args`.
   */
  handler(
    decl: ts.FunctionLikeDeclaration,
    component: number,
    /** The handler's event (`true` means input, `false` click). */
    input: boolean | HandlerEvent,
    parent?: FnBuilder,
  ): { params?: Local[]; locals: Local[]; body: Stmt[]; args?: Expr[] } {
    const boxed = this.analyseCaptures(decl);
    const b = new FnBuilder('handler', parent, component, boxed, input);
    const event = decl.parameters[0];
    if (event) {
      if (!ts.isIdentifier(event.name))
        this.fail(event, 'E_EVENT', 'Destructured event parameters are unsupported');
      this.bindings.set(this.checker.getSymbolAtLocation(event.name)!, {
        kind: 'event',
        handler: b,
      });
    }
    if (decl.parameters.length > 1)
      this.fail(decl.parameters[1], 'E_EVENT', 'Event handlers take at most one parameter');
    let body: Stmt[];
    if (isAsync(decl)) {
      for (const p of decl.parameters) {
        const sym = ts.isIdentifier(p.name) && this.checker.getSymbolAtLocation(p.name);
        if (sym) b.boxed.add(sym);
      }
      const ret = this.checker.getSignatureFromDeclaration(decl)?.getReturnType();
      const t = ret ? this.types.map(ret, decl) : undefined;
      body = asyncBody(
        this,
        decl,
        b,
        typeof t === 'object' && 'promise' in t ? t.promise : 'void',
        true,
      );
    } else body = this.functionBody(decl, b);
    // A handler's value is discarded: `() => items.push(x)` runs for its effect.
    if (decl.body && !ts.isBlock(decl.body) && body.length === 1 && body[0].op === 'return')
      body = body[0].value ? [{ op: 'expr', value: body[0].value }] : [];
    body.unshift(...this.hoistedLets(b));
    if (b.eventLocal !== undefined)
      body.unshift({ op: 'let', local: b.eventLocal, value: { op: 'event' } });
    if (!b.captures.length) return { locals: b.locals, body };
    return {
      params: b.captures,
      locals: b.locals,
      body: remapLocals(body, i => b.final(i)),
      args: b.captureSources.map(c => ({ op: 'local', local: c.local }) as Expr),
    };
  }

  /**
   * The handler of a two-way binding (`bind:value`, `v-model`): assigns the
   * event payload to `target`. Inside a template scope, captured list items
   * become handler params passed by the listener as `args`.
   */
  bindHandler(
    target: ts.Expression,
    component: number,
    event: HandlerEvent,
    parent: FnBuilder,
    /** The value written (default: the event payload). */
    value: Expr = { op: 'payload' },
  ): { params?: Local[]; locals: Local[]; body: Stmt[]; args?: Expr[] } {
    const b = new FnBuilder('bind', parent, component, new Set(), event);
    const body = this.writeTo(target, value, b);
    if (!b.captures.length) return { locals: b.locals, body };
    return {
      params: b.captures,
      locals: b.locals,
      body: remapLocals(body, i => b.final(i)),
      args: b.captureSources.map(c => ({ op: 'local', local: c.local }) as Expr),
    };
  }

  /**
   * Lower a template or initialiser expression. Expressions that need
   * temporaries become a component function that is called in place.
   */
  value(e: ts.Expression, component: number | undefined, name: string): Expr {
    const b = new FnBuilder(name, undefined, component, new Set(), false);
    const v = this.expr(e, b);
    if (!b.locals.length) return v;
    const index = this.reserve();
    this.functions[index] = {
      name,
      ...(component !== undefined ? { component } : {}),
      params: [],
      locals: b.locals,
      result: this.exprType(e),
      body: [...this.hoistedLets(b), { op: 'return', value: v }],
    };
    return { op: 'call', function: index, args: [] };
  }

  /** The value of function binding `fn` in `b` (see `hoistFunctionValues`). */
  private functionValue(fn: number, stable: boolean, id: ts.Identifier, b: FnBuilder): Expr {
    const value: Expr = {
      op: 'closure',
      function: fn,
      captures: [],
      ...(stable ? { stable } : {}),
    };
    if (stable || !this.hoistFunctionValues) return value;
    let root = b;
    while (root.parent && !root.parent.template) root = root.parent;
    if (root.template) return value;
    let local = root.functionValues.get(fn);
    if (local === undefined) {
      // The function may not be lowered yet: its signature's types now, the
      // lowered ones once every function is (the object is shared by captures).
      const sig = this.checker.getTypeAtLocation(id).getCallSignatures()[0];
      const type = {
        fn: {
          params: (sig?.parameters ?? []).map(p =>
            this.types.map(this.checker.getTypeOfSymbolAtLocation(p, id), id),
          ),
          result: this.functions[fn]?.result ?? 'void',
        },
      };
      this.hoistedTypes.push({ fn, type });
      local = root.local(`${id.text}$fn`, type);
      root.functionValues.set(fn, local);
    }
    return { op: 'local', local: b.resolve(root, local) };
  }

  /** `let` statements creating the function values hoisted into root builder `b`. */
  private hoistedLets(b: FnBuilder): Stmt[] {
    return [...b.functionValues].map(([fn, local]) => ({
      op: 'let',
      local,
      value: { op: 'closure', function: fn, captures: [] },
    }));
  }

  /** Complete the types of hoisted function values (once every function is lowered). */
  settleFunctionValues(): void {
    for (const { fn, type } of this.hoistedTypes) {
      type.fn.params = this.functions[fn].params.map(p => p.type);
      type.fn.result = this.functions[fn].result;
    }
  }

  /** A closure expression for an inline function. */
  closure(decl: ts.FunctionLikeDeclaration, ctx: FnBuilder, name = 'closure'): Expr {
    const { index, builder } = this.function(decl, `${ctx.name}.${name}`, ctx, ctx.component);
    return { op: 'closure', function: index, captures: builder.captureSources.map(c => c.local) };
  }

  // -------------------------------------------------------------------------
  // Statements

  block(statements: readonly ts.Statement[], b: FnBuilder): Stmt[] {
    return statements.flatMap(s => this.statement(s, b));
  }

  private src(node: ts.Node) {
    const s = this.sourceOf(node);
    return s ? { source: s } : {};
  }

  statement(s: ts.Statement, b: FnBuilder, origin: ts.Node = s): Stmt[] {
    const K = ts.SyntaxKind;
    if (ts.isBlock(s)) return this.block(s.statements, b);
    if (ts.isEmptyStatement(s)) return [];
    if (ts.isVariableStatement(s)) {
      const out: Stmt[] = [];
      for (const d of s.declarationList.declarations) out.push(...this.declaration(d, b));
      return out;
    }
    if (ts.isExpressionStatement(s)) return this.expressionStatement(s.expression, b, origin);
    if (ts.isIfStatement(s)) {
      return [
        {
          op: 'if',
          test: this.condition(s.expression, b),
          then: this.statement(s.thenStatement, b),
          ...(s.elseStatement ? { else: this.statement(s.elseStatement, b) } : {}),
          ...this.src(s),
        },
      ];
    }
    if (ts.isReturnStatement(s) && b.asyncReturn) return b.asyncReturn(s.expression, s);
    if (ts.isReturnStatement(s)) {
      let value = s.expression && this.expr(s.expression, b);
      if (value && b.result === 'void' && this.irType(value, b) !== 'void')
        return [
          { op: 'expr', value },
          { op: 'return', ...this.src(s) },
        ];
      // `T | undefined` results: a returned T is wrapped.
      const inner = b.result && maybeInner(b.result);
      if (value && inner && sameType(this.irType(value, b), inner)) value = { op: 'some', value };
      return [{ op: 'return', ...(value ? { value } : {}), ...this.src(s) }];
    }
    if (ts.isThrowStatement(s))
      return [{ op: 'throw', value: this.expr(s.expression, b), ...this.src(s) }];
    if (ts.isWhileStatement(s))
      return this.loop(s, b, label => [
        {
          op: 'while',
          test: this.condition(s.expression, b),
          body: this.statement(s.statement, b),
          label,
        },
      ]);
    if (ts.isDoStatement(s))
      return this.loop(s, b, label => [
        {
          op: 'while',
          test: { op: 'lit', value: true },
          body: [
            ...this.statement(s.statement, b),
            {
              op: 'if',
              test: { op: 'not', arg: this.condition(s.expression, b) },
              then: [{ op: 'break', label }],
            },
          ],
          label,
        },
      ]);
    if (ts.isForStatement(s)) {
      const init: Stmt[] = [];
      if (s.initializer) {
        if (ts.isVariableDeclarationList(s.initializer)) {
          if (s.initializer.flags & ts.NodeFlags.Let && this.capturedInLoop(s))
            this.fail(
              s,
              'E_LOOP_CAPTURE',
              'Closures capturing a per-iteration let binding are planned for later',
            );
          for (const d of s.initializer.declarations) init.push(...this.declaration(d, b));
        } else init.push(...this.expressionStatement(s.initializer, b, s.initializer));
      }
      return [
        ...init,
        ...this.loop(s, b, label => [
          {
            op: 'while',
            test: s.condition ? this.condition(s.condition, b) : { op: 'lit', value: true },
            body: this.statement(s.statement, b),
            ...(s.incrementor
              ? { update: this.expressionStatement(s.incrementor, b, s.incrementor) }
              : {}),
            label,
          },
        ]),
      ];
    }
    if (ts.isForOfStatement(s)) {
      if (s.awaitModifier) this.fail(s, 'E_ASYNC', 'for await is planned for M4');
      const iterable = this.expr(s.expression, b);
      const iterType = this.irType(iterable, b);
      const init = s.initializer;
      if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1)
        this.fail(s, 'E_STATEMENT', 'for-of requires a single declared loop variable');
      const decl = (init as ts.VariableDeclarationList).declarations[0];
      const elementType = this.iterationType(s.expression, iterType);
      if (ts.isIdentifier(decl.name)) {
        const sym = this.checker.getSymbolAtLocation(decl.name)!;
        const local = b.local(decl.name.text, elementType, b.boxed.has(sym));
        this.bindings.set(sym, { kind: 'local', owner: b, local });
        return this.loop(s, b, label => [
          {
            op: 'for-of',
            local,
            iterable,
            body: this.statement(s.statement, b),
            label,
            ...this.src(s),
          },
        ]);
      }
      // Destructuring loop variable: bind a temporary, then destructure.
      const tmp = b.local('$item', elementType);
      return this.loop(s, b, label => [
        {
          op: 'for-of',
          local: tmp,
          iterable,
          body: [
            ...this.destructure(decl.name, { op: 'local', local: tmp }, elementType, b),
            ...this.statement(s.statement, b),
          ],
          label,
        },
      ]);
    }
    if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
      const op = ts.isBreakStatement(s) ? 'break' : 'continue';
      let label = s.label?.text;
      // Unlabelled continue targets the nearest real loop (not a switch).
      const target = label
        ? [...b.loops].reverse().find(l => l.label === label)
        : op === 'continue'
          ? [...b.loops].reverse().find(l => l.real)
          : b.loops.at(-1);
      if (!label) {
        if (!target) this.fail(s, 'E_STATEMENT', `${op} outside a loop`);
        label = target!.label;
      }
      if (target?.jump) return op === 'break' ? target.jump.break : target.jump.continue;
      return [{ op, label }];
    }
    if (ts.isLabeledStatement(s)) {
      const inner = s.statement;
      if (!(
        ts.isForStatement(inner) ||
        ts.isForOfStatement(inner) ||
        ts.isWhileStatement(inner) ||
        ts.isDoStatement(inner)
      ))
        this.fail(s, 'E_STATEMENT', 'Labels are supported on loops');
      LABELS.set(inner, s.label.text);
      return this.statement(inner, b);
    }
    if (ts.isSwitchStatement(s)) return this.switch(s, b);
    if (ts.isTryStatement(s)) {
      let handler: { local?: number; body: Stmt[] } | undefined;
      if (s.catchClause) {
        const v = s.catchClause.variableDeclaration;
        let local: number | undefined;
        if (v) {
          if (!ts.isIdentifier(v.name))
            this.fail(v, 'E_STATEMENT', 'Destructured catch bindings are planned for later');
          local = b.local((v.name as ts.Identifier).text, { record: this.errorRecord() });
          // `unknown` in TypeScript; our thrown values are Error records.
          this.types.override(this.checker.getSymbolAtLocation(v.name)!, {
            record: this.errorRecord(),
          });
          this.bindings.set(this.checker.getSymbolAtLocation(v.name)!, {
            kind: 'local',
            owner: b,
            local,
          });
        }
        handler = {
          ...(local !== undefined ? { local } : {}),
          body: this.block(s.catchClause.block.statements, b),
        };
      }
      return [
        {
          op: 'try',
          body: this.block(s.tryBlock.statements, b),
          ...(handler ? { catch: handler } : {}),
          ...(s.finallyBlock ? { finally: this.block(s.finallyBlock.statements, b) } : {}),
        },
      ];
    }
    if (ts.isFunctionDeclaration(s)) {
      // Nested function declarations are hoisted: bind before use.
      const name = s.name?.text ?? 'fn';
      const sym = s.name ? this.checker.getSymbolAtLocation(s.name) : undefined;
      const local = b.local(name, this.types.of(s.name ?? s));
      if (sym) this.bindings.set(sym, { kind: 'local', owner: b, local });
      return [{ op: 'let', local, value: this.closure(s, b, name) }];
    }
    if (s.kind === K.TypeAliasDeclaration || s.kind === K.InterfaceDeclaration) return [];
    return this.fail(s, 'E_STATEMENT', `Unsupported statement: ${K[s.kind]}`);
  }

  private errorIndex: number | undefined;
  /** The record type of caught errors ({ name, message }). */
  errorRecord(): number {
    if (this.errorIndex === undefined) {
      this.errorIndex = this.types.records.length;
      this.types.records.push({
        name: 'Error',
        fields: [
          { name: 'name', type: STRING },
          { name: 'message', type: STRING },
        ],
      });
    }
    return this.errorIndex;
  }

  private capturedInLoop(s: ts.ForStatement): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionLike(n)) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(s.statement);
    return found;
  }

  private loop(s: ts.IterationStatement, b: FnBuilder, make: (label: string) => Stmt[]): Stmt[] {
    const label = LABELS.get(s) ?? b.label('loop');
    b.loops.push({ label, real: true });
    try {
      return make(label);
    } finally {
      b.loops.pop();
    }
  }

  /** switch → a single-iteration labelled loop with explicit fallthrough. */
  private switch(s: ts.SwitchStatement, b: FnBuilder): Stmt[] {
    const label = b.label('switch');
    const disc = b.local('$switch', this.types.of(s.expression));
    const matched = b.local('$matched', BOOLEAN);
    b.loops.push({ label, real: false });
    try {
      const body: Stmt[] = [];
      const clauses = s.caseBlock.clauses;
      const hasDefault = clauses.some(ts.isDefaultClause);
      // Pass 1: cases in order (a default clause only participates through fallthrough).
      for (const c of clauses) {
        const test: Expr = ts.isCaseClause(c)
          ? {
              op: 'or',
              left: { op: 'local', local: matched },
              right: {
                op: 'eq',
                left: { op: 'local', local: disc },
                right: this.expr(c.expression, b),
              },
            }
          : { op: 'local', local: matched };
        body.push({
          op: 'if',
          test,
          then: [
            {
              op: 'assign',
              target: { place: 'local', local: matched },
              value: { op: 'lit', value: true },
            },
            ...this.block(c.statements, b),
          ],
        });
      }
      if (hasDefault) {
        // Pass 2: no case matched → start at default and fall through the rest.
        const start = clauses.findIndex(ts.isDefaultClause);
        const rest = clauses.slice(start).flatMap(c => this.block(c.statements, b));
        body.push({
          op: 'if',
          test: { op: 'not', arg: { op: 'local', local: matched } },
          then: rest,
        });
      }
      body.push({ op: 'break', label });
      return [
        { op: 'let', local: disc, value: this.expr(s.expression, b) },
        { op: 'let', local: matched, value: { op: 'lit', value: false } },
        { op: 'while', test: { op: 'lit', value: true }, body, label },
      ];
    } finally {
      b.loops.pop();
    }
  }

  private declaration(d: ts.VariableDeclaration, b: FnBuilder): Stmt[] {
    if (ts.isIdentifier(d.name)) {
      const sym = this.checker.getSymbolAtLocation(d.name)!;
      if (d.initializer && !d.type && this.isRegexpResult(d.initializer)) {
        // Captures that may not participate are `string | undefined`.
        const value = this.expr(d.initializer, b);
        const local = b.local(d.name.text, this.irType(value, b), b.boxed.has(sym));
        this.bindings.set(sym, { kind: 'local', owner: b, local });
        return [{ op: 'let', local, value, ...this.src(d) }];
      }
      const declared = this.types.typeOrUndefined(d.name);
      if (declared === undefined) {
        // TypeScript only knows `any`: the initialiser's IR type decides.
        if (!d.initializer)
          this.fail(
            d,
            'E_TYPE_UNSUPPORTED',
            `${d.name.text} needs a type annotation or an initialiser`,
          );
        const value = this.expr(d.initializer!, b);
        const local = b.local(d.name.text, this.irType(value, b), b.boxed.has(sym));
        this.bindings.set(sym, { kind: 'local', owner: b, local });
        return [{ op: 'let', local, value, ...this.src(d) }];
      }
      const type = declared;
      const local = b.local(d.name.text, type, b.boxed.has(sym));
      this.bindings.set(sym, { kind: 'local', owner: b, local });
      if (
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
      )
        return [{ op: 'let', local, value: this.closure(d.initializer, b, d.name.text) }];
      return [
        {
          op: 'let',
          local,
          ...(d.initializer ? { value: this.expr(d.initializer, b) } : {}),
          ...this.src(d),
        },
      ];
    }
    if (!d.initializer) this.fail(d, 'E_STATEMENT', 'Destructuring requires an initializer');
    const value = this.expr(d.initializer!, b);
    const type = this.irType(value, b);
    const tmp = b.local('$destructure', type);
    return [
      { op: 'let', local: tmp, value },
      ...this.destructure(d.name, { op: 'local', local: tmp }, type, b),
    ];
  }

  private destructure(pattern: ts.BindingName, source: Expr, type: Type, b: FnBuilder): Stmt[] {
    const out: Stmt[] = [];
    const bind = (name: ts.BindingName, value: Expr, t: Type, init?: ts.Expression) => {
      if (init) value = { op: 'nullish', left: value, right: this.expr(init, b) };
      if (ts.isIdentifier(name)) {
        const sym = this.checker.getSymbolAtLocation(name)!;
        const local = b.local(name.text, this.types.typeOrUndefined(name) ?? t, b.boxed.has(sym));
        this.bindings.set(sym, { kind: 'local', owner: b, local });
        out.push({ op: 'let', local, value });
      } else out.push(...this.destructure(name, value, t, b));
    };
    if (
      ts.isObjectBindingPattern(pattern) &&
      (type === 'string' || (typeof type === 'object' && 'array' in type))
    ) {
      for (const el of pattern.elements) {
        const key = (el.propertyName ?? el.name) as ts.Identifier;
        if (!ts.isIdentifier(key) || key.text !== 'length' || el.dotDotDotToken)
          this.fail(el, 'E_DESTRUCTURE', 'Only length can be destructured from strings and arrays');
        const length: Expr =
          type === 'string'
            ? { op: 'utf16-length', arg: source }
            : { op: 'builtin', name: 'array.length', args: [source], type: NUMBER };
        bind(el.name, length, NUMBER, el.initializer);
      }
      return out;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      if (typeof type !== 'object' || !('record' in type))
        this.fail(pattern, 'E_DESTRUCTURE', 'Object destructuring requires a record value');
      const record = (type as { record: number }).record;
      for (const el of pattern.elements) {
        if (el.dotDotDotToken)
          this.fail(el, 'E_DESTRUCTURE', 'Rest properties are planned for later');
        const key = (el.propertyName ?? el.name) as ts.Identifier;
        if (!ts.isIdentifier(key))
          this.fail(el, 'E_DESTRUCTURE', 'Computed destructuring keys are unsupported');
        const field = this.types.fieldIndex(record, key.text, el);
        bind(
          el.name,
          { op: 'get', object: source, field },
          this.types.records[record].fields[field].type,
          el.initializer,
        );
      }
    } else if (ts.isArrayBindingPattern(pattern)) {
      if (typeof type !== 'object' || !('array' in type))
        this.fail(pattern, 'E_DESTRUCTURE', 'Array destructuring requires an array value');
      const element = (type as { array: Type }).array;
      pattern.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return;
        if (el.dotDotDotToken) {
          bind(
            el.name,
            { op: 'builtin', name: 'array.slice', args: [source, { op: 'lit', value: i }], type },
            type,
          );
          return;
        }
        const declared = this.types.typeOrUndefined(el.name);
        const maybe = typeof declared === 'object' && 'maybe' in declared;
        if (maybeInner(element) && !maybe && !el.initializer)
          this.fail(
            el,
            'E_REGEXP',
            'This capture group may not participate in the match, so its value can be undefined; give the binding a default or the type string | undefined',
          );
        const read: Expr =
          el.initializer || maybe
            ? {
                op: 'builtin',
                name: 'array.get',
                args: [source, { op: 'lit', value: i }],
                type: { maybe: element },
              }
            : { op: 'index', array: source, index: { op: 'lit', value: i } };
        bind(el.name, read, element, el.initializer);
      });
    }
    return out;
  }

  private expressionStatement(e: ts.Expression, b: FnBuilder, origin: ts.Node): Stmt[] {
    e = skipParens(e);
    const custom = this.hooks.statement?.(e, b, this);
    if (custom) return custom;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken)
      return [
        ...this.expressionStatement(e.left, b, origin),
        ...this.expressionStatement(e.right, b, origin),
      ];
    if (ts.isBinaryExpression(e) && isAssignmentOperator(e.operatorToken.kind))
      return this.assignment(e.left, e.operatorToken.kind, e.right, b);
    if (
      (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(e.operator)
    ) {
      const op =
        e.operator === ts.SyntaxKind.PlusPlusToken
          ? ts.SyntaxKind.PlusEqualsToken
          : ts.SyntaxKind.MinusEqualsToken;
      return this.assignment(e.operand, op, { expr: { op: 'lit', value: 1 }, type: NUMBER }, b);
    }
    if (ts.isVoidExpression(e)) return this.expressionStatement(e.expression, b, origin);
    return [{ op: 'expr', value: this.expr(e, b), ...this.src(origin) }];
  }

  /**
   * The IR type of an assignment target. TypeScript reports `any` for
   * targets it rejects (e.g. Vue template `count++` on an unwrapped ref), so
   * bindings answer first.
   */
  private targetType(target: ts.Expression, b: FnBuilder): Type {
    if (ts.isIdentifier(target)) {
      const binding = this.binding(target);
      if (binding?.kind === 'cell') return this.hooks.cellType(binding.cell);
      if (binding?.kind === 'local') return b.typeOf(b.resolve(binding.owner, binding.local));
    }
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
      const ref = this.binding(target.expression);
      if (ref?.kind === 'ref' && target.name.text === refField(ref))
        return this.hooks.cellType(ref.cell);
    }
    return this.typeAt(target);
  }

  /** `target op= value` as statements. */
  assignment(
    target: ts.Expression,
    operator: ts.SyntaxKind,
    valueNode: ts.Expression | { expr: Expr; type: Type },
    b: FnBuilder,
  ): Stmt[] {
    target = skipParens(target);
    const compound = COMPOUND[operator];
    const current = () => this.expr(target, b);
    const rhs = () => ('expr' in valueNode ? valueNode.expr : this.expr(valueNode, b));
    // TypeScript's type of the value, or its IR type where TypeScript only knows `any`.
    const rhsType = (lowered: Expr) =>
      'expr' in valueNode
        ? valueNode.type
        : (this.types.typeOrUndefined(valueNode) ?? this.irType(lowered, b));
    let value: Expr;
    if (operator === ts.SyntaxKind.EqualsToken) value = rhs();
    else if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken)
      value = { op: 'nullish', left: current(), right: rhs() };
    else if (
      operator === ts.SyntaxKind.BarBarEqualsToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    )
      return this.fail(target, 'E_ASSIGN', 'Logical assignment operators are planned for later');
    else if (compound) {
      const right = rhs();
      value = this.binary(
        compound,
        current(),
        this.targetType(target, b),
        right,
        rhsType(right),
        target,
      );
    } else return this.fail(target, 'E_ASSIGN', 'Unsupported assignment operator');
    return this.writeTo(target, value, b);
  }

  /** Statements assigning `value` to an assignable expression (variable, state, field, element). */
  /** `document.documentElement`. */
  private isRoot(e: ts.Expression): boolean {
    e = skipParens(e);
    return (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === 'documentElement' &&
      this.hostName(e.expression) === 'document'
    );
  }

  /** A document element member: an attribute (`lang`, `dir`, `dataset.x`) or a style property. */
  private rootMember(e: ts.Expression): { kind: 'attr' | 'style'; name: string } | undefined {
    e = skipParens(e);
    if (!ts.isPropertyAccessExpression(e)) return undefined;
    const n = e.name.text;
    const kebab = (s: string) => s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    if (this.isRoot(e.expression))
      return ['lang', 'dir'].includes(n) ? { kind: 'attr', name: n } : undefined;
    const inner = skipParens(e.expression);
    if (!ts.isPropertyAccessExpression(inner) || !this.isRoot(inner.expression)) return undefined;
    if (inner.name.text === 'dataset') return { kind: 'attr', name: 'data-' + kebab(n) };
    if (inner.name.text === 'style') return { kind: 'style', name: kebab(n) };
    return undefined;
  }

  writeTo(target: ts.Expression, value: Expr, b: FnBuilder): Stmt[] {
    const root = this.rootMember(target);
    if (root) {
      const text: Expr =
        this.irType(value, b) === 'string' ? value : { op: 'to-string', arg: value };
      return [
        {
          op: 'expr',
          value: {
            op: 'builtin',
            name: root.kind === 'attr' ? 'root.set-attr' : 'root.style-set',
            args: [{ op: 'lit', value: root.name }, text],
            type: 'void',
          },
          ...this.src(target),
        },
      ];
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      target.name.text === 'lastIndex' &&
      this.types.typeOrUndefined(target.expression) === 'regexp'
    ) {
      if (!ts.isIdentifier(skipParens(target.expression)))
        return this.fail(target, 'E_REGEXP', 'Assign lastIndex of a RegExp held by a variable');
      return [
        {
          op: 'expr',
          value: {
            op: 'builtin',
            name: 'regexp.set-lastIndex',
            args: [this.expr(target.expression, b), value],
            type: 'void',
          },
          ...this.src(target),
        },
      ];
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      (target.name.text === 'scrollTop' || target.name.text === 'scrollLeft') &&
      this.types.typeOrUndefined(target.expression) === 'element'
    )
      return [
        {
          op: 'expr',
          value: {
            op: 'builtin',
            name: `element.set-${target.name.text}`,
            args: [this.expr(target.expression, b), value],
            type: 'void',
          },
          ...this.src(target),
        },
      ];
    // T is widened into a nullable target (Maybe<T>).
    const want = this.targetType(target, b);
    const have = this.irType(value, b);
    if (maybeInner(want) && !maybeInner(have) && have !== 'void') value = { op: 'some', value };
    if (ts.isIdentifier(target)) {
      const binding = this.binding(target);
      if (binding?.kind === 'local')
        return [
          {
            op: 'assign',
            target: { place: 'local', local: b.resolve(binding.owner, binding.local) },
            value,
            ...this.src(target),
          },
        ];
      if (binding?.kind === 'cell') {
        if (!this.hooks.writeCell)
          this.fail(target, 'E_ASSIGN', 'This framework does not support direct state assignment');
        return this.hooks.writeCell!(binding.cell, value, b, target);
      }
      return this.fail(target, 'E_ASSIGN', `Cannot assign to ${target.text}`);
    }
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
      const ref = this.binding(target.expression);
      if (ref?.kind === 'ref' && target.name.text === refField(ref))
        return this.hooks.writeCell!(ref.cell, value, b, target);
      if (ref?.kind === 'computed' && target.name.text === 'value')
        return this.fail(target, 'E_ASSIGN', 'Computed values are read-only');
    }
    return [{ op: 'assign', target: this.place(target, b), value, ...this.src(target) }];
  }

  private place(target: ts.Expression, b: FnBuilder): Place {
    if (ts.isPropertyAccessExpression(target)) {
      const type = this.typeAt(target.expression);
      if (typeof type === 'object' && 'record' in type)
        return {
          place: 'field',
          object: this.expr(target.expression, b),
          field: this.types.fieldIndex(type.record, target.name.text, target),
        };
    }
    if (ts.isElementAccessExpression(target)) {
      const type = this.typeAt(target.expression);
      if (typeof type === 'object' && 'array' in type)
        return {
          place: 'index',
          array: this.expr(target.expression, b),
          index: this.expr(target.argumentExpression, b),
        };
    }
    return this.fail(target, 'E_ASSIGN', 'Unsupported assignment target');
  }

  // -------------------------------------------------------------------------
  // Expressions

  binding(id: ts.Identifier): Binding | undefined {
    const s = this.symbol(id);
    return s ? this.bindings.get(s) : undefined;
  }

  typeOfNode(n: ts.Node): Type {
    return this.types.of(n);
  }

  /** The IR type of an expression lowered by `value` (no locals). */
  valueType(e: Expr): Type {
    return this.irType(e, new FnBuilder('value', undefined, undefined, new Set(), false));
  }

  /** The IR type of a lowered expression in function `b`. */
  irType(e: Expr, b: FnBuilder): Type {
    return irType(e, {
      local: i => b.typeOf(i),
      cell: c => this.hooks.cellType(c),
      records: this.types.records,
      functions: this.functions,
      globals: this.globals,
    });
  }

  /** A boolean test with JS truthiness. */
  condition(e: ts.Expression, b: FnBuilder): Expr {
    const v = this.expr(e, b);
    return this.truthy(v, this.irType(v, b));
  }

  truthy(v: Expr, t: Type): Expr {
    return t === 'boolean' ? v : { op: 'to-boolean', arg: v };
  }

  iterationType(e: ts.Expression, t: Type): Type {
    if (t === 'string') return 'string';
    if (typeof t === 'object' && 'array' in t) return t.array;
    if (typeof t === 'object' && 'set' in t) return t.set;
    if (typeof t === 'object' && 'map' in t) return { array: t.map[0] }; // [key, value] pairs need tuples
    return this.fail(e, 'E_ITERATE', 'for-of is supported over arrays, sets and strings');
  }

  expr(e: ts.Expression, b: FnBuilder): Expr {
    if (ts.isAwaitExpression(e))
      return this.fail(
        e,
        'E_ASYNC',
        'await is supported in async functions as a statement, an initialiser, an assignment or a return value',
      );
    const K = ts.SyntaxKind;
    const override = this.overrides.get(e);
    if (override) return override.expr;
    const groups = this.groupsAccess(e, b);
    if (groups) return groups;
    if (ts.isOptionalChain(e)) {
      const link = this.pendingLink(e);
      if (link) return this.optionalChain(e, link, b);
    }
    switch (e.kind) {
      case K.ParenthesizedExpression:
      case K.AsExpression:
      case K.SatisfiesExpression:
      case K.TypeAssertionExpression:
        return this.expr((e as ts.ParenthesizedExpression).expression, b);
      case K.NonNullExpression: {
        const inner = (e as ts.NonNullExpression).expression;
        const t = this.types.of(inner);
        const v = this.expr(inner, b);
        return (typeof t === 'object' && 'maybe' in t) || maybeInner(this.irType(v, b))
          ? { op: 'unwrap', value: v }
          : v;
      }
      case K.NumericLiteral:
        return { op: 'lit', value: Number((e as ts.NumericLiteral).text) };
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
        return this.stringLiteral(e, (e as ts.StringLiteral).text);
      case K.RegularExpressionLiteral:
        return this.regexLiteral(e as ts.RegularExpressionLiteral);
      case K.TrueKeyword:
        return { op: 'lit', value: true };
      case K.FalseKeyword:
        return { op: 'lit', value: false };
      case K.NullKeyword:
        return { op: 'null', type: this.contextual(e) };
      case K.TemplateExpression: {
        const t = e as ts.TemplateExpression;
        let out: Expr = this.stringLiteral(t.head, t.head.text);
        for (const span of t.templateSpans) {
          out = {
            op: 'concat',
            left: out,
            right: (v => this.stringify(v, this.irType(v, b)))(this.expr(span.expression, b)),
          };
          if (span.literal.text)
            out = {
              op: 'concat',
              left: out,
              right: this.stringLiteral(span.literal, span.literal.text),
            };
        }
        return out;
      }
      case K.Identifier:
        return this.identifier(e as ts.Identifier, b);
      case K.PrefixUnaryExpression:
        return this.prefix(e as ts.PrefixUnaryExpression, b);
      case K.BinaryExpression:
        return this.binaryExpression(e as ts.BinaryExpression, b);
      case K.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        return {
          op: 'cond',
          test: this.condition(c.condition, b),
          then: this.coerce(c.whenTrue, b, this.types.of(e)),
          else: this.coerce(c.whenFalse, b, this.types.of(e)),
        };
      }
      case K.TypeOfExpression:
        return { op: 'typeof', arg: this.expr((e as ts.TypeOfExpression).expression, b) };
      case K.PropertyAccessExpression:
        return this.property(e as ts.PropertyAccessExpression, b);
      case K.ElementAccessExpression:
        return this.element(e as ts.ElementAccessExpression, b);
      case K.CallExpression:
        return this.call(e as ts.CallExpression, b);
      case K.NewExpression:
        return this.newExpression(e as ts.NewExpression, b);
      case K.ArrowFunction:
      case K.FunctionExpression:
        return this.closure(e as ts.ArrowFunction, b);
      case K.ObjectLiteralExpression:
        return this.object(e as ts.ObjectLiteralExpression, b);
      case K.ArrayLiteralExpression:
        return this.array(e as ts.ArrayLiteralExpression, b);
      case K.VoidExpression:
        return { op: 'undefined', type: 'void' };
      default:
        if (this.isStatementLike(e))
          return this.fail(
            e,
            'E_ASSIGN_EXPR',
            'Assignments are supported as statements, not as values',
          );
        return this.fail(e, 'E_EXPRESSION', `Unsupported expression: ${K[e.kind]}`);
    }
  }

  /**
   * The IR type of an expression. Literals take their contextual type
   * (`[]` assigned to `Entry[]` is an `Entry[]`, not `never[]`).
   */
  exprType(e: ts.Expression): Type {
    const inner = skipParens(e);
    if (ts.isArrayLiteralExpression(inner) || ts.isObjectLiteralExpression(inner)) {
      let ctx = this.checker.getContextualType(inner);
      // The literal itself is never nullish, even where the context allows it.
      if (ctx) ctx = this.checker.getNonNullableType(ctx);
      // In a union context (e.g. useState's `S | (() => S)`) use the member
      // of the literal's own kind.
      if (ctx?.isUnion()) {
        const array = ts.isArrayLiteralExpression(inner);
        const members = ctx.types.filter(t =>
          array
            ? this.checker.isArrayType(t) || this.checker.isTupleType(t)
            : !!(t.flags & ts.TypeFlags.Object) && !t.getCallSignatures().length,
        );
        if (members.length === 1) ctx = members[0];
      }
      if (ctx) return this.types.map(ctx, inner);
    }
    return this.types.of(e);
  }

  /** Lower `e` and widen it to `target` (e.g. T into Maybe<T>). */
  coerce(e: ts.Expression, b: FnBuilder, target: Type): Expr {
    const v = this.expr(e, b);
    const t = this.irType(v, b);
    if (
      typeof target === 'object' &&
      'maybe' in target &&
      !(typeof t === 'object' && 'maybe' in t) &&
      t !== 'void'
    )
      return { op: 'some', value: v };
    return v;
  }

  private contextual(e: ts.Expression): Type {
    let t = this.checker.getContextualType(e);
    if (!t) {
      // A branch of a conditional without a contextual type (an untyped
      // `const`): the conditional's type.
      let node: ts.Node = e;
      while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
      const p = node.parent;
      if (ts.isConditionalExpression(p) && p.condition !== node)
        t = this.checker.getTypeAtLocation(p);
    }
    if (!t) return { maybe: NUMBER };
    const mapped = this.types.map(t, e);
    return typeof mapped === 'object' && 'maybe' in mapped ? mapped : { maybe: mapped };
  }

  stringify(v: Expr, t: Type): Expr {
    return t === 'string' ? v : { op: 'to-string', arg: v };
  }

  private identifier(id: ts.Identifier, b: FnBuilder): Expr {
    if (id.text === 'undefined' && !this.binding(id))
      return { op: 'undefined', type: this.contextual(id) };
    // NaN cannot be a JSON literal.
    if (id.text === 'NaN' && !this.binding(id))
      return { op: 'builtin', name: 'Number.NaN', args: [], type: NUMBER };
    if (id.text === 'Infinity' && !this.binding(id))
      return { op: 'builtin', name: 'Number.POSITIVE_INFINITY', args: [], type: NUMBER };
    const binding = this.binding(id);
    if (!binding)
      return this.fail(id, 'E_UNRESOLVED', `${id.text} is not a supported binding here`);
    return this.bindingExpr(binding, id, b);
  }

  /** The expression reading `binding` at `id` (narrowed to the type TypeScript sees there). */
  bindingExpr(binding: Binding, id: ts.Identifier, b: FnBuilder, here?: Type): Expr {
    // TypeScript narrows `T | undefined` to `T` after checks; unwrap there.
    const narrow = (e: Expr, declared: Type): Expr => {
      here ??= this.types.typeOrUndefined(id);
      if (here === undefined) return e;
      return typeof declared === 'object' &&
        'maybe' in declared &&
        !(typeof here === 'object' && 'maybe' in here) &&
        here !== 'void'
        ? { op: 'unwrap', value: e }
        : e;
    };
    switch (binding.kind) {
      case 'local': {
        const local = b.resolve(binding.owner, binding.local);
        return narrow({ op: 'local', local }, b.typeOf(local));
      }
      case 'member': {
        const local = b.resolve(binding.owner, binding.local);
        let e: Expr = { op: 'local', local };
        for (const field of binding.path) e = { op: 'get', object: e, field };
        return narrow(e, this.irType(e, b));
      }
      case 'cell':
        return narrow(this.hooks.readCell(binding.cell, b, id), this.hooks.cellType(binding.cell));
      case 'derived':
        return { op: 'call', function: binding.fn, args: [] };
      case 'value':
        return binding.expr;
      case 'function':
        // A function used as a value: wrap it in a closure forwarding its params.
        return this.functionValue(binding.fn, !!binding.stable, id, b);
      case 'props':
        return this.fail(
          id,
          'E_PROPS',
          'Use props through member access (props.name) or destructuring',
        );
      case 'ref':
      case 'computed':
        return this.fail(
          id,
          'E_REF',
          `Refs are supported through .${binding.kind === 'ref' ? refField(binding) : 'value'} (passing ref objects is planned for a later milestone)`,
        );
      case 'event':
        return this.eventValue(binding.handler, b);
      case 'generic':
        return this.fail(
          id,
          'E_FUNCTION',
          `${id.text} has untyped parameters, so it can only be called directly; add parameter types to pass it as a value`,
        );
    }
  }

  private prefix(e: ts.PrefixUnaryExpression, b: FnBuilder): Expr {
    const K = ts.SyntaxKind;
    const v = this.expr(e.operand, b);
    const t = this.irType(v, b);
    switch (e.operator) {
      case K.ExclamationToken:
        return { op: 'not', arg: this.truthy(v, t) };
      case K.MinusToken:
        return { op: 'neg', arg: t === 'number' ? v : { op: 'to-number', arg: v } };
      case K.PlusToken:
        return t === 'number' ? v : { op: 'to-number', arg: v };
      case K.TildeToken:
        return { op: 'bit-not', arg: t === 'number' ? v : { op: 'to-number', arg: v } };
      default:
        return this.fail(e, 'E_ASSIGN_EXPR', 'Increment/decrement is supported as a statement');
    }
  }

  private binaryExpression(e: ts.BinaryExpression, b: FnBuilder): Expr {
    const K = ts.SyntaxKind;
    const op = e.operatorToken.kind;
    if (isAssignmentOperator(op))
      return this.fail(
        e,
        'E_ASSIGN_EXPR',
        'Assignments are supported as statements, not as values',
      );
    if (op === K.CommaToken)
      return this.fail(e, 'E_EXPRESSION', 'Comma expressions are supported as statements');
    if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
      const left = this.expr(e.left, b);
      const lt = this.irType(left, b);
      let right = this.expr(e.right, b);
      const rt = this.irType(right, b);
      // The result type: TypeScript's (narrowed) type, or the operands' common type.
      const ts0 = this.types.typeOrUndefined(e);
      const result: Type =
        ts0 ?? (sameType(lt, rt) ? lt : maybeInner(lt) && sameType(maybeInner(lt)!, rt) ? rt : rt);
      if (maybeInner(result) && !maybeInner(rt) && rt !== 'void')
        right = { op: 'some', value: right };
      if (lt === 'boolean' && rt === 'boolean')
        return { op: op === K.AmpersandAmpersandToken ? 'and' : 'or', left, right };
      // JS value semantics: evaluate the left operand once.
      const tmp = b.local('$logical', lt);
      const read: Expr = { op: 'local', local: tmp };
      const keep = sameType(lt, result) ? read : ({ op: 'some', value: read } as Expr);
      const test = this.truthy(read, lt);
      return {
        op: 'with',
        local: tmp,
        value: left,
        body:
          op === K.AmpersandAmpersandToken
            ? { op: 'cond', test, then: right, else: keep }
            : { op: 'cond', test, then: keep, else: right },
      };
    }
    if (op === K.QuestionQuestionToken) {
      const left = this.expr(e.left, b);
      const result = this.types.typeOrUndefined(e) ?? maybeInner(this.irType(left, b)) ?? 'void';
      return { op: 'nullish', left, right: this.coerce(e.right, b, result) };
    }
    if (op === K.InKeyword || op === K.InstanceOfKeyword)
      return this.fail(e, 'E_EXPRESSION', 'in/instanceof are planned for later');
    const left = this.expr(e.left, b);
    const right = this.expr(e.right, b);
    return this.binary(op, left, this.irType(left, b), right, this.irType(right, b), e);
  }

  binary(op: ts.SyntaxKind, left: Expr, lt: Type, right: Expr, rt: Type, at: ts.Node): Expr {
    const K = ts.SyntaxKind;
    const num = (v: Expr, t: Type): Expr => (t === 'number' ? v : { op: 'to-number', arg: v });
    switch (op) {
      case K.PlusToken:
        if (lt === 'string' || rt === 'string')
          return { op: 'concat', left: this.stringify(left, lt), right: this.stringify(right, rt) };
        if (lt === 'number' && rt === 'number') return { op: 'add', left, right };
        return this.fail(at, 'E_OPERATOR', '+ is supported on numbers and strings');
      case K.MinusToken:
        return { op: 'sub', left: num(left, lt), right: num(right, rt) };
      case K.AsteriskToken:
        return { op: 'mul', left: num(left, lt), right: num(right, rt) };
      case K.SlashToken:
        return { op: 'div', left: num(left, lt), right: num(right, rt) };
      case K.PercentToken:
        return { op: 'rem', left: num(left, lt), right: num(right, rt) };
      case K.AsteriskAsteriskToken:
        return { op: 'pow', left: num(left, lt), right: num(right, rt) };
      case K.AmpersandToken:
        return { op: 'bit-and', left: num(left, lt), right: num(right, rt) };
      case K.BarToken:
        return { op: 'bit-or', left: num(left, lt), right: num(right, rt) };
      case K.CaretToken:
        return { op: 'bit-xor', left: num(left, lt), right: num(right, rt) };
      case K.LessThanLessThanToken:
        return { op: 'shl', left: num(left, lt), right: num(right, rt) };
      case K.GreaterThanGreaterThanToken:
        return { op: 'shr', left: num(left, lt), right: num(right, rt) };
      case K.GreaterThanGreaterThanGreaterThanToken:
        return { op: 'ushr', left: num(left, lt), right: num(right, rt) };
      case K.LessThanToken:
      case K.LessThanEqualsToken:
      case K.GreaterThanToken:
      case K.GreaterThanEqualsToken: {
        const name = {
          [K.LessThanToken]: 'lt',
          [K.LessThanEqualsToken]: 'le',
          [K.GreaterThanToken]: 'gt',
          [K.GreaterThanEqualsToken]: 'ge',
        }[op] as 'lt';
        if (lt === 'string' && rt === 'string')
          return { op: 'builtin', name: `string.${name}`, args: [left, right], type: BOOLEAN };
        return { op: name, left: num(left, lt), right: num(right, rt) };
      }
      case K.EqualsEqualsEqualsToken:
      case K.ExclamationEqualsEqualsToken:
      case K.EqualsEqualsToken:
      case K.ExclamationEqualsToken: {
        const strict = op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken;
        const negate = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
        const r = this.equality(left, lt, right, rt, strict, at);
        return negate ? { op: 'not', arg: r } : r;
      }
      default:
        return this.fail(at, 'E_OPERATOR', `Unsupported operator ${K[op]}`);
    }
  }

  private equality(
    left: Expr,
    lt: Type,
    right: Expr,
    rt: Type,
    strict: boolean,
    at: ts.Node,
  ): Expr {
    const isNullLit = (e: Expr) => e.op === 'null' || e.op === 'undefined';
    // Comparisons against null/undefined literals.
    if (isNullLit(right) || isNullLit(left)) {
      const [value, lit] = isNullLit(right) ? [left, right] : [right, left];
      const name = !strict
        ? 'maybe.is-nullish'
        : lit.op === 'null'
          ? 'maybe.is-null'
          : 'maybe.is-undefined';
      return { op: 'builtin', name, args: [value], type: BOOLEAN };
    }
    if (sameType(lt, rt)) return { op: 'eq', left, right };
    const base = (t: Type) => (typeof t === 'object' && 'maybe' in t ? t.maybe : t);
    if (sameType(base(lt), base(rt))) {
      // Maybe<T> vs T: compare as Maybe.
      const wrap = (v: Expr, t: Type): Expr =>
        typeof t === 'object' && 'maybe' in t ? v : { op: 'some', value: v };
      return { op: 'eq', left: wrap(left, lt), right: wrap(right, rt) };
    }
    if (
      !strict &&
      ['number', 'string', 'boolean'].includes(lt as string) &&
      ['number', 'string', 'boolean'].includes(rt as string)
    )
      return {
        op: 'eq',
        left: { op: 'to-number', arg: left },
        right: { op: 'to-number', arg: right },
      };
    return this.fail(at, 'E_OPERATOR', 'Equality between these types is outside the value model');
  }

  // Property access, calls and built-ins ---------------------------------------

  private receiverKind(t: Type): string | undefined {
    if (t === 'string') return 'string';
    if (t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'element') return 'element';
    if (t === 'event') return 'event';
    if (t === 'regexp') return 'regexp';
    if (t === 'media-query') return 'media-query';
    if (typeof t === 'object') {
      if ('array' in t) return 'array';
      if ('map' in t) return 'map';
      if ('set' in t) return 'set';
      if ('maybe' in t) return 'maybe';
      if ('record' in t) return 'record';
      if ('promise' in t) return 'promise';
    }
    return undefined;
  }

  /**
   * A promise rejection handler: its parameter (`any` in TypeScript's
   * declarations) is the Error record.
   */
  private rejectionHandler(arg: ts.Expression, b: FnBuilder): Expr {
    const f = skipParens(arg);
    if (!(ts.isArrowFunction(f) || ts.isFunctionExpression(f))) return this.expr(arg, b);
    const { index, builder } = this.function(f, `${b.name}.rejected`, b, b.component, undefined, [
      { record: this.errorRecord() },
    ]);
    return { op: 'closure', function: index, captures: builder.captureSources.map(c => c.local) };
  }

  /** `then`, `catch` and `finally` of a promise. */
  private promiseMethod(method: string, receiver: Expr, e: ts.CallExpression, b: FnBuilder): Expr {
    const a = e.arguments;
    let args: Expr[];
    if (method === 'then' && (a.length === 1 || a.length === 2))
      args = [this.expr(a[0], b), ...(a[1] ? [this.rejectionHandler(a[1], b)] : [])];
    else if (method === 'catch' && a.length === 1) args = [this.rejectionHandler(a[0], b)];
    else if (method === 'finally' && a.length === 1) args = [this.expr(a[0], b)];
    else
      return this.fail(
        e,
        'E_MEMBER',
        `Promise .${method} with ${a.length} arguments is unsupported`,
      );
    return {
      op: 'builtin',
      name: `promise.${method}`,
      args: [receiver, ...args],
      type: this.tsCallType(e) ?? this.fail(e, 'E_TYPE_UNSUPPORTED', 'Promise result type unknown'),
    };
  }

  /** The name of a standard-library global that `e` resolves to (a local binding cannot impersonate it). */
  /** A string literal; IR literals are Unicode text, so lone surrogates are rejected. */
  private stringLiteral(n: ts.Node, text: string): Expr {
    if (/\p{Cs}/u.test(text))
      this.fail(n, 'E_STRING', 'String literals with unpaired surrogates are unsupported');
    return { op: 'lit', value: text };
  }

  /** The event object of `handler`, read in `b` (the handler or a closure inside it). */
  private eventValue(handler: FnBuilder, b: FnBuilder): Expr {
    handler.eventLocal ??= handler.local('event', 'event');
    return { op: 'local', local: b.resolve(handler, handler.eventLocal) };
  }

  private globalName(e: ts.Expression): string | undefined {
    if (!ts.isIdentifier(e)) return undefined;
    const s = this.symbol(e);
    const decl = s?.valueDeclaration ?? s?.declarations?.[0];
    const file = decl?.getSourceFile();
    return file && this.program.isSourceFileDefaultLibrary(file) ? e.text : undefined;
  }

  /** The name of a host global declared in frontend/dom.d.ts (timers, clocks). */
  private hostName(e: ts.Expression): string | undefined {
    if (!ts.isIdentifier(e)) return undefined;
    const s = this.symbol(e);
    const decl = s?.valueDeclaration ?? s?.declarations?.[0];
    return decl && path.resolve(decl.getSourceFile().fileName) === DOM ? e.text : undefined;
  }

  /** Timer, microtask and clock host calls. */
  private hostCall(name: string, e: ts.CallExpression, b: FnBuilder): Expr | undefined {
    const args = e.arguments.map(a => this.expr(a, b));
    const number = (i: number): Expr => args[i] ?? { op: 'lit', value: 0 };
    const builtin = (n: string, a: Expr[], type: Type): Expr => ({
      op: 'builtin',
      name: n,
      args: a,
      type,
    });
    switch (name) {
      case 'matchMedia':
        return builtin('media.query', [args[0]], 'media-query');
      case 'setTimeout':
      case 'setInterval':
        if (e.arguments.length > 2)
          this.fail(e, 'E_CALL', `Extra ${name} arguments are planned for later; use a closure`);
        return builtin(
          name === 'setTimeout' ? 'timer.timeout' : 'timer.interval',
          [args[0], number(1)],
          NUMBER,
        );
      case 'requestAnimationFrame':
        return builtin('timer.frame', [args[0]], NUMBER);
      case 'queueMicrotask':
        return builtin('microtask.queue', [args[0]], 'void');
      case 'clearTimeout':
      case 'clearInterval':
      case 'cancelAnimationFrame': {
        // clearTimeout(undefined) does nothing.
        const id = args[0];
        const t = this.irType(id, b);
        if (typeof t === 'object' && 'maybe' in t) {
          const local = b.local('$timer', t);
          const read: Expr = { op: 'local', local };
          return {
            op: 'with',
            local,
            value: id,
            body: {
              op: 'cond',
              test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: BOOLEAN },
              then: { op: 'undefined', type: 'void' },
              else: builtin('timer.clear', [{ op: 'unwrap', value: read }], 'void'),
            },
          };
        }
        return builtin('timer.clear', [id], 'void');
      }
    }
    return undefined;
  }

  private property(e: ts.PropertyAccessExpression, b: FnBuilder): Expr {
    const name = e.name.text;
    if (ts.isIdentifier(e.expression)) {
      const special = this.binding(e.expression);
      if (special?.kind === 'props')
        return special.values.get(name) ?? this.fail(e, 'E_PROPS', `Prop ${name} is not passed`);
      if (special?.kind === 'ref' && name === refField(special)) {
        const read = this.hooks.readCell(special.cell, b, e);
        const here = this.types.typeOrUndefined(e);
        const declared = this.hooks.cellType(special.cell);
        return typeof declared === 'object' &&
          'maybe' in declared &&
          here !== undefined &&
          !(typeof here === 'object' && 'maybe' in here)
          ? { op: 'unwrap', value: read }
          : read;
      }
      if (special?.kind === 'computed' && name === 'value')
        return { op: 'call', function: special.fn, args: [] };
    }
    // The document element and matchMedia(query).matches.
    const root = this.rootMember(e);
    if (root?.kind === 'style')
      return {
        op: 'builtin',
        name: 'root.style-get',
        args: [{ op: 'lit', value: root.name }],
        type: 'string',
      };
    if (root) {
      const read: Expr = {
        op: 'builtin',
        name: 'root.get-attr',
        args: [{ op: 'lit', value: root.name }],
        type: { maybe: 'string' },
      };
      // lang/dir read as "" when absent; dataset entries as undefined.
      if (!root.name.startsWith('data-'))
        return { op: 'nullish', left: read, right: { op: 'lit', value: '' } };
      const tmp = b.local('$attr', { maybe: 'string' });
      const t: Expr = { op: 'local', local: tmp };
      return {
        op: 'with',
        local: tmp,
        value: read,
        body: {
          op: 'cond',
          test: { op: 'builtin', name: 'maybe.is-null', args: [t], type: 'boolean' },
          then: { op: 'undefined', type: { maybe: 'string' } },
          else: t,
        },
      };
    }
    if (
      name === 'matches' &&
      ts.isCallExpression(skipParens(e.expression)) &&
      this.hostName((skipParens(e.expression) as ts.CallExpression).expression) === 'matchMedia'
    ) {
      const call = skipParens(e.expression) as ts.CallExpression;
      return {
        op: 'builtin',
        name: 'media.matches',
        args: [this.expr(call.arguments[0], b)],
        type: 'boolean',
      };
    }
    if (this.hostName(e.expression) === 'window') {
      if (!WINDOW_METRICS.includes(name))
        return this.fail(e, 'E_MEMBER', `window.${name} is unsupported`);
      return { op: 'builtin', name: `window.${name}`, args: [], type: NUMBER };
    }
    const global = this.globalName(e.expression);
    if (global === 'Math' || global === 'Number')
      return { op: 'builtin', name: `${global}.${name}`, args: [], type: NUMBER };
    // The target control's value and checked state (at dispatch) through an
    // event: e.target.value, (e.target as HTMLInputElement).checked, and
    // e.currentTarget.value where the listener is on the target.
    let control: ts.Expression = e.expression;
    while (
      ts.isParenthesizedExpression(control) ||
      ts.isAsExpression(control) ||
      ts.isNonNullExpression(control)
    )
      control = control.expression;
    if (
      (name === 'value' || name === 'checked') &&
      ts.isPropertyAccessExpression(control) &&
      ['target', 'currentTarget'].includes(control.name.text) &&
      ts.isIdentifier(control.expression)
    ) {
      const ev = this.expr(control.expression, b);
      if (this.irType(ev, b) === 'event') {
        if (control.name.text === 'currentTarget') {
          const binding = this.binding(control.expression);
          const onTarget =
            binding?.kind === 'event' && ['input', 'change'].includes(binding.handler.event ?? '');
          if (!onTarget)
            this.fail(
              e,
              'E_EVENT',
              `e.currentTarget.${name} is supported in input and change handlers; use e.target.${name}`,
            );
        }
        return { op: 'builtin', name: `event.${name}`, args: [ev], type: EVENT_MEMBERS[name] };
      }
    }
    const object = this.expr(e.expression, b);
    const t = this.irType(object, b);
    const kind = this.receiverKind(t);
    if (kind === 'media-query') {
      if (name !== 'matches')
        return this.fail(
          e,
          'E_MEMBER',
          `MediaQueryList ${name} is unsupported (matches is supported)`,
        );
      return { op: 'builtin', name: 'media-query.matches', args: [object], type: 'boolean' };
    }
    if (kind === 'element') {
      if (!ELEMENT_METRICS.includes(name))
        return this.fail(
          e,
          'E_MEMBER',
          `Element ${name} is unsupported (${ELEMENT_METRICS.join(', ')} are supported)`,
        );
      return { op: 'builtin', name: `element.${name}`, args: [object], type: NUMBER };
    }
    if (kind === 'event') {
      const type = EVENT_MEMBERS[name];
      if (type === undefined || type === 'void' || name === 'value' || name === 'checked')
        return this.fail(
          e,
          'E_EVENT',
          'Event objects support type, key, code, ctrlKey/shiftKey/altKey/metaKey, repeat, clientX/clientY, button/buttons, deltaX/deltaY, target, currentTarget, defaultPrevented, target.value/checked, preventDefault(), stopPropagation() and stopImmediatePropagation()',
        );
      return { op: 'builtin', name: `event.${name}`, args: [object], type };
    }
    if (kind === 'record')
      return {
        op: 'get',
        object,
        field: this.types.fieldIndex((t as { record: number }).record, name, e),
      };
    if (kind === 'regexp') {
      const type = REGEXP_PROPERTIES[name];
      if (type === undefined)
        return this.fail(
          e,
          'E_REGEXP',
          `RegExp property ${name} is unsupported (source, flags, global, ignoreCase, multiline, dotAll, unicode, unicodeSets, sticky, hasIndices and lastIndex are supported)`,
        );
      return { op: 'builtin', name: `regexp.${name}`, args: [object], type };
    }
    if (kind === 'array' && this.isMatchArray(e.expression)) {
      let inner: ts.Expression = e.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner))
        return this.fail(
          e,
          'E_REGEXP',
          'Match array properties of an asserted value are unsupported',
        );
      if (name === 'index' || name === 'input') {
        const read: Expr = {
          op: 'builtin',
          name: `match.${name}`,
          args: [object],
          type: { maybe: name === 'index' ? NUMBER : STRING },
        };
        // RegExpExecArray: always present.
        const here = this.types.typeOrUndefined(e);
        return here && !maybeInner(here) ? { op: 'unwrap', value: read } : read;
      }
      if (name === 'groups')
        return this.fail(
          e,
          'E_REGEXP',
          'Named groups are read as m.groups.name, m.groups?.name or m.groups!.name',
        );
    }
    if (kind === 'string' && name === 'length') return { op: 'utf16-length', arg: object };
    if (kind && ['array', 'map', 'set'].includes(kind) && ['length', 'size'].includes(name))
      return { op: 'builtin', name: `${kind}.${name}`, args: [object], type: NUMBER };
    return this.fail(e, 'E_MEMBER', `Unsupported property ${name} on ${kind ?? 'this value'}`);
  }

  // Optional chaining ---------------------------------------------------------
  //
  // The innermost pending `?.` link is lowered first: its base is evaluated,
  // bound to a temporary and substituted (`overrides`) while the rest of the
  // chain is lowered; outer `?.` links resolve recursively. Chain members are
  // typed with their own declared types (without the chain's short-circuit
  // `undefined`).

  private readonly overrides = new Map<ts.Node, { expr: Expr; type: Type }>();

  /** The IR type of a node, honouring chain substitutions and link types. */
  typeAt(n: ts.Expression): Type {
    const o = this.overrides.get(n);
    if (o) return o.type;
    return ts.isOptionalChain(n) ? this.nodeType(n) : this.types.of(n);
  }

  /** The type of a chain link as if its base were present. */
  nodeType(n: ts.Expression): Type {
    if (!ts.isOptionalChain(n)) return this.types.of(n);
    if (ts.isCallExpression(n)) {
      // The resolved signature of an optional call has `undefined` added;
      // use the callee member's declared signature instead.
      if (ts.isPropertyAccessExpression(n.expression)) {
        const sym = this.checker.getSymbolAtLocation(n.expression.name);
        const sigs =
          sym && this.checker.getTypeOfSymbolAtLocation(sym, n.expression).getCallSignatures();
        if (sigs?.length === 1) return this.types.map(sigs[0].getReturnType(), n);
      }
      const sig = this.checker.getResolvedSignature(n);
      if (sig) return this.types.map(sig.getReturnType(), n);
    }
    if (ts.isPropertyAccessExpression(n)) {
      const sym = this.checker.getSymbolAtLocation(n.name);
      if (sym) {
        let t = this.checker.getTypeOfSymbolAtLocation(sym, n);
        if (sym.flags & ts.SymbolFlags.Optional)
          t = this.checker.getNullableType(t, ts.TypeFlags.Undefined);
        return this.types.map(t, n);
      }
    }
    if (ts.isElementAccessExpression(n)) {
      const base = this.typeAt(n.expression);
      if (typeof base === 'object' && 'array' in base) return base.array;
    }
    if (ts.isNonNullExpression(n)) {
      const inner = this.typeAt(n.expression);
      return typeof inner === 'object' && 'maybe' in inner ? inner.maybe : inner;
    }
    return this.types.of(n);
  }

  /** The innermost `?.` link of the chain ending at `e` whose base is not yet substituted. */
  private pendingLink(e: ts.Expression): ts.Expression | undefined {
    let found: ts.Expression | undefined;
    let cur: ts.Expression = e;
    while (
      ts.isPropertyAccessExpression(cur) ||
      ts.isElementAccessExpression(cur) ||
      ts.isCallExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      if (this.overrides.has(cur)) break;
      if ('questionDotToken' in cur && cur.questionDotToken && !this.overrides.has(cur.expression))
        found = cur;
      if (!ts.isOptionalChain(cur)) break;
      cur = cur.expression;
    }
    return found;
  }

  private optionalChain(e: ts.Expression, link: ts.Expression, b: FnBuilder): Expr {
    const base = (link as ts.PropertyAccessExpression).expression;
    let bt = this.typeAt(base);
    const bv = this.expr(base, b);
    // The lowered value's own nullable type where it is more precise (match
    // arrays with captures that may be undefined).
    const lowered = this.irType(bv, b);
    if (maybeInner(bt) && maybeInner(lowered)) bt = lowered;
    if (!(typeof bt === 'object' && 'maybe' in bt)) {
      // `?.` on a value that cannot be nullish behaves like `.`.
      this.overrides.set(base, { expr: bv, type: bt });
      try {
        return this.expr(e, b);
      } finally {
        this.overrides.delete(base);
      }
    }
    const tmp = b.local('$optional', bt.maybe);
    this.overrides.set(base, { expr: { op: 'local', local: tmp }, type: bt.maybe });
    let then: Expr;
    let alreadyMaybe: boolean;
    try {
      // A further `?.` in the chain makes the rest a Maybe already.
      const nested = this.pendingLink(e) !== undefined;
      then = this.expr(e, b);
      const thenType = this.typeAt(e);
      alreadyMaybe =
        nested ||
        (typeof thenType === 'object' && 'maybe' in thenType) ||
        maybeInner(this.irType(then, b)) !== undefined;
    } finally {
      this.overrides.delete(base);
    }
    if (this.irType(then, b) === 'void') {
      // `x?.f()` for a void call: run it when x is not nullish (no Maybe<void>).
      const whole = b.local('$optional?', bt);
      const read: Expr = { op: 'local', local: whole };
      return {
        op: 'with',
        local: whole,
        value: bv,
        body: {
          op: 'cond',
          test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: 'boolean' },
          then: { op: 'undefined', type: 'void' },
          else: { op: 'with', local: tmp, value: { op: 'unwrap', value: read }, body: then },
        },
      };
    }
    if (!alreadyMaybe) then = { op: 'some', value: then };
    return { op: 'optional', value: bv, local: tmp, then };
  }

  private element(e: ts.ElementAccessExpression, b: FnBuilder): Expr {
    const object = this.expr(e.expression, b);
    const t = this.irType(object, b);
    const kind = this.receiverKind(t);
    if (kind === 'array') {
      const index = this.expr(e.argumentExpression, b);
      const el = (t as { array: Type }).array;
      const here = this.types.typeOrUndefined(e);
      if (maybeInner(el) && here !== undefined && !maybeInner(here))
        return this.captureRead(e, object, index, b);
      return { op: 'index', array: object, index };
    }
    if (kind === 'string')
      return {
        op: 'builtin',
        name: 'string.index',
        args: [object, this.expr(e.argumentExpression, b)],
        type: { maybe: STRING },
      };
    if (kind === 'record' && ts.isStringLiteral(e.argumentExpression))
      return {
        op: 'get',
        object,
        field: this.types.fieldIndex(
          (t as { record: number }).record,
          e.argumentExpression.text,
          e,
        ),
      };
    return this.fail(e, 'E_MEMBER', 'Unsupported element access');
  }

  /** TypeScript's type of a call result, or undefined where it is `any`. */
  private tsCallType(e: ts.CallExpression): Type | undefined {
    try {
      return this.nodeType(e);
    } catch (err) {
      if ((err as { code?: string }).code === 'E_TYPE_UNSUPPORTED') return undefined;
      throw err;
    }
  }

  private builtinCall(
    name: string,
    args: Expr[],
    b: FnBuilder,
    ts0: Type | undefined,
    at: ts.Node,
  ): Expr {
    const type =
      ts0 ??
      builtinType(
        name,
        args.map(a => this.irType(a, b)),
      );
    if (type === undefined)
      return this.fail(
        at,
        'E_TYPE_UNSUPPORTED',
        `Cannot determine the result type of ${name}; add a type annotation`,
      );
    return { op: 'builtin', name, args, type };
  }

  private call(e: ts.CallExpression, b: FnBuilder): Expr {
    const custom = this.hooks.call?.(e, b, this);
    if (custom) return custom;
    const callee = e.expression;
    const args = () => e.arguments.map(a => this.expr(a, b));
    if (ts.isIdentifier(callee)) {
      const host = this.hostName(callee);
      const hosted = host && this.hostCall(host, e, b);
      if (hosted) return hosted;
      const global = this.globalName(callee);
      if (global === 'RegExp') return this.regexpNew(e, e.arguments, b);
      // A copy of a match array keeps index, input and groups in JavaScript.
      if (global === 'structuredClone' && e.arguments[0] && this.isMatchArray(e.arguments[0]))
        return this.fail(e, 'E_REGEXP', 'structuredClone of a match array is unsupported');
      if (global && GLOBAL_FUNCTIONS.has(global))
        return this.builtinCall(global, args(), b, this.tsCallType(e), e);
      const binding = this.binding(callee);
      if (binding?.kind === 'function')
        return { op: 'call', function: binding.fn, args: this.callArgs(e, b) };
      if (binding?.kind === 'generic') return this.specialise(binding, e, b);
      if (binding)
        return { op: 'call-value', callee: this.expr(callee, b), args: this.callArgs(e, b) };
      return this.fail(callee, 'E_UNRESOLVED', `${callee.text} is not a supported function`);
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const global = this.globalName(callee.expression);
      if (global === 'JSON' && method === 'parse') {
        const ctx = this.checker.getContextualType(e);
        if (!ctx)
          this.fail(
            e,
            'E_TYPE_UNSUPPORTED',
            'JSON.parse needs a declared result type (e.g. const v: Item = JSON.parse(text))',
          );
        return { op: 'builtin', name: 'JSON.parse', args: args(), type: this.types.map(ctx!, e) };
      }
      if (global === 'RegExp') return this.fail(e, 'E_REGEXP', `RegExp.${method} is unsupported`);
      if (global === 'Array' && method === 'from' && e.arguments.length === 1) {
        // Array.from(s.matchAll(re)): the matches are a new array already.
        const source = skipParens(e.arguments[0]);
        if (this.isMatchAll(source)) return this.expr(source, b);
      }
      if (global === 'Date' && method === 'now' && !e.arguments.length)
        return { op: 'builtin', name: 'clock.date', args: [], type: NUMBER };
      if (this.hostName(callee.expression) === 'performance' && method === 'now')
        return { op: 'builtin', name: 'clock.now', args: [], type: NUMBER };
      // Document element methods.
      const owner = skipParens(callee.expression);
      const rootPart =
        ts.isPropertyAccessExpression(owner) && this.isRoot(owner.expression)
          ? owner.name.text
          : undefined;
      if (rootPart === 'classList' || rootPart === 'style' || this.isRoot(callee.expression)) {
        const a = e.arguments.map(x => this.expr(x, b));
        const op = (n: string, args: Expr[], type: Type): Expr => ({
          op: 'builtin',
          name: `root.${n}`,
          args,
          type,
        });
        const one = () => {
          if (a.length !== 1) this.fail(e, 'E_CALL', `${method} takes one token here`);
          return a;
        };
        if (rootPart === 'classList') {
          if (method === 'toggle') return op('class-toggle', a, 'boolean');
          if (method === 'add' || method === 'remove') return op(`class-${method}`, one(), 'void');
          if (method === 'contains') return op('class-contains', one(), 'boolean');
        } else if (rootPart === 'style') {
          if (method === 'setProperty') {
            const priority = e.arguments[2];
            if (priority && !(ts.isStringLiteralLike(priority) && priority.text === ''))
              this.fail(
                priority,
                'E_CALL',
                'Important style properties are planned for a later milestone',
              );
            if (a[1]?.op === 'null') return op('style-remove', [a[0]], 'string');
            if (this.irType(a[1], b) !== 'string')
              this.fail(e.arguments[1], 'E_CALL', 'setProperty takes a string value');
            return op('style-set', a.slice(0, 2), 'void');
          }
          if (method === 'removeProperty') return op('style-remove', a, 'string');
          if (method === 'getPropertyValue') return op('style-get', a, 'string');
        } else {
          if (method === 'setAttribute') return op('set-attr', a, 'void');
          if (method === 'removeAttribute') return op('remove-attr', a, 'void');
          if (method === 'getAttribute') return op('get-attr', a, { maybe: 'string' });
        }
        return this.fail(
          e,
          'E_CALL',
          `document.documentElement ${rootPart ? rootPart + '.' : ''}${method} is unsupported`,
        );
      }
      const host = this.hostName(callee.expression);
      if (host === 'window' && method === 'matchMedia')
        return {
          op: 'builtin',
          name: 'media.query',
          args: [this.expr(e.arguments[0], b)],
          type: 'media-query',
        };
      if (host === 'window' && (method === 'scrollTo' || method === 'scrollBy'))
        return {
          op: 'builtin',
          name: `window.${method}`,
          args: this.scrollCoordinates(e, b),
          type: 'void',
        };
      if (
        (host === 'window' || host === 'document') &&
        (method === 'addEventListener' || method === 'removeEventListener')
      ) {
        const [type, listener, options] = e.arguments;
        if (options)
          this.fail(
            options,
            'E_EVENT',
            'Listener options (capture, passive, once) are planned for a later milestone',
          );
        if (!type || !ts.isStringLiteralLike(type) || !EVENT_KINDS.includes(type.text as EventKind))
          this.fail(type ?? e, 'E_EVENT', `${host}.${method} takes a supported event name literal`);
        return {
          op: 'builtin',
          name: `${host}.${method === 'addEventListener' ? 'listen' : 'unlisten'}`,
          args: [{ op: 'lit', value: (type as ts.StringLiteral).text }, this.expr(listener, b)],
          type: 'void',
        };
      }
      if (host === 'localStorage') {
        const name = { getItem: 'get', setItem: 'set', removeItem: 'remove', clear: 'clear' }[
          method
        ];
        if (!name) return this.fail(e, 'E_MEMBER', `localStorage.${method} is unsupported`);
        return {
          op: 'builtin',
          name: `storage.${name}`,
          args: args(),
          type: name === 'get' ? { maybe: STRING } : 'void',
        };
      }
      if (global && STATIC_NAMESPACES.has(global))
        return this.builtinCall(`${global}.${method}`, args(), b, this.tsCallType(e), e);
      if (global === 'Promise') {
        if (!['resolve', 'reject', 'all'].includes(method))
          return this.fail(e, 'E_BUILTIN', `Promise.${method} is planned for later`);
        return this.builtinCall(`promise.${method}`, args(), b, this.tsCallType(e), e);
      }
      if (ts.isIdentifier(callee.expression)) {
        const special = this.binding(callee.expression);
        if (special?.kind === 'props')
          return { op: 'call-value', callee: this.property(callee, b), args: this.callArgs(e, b) };
      }
      const receiver = this.expr(callee.expression, b);
      const kind = this.receiverKind(this.irType(receiver, b));
      if (kind === 'promise') return this.promiseMethod(method, receiver, e, b);
      if (kind === 'regexp') return this.regexpMethod(method, receiver, callee.expression, e, b);
      if (
        kind === 'string' &&
        REGEXP_STRING_METHODS.has(method) &&
        e.arguments[0] &&
        this.types.typeOrUndefined(e.arguments[0]) === 'regexp'
      )
        return this.stringRegexp(method, receiver, e, b);
      if (kind === 'record')
        return { op: 'call-value', callee: this.property(callee, b), args: this.callArgs(e, b) };
      if (kind === 'element') return this.elementMethod(method, receiver, e, b);
      if (kind === 'media-query') {
        const [type, listener, options] = e.arguments;
        if (method !== 'addEventListener' && method !== 'removeEventListener')
          return this.fail(e, 'E_CALL', `MediaQueryList ${method}() is unsupported`);
        if (options)
          this.fail(options, 'E_EVENT', 'Listener options are planned for a later milestone');
        if (!type || !ts.isStringLiteralLike(type) || type.text !== 'change')
          this.fail(type ?? e, 'E_EVENT', 'Media query lists have change listeners');
        return {
          op: 'builtin',
          name: `media-query.${method === 'addEventListener' ? 'listen' : 'unlisten'}`,
          args: [receiver, this.expr(listener, b)],
          type: 'void',
        };
      }
      if (kind)
        return this.builtinCall(
          `${kind}.${method}`,
          [receiver, ...args()],
          b,
          this.tsCallType(e),
          e,
        );
    }
    return this.fail(e, 'E_CALL', 'Unsupported call');
  }

  /** Element methods: focus and blur, layout reads and scrolling. */
  private elementMethod(method: string, receiver: Expr, e: ts.CallExpression, b: FnBuilder): Expr {
    const call = (name: string, args: Expr[], type: Type): Expr => ({
      op: 'builtin',
      name: `element.${name}`,
      args: [receiver, ...args],
      type,
    });
    switch (method) {
      case 'focus':
      case 'blur':
        if (e.arguments.length)
          this.fail(e.arguments[0], 'E_CALL', `${method}() options are unsupported`);
        return call(method, [], 'void');
      case 'getBoundingClientRect': {
        const type = this.tsCallType(e);
        if (!type)
          return this.fail(e, 'E_TYPE_UNSUPPORTED', 'getBoundingClientRect needs the DOMRect type');
        return call(method, [], type);
      }
      case 'scrollTo':
      case 'scrollBy':
        return call(method, this.scrollCoordinates(e, b), 'void');
      case 'scrollIntoView': {
        // Defaults: block start, inline nearest; false aligns the block end.
        let block = 'start';
        let inline = 'nearest';
        const [arg] = e.arguments;
        if (arg?.kind === ts.SyntaxKind.FalseKeyword) block = 'end';
        else if (arg && arg.kind !== ts.SyntaxKind.TrueKeyword) {
          const options = this.literalOptions(arg, ['block', 'inline', 'behavior']);
          block = options.get('block') ?? block;
          inline = options.get('inline') ?? inline;
          this.instantScroll(arg, options);
        }
        return call(method, [lit(block), lit(inline)], 'void');
      }
    }
    return this.fail(e, 'E_CALL', `Element ${method}() is unsupported`);
  }

  /** The (left, top) coordinates of scrollTo/scrollBy: two numbers or options. */
  private scrollCoordinates(e: ts.CallExpression, b: FnBuilder): Expr[] {
    const absent: Expr = { op: 'undefined', type: { maybe: NUMBER } };
    const some = (x: ts.Expression): Expr => {
      const v = this.expr(x, b);
      if (this.irType(v, b) !== NUMBER) this.fail(x, 'E_CALL', 'Scroll coordinates are numbers');
      return { op: 'some', value: v };
    };
    const [first, second] = e.arguments;
    if (second) return [some(first), some(second)];
    if (!first) return [absent, absent];
    const o = skipParens(first);
    if (!ts.isObjectLiteralExpression(o))
      return this.fail(first, 'E_CALL', 'Scroll options are an object literal');
    const values = new Map<string, Expr>();
    const strings = new Map<string, string>();
    for (const p of o.properties) {
      const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
      if (!ts.isPropertyAssignment(p) || !key || !['left', 'top', 'behavior'].includes(key))
        return this.fail(p, 'E_CALL', 'Scroll options are left, top and behavior');
      if (key === 'behavior') {
        if (!ts.isStringLiteralLike(p.initializer))
          return this.fail(p.initializer, 'E_CALL', 'Scroll behavior is a literal');
        strings.set(key, p.initializer.text);
      } else values.set(key, some(p.initializer));
    }
    this.instantScroll(first, strings);
    return [values.get('left') ?? absent, values.get('top') ?? absent];
  }

  /** Literal string options of an object literal (others rejected). */
  private literalOptions(arg: ts.Expression, keys: string[]): Map<string, string> {
    const o = skipParens(arg);
    if (!ts.isObjectLiteralExpression(o)) {
      this.fail(arg, 'E_CALL', 'Options are an object literal or a boolean literal');
    }
    const out = new Map<string, string>();
    for (const p of (o as ts.ObjectLiteralExpression).properties) {
      const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
      if (
        !ts.isPropertyAssignment(p) ||
        !key ||
        !keys.includes(key) ||
        !ts.isStringLiteralLike(p.initializer)
      )
        this.fail(p, 'E_CALL', `Options are literal ${keys.join(', ')}`);
      out.set(key!, ((p as ts.PropertyAssignment).initializer as ts.StringLiteral).text);
    }
    return out;
  }

  /** Smooth scrolling animates over frames: only instant scrolls are supported. */
  private instantScroll(at: ts.Node, options: Map<string, string>) {
    const behavior = options.get('behavior');
    if (behavior !== undefined && behavior !== 'auto' && behavior !== 'instant')
      this.fail(at, 'E_CALL', 'Smooth scrolling is unsupported (behavior auto or instant)');
  }

  /** Call a function with untyped parameters, specialised to the argument types. */
  private specialise(
    g: Extract<Binding, { kind: 'generic' }>,
    e: ts.CallExpression,
    b: FnBuilder,
  ): Expr {
    const args = e.arguments.map(a => this.expr(a, b));
    const types = args.map(a => this.irType(a, b));
    if (types.length < g.decl.parameters.length)
      this.fail(
        e,
        'E_TYPE_UNSUPPORTED',
        `Untyped ${g.name} needs all ${g.decl.parameters.length} arguments (or type annotations)`,
      );
    const key = JSON.stringify(types);
    let index = g.specs.get(key);
    if (index === undefined) {
      index = this.reserve();
      g.specs.set(key, index);
      this.inProgress.add(index);
      this.function(
        g.decl,
        `${g.name}<${types.map(t => JSON.stringify(t)).join(',')}>`,
        undefined,
        g.component,
        index,
        types,
      );
      this.inProgress.delete(index);
    } else if (this.inProgress.has(index))
      this.fail(e, 'E_TYPE_UNSUPPORTED', `Recursive untyped ${g.name}: add type annotations`);
    return { op: 'call', function: index, args: args.slice(0, g.decl.parameters.length) };
  }
  private readonly inProgress = new Set<number>();

  /** Register a function declaration: typed functions now, untyped ones per call site. */
  declare(
    sym: ts.Symbol,
    decl: ts.FunctionLikeDeclaration,
    name: string,
    component: number | undefined,
  ): (() => void) | undefined {
    const untyped = decl.parameters.some(
      p => !p.type && this.types.typeOrUndefined(p) === undefined,
    );
    if (untyped) {
      this.bindings.set(sym, { kind: 'generic', decl, name, component, specs: new Map() });
      return undefined;
    }
    const index = this.reserve();
    const stable = component === undefined || this.stableFunctions;
    this.bindings.set(sym, { kind: 'function', fn: index, ...(stable ? { stable } : {}) });
    // Placeholder with the signature's types until the body is lowered.
    const sig = this.checker.getSignatureFromDeclaration(decl);
    const ret = sig?.getReturnType();
    if (ret && !(ret.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
      this.functions[index] = {
        name,
        ...(component !== undefined ? { component } : {}),
        params: [],
        locals: [],
        result: this.types.map(ret, decl),
        body: [],
      };
    return () => this.function(decl, name, undefined, component, index);
  }

  /** Arguments with optional parameters widened to Maybe and missing ones as undefined. */
  private callArgs(e: ts.CallExpression, b: FnBuilder): Expr[] {
    const sig = this.checker.getResolvedSignature(e);
    // An untyped callee (e.g. a JavaScript callback prop) has no parameter list.
    const untyped = this.checker.getTypeAtLocation(e.expression).flags & ts.TypeFlags.Any;
    if (!sig || untyped) return e.arguments.map(a => this.expr(a, b));
    // A callee with an overridden function type (a promise's resolve) takes its parameters.
    const given = this.types.overridden(e.expression);
    if (typeof given === 'object' && 'fn' in given)
      return given.fn.params.map((pt, i) => {
        const arg = e.arguments[i];
        return arg ? this.coerce(arg, b, pt) : ({ op: 'undefined', type: pt } as Expr);
      });
    return sig.parameters.map((p, i) => {
      const pt = this.types.map(this.checker.getTypeOfSymbolAtLocation(p, e), e);
      const arg = e.arguments[i];
      if (!arg) return { op: 'undefined', type: pt } as Expr;
      return this.coerce(arg, b, pt);
    });
  }

  private newExpression(e: ts.NewExpression, b: FnBuilder): Expr {
    const global = this.globalName(e.expression);
    if (global === 'Promise') {
      // new Promise<T>(executor): resolve takes a T, reject an Error.
      const type = this.exprType(e);
      const exec = e.arguments?.[0] && skipParens(e.arguments[0]);
      if (
        !exec ||
        !(ts.isArrowFunction(exec) || ts.isFunctionExpression(exec)) ||
        !(typeof type === 'object' && 'promise' in type)
      )
        return this.fail(
          e,
          'E_NEW',
          'new Promise takes an executor function and a known value type',
        );
      const value = type.promise;
      const { index, builder } = this.function(
        exec,
        `${b.name}.executor`,
        b,
        b.component,
        undefined,
        [
          { fn: { params: [value], result: 'void' } },
          { fn: { params: [{ record: this.errorRecord() }], result: 'void' } },
        ],
      );
      return {
        op: 'builtin',
        name: 'promise.new',
        args: [
          { op: 'closure', function: index, captures: builder.captureSources.map(c => c.local) },
        ],
        type,
      };
    }
    if (global === 'RegExp') return this.regexpNew(e, e.arguments ?? [], b);
    const args = (e.arguments ?? []).map(a => this.expr(a, b));
    if (global === 'Map' || global === 'Set')
      return { op: 'builtin', name: `${global}.new`, args, type: this.exprType(e) };
    if (global && ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(global))
      return {
        op: 'record',
        record: this.errorRecord(),
        fields: [{ op: 'lit', value: global }, args[0] ?? { op: 'lit', value: '' }],
      };
    return this.fail(e, 'E_NEW', 'Unsupported constructor');
  }

  private object(e: ts.ObjectLiteralExpression, b: FnBuilder): Expr {
    const t = this.checker.getContextualType(e) ?? this.checker.getTypeAtLocation(e);
    const type = this.types.map(t, e);
    const recordType = typeof type === 'object' && 'maybe' in type ? type.maybe : type;
    if (!(typeof recordType === 'object' && 'record' in recordType))
      return this.fail(e, 'E_OBJECT', 'Object literal without a record type');
    const declared = this.types.records[recordType.record];
    // Keys are observable (Object.keys, JSON.stringify): the record has the
    // literal's key order.
    const order = this.types.keyOrder(e, declared.fields);
    if (order.some((n, i) => declared.fields[i].name !== n)) {
      if (declared.name !== 'Object')
        return this.fail(
          e,
          'E_OBJECT',
          `Properties are in a different order than in ${declared.name} (${declared.fields
            .map(f => f.name)
            .join(', ')}); key order is observable, so write them in declaration order`,
        );
      recordType.record = this.types.reordered(recordType.record, order);
    }
    const record = this.types.records[recordType.record];
    const values: (Expr | undefined)[] = record.fields.map(() => undefined);
    const spreads: { local: number; value: Expr }[] = [];
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) {
        const st = this.types.of(p.expression);
        if (!(typeof st === 'object' && 'record' in st))
          this.fail(p, 'E_OBJECT', 'Spread requires a record value');
        const source = b.local('$spread', st);
        const src = this.types.records[(st as { record: number }).record];
        // Each field that exists in the source overrides earlier values.
        record.fields.forEach((f, i) => {
          const j = src.fields.findIndex(sf => sf.name === f.name);
          if (j >= 0) values[i] = { op: 'get', object: { op: 'local', local: source }, field: j };
        });
        spreads.push({ local: source, value: this.expr(p.expression, b) });
        continue;
      }
      let name: string;
      let value: Expr;
      if (ts.isPropertyAssignment(p)) {
        name =
          ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
            ? p.name.text
            : this.fail(p, 'E_OBJECT', 'Computed keys are unsupported');
        const i = this.types.fieldIndex(recordType.record, name, p);
        if (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))
          value = this.closure(p.initializer, b, name);
        else value = this.coerce(p.initializer, b, record.fields[i].type);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        name = p.name.text;
        const i = this.types.fieldIndex(recordType.record, name, p);
        const sym = this.checker.getShorthandAssignmentValueSymbol(p);
        const binding = sym && this.bindings.get(sym);
        value = binding
          ? this.bindingExpr(binding, p.name, b, this.types.of(p.name))
          : this.fail(p, 'E_UNRESOLVED', `${name} is not a supported binding`);
        const vt = this.types.of(p.name);
        if (
          typeof record.fields[i].type === 'object' &&
          'maybe' in (record.fields[i].type as object) &&
          !(typeof vt === 'object' && 'maybe' in vt)
        )
          value = { op: 'some', value };
      } else if (ts.isMethodDeclaration(p)) {
        name = (p.name as ts.Identifier).text;
        value = this.closure(p, b, name);
      } else return this.fail(p, 'E_OBJECT', 'Unsupported object member');
      values[this.types.fieldIndex(recordType.record, name, p)] = value;
    }
    const fields = record.fields.map(
      (f, i) =>
        values[i] ??
        (typeof f.type === 'object' && 'maybe' in f.type
          ? ({ op: 'undefined', type: f.type } as Expr)
          : this.fail(e, 'E_OBJECT', `Missing field ${f.name}`)),
    );
    let out: Expr = { op: 'record', record: recordType.record, fields };
    // Bind spread sources (in source order) around the construction.
    for (const sp of spreads.reverse())
      out = { op: 'with', local: sp.local, value: sp.value, body: out };
    return out;
  }

  // Regular expressions (docs/IR.md) ---------------------------------------
  //
  // Match arrays (exec, match, matchAll) and split results are string
  // arrays. Captures that may not participate in a match are undefined there,
  // which TypeScript's types do not express: such results are typed
  // `(string | undefined)[]` unless the pattern is known (a literal, or a
  // const initialised with one) and every capture participates in every
  // match. Reads that TypeScript types as `string` are then unwrapped where
  // the pattern proves the capture present, kept nullable where undefined is
  // handled (`??`, conditions, templates), and rejected otherwise.

  /** `/source/flags` */
  private regexLiteral(e: ts.RegularExpressionLiteral): Expr {
    const { source, flags } = literalParts(e.text);
    this.checkRegex(e, source, flags);
    return {
      op: 'builtin',
      name: 'regexp.new',
      args: [
        { op: 'lit', value: source },
        { op: 'lit', value: flags },
      ],
      type: 'regexp',
    };
  }

  /** Literal flags (without v) and, when known, the pattern compile (V8's errors). */
  private checkRegex(at: ts.Node, source: string | undefined, flags: string) {
    if (flags.includes('v'))
      this.fail(at, 'E_REGEXP', 'The v flag (unicodeSets) is unsupported; use u');
    const error = syntaxError(source ?? '', flags);
    if (error) this.fail(at, 'E_REGEXP', error);
  }

  /** `new RegExp(pattern, flags)` and `RegExp(pattern, flags)`. */
  private regexpNew(
    e: ts.NewExpression | ts.CallExpression,
    args: readonly ts.Expression[],
    b: FnBuilder,
  ): Expr {
    const [pattern, flagsNode, ...rest] = args;
    if (!pattern || rest.length)
      return this.fail(e, 'E_REGEXP', 'new RegExp takes a pattern and optional literal flags');
    if (this.types.typeOrUndefined(pattern) === 'regexp')
      return this.fail(
        pattern,
        'E_REGEXP',
        'new RegExp(regexp) is unsupported; pass the pattern source string',
      );
    if (flagsNode && !ts.isStringLiteralLike(flagsNode))
      return this.fail(flagsNode, 'E_REGEXP', 'RegExp flags must be a string literal');
    const flags = flagsNode ? (flagsNode as ts.StringLiteralLike).text : '';
    this.checkRegex(e, ts.isStringLiteralLike(pattern) ? pattern.text : undefined, flags);
    const source = this.expr(pattern, b);
    if (this.irType(source, b) !== 'string')
      return this.fail(pattern, 'E_REGEXP', 'The pattern of new RegExp must be a string');
    return {
      op: 'builtin',
      name: 'regexp.new',
      args: [source, { op: 'lit', value: flags }],
      type: 'regexp',
    };
  }

  /** The pattern of a RegExp expression, when it is known at compile time. */
  regexInfo(e: ts.Expression, depth = 0): RegexInfo | undefined {
    e = skipParens(e);
    while (ts.isNonNullExpression(e)) e = skipParens(e.expression);
    if (ts.isRegularExpressionLiteral(e)) {
      const { source, flags } = literalParts(e.text);
      return syntaxError(source, flags) === undefined ? analyze(source, flags) : undefined;
    }
    if (
      (ts.isNewExpression(e) || ts.isCallExpression(e)) &&
      this.globalName(e.expression) === 'RegExp'
    ) {
      const [pattern, flagsNode] = e.arguments ?? [];
      if (!pattern || !ts.isStringLiteralLike(pattern)) return undefined;
      if (flagsNode && !ts.isStringLiteralLike(flagsNode)) return undefined;
      const flags = flagsNode ? (flagsNode as ts.StringLiteralLike).text : '';
      return syntaxError(pattern.text, flags) === undefined
        ? analyze(pattern.text, flags)
        : undefined;
    }
    if (ts.isIdentifier(e) && depth < 8) {
      const decl = this.symbol(e)?.valueDeclaration;
      if (
        decl &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        ts.isVariableDeclarationList(decl.parent) &&
        decl.parent.flags & ts.NodeFlags.Const
      )
        return this.regexInfo(decl.initializer, depth + 1);
    }
    return undefined;
  }

  /** Whether TypeScript types `e` as a match array (RegExpExecArray, RegExpMatchArray). */
  private isMatchArray(e: ts.Expression): boolean {
    const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
    return /^RegExp(Exec|Match)Array$/.test(t.symbol?.name ?? '');
  }

  /** `s.matchAll(…)` */
  private isMatchAll(e: ts.Expression): boolean {
    return (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === 'matchAll'
    );
  }

  /** A call whose result is a match array or split result of a RegExp. */
  private isRegexpResult(e: ts.Expression): boolean {
    e = skipParens(e);
    while (ts.isNonNullExpression(e)) e = skipParens(e.expression);
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
    const m = e.expression.name.text;
    if (m === 'exec') return this.types.typeOrUndefined(e.expression.expression) === 'regexp';
    return (
      (m === 'match' || m === 'split') &&
      !!e.arguments[0] &&
      this.types.typeOrUndefined(e.arguments[0]) === 'regexp'
    );
  }

  /** The pattern a match array comes from, when known (and whether it is a global match's list of matched strings). */
  private matchSource(
    e: ts.Expression,
    depth = 0,
  ): { info: RegexInfo; matches: boolean } | undefined {
    e = skipParens(e);
    while (ts.isNonNullExpression(e)) e = skipParens(e.expression);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if (m === 'exec') {
        const info = this.regexInfo(e.expression.expression);
        return info && { info, matches: false };
      }
      if (m === 'match' && e.arguments[0]) {
        const info = this.regexInfo(e.arguments[0]);
        return info && { info, matches: info.flags.includes('g') };
      }
      return undefined;
    }
    if (ts.isIdentifier(e) && depth < 8) {
      const decl = this.symbol(e)?.valueDeclaration;
      if (!decl || !ts.isVariableDeclaration(decl) || !ts.isVariableDeclarationList(decl.parent))
        return undefined;
      const list = decl.parent;
      // for (const m of s.matchAll(re))
      if (ts.isForOfStatement(list.parent)) {
        const it = skipParens(list.parent.expression);
        if (this.isMatchAll(it)) {
          const arg = (it as ts.CallExpression).arguments[0];
          const info = arg && this.regexInfo(arg);
          return info && { info, matches: false };
        }
        return undefined;
      }
      if (list.flags & ts.NodeFlags.Const && decl.initializer)
        return this.matchSource(decl.initializer, depth + 1);
    }
    return undefined;
  }

  /** Match array elements: strings where the pattern proves every capture present. */
  private captureType(info: RegexInfo | undefined): Type {
    return info && allCertain(info) ? STRING : { maybe: STRING };
  }

  /** Whether the value of `e` may be undefined where it is used (`??`, conditions, `!`, templates). */
  private undefinedHandled(e: ts.Expression): boolean {
    let n: ts.Node = e;
    while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
    const p = n.parent;
    if (ts.isBinaryExpression(p))
      return p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && p.left === n;
    if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isNonNullExpression(p) || ts.isTemplateSpan(p)) return true;
    if (ts.isConditionalExpression(p)) return p.condition === n;
    if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p))
      return p.expression === n;
    return false;
  }

  /**
   * `m[k]` of a match array (or split result) whose elements may be
   * undefined where TypeScript types the read as `string`.
   */
  private captureRead(e: ts.ElementAccessExpression, array: Expr, index: Expr, b: FnBuilder): Expr {
    const arg = skipParens(e.argumentExpression);
    const k = ts.isNumericLiteral(arg) ? Number(arg.text) : undefined;
    const source = this.matchSource(e.expression);
    if (
      !this.undefinedHandled(e) &&
      k !== undefined &&
      source &&
      !source.matches &&
      k <= source.info.captures &&
      source.info.certain[k]
    )
      return { op: 'unwrap', value: { op: 'index', array, index } };
    if (!this.undefinedHandled(e))
      return this.fail(
        e,
        'E_REGEXP',
        'This capture group may not participate in the match, so the value can be undefined (TypeScript types it as string); handle undefined, e.g. m[1] ?? ""',
      );
    // Out of range reads undefined, as in JavaScript.
    const arr = b.local('$match', this.irType(array, b));
    const i = b.local('$index', NUMBER);
    const a: Expr = { op: 'local', local: arr };
    const at: Expr = { op: 'local', local: i };
    return {
      op: 'with',
      local: arr,
      value: array,
      body: {
        op: 'with',
        local: i,
        value: index,
        body: {
          op: 'cond',
          test: {
            op: 'lt',
            left: at,
            right: { op: 'builtin', name: 'array.length', args: [a], type: NUMBER },
          },
          then: { op: 'index', array: a, index: at },
          else: { op: 'undefined', type: { maybe: STRING } },
        },
      },
    };
  }

  /** `m.groups.name`, `m.groups?.name`, `m.groups!.name` of a match array. */
  private groupsAccess(e: ts.Expression, b: FnBuilder): Expr | undefined {
    if (!ts.isPropertyAccessExpression(e)) return undefined;
    let g = skipParens(e.expression);
    while (ts.isNonNullExpression(g)) g = skipParens(g.expression);
    if (!ts.isPropertyAccessExpression(g) || g.name.text !== 'groups' || g.questionDotToken)
      return undefined;
    const node = g.expression;
    if (ts.isOptionalChain(node) || !this.isMatchArray(node)) return undefined;
    const name = e.name.text;
    const array = this.expr(node, b);
    const tmp = b.local('$match', this.irType(array, b));
    const m: Expr = { op: 'local', local: tmp };
    const read: Expr = {
      op: 'builtin',
      name: 'match.group',
      args: [m, { op: 'lit', value: name }],
      type: { maybe: STRING },
    };
    const optional = !!e.questionDotToken;
    const value: Expr = {
      op: 'with',
      local: tmp,
      value: array,
      body: optional
        ? {
            op: 'cond',
            test: { op: 'builtin', name: 'match.has-groups', args: [m], type: BOOLEAN },
            then: read,
            else: { op: 'undefined', type: { maybe: STRING } },
          }
        : read,
    };
    const here = this.types.typeOrUndefined(e);
    if (here !== undefined && !maybeInner(here)) {
      const source = this.matchSource(node);
      const at = source?.info.names.indexOf(name) ?? -1;
      if (source && !optional && at > 0 && source.info.certain[at] && !this.undefinedHandled(e))
        return { op: 'unwrap', value };
      if (!this.undefinedHandled(e))
        return this.fail(
          e,
          'E_REGEXP',
          `Group ${name} may not participate in the match, so its value can be undefined; handle undefined, e.g. m.groups?.${name} ?? ""`,
        );
    }
    return value;
  }

  /** `re.exec(s)`, `re.test(s)`, `re.toString()`. */
  private regexpMethod(
    method: string,
    receiver: Expr,
    node: ts.Expression,
    e: ts.CallExpression,
    b: FnBuilder,
  ): Expr {
    const string = (): Expr => {
      if (e.arguments.length !== 1) return this.fail(e, 'E_REGEXP', `${method} takes one string`);
      const v = this.expr(e.arguments[0], b);
      if (this.irType(v, b) !== 'string')
        return this.fail(e.arguments[0], 'E_REGEXP', `${method} takes a string`);
      return v;
    };
    const call = (name: string, args: Expr[], type: Type): Expr => ({
      op: 'builtin',
      name: `regexp.${name}`,
      args: [receiver, ...args],
      type,
    });
    switch (method) {
      case 'test':
        return call('test', [string()], BOOLEAN);
      case 'exec':
        return call('exec', [string()], {
          maybe: { array: this.captureType(this.regexInfo(node)) },
        });
      case 'toString':
        if (e.arguments.length) return this.fail(e, 'E_REGEXP', 'toString takes no arguments');
        return call('toString', [], STRING);
    }
    return this.fail(
      e,
      'E_REGEXP',
      `RegExp.prototype.${method} is unsupported (exec, test and toString are supported)`,
    );
  }

  /** String methods with a RegExp argument. */
  private stringRegexp(method: string, receiver: Expr, e: ts.CallExpression, b: FnBuilder): Expr {
    const [patternNode, second, ...rest] = e.arguments;
    const pattern = this.expr(patternNode, b);
    const info = this.regexInfo(patternNode);
    const call = (extra: Expr[], type: Type): Expr => ({
      op: 'builtin',
      name: `string.regexp-${method}`,
      args: [receiver, pattern, ...extra],
      type,
    });
    const arity = (n: number) => {
      if (e.arguments.length > n)
        this.fail(e, 'E_REGEXP', `${method} with a RegExp takes ${n} argument${n > 1 ? 's' : ''}`);
    };
    switch (method) {
      case 'replace':
      case 'replaceAll': {
        if (!second || rest.length)
          return this.fail(e, 'E_REGEXP', `${method} takes a RegExp and a replacement`);
        const fn = skipParens(second);
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
          return call(
            [this.replacer(fn, info, b), { op: 'lit', value: info?.captures ?? 0 }],
            STRING,
          );
        const value = this.expr(second, b);
        const t = this.irType(value, b);
        if (t === 'string') return call([value], STRING);
        if (typeof t === 'object' && 'fn' in t) {
          if (t.fn.params.length > 1 && !info)
            return this.fail(
              second,
              'E_REGEXP',
              'A replacement function taking captures needs a RegExp literal (or a const initialised with one), whose captures are known',
            );
          return call([value, { op: 'lit', value: info?.captures ?? 0 }], STRING);
        }
        return this.fail(second, 'E_REGEXP', 'The replacement must be a string or a function');
      }
      case 'match': {
        arity(1);
        const element = info && info.flags.includes('g') ? STRING : this.captureType(info);
        return call([], { maybe: { array: element } });
      }
      case 'matchAll': {
        arity(1);
        let n: ts.Node = e;
        while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
        const p = n.parent;
        const allowed =
          (ts.isForOfStatement(p) && p.expression === n) ||
          ts.isSpreadElement(p) ||
          (ts.isCallExpression(p) &&
            this.globalName(
              ts.isPropertyAccessExpression(p.expression) ? p.expression.expression : p.expression,
            ) === 'Array');
        if (!allowed)
          return this.fail(
            e,
            'E_REGEXP',
            'matchAll results are supported directly in for-of, Array.from(…) and [...…]',
          );
        return call([], { array: { array: this.captureType(info) } });
      }
      case 'search':
        arity(1);
        return call([], NUMBER);
      case 'split': {
        arity(2);
        const limit = second ? [this.expr(second, b)] : [];
        if (limit.length && this.irType(limit[0], b) !== 'number')
          return this.fail(second, 'E_REGEXP', 'The split limit must be a number');
        return call(limit, { array: this.captureType(info) });
      }
    }
    return this.fail(e, 'E_REGEXP', `String.prototype.${method} with a RegExp is unsupported`);
  }

  /**
   * A replacement function: the match, then each capture (`string` where
   * the pattern proves it present, else `string | undefined`), the position
   * and the string.
   */
  private replacer(
    fn: ts.ArrowFunction | ts.FunctionExpression,
    info: RegexInfo | undefined,
    b: FnBuilder,
  ): Expr {
    const ps = fn.parameters;
    if (ps.some(p => p.dotDotDotToken))
      this.fail(fn, 'E_REGEXP', 'Rest parameters of replacement functions are unsupported');
    if (!info && ps.length > 1)
      this.fail(
        fn,
        'E_REGEXP',
        'A replacement function taking captures needs a RegExp literal (or a const initialised with one), whose captures are known',
      );
    const n = info?.captures ?? 0;
    const types: Type[] = ps.map((p, i) => {
      if (i === 0) return STRING;
      if (i <= n) {
        const certain = info!.certain[i];
        if (!p.type) return certain ? STRING : { maybe: STRING };
        const declared = this.types.map(this.checker.getTypeFromTypeNode(p.type), p);
        if (declared === 'string' && !certain)
          this.fail(
            p,
            'E_REGEXP',
            `Capture ${i} may not participate in a match, so this parameter can be undefined; declare it string | undefined`,
          );
        return declared;
      }
      if (i === n + 1) return NUMBER;
      if (i === n + 2) return STRING;
      return this.fail(
        p,
        'E_REGEXP',
        'The groups parameter of replacement functions is unsupported',
      );
    });
    const { index, builder } = this.function(
      fn,
      `${b.name}.replacer`,
      b,
      b.component,
      undefined,
      types,
    );
    return { op: 'closure', function: index, captures: builder.captureSources.map(c => c.local) };
  }

  private array(e: ts.ArrayLiteralExpression, b: FnBuilder): Expr {
    const [only] = e.elements;
    if (
      e.elements.length === 1 &&
      ts.isSpreadElement(only) &&
      this.isMatchAll(skipParens(only.expression))
    )
      return this.expr(only.expression, b);
    const type = this.exprType(e);
    const t = typeof type === 'object' && 'maybe' in type ? type.maybe : type;
    if (!(typeof t === 'object' && 'array' in t))
      return this.fail(e, 'E_ARRAY', 'Array literal without an array type');
    const items = e.elements.map(el =>
      ts.isSpreadElement(el)
        ? { spread: this.expr(el.expression, b) }
        : this.coerce(el, b, t.array),
    );
    return { op: 'array', type: t, items };
  }
}

// Helpers -----------------------------------------------------------------------

const LABELS = new WeakMap<ts.Node, string>();

const GLOBAL_FUNCTIONS = new Set([
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'String',
  'Number',
  'Boolean',
  'structuredClone',
  'encodeURIComponent',
  'decodeURIComponent',
]);
const STATIC_NAMESPACES = new Set(['Math', 'Number', 'String', 'Array', 'Object', 'JSON']);

/** String methods that take a RegExp (`string.regexp-*` built-ins). */
const REGEXP_STRING_METHODS = new Set([
  'replace',
  'replaceAll',
  'match',
  'matchAll',
  'search',
  'split',
]);

/** RegExp properties (`regexp.*` built-ins). */
const REGEXP_PROPERTIES: Record<string, Type> = {
  source: STRING,
  flags: STRING,
  global: BOOLEAN,
  ignoreCase: BOOLEAN,
  multiline: BOOLEAN,
  dotAll: BOOLEAN,
  unicode: BOOLEAN,
  unicodeSets: BOOLEAN,
  sticky: BOOLEAN,
  hasIndices: BOOLEAN,
  lastIndex: NUMBER,
};

export const COMPOUND: Record<number, ts.SyntaxKind> = {
  [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken,
  [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken,
  [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken,
  [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken,
  [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken,
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: ts.SyntaxKind.AsteriskAsteriskToken,
  [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken,
  [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken,
  [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken,
  [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken,
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken,
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]:
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
};

export function isAssignmentOperator(k: ts.SyntaxKind) {
  return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
}

export function skipParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))
    e = e.expression;
  return e;
}

/** Rewrite provisional local indices in a function body (not nested functions). */
/** Renumber the local indices in an IR fragment. */
export function remapLocals<T>(node: T, map: (i: number) => number): T {
  const visit = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(visit);
    if (!n || typeof n !== 'object') return n;
    const o = n as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'local' && typeof v === 'number') out[k] = map(v);
      else if (k === 'captures' && o.op === 'closure' && Array.isArray(v))
        out[k] = (v as number[]).map(map);
      else out[k] = visit(v);
    }
    return out;
  };
  return visit(node) as T;
}

const lit = (value: string): Expr => ({ op: 'lit', value });
