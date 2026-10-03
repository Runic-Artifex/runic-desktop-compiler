// Shared lowering of TypeScript/JavaScript statements and expressions to IR
// schema 4 (docs/design/M2-VALUES.md). Framework adapters supply only the
// semantics of their reactive bindings through `Hooks`.
import ts from 'typescript';
import type { Expr, Fn, Local, Place, Stmt, Type } from './ir.ts';
import { sameType, TypeMapper, type Fail } from './types.ts';
import { builtinType, irType, maybeInner } from './irtype.ts';

export type Binding =
  | { kind: 'local'; owner: FnBuilder; local: number }
  | { kind: 'cell'; cell: number }
  | { kind: 'function'; fn: number }
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
  /** A Vue ref (`x.value` reads and writes the cell). */
  | { kind: 'ref'; cell: number }
  /** A Vue computed (`x.value` calls the derived function). */
  | { kind: 'computed'; fn: number }
  /** A component's props object (inlined components): member reads are values. */
  | { kind: 'props'; values: Map<string, Expr> }
  | { kind: 'event' };

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
export class FnBuilder {
  readonly captures: Local[] = [];
  readonly params: Local[] = [];
  readonly locals: Local[] = [];
  /** Outer (owner, local) → capture index, for closures. */
  readonly captureOf = new Map<string, number>();
  readonly captureSources: { owner: FnBuilder; local: number }[] = [];
  /** Labels of enclosing loops: [label, isRealLoop]. */
  readonly loops: { label: string; real: boolean }[] = [];
  private labelCounter = 0;

  readonly name: string;
  readonly parent: FnBuilder | undefined;
  readonly component: number | undefined;
  /** Symbols captured and mutated somewhere: their locals are boxed. */
  readonly boxed: Set<ts.Symbol>;
  readonly eventPayload: boolean;

  constructor(
    name: string,
    parent: FnBuilder | undefined,
    component: number | undefined,
    boxed: Set<ts.Symbol>,
    eventPayload: boolean,
  ) {
    this.name = name;
    this.parent = parent;
    this.component = component;
    this.boxed = boxed;
    this.eventPayload = eventPayload;
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
  readonly bindings = new Map<ts.Symbol, Binding>();

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
  ): { index: number; builder: FnBuilder } {
    const boxed = this.analyseCaptures(decl);
    for (const s of parent?.boxed ?? []) boxed.add(s);
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
      node: ts.ParameterDeclaration;
    }[] = [];
    for (const p of paramDecls) {
      if (p.dotDotDotToken) this.fail(p, 'E_FUNCTION', 'Rest parameters are planned for later');
      const type =
        paramTypes?.[pending.length] ?? this.types.map(this.checker.getTypeAtLocation(p), p);
      if (!ts.isIdentifier(p.name))
        this.fail(p, 'E_FUNCTION', 'Destructured parameters are planned for later');
      pending.push({
        symbol: this.checker.getSymbolAtLocation(p.name),
        type,
        name: p.name.text,
        node: p,
      });
    }
    const tsResult = sig!.getReturnType();
    let result: Type =
      tsResult.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
        ? 'void'
        : this.types.map(tsResult, decl);
    // Body lowering may add captures; params/locals are appended after, so we
    // lower into a staging builder and rebase indices at the end.
    const lowered = this.withParams(b, pending, () => this.functionBody(decl, b));
    if (tsResult.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      result = this.returnType(lowered, b);
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
    pending: { symbol?: ts.Symbol; type: Type; name: string; node: ts.ParameterDeclaration }[],
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
      if (p.node.initializer) {
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
              value: this.expr(p.node.initializer, b),
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
    return [{ op: 'return', value: this.expr(e, b) }];
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
  handler(
    decl: ts.FunctionLikeDeclaration,
    component: number,
    input: boolean,
  ): { locals: Local[]; body: Stmt[] } {
    const boxed = this.analyseCaptures(decl);
    const b = new FnBuilder('handler', undefined, component, boxed, input);
    const event = decl.parameters[0];
    if (event) {
      if (!ts.isIdentifier(event.name))
        this.fail(event, 'E_EVENT', 'Destructured event parameters are unsupported');
      this.bindings.set(this.checker.getSymbolAtLocation(event.name)!, { kind: 'event' });
    }
    if (decl.parameters.length > 1)
      this.fail(decl.parameters[1], 'E_EVENT', 'Event handlers take at most one parameter');
    const body = this.functionBody(decl, b);
    if (b.captures.length) throw new Error('handler captures');
    return { locals: b.locals, body };
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
      body: [{ op: 'return', value: v }],
    };
    return { op: 'call', function: index, args: [] };
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
    if (ts.isReturnStatement(s))
      return [
        {
          op: 'return',
          ...(s.expression ? { value: this.expr(s.expression, b) } : {}),
          ...this.src(s),
        },
      ];
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
      if (!label) {
        // Unlabelled continue targets the nearest real loop (not a switch).
        const target =
          op === 'continue' ? [...b.loops].reverse().find(l => l.real) : b.loops.at(-1);
        if (!target) this.fail(s, 'E_STATEMENT', `${op} outside a loop`);
        label = target!.label;
      }
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
    if (
      ts.isPropertyAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      target.name.text === 'value'
    ) {
      const ref = this.binding(target.expression);
      if (ref?.kind === 'ref') return this.hooks.cellType(ref.cell);
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
    const rhsType = () => ('expr' in valueNode ? valueNode.type : this.typeOfNode(valueNode));
    let value: Expr;
    if (operator === ts.SyntaxKind.EqualsToken) value = rhs();
    else if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken)
      value = { op: 'nullish', left: current(), right: rhs() };
    else if (
      operator === ts.SyntaxKind.BarBarEqualsToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    )
      return this.fail(target, 'E_ASSIGN', 'Logical assignment operators are planned for later');
    else if (compound)
      value = this.binary(
        compound,
        current(),
        this.targetType(target, b),
        rhs(),
        rhsType(),
        target,
      );
    else return this.fail(target, 'E_ASSIGN', 'Unsupported assignment operator');
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
    if (
      ts.isPropertyAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      target.name.text === 'value'
    ) {
      const ref = this.binding(target.expression);
      if (ref?.kind === 'ref') return this.hooks.writeCell!(ref.cell, value, b, target);
      if (ref?.kind === 'computed')
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
    const K = ts.SyntaxKind;
    const override = this.overrides.get(e);
    if (override) return override.expr;
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
        return typeof t === 'object' && 'maybe' in t ? { op: 'unwrap', value: v } : v;
      }
      case K.NumericLiteral:
        return { op: 'lit', value: Number((e as ts.NumericLiteral).text) };
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
        return this.stringLiteral(e, (e as ts.StringLiteral).text);
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
    const t = this.checker.getContextualType(e);
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
      case 'cell':
        return narrow(this.hooks.readCell(binding.cell, b, id), this.hooks.cellType(binding.cell));
      case 'derived':
        return { op: 'call', function: binding.fn, args: [] };
      case 'value':
        return binding.expr;
      case 'function': {
        // A function used as a value: wrap it in a closure forwarding its params.
        return { op: 'closure', function: binding.fn, captures: [] };
      }
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
          'Refs are supported through .value (passing ref objects is planned for M3)',
        );
      case 'event':
        return this.fail(
          id,
          'E_EVENT',
          'Event objects are supported only as e.target.value / e.currentTarget.value in input handlers',
        );
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
    if (typeof t === 'object') {
      if ('array' in t) return 'array';
      if ('map' in t) return 'map';
      if ('set' in t) return 'set';
      if ('maybe' in t) return 'maybe';
      if ('record' in t) return 'record';
    }
    return undefined;
  }

  /** The name of a standard-library global that `e` resolves to (a local binding cannot impersonate it). */
  /** A string literal; IR literals are Unicode text, so lone surrogates are rejected. */
  private stringLiteral(n: ts.Node, text: string): Expr {
    if (/\p{Cs}/u.test(text))
      this.fail(n, 'E_STRING', 'String literals with unpaired surrogates are unsupported');
    return { op: 'lit', value: text };
  }

  private globalName(e: ts.Expression): string | undefined {
    if (!ts.isIdentifier(e)) return undefined;
    const s = this.symbol(e);
    const decl = s?.valueDeclaration ?? s?.declarations?.[0];
    const file = decl?.getSourceFile();
    return file && this.program.isSourceFileDefaultLibrary(file) ? e.text : undefined;
  }

  private property(e: ts.PropertyAccessExpression, b: FnBuilder): Expr {
    const name = e.name.text;
    if (ts.isIdentifier(e.expression)) {
      const special = this.binding(e.expression);
      if (special?.kind === 'props')
        return special.values.get(name) ?? this.fail(e, 'E_PROPS', `Prop ${name} is not passed`);
      if (special?.kind === 'ref' && name === 'value') {
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
    const global = this.globalName(e.expression);
    if (global === 'Math' || global === 'Number')
      return { op: 'builtin', name: `${global}.${name}`, args: [], type: NUMBER };
    if (ts.isIdentifier(e.expression) && this.binding(e.expression)?.kind === 'event') {
      return this.fail(e, 'E_EVENT', 'Use e.target.value or e.currentTarget.value');
    }
    if (
      ts.isPropertyAccessExpression(e.expression) &&
      ts.isIdentifier(e.expression.expression) &&
      this.binding(e.expression.expression)?.kind === 'event'
    ) {
      if (
        ['target', 'currentTarget'].includes(e.expression.name.text) &&
        name === 'value' &&
        b.eventPayload
      )
        return { op: 'payload' };
      return this.fail(
        e,
        'E_EVENT',
        'Event objects are supported only as e.target.value / e.currentTarget.value in input handlers',
      );
    }
    const object = this.expr(e.expression, b);
    const t = this.irType(object, b);
    const kind = this.receiverKind(t);
    if (kind === 'record')
      return {
        op: 'get',
        object,
        field: this.types.fieldIndex((t as { record: number }).record, name, e),
      };
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
    const bt = this.typeAt(base);
    const bv = this.expr(base, b);
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
      alreadyMaybe = nested || (typeof thenType === 'object' && 'maybe' in thenType);
    } finally {
      this.overrides.delete(base);
    }
    if (!alreadyMaybe) then = { op: 'some', value: then };
    return { op: 'optional', value: bv, local: tmp, then };
  }

  private element(e: ts.ElementAccessExpression, b: FnBuilder): Expr {
    const object = this.expr(e.expression, b);
    const t = this.irType(object, b);
    const kind = this.receiverKind(t);
    if (kind === 'array')
      return { op: 'index', array: object, index: this.expr(e.argumentExpression, b) };
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
      const global = this.globalName(callee);
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
      if (global && STATIC_NAMESPACES.has(global))
        return this.builtinCall(`${global}.${method}`, args(), b, this.tsCallType(e), e);
      if (ts.isIdentifier(callee.expression)) {
        const special = this.binding(callee.expression);
        if (special?.kind === 'props')
          return { op: 'call-value', callee: this.property(callee, b), args: this.callArgs(e, b) };
      }
      const receiver = this.expr(callee.expression, b);
      const kind = this.receiverKind(this.irType(receiver, b));
      if (kind === 'record')
        return { op: 'call-value', callee: this.property(callee, b), args: this.callArgs(e, b) };
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
    this.bindings.set(sym, { kind: 'function', fn: index });
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
    if (!sig) return e.arguments.map(a => this.expr(a, b));
    return sig.parameters.map((p, i) => {
      const pt = this.types.map(this.checker.getTypeOfSymbolAtLocation(p, e), e);
      const arg = e.arguments[i];
      if (!arg) return { op: 'undefined', type: pt } as Expr;
      return this.coerce(arg, b, pt);
    });
  }

  private newExpression(e: ts.NewExpression, b: FnBuilder): Expr {
    const global = this.globalName(e.expression);
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

  private array(e: ts.ArrayLiteralExpression, b: FnBuilder): Expr {
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

const COMPOUND: Record<number, ts.SyntaxKind> = {
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
function remapLocals<T>(node: T, map: (i: number) => number): T {
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
