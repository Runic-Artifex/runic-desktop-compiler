// Shared lowering of TypeScript/JavaScript statements and expressions to IR
// schema 4 (docs/design/M2-VALUES.md). Framework adapters supply only the
// semantics of their reactive bindings through `Hooks`.
import ts from 'typescript';
import { platform } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  EVENT_KINDS,
  type AttrItem,
  WINDOW_EVENT_KINDS,
  type EventKind,
  type Expr,
  type Fn,
  type Global,
  type Literal,
  type Local,
  type Place,
  type Stmt,
  type Type,
} from './ir.ts';
import { containsAny, sameType, TypeMapper, type Fail } from './types.ts';
import {
  arrayElement,
  builtinType,
  ELEMENT_METRICS,
  ANIMATION_MEMBERS,
  EVENT_MEMBERS,
  irType,
  maybeInner,
  WINDOW_METRICS,
} from './irtype.ts';
import { DOM } from './program.ts';
import { declarationFile } from './package-modules.ts';
import { asyncBody, isAsync } from './async.ts';
import { allCertain, analyze, literalParts, syntaxError, type RegexInfo } from './regexp.ts';
import { intlSpec, LOCALES, verifiedLocale, type IntlKind } from './intl.ts';
import { Classes, type ClassInfo } from './classes.ts';
import { Unions } from './unions.ts';
import { bindPackConstant, packType } from './packs.ts';
import { newSvelteMap, svelteMapEntries, svelteMapType } from './svelte-reactivity.ts';
import { componentValueType, knownComponentRecord } from './component-values.ts';
import {
  type Choice,
  valueSet,
  graft as graftChoice,
  leaf as choiceLeaf,
  sequence as choiceSequence,
  toExpr as choiceExpr,
  valueChoice,
} from './packs/choice.ts';
import type { DomainHook } from './domains.ts';
import type { Shape } from './bags.ts';

/**
 * Members of records that packs define (svelte-toolbelt's boxes): reads and
 * writes of their properties lower through the pack.
 */
export interface RecordMembers {
  read(name: string, object: Expr, at: ts.Node, b: FnBuilder): Expr;
  write(name: string, object: Expr, value: Expr, at: ts.Node, b: FnBuilder): Stmt[];
  /** A method call (svelte/reactivity's SvelteMap). */
  call?(name: string, object: Expr, node: ts.CallExpression, b: FnBuilder): Expr;
}

/**
 * Whether the declaration file of untyped package function `decl`
 * declares it a type predicate dropping null: `(v: T | null) => v is T`.
 */
function declaredNotNull(decl: ts.FunctionLikeDeclaration): boolean {
  if (!ts.isFunctionDeclaration(decl) || !decl.name) return false;
  const file = decl.getSourceFile().fileName.replace(/\.__runic\.ts$/, '');
  const dts = declarationFile(file);
  if (!dts) return false;
  const sf = ts.createSourceFile(dts, readFileSync(dts, 'utf8'), ts.ScriptTarget.Latest, true);
  return sf.statements.some(s => {
    if (!ts.isFunctionDeclaration(s) || s.name?.text !== decl.name!.text) return false;
    const [p] = s.parameters;
    const t = s.type;
    if (!p || s.parameters.length !== 1 || !p.type || !t || !ts.isTypePredicateNode(t))
      return false;
    if (!ts.isUnionTypeNode(p.type) || !t.type || !ts.isIdentifier(t.parameterName)) return false;
    const parts = p.type.types.map(x => x.getText(sf));
    return (
      t.parameterName.text === p.name.getText(sf) &&
      parts.length === 2 &&
      parts.includes('null') &&
      parts.includes(t.type.getText(sf))
    );
  });
}

/** Event interfaces `instanceof` tests (runic_js::event::EVENT_INTERFACES). */
const EVENT_INTERFACES = [
  'Event',
  'UIEvent',
  'MouseEvent',
  'PointerEvent',
  'WheelEvent',
  'KeyboardEvent',
  'FocusEvent',
  'InputEvent',
  'CustomEvent',
];
/** The interface declaring an event member (`"button" in e`). */
const EVENT_MEMBER_INTERFACES: Record<string, string> = {
  type: 'Event',
  target: 'Event',
  currentTarget: 'Event',
  defaultPrevented: 'Event',
  preventDefault: 'Event',
  stopPropagation: 'Event',
  stopImmediatePropagation: 'Event',
  clientX: 'MouseEvent',
  clientY: 'MouseEvent',
  button: 'MouseEvent',
  buttons: 'MouseEvent',
  pointerType: 'PointerEvent',
  deltaX: 'WheelEvent',
  deltaY: 'WheelEvent',
  key: 'KeyboardEvent',
  code: 'KeyboardEvent',
  repeat: 'KeyboardEvent',
};

/** Events element listeners added by script receive (`element.listen`). */
const ELEMENT_SCRIPT_EVENTS = ['scroll', 'pointermove', 'pointerenter', 'pointerleave'];

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
      /**
       * The function literal a curried untyped function returned
       * (`Lowerer.curried`): the outer function's parameters, bound to the
       * values in `locals` of `owner`.
       */
      outer?: { params: readonly ts.ParameterDeclaration[]; owner: FnBuilder; locals: number[] };
    }
  | { kind: 'derived'; fn: number }
  /**
   * A module `let` (M6): field 0 of the one-field record program global
   * `global` holds it (reactive for `$state`; `Lowerer.moduleVariable`).
   */
  | { kind: 'module-let'; global: number }
  | { kind: 'value'; expr: Expr }
  /**
   * A function returning the window or the document (bits-ui's
   * `getOwnerDocument(el)`): calls of it are that host object
   * (`Lowerer.hostName`); it is not lowered as a function.
   */
  | { kind: 'host'; name: 'window' | 'document' }
  /**
   * A rest parameter of a function of known parameters (`(...args) =>`
   * where a callback of three is expected): the parameters it holds, in
   * locals of `owner`; it is spread into calls.
   */
  | { kind: 'rest'; owner: FnBuilder; locals: number[] }
  /** A ref object: `x.value` (Vue) or `x.<field>` (React `current`) reads and writes the cell. */
  | { kind: 'ref'; cell: number; field?: string }
  /** A Vue computed (`x.value` calls the derived function). */
  | { kind: 'computed'; fn: number }
  /** A component's props object (inlined components): member reads are values. */
  | { kind: 'props'; values: Map<string, Expr> }
  /** A handler's event parameter. */
  | { kind: 'event'; handler: FnBuilder }
  /**
   * An export of a mapping pack (frontend/packs.ts): calls lower through the
   * pack; other uses (and components, which templates expand) are rejected.
   */
  | {
      kind: 'pack';
      label: string;
      call?: (node: ts.CallExpression, b: FnBuilder, lower: Lowerer) => Expr;
      /** The exact values a call can return (calls evaluated at build time, frontend/packs/choice.ts). */
      choice?: (node: ts.CallExpression, b: FnBuilder, lower: Lowerer) => Choice;
      /** The values a call can return, without IR (frontend/domains.ts); undefined if open. */
      values?: (node: ts.CallExpression, lower: Lowerer) => unknown[] | undefined;
      /**
       * A call (or `new`) initialising a const that becomes a pack binding
       * (`tv(config)`, runed's `new Context(name)`).
       */
      constant?: (
        node: ts.CallExpression | ts.NewExpression,
        name: string,
        lower: Lowerer,
      ) => Binding;
      /** Wrappers returning a call of this function over a rest parameter are inlined. */
      inline?: boolean;
      /** Methods called on the bound value (`watch.pre(…)`, a context's `set`/`get`). */
      methods?: Record<string, (node: ts.CallExpression, b: FnBuilder, lower: Lowerer) => Expr>;
      /** The keys of the attribute bag a call returns (frontend/bags.ts). */
      shape?: (node: ts.CallExpression, of: (e: ts.Expression) => Shape) => Shape;
      /**
       * The values the bag a call returns holds for `key` (`undefined` where it
       * may not hold it; frontend/bags.ts `BagShapes.values`), given those of
       * its arguments; undefined where they are open.
       */
      keyValues?: (
        node: ts.CallExpression,
        key: string,
        of: (e: ts.Expression) => Shape,
        values: (e: ts.Expression) => unknown[] | undefined,
      ) => unknown[] | undefined;
      /** `new X(…)` of a pack class (svelte-toolbelt's DOMContext). */
      construct?: (node: ts.NewExpression, b: FnBuilder, lower: Lowerer) => Expr;
    }
  /** A class declaration (frontend/classes.ts): `new C(…)` and static members. */
  | { kind: 'class'; cls: ClassInfo }
  /**
   * A module constant of a package compiled from source, evaluated at build
   * time (frontend/package-bindings.ts): its primitive members are literals.
   */
  | { kind: 'constant'; label: string; value: unknown };

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
  /**
   * A local declaration the framework lowers itself (Svelte's `$state` and
   * `$derived` in functions of rune modules), or undefined.
   */
  localRune?(d: ts.VariableDeclaration, ctx: FnBuilder, lower: Lowerer): Stmt[] | undefined;
  /** The type a framework call (svelte/events' `on`) takes for argument `index`, if it says. */
  argumentType?(call: ts.CallExpression, index: number, lower: Lowerer): Type | undefined;
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
const VOID: Type = 'void';

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
    this.classes = new Classes(this);
    // Type parameters of generic functions (one instantiation per program,
    // `bindTypeParameters`), after those of generic classes.
    const classTypeArgs = this.types.typeParameter;
    this.types.typeParameter = t =>
      classTypeArgs?.(t) ?? (t.symbol ? this.functionTypeArgs.get(t.symbol) : undefined);
    types.classType = (cls, t, at) => this.classes.typeOf(cls, t, at);
    types.classUnion = (parts, at) => this.classes.unionOf(parts, at);
    types.hostParameter = p => this.hostParam(p) !== undefined;
    types.packType = (t, at) =>
      packType(t, at, this) ?? svelteMapType(t, at, this) ?? componentValueType(t, at, this);
    // Error objects are the Error records thrown values are (catch bindings, rejections).
    types.errorType = () => this.errorRecord();
    // Unions outside the value model, narrowed by the values reaching them.
    this.unions = new Unions(
      checker,
      () => program.getSourceFiles().filter(sf => !sf.isDeclarationFile),
      sourceOf,
      sym =>
        this.domains
          ? this.domains.values(sym)
          : this.unpassedProp?.(sym)
            ? [undefined]
            : undefined,
      () => program.getSourceFiles(),
      sym => this.domains?.written(sym),
      test => this.buildTimeTruth(test),
    );
    types.narrow = (parts, at, fail) => this.unions.member(parts, at, fail);
    types.nothingSlot = decl => this.unions.nothingSlot(decl);
    types.nothingInBoxes = decl => this.unions.nothingInBoxes(decl);
    types.anyFnSlot = (decl, box) => this.unions.anyFnSlot(decl, box);
    // Object types implemented with getters (frontend/types.ts `accessorTypes`).
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const visit = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n) && n.properties.some(ts.isGetAccessorDeclaration)) {
          const contextual = checker.getContextualType(n);
          if (contextual) types.accessorTypes.add(contextual);
          types.accessorTypes.add(checker.getTypeAtLocation(n));
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }

  /** Classes (frontend/classes.ts). */
  readonly classes: Classes;
  /** Unions narrowed by the values that reach them (frontend/unions.ts). */
  readonly unions: Unions;
  /**
   * Records whose object literals a pack builds (`object`: a literal
   * TypeScript cannot type where one is expected).
   */
  readonly recordLiterals = new Map<
    number,
    (e: ts.ObjectLiteralExpression, b: FnBuilder) => Expr
  >();
  /** Records whose members a pack lowers (by record index). */
  readonly recordMembers = new Map<number, RecordMembers>();
  /** The values props receive from their instantiation sites (frontend/domains.ts), if analysed. */
  domains?: DomainHook;
  /**
   * Before `domains` exist: whether a prop is never passed (no site sets
   * it, no site spreads a bag into its component) and has no default.
   */
  unpassedProp?: (sym: ts.Symbol) => boolean;
  /** Whether a source file is a component's the program never renders (the adapter's). */
  unrenderedFile?: (fileName: string) => boolean;

  /**
   * Whether `node` is in code that never runs: in a function or method all
   * of whose references are in components the program never renders, or in
   * such code in turn (bits-ui's `MenuRadioGroupState.create`, called only
   * by the radio group component, which a menu without radio items does not
   * render). Conservative: false where unsure.
   */
  neverRuns(node: ts.Node, depth = 0): boolean {
    if (depth > 4 || !this.unrenderedFile) return false;
    let f: ts.Node | undefined = node.parent;
    while (
      f &&
      !ts.isFunctionDeclaration(f) &&
      !ts.isMethodDeclaration(f) &&
      !ts.isConstructorDeclaration(f)
    )
      f = f.parent;
    if (!f) return false;
    const named = ts.isConstructorDeclaration(f)
      ? (f.parent as ts.ClassDeclaration).name
      : (f as ts.FunctionDeclaration | ts.MethodDeclaration).name;
    if (!named || !ts.isIdentifier(named)) return false;
    const sym = this.symbol(named);
    if (!sym) return false;
    let runs = false;
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile || runs) continue;
      if (!sf.text.includes(named.text)) continue;
      const unrendered = this.unrenderedFile(sf.fileName);
      const visit = (n: ts.Node) => {
        if (runs) return;
        if (ts.isIdentifier(n) && n !== named && n.text === named.text && this.symbol(n) === sym)
          if (!unrendered && !this.neverRuns(n, depth + 1)) runs = true;
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return !runs;
  }
  /**
   * Where `this` lives for the code of a class member (method, accessor,
   * constructor, field initialiser): a local of `owner`, a `maybe` one while
   * the constructor has not yet built the instance.
   */
  readonly thisBindings = new Map<
    ts.Node,
    {
      owner: FnBuilder;
      local: number;
      maybe?: boolean;
      /** In a constructor: the exact class being constructed (M6 inheritance). */
      cls?: ClassInfo;
    }
  >();

  /** Lower with `overrides` substituted for the given nodes. */
  withOverrides<T>(overrides: Map<ts.Node, { expr: Expr; type: Type }>, f: () => T): T {
    for (const [n, o] of overrides) this.overrides.set(n, o);
    try {
      return f();
    } finally {
      for (const n of overrides.keys()) this.overrides.delete(n);
    }
  }

  /**
   * The symbol `node` names; for the name of a shorthand property
   * (`{ rootMargin }`), the variable it reads.
   */
  valueSymbol(node: ts.Node): ts.Symbol | undefined {
    if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node)
      return this.checker.getShorthandAssignmentValueSymbol(node.parent);
    return this.checker.getSymbolAtLocation(node);
  }

  symbol(node: ts.Node): ts.Symbol | undefined {
    const s = this.valueSymbol(node);
    return s && s.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(s) : s;
  }

  /**
   * Variables captured by a closure created in their own initialiser
   * (`analyseCaptures`): declared by a binding, then assigned, so that the
   * closure shares the binding the value is stored in.
   */
  readonly selfCaptured = new Set<ts.Symbol>();

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
    /**
     * Variables a closure in their own initialiser captures (`const o = new
     * ResizeObserver(() => … o …)`): the closure must see the value assigned
     * after it was created, so they are shared by reference (boxed).
     */
    const early = new Set<ts.Symbol>();
    /** Nested function declarations, hoisted to their block's start. */
    const declarations = new Map<ts.Symbol, ts.Node>();
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
        const s = ts.isIdentifier(n.name) ? this.checker.getSymbolAtLocation(n.name) : undefined;
        if (s) declaredIn.set(s, fnOf(n) ?? body);
      }
      if (ts.isFunctionDeclaration(n) && n.name && n !== body) {
        const s = this.checker.getSymbolAtLocation(n.name);
        if (s) declarations.set(s, fnOf(n) ?? body);
      }
      // A function declaration a closure (or itself) refers to is created
      // with the others of its block, before them all exist: shared by
      // reference (boxed).
      if (ts.isIdentifier(n) && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)) {
        const s = this.checker.getSymbolAtLocation(n);
        const home = s && declarations.get(s);
        if (s && home && fnOf(n) !== home) early.add(s);
      }
      if (ts.isIdentifier(n) && !ts.isVariableDeclaration(n.parent)) {
        const s = this.checker.getSymbolAtLocation(n);
        const decl = s?.valueDeclaration;
        if (
          s &&
          decl &&
          ts.isVariableDeclaration(decl) &&
          decl.initializer &&
          n.pos >= decl.initializer.pos &&
          n.end <= decl.initializer.end &&
          fnOf(n) !== fnOf(decl)
        )
          early.add(s);
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
    for (const s of early) this.selfCaptured.add(s);
    return new Set([...[...captured].filter(s => mutated.has(s)), ...early]);
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
    options?: {
      tupleParams?: boolean;
      /** A class member: the instance is a first parameter `this` (frontend/classes.ts). */
      self?: Type;
      /** Lower the body with this instead of the declaration's statements (constructors). */
      body?: (b: FnBuilder) => Stmt[];
      /**
       * The result type, where the declaration's is not the value's (a
       * constructor returns its exact class; attribute bags).
       */
      result?: Type;
      /** Parameters of an outer function that come first (a curried function's literal). */
      outer?: readonly ts.ParameterDeclaration[];
      /**
       * Parameters (by index, outer ones first) that stand for closed
       * function literals applied at each call: no IR parameter.
       */
      inline?: Map<number, Binding>;
    },
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
    const paramDecls = [...(options?.outer ?? []), ...decl.parameters];
    const pending: {
      symbol?: ts.Symbol;
      type: Type;
      name: string;
      initializer?: ts.Expression;
      pattern?: ts.BindingPattern;
      restOf?: ts.Symbol;
    }[] = [];
    for (const [i, p] of paramDecls.entries()) {
      // A parameter that is the document or the window (`hostParam`): no IR parameter.
      if (this.hostParam(p)) continue;
      const literal = options?.inline?.get(i);
      if (literal) {
        const sym = ts.isIdentifier(p.name) ? this.checker.getSymbolAtLocation(p.name) : undefined;
        if (sym) this.bindings.set(sym, literal);
        continue;
      }
      // A rest parameter where the function's parameter types are given
      // (a callback): one parameter per remaining type.
      // (Or a tuple type: a callback TypeScript types from its context.)
      const restTuple =
        p.dotDotDotToken && !paramTypes ? this.checker.getTypeAtLocation(p) : undefined;
      const restTypes = paramTypes
        ? paramTypes.slice(pending.length)
        : restTuple && this.types.restParams(restTuple, p);
      if (
        p.dotDotDotToken &&
        restTypes &&
        i === paramDecls.length - 1 &&
        ts.isIdentifier(p.name) &&
        !p.initializer
      ) {
        const restOf = this.checker.getSymbolAtLocation(p.name);
        for (const [j, type] of restTypes.entries())
          pending.push({ type, name: `${p.name.text}$${j}`, restOf });
        // (An empty one has no parameters to register: spreading it passes none.)
        if (!restTypes.length && restOf)
          this.bindings.set(restOf, { kind: 'rest', owner: b, locals: [] });
        continue;
      }
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
      // A destructured parameter: an unnamed parameter, destructured on entry.
      if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
        pending.push({
          type,
          name: `$param${pending.length}`,
          initializer: p.initializer,
          pattern: p.name,
        });
        continue;
      }
      // An overridden parameter type also holds where the parameter is read.
      const given = paramTypes?.[pending.length];
      // A parameter property (class constructors) also declares a field: the body reads the parameter.
      const symbol = ts.isParameterPropertyDeclaration(p, p.parent)
        ? this.checker.getSymbolsOfParameterPropertyDeclaration(p, p.name.text)[0]
        : this.checker.getSymbolAtLocation(p.name);
      if (given && symbol) this.types.override(symbol, given);
      pending.push({
        symbol,
        type,
        name: p.name.text,
        initializer: p.initializer,
      });
    }
    if (options?.self) {
      // `this` is the first parameter (local 0).
      pending.unshift({ type: options.self, name: 'this' });
      this.thisBindings.set(decl, { owner: b, local: 0 });
    }
    const tsResult = sig!.getReturnType();
    // A host function (its result the window or the document, as its type
    // declares: bits-ui's `getWindow: () => this.domContext.getWindow()`):
    // it returns nothing, and its calls are the host object (`hostName`).
    // Its body is only the return of that object read without effects.
    if (!options?.result && this.types.hostOf(tsResult)) {
      const body = decl.body;
      const returned =
        body && !ts.isBlock(body)
          ? body
          : body && body.statements.length === 1 && ts.isReturnStatement(body.statements[0])
            ? body.statements[0].expression
            : undefined;
      if (!returned || this.hostName(returned) !== this.types.hostOf(tsResult))
        this.fail(
          decl,
          'E_FUNCTION',
          'A function returning the window or the document returns it directly (() => window, () => ctx.getWindow())',
        );
      options = { ...options, result: 'void', body: () => [] };
    }
    // A result TypeScript types as `any`, or wider than the value model
    // where the values returned have one type (a getter of a prop a
    // discriminant narrowed, `() => value`): the returned values' type.
    const untypedResult = !!(tsResult.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    // A function that never returns normally (it throws): no value.
    const never = !!(tsResult.flags & ts.TypeFlags.Never);
    const mapped =
      options?.result ?? (untypedResult || never ? 'void' : this.types.tryMap(tsResult, decl));
    const inferred = !options?.result && !never && (untypedResult || mapped === undefined);
    let result: Type = mapped ?? 'void';
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
    if (options?.result) result = options.result;
    // Body lowering may add captures; params/locals are appended after, so we
    // lower into a staging builder and rebase indices at the end.
    if (voidContext || !inferred) b.result = result;
    const lowered = this.withParams(b, pending, () => {
      if (options?.body) return options.body(b);
      if (!async) return this.functionBody(decl, b);
      if (!(typeof result === 'object' && 'promise' in result))
        return this.fail(decl, 'E_ASYNC', 'An async function needs a Promise result type');
      return asyncBody(this, decl, b, result.promise);
    });
    if (!voidContext && inferred) result = this.unifyReturns(lowered, b, decl);
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

  /**
   * The result type of an untyped function from the values it returns: their
   * one type, nullable where it also returns `undefined` or `null` (whose
   * type is settled here) or a nullable value (the others are wrapped).
   * Values of different types are left to the validator.
   */
  private unifyReturns(body: Stmt[], b: FnBuilder, at: ts.Node): Type {
    const returns: Extract<Stmt, { op: 'return' }>[] = [];
    const bare: Extract<Stmt, { op: 'return' }>[] = [];
    const visit = (stmts: Stmt[]) => {
      for (const st of stmts) {
        if (st.op === 'return' && st.value) returns.push(st);
        else if (st.op === 'return') bare.push(st);
        for (const v of Object.values(st))
          if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'op' in v[0])
            visit(v as Stmt[]);
        if (st.op === 'try') {
          if (st.catch) visit(st.catch.body);
          if (st.finally) visit(st.finally);
        }
      }
    };
    visit(body);
    // (A bare `null` or `undefined` returned, also one typed already by
    // a rule for untyped nulls: it takes the other returns' type.)
    const placeholder = (v: Expr) => v.op === 'undefined' || v.op === 'null';
    // `return []` (above): the array type of the other returns.
    const emptyArray = (v: Expr) =>
      v.op === 'array' &&
      !v.items.length &&
      typeof v.type === 'object' &&
      'array' in v.type &&
      v.type.array === 'void';
    const arrays = returns.filter(r => emptyArray(r.value!));
    if (arrays.length) {
      const others = returns.filter(r => !emptyArray(r.value!) && !placeholder(r.value!));
      const t = others.length ? this.irType(others[0].value!, b) : undefined;
      const inner = t && (maybeInner(t) ?? t);
      if (!(typeof inner === 'object' && 'array' in inner))
        return this.fail(
          at,
          'E_TYPE_UNSUPPORTED',
          'A function returning [] needs another return of an array type (or a result type)',
        );
      for (const r of arrays) (r.value as { type: Type }).type = inner;
    }
    const concrete = returns.filter(r => !placeholder(r.value!));
    // Only `undefined`/`null` returned: no other type to take (as a literal
    // `undefined` without a contextual type).
    if (!concrete.length) {
      if (!returns.length) return 'void';
      const none: Type = { maybe: NUMBER };
      for (const r of returns) (r.value as { type: Type }).type = none;
      return none;
    }
    const types = concrete.map(r => this.irType(r.value!, b));
    const inner = types.map(t => maybeInner(t) ?? t);
    if (!inner.every(t => sameType(t, inner[0]))) return types[0];
    // A bare `return;` (bits-ui's watch effects: `if (!viewport) return;`
    // before `return cleanup`) returns undefined, as does running off the
    // end of such a function.
    const nullable =
      concrete.length < returns.length || bare.length > 0 || types.some(t => maybeInner(t));
    const result: Type = nullable ? { maybe: inner[0] } : inner[0];
    if (bare.length) {
      for (const r of bare) r.value = { op: 'undefined', type: result };
      body.push({ op: 'return', value: { op: 'undefined', type: result } });
    }
    if (nullable)
      for (const r of returns) {
        const v = r.value!;
        if (placeholder(v)) (v as { type: Type }).type = result;
        else if (!maybeInner(this.irType(v, b))) r.value = { op: 'some', value: v };
      }
    return result;
  }

  /** Params are registered as locals of the builder before the body is lowered. */
  withParams(
    b: FnBuilder,
    pending: {
      symbol?: ts.Symbol;
      type: Type;
      name: string;
      initializer?: ts.Expression;
      pattern?: ts.BindingPattern;
      restOf?: ts.Symbol;
    }[],
    lower: () => Stmt[],
  ): Stmt[] {
    // Lower once to discover captures without registering anything else.
    const params: { index: number; p: (typeof pending)[number] }[] = [];
    for (const p of pending) {
      const index = b.param(p.name, p.type, !!p.symbol && b.boxed.has(p.symbol));
      params.push({ index, p });
      if (p.symbol) this.bindings.set(p.symbol, { kind: 'local', owner: b, local: index });
      if (p.restOf) {
        const known = this.bindings.get(p.restOf);
        if (known?.kind === 'rest' && known.owner === b) known.locals.push(index);
        else this.bindings.set(p.restOf, { kind: 'rest', owner: b, locals: [index] });
      }
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
              value: this.fitValue(this.expr(p.initializer, b), p.type, b),
            },
          ],
        });
      }
    }
    for (const { index, p } of params)
      if (p.pattern)
        body.push(...this.destructure(p.pattern, { op: 'local', local: index }, p.type, b));
    body.push(...lower());
    return body;
  }

  functionBody(decl: ts.FunctionLikeDeclaration, b: FnBuilder): Stmt[] {
    if (!decl.body) this.fail(decl, 'E_FUNCTION', 'Function without body');
    if (ts.isBlock(decl.body!)) return this.block(decl.body.statements, b);
    // Expression-bodied arrow.
    const e = decl.body as ts.Expression;
    const custom = this.hooks.statement?.(skipParens(e), b, this);
    if (custom) return custom;
    if (this.isStatementLike(e))
      return [...this.statement(ts.factory.createExpressionStatement(e), b, e)];
    if (b.result !== undefined && b.result !== 'void') this.expected.set(skipParens(e), b.result);
    // (A cast of a prop no site passes: see `coerce`.)
    const cast = skipParens(e);
    const value =
      b.result !== undefined && b.result !== 'void' && cast !== e && ts.isIdentifier(cast)
        ? this.coerce(e, b, b.result)
        : this.expr(e, b);
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
    /**
     * What the framework does with a promise the handler returns (Vue
     * handles it); by default it is discarded, as Svelte and React do.
     */
    returned?: (promise: Expr) => Expr,
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
        !returned,
      );
      // The function's promise goes to the framework.
      if (returned) {
        const last = body.pop();
        if (last?.op !== 'return' || !last.value) throw new Error('async body returns its promise');
        body.push({ op: 'expr', value: returned(last.value) });
      }
    } else {
      body = this.functionBody(decl, b);
      const ret = this.checker.getSignatureFromDeclaration(decl)?.getReturnType();
      if (returned && decl.body && ts.isBlock(decl.body) && ret?.symbol?.name === 'Promise')
        this.fail(
          decl,
          'E_EVENT',
          'A listener returning a promise from a block body is unsupported (return it from an arrow expression or make the listener async)',
        );
    }
    // A handler's value is discarded: `() => items.push(x)` runs for its effect;
    // a promise goes to the framework.
    if (decl.body && !ts.isBlock(decl.body) && body.length === 1 && body[0].op === 'return') {
      const v = body[0].value;
      const t = v && this.irType(v, b);
      const promise = returned && typeof t === 'object' && 'promise' in t;
      body = v ? [{ op: 'expr', value: promise ? returned(v) : v }] : [];
    }
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
   * The setter of a component binding to an assignable expression other
   * than a variable (bits-ui's `bind:value={rootState.opts.value.current as
   * string}`): a closure writing its parameter (of type `type`) there,
   * unwrapped where `present` (the child must never write undefined).
   */
  bindSetter(target: ts.Expression, parent: FnBuilder, type: Type, present: boolean): Expr {
    const b = new FnBuilder(`${parent.name}.bind`, parent, parent.component, new Set(), false);
    const v = b.param('v', type);
    const arg: Expr = { op: 'local', local: v };
    const body = this.writeTo(target, present ? { op: 'unwrap', value: arg } : arg, b);
    const index = this.reserve();
    this.functions[index] = {
      name: b.name,
      ...(parent.component !== undefined ? { component: parent.component } : {}),
      ...(b.captures.length ? { captures: b.captures } : {}),
      params: b.params,
      locals: b.locals,
      result: 'void',
      body: remapLocals([...this.hoistedLets(b), ...body], i => b.final(i)),
    };
    return { op: 'closure', function: index, captures: b.captureSources.map(c => c.local) };
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
      // (A type TypeScript cannot give, such as svelte-toolbelt's merged
      // props of a plain record: the lowered value's.)
      result:
        this.types.tryMap(this.checker.getTypeAtLocation(e), e) === undefined
          ? this.irType(v, b)
          : this.exprType(e),
      body: [...this.hoistedLets(b), { op: 'return', value: v }],
    };
    return { op: 'call', function: index, args: [] };
  }

  /**
   * A statement run for its effect while an instance of `component` is
   * created (a top-level statement of a component script): a call of a
   * function running it and returning `true`.
   */
  statementValue(s: ts.Statement, component: number, name: string): Expr {
    const b = new FnBuilder(name, undefined, component, new Set(), false);
    const body = this.statement(s, b);
    const index = this.reserve();
    this.functions[index] = {
      name,
      component,
      params: [],
      locals: b.locals,
      result: 'boolean',
      body: [...this.hoistedLets(b), ...body, { op: 'return', value: { op: 'lit', value: true } }],
    };
    return { op: 'call', function: index, args: [] };
  }

  /** Variables and fields assigned other than null or undefined (`onlyNothing`). */
  private setToSomething?: Set<ts.Symbol>;

  /**
   * Whether `x` names a variable or field that only ever holds null or
   * undefined: declared as one, and every assignment anywhere in the
   * program stores a value TypeScript types as null or undefined.
   */
  private onlyNothing(x: ts.Expression): boolean {
    const name = ts.isIdentifier(x) ? x : ts.isPropertyAccessExpression(x) ? x.name : undefined;
    const sym = name && this.checker.getSymbolAtLocation(name);
    const d = sym?.valueDeclaration;
    if (!sym || !d || !(ts.isPropertyDeclaration(d) || ts.isVariableDeclaration(d))) return false;
    if (!this.setToSomething) {
      const nothing = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
      const set = (this.setToSomething = new Set());
      const K = ts.SyntaxKind;
      const targetOf = (l: ts.Expression) => {
        l = skipParens(l);
        return ts.isPropertyAccessExpression(l) ? l.name : l;
      };
      for (const sf of this.program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        const visit = (n: ts.Node) => {
          if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind >= K.FirstAssignment &&
            n.operatorToken.kind <= K.LastAssignment
          ) {
            const l = skipParens(n.left);
            if (ts.isObjectLiteralExpression(l) || ts.isArrayLiteralExpression(l)) {
              // (A destructuring assignment: whatever it names.)
              const names = (m: ts.Node) => {
                const s = ts.isIdentifier(m) ? this.checker.getSymbolAtLocation(m) : undefined;
                if (s) set.add(s);
                ts.forEachChild(m, names);
              };
              names(l);
            }
            const s = this.checker.getSymbolAtLocation(targetOf(l));
            const plain = n.operatorToken.kind === K.EqualsToken;
            if (s && !(plain && this.checker.getTypeAtLocation(n.right).flags & nothing))
              set.add(s);
          } else if (
            (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
            (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken)
          ) {
            const s = this.checker.getSymbolAtLocation(targetOf(n.operand));
            if (s) set.add(s);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
    return !this.setToSomething.has(sym);
  }

  /**
   * The value of a side-effect-free test that the IR type of a local
   * decides: `Array.isArray(x)` and `typeof x === "…"` (or `!==`) of a
   * parameter or local, a prop's one value, or a value known at build time
   * (`staticValue`), through `!`, parentheses, and `&&`/`||` whose left
   * operand is decided. Also the member tests of a union narrowed by the
   * values that reach it (frontend/unions.ts: `typeof to.current ===
   * "string"`, `Array.isArray(v)`), whose operands are collected in
   * `effects` where reading them may have effects (a getter tracked as a
   * dependency): the caller evaluates them. Undefined otherwise.
   */
  /**
   * Whether member read `e` is a method (or a property of a function type)
   * TypeScript declares, not optional, on every type it may come from: a
   * function (`element.contains?.(x)` is `element.contains(x)`).
   */
  private declaredFunction(e: ts.PropertyAccessExpression): boolean {
    const decls = this.checker.getSymbolAtLocation(e.name)?.declarations ?? [];
    const t = this.checker.getTypeAtLocation(e);
    const fn = (d: ts.Declaration) =>
      ((ts.isMethodSignature(d) || ts.isMethodDeclaration(d)) && !d.questionToken) ||
      ((ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) &&
        !d.questionToken &&
        !!d.type &&
        ts.isFunctionTypeNode(d.type));
    return (
      decls.length > 0 &&
      decls.every(fn) &&
      t.getCallSignatures().length > 0 &&
      this.checker.getNonNullableType(t) === t
    );
  }

  private staticTruth(
    e: ts.Expression,
    b: FnBuilder,
    effects: ts.Expression[] = [],
  ): boolean | undefined {
    e = skipParens(e);
    // Known without lowering (`buildTimeTruth`): a value traced to the
    // calls that pass it, or a field every class the value can have
    // declares with one literal type (its receiver is still read).
    const known = this.buildTimeTruth(e);
    if (known !== undefined) {
      if (ts.isPropertyAccessExpression(e) && this.classLiteral(e)) effects.push(e.expression);
      return known;
    }
    // The document and the window (also through a constant naming them:
    // bits-ui's `const doc = getDocument(node); if (!doc) return;`) are
    // objects: truthy.
    const host = this.hostName(e);
    if (host === 'document' || host === 'window') return true;
    // A value known at build time (literals, pack constants: esm-env's DEV).
    const value = this.staticValue(e);
    if (value) return !!value.value;
    // A prop that takes one value at every site (bits-ui's ScrollLock's
    // `preventScroll`, false under a Popover): its truth.
    if (ts.isIdentifier(e) && this.domains) {
      const sym = this.symbol(e);
      const values =
        sym && this.bindingOf(sym)?.kind === 'cell' ? this.domains.values(sym) : undefined;
      if (values?.length === 1) return !!values[0];
    }
    const K = ts.SyntaxKind;
    // (Also a member of a name or of `this`, which a decided test still
    // reads: `typeof this.opts.style` of a box, bits-ui's floating layer.)
    let readEffect: ts.Expression | undefined;
    const typeOfLocal = (x: ts.Expression): Type | undefined => {
      x = skipParens(x);
      const chain = (y: ts.Expression): boolean =>
        ts.isIdentifier(y) ||
        y.kind === ts.SyntaxKind.ThisKeyword ||
        (ts.isPropertyAccessExpression(y) && !y.questionDotToken && chain(y.expression));
      if (ts.isPropertyAccessExpression(x) && chain(x)) {
        const probe = new FnBuilder('probe', b, b.component, new Set(b.boxed), false);
        let t: Type;
        try {
          t = this.irType(this.expr(x, probe), probe);
        } catch (err) {
          // (A member that is not a value here, such as a method: undecided.)
          if (/^E_(MEMBER|TYPE|FIELD)/.test((err as { code?: string }).code ?? ''))
            return undefined;
          throw err;
        }
        readEffect = x;
        return t;
      }
      if (!ts.isIdentifier(x)) return undefined;
      const binding = this.binding(x);
      if (binding?.kind !== 'local') return undefined;
      return this.irType(this.expr(x, b), b);
    };
    /** The member a narrowed union stands for, where `x` has one (and no nullish part). */
    const member = (x: ts.Expression): ts.Type | undefined => {
      x = skipParens(x);
      const t = this.checker.getTypeAtLocation(x);
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || !t.isUnion()) return undefined;
      if (
        t.types.some(
          p => p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void),
        )
      )
        return undefined;
      // Mapping the type narrows it (or rejects it).
      if (this.types.tryMap(t, x) === undefined) return undefined;
      const m = this.unions.narrowed(t);
      if (m && !ts.isIdentifier(x)) effects.push(x);
      return m;
    };
    if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken) {
      const v = this.staticTruth(e.operand, b, effects);
      return v === undefined ? undefined : !v;
    }
    // A method (or a property of a function type) TypeScript declares, not
    // optional, is a function: truthy (bits-ui's `if (!element ||
    // !element.focus) return`, also of a union of such declarations). The
    // receiver is still read.
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && this.declaredFunction(e)) {
      effects.push(e.expression);
      return true;
    }
    // A member that holds an object (bits-ui's `!this.opts.style` of a box)
    // is truthy; it is still read.
    // (Not a field declared without an initialiser, which holds undefined
    // until assigned whatever its declared type: bits-ui's
    // `static instance` of FocusScopeManager.)
    const uninitialised = (x: ts.PropertyAccessExpression) => {
      const d = this.checker.getSymbolAtLocation(x.name)?.valueDeclaration;
      return !!d && ts.isPropertyDeclaration(d) && !d.initializer;
    };
    if (ts.isPropertyAccessExpression(e) && !uninitialised(e)) {
      readEffect = undefined;
      const t = typeOfLocal(e);
      const object =
        t === 'element' ||
        (typeof t === 'object' &&
          ['array', 'record', 'map', 'set', 'class', 'classes', 'fn'].some(k => k in t));
      if (object && readEffect) {
        effects.push(readEffect);
        return true;
      }
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
        const left = this.staticTruth(e.left, b, effects);
        if (left === undefined) {
          // `a && false` is falsy and `a || true` truthy whatever `a` is
          // (it is still evaluated).
          const and = op === K.AmpersandAmpersandToken;
          const rightEffects: ts.Expression[] = [];
          const right = this.staticTruth(e.right, b, rightEffects);
          if (right !== and && right !== undefined) {
            effects.push(e.left, ...rightEffects);
            return right;
          }
          return undefined;
        }
        if (op === K.AmpersandAmpersandToken ? !left : left) return left;
        return this.staticTruth(e.right, b, effects);
      }
      const eq = [K.EqualsEqualsEqualsToken, K.EqualsEqualsToken].includes(op);
      const ne = [K.ExclamationEqualsEqualsToken, K.ExclamationEqualsToken].includes(op);
      // A value TypeScript types as only null (or only undefined) compared
      // with null or undefined (a field untyped code never sets).
      if (eq || ne) {
        const nothing = (x: ts.Expression) =>
          x.kind === K.NullKeyword
            ? 'null'
            : (ts.isIdentifier(x) && x.text === 'undefined' && !this.binding(x)) ||
                ts.isVoidExpression(x)
              ? 'undefined'
              : undefined;
        const [l, r] = [skipParens(e.left), skipParens(e.right)];
        const other = nothing(r) ? l : nothing(l) ? r : undefined;
        const lit = nothing(r) ?? nothing(l);
        const t = other && this.checker.getTypeAtLocation(other);
        const only =
          t && t.flags & ts.TypeFlags.Null
            ? 'null'
            : t && t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)
              ? 'undefined'
              : undefined;
        // Only a variable or field the program never sets to anything
        // else: not an accessor such as a box's `current`, which code may
        // fill while its type stays null (bits-ui's `floating.current` of
        // `simpleBox(null)`).
        if (other && lit && only && this.onlyNothing(other)) {
          const loose = op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken;
          if (!ts.isIdentifier(other)) effects.push(other);
          return (loose || only === lit) === eq;
        }
      }
      // A prop that takes one value at every site (a discriminant, bits-ui's
      // `type`) compared with a string.
      if ((eq || ne) && ts.isStringLiteralLike(e.right)) {
        const one = this.oneValue(e.left);
        if (one !== undefined) return (one === e.right.text) === eq;
      }
      if ((eq || ne) && ts.isTypeOfExpression(e.left) && ts.isStringLiteralLike(e.right)) {
        const m = member(e.left.expression);
        if (m) {
          const F = ts.TypeFlags;
          const name =
            m.flags & F.StringLike
              ? 'string'
              : m.flags & F.NumberLike
                ? 'number'
                : m.flags & F.BooleanLike
                  ? 'boolean'
                  : m.getCallSignatures().length
                    ? 'function'
                    : 'object';
          return (name === e.right.text) === eq;
        }
        const t = typeOfLocal(e.left.expression);
        const kind = (x: Type): string | undefined =>
          x === 'string' || x === 'number' || x === 'boolean'
            ? x
            : typeof x === 'object' && 'fn' in x
              ? 'function'
              : typeof x === 'object' &&
                  ['array', 'record', 'map', 'set', 'class', 'classes'].some(k => k in x)
                ? 'object'
                : undefined;
        if (t === undefined) return undefined;
        const inner = maybeInner(t);
        if (inner !== undefined) {
          // A nullable value is `undefined`, `null` (`object`) or its value:
          // a test for another type is false (`typeof getter === function`
          // of a nullable boolean).
          const k = kind(inner);
          if (k === undefined || ['undefined', 'object', k].includes(e.right.text))
            return undefined;
          if (readEffect) effects.push(readEffect);
          return !eq;
        }
        const name = kind(t);
        if (name === undefined) return undefined;
        if (readEffect) effects.push(readEffect);
        return (name === e.right.text) === eq;
      }
      return undefined;
    }
    // A value that only holds null or undefined (a prop no site passes,
    // a getter box of one: frontend/unions.ts) is falsy. Reading it has no
    // effect (the getters only return such values), so it is not read.
    if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && this.unions.nothing(e))
      return false;
    if (
      ts.isCallExpression(e) &&
      e.arguments.length === 1 &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === 'isArray' &&
      this.globalName(e.expression.expression) === 'Array'
    ) {
      const m = member(e.arguments[0]);
      if (m) return this.checker.isArrayType(m) || this.checker.isTupleType(m);
      const t = typeOfLocal(e.arguments[0]);
      if (t === undefined || (typeof t === 'object' && 'maybe' in t)) return undefined;
      // (A tuple record is an array in JavaScript.)
      if (typeof t === 'object' && 'record' in t && this.types.isTuple(t.record)) return true;
      return typeof t === 'object' && 'array' in t;
    }
    return undefined;
  }

  // Build-time values and truth, without lowering ----------------------------

  /**
   * The one value `e` has wherever it is evaluated, known without lowering
   * it: a literal or build-time constant (`staticValue`), a prop that takes
   * one value at every site (frontend/domains.ts), or a property
   * destructured from a parameter (bits-ui's `static create(props) { const
   * { type, ...rest } = props; … }`) that every call of its function, all of
   * them direct calls in the program, passes in an object literal with one
   * such value. Undefined where it may differ or cannot be told.
   */
  buildTimeValue(e: ts.Expression, depth = 0): { value: unknown } | undefined {
    e = skipParens(e);
    const known = this.staticValue(e);
    if (known) return known;
    if (!ts.isIdentifier(e) || depth > 8) return undefined;
    const sym = this.checker.getSymbolAtLocation(e);
    return sym && this.symbolValue(sym, depth);
  }

  private symbolValue(sym: ts.Symbol, depth: number): { value: unknown } | undefined {
    // (Not a snippet or function prop: sites pass snippets as content, which
    // the prop domains do not see.)
    const decl = sym.valueDeclaration;
    const callable =
      !!decl &&
      this.checker
        .getNonNullableType(this.checker.getTypeOfSymbolAtLocation(sym, decl))
        .getCallSignatures().length > 0;
    const values = callable ? undefined : this.domains?.values(sym);
    if (values) return values.length === 1 ? { value: values[0] } : undefined;
    if (callable) return undefined;
    const el = sym.valueDeclaration;
    if (!el || !ts.isBindingElement(el) || el.dotDotDotToken || el.initializer) return undefined;
    const pattern = el.parent;
    if (!ts.isObjectBindingPattern(pattern)) return undefined;
    const key = (el.propertyName ?? el.name) as ts.Node;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return undefined;
    // The parameter destructured, directly or by a constant.
    let param: ts.ParameterDeclaration | undefined;
    if (ts.isParameter(pattern.parent)) param = pattern.parent;
    else if (
      ts.isVariableDeclaration(pattern.parent) &&
      pattern.parent.initializer &&
      ts.isIdentifier(pattern.parent.initializer) &&
      ts.getCombinedNodeFlags(pattern.parent) & ts.NodeFlags.Const
    ) {
      const d = this.checker.getSymbolAtLocation(pattern.parent.initializer)?.valueDeclaration;
      if (
        d &&
        ts.isParameter(d) &&
        ts.isIdentifier(d.name) &&
        this.destructuredFirst(d, pattern.parent)
      )
        param = d;
    }
    if (!param || param.dotDotDotToken) return undefined;
    const fn = param.parent;
    const index = fn.parameters.indexOf(param);
    const calls = this.callsOf(fn);
    if (!calls) return undefined;
    let found: { value: unknown } | undefined;
    for (const call of calls) {
      const arg = call.arguments[index] && skipParens(call.arguments[index]);
      if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
      if (
        arg.properties.some(
          p => !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p),
        )
      )
        return undefined;
      const prop = arg.properties.find(
        p =>
          (ts.isIdentifier(p.name!) || ts.isStringLiteral(p.name!)) &&
          (p.name as ts.Identifier).text === key.text,
      );
      const v = !prop
        ? { value: undefined }
        : ts.isShorthandPropertyAssignment(prop)
          ? (() => {
              const s = this.checker.getShorthandAssignmentValueSymbol(prop);
              return s && this.symbolValue(s, depth + 1);
            })()
          : this.buildTimeValue((prop as ts.PropertyAssignment).initializer, depth + 1);
      if (!v || (found && found.value !== v.value)) return undefined;
      found = v;
    }
    return found;
  }

  /**
   * Whether a constant destructuring parameter `p` (`decl`) reads it before
   * anything can change it: a statement of the function's body, the
   * parameter's first use; and the parameter is never reassigned.
   */
  private destructuredFirst(p: ts.ParameterDeclaration, decl: ts.VariableDeclaration): boolean {
    const body = (p.parent as ts.FunctionLikeDeclaration).body;
    const statement = decl.parent.parent;
    if (!body || !ts.isBlock(body) || !body.statements.includes(statement as ts.Statement))
      return false;
    const sym = this.checker.getSymbolAtLocation(p.name);
    let ok = true;
    let first = true;
    const visit = (n: ts.Node): void => {
      if (!ok) return;
      if (ts.isIdentifier(n) && this.checker.getSymbolAtLocation(n) === sym) {
        const assigned =
          ts.isBinaryExpression(n.parent) &&
          n.parent.left === n &&
          n.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        if (assigned || (first && n !== decl.initializer)) ok = false;
        first = false;
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return ok;
  }

  /** The calls of each function, where the program only calls it directly (by name). */
  private readonly calls = new Map<ts.Node, ts.CallExpression[] | null>();

  /**
   * The calls of a named function or method in the program's code, where
   * it is only ever called directly (by its name, or as `X.name(…)`); null
   * where it is used as a value too.
   */
  private callsOf(fn: ts.SignatureDeclaration): ts.CallExpression[] | null {
    if (this.calls.has(fn)) return this.calls.get(fn)!;
    this.calls.set(fn, null);
    const name = fn.name;
    const sym = name && this.checker.getSymbolAtLocation(name);
    if (
      !sym ||
      !(ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) ||
      !ts.isIdentifier(name!)
    )
      return null;
    const found: ts.CallExpression[] = [];
    let escapes = false;
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile || escapes || !sf.text.includes(name!.text)) continue;
      // (Not in a component nothing renders, nor in a function nothing
      // that runs calls.)
      if (this.unrenderedFile?.(sf.fileName)) continue;
      const visit = (n: ts.Node): void => {
        if (escapes) return;
        // (Through imports: their specifiers are not uses.)
        const specifier =
          !!n.parent &&
          (ts.isImportSpecifier(n.parent) ||
            ts.isExportSpecifier(n.parent) ||
            ts.isImportClause(n.parent));
        if (ts.isIdentifier(n) && n !== name && n.text === name!.text && !specifier) {
          let at = this.checker.getSymbolAtLocation(n);
          if (at && at.flags & ts.SymbolFlags.Alias) at = this.checker.getAliasedSymbol(at);
          if (at === sym && !this.neverRuns(n)) {
            const callee =
              ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
            if (ts.isCallExpression(callee.parent) && callee.parent.expression === callee)
              found.push(callee.parent);
            else escapes = true;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    const result = escapes ? null : found;
    this.calls.set(fn, result);
    return result;
  }

  /**
   * Whether `e` is true or false wherever it is evaluated, known without
   * lowering it (`buildTimeValue` of its operands; `!`, `&&`, `||`,
   * equality; `classLiteral` members).
   */
  buildTimeTruth(e: ts.Expression): boolean | undefined {
    e = skipParens(e);
    const K = ts.SyntaxKind;
    if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken) {
      const v = this.buildTimeTruth(e.operand);
      return v === undefined ? undefined : !v;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
        const l = this.buildTimeTruth(e.left);
        if (l === undefined) return undefined;
        if (op === K.AmpersandAmpersandToken ? !l : l) return l;
        return this.buildTimeTruth(e.right);
      }
      const eq = [K.EqualsEqualsEqualsToken, K.EqualsEqualsToken].includes(op);
      const ne = [K.ExclamationEqualsEqualsToken, K.ExclamationEqualsToken].includes(op);
      if (eq || ne) {
        const l = this.buildTimeValue(e.left) ?? this.classLiteral(e.left);
        const r = l && (this.buildTimeValue(e.right) ?? this.classLiteral(e.right));
        if (!l || !r) return undefined;
        const loose = op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken;
        // (Loose equality of primitives of one type, or of null and undefined.)
        const same = loose ? l.value == r.value : l.value === r.value;
        if (loose && typeof l.value !== typeof r.value && l.value != null && r.value != null)
          return undefined;
        return eq ? same : !same;
      }
      return undefined;
    }
    const v = this.buildTimeValue(e) ?? this.classLiteral(e);
    return v ? !!v.value : undefined;
  }

  /**
   * `x.f` where every class the value of `x` can have (its type's classes
   * that the program constructs, `constructedClasses`) declares `f` as a
   * field of one literal type (bits-ui's `this.root.isMulti`, `readonly
   * isMulti: false` of the single select where no multiple one exists),
   * and no code assigns a property of its name.
   */
  classLiteral(e: ts.Expression): { value: unknown } | undefined {
    e = skipParens(e);
    if (!ts.isPropertyAccessExpression(e) || e.questionDotToken) return undefined;
    // (TypeScript's literal type, where nothing assigns a property of the
    // name: the typed modules of package JavaScript are not type-checked.)
    if (this.assignedNames().has(e.name.text)) return undefined;
    // (Also a member of a union of object types the values reaching it
    // narrowed to one member, frontend/unions.ts: bits-ui's
    // `selection.type` of the single select's value snippet.)
    const receiver = this.checker.getTypeAtLocation(e.expression);
    const narrowed =
      receiver.isUnion() && this.checker.getNonNullableType(receiver) === receiver
        ? this.unions.narrowed(receiver)
        : undefined;
    if (narrowed) {
      const prop = this.checker.getPropertyOfType(narrowed, e.name.text);
      const t = prop && this.checker.getTypeOfSymbol(prop);
      if (!t || prop!.flags & ts.SymbolFlags.Optional) return undefined;
      if (t.isStringLiteral() || t.isNumberLiteral()) return { value: t.value };
      if (t.flags & ts.TypeFlags.BooleanLiteral)
        return { value: (t as unknown as { intrinsicName: string }).intrinsicName === 'true' };
      return undefined;
    }
    const possible = this.possibleClasses(e.expression);
    if (!possible?.length) return undefined;
    let found: { value: unknown } | undefined;
    for (const c of possible) {
      const prop = this.checker.getPropertyOfType(
        this.checker.getDeclaredTypeOfSymbol(c),
        e.name.text,
      );
      const d = prop?.valueDeclaration;
      if (!prop || !d || !(ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)))
        return undefined;
      const t = this.checker.getTypeOfSymbol(prop);
      const v =
        t.isStringLiteral() || t.isNumberLiteral()
          ? t.value
          : t.flags & ts.TypeFlags.BooleanLiteral
            ? (t as unknown as { intrinsicName: string }).intrinsicName === 'true'
            : undefined;
      if (v === undefined || (found && found.value !== v)) return undefined;
      found = { value: v };
    }
    return found;
  }

  /** `assignedNames`: computed once. */
  private assignedNameSet?: Set<string>;

  /**
   * The names of the properties the program assigns anywhere (`x.f = …`,
   * compound assignments, `++`/`--`, `x["f"] = …`).
   */
  private assignedNames(): Set<string> {
    if (this.assignedNameSet) return this.assignedNameSet;
    const out = new Set<string>();
    const target = (t: ts.Expression) => {
      t = skipParens(t);
      if (ts.isPropertyAccessExpression(t)) out.add(t.name.text);
      else if (ts.isElementAccessExpression(t) && ts.isStringLiteralLike(t.argumentExpression))
        out.add(t.argumentExpression.text);
    };
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const visit = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          target(n.left);
        if (
          (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
          (n.operator === ts.SyntaxKind.PlusPlusToken ||
            n.operator === ts.SyntaxKind.MinusMinusToken)
        )
          target(n.operand);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    this.assignedNameSet = out;
    return out;
  }

  /**
   * The classes compiled from source a value of `x` can be an instance of:
   * those of its type (a class or a union of classes) and their subclasses
   * that the program constructs. Undefined where its type is not one, or
   * the program constructs classes it cannot name.
   */
  private possibleClasses(x: ts.Expression): ts.Symbol[] | undefined {
    const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(x));
    const members = t.isUnion() ? t.types : [t];
    const classes = members.map(m =>
      m.symbol && m.symbol.flags & ts.SymbolFlags.Class && !m.getConstructSignatures().length
        ? m.symbol
        : undefined,
    );
    if (classes.some(c => !c)) return undefined;
    return this.liveSubclasses(classes as ts.Symbol[]);
  }

  /**
   * The constructed classes that are `classes` or extend one of them
   * (undefined: unknown, or a class that is not compiled from source). A
   * package's declaration of a class stands for its implementation.
   */
  liveSubclasses(given: ts.Symbol[]): ts.Symbol[] | undefined {
    const built = this.constructedClasses();
    if (!built) return undefined;
    const classes: ts.Symbol[] = [];
    for (const c of given) {
      const decl = c.valueDeclaration ?? c.declarations?.[0];
      const source = decl?.getSourceFile().isDeclarationFile ? this.implementation?.(c) : c;
      if (!source) return undefined;
      classes.push(source);
    }
    return [...built].filter(c => {
      for (let x: ts.Symbol | undefined = c; x; x = this.baseClass(x))
        if (classes.includes(x)) return true;
      return false;
    });
  }

  private baseClass(c: ts.Symbol): ts.Symbol | undefined {
    const [base] = this.checker.getBaseTypes(
      this.checker.getDeclaredTypeOfSymbol(c) as ts.InterfaceType,
    );
    return base?.symbol;
  }

  /** `constructedClasses`: computed once; null while computing or where unknown. */
  private built: Set<ts.Symbol> | null | undefined;

  /**
   * The classes compiled from source that the program constructs: `new C(…)`
   * in code that runs (not in a component nothing renders, a function
   * nothing that runs calls (`neverRuns`), or a branch `buildTimeTruth`
   * decides against). Null where a `new` names something else than a class
   * (a constructor in a variable).
   */
  constructedClasses(): Set<ts.Symbol> | null {
    if (this.built !== undefined) return this.built;
    // (Not before the prop domains exist: the tests they decide are open.)
    if (!this.domains) return null;
    this.built = null;
    const out = new Set<ts.Symbol>();
    let unknown = false;
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile || unknown || this.unrenderedFile?.(sf.fileName)) continue;
      const visit = (n: ts.Node): void => {
        if (unknown) return;
        if (ts.isConditionalExpression(n) || ts.isIfStatement(n)) {
          const test = ts.isIfStatement(n) ? n.expression : n.condition;
          const d = this.buildTimeTruth(test);
          if (d !== undefined) {
            visit(test);
            const live = ts.isIfStatement(n)
              ? d
                ? n.thenStatement
                : n.elseStatement
              : d
                ? n.whenTrue
                : n.whenFalse;
            if (live) visit(live);
            return;
          }
        }
        if (ts.isNewExpression(n)) {
          let sym = this.checker.getSymbolAtLocation(n.expression);
          if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
          const d = sym?.valueDeclaration;
          if (d && (ts.isClassDeclaration(d) || ts.isClassExpression(d))) {
            if (!d.getSourceFile().isDeclarationFile && !this.neverRuns(n)) out.add(sym!);
          } else if (!d || !d.getSourceFile().isDeclarationFile) {
            unknown = true;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    this.built = unknown ? null : out;
    return this.built;
  }

  /** `v` as a `want` value (a nullable target takes a plain value). */
  private fitValue(v: Expr, want: Type, b: FnBuilder): Expr {
    const have = this.irType(v, b);
    return maybeInner(want) && !maybeInner(have) && have !== 'void' ? { op: 'some', value: v } : v;
  }

  /** Object.prototype's member names: a dictionary object would read them. */
  private static readonly PROTOTYPE_NAMES = [
    '__proto__',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    'constructor',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    'toString',
    'valueOf',
  ];
  private readonly guards = new Map<string, number>();

  /**
   * A function of a key: for the name of an Object.prototype member (which
   * a plain object would find on its prototype, or, written, `__proto__`
   * would replace the prototype) it throws RunicUnsupportedError; otherwise
   * it gives undefined of type `result` (or nothing).
   */
  private prototypeGuard(result: Type, write = false): number {
    const key = JSON.stringify([result, write]);
    const known = this.guards.get(key);
    if (known !== undefined) return known;
    const index = this.reserve();
    this.guards.set(key, index);
    const names = write ? ['__proto__'] : Lowerer.PROTOTYPE_NAMES;
    const test = names
      .map((n): Expr => ({
        op: 'eq',
        left: { op: 'local', local: 0 },
        right: { op: 'lit', value: n },
      }))
      .reduce((a, c) => ({ op: 'or', left: a, right: c }));
    const error: Expr = {
      op: 'record',
      record: this.errorRecord(),
      fields: [
        { op: 'lit', value: 'RunicUnsupportedError' },
        {
          op: 'lit',
          value: write
            ? 'an object used as a dictionary is given the key __proto__ (JavaScript sets its prototype)'
            : 'an object used as a dictionary is read with the name of an Object.prototype member',
        },
      ],
    };
    const body: Stmt[] = [{ op: 'if', test, then: [{ op: 'throw', value: error }] }];
    if (result !== 'void') body.push({ op: 'return', value: { op: 'undefined', type: result } });
    this.functions[index] = {
      name: write ? 'dictionary$writeGuard' : 'dictionary$readGuard',
      params: [{ name: 'key', type: STRING }],
      locals: [],
      result,
      body,
    };
    return index;
  }

  /**
   * An object literal used as a dictionary (TypeScript gives it a string
   * index signature only): a map, its entries set in order, keys evaluated
   * before values as JavaScript defines properties.
   */
  private dictionaryLiteral(
    e: ts.ObjectLiteralExpression,
    t: { map: [Type, Type] },
    b: FnBuilder,
  ): Expr {
    let out: Expr = { op: 'builtin', name: 'Map.new', args: [], type: t };
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p))
        return this.fail(p, 'E_OBJECT', 'Dictionary objects take key: value entries');
      let key: Expr;
      // A computed key defines an own property (`__proto__` and the other
      // prototype names included).
      if (ts.isComputedPropertyName(p.name)) key = this.coerce(p.name.expression, b, STRING);
      else if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) {
        if (p.name.text === '__proto__')
          return this.fail(p, 'E_OBJECT', '__proto__: sets the prototype of an object literal');
        key = { op: 'lit', value: p.name.text };
      } else return this.fail(p, 'E_OBJECT', 'Dictionary keys are names, strings or computed');
      const k = b.local('$key', STRING);
      out = {
        op: 'with',
        local: k,
        value: key,
        body: {
          op: 'builtin',
          name: 'map.set',
          args: [
            out,
            { op: 'local', local: k },
            this.fitValue(this.coerce(p.initializer, b, t.map[1]), t.map[1], b),
          ],
          type: t,
        },
      };
    }
    return out;
  }

  /**
   * A record read with a key computed at run time (`{ horizontal: …,
   * vertical: … }[orientation]`): its fields, of one type, chosen by
   * comparing the key with their names. A key TypeScript types as a union of
   * the field names selects among them (a value outside it, through an
   * unsound cast, throws a TypeError); another key may name none (then
   * undefined) or a member of Object.prototype (RunicUnsupportedError).
   */
  private dynamicField(e: ts.ElementAccessExpression, object: Expr, t: Type, b: FnBuilder): Expr {
    const r = this.types.records[(t as { record: number }).record];
    const types = new Set(r.fields.map(f => JSON.stringify(f.type)));
    if (types.size !== 1)
      return this.fail(e, 'E_MEMBER', 'A record read with a computed key needs fields of one type');
    const field = r.fields[0].type;
    const keyType = this.checker.getTypeAtLocation(e.argumentExpression);
    const literals = (keyType.isUnion() ? keyType.types : [keyType]).map(m =>
      m.isStringLiteral() ? m.value : undefined,
    );
    const names = r.fields.map(f => f.name);
    const exhaustive = literals.every(l => l !== undefined && names.includes(l));
    const result: Type = exhaustive || maybeInner(field) ? field : { maybe: field };
    const rec = b.local('$record', t);
    const k = b.local('$key', STRING);
    const fieldExpr = (i: number): Expr => {
      const v: Expr = { op: 'get', object: { op: 'local', local: rec }, field: i };
      return exhaustive || maybeInner(field) ? v : { op: 'some', value: v };
    };
    const candidates = exhaustive ? (literals as string[]) : names;
    let chain: Expr = exhaustive
      ? { op: 'unwrap', value: { op: 'undefined', type: { maybe: field } } }
      : {
          op: 'call',
          function: this.prototypeGuard(result),
          args: [{ op: 'local', local: k }],
        };
    for (const name of [...candidates].reverse())
      chain = {
        op: 'cond',
        test: {
          op: 'eq',
          left: { op: 'local', local: k },
          right: { op: 'lit', value: name },
        },
        then: fieldExpr(names.indexOf(name)),
        else: chain,
      };
    return {
      op: 'with',
      local: rec,
      value: object,
      body: {
        op: 'with',
        local: k,
        value: this.coerce(e.argumentExpression, b, STRING),
        body: chain,
      },
    };
  }

  /**
   * `Object.is(a, b)` (SameValue): `===` except that NaN is NaN and 0 is not
   * -0, for numbers; `===` for other values of one type.
   */
  private objectIs(e: ts.CallExpression, b: FnBuilder): Expr {
    let [x, y] = e.arguments.map(a => this.expr(a, b));
    let t = this.irType(x, b);
    const u = this.irType(y, b);
    // A nullable value and a value of its type (`Object.is(box.current, id)`).
    const tx = maybeInner(t);
    const uy = maybeInner(u);
    if (!sameType(t, u) && tx !== NUMBER && uy !== NUMBER) {
      if (tx !== undefined && sameType(tx, u)) y = { op: 'some', value: y };
      else if (uy !== undefined && sameType(uy, t)) {
        x = { op: 'some', value: x };
        t = u;
      }
    }
    if (!sameType(t, this.irType(y, b)))
      return this.fail(e, 'E_BUILTIN', 'Object.is compares values of one type');
    if (t !== NUMBER) return { op: 'eq', left: x, right: y };
    const l = b.local('$a', t);
    const r = b.local('$b', t);
    const a: Expr = { op: 'local', local: l };
    const c: Expr = { op: 'local', local: r };
    const zero: Expr = { op: 'lit', value: 0 };
    const one: Expr = { op: 'lit', value: 1 };
    return {
      op: 'with',
      local: l,
      value: x,
      body: {
        op: 'with',
        local: r,
        value: y,
        body: {
          op: 'or',
          left: {
            op: 'and',
            left: { op: 'eq', left: a, right: c },
            right: {
              op: 'or',
              left: { op: 'ne', left: a, right: zero },
              right: {
                op: 'eq',
                left: { op: 'div', left: one, right: a },
                right: { op: 'div', left: one, right: c },
              },
            },
          },
          right: {
            op: 'and',
            left: { op: 'ne', left: a, right: a },
            right: { op: 'ne', left: c, right: c },
          },
        },
      },
    };
  }

  /** The one value a prop takes at every site (its domain), if `e` reads such a prop. */
  private oneValue(e: ts.Expression): unknown {
    e = skipParens(e);
    if (!ts.isIdentifier(e) || !this.domains) return undefined;
    const sym = this.symbol(e);
    const binding = sym && this.bindingOf(sym);
    if (binding?.kind !== 'cell') return undefined;
    const values = this.domains.values(sym!);
    return values?.length === 1 ? values[0] : undefined;
  }

  /** The type a branch of a decided conditional takes: TypeScript's at `e`, or the branch's own. */
  private contextualOr(e: ts.Expression, branch: ts.Expression): Type {
    // Assigned to a variable or prop: its IR type (which a discriminant may
    // have narrowed from TypeScript's).
    let node: ts.Node = e;
    while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
    const p = node.parent;
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === node &&
      ts.isIdentifier(p.left)
    ) {
      const binding = this.binding(p.left);
      if (binding?.kind === 'cell') {
        const t = this.hooks.cellType(binding.cell);
        return maybeInner(t) ?? t;
      }
      if (binding?.kind === 'local') return binding.owner.typeOf(binding.local);
    }
    const contextual = this.checker.getContextualType(e);
    const mapped = contextual && this.types.tryMap(contextual, e);
    return (
      mapped ?? this.types.tryMap(this.checker.getTypeAtLocation(e), e) ?? this.types.of(branch)
    );
  }

  /**
   * `$state.snapshot(v)`: primitives as they are, plain arrays and objects
   * (and nullable ones) copied deeply without proxies, as `structuredClone`
   * copies them; class instances are rejected there.
   */
  private stateSnapshot(e: ts.CallExpression, b: FnBuilder): Expr {
    if (e.arguments.length !== 1)
      return this.fail(e, 'E_RUNE', '$state.snapshot takes one argument');
    const v = this.expr(e.arguments[0], b);
    const t = this.irType(v, b);
    const inner = maybeInner(t) ?? t;
    if (typeof inner === 'string') return v;
    const clone = (x: Expr): Expr => this.builtinCall('structuredClone', [x], b, inner, e);
    if (inner === t) return clone(v);
    const local = b.local('$snapshot', inner);
    return {
      op: 'optional',
      value: v,
      local,
      then: { op: 'some', value: clone({ op: 'local', local }) },
    };
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
  hoistedLets(b: FnBuilder): Stmt[] {
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

  /**
   * A closure of no parameters returning `e` (lowered in a function of its
   * own, capturing what it reads from `ctx`), of `e`'s own type where
   * `result` is undefined. `read` lowers the value instead of `e` (a
   * shorthand property's binding).
   */
  expressionClosure(
    e: ts.Expression,
    ctx: FnBuilder,
    name: string,
    result: Type | undefined,
    read?: (b: FnBuilder) => Expr,
  ): Expr {
    const b = new FnBuilder(`${ctx.name}.${name}`, ctx, ctx.component, new Set(ctx.boxed), false);
    let value: Expr;
    if (read) {
      value = read(b);
      const vt = this.irType(value, b);
      if (result === undefined) result = vt;
      else if (maybeInner(result) && !maybeInner(vt)) value = { op: 'some', value };
      b.result = result;
    } else if (result === undefined) {
      value = this.expr(e, b);
      result = this.irType(value, b);
      b.result = result;
    } else {
      b.result = result;
      this.expected.set(skipParens(e), result);
      value = this.coerce(e, b, result);
    }
    const index = this.reserve();
    const body: Stmt[] = [...this.hoistedLets(b), { op: 'return', value }];
    this.functions[index] = {
      name: b.name,
      ...(ctx.component !== undefined ? { component: ctx.component } : {}),
      ...(b.captures.length ? { captures: b.captures } : {}),
      params: [],
      locals: b.locals,
      result,
      body: remapLocals(body, i => b.final(i)),
    };
    return { op: 'closure', function: index, captures: b.captureSources.map(c => c.local) };
  }

  /** A closure expression for an inline function. */
  closure(
    decl: ts.FunctionLikeDeclaration,
    ctx: FnBuilder,
    name = 'closure',
    paramTypes?: Type[],
    result?: Type,
  ): Expr {
    const { index, builder } = this.function(
      decl,
      `${ctx.name}.${name}`,
      ctx,
      ctx.component,
      undefined,
      paramTypes,
      result !== undefined ? { result } : undefined,
    );
    return { op: 'closure', function: index, captures: builder.captureSources.map(c => c.local) };
  }

  // -------------------------------------------------------------------------
  // Statements

  block(statements: readonly ts.Statement[], b: FnBuilder): Stmt[] {
    const out: Stmt[] = [];
    // Function declarations exist from the block's start (hoisted). One
    // that statements before it use (or that such a function uses) is
    // created there, after binding them all; the others where they stand
    // (they capture the variables declared before them).
    const fns = statements.filter(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.body && !!s.name,
    );
    const symbols = new Map(fns.map(f => [this.checker.getSymbolAtLocation(f.name!)!, f]));
    const early = new Set<ts.FunctionDeclaration>();
    const uses = (n: ts.Node, found: (f: ts.FunctionDeclaration) => void) => {
      const visit = (x: ts.Node) => {
        if (ts.isIdentifier(x)) {
          const f = symbols.get(this.checker.getSymbolAtLocation(x)!);
          if (f && f.name !== x) found(f);
        }
        ts.forEachChild(x, visit);
      };
      visit(n);
    };
    const hoist = (f: ts.FunctionDeclaration) => {
      if (early.has(f)) return;
      early.add(f);
      uses(f, hoist);
    };
    for (const s of statements) {
      if (ts.isFunctionDeclaration(s)) continue;
      uses(s, f => {
        if (s.pos < f.pos) hoist(f);
      });
    }
    const declared = new Map(fns.map(f => [f, this.declareFunction(f, b)]));
    for (const d of declared.values()) out.push(...d.lets);
    for (const f of fns) if (early.has(f)) out.push(...declared.get(f)!.create());
    for (const [i, s] of statements.entries()) {
      if (ts.isFunctionDeclaration(s) && declared.has(s)) {
        if (!early.has(s)) out.push(...declared.get(s)!.create());
        continue;
      }
      out.push(...this.statement(s, b));
      // `if (x === undefined) return …;`: the rest of the block knows `x`.
      if (ts.isIfStatement(s) && !s.elseStatement && exits(s.thenStatement)) {
        const facts = this.presentIn(s.expression, true);
        if (facts.length)
          return [...out, ...this.withPresent(facts, () => this.block(statements.slice(i + 1), b))];
      }
      // `if (!x) x = new C(…);` of an untyped variable the rest of the block
      // does not assign (bits-ui's `if (!scope) scope = new FocusScope(opts)`):
      // the rest knows `x`.
      const created = ts.isIfStatement(s) && !s.elseStatement ? this.createdIn(s) : undefined;
      if (created && !statements.slice(i + 1).some(r => this.assigned(created, r)))
        return [
          ...out,
          ...this.withPresent([created], () => this.block(statements.slice(i + 1), b)),
        ];
    }
    return out;
  }

  /**
   * A nested function declaration: its local, bound now; `lets` declare it
   * where closures created before it refer to it (boxed:
   * `analyseCaptures`), `create` lowers its creation.
   */
  private declareFunction(
    s: ts.FunctionDeclaration,
    b: FnBuilder,
  ): { lets: Stmt[]; create: () => Stmt[] } {
    const name = s.name?.text ?? 'fn';
    const sym = s.name ? this.checker.getSymbolAtLocation(s.name) : undefined;
    // Untyped JavaScript whose result no call reads (bits-ui's
    // `trackWhileMountedDeps()`, called for the reads it makes): a
    // function of no result.
    const discarded =
      sym && this.types.typeOrUndefined(s.name ?? s) === undefined && this.resultDiscarded(sym, s);
    const params = discarded ? s.parameters.map(p => this.types.of(p)) : undefined;
    const boxed = !!sym && b.boxed.has(sym);
    const local = b.local(
      name,
      params ? { fn: { params, result: 'void' } } : this.types.of(s.name ?? s),
      boxed,
    );
    if (sym) this.bindings.set(sym, { kind: 'local', owner: b, local });
    const create = () =>
      params ? this.closure(s, b, name, params, 'void') : this.closure(s, b, name);
    if (!boxed) return { lets: [], create: () => [{ op: 'let', local, value: create() }] };
    return {
      lets: [{ op: 'let', local }],
      create: () => [{ op: 'assign', target: { place: 'local', local }, value: create() }],
    };
  }

  private src(node: ts.Node) {
    const s = this.sourceOf(node);
    return s ? { source: s } : {};
  }

  statement(s: ts.Statement, b: FnBuilder, origin: ts.Node = s): Stmt[] {
    const K = ts.SyntaxKind;
    // (A property its function's declaration created: `expando`.)
    if (this.expandoAssignments.has(s)) return [];
    if (ts.isBlock(s)) return this.block(s.statements, b);
    if (ts.isEmptyStatement(s)) return [];
    if (ts.isVariableStatement(s)) {
      const out: Stmt[] = [];
      for (const d of s.declarationList.declarations) out.push(...this.declaration(d, b));
      return out;
    }
    if (ts.isExpressionStatement(s)) return this.expressionStatement(s.expression, b, origin);
    if (ts.isIfStatement(s)) {
      // A test the IR types decide (untyped JavaScript specialised per call
      // site: `Array.isArray(a)` of a string) leaves one branch, which is all
      // JavaScript would run; the other may not be typable for these types.
      const effects: ts.Expression[] = [];
      const known = this.staticTruth(s.expression, b, effects);
      const first = (): Stmt[] => effects.map(x => ({ op: 'expr', value: this.expr(x, b) }));
      if (known === true) return [...first(), ...this.statement(s.thenStatement, b)];
      if (known === false)
        return [...first(), ...(s.elseStatement ? this.statement(s.elseStatement, b) : [])];
      return [
        {
          op: 'if',
          test: this.condition(s.expression, b),
          then: this.withPresent(this.presentIn(s.expression, false, s.thenStatement), () =>
            this.statement(s.thenStatement, b),
          ),
          ...(s.elseStatement
            ? {
                else: this.withPresent(this.presentIn(s.expression, true, s.elseStatement), () =>
                  this.statement(s.elseStatement!, b),
                ),
              }
            : {}),
          ...this.src(s),
        },
      ];
    }
    if (ts.isReturnStatement(s) && b.asyncReturn) return b.asyncReturn(s.expression, s);
    if (ts.isReturnStatement(s)) {
      // A returned array literal no caller reads (`resultDiscarded`): its
      // elements, evaluated in order.
      const returned = s.expression && skipParens(s.expression);
      if (b.result === 'void' && returned && ts.isArrayLiteralExpression(returned))
        return [
          ...returned.elements.flatMap(x =>
            this.expressionStatement(ts.isSpreadElement(x) ? x.expression : x, b, s),
          ),
          { op: 'return', ...this.src(s) },
        ];
      if (s.expression && b.result !== undefined && b.result !== 'void')
        this.expected.set(skipParens(s.expression), b.result);
      // `return []` of a function whose result is inferred (untyped
      // JavaScript): an empty array of the type the other returns give
      // (`unifyReturns`).
      if (
        b.result === undefined &&
        returned &&
        ts.isArrayLiteralExpression(returned) &&
        !returned.elements.length
      )
        return [
          {
            op: 'return',
            value: { op: 'array', type: { array: 'void' }, items: [] },
            ...this.src(s),
          },
        ];
      let value = s.expression && this.expr(s.expression, b);
      if (value && b.result === 'void' && this.irType(value, b) !== 'void')
        return [
          { op: 'expr', value },
          { op: 'return', ...this.src(s) },
        ];
      // `T | undefined` results: a returned T is wrapped, a literal `null`
      // or `undefined` takes the result type.
      const inner = b.result && maybeInner(b.result);
      if (value && inner && (value.op === 'null' || value.op === 'undefined'))
        value = { op: value.op, type: b.result! };
      else if (value && inner && sameType(this.irType(value, b), inner))
        value = { op: 'some', value };
      // A nullable value where the declared result is present (untyped
      // package JavaScript whose declarations say so: bits-ui's SharedState
      // `get(): ReturnType<T>` returning `this.#state`): a TypeError if the
      // program broke its types (JavaScript would return undefined).
      else if (
        value &&
        b.result &&
        !inner &&
        maybeInner(this.irType(value, b)) !== undefined &&
        sameType(maybeInner(this.irType(value, b))!, b.result)
      )
        value = { op: 'unwrap', value };
      // A class instance returned as a class reference.
      else if (value && b.result)
        value = this.classes.fitAt(value, this.irType(value, b), b.result, s);
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
      let iterable = this.collectionIteration(s.expression, b) ?? this.expr(s.expression, b);
      let iterType = this.irType(iterable, b);
      // A map (M6 overlays: bits-ui's `for (const [_, value] of map)`): its
      // entries, tuple records, taken when the loop starts as for sets.
      if (typeof iterType === 'object' && 'map' in iterType) {
        const entry = this.types.tupleRecord([iterType.map[0], iterType.map[1]]);
        iterType = { array: { record: entry } };
        iterable = { op: 'builtin', name: 'map.entries', args: [iterable], type: iterType };
      }
      // A SvelteMap: its entries, read as Svelte reads them (all of them).
      const reactiveEntries = svelteMapEntries(this, iterType, iterable);
      if (reactiveEntries) {
        iterable = reactiveEntries;
        iterType = this.irType(iterable, b);
      }
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
    // for-in over a dictionary object (bits-ui's `for (const eventType in
    // this.#interceptedEvents)`): its keys in own-key order, each skipped
    // if deleted before it is reached (keys added meanwhile are not visited).
    if (ts.isForInStatement(s)) {
      const object = this.expr(s.expression, b);
      const t = this.irType(object, b);
      const init = s.initializer;
      if (!(typeof t === 'object' && 'map' in t && t.map[0] === STRING))
        return this.fail(
          s.expression,
          'E_STATEMENT',
          'for-in is supported over dictionary objects',
        );
      if (
        !ts.isVariableDeclarationList(init) ||
        init.declarations.length !== 1 ||
        !ts.isIdentifier(init.declarations[0].name)
      )
        return this.fail(s, 'E_STATEMENT', 'for-in requires a single declared loop variable');
      const name = init.declarations[0].name as ts.Identifier;
      const sym = this.checker.getSymbolAtLocation(name)!;
      const dict = b.local('$dictionary', t);
      const local = b.local(name.text, STRING, b.boxed.has(sym));
      this.bindings.set(sym, { kind: 'local', owner: b, local });
      return [
        { op: 'let', local: dict, value: object },
        ...this.loop(s, b, label => [
          {
            op: 'for-of',
            local,
            iterable: {
              op: 'builtin',
              name: 'map.dictionary-keys',
              args: [{ op: 'local', local: dict }],
              type: { array: STRING },
            },
            body: [
              {
                op: 'if',
                test: {
                  op: 'not',
                  arg: {
                    op: 'builtin',
                    name: 'map.has',
                    args: [
                      { op: 'local', local: dict },
                      { op: 'local', local },
                    ],
                    type: BOOLEAN,
                  },
                },
                then: [{ op: 'continue', label }],
              },
              ...this.statement(s.statement, b),
            ],
            label,
            ...this.src(s),
          },
        ]),
      ];
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
      const f = this.declareFunction(s, b);
      return [...f.lets, ...f.create()];
    }
    if (s.kind === K.TypeAliasDeclaration || s.kind === K.InterfaceDeclaration) return [];
    if (ts.isClassDeclaration(s))
      return this.fail(
        s,
        'E_CLASS',
        'Classes are declared at the top level of a module or component script',
      );
    return this.fail(s, 'E_STATEMENT', `Unsupported statement: ${K[s.kind]}`);
  }

  /**
   * Whether TypeScript has `e` as present: a type without null or undefined
   * (narrowed by a test, such as an iterator result's `value` after its
   * `done`), or untyped (`any`). Where the IR has it nullable, a member
   * access through it unwraps: through nullish it throws a TypeError, as in
   * JavaScript.
   */
  tsPresent(e: ts.Expression): boolean {
    const t = this.checker.getTypeAtLocation(e);
    if (t.flags & ts.TypeFlags.Any) return true;
    return !(t.isUnion() ? t.types : [t]).some(
      p => p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void),
    );
  }

  private onceRecords = new Map<string, number>();

  /**
   * `target.addEventListener(type, f, { once: true })`: a wrapper is
   * registered that removes itself before calling `f`, as the listener is
   * removed before it runs. A registration function builds the wrapper
   * (holding itself through a record, to remove the same value).
   */
  private onceListener(host: string, type: string, f: Expr, b: FnBuilder): Expr {
    const ft = this.irType(f, b);
    if (typeof ft !== 'object' || !('fn' in ft) || ft.fn.params.length > 1)
      return this.fail(undefined as never, 'E_EVENT', 'A once listener takes the event or nothing');
    const wrapperType: Type = { fn: { params: ['event'], result: 'void' } };
    const key = JSON.stringify(wrapperType);
    let record = this.onceRecords.get(key);
    if (record === undefined) {
      record = this.types.records.length;
      this.types.records.push({
        name: 'OnceListener',
        fields: [{ name: 'fn', type: { maybe: wrapperType } }],
      });
      this.onceRecords.set(key, record);
    }
    const local = (i: number): Expr => ({ op: 'local', local: i });
    // The wrapper: captures f (0) and the holder (1); the event (2).
    const wrapper = this.reserve();
    this.functions[wrapper] = {
      name: `${host}.once${type}`,
      captures: [
        { name: 'f', type: ft },
        { name: 'holder', type: { record } },
      ],
      params: [{ name: 'event', type: 'event' }],
      locals: [],
      result: 'void',
      body: [
        {
          op: 'expr',
          value: {
            op: 'builtin',
            name: `${host}.unlisten`,
            args: [
              { op: 'lit', value: type },
              { op: 'unwrap', value: { op: 'get', object: local(1), field: 0 } },
            ],
            type: 'void',
          },
        },
        {
          op: 'expr',
          value: {
            op: 'call-value',
            callee: local(0),
            args: ft.fn.params.length ? [local(2)] : [],
          },
        },
      ],
    };
    // The registration: f (0); the holder (1) and the wrapper (2).
    const register = this.reserve();
    this.functions[register] = {
      name: `${host}.listen-once${type}`,
      params: [{ name: 'f', type: ft }],
      locals: [
        { name: 'holder', type: { record } },
        { name: 'wrapper', type: wrapperType },
      ],
      result: 'void',
      body: [
        {
          op: 'let',
          local: 1,
          value: {
            op: 'record',
            record,
            fields: [{ op: 'undefined', type: { maybe: wrapperType } }],
          },
        },
        { op: 'let', local: 2, value: { op: 'closure', function: wrapper, captures: [0, 1] } },
        {
          op: 'assign',
          target: { place: 'field', object: local(1), field: 0 },
          value: { op: 'some', value: local(2) },
        },
        {
          op: 'expr',
          value: {
            op: 'builtin',
            name: `${host}.listen`,
            args: [{ op: 'lit', value: type }, local(2)],
            type: 'void',
          },
        },
      ],
    };
    return { op: 'call', function: register, args: [f] };
  }

  /**
   * `m.values()`, `m.keys()` or `m.entries()` of a map or set iterated by
   * for-of (bits-ui's `for (const record of registry.triggers.values())`):
   * the items, taken when the loop starts, as for-of over the collection.
   */
  private collectionIteration(e: ts.Expression, b: FnBuilder): Expr | undefined {
    const call = skipParens(e);
    if (
      !ts.isCallExpression(call) ||
      call.arguments.length ||
      !ts.isPropertyAccessExpression(call.expression) ||
      !['values', 'keys', 'entries'].includes(call.expression.name.text)
    )
      return undefined;
    const method = call.expression.name.text;
    const collection = this.expr(call.expression.expression, b);
    const t = this.irType(collection, b);
    if (typeof t !== 'object' || !('map' in t || 'set' in t)) return undefined;
    if ('set' in t) {
      if (method === 'entries') return undefined;
      return { op: 'builtin', name: `set.${method}`, args: [collection], type: { array: t.set } };
    }
    if (method === 'entries')
      return {
        op: 'builtin',
        name: 'map.entries',
        args: [collection],
        type: { array: { record: this.types.tupleRecord([t.map[0], t.map[1]]) } },
      };
    return {
      op: 'builtin',
      name: `map.${method}`,
      args: [collection],
      type: { array: method === 'keys' ? t.map[0] : t.map[1] },
    };
  }

  /** Whether `n` is in a JavaScript file (untyped package code). */
  private isUntypedSource(n: ts.Node): boolean {
    return /\.[cm]?js$/.test(n.getSourceFile().fileName);
  }

  private iteratorResults = new Map<string, number>();

  /**
   * `m.entries().next()` (also `keys` and `values`) of a map or set (bits-ui's
   * tooltip registry's first trigger): a fresh iterator's first result,
   * `{ done, value }`, its value undefined when the collection is empty.
   * Reading through the value after `done` throws as JavaScript does.
   * Other uses of iterators are not supported.
   */
  private firstIteration(e: ts.CallExpression, b: FnBuilder): Expr | undefined {
    const next = skipParens(e.expression);
    if (!ts.isPropertyAccessExpression(next) || next.name.text !== 'next' || e.arguments.length)
      return undefined;
    const inner = skipParens(next.expression);
    if (
      !ts.isCallExpression(inner) ||
      inner.arguments.length ||
      !ts.isPropertyAccessExpression(inner.expression) ||
      !['entries', 'keys', 'values'].includes(inner.expression.name.text)
    )
      return undefined;
    const method = inner.expression.name.text;
    const collection = this.expr(inner.expression.expression, b);
    const ct = this.irType(collection, b);
    if (typeof ct !== 'object' || !('map' in ct || 'set' in ct)) return undefined;
    const [k, v] = 'map' in ct ? ct.map : [ct.set, ct.set];
    const family = 'map' in ct ? 'map' : 'set';
    let items: Expr;
    let item: Type;
    if (method === 'entries') {
      item = { record: this.types.tupleRecord([k, v]) };
      items =
        family === 'map'
          ? { op: 'builtin', name: 'map.entries', args: [collection], type: { array: item } }
          : this.fail(e, 'E_BUILTIN', 'set.entries() is not supported');
    } else {
      item = method === 'keys' ? k : v;
      items = {
        op: 'builtin',
        name: `${family}.${method}`,
        args: [collection],
        type: { array: item },
      };
    }
    const key = JSON.stringify(item);
    // (Typed code: the record TypeScript's `IteratorResult` maps to.)
    const tsType = this.checker.getTypeAtLocation(e);
    const mapped = tsType.flags & ts.TypeFlags.Any ? undefined : this.types.tryMap(tsType, e);
    let record: number | undefined =
      typeof mapped === 'object' && 'record' in mapped
        ? mapped.record
        : this.iteratorResults.get(key);
    if (record === undefined) {
      record = this.types.records.length;
      this.types.records.push({
        name: 'IteratorResult',
        fields: [
          { name: 'done', type: BOOLEAN },
          { name: 'value', type: { maybe: item } },
        ],
      });
      this.iteratorResults.set(key, record);
    }
    const tmp = b.local('$items', { array: item });
    const list: Expr = { op: 'local', local: tmp };
    const done: Expr = {
      op: 'eq',
      left: { op: 'builtin', name: 'array.length', args: [list], type: NUMBER },
      right: { op: 'lit', value: 0 },
    };
    const fields = this.types.records[record].fields;
    const valueType = fields.find(x => x.name === 'value')?.type;
    const doneType = fields.find(x => x.name === 'done')?.type;
    if (
      fields.length !== 2 ||
      JSON.stringify(valueType) !== JSON.stringify({ maybe: item }) ||
      (doneType !== BOOLEAN && JSON.stringify(doneType) !== JSON.stringify({ maybe: BOOLEAN }))
    )
      return this.fail(
        e,
        'E_TYPE_UNSUPPORTED',
        'An iterator result is { done, value } of the items',
      );
    const value: Expr = {
      op: 'cond',
      test: done,
      then: { op: 'undefined', type: { maybe: item } },
      else: { op: 'some', value: { op: 'index', array: list, index: { op: 'lit', value: 0 } } },
    };
    const doneValue: Expr = doneType === BOOLEAN ? done : { op: 'some', value: done };
    return {
      op: 'with',
      local: tmp,
      value: items,
      body: {
        op: 'record',
        record,
        fields: fields.map(x => (x.name === 'done' ? doneValue : value)),
      },
    };
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
    // (The discriminant's IR type: a nullable value TypeScript types as
    // present compares as nullable, `===` of each case.)
    const discValue = this.expr(s.expression, b);
    const discType = this.irType(discValue, b);
    const disc = b.local('$switch', discType);
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
              right: (() => {
                const v = this.expr(c.expression, b);
                return this.equality(
                  { op: 'local', local: disc },
                  discType,
                  v,
                  this.irType(v, b),
                  true,
                  c,
                );
              })(),
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
        { op: 'let', local: disc, value: discValue },
        { op: 'let', local: matched, value: { op: 'lit', value: false } },
        { op: 'while', test: { op: 'lit', value: true }, body, label },
      ];
    } finally {
      b.loops.pop();
    }
  }

  private declaration(d: ts.VariableDeclaration, b: FnBuilder): Stmt[] {
    // Intl and pack constants have no runtime value (their uses are lowered).
    if (this.isIntlConstant(d) || this.isPackConstant(d)) return [];
    // A constant naming the document or the window (bits-ui's `const
    // documentObj = document`): its uses are that object (`hostName`).
    if (
      d.initializer &&
      ts.isIdentifier(d.name) &&
      ts.isVariableDeclarationList(d.parent) &&
      d.parent.flags & ts.NodeFlags.Const &&
      ['document', 'window'].includes(this.hostName(d.initializer, 0, true) ?? '')
    ) {
      // (A call naming it, `getDocument(node)`: its argument is evaluated.)
      const init = skipParens(d.initializer);
      if (ts.isCallExpression(init) && init.arguments.length === 1)
        return [{ op: 'expr', value: this.expr(init.arguments[0], b) }];
      return [];
    }
    const rune = this.hooks.localRune?.(d, b, this);
    if (rune) return rune;
    // `const id = ++counter` (and `counter++`, `--`, of a variable): the
    // increment as a statement, before (prefix) or after (postfix) the
    // declaration of the variable's value.
    const init = d.initializer && skipParens(d.initializer);
    if (
      init &&
      (ts.isPrefixUnaryExpression(init) || ts.isPostfixUnaryExpression(init)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(init.operator) &&
      ts.isIdentifier(init.operand)
    ) {
      const step = this.expressionStatement(init, b, d);
      const whole = d.initializer;
      // (The declaration of the operand's value: the node is the operand's.)
      (d as { initializer?: ts.Expression }).initializer = init.operand;
      try {
        const decl = this.declaration(d, b);
        return ts.isPrefixUnaryExpression(init) ? [...step, ...decl] : [...decl, ...step];
      } finally {
        (d as { initializer?: ts.Expression }).initializer = whole;
      }
    }
    // Another name of the window or the document (`hostName`): its uses are the host's.
    if (
      d.initializer &&
      d.parent.flags & ts.NodeFlags.Const &&
      !ts.isIdentifier(skipParens(d.initializer)) &&
      this.hostName(d.initializer)
    )
      return [];
    if (ts.isIdentifier(d.name)) {
      const sym = this.checker.getSymbolAtLocation(d.name)!;
      if (d.initializer && !d.type && this.isRegexpResult(d.initializer)) {
        // Captures that may not participate are `string | undefined`.
        const value = this.expr(d.initializer, b);
        const local = b.local(d.name.text, this.irType(value, b), b.boxed.has(sym));
        this.bindings.set(sym, { kind: 'local', owner: b, local });
        return [{ op: 'let', local, value, ...this.src(d) }];
      }
      const curried = this.curried(d, b);
      if (curried) return curried;
      const expando = this.expando(d, sym, b);
      if (expando) return expando;
      // A type that only TypeScript's `any` makes unmappable (untyped
      // JavaScript: `ReadableBox<any>`) is untyped too.
      const declared = this.types.typeOrUndefined(d.name);
      if (declared === undefined) {
        // TypeScript only knows `any`: the initialiser's IR type decides.
        // Without one (untyped JavaScript, `let timer;`): the one type of the
        // values assigned to it in its scope, undefined until then.
        if (!d.initializer) {
          const assigned = this.assignedType(d, sym);
          if (assigned) {
            const t: Type = maybeInner(assigned) ? assigned : { maybe: assigned };
            const local = b.local(d.name.text, t, b.boxed.has(sym));
            this.bindings.set(sym, { kind: 'local', owner: b, local });
            return [{ op: 'let', local, value: { op: 'undefined', type: t }, ...this.src(d) }];
          }
          this.fail(
            d,
            'E_TYPE_UNSUPPORTED',
            `${d.name.text} needs a type annotation or an initialiser`,
          );
        }
        // `let x = null` (or undefined) assigned later (bits-ui's FocusScope
        // `let scope = null; … scope = new FocusScope(opts)`): nullable of
        // the type of the values assigned.
        const first = skipParens(d.initializer!);
        if (
          !(d.parent.flags & ts.NodeFlags.Const) &&
          (first.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(first) && first.text === 'undefined' && !this.binding(first)))
        ) {
          const assigned = this.assignedType(d, sym);
          if (assigned) {
            const t: Type = maybeInner(assigned) ? assigned : { maybe: assigned };
            const local = b.local(d.name.text, t, b.boxed.has(sym));
            this.bindings.set(sym, { kind: 'local', owner: b, local });
            return [
              {
                op: 'let',
                local,
                value: {
                  op: first.kind === ts.SyntaxKind.NullKeyword ? 'null' : 'undefined',
                  type: t,
                },
                ...this.src(d),
              },
            ];
          }
        }
        // A value TypeScript types too narrowly to be useful (`simpleBox(null)`)
        // where its uses say what it holds (a property of a returned object
        // of a declared type): that type.
        const flow = this.flowType(d, sym);
        if (flow !== undefined) this.expected.set(skipParens(d.initializer!), flow);
        const value = this.expr(d.initializer!, b);
        const local = b.local(d.name.text, this.irType(value, b), b.boxed.has(sym));
        this.bindings.set(sym, { kind: 'local', owner: b, local });
        return [{ op: 'let', local, value, ...this.src(d) }];
      }
      let type = declared;
      // A `let` of untyped package JavaScript that is assigned values
      // TypeScript cannot type (bits-ui's transformOrigin: `let x = "";` then
      // `x = hidden ? dictionary[key] : …`, undefined for another key): its
      // values may be undefined too, which its reads keep.
      if (
        !(d.parent.flags & ts.NodeFlags.Const) &&
        !d.type &&
        d.initializer &&
        /\.js\.__runic\.ts$/.test(d.getSourceFile().fileName) &&
        (type === STRING || type === NUMBER || type === BOOLEAN) &&
        this.untypedAssignments(d, sym)
      ) {
        type = { maybe: type };
        this.widened.add(sym);
      }
      // A read of a dictionary object (bits-ui's `let itemIndex =
      // keyToIndex[e.key]`, then `if (itemIndex === undefined) return`):
      // undefined for keys it lacks, whatever TypeScript's index signature
      // says; reads TypeScript narrows unwrap it.
      if (
        !d.type &&
        d.initializer &&
        ts.isElementAccessExpression(skipParens(d.initializer)) &&
        !maybeInner(type) &&
        this.checker
          .getIndexInfosOfType(
            this.checker.getTypeAtLocation(
              (skipParens(d.initializer) as ts.ElementAccessExpression).expression,
            ),
          )
          .some(i => i.keyType.flags & ts.TypeFlags.String)
      )
        type = { maybe: type };
      const fn =
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
      // A call TypeScript cannot type (untyped JavaScript) initialising an
      // annotated variable returns the variable's type.
      const call = d.initializer && skipParens(d.initializer);
      if (d.type && call && ts.isCallExpression(call) && !this.expected.has(call))
        this.expected.set(call, type);
      // An unannotated variable whose initialiser may be undefined where
      // TypeScript does not say so (a dictionary object's entry,
      // `keyToIndex[e.key]`): the nullable type.
      // (Not for a variable its initialiser refers to: that needs the binding.)
      const early =
        !fn && d.initializer && !d.type && !this.selfCaptured.has(sym)
          ? this.expr(d.initializer, b)
          : undefined;
      const earlyType = early && this.irType(early, b);
      if (earlyType && !maybeInner(type) && sameType(maybeInner(earlyType) ?? 'void', type))
        type = earlyType;
      const local = b.local(d.name.text, type, b.boxed.has(sym));
      this.bindings.set(sym, { kind: 'local', owner: b, local });
      if (fn) {
        const value = this.closure(d.initializer!, b, d.name.text);
        // A function calling itself through the variable shares its binding.
        if (this.selfCaptured.has(sym))
          return [
            { op: 'let', local },
            { op: 'assign', target: { place: 'local', local }, value },
          ];
        return [{ op: 'let', local, value }];
      }
      const init = early ?? (d.initializer && this.expr(d.initializer, b));
      if (init && this.selfCaptured.has(sym))
        return [
          { op: 'let', local, ...this.src(d) },
          {
            op: 'assign',
            target: { place: 'local', local },
            value: this.classes.fitAt(init, this.irType(init, b), type, d),
            ...this.src(d),
          },
        ];
      return [
        {
          op: 'let',
          local,
          // A class instance initialises a class reference.
          ...(init ? { value: this.classes.fitAt(init, this.irType(init, b), type, d) } : {}),
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

  /** Statements assigning properties of functions, which their declarations create (`expando`). */
  private readonly expandoAssignments = new Set<ts.Node>();

  /**
   * A constant function whose properties the statements right after its
   * declaration assign function literals (bits-ui's debounce:
   * `const debounced = (...args) => {…}; debounced.destroy = () => {…};
   * return debounced;`): a record of the function and the properties
   * (frontend/types.ts), created with them at the declaration (creating a
   * function literal earlier is unobservable: nothing runs, and nothing is
   * declared in between). Its type is the variable's, or, where untyped
   * JavaScript leaves that unknown, the result of the function returning it
   * next. Other property assignments to functions are rejected.
   */
  private expando(d: ts.VariableDeclaration, sym: ts.Symbol, b: FnBuilder): Stmt[] | undefined {
    const init = d.initializer && skipParens(d.initializer);
    if (!init || !ts.isIdentifier(d.name)) return undefined;
    if (!(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return undefined;
    const list = d.parent;
    let scope: ts.Node = list;
    while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    const assigns: ts.BinaryExpression[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) &&
        ts.isIdentifier(n.left.expression) &&
        this.checker.getSymbolAtLocation(n.left.expression) === sym
      )
        assigns.push(n);
      ts.forEachChild(n, visit);
    };
    visit(scope);
    if (!assigns.length) return undefined;
    const reject = (at: ts.Node): never =>
      this.fail(
        at,
        'E_FUNCTION_PROPERTY',
        'Properties of a function are function literals assigned in the statements right after the declaration of a const holding it',
      );
    const stmt = list.parent;
    if (
      !(list.flags & ts.NodeFlags.Const) ||
      !ts.isVariableStatement(stmt) ||
      (list as ts.VariableDeclarationList).declarations.length !== 1 ||
      this.selfCaptured.has(sym)
    )
      return reject(d);
    const statements = (stmt.parent as ts.Block | ts.SourceFile).statements;
    const at = statements.indexOf(stmt);
    const props = new Map<string, ts.FunctionLikeDeclaration>();
    assigns.forEach((a, k) => {
      const s = statements[at + 1 + k];
      const value = skipParens(a.right);
      if (
        !s ||
        !ts.isExpressionStatement(s) ||
        skipParens(s.expression) !== a ||
        !ts.isPropertyAccessExpression(a.left) ||
        !(ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ||
        props.has(a.left.name.text)
      )
        return reject(a);
      props.set(a.left.name.text, value);
    });
    let type = this.types.typeOrUndefined(d.name);
    if (type === undefined) {
      const next = statements[at + 1 + assigns.length];
      const returned =
        next &&
        ts.isReturnStatement(next) &&
        next.expression &&
        ts.isIdentifier(skipParens(next.expression)) &&
        this.checker.getSymbolAtLocation(skipParens(next.expression)) === sym;
      if (returned) type = b.result;
    }
    if (type === undefined)
      return this.fail(d, 'E_TYPE_UNSUPPORTED', `${d.name.text} needs a type annotation`);
    const record = typeof type === 'object' && 'record' in type ? type.record : undefined;
    const fields = record !== undefined ? this.types.records[record].fields : [];
    if (
      record === undefined ||
      !this.types.isCallable(record) ||
      fields.length !== props.size + 1 ||
      !fields.slice(1).every(f => props.has(f.name))
    )
      return this.fail(
        d,
        'E_TYPE_UNSUPPORTED',
        `${d.name.text} is used as a function with other properties than it is assigned`,
      );
    const values = fields.map((f, i) => {
      const fn = i === 0 ? init : props.get(f.name)!;
      this.expected.set(fn, f.type);
      const want = this.expectedFunction(fn);
      const value = this.closure(
        fn,
        b,
        `${(d.name as ts.Identifier).text}${i === 0 ? '' : '.' + f.name}`,
        want?.params,
        want?.result,
      );
      return this.classes.fitAt(value, this.irType(value, b), f.type, fn);
    });
    for (const a of assigns) this.expandoAssignments.add(a.parent);
    const local = b.local(d.name.text, type, b.boxed.has(sym));
    this.bindings.set(sym, { kind: 'local', owner: b, local });
    return [
      {
        op: 'let',
        local,
        value: { op: 'record', record: record!, fields: values },
        ...this.src(d),
      },
    ];
  }

  /**
   * `delete dict[k]` or `delete dict.k` of a dictionary object: its entry
   * removed (true, as `delete` of an own or absent property gives).
   */
  private deleteEntry(e: ts.DeleteExpression, b: FnBuilder): Expr {
    const target = skipParens(e.expression);
    if (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target)) {
      const object = this.expr(target.expression, b);
      const t = this.irType(object, b);
      if (typeof t === 'object' && 'map' in t && t.map[0] === STRING) {
        const key: Expr = ts.isElementAccessExpression(target)
          ? this.coerce(target.argumentExpression, b, STRING)
          : { op: 'lit', value: target.name.text };
        return {
          op: 'with',
          local: b.local('$deleted', BOOLEAN),
          value: { op: 'builtin', name: 'map.delete', args: [object, key], type: BOOLEAN },
          body: { op: 'lit', value: true },
        };
      }
    }
    return this.fail(e, 'E_EXPRESSION', 'delete is supported for entries of dictionary objects');
  }

  /**
   * Whether evaluating `e` has no effect and cannot throw: reads, literals,
   * arithmetic, objects and closures created, attribute bag and string
   * built-ins, and calls of functions whose bodies are such (no writes,
   * loops, throws, unwrapping or calls of function values). Evaluating such
   * an expression early, again or not at all is unobservable except for the
   * identity of what it creates.
   */
  effectFree(e: Expr): boolean {
    const builtin = (name: string) =>
      /^(attrs|string|Math|maybe)\./.test(name) && name !== 'attrs.get';
    // A map the expression itself creates (a dictionary literal: `Map.new`
    // then `map.set`s): filling it changes nothing else.
    const fresh = (x: Expr): boolean =>
      (x.op === 'builtin' && x.name === 'Map.new') ||
      (x.op === 'builtin' && x.name === 'map.set' && fresh(x.args[0])) ||
      (x.op === 'with' && fresh(x.body));
    const visit = (x: unknown): boolean => {
      if (Array.isArray(x)) return x.every(visit);
      if (!x || typeof x !== 'object') return true;
      const o = x as Record<string, unknown>;
      switch (o.op) {
        case 'call-value':
        case 'mount':
        case 'unwrap':
        case 'downcast':
        case 'set':
        case 'assign':
        case 'throw':
        case 'while':
        case 'for-of':
        case 'try':
          return false;
        case 'builtin':
          if (!builtin(o.name as string) && !fresh(o as Expr)) return false;
          break;
        case 'closure':
          return true;
        case 'call':
          if (!this.functionEffectFree(o.function as number)) return false;
          break;
      }
      return Object.entries(o).every(([k, v]) => k === 'type' || visit(v));
    };
    return visit(e);
  }

  private readonly effectFreeFunctions = new Map<number, boolean>();

  private functionEffectFree(index: number): boolean {
    const known = this.effectFreeFunctions.get(index);
    if (known !== undefined) return known;
    // (A recursive call is not effect-free: it may not end.)
    this.effectFreeFunctions.set(index, false);
    const f = this.functions[index];
    const ok = !!f && f.body.length > 0 && this.effectFree(f.body as unknown as Expr);
    this.effectFreeFunctions.set(index, ok);
    return ok;
  }

  /** Record field reads that are undefined only where the object lacks the key (`byName`). */
  private readonly absentWhenUndefined = {
    add: (e: Expr) => void EXPR_TAGS.set(e, { ...EXPR_TAGS.get(e), absent: true }),
    has: (e: Expr) => !!EXPR_TAGS.get(e)?.absent,
  };
  /** Style records spread into style objects, with the function to write (`styleObject`). */
  private readonly styleSpreadChecks: { record: number; fn: number; at: ts.Node }[] = [];
  /** Record spreads keeping an earlier value where the spread's is undefined (`byName`). */
  private readonly recordSpreadChecks: { record: number; field: string; at: ts.Node }[] = [];
  /** The key order of the object literal a record expression builds (`byName`). */
  private readonly literalOrder = {
    set: (e: Expr, order: string[]) => void EXPR_TAGS.set(e, { ...EXPR_TAGS.get(e), order }),
    get: (e: Expr) => EXPR_TAGS.get(e)?.order,
  };

  /**
   * Checks the assumption of style spreads (`styleObject`): every
   * construction of a spread style record gives each field that may be
   * undefined a value, or leaves it undefined only where the object it
   * stands for lacks the key. Call with the finished program.
   */
  checkStyleSpreads(program: unknown): void {
    if (!this.styleSpreadChecks.length && !this.recordSpreadChecks.length) return;
    const records = new Set([
      ...this.styleSpreadChecks.map(c => c.record),
      ...this.recordSpreadChecks.map(c => c.record),
    ]);
    const built = new Map<number, Expr[]>();
    const visit = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(visit);
      if (!x || typeof x !== 'object') return;
      const o = x as Expr;
      if (o.op === 'record' && records.has(o.record)) {
        const list = built.get(o.record) ?? [];
        list.push(o);
        built.set(o.record, list);
      }
      for (const v of Object.values(o)) visit(v);
    };
    visit(program);
    // Record spreads over earlier values (`byName`): the spread field is
    // undefined only where the object lacks the key, so the earlier value
    // stays, as in JavaScript.
    for (const c of this.recordSpreadChecks) {
      const r = this.types.records[c.record];
      const i = r.fields.findIndex(f => f.name === c.field);
      for (const e of built.get(c.record) ?? []) {
        if (e.op !== 'record') continue;
        const v = e.fields[i];
        if (!(v.op === 'some' || this.absentWhenUndefined.has(v)))
          this.fail(
            c.at,
            'E_OBJECT',
            `This spread of a ${r.name} object keeps the earlier ${c.field} where the spread one is undefined, but an object may have the key ${c.field} with an undefined value (a spread copies it); whether a key exists is tracked for keys an object literal leaves out or adds by a conditional spread`,
          );
      }
    }
    for (const c of this.styleSpreadChecks) {
      const r = this.types.records[c.record];
      const fail = (why: string) =>
        this.fail(c.at, 'E_ATTRS', `A style object spreads a ${r.name} object: ${why}`);
      // Each construction: its keys in order (a field that may be undefined
      // is a key only where its value is not; it must be undefined only
      // where the object lacks the key).
      const orders: string[][] = [];
      for (const e of built.get(c.record) ?? []) {
        if (e.op !== 'record') continue;
        r.fields.forEach((f, i) => {
          const v = e.fields[i];
          if (maybeInner(f.type) && !(v.op === 'some' || this.absentWhenUndefined.has(v)))
            fail(
              `its ${f.name} may be undefined where the object has the key (it would print "undefined"); whether a key exists is tracked for keys an object literal leaves out or adds by a conditional spread`,
            );
        });
        const order = this.literalOrder.get(e);
        if (!order && this.types.packageRecords.has(c.record))
          fail('its key order is not known (an object a package builds)');
        orders.push(order ?? r.fields.map(f => f.name));
      }
      // One order of all keys that each construction's order follows.
      const keys: string[] = [];
      const before = new Map<string, Set<string>>();
      for (const o of orders)
        o.forEach((k, i) => {
          if (!keys.includes(k)) keys.push(k);
          const set = before.get(k) ?? new Set<string>();
          o.slice(0, i).forEach(x => set.add(x));
          before.set(k, set);
        });
      for (const f of r.fields) if (!keys.includes(f.name)) keys.push(f.name);
      const order: string[] = [];
      while (order.length < keys.length) {
        const next = keys.find(
          k => !order.includes(k) && [...(before.get(k) ?? [])].every(x => order.includes(x)),
        );
        if (next === undefined) fail('its objects have their keys in different orders');
        order.push(next!);
      }
      const M: Type = { map: [STRING, { maybe: STRING }] };
      // Each call site (`styleObject`: the map so far in a local, the
      // object): the keys set in order, rebinding that local.
      const sites: Expr[] = [];
      const find = (x: unknown) => {
        if (Array.isArray(x)) return x.forEach(find);
        if (!x || typeof x !== 'object') return;
        const o = x as Expr;
        if (o.op === 'call' && o.function === c.fn) sites.push(o);
        for (const v of Object.values(o)) find(v);
      };
      find(program);
      for (const site of sites) {
        if (site.op !== 'call') continue;
        const [prevRead, object] = site.args;
        if (prevRead.op !== 'local') continue;
        const prev = prevRead.local;
        const read: Expr = { op: 'local', local: prev };
        const steps: Expr[] = order.map(name => {
          const i = r.fields.findIndex(f => f.name === name);
          const f = r.fields[i];
          const fv: Expr = {
            op: 'get',
            object: JSON.parse(JSON.stringify(object)) as Expr,
            field: i,
          };
          const set = (value: Expr): Expr => ({
            op: 'builtin',
            name: 'map.set',
            args: [read, { op: 'lit', value: name }, value],
            type: M,
          });
          return f.type === STRING
            ? set({ op: 'some', value: fv })
            : {
                op: 'cond',
                test: {
                  op: 'builtin',
                  name: 'maybe.is-undefined',
                  args: [JSON.parse(JSON.stringify(fv)) as Expr],
                  type: BOOLEAN,
                },
                then: read,
                else: set(fv),
              };
        });
        let out: Expr = read;
        for (const step of steps.reverse())
          out = { op: 'with', local: prev, value: step, body: out };
        for (const k of Object.keys(site)) delete (site as Record<string, unknown>)[k];
        Object.assign(site, out);
      }
      // (The marker function is not called any more.)
      this.functions[c.fn] = {
        name: `${r.name}$styleSpread`,
        params: [],
        locals: [],
        result: 'void',
        body: [],
      };
    }
  }

  /** A function with properties (a callable record) as the function it is; other values as they are. */
  /**
   * The function a call of value `v` calls: a function with properties'
   * function; a nullable function unwrapped (calling nullish throws a
   * TypeError, as unwrapping does: bits-ui's `if (typeof cleanup ===
   * "function") cleanup()`).
   */
  calleeOf(v: Expr, b: FnBuilder): Expr {
    const fnInner = maybeInner(this.irType(v, b));
    if (typeof fnInner === 'object' && 'fn' in fnInner) return { op: 'unwrap', value: v };
    return this.functionOf(v, b);
  }

  functionOf(v: Expr, b: FnBuilder): Expr {
    const t = this.irType(v, b);
    return typeof t === 'object' && 'record' in t && this.types.isCallable(t.record)
      ? { op: 'get', object: v, field: 0 }
      : v;
  }

  /**
   * The one IR type the uses of a variable expect (their contextual types:
   * a property of an object literal, an argument), where TypeScript's
   * contextual types are known; undefined otherwise.
   */
  flowType(d: ts.VariableDeclaration, sym: ts.Symbol): Type | undefined {
    let scope: ts.Node = d.parent;
    while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    let found: Type | undefined;
    let conflict = false;
    const visit = (n: ts.Node) => {
      if (conflict) return;
      const short =
        ts.isIdentifier(n) && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n;
      const refers =
        ts.isIdentifier(n) &&
        n !== d.name &&
        (short
          ? this.checker.getShorthandAssignmentValueSymbol(
              n.parent as ts.ShorthandPropertyAssignment,
            ) === sym
          : this.checker.getSymbolAtLocation(n) === sym);
      // (A spread operand is not a value of the object's type.)
      if (
        refers &&
        ts.isIdentifier(n) &&
        !ts.isSpreadAssignment(n.parent) &&
        !ts.isSpreadElement(n.parent)
      ) {
        // `get name() { return x; }` in an object literal of a declared type:
        // the type of its property `name`.
        const getter =
          ts.isReturnStatement(n.parent) &&
          ts.isBlock(n.parent.parent) &&
          ts.isGetAccessorDeclaration(n.parent.parent.parent) &&
          ts.isObjectLiteralExpression(n.parent.parent.parent.parent)
            ? n.parent.parent.parent
            : undefined;
        const owner = short
          ? (n.parent.parent as ts.ObjectLiteralExpression)
          : getter
            ? (getter.parent as ts.ObjectLiteralExpression)
            : undefined;
        const key = short
          ? n.text
          : getter && ts.isIdentifier(getter.name)
            ? getter.name.text
            : undefined;
        const ctx = owner
          ? this.checker.getContextualType(owner)
          : this.checker.getContextualType(n);
        const prop = owner && ctx && key ? this.checker.getPropertyOfType(ctx, key) : undefined;
        const t = prop ? this.checker.getTypeOfSymbol(prop) : owner ? undefined : ctx;
        // (An argument of a call the framework lowers: svelte/events' `on`.)
        const call = n.parent;
        const framework =
          ts.isCallExpression(call) && call.arguments.includes(n)
            ? this.hooks.argumentType?.(call, call.arguments.indexOf(n), this)
            : undefined;
        const mapped =
          framework ??
          (t && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
            ? this.types.tryMap(t, n)
            : undefined);
        if (mapped !== undefined) {
          if (found !== undefined && !sameType(found, mapped)) conflict = true;
          found = mapped;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return conflict ? undefined : found;
  }

  /**
   * Whether every use of function `sym` (declared by `decl`) in its scope
   * is a call whose result is discarded (an expression statement).
   */
  private resultDiscarded(sym: ts.Symbol, decl: ts.FunctionDeclaration): boolean {
    let ok = true;
    let used = false;
    const visit = (n: ts.Node) => {
      if (!ok) return;
      if (ts.isIdentifier(n) && n !== decl.name && this.checker.getSymbolAtLocation(n) === sym) {
        used = true;
        let call: ts.Node = n.parent;
        if (!ts.isCallExpression(call) || call.expression !== n) {
          ok = false;
          return;
        }
        while (ts.isParenthesizedExpression(call.parent) || ts.isVoidExpression(call.parent))
          call = call.parent;
        if (!ts.isExpressionStatement(call.parent)) ok = false;
      }
      ts.forEachChild(n, visit);
    };
    visit(decl.parent);
    return ok && used;
  }

  /** Untyped `let`s whose values may be undefined (`declaration`): reads keep them nullable. */
  private readonly widened = new Set<ts.Symbol>();

  /** Whether variable `sym` is assigned a value TypeScript types `any` in its scope. */
  private untypedAssignments(d: ts.VariableDeclaration, sym: ts.Symbol): boolean {
    let scope: ts.Node = d.parent;
    while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        this.checker.getSymbolAtLocation(n.left) === sym &&
        this.checker.getTypeAtLocation(n.right).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
      )
        found = true;
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return found;
  }

  /**
   * The IR type of the values assigned to an untyped variable declared
   * without an initialiser, from TypeScript's types of the right-hand sides
   * in its scope; undefined when there are none or they differ.
   */
  private assignedType(d: ts.VariableDeclaration, sym: ts.Symbol): Type | undefined {
    let scope: ts.Node = d.parent;
    while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    const found: Type[] = [];
    let open = false;
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        this.checker.getSymbolAtLocation(n.left) === sym
      ) {
        // (Undefined and null: the variable is nullable, as it is anyway.)
        const right = skipParens(n.right);
        if (
          right.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(right) && right.text === 'undefined')
        ) {
          ts.forEachChild(n, visit);
          return;
        }
        const t = this.types.tryMap(this.checker.getTypeAtLocation(n.right), n.right);
        if (t === undefined) open = true;
        else found.push(t);
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    if (open || !found.length) return undefined;
    const inner = found.map(t => maybeInner(t) ?? t);
    if (!inner.every(t => sameType(t, inner[0]))) return undefined;
    return found.some(t => maybeInner(t)) ? { maybe: inner[0] } : inner[0];
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
    // An event's members (bits-ui's `const { clientX, clientY } = event`),
    // read as `event.clientX` reads them.
    if (ts.isObjectBindingPattern(pattern) && type === 'event') {
      for (const el of pattern.elements) {
        const key = (el.propertyName ?? el.name) as ts.Identifier;
        const t = ts.isIdentifier(key) ? EVENT_MEMBERS[key.text] : undefined;
        if (
          el.dotDotDotToken ||
          t === undefined ||
          t === 'void' ||
          key.text === 'value' ||
          key.text === 'checked'
        )
          this.fail(el, 'E_DESTRUCTURE', 'Events destructure into their supported members');
        bind(
          el.name,
          { op: 'builtin', name: `event.${key.text}`, args: [source], type: t! },
          t!,
          el.initializer,
        );
      }
      return out;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      if (typeof type !== 'object' || !('record' in type))
        this.fail(pattern, 'E_DESTRUCTURE', 'Object destructuring requires a record value');
      const record = (type as { record: number }).record;
      if (this.types.accessors.has(record))
        this.fail(
          pattern,
          'E_DESTRUCTURE',
          'Destructuring objects implemented with getters is unsupported; read their properties',
        );
      for (const el of pattern.elements) {
        if (el.dotDotDotToken) {
          bind(el.name, this.restRecord(el, source, record), this.types.of(el.name));
          continue;
        }
        const key = (el.propertyName ?? el.name) as ts.Identifier;
        if (!ts.isIdentifier(key))
          this.fail(el, 'E_DESTRUCTURE', 'Computed destructuring keys are unsupported');
        // A record of a pack (svelte-toolbelt's box: \`{ current }\`): read as
        // the pack reads its members.
        const members = this.recordMembers.get(record);
        if (members) {
          const read = members.read(key.text, source, el, b);
          bind(el.name, read, this.irType(read, b), el.initializer);
          continue;
        }
        // A class instance: its fields and getters by name.
        if (this.types.records[record].class) {
          const read = this.classes.readMember(type, source, key, el, el.name, b);
          bind(el.name, read, this.irType(read, b), el.initializer);
          continue;
        }
        const field = this.types.fieldIndex(record, key.text, el);
        bind(
          el.name,
          { op: 'get', object: source, field },
          this.types.records[record].fields[field].type,
          el.initializer,
        );
      }
    } else if (
      ts.isArrayBindingPattern(pattern) &&
      typeof type === 'object' &&
      'record' in type &&
      this.types.isTuple(type.record)
    ) {
      // A tuple record: its items by index.
      const fields = this.types.records[type.record].fields;
      pattern.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return;
        if (el.dotDotDotToken || i >= fields.length)
          return this.fail(el, 'E_DESTRUCTURE', 'Tuples destructure into their items');
        bind(el.name, { op: 'get', object: source, field: i }, fields[i].type, el.initializer);
      });
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

  /**
   * A field of a merged record (frontend/types.ts `mergeRecords`, bits-ui's
   * options of a class hierarchy) as TypeScript types it where it is read: a
   * field some of the merged types lack is read through a type that has it
   * (only those types name it), so it is present (unwrapped; a TypeError if
   * the program broke its types), and a class union narrows to the class
   * TypeScript names (TypeError when it is another).
   */
  private mergedRead(
    read: Expr,
    record: number,
    field: number,
    e: ts.PropertyAccessExpression,
  ): Expr {
    const have = this.types.records[record].fields[field].type;
    const here = this.types.tryMap(this.checker.getTypeAtLocation(e), e);
    if (here === undefined) return read;
    let value = read;
    let type = have;
    if (maybeInner(have) && !maybeInner(here)) {
      value = { op: 'unwrap', value };
      type = maybeInner(have)!;
    }
    return this.classes.narrow(value, type, here);
  }

  /** Whether `e` is the object of a member access (`e.x`, `e[i]`, `e.m()`). */
  private isReceiver(e: ts.Expression): boolean {
    let use: ts.Node = e;
    while (ts.isParenthesizedExpression(use.parent) || ts.isNonNullExpression(use.parent))
      use = use.parent;
    return (
      (ts.isPropertyAccessExpression(use.parent) || ts.isElementAccessExpression(use.parent)) &&
      use.parent.expression === use
    );
  }

  /**
   * `...rest` of an object pattern: a new record (TypeScript's type of the
   * rest, the source's other properties) of the source's fields.
   */
  private restRecord(el: ts.BindingElement, source: Expr, record: number): Expr {
    const type = this.types.of(el.name);
    if (typeof type !== 'object' || !('record' in type) || this.types.records[type.record].class)
      return this.fail(el, 'E_DESTRUCTURE', 'Rest properties require a plain object value');
    // The source is read once per field: a local or fields of one.
    let s = source;
    while (s.op === 'get') s = s.object;
    if (s.op !== 'local')
      return this.fail(
        el,
        'E_DESTRUCTURE',
        'Rest properties of a defaulted nested pattern are unsupported',
      );
    const src = this.types.records[record];
    const fields = this.types.records[type.record].fields.map((f): Expr => {
      const j = src.fields.findIndex(s => s.name === f.name);
      if (j < 0) return this.fail(el, 'E_DESTRUCTURE', `The rest has no source field ${f.name}`);
      const value: Expr = { op: 'get', object: source, field: j };
      const have = src.fields[j].type;
      if (sameType(have, f.type)) return value;
      if (maybeInner(f.type) && sameType(maybeInner(f.type)!, have)) return { op: 'some', value };
      return this.fail(
        el,
        'E_DESTRUCTURE',
        `The rest's field ${f.name} has another type than its source`,
      );
    });
    return { op: 'record', record: type.record, fields };
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
      if (binding?.kind === 'module-let') return this.moduleVariableType(binding.global);
      // A field of a local's record (a function's `$state` local).
      if (binding?.kind === 'member' && binding.path.length) {
        let t = b.typeOf(b.resolve(binding.owner, binding.local));
        for (const f of binding.path)
          t = this.types.records[(t as { record: number }).record].fields[f].type;
        return t;
      }
    }
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
      const ref = this.binding(target.expression);
      if (ref?.kind === 'ref' && target.name.text === refField(ref))
        return this.hooks.cellType(ref.cell);
    }
    // A place TypeScript cannot type (untyped JavaScript): the IR type of
    // what it reads.
    if (
      !this.overrides.has(target) &&
      !ts.isOptionalChain(target) &&
      this.types.typeOrUndefined(target) === undefined
    )
      return this.irType(this.expr(target, b), b);
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
    // `j = i++` (and `++i`, `--`; bits-ui's `for (let i = 0, j = length - 1;
    // i < length; j = i++)`): the increment, then the assignment of the
    // value before it (after it for a prefix).
    const counted = !('expr' in valueNode) ? skipParens(valueNode) : undefined;
    if (
      operator === ts.SyntaxKind.EqualsToken &&
      counted &&
      (ts.isPrefixUnaryExpression(counted) || ts.isPostfixUnaryExpression(counted)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(counted.operator) &&
      ts.isIdentifier(counted.operand)
    ) {
      const step = this.expressionStatement(counted, b, counted);
      if (ts.isPrefixUnaryExpression(counted))
        return [...step, ...this.assignment(target, operator, counted.operand, b)];
      const before = this.expr(counted.operand, b);
      const type = this.irType(before, b);
      const tmp = b.local('$before', type);
      return [
        { op: 'let', local: tmp, value: before },
        ...step,
        ...this.assignment(target, operator, { expr: { op: 'local', local: tmp }, type }, b),
      ];
    }
    // A host field (frontend/classes.ts `hostFieldOf`): whether it holds its object.
    const host =
      operator === ts.SyntaxKind.EqualsToken && !('expr' in valueNode)
        ? this.classes.hostField(target)
        : undefined;
    if (host && !('expr' in valueNode)) {
      const holds = this.hostName(valueNode) === host;
      return this.assignment(
        target,
        operator,
        { expr: { op: 'lit', value: holds }, type: BOOLEAN },
        b,
      );
    }
    const compound = COMPOUND[operator];
    const current = () => this.expr(target, b);
    const rhs = () => ('expr' in valueNode ? valueNode.expr : this.expr(valueNode, b));
    // TypeScript's type of the value, or its IR type where TypeScript only knows `any`.
    const rhsType = (lowered: Expr) =>
      'expr' in valueNode
        ? valueNode.type
        : (this.types.typeOrUndefined(valueNode) ?? this.irType(lowered, b));
    let value: Expr;
    if (operator === ts.SyntaxKind.EqualsToken) {
      // An object literal TypeScript cannot type (untyped JavaScript) takes
      // the target's type.
      // So does `undefined` (or `null`).
      const literal = !('expr' in valueNode) && skipParens(valueNode);
      if (
        literal &&
        (ts.isObjectLiteralExpression(literal) ||
          literal.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(literal) && literal.text === 'undefined' && !this.binding(literal)))
      )
        this.expected.set(literal, this.targetType(target, b));
      value = rhs();
      // A literal `null` or `undefined` takes the target's nullable type
      // (its contextual type may be one the value model maps differently).
      if (value.op === 'null' || value.op === 'undefined') {
        const t = this.targetType(target, b);
        if (maybeInner(t)) value = { op: value.op, type: t };
      }
    } else if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken)
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

  /**
   * A host element scripts change (`root`: `document.documentElement`;
   * `body`: `document.body`, M6, bits-ui's scroll lock), whose built-ins
   * are the `root.*` and `body.*` families.
   */
  private hostElement(e: ts.Expression): 'root' | 'body' | undefined {
    e = skipParens(e);
    if (this.isRoot(e)) return 'root';
    return ts.isPropertyAccessExpression(e) &&
      e.name.text === 'body' &&
      this.hostName(e.expression) === 'document'
      ? 'body'
      : undefined;
  }

  /**
   * A member of a host element: an attribute (the document element's
   * `lang` and `dir`, `dataset.x`) or a style property.
   */
  private rootMember(
    e: ts.Expression,
  ): { family: 'root' | 'body'; kind: 'attr' | 'style'; name: string } | undefined {
    e = skipParens(e);
    if (!ts.isPropertyAccessExpression(e)) return undefined;
    const n = e.name.text;
    const kebab = (s: string) => s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    if (this.isRoot(e.expression))
      return ['lang', 'dir'].includes(n) ? { family: 'root', kind: 'attr', name: n } : undefined;
    const inner = skipParens(e.expression);
    const family = ts.isPropertyAccessExpression(inner)
      ? this.hostElement(inner.expression)
      : undefined;
    if (!family) return undefined;
    const part = (inner as ts.PropertyAccessExpression).name.text;
    if (part === 'dataset') return { family, kind: 'attr', name: 'data-' + kebab(n) };
    if (part === 'style') return { family, kind: 'style', name: kebab(n) };
    return undefined;
  }

  writeTo(target: ts.Expression, value: Expr, b: FnBuilder): Stmt[] {
    // location.hash = value: a fragment navigation.
    if (
      ts.isPropertyAccessExpression(target) &&
      this.hostName(skipParens(target.expression)) === 'location'
    ) {
      if (target.name.text !== 'hash')
        return this.fail(
          target,
          'E_HOST',
          `Assigning location.${target.name.text} navigates to another document, which is unsupported (assign location.hash or use history.pushState)`,
        );
      const text: Expr =
        this.irType(value, b) === 'string' ? value : { op: 'to-string', arg: value };
      return [
        {
          op: 'expr',
          value: { op: 'builtin', name: 'location.set-hash', args: [text], type: 'void' },
          ...this.src(target),
        },
      ];
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      target.name.text === 'title' &&
      this.hostName(skipParens(target.expression)) === 'document'
    ) {
      const text: Expr =
        this.irType(value, b) === 'string' ? value : { op: 'to-string', arg: value };
      return [
        {
          op: 'expr',
          value: { op: 'builtin', name: 'document.set-title', args: [text], type: 'void' },
          ...this.src(target),
        },
      ];
    }
    if (ts.isPropertyAccessExpression(target)) {
      const host = this.hostName(skipParens(target.expression));
      if (host === 'history' || host === 'navigator' || host === 'console' || host === 'crypto')
        return this.fail(target, 'E_HOST', `${host}.${target.name.text} cannot be assigned`);
      // A static field the class assigns (`C.name = v`, `this.name = v` in
      // a static member).
      const owner = skipParens(target.expression);
      const cls =
        owner.kind === ts.SyntaxKind.ThisKeyword
          ? this.classes.staticThis(owner)
          : ts.isIdentifier(owner) && this.binding(owner)?.kind === 'class'
            ? (this.binding(owner) as { cls: ClassInfo }).cls
            : undefined;
      if (cls) return this.classes.staticWrite(cls, target, value, b);
    }
    const root = this.rootMember(target);
    if (root) {
      const text: Expr =
        this.irType(value, b) === 'string' ? value : { op: 'to-string', arg: value };
      return [
        {
          op: 'expr',
          value: {
            op: 'builtin',
            name: `${root.family}.${root.kind === 'attr' ? 'set-attr' : 'style-set'}`,
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
    // An element's inline style property, set through the CSSOM.
    const style = ts.isPropertyAccessExpression(target) && this.elementStyle(target, b);
    if (style) {
      const text: Expr =
        this.irType(value, b) === 'string' ? value : { op: 'to-string', arg: value };
      return [
        {
          op: 'expr',
          value: {
            op: 'builtin',
            name: 'element.style-set',
            args: [style.element, { op: 'lit', value: style.property }, text],
            type: 'void',
          },
          ...this.src(target),
        },
      ];
    }
    // Members of pack records (svelte-toolbelt's boxes; `super` is a class).
    if (
      ts.isPropertyAccessExpression(target) &&
      target.expression.kind !== ts.SyntaxKind.SuperKeyword
    ) {
      const t = this.typeAt(target.expression, b);
      const r = typeof t === 'object' && 'record' in t ? t.record : undefined;
      const members = r !== undefined && this.recordMembers.get(r);
      if (members)
        return members.write(target.name.text, this.expr(target.expression, b), value, target, b);
      // A class reference to such records (`packUnionRead`): written as the
      // one class whose member has the value's type, downcast to it.
      if (
        typeof t === 'object' &&
        'classes' in t &&
        t.classes.every(c => this.recordMembers.has(c))
      ) {
        const name = target.name.text;
        const vt = this.irType(value, b);
        const matching = t.classes.filter(record => {
          const probe = b.local('$probe', { record });
          const read = this.recordMembers
            .get(record)!
            .read(name, { op: 'local', local: probe }, target, b);
          return sameType(this.irType(read, b), vt);
        });
        if (matching.length !== 1)
          return this.fail(
            target,
            'E_MEMBER',
            `${name} is written with a value whose type ${matching.length ? 'several' : 'none'} of the classes of this value hold there`,
          );
        const local = b.local(`$${this.types.records[matching[0]].name}`, { record: matching[0] });
        return [
          {
            op: 'assign',
            target: { place: 'local', local },
            value: {
              op: 'downcast',
              value: this.expr(target.expression, b),
              type: { record: matching[0] },
            },
          },
          ...this.recordMembers
            .get(matching[0])!
            .write(name, { op: 'local', local }, value, target, b),
        ];
      }
    }
    // Class setters and members that are not fields (frontend/classes.ts).
    if (ts.isPropertyAccessExpression(target)) {
      const member = this.classes.write(target, value, b);
      if (member) return member;
    }
    // A dictionary object's entry (`keyToIndex[k] = v`, `seen.click = v`).
    if (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target)) {
      const t = this.typeAt(target.expression, b);
      if (typeof t === 'object' && 'map' in t && t.map[0] === STRING) {
        const k = b.local('$key', STRING);
        const key: Expr = { op: 'local', local: k };
        return [
          {
            op: 'let',
            local: k,
            value: ts.isElementAccessExpression(target)
              ? this.coerce(target.argumentExpression, b, STRING)
              : { op: 'lit', value: target.name.text },
          },
          {
            op: 'expr',
            value: { op: 'call', function: this.prototypeGuard('void', true), args: [key] },
          },
          {
            op: 'expr',
            value: {
              op: 'builtin',
              name: 'map.set',
              args: [this.expr(target.expression, b), key, this.fitValue(value, t.map[1], b)],
              type: t,
            },
          },
        ];
      }
    }
    // T is widened into a nullable target (Maybe<T>), a class instance into a class reference.
    const want = this.targetType(target, b);
    const have = this.irType(value, b);
    value = this.classes.fitAt(value, have, want, target);
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
      if (binding?.kind === 'module-let')
        return [
          {
            op: 'assign',
            target: {
              place: 'field',
              object: { op: 'global', global: binding.global },
              field: 0,
            },
            value,
            ...this.src(target),
          },
        ];
      // A field of a local's record (a function's `$state` local).
      if (binding?.kind === 'member' && binding.path.length) {
        let object: Expr = { op: 'local', local: b.resolve(binding.owner, binding.local) };
        for (const f of binding.path.slice(0, -1)) object = { op: 'get', object, field: f };
        return [
          {
            op: 'assign',
            target: { place: 'field', object, field: binding.path[binding.path.length - 1] },
            value,
            ...this.src(target),
          },
        ];
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
      const type = this.typeAt(target.expression, b);
      if (typeof type === 'object' && 'record' in type && this.types.accessors.has(type.record))
        return this.fail(target, 'E_ASSIGN', 'Properties implemented with getters are read-only');
      if (typeof type === 'object' && 'record' in type)
        return {
          place: 'field',
          object: this.expr(target.expression, b),
          field: this.types.fieldIndex(type.record, target.name.text, target),
        };
    }
    if (ts.isElementAccessExpression(target)) {
      const type = this.typeAt(target.expression, b);
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

  /**
   * Bindings created on first use: the declarations of package modules
   * compiled from source (frontend/package-bindings.ts), which are lowered
   * only when the program reaches them. Undefined for other symbols.
   */
  lazy?: (symbol: ts.Symbol) => Binding | undefined;
  /**
   * The class compiled from source that a package's declaration file
   * declares (frontend/package-modules.ts), if any: its instances are the
   * implementation's.
   */
  implementation?: (symbol: ts.Symbol) => ts.Symbol | undefined;

  /** The binding of `symbol`, created on first use if it is lazy. */
  bindingOf(symbol: ts.Symbol): Binding | undefined {
    return this.bindings.get(symbol) ?? this.lazy?.(symbol);
  }

  binding(id: ts.Identifier): Binding | undefined {
    // Package imports and re-exports are bound by their own symbols
    // (frontend/packs.ts): follow the alias chain through local re-exports.
    let own = this.valueSymbol(id);
    for (let hops = 0; own && hops < 32; hops++) {
      const pack = this.bindingOf(own);
      if (pack?.kind === 'pack' || pack?.kind === 'constant') return pack;
      if (!(own.flags & ts.SymbolFlags.Alias)) break;
      own = this.checker.getImmediateAliasedSymbol(own);
    }
    const s = this.symbol(id);
    return s ? this.bindingOf(s) : undefined;
  }

  /** The module namespace an expression names (`import * as ns`, `export * as ns`), if any. */
  namespaceOf(e: ts.Expression): ts.Symbol | undefined {
    e = skipParens(e);
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return undefined;
    const s = this.symbol(ts.isIdentifier(e) ? e : e.name);
    return s && s.flags & ts.SymbolFlags.ValueModule && !(s.flags & ts.SymbolFlags.Function)
      ? s
      : undefined;
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
    // In a test only truthiness matters: `a && b` and `a || b` combine the
    // operands' truthiness (short-circuiting as JavaScript does), whatever
    // their types; `!a` negates it.
    const inner = skipParens(e);
    const effects: ts.Expression[] = [];
    const known = this.staticTruth(inner, b, effects);
    if (known !== undefined) return this.after(effects, { op: 'lit', value: known }, b);
    if (ts.isBinaryExpression(inner)) {
      const op = inner.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const and = op === ts.SyntaxKind.AmpersandAmpersandToken;
        const leftEffects: ts.Expression[] = [];
        const left = this.staticTruth(inner.left, b, leftEffects);
        if (left !== undefined)
          return this.after(
            leftEffects,
            left === and ? this.condition(inner.right, b) : { op: 'lit', value: !and },
            b,
          );
        return {
          op: and ? 'and' : 'or',
          left: this.condition(inner.left, b),
          right: this.condition(inner.right, b),
        };
      }
    }
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken)
      return { op: 'not', arg: this.condition(inner.operand, b) };
    const v = this.expr(e, b);
    return this.truthy(v, this.irType(v, b));
  }

  /**
   * `[a, c && b, …].filter(Boolean)`: an array literal whose elements may be
   * falsy instead of a value (bits-ui's floating-ui middleware list), with
   * the falsy ones removed: an array of the values' type. The elements are a
   * nullable value each (`c && b` undefined where `c` is falsy), kept where
   * truthy. Undefined for other calls.
   */
  private filterBoolean(e: ts.CallExpression, b: FnBuilder): Expr | undefined {
    const callee = e.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'filter') return undefined;
    const [arg] = e.arguments;
    const list = skipParens(callee.expression);
    if (
      e.arguments.length !== 1 ||
      !ts.isIdentifier(arg) ||
      this.globalName(arg) !== 'Boolean' ||
      !ts.isArrayLiteralExpression(list) ||
      list.elements.some(ts.isSpreadElement)
    )
      return undefined;
    // The values' type: what is expected here, or TypeScript's element type
    // without its falsy members.
    let t: Type | undefined;
    const want = this.expected.get(e);
    if (typeof want === 'object' && 'array' in want) t = want.array;
    if (t === undefined) {
      const el = this.checker.getTypeAtLocation(list);
      const [elem] = this.checker.isArrayType(el)
        ? this.checker.getTypeArguments(el as ts.TypeReference)
        : [];
      const F = ts.TypeFlags;
      const parts = (elem?.isUnion() ? elem.types : elem ? [elem] : []).filter(
        p =>
          !(p.flags & (F.Null | F.Undefined | F.Void)) &&
          !(
            p.flags & F.BooleanLiteral &&
            (p as { intrinsicName?: string }).intrinsicName === 'false'
          ),
      );
      t = parts.length === 1 ? this.types.tryMap(parts[0], list) : undefined;
    }
    if (t === undefined)
      return this.fail(e, 'E_TYPE_UNION', 'filter(Boolean) needs one type of the values it keeps');
    const value = t;
    const m: Type = { maybe: value };
    const items = list.elements.map((el): Expr => {
      const x = skipParens(el);
      const one = (v: ts.Expression): Expr => {
        this.expected.set(skipParens(v), value);
        const out = this.coerce(v, b, m);
        return out;
      };
      if (
        ts.isBinaryExpression(x) &&
        x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return {
          op: 'cond',
          test: this.condition(x.left, b),
          then: one(x.right),
          else: { op: 'undefined', type: m },
        };
      return one(x);
    });
    const keep = this.reserve();
    this.functions[keep] = {
      name: 'filter$Boolean',
      params: [{ name: 'v', type: m }],
      locals: [],
      result: BOOLEAN,
      body: [{ op: 'return', value: { op: 'to-boolean', arg: { op: 'local', local: 0 } } }],
    };
    const unwrap = this.reserve();
    this.functions[unwrap] = {
      name: 'filter$value',
      params: [{ name: 'v', type: m }],
      locals: [],
      result: value,
      body: [{ op: 'return', value: { op: 'unwrap', value: { op: 'local', local: 0 } } }],
    };
    const kept: Expr = {
      op: 'builtin',
      name: 'array.filter',
      args: [
        { op: 'array', type: { array: m }, items },
        { op: 'closure', function: keep, captures: [] },
      ],
      type: { array: m },
    };
    return {
      op: 'builtin',
      name: 'array.map',
      args: [kept, { op: 'closure', function: unwrap, captures: [] }],
      type: { array: value },
    };
  }

  /**
   * `typeof x === "function" ? x() : x` (or with `!==` and the branches
   * swapped) where `x` is a local or parameter holding a nullable function
   * of no parameters: `x()` where it holds one, otherwise its `undefined`
   * or `null`, as the call's nullable result type. Undefined for other
   * conditionals.
   */
  private maybeGetter(c: ts.ConditionalExpression, b: FnBuilder): Expr | undefined {
    const test = skipParens(c.condition);
    if (!ts.isBinaryExpression(test) || !ts.isTypeOfExpression(skipParens(test.left)))
      return undefined;
    const right = skipParens(test.right);
    if (!ts.isStringLiteralLike(right) || right.text !== 'function') return undefined;
    const op = test.operatorToken.kind;
    const eq =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const ne =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!eq && !ne) return undefined;
    const operand = skipParens((skipParens(test.left) as ts.TypeOfExpression).expression);
    if (!ts.isIdentifier(operand)) return undefined;
    const [call, plain] = eq ? [c.whenTrue, c.whenFalse] : [c.whenFalse, c.whenTrue];
    const callNode = skipParens(call);
    const plainNode = skipParens(plain);
    if (
      !ts.isCallExpression(callNode) ||
      callNode.arguments.length ||
      !ts.isIdentifier(skipParens(callNode.expression)) ||
      this.symbol(skipParens(callNode.expression)) !== this.symbol(operand) ||
      !ts.isIdentifier(plainNode) ||
      this.symbol(plainNode) !== this.symbol(operand)
    )
      return undefined;
    const x = this.expr(operand, b);
    const t = this.irType(x, b);
    const fn = maybeInner(t);
    if (!fn || typeof fn !== 'object' || !('fn' in fn) || fn.fn.params.length) return undefined;
    const result: Type = maybeInner(fn.fn.result) ? fn.fn.result : { maybe: fn.fn.result };
    const tmp = b.local('$getter', t);
    const v: Expr = { op: 'local', local: tmp };
    const called: Expr = { op: 'call-value', callee: { op: 'unwrap', value: v }, args: [] };
    return {
      op: 'with',
      local: tmp,
      value: x,
      body: {
        op: 'cond',
        test: { op: 'builtin', name: 'maybe.is-nullish', args: [v], type: 'boolean' },
        then: {
          op: 'cond',
          test: { op: 'builtin', name: 'maybe.is-null', args: [v], type: 'boolean' },
          then: { op: 'null', type: result },
          else: { op: 'undefined', type: result },
        },
        else: maybeInner(fn.fn.result) ? called : { op: 'some', value: called },
      },
    };
  }

  /** Program globals standing for `globalThis.NAME`, by name. */
  private readonly globalThisVars = new Map<string, number>();

  /**
   * `globalThis.NAME` where a module initialises it with a statement
   * `globalThis.NAME ??= init` at its top level (bits-ui's id counter and
   * layer registries): a program global, `init` evaluated once with the
   * module (nothing else sets the name first, so `??=` always assigns).
   * Other writes of the name are rejected. Undefined for other members.
   */
  private globalThisVar(e: ts.PropertyAccessExpression): Expr | undefined {
    const object = skipParens(e.expression);
    if (!ts.isIdentifier(object) || object.text !== 'globalThis' || this.binding(object))
      return undefined;
    const name = e.name.text;
    const known = this.globalThisVars.get(name);
    if (known !== undefined) return { op: 'global', global: known };
    const defs: ts.BinaryExpression[] = [];
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      const visit = (n: ts.Node) => {
        if (
          ts.isBinaryExpression(n) &&
          isAssignmentOperator(n.operatorToken.kind) &&
          ts.isPropertyAccessExpression(skipParens(n.left))
        ) {
          const left = skipParens(n.left) as ts.PropertyAccessExpression;
          const target = skipParens(left.expression);
          if (ts.isIdentifier(target) && target.text === 'globalThis' && left.name.text === name) {
            const top =
              n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
              ts.isExpressionStatement(n.parent) &&
              ts.isSourceFile(n.parent.parent);
            if (!top)
              this.fail(
                n,
                'E_MODULE',
                `globalThis.${name} is set only by a module statement globalThis.${name} ??= …`,
              );
            defs.push(n);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    if (defs.length !== 1)
      return this.fail(
        e,
        'E_MODULE',
        defs.length
          ? `globalThis.${name} is initialised by several modules`
          : `globalThis.${name} is not initialised by a module statement globalThis.${name} ??= …`,
      );
    const init = defs[0].right;
    // (The name has no declared type: the initialiser's own.)
    const type = this.types.map(this.checker.getTypeAtLocation(init), init);
    const value = this.value(init, undefined, `globalThis.${name}`);
    const global = this.globals.length;
    this.globals.push({ name: `globalThis.${name}`, type, init: value });
    this.globalThisVars.set(name, global);
    return { op: 'global', global };
  }

  /** `value` after evaluating `effects` (the operands of folded tests). */
  private after(effects: ts.Expression[], value: Expr, b: FnBuilder): Expr {
    let out = value;
    for (const x of [...effects].reverse()) {
      const v = this.expr(x, b);
      const tmp = b.local('$folded', this.irType(v, b));
      out = { op: 'with', local: tmp, value: v, body: out };
    }
    return out;
  }

  truthy(v: Expr, t: Type): Expr {
    // (A value read as present where TypeScript says so: its truthiness is
    // tested, which a nullish value has too; JavaScript reads it without
    // throwing: bits-ui's `if (!this.instance)` of a static field declared
    // without an initialiser.)
    if (v.op === 'unwrap') return { op: 'to-boolean', arg: v.value };
    return t === 'boolean' ? v : { op: 'to-boolean', arg: v };
  }

  iterationType(e: ts.Expression, t: Type): Type {
    if (t === 'string') return 'string';
    if (typeof t === 'object' && 'array' in t) return t.array;
    if (typeof t === 'object' && 'set' in t) return t.set;
    return this.fail(e, 'E_ITERATE', 'for-of is supported over arrays, sets, maps and strings');
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
      case K.AsExpression:
      case K.TypeAssertionExpression: {
        const v = this.expr((e as ts.AsExpression).expression, b);
        // A class reference asserted to be of some of its classes: checked (a TypeError where it is not).
        const t = this.irType(v, b);
        if (!this.classes.isClass(maybeInner(t) ?? t)) return v;
        return this.classes.narrow(v, t, this.types.typeOrUndefined(e));
      }
      case K.ParenthesizedExpression:
      case K.SatisfiesExpression:
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
      case K.ThisKeyword:
        return this.classes.thisValue(e, b);
      case K.SuperKeyword:
        return this.fail(
          e,
          'E_CLASS',
          'super is supported in member accesses and calls (super.m(…), super.x) and as the super(…) statement of a constructor',
        );
      case K.PrefixUnaryExpression:
        return this.prefix(e as ts.PrefixUnaryExpression, b);
      case K.BinaryExpression:
        return this.binaryExpression(e as ts.BinaryExpression, b);
      case K.ConditionalExpression: {
        const c = e as ts.ConditionalExpression;
        // A test the types or a prop's one value decide: its branch only (the
        // other may not be typable: bits-ui's `type === "single" ? "" : []`).
        const effects: ts.Expression[] = [];
        const known = this.staticTruth(c.condition, b, effects);
        if (known !== undefined)
          return this.after(
            effects,
            this.coerce(
              known ? c.whenTrue : c.whenFalse,
              b,
              this.contextualOr(e, known ? c.whenTrue : c.whenFalse),
            ),
            b,
          );
        // Untyped JavaScript (`unknown` from an untyped context key): the
        // branches' one IR type.
        const own = this.types.typeOrUndefined(e);
        if (own === undefined) {
          // `typeof x === "function" ? x() : x` of a nullable function (a
          // getter or nothing, runed's and bits-ui's `get`): the call where
          // it is one, and the nullish value as it is where it is not.
          const getter = this.maybeGetter(c, b);
          if (getter) return getter;
          const test = this.condition(c.condition, b);
          let then = this.expr(c.whenTrue, b);
          let other = this.expr(c.whenFalse, b);
          let tt = this.irType(then, b);
          // A value and a nullable one of its type: the nullable type.
          const ot = this.irType(other, b);
          if (maybeInner(tt) && sameType(maybeInner(tt)!, ot)) other = { op: 'some', value: other };
          else if (maybeInner(ot) && sameType(maybeInner(ot)!, tt)) {
            then = { op: 'some', value: then };
            tt = ot;
          }
          if (!sameType(tt, this.irType(other, b)))
            return this.fail(
              e,
              'E_TYPE_UNSUPPORTED',
              `The branches of this untyped conditional have different types (${JSON.stringify(tt)} and ${JSON.stringify(this.irType(other, b))})`,
            );
          return { op: 'cond', test, then, else: other };
        }
        return {
          op: 'cond',
          test: this.condition(c.condition, b),
          then: this.coerce(c.whenTrue, b, own),
          else: this.coerce(c.whenFalse, b, own),
        };
      }
      case K.TypeOfExpression: {
        // A method of a host object (`typeof node.getAnimations`) is a function.
        const operand = skipParens((e as ts.TypeOfExpression).expression);
        const member = ts.isPropertyAccessExpression(operand)
          ? this.checker.getSymbolAtLocation(operand.name)?.valueDeclaration
          : undefined;
        if (
          member &&
          ts.isMethodSignature(member) &&
          path.resolve(member.getSourceFile().fileName) === DOM
        )
          return { op: 'lit', value: 'function' };
        // The host's globals (`typeof document`): native apps have them.
        if (ts.isIdentifier(operand) && this.hostGlobal(operand))
          return { op: 'lit', value: 'object' };
        const arg = this.expr((e as ts.TypeOfExpression).expression, b);
        // A component value (frontend/component-values.ts) is a function in JavaScript.
        const argType = this.irType(arg, b);
        const component = maybeInner(argType) ?? argType;
        if (
          typeof component === 'object' &&
          'record' in component &&
          component.record === knownComponentRecord(this)
        )
          return maybeInner(argType)
            ? {
                op: 'cond',
                test: { op: 'to-boolean', arg },
                then: { op: 'lit', value: 'function' },
                else: { op: 'typeof', arg },
              }
            : { op: 'lit', value: 'function' };
        return { op: 'typeof', arg };
      }
      case K.PropertyAccessExpression:
        return this.property(e as ts.PropertyAccessExpression, b);
      case K.ElementAccessExpression:
        return this.element(e as ts.ElementAccessExpression, b);
      case K.CallExpression:
        return this.call(e as ts.CallExpression, b);
      case K.NewExpression:
        return this.newExpression(e as ts.NewExpression, b);
      case K.ArrowFunction:
      case K.FunctionExpression: {
        // An untyped function literal where a function type is expected.
        const want = this.expectedFunction(e as ts.ArrowFunction);
        return want
          ? this.closure(e as ts.ArrowFunction, b, 'closure', want.params, want.result)
          : this.closure(e as ts.ArrowFunction, b);
      }
      case K.ObjectLiteralExpression:
        return this.object(e as ts.ObjectLiteralExpression, b);
      case K.ArrayLiteralExpression:
        return this.array(e as ts.ArrayLiteralExpression, b);
      case K.VoidExpression:
        return { op: 'undefined', type: 'void' };
      case K.DeleteExpression:
        return this.deleteEntry(e as ts.DeleteExpression, b);
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
  /** The type of the module `let` global `global` holds. */
  private moduleVariableType(global: number): Type {
    const t = this.globals[global].type as { record: number };
    return this.types.records[t.record].fields[0].type;
  }

  /**
   * A module `let` (M6, bits-ui's scroll lock and keyboard tracking):
   * module state lives as long as the program, so the variable is field 0 of
   * a one-field class record in a program global created where the
   * declaration is (in order with the module's constants). `$state` and
   * `$state.raw` (in modules Svelte compiles runes in) make the field
   * reactive, a signal as Svelte's module state is. Its type is the
   * declared one, or in untyped JavaScript that of its initialiser and of the
   * values the module assigns it (nullable where one is null or undefined).
   * Returns the function initialising it, to run in the module's order;
   * `eager` (package modules, bound on first use) lowers the initialiser
   * first, so the globals it reaches are created before this one.
   */
  moduleVariable(
    sym: ts.Symbol,
    d: ts.VariableDeclaration,
    name: string,
    runes: boolean,
    eager = false,
  ): () => void {
    const init0 = d.initializer && skipParens(d.initializer);
    const rune =
      runes && init0 && ts.isCallExpression(init0) ? init0.expression.getText() : undefined;
    const reactive =
      rune === '$state' ? ('state' as const) : rune === '$state.raw' ? ('raw' as const) : undefined;
    if (rune?.startsWith('$') && !reactive)
      this.fail(
        d,
        'E_MODULE',
        `${rune} in a module variable is unsupported ($state and $state.raw are)`,
      );
    if (reactive && (init0 as ts.CallExpression).arguments.length > 1)
      this.fail(d, 'E_MODULE', `${rune} takes one initial value`);
    const init = reactive ? (init0 as ts.CallExpression).arguments[0] : init0;
    const declared = this.types.typeOrUndefined(d.name);
    const type = declared ?? this.untypedVariableType(sym, d, init);
    // (Literals take the variable's type: `$state([])` of a `string[]`.)
    if (init && !this.expected.has(init)) this.expected.set(init, maybeInner(type) ?? type);
    const initial = (): Expr =>
      init
        ? this.coerceValue(this.value(init, undefined, `${name}$module`), type, init)
        : { op: 'undefined', type };
    const first = eager ? initial() : undefined;
    const record = this.types.records.length;
    this.types.records.push({
      name: `${name}$module`,
      class: true,
      fields: [{ name, type, ...(reactive ? { reactive } : {}) }],
    });
    const global = this.globals.length;
    this.globals.push({
      name: `${name}$module`,
      type: { record },
      init: { op: 'undefined', type: { maybe: 'number' } },
    });
    this.bindings.set(sym, { kind: 'module-let', global });
    const set = (value: Expr) =>
      void (this.globals[global].init = { op: 'record', record, fields: [value] });
    if (first) {
      set(first);
      return () => {};
    }
    return () => set(initial());
  }

  /** A value of an initialiser as type `want` (nullable widening, null of the type). */
  private coerceValue(v: Expr, want: Type, at: ts.Node): Expr {
    if (v.op === 'null' || v.op === 'undefined') return { ...v, type: want } as Expr;
    const have = this.valueType(v);
    if (sameType(have, want)) return v;
    if (maybeInner(want) && sameType(have, maybeInner(want)!)) return { op: 'some', value: v };
    return this.fail(
      at,
      'E_MODULE',
      `The module variable's initial value has type ${JSON.stringify(have)}, not ${JSON.stringify(want)}`,
    );
  }

  /**
   * The type of an untyped module `let`: of its initialiser and the values
   * assigned to it in its module (nullable where one is null, undefined or
   * missing).
   */
  private untypedVariableType(
    sym: ts.Symbol,
    d: ts.VariableDeclaration,
    init?: ts.Expression,
  ): Type {
    const values: ts.Expression[] = init ? [init] : [];
    let nullable = !init;
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        this.checker.getSymbolAtLocation(n.left) === sym
      )
        values.push(n.right);
      ts.forEachChild(n, visit);
    };
    visit(d.getSourceFile());
    let base: Type | undefined;
    for (const v of values) {
      const x = skipParens(v);
      if (x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined')) {
        nullable = true;
        continue;
      }
      const t = this.exprType(v);
      const inner = maybeInner(t) ?? t;
      nullable ||= inner !== t;
      if (base && !sameType(base, inner))
        return this.fail(
          d,
          'E_MODULE',
          `The module variable ${d.name.getText()} is given values of different types (${JSON.stringify(base)} and ${JSON.stringify(inner)})`,
        );
      base = inner;
    }
    if (!base)
      return this.fail(d, 'E_MODULE', `The module variable ${d.name.getText()} needs a type`);
    return nullable ? { maybe: base } : base;
  }

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

  /**
   * A function value of type `from` where a function of type `to` taking
   * more parameters is expected (JavaScript ignores extra arguments, as when
   * `onOpenChange = noop` defaults a `(value: boolean) => void` prop): a
   * closure calling it with the leading arguments. Undefined where no such
   * adaptation applies.
   */
  adaptFunction(v: Expr, from: Type, to: Type): Expr | undefined {
    if (typeof from !== 'object' || !('fn' in from) || typeof to !== 'object' || !('fn' in to))
      return undefined;
    const f = from.fn;
    const t = to.fn;
    // Fewer parameters, a result where none is expected (it is discarded),
    // or no result where a nullable one is expected (`() => void |
    // Promise<void>` callbacks: undefined).
    const undefinedResult = f.result === 'void' && maybeInner(t.result) !== undefined;
    // (A result where a nullable one is expected: `() => this.opts.strategy.current`
    // for a getter of an optional value.)
    const widened =
      maybeInner(t.result) !== undefined &&
      maybeInner(f.result) === undefined &&
      sameType(f.result, maybeInner(t.result)!);
    if (
      f.params.length > t.params.length ||
      (f.params.length === t.params.length &&
        !(t.result === 'void' && f.result !== 'void') &&
        !undefinedResult &&
        !widened)
    )
      return undefined;
    if (!f.params.every((p, i) => sameType(p, t.params[i]))) return undefined;
    if (!(sameType(f.result, t.result) || t.result === 'void' || undefinedResult || widened))
      return undefined;
    const call: Expr = {
      op: 'call-value',
      callee: { op: 'local', local: 0 },
      args: f.params.map((_, i) => ({ op: 'local', local: i + 1 }) as Expr),
    };
    const adapter = this.reserve();
    this.functions[adapter] = {
      name: 'adapted',
      captures: [{ name: 'fn', type: from }],
      params: t.params.map((p, i) => ({ name: `arg${i}`, type: p })),
      locals: [],
      result: t.result,
      body:
        t.result === 'void'
          ? [{ op: 'expr', value: call }]
          : undefinedResult
            ? [
                { op: 'expr', value: call },
                { op: 'return', value: { op: 'undefined', type: t.result } },
              ]
            : widened
              ? [{ op: 'return', value: { op: 'some', value: call } }]
              : [{ op: 'return', value: call }],
    };
    const make = this.reserve();
    this.functions[make] = {
      name: 'adapt',
      params: [{ name: 'fn', type: from }],
      locals: [],
      result: to,
      body: [{ op: 'return', value: { op: 'closure', function: adapter, captures: [0] } }],
    };
    return { op: 'call', function: make, args: [v] };
  }

  /** Lower `e` and widen it to `target` (T into Maybe<T>, a class instance into a class reference). */
  /**
   * `v` (of plain record type `t`, from `e`) as a record of type `target`
   * whose fields are some of `t`'s, of the same types: a copy of those
   * fields. JavaScript passes the same object; the copy behaves the same
   * where no code replaces those fields (options holding boxes, which both
   * share) and no code compares such objects by identity, both checked
   * over the program by TypeScript's types of `e` and of its context.
   */
  private recordView(
    e: ts.Expression,
    v: Expr,
    t: Type,
    target: Type,
    b: FnBuilder,
  ): Expr | undefined {
    const rec = (x: Type) => (typeof x === 'object' && 'record' in x ? x.record : undefined);
    const from = rec(t);
    const to = rec(target);
    if (from === undefined || to === undefined || from === to) return undefined;
    const rf = this.types.records[from];
    const rt = this.types.records[to];
    if (rf.class || rt.class || this.types.accessors.has(from) || this.types.accessors.has(to))
      return undefined;
    const index = rt.fields.map(f => rf.fields.findIndex(g => g.name === f.name));
    if (
      index.some(
        (j, i) => j < 0 || JSON.stringify(rf.fields[j].type) !== JSON.stringify(rt.fields[i].type),
      )
    )
      return undefined;
    // The TypeScript types involved: `e`'s and the context's.
    const loose = (x: ts.Type) => !!(x.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    const types = [this.checker.getTypeAtLocation(e), this.checker.getContextualType(e)].filter(
      (x): x is ts.Type => !!x && !loose(x),
    );
    if (!types.length) return undefined;
    const names = new Set(rt.fields.map(f => f.name));
    const ofTypes = (x: ts.Expression) => {
      const xt = this.checker.getTypeAtLocation(x);
      if (loose(xt) || !(xt.flags & ts.TypeFlags.Object)) return false;
      return types.some(
        y => this.checker.isTypeAssignableTo(xt, y) && this.checker.isTypeAssignableTo(y, xt),
      );
    };
    let unsafe: ts.Node | undefined;
    const K = ts.SyntaxKind;
    for (const sf of this.program.getSourceFiles()) {
      if (sf.isDeclarationFile || unsafe) continue;
      const visit = (n: ts.Node) => {
        if (unsafe) return;
        if (ts.isBinaryExpression(n)) {
          const op = n.operatorToken.kind;
          if (
            op >= K.FirstAssignment &&
            op <= K.LastAssignment &&
            ts.isPropertyAccessExpression(n.left) &&
            names.has(n.left.name.text) &&
            ofTypes(n.left.expression)
          )
            unsafe = n;
          if (
            [
              K.EqualsEqualsEqualsToken,
              K.ExclamationEqualsEqualsToken,
              K.EqualsEqualsToken,
              K.ExclamationEqualsToken,
            ].includes(op) &&
            (ofTypes(n.left) || ofTypes(n.right))
          )
            unsafe = n;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    if (unsafe) return undefined;
    const local = b.local('$view', t);
    return {
      op: 'with',
      local,
      value: v,
      body: {
        op: 'record',
        record: to,
        fields: index.map(j => ({ op: 'get', object: { op: 'local', local }, field: j }) as Expr),
      },
    };
  }

  coerce(e: ts.Expression, b: FnBuilder, target: Type): Expr {
    // A `null` or `undefined` literal where a nullable value is expected:
    // that value of the target type (its own type, only null, has none).
    const bare = skipParens(e);
    if (maybeInner(target) !== undefined) {
      if (bare.kind === ts.SyntaxKind.NullKeyword) return { op: 'null', type: target };
      if (ts.isIdentifier(bare) && bare.text === 'undefined' && !this.binding(bare))
        return { op: 'undefined', type: target };
    }
    // A prop that every site leaves undefined (or null), cast to another
    // type (bits-ui's `virtualEl as unknown as Measurable | null`): that
    // value of the target type (reading a prop has no effect).
    const cast = skipParens(e);
    if (cast !== e && ts.isIdentifier(cast) && maybeInner(target) !== undefined && this.domains) {
      const sym = this.symbol(cast);
      const values = sym && this.domains.values(sym);
      const castType = this.types.typeOrUndefined(e);
      if (values?.length && castType !== undefined) {
        const declared = this.types.typeOrUndefined(cast);
        if (declared === undefined || !sameType(declared, castType)) {
          if (values.every(x => x === undefined)) return { op: 'undefined', type: target };
          if (values.every(x => x === null)) return { op: 'null', type: target };
        }
      }
    }
    const v = this.expr(e, b);
    const t = this.irType(v, b);
    // A record where a record of some of its fields is expected (bits-ui's
    // `new MenuItemSharedState(opts, …)` of the combined item options): a
    // view of those fields (`recordView`).
    const view = this.recordView(e, v, t, target, b);
    if (view) return view;
    // An event's `currentTarget` where an element is expected (bits-ui's
    // `isFocusVisible(e.currentTarget)` in a listener, where it is the
    // listener's element): null after the dispatch, a TypeError as soon as
    // it is used as one.
    if (
      target === 'element' &&
      JSON.stringify(t) === JSON.stringify({ maybe: 'element' }) &&
      ts.isPropertyAccessExpression(bare) &&
      bare.name.text === 'currentTarget' &&
      this.irType(this.expr(bare.expression, b), b) === 'event'
    )
      return { op: 'unwrap', value: v };
    // A nullable value where one holding nothing but null and undefined is
    // expected (bits-ui's tooltip snippet: `payload: rootState.activePayload
    // as [T] extends [never] ? null : T | null`): null and undefined pass;
    // another value breaks the types, which throws a TypeError (`unwrap`,
    // as other broken types do: `presentIn`).
    if (
      JSON.stringify(target) === JSON.stringify({ maybe: 'void' }) &&
      maybeInner(t) !== undefined &&
      maybeInner(t) !== 'void'
    ) {
      const tmp = b.local('$nothing', t);
      const read: Expr = { op: 'local', local: tmp };
      return {
        op: 'with',
        local: tmp,
        value: v,
        body: {
          op: 'cond',
          test: { op: 'builtin', name: 'maybe.is-null', args: [read], type: BOOLEAN },
          then: { op: 'null', type: target },
          else: {
            op: 'cond',
            test: { op: 'builtin', name: 'maybe.is-undefined', args: [read], type: BOOLEAN },
            then: { op: 'undefined', type: target },
            else: {
              op: 'with',
              local: b.local('$broken', 'void'),
              value: { op: 'unwrap', value: { op: 'undefined', type: target } },
              body: { op: 'undefined', type: target },
            },
          },
        },
      };
    }
    // A nullable value TypeScript narrowed to its value (`if (o.x) f(o.x)`).
    const inner = maybeInner(t);
    if (inner !== undefined && sameType(inner, target)) {
      const ts0 = this.checker.getTypeAtLocation(e);
      if (
        !(ts0.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
        this.checker.getNonNullableType(ts0) === ts0
      )
        return { op: 'unwrap', value: v };
    }
    // A plain object where an attribute bag is expected (bits-ui's
    // `{ props: focusScopeState.props }` for a snippet's bag): a bag of its
    // properties.
    if (
      target === 'attrs' &&
      typeof t === 'object' &&
      'record' in t &&
      !this.types.records[t.record].class
    )
      return this.bagOf(v, t, e, b);
    // A filter result narrowed to present elements where nullable ones are
    // expected (a record typed by TypeScript, which does not see an untyped
    // predicate: bits-ui's `boundary: this.#boundary.filter(isNotNull)`):
    // the filter's own result.
    if (
      v.op === 'builtin' &&
      v.name === 'array.map' &&
      v.args[1]?.op === 'closure' &&
      this.functions[v.args[1].function]?.name === 'filter$narrowed' &&
      sameType(this.irType(v.args[0], b), target)
    )
      return v.args[0];
    // A nullable value whose present values TypeScript narrowed away here
    // (bits-ui's `Array.isArray(b) ? b : [b]` of a nullable array: `b` in
    // the second branch): its nullish value, of the expected type.
    const ti = maybeInner(t);
    const wi = maybeInner(target);
    if (ti !== undefined && wi !== undefined && !sameType(ti, wi)) {
      const here = this.checker.getTypeAtLocation(e);
      const mapped =
        here.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
          ? undefined
          : this.types.tryMap(here, e);
      if (mapped !== undefined && sameType(maybeInner(mapped) ?? mapped, wi)) {
        const local = b.local('$narrowed', t);
        const read: Expr = { op: 'local', local };
        return {
          op: 'with',
          local,
          value: v,
          body: {
            op: 'cond',
            test: { op: 'builtin', name: 'maybe.is-null', args: [read], type: BOOLEAN },
            then: { op: 'null', type: target },
            else: {
              op: 'cond',
              test: { op: 'builtin', name: 'maybe.is-undefined', args: [read], type: BOOLEAN },
              then: { op: 'undefined', type: target },
              else: this.unsupportedValue(
                'narrowed',
                target,
                'a value of a type TypeScript narrowed away where it is read',
              ),
            },
          },
        };
      }
    }
    // A function with properties where a function is expected: its function.
    const fnTarget = maybeInner(target) ?? target;
    if (typeof fnTarget === 'object' && 'fn' in fnTarget && this.functionOf(v, b) !== v) {
      const f = this.functionOf(v, b);
      const ft = this.irType(f, b);
      const adapted = sameType(ft, fnTarget) ? f : this.adaptFunction(f, ft, fnTarget);
      if (adapted) return maybeInner(target) ? { op: 'some', value: adapted } : adapted;
    }
    // A function where a function of another (compatible) type is expected.
    if (!sameType(t, target)) {
      const adapted = this.adaptFunction(v, t, maybeInner(target) ?? target);
      if (adapted) return maybeInner(target) ? { op: 'some', value: adapted } : adapted;
    }
    const merged = this.toMerged(e, v, t, target, b);
    if (merged) return merged;
    return this.classes.fitAt(v, t, target, e);
  }

  /**
   * A plain record passed where a merged record (frontend/types.ts
   * `mergeRecords`) is expected: a copy holding its fields, where nothing
   * else can see the original (a `const` read only here: bits-ui's
   * `new ToggleGroupMultipleState(rest)`), so the copy's identity is
   * unobservable.
   */
  private toMerged(
    e: ts.Expression,
    v: Expr,
    have: Type,
    want: Type,
    b: FnBuilder,
  ): Expr | undefined {
    if (
      typeof have !== 'object' ||
      !('record' in have) ||
      typeof want !== 'object' ||
      !('record' in want) ||
      have.record === want.record ||
      !this.types.merged.has(want.record) ||
      this.types.records[have.record].class
    )
      return undefined;
    const id = skipParens(e);
    const sym = ts.isIdentifier(id) ? this.symbol(id) : undefined;
    const decl = sym?.valueDeclaration;
    let list: ts.Node | undefined = decl;
    while (list && !ts.isVariableDeclarationList(list)) list = list.parent;
    const constant = !!list && !!((list as ts.VariableDeclarationList).flags & ts.NodeFlags.Const);
    let scope: ts.Node | undefined = list;
    while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    const reads: ts.Node[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n !== (decl as ts.NamedDeclaration).name && this.symbol(n) === sym)
        reads.push(n);
      ts.forEachChild(n, visit);
    };
    if (scope && sym) visit(scope);
    // Read once, or once in each branch of one conditional (`c ? new A(o) : new B(o)`).
    const within = (n: ts.Node, root: ts.Node) => {
      for (let p: ts.Node | undefined = n; p; p = p.parent) if (p === root) return true;
      return false;
    };
    let branches = false;
    if (reads.length === 2)
      for (let p = reads[0].parent; p; p = p.parent)
        if (ts.isConditionalExpression(p) && within(reads[1], p)) {
          branches =
            (within(reads[0], p.whenTrue) && within(reads[1], p.whenFalse)) ||
            (within(reads[0], p.whenFalse) && within(reads[1], p.whenTrue));
          break;
        }
    if (!constant || !(reads.length === 1 || branches))
      return this.fail(
        e,
        'E_OBJECT',
        'An object passed as another options type is copied, which only a const read once can be',
      );
    const src = this.types.records[have.record];
    const tmp = b.local('$copy', have);
    const fields = this.types.records[want.record].fields.map((f): Expr => {
      const j = src.fields.findIndex(s => s.name === f.name);
      if (j < 0) {
        if (maybeInner(f.type)) return { op: 'undefined', type: f.type };
        return this.fail(e, 'E_OBJECT', `The object has no ${f.name} for its options type`);
      }
      const value: Expr = { op: 'get', object: { op: 'local', local: tmp }, field: j };
      const out = this.classes.fit(value, src.fields[j].type, f.type);
      if (out === value && !sameType(src.fields[j].type, f.type))
        return this.fail(
          e,
          'E_OBJECT',
          `The object's ${f.name} has another type than its options type's`,
        );
      return out;
    });
    return {
      op: 'with',
      local: tmp,
      value: v,
      body: { op: 'record', record: want.record, fields },
    };
  }

  private contextual(e: ts.Expression): Type {
    // A branch of a conditional without a usable contextual type (an
    // untyped `const`, or a prop typed wider than the value model, such as
    // svelte/elements' `class`): the conditional's type.
    const conditional = () => {
      let node: ts.Node = e;
      while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
      const p = node.parent;
      return ts.isConditionalExpression(p) && p.condition !== node
        ? this.checker.getTypeAtLocation(p)
        : undefined;
    };
    const t = this.checker.getContextualType(e);
    // Untyped JavaScript: the type expected here, or, for a returned
    // `undefined` or `null`, the type of the other values the function
    // returns (`unifyReturns`; `void` until then).
    // (Also a type of only null or undefined: an untyped field declared
    // null that code sets elsewhere, which an assignment of null expects.)
    const F = ts.TypeFlags;
    if (t && t.flags & (F.Any | F.Unknown | F.Null | F.Undefined | F.Void)) {
      let node: ts.Node = e;
      while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
      const want = this.expected.get(node);
      if (want !== undefined) return maybeInner(want) ? want : { maybe: want };
      if (ts.isReturnStatement(node.parent) && t.flags & (F.Any | F.Unknown)) return 'void';
    }
    const alternative = conditional();
    if (!t && !alternative) return { maybe: NUMBER };
    const mapped =
      (t && alternative ? this.types.tryMap(t, e) : undefined) ??
      (alternative ? this.types.map(alternative, e) : this.types.map(t!, e));
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
    if (!binding && this.intlObject(id))
      return this.fail(
        id,
        'E_INTL',
        `${id.text} is an Intl constant: use its methods (format, compare) directly`,
      );
    if (!binding && this.checker.getSymbolAtLocation(id)?.declarations?.some(ts.isNamespaceImport))
      return this.fail(
        id,
        'E_IMPORT',
        `${id.text} is a namespace import: namespaces are supported as component tags (<${id.text}.Name>) and re-exports; import the names the code uses`,
      );
    if (!binding)
      return this.fail(id, 'E_UNRESOLVED', `${id.text} is not a supported binding here`);
    return this.bindingExpr(binding, id, b);
  }

  /** The expression reading `binding` at `id` (narrowed to the type TypeScript sees there). */
  bindingExpr(binding: Binding, id: ts.Identifier, b: FnBuilder, here?: Type): Expr {
    // TypeScript narrows `T | undefined` to `T` after checks; unwrap there.
    const narrow = (e: Expr, declared: Type): Expr => {
      // An untyped local a test proved present (`presentIn`).
      if (maybeInner(declared) && this.knownPresent(id)) return { op: 'unwrap', value: e };
      const own = this.symbol(id);
      if (own && this.widened.has(own)) return e;
      // (An operand of a comparison with null or undefined: the test reads
      // the value as it is, `itemIndex === undefined`.)
      {
        let at: ts.Node = id;
        while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
        const p = at.parent;
        const K = ts.SyntaxKind;
        const nullish = (x: ts.Expression) => {
          x = skipParens(x);
          return (
            x.kind === K.NullKeyword ||
            (ts.isIdentifier(x) && x.text === 'undefined' && !this.binding(x))
          );
        };
        if (
          ts.isBinaryExpression(p) &&
          [
            K.EqualsEqualsEqualsToken,
            K.ExclamationEqualsEqualsToken,
            K.EqualsEqualsToken,
            K.ExclamationEqualsToken,
          ].includes(p.operatorToken.kind) &&
          (nullish(p.left) || nullish(p.right))
        )
          return e;
      }
      // (An attribute bag is not narrowed: TypeScript's type of merged
      // props says nothing about it.)
      if (declared === 'attrs') return e;
      here ??= this.types.typeOrUndefined(id);
      if (here === undefined) return e;
      const unwrap =
        typeof declared === 'object' &&
        'maybe' in declared &&
        !(typeof here === 'object' && 'maybe' in here) &&
        here !== 'void';
      const out: Expr = unwrap ? { op: 'unwrap', value: e } : e;
      // A class reference narrowed to some of its classes (instanceof, discriminants).
      return this.classes.narrow(out, unwrap ? maybeInner(declared)! : declared, here);
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
      case 'cell': {
        const declared = this.hooks.cellType(binding.cell);
        // A rest-props bag has no narrower type (its TypeScript type, such as
        // svelte/elements' attribute interfaces, is not a value type).
        if (declared === 'attrs') return this.hooks.readCell(binding.cell, b, id);
        return narrow(this.hooks.readCell(binding.cell, b, id), declared);
      }
      case 'derived':
        return { op: 'call', function: binding.fn, args: [] };
      case 'module-let': {
        const e: Expr = { op: 'get', object: { op: 'global', global: binding.global }, field: 0 };
        return narrow(e, this.moduleVariableType(binding.global));
      }
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
      case 'pack':
        return this.fail(
          id,
          'E_PACK',
          binding.call
            ? `${binding.label} is supported in direct calls only`
            : `${binding.label} is a component: use it as a template tag`,
        );
      case 'generic':
        return this.fail(
          id,
          'E_FUNCTION',
          `${id.text} has untyped parameters, so it can only be called directly; add parameter types to pass it as a value`,
        );
      case 'rest':
        return this.fail(
          id,
          'E_FUNCTION',
          `${id.text} is a rest parameter of a callback: spread it into a call (f(...${id.text}))`,
        );
      case 'host':
        return this.fail(
          id,
          'E_FUNCTION',
          `${id.text} returns the ${binding.name}: call it where the ${binding.name} is used (its members, on(…))`,
        );
      case 'class':
        return this.fail(
          id,
          'E_CLASS',
          `The class ${id.text} is not a value (construct it with new, or use its static members)`,
        );
      case 'constant':
        return this.constantExpr(binding.value, binding.label, id);
    }
  }

  /**
   * `x.style.prop` on an element `x`: the element and the CSS property the
   * camelCase name stands for (`transitionDuration` → `transition-duration`,
   * `WebkitX` → `-webkit-x`, `cssFloat` → `float`).
   */
  private elementStyle(
    e: ts.PropertyAccessExpression,
    b: FnBuilder,
  ): { element: Expr; property: string } | undefined {
    const inner = skipParens(e.expression);
    if (!ts.isPropertyAccessExpression(inner) || inner.name.text !== 'style') return undefined;
    if (this.types.typeOrUndefined(inner.expression) !== 'element') return undefined;
    const name = e.name.text;
    if (['cssText', 'length', 'parentRule', 'cssFloat'].includes(name) && name !== 'cssFloat')
      return this.fail(e, 'E_MEMBER', `style.${name} is unsupported (style properties are)`);
    const property =
      name === 'cssFloat'
        ? 'float'
        : name
            .replace(/^[A-Z]/, c => '-' + c.toLowerCase())
            .replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    return { element: this.expr(inner.expression, b), property };
  }

  /** Whether `id` names an object global of the host (frontend/dom.d.ts: `document`, `window`, …). */
  hostGlobal(id: ts.Identifier): boolean {
    const decls = this.checker.getSymbolAtLocation(id)?.declarations ?? [];
    return (
      decls.length > 0 &&
      decls.every(
        d => ts.isVariableDeclaration(d) && path.resolve(d.getSourceFile().fileName) === DOM,
      )
    );
  }

  /**
   * The value of an expression known at build time, or undefined: literals,
   * constants of packs (esm-env's `BROWSER`) and of package modules
   * evaluated at build time, `typeof` of the host's globals (objects in a
   * native app), and `!`, `===`, `!==`, `==`, `!=`, `&&`, `||`, `??` over
   * them. A condition with such a value is folded: the branch it never takes
   * is not lowered (it never runs).
   */
  staticValue(e: ts.Expression): { value: unknown } | undefined {
    e = skipParens(e);
    const K = ts.SyntaxKind;
    if (e.kind === K.TrueKeyword) return { value: true };
    if (e.kind === K.FalseKeyword) return { value: false };
    if (e.kind === K.NullKeyword) return { value: null };
    if (ts.isStringLiteralLike(e)) return { value: e.text };
    if (ts.isNumericLiteral(e)) return { value: Number(e.text) };
    if (ts.isIdentifier(e)) {
      const bound = this.binding(e);
      if (e.text === 'undefined' && !bound) return { value: undefined };
      if (bound?.kind !== 'constant') return undefined;
      const v = bound.value;
      return v === null || ['boolean', 'number', 'string', 'undefined'].includes(typeof v)
        ? { value: v }
        : undefined;
    }
    if (ts.isTypeOfExpression(e)) {
      const operand = skipParens(e.expression);
      return ts.isIdentifier(operand) && this.hostGlobal(operand) ? { value: 'object' } : undefined;
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken) {
      const v = this.staticValue(e.operand);
      return v && { value: !v.value };
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      const l = this.staticValue(e.left);
      if (!l) return undefined;
      if (op === K.AmpersandAmpersandToken) return l.value ? this.staticValue(e.right) : l;
      if (op === K.BarBarToken) return l.value ? l : this.staticValue(e.right);
      if (op === K.QuestionQuestionToken)
        return l.value === null || l.value === undefined ? this.staticValue(e.right) : l;
      const r = this.staticValue(e.right);
      if (!r) return undefined;
      switch (op) {
        case K.EqualsEqualsEqualsToken:
          return { value: l.value === r.value };
        case K.ExclamationEqualsEqualsToken:
          return { value: l.value !== r.value };
        case K.EqualsEqualsToken:
          return { value: l.value == r.value };
        case K.ExclamationEqualsToken:
          return { value: l.value != r.value };
      }
      if (typeof l.value === 'number' && typeof r.value === 'number')
        switch (op) {
          case K.GreaterThanToken:
            return { value: l.value > r.value };
          case K.GreaterThanEqualsToken:
            return { value: l.value >= r.value };
          case K.LessThanToken:
            return { value: l.value < r.value };
          case K.LessThanEqualsToken:
            return { value: l.value <= r.value };
        }
    }
    // The platform (M6 overlays: bits-ui's isIOS): the runtime's user agent
    // (builds target the platform they run on) and no touch points.
    if (ts.isPropertyAccessExpression(e) && this.hostName(e.expression) === 'navigator') {
      if (e.name.text === 'userAgent') return { value: platformUserAgent() };
      if (e.name.text === 'maxTouchPoints') return { value: 0 };
    }
    if (ts.isCallExpression(e) && !e.arguments.some(ts.isSpreadElement)) {
      const callee = skipParens(e.expression);
      // A literal pattern's `test` of a constant string (ECMAScript's
      // semantics, as here).
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'test' &&
        ts.isRegularExpressionLiteral(skipParens(callee.expression)) &&
        e.arguments.length === 1
      ) {
        const arg = this.staticValue(e.arguments[0]);
        if (!arg || typeof arg.value !== 'string') return undefined;
        const text = skipParens(callee.expression).getText();
        const end = text.lastIndexOf('/');
        const re = new RegExp(text.slice(1, end), text.slice(end + 1));
        return { value: re.test(arg.value) };
      }
      // A function without parameters returning one expression known at
      // build time (bits-ui's `getIsIOS()`).
      if (ts.isIdentifier(callee) && !e.arguments.length) {
        const decl = this.symbol(callee)?.valueDeclaration;
        const ret =
          decl &&
          ts.isFunctionDeclaration(decl) &&
          !decl.parameters.length &&
          decl.body?.statements.length === 1 &&
          ts.isReturnStatement(decl.body.statements[0])
            ? decl.body.statements[0].expression
            : undefined;
        if (ret && !this.staticCalls.has(decl!)) {
          this.staticCalls.add(decl!);
          try {
            return this.staticValue(ret);
          } finally {
            this.staticCalls.delete(decl!);
          }
        }
      }
    }
    return undefined;
  }

  private readonly staticCalls = new Set<ts.Node>();

  /** A value computed at build time as an IR literal (strings, numbers, booleans, undefined). */
  constantExpr(value: unknown, label: string, at: ts.Node): Expr {
    if (typeof value === 'string' || typeof value === 'boolean') return { op: 'lit', value };
    if (typeof value === 'number' && Number.isFinite(value)) return { op: 'lit', value };
    if (value === undefined) return { op: 'undefined', type: this.contextual(at as ts.Expression) };
    return this.fail(
      at,
      'E_CONST',
      `${label} is evaluated at build time; only its string, number and boolean members can be used`,
    );
  }

  /** The build-time value of `e` if it reads a member of a build-time constant (`attrs.root`). */
  constantMember(e: ts.Expression): { value: unknown; label: string } | undefined {
    e = skipParens(e);
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    const b = this.binding(e.expression);
    if (b?.kind !== 'constant') return undefined;
    const object = b.value;
    if (!object || typeof object !== 'object' || !Object.hasOwn(object, e.name.text))
      return this.fail(e, 'E_CONST', `${b.label} has no member ${e.name.text}`);
    return {
      value: (object as Record<string, unknown>)[e.name.text],
      label: `${b.label}.${e.name.text}`,
    };
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
      // A left operand known at build time decides which operand is the
      // value; the other is never evaluated, so it is not lowered.
      const known = this.staticValue(e.left);
      if (known) {
        const and = op === K.AmpersandAmpersandToken;
        if (and ? !known.value : !!known.value)
          return this.constantExpr(known.value, e.left.getText(), e.left);
        const right = this.expr(e.right, b);
        const rt = this.irType(right, b);
        const result = this.types.typeOrUndefined(e) ?? rt;
        return maybeInner(result) && !maybeInner(rt) && rt !== 'void'
          ? { op: 'some', value: right }
          : right;
      }
      const left = this.expr(e.left, b);
      const lt = this.irType(left, b);
      // `x || null` in untyped JavaScript: null of the left operand's
      // nullable type.
      const r0 = skipParens(e.right);
      const nothing =
        r0.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(r0) && r0.text === 'undefined' && !this.binding(r0));
      if (
        nothing &&
        lt !== 'void' &&
        this.checker.getContextualType(r0)?.flags !== undefined &&
        this.checker.getContextualType(r0)!.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
      ) {
        const m: Type = maybeInner(lt) ? lt : { maybe: lt };
        this.expected.set(r0, m);
      }
      let right = this.expr(e.right, b);
      const rt = this.irType(right, b);
      // The result type: TypeScript's (narrowed) type, or the operands' common type.
      const ts0 = this.types.typeOrUndefined(e);
      let result: Type =
        ts0 ?? (sameType(lt, rt) ? lt : maybeInner(lt) && sameType(maybeInner(lt)!, rt) ? rt : rt);
      // A nullable right operand TypeScript deems unreachable (a left typed
      // truthy, which a getter of an optional property may yet not be).
      if (!maybeInner(result) && maybeInner(rt) && sameType(maybeInner(rt)!, result)) result = rt;
      if (maybeInner(result) && !maybeInner(rt) && rt !== 'void')
        right = { op: 'some', value: right };
      if (lt === 'boolean' && rt === 'boolean')
        return { op: op === K.AmpersandAmpersandToken ? 'and' : 'or', left, right };
      // JS value semantics: evaluate the left operand once.
      const tmp = b.local('$logical', lt);
      const read: Expr = { op: 'local', local: tmp };
      // `a || b` keeps a truthy `a`, which is not nullish.
      const keep: Expr = sameType(lt, result)
        ? read
        : op === K.BarBarToken && maybeInner(lt) && sameType(maybeInner(lt)!, result)
          ? { op: 'unwrap', value: read }
          : { op: 'some', value: read };
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
      // A left operand that only holds null or undefined (a prop no site
      // passes, frontend/unions.ts): the right one.
      if (this.unions.nothing(e.left)) {
        const right = this.coerce(
          e.right,
          b,
          this.types.typeOrUndefined(e) ?? this.irType(this.expr(e.right, b), b),
        );
        return right;
      }
      const left = this.expr(e.left, b);
      const lt = this.irType(left, b);
      // A left operand that is never nullish (a prop with a default) is the
      // value; the right one is not evaluated.
      if (!maybeInner(lt) && lt !== 'void') return left;
      // A left operand that holds nothing but null or undefined (bits-ui's
      // tooltip payload): the right one, after the left is read.
      if (JSON.stringify(lt) === JSON.stringify({ maybe: 'void' })) {
        const tmp = b.local('$nothing', lt);
        const want = this.types.typeOrUndefined(e);
        const right = want === undefined ? this.expr(e.right, b) : this.coerce(e.right, b, want);
        return { op: 'with', local: tmp, value: left, body: right };
      }
      const result = this.types.typeOrUndefined(e) ?? maybeInner(lt) ?? 'void';
      // (An untyped literal takes the left operand's type.)
      const r0 = skipParens(e.right);
      if (
        (ts.isArrayLiteralExpression(r0) || ts.isObjectLiteralExpression(r0)) &&
        !this.expected.has(r0)
      )
        this.expected.set(r0, maybeInner(result) ?? result);
      const right = this.coerce(e.right, b, result);
      const rt = this.irType(right, b);
      if (
        !sameType(rt, result) &&
        !sameType({ maybe: rt }, result) &&
        !sameType(rt, maybeInner(lt) ?? lt)
      )
        return this.fail(
          e,
          'E_TYPE_UNION',
          `The sides of ?? have different types (${JSON.stringify(maybeInner(lt) ?? lt)} and ${JSON.stringify(rt)})`,
        );
      return { op: 'nullish', left, right };
    }
    if (op === K.InstanceOfKeyword && ts.isIdentifier(e.right)) {
      const cls = this.binding(e.right);
      if (cls?.kind === 'class') return this.classes.instanceOf(cls.cls, e.left, b);
      // bits-ui's isHTMLElement: an element value is an HTMLElement unless it
      // is in the SVG namespace (an event target).
      // Every element value is an Element (and a Node).
      const global = this.hostName(e.right);
      // An event's interface, as Chromium creates it for its type (M6
      // overlays: bits-ui's `e instanceof PointerEvent`).
      if (global && EVENT_INTERFACES.includes(global)) {
        const v = this.expr(e.left, b);
        if (this.irType(v, b) !== 'event')
          return this.fail(e, 'E_EXPRESSION', `instanceof ${global} tests event values`);
        return {
          op: 'builtin',
          name: 'event.instance-of',
          args: [v, { op: 'lit', value: global }],
          type: BOOLEAN,
        };
      }
      if (
        global === 'HTMLElement' ||
        global === 'Element' ||
        global === 'Node' ||
        global === 'SVGElement' ||
        global === 'Document' ||
        global === 'HTMLInputElement'
      ) {
        const v = this.expr(e.left, b);
        const t = this.irType(v, b);
        const nullable = JSON.stringify(t) === JSON.stringify({ maybe: 'element' });
        if (t !== 'element' && !nullable)
          return this.fail(e, 'E_EXPRESSION', `instanceof ${global} tests element values`);
        // (An element value may be an event target that is the document or
        // the window: a window `scroll` listener's `e.target` is the document.)
        const is = (name: string, x: Expr): Expr => ({
          op: 'builtin',
          name: `element.${name}`,
          args: [x],
          type: BOOLEAN,
        });
        const test = (x: Expr): Expr => {
          if (global === 'HTMLElement') return is('isHTML', x);
          // (An input: an HTML element named `input`, bits-ui's isSelectableInput.)
          if (global === 'HTMLInputElement') {
            const local = b.local('$element', 'element');
            const read: Expr = { op: 'local', local };
            return {
              op: 'with',
              local,
              value: x,
              body: {
                op: 'and',
                left: is('isHTML', read),
                right: {
                  op: 'eq',
                  left: { op: 'builtin', name: 'element.localName', args: [read], type: STRING },
                  right: { op: 'lit', value: 'input' },
                },
              },
            };
          }
          if (global === 'Document') return is('isDocument', x);
          if (global === 'Element') return is('isElement', x);
          const local = b.local('$element', 'element');
          const read: Expr = { op: 'local', local };
          return {
            op: 'with',
            local,
            value: x,
            body:
              global === 'SVGElement'
                ? {
                    op: 'and',
                    left: is('isElement', read),
                    right: { op: 'not', arg: is('isHTML', read) },
                  }
                : { op: 'or', left: is('isElement', read), right: is('isDocument', read) },
          };
        };
        if (!nullable) return test(v);
        const local = b.local('$element', t);
        const read: Expr = { op: 'local', local };
        return {
          op: 'with',
          local,
          value: v,
          body: {
            op: 'cond',
            test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: BOOLEAN },
            then: { op: 'lit', value: false },
            else: test({ op: 'unwrap', value: read }),
          },
        };
      }
    }
    // `"button" in event` (M6 overlays: bits-ui's dismissible layer): whether
    // the event's interface has the member.
    if (op === K.InKeyword && ts.isStringLiteralLike(e.left)) {
      const v = this.expr(e.right, b);
      if (this.irType(v, b) === 'event') {
        const owner = EVENT_MEMBER_INTERFACES[e.left.text];
        if (!owner)
          return this.fail(e, 'E_EXPRESSION', `"${e.left.text}" in an event is unsupported`);
        return {
          op: 'builtin',
          name: 'event.instance-of',
          args: [v, { op: 'lit', value: owner }],
          type: BOOLEAN,
        };
      }
    }
    // `"select" in element` (bits-ui's isSelectableInput): inputs and text
    // areas have select().
    if (op === K.InKeyword && ts.isStringLiteralLike(e.left) && e.left.text === 'select') {
      const v = this.expr(e.right, b);
      if (this.irType(v, b) === 'element') {
        const local = b.local('$element', 'element');
        const name: Expr = {
          op: 'builtin',
          name: 'element.localName',
          args: [{ op: 'local', local }],
          type: STRING,
        };
        return {
          op: 'with',
          local,
          value: v,
          body: {
            op: 'or',
            left: { op: 'eq', left: name, right: { op: 'lit', value: 'input' } },
            right: { op: 'eq', left: name, right: { op: 'lit', value: 'textarea' } },
          },
        };
      }
    }
    if (op === K.InKeyword || op === K.InstanceOfKeyword)
      return this.fail(e, 'E_EXPRESSION', 'in/instanceof are planned for later');
    // An array element compared for equality: undefined past the end
    // (`items[0] === node` with no items), not a RangeError.
    const equality = [
      K.EqualsEqualsEqualsToken,
      K.ExclamationEqualsEqualsToken,
      K.EqualsEqualsToken,
      K.ExclamationEqualsToken,
    ].includes(op);
    const operand = (x: ts.Expression): Expr => {
      const v = this.expr(x, b);
      if (!equality || v.op !== 'index') return v;
      const el = (this.irType(v.array, b) as { array: Type }).array;
      return { op: 'builtin', name: 'array.get', args: [v.array, v.index], type: { maybe: el } };
    };
    const left = operand(e.left);
    const right = operand(e.right);
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
    // Class instances compare as their common class type.
    const joined = this.classes.join(lt, rt);
    if (joined)
      return {
        op: 'eq',
        left: this.classes.fit(left, lt, joined),
        right: this.classes.fit(right, rt, joined),
      };
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
    if (t === 'date') return 'date';
    if (t === 'animation') return 'animation';
    if (typeof t === 'object') {
      if ('array' in t) return 'array';
      if ('map' in t) return 'map';
      if ('set' in t) return 'set';
      if ('maybe' in t) return 'maybe';
      if ('record' in t) return 'record';
      if ('class' in t || 'classes' in t) return 'class';
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

  /**
   * A promise a listener returns, as Vue's callWithAsyncErrorHandling treats
   * it: `p.then(() => {}, err => console.error(err))` (production logError),
   * so a rejection is logged, not reported as unhandled. Chromium shows the
   * error with its stack (from Vue's code); the line here is `Name: message`.
   */
  loggedRejection(p: Expr, component: number | undefined): Expr {
    const fn = (name: string, params: Local[], body: Stmt[]): Expr => {
      const index = this.reserve();
      this.functions[index] = {
        name,
        ...(component !== undefined ? { component } : {}),
        params,
        locals: [],
        result: VOID,
        body,
      };
      return { op: 'closure', function: index, captures: [] };
    };
    const error: Expr = { op: 'local', local: 0 };
    const name: Expr = { op: 'get', object: error, field: 0 };
    const message: Expr = { op: 'get', object: error, field: 1 };
    const text: Expr = {
      op: 'cond',
      test: { op: 'eq', left: message, right: lit('') },
      then: name,
      else: { op: 'concat', left: name, right: { op: 'concat', left: lit(': '), right: message } },
    };
    const log: Stmt = {
      op: 'expr',
      value: { op: 'builtin', name: 'console.error', args: [text], type: VOID },
    };
    return {
      op: 'builtin',
      name: 'promise.then',
      args: [
        p,
        fn('listener.fulfilled', [], []),
        fn('listener.rejected', [{ name: 'err', type: { record: this.errorRecord() } }], [log]),
      ],
      type: { promise: VOID },
    };
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
  /** The host global (`document`, `window`, …) an expression names, if any (`hostName`). */
  hostOf(e: ts.Expression): string | undefined {
    return this.hostName(skipParens(e));
  }

  hostName(e: ts.Expression, depth = 0, declared = false): string | undefined {
    e = skipParens(e);
    if (depth > 8) return undefined;
    // Other names of the window and the document (M6 overlays: bits-ui's
    // `element.ownerDocument.defaultView || window`, svelte-toolbelt's
    // `getWindow(node)` and `getDocument(node)`): an element's owner
    // document is the document (every element is in it or was created by
    // it), its default view the window.
    if (ts.isPropertyAccessExpression(e)) {
      const name = e.name.text;
      const inner = skipParens(e.expression);
      if (name === 'ownerDocument' && this.types.typeOrUndefined(inner) === 'element')
        return 'document';
      if (name === 'defaultView' && this.hostName(inner, depth + 1) === 'document') return 'window';
      if (name === 'ownerDocument' && this.hostName(inner, depth + 1) === 'document')
        return 'document';
      // `window.navigator` (also `window?.navigator`: the window is never nullish).
      if (name === 'navigator' && this.hostName(inner, depth + 1) === 'window') return 'navigator';
      return undefined;
    }
    if (
      ts.isBinaryExpression(e) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        e.operatorToken.kind,
      )
    ) {
      // `node?.ownerDocument ?? document` of a nullable element (bits-ui's
      // getOwnerDocument): the document either way.
      const left = skipParens(e.left);
      if (
        ts.isPropertyAccessExpression(left) &&
        left.questionDotToken &&
        left.name.text === 'ownerDocument' &&
        plainName(left.expression) &&
        JSON.stringify(this.types.typeOrUndefined(skipParens(left.expression))) ===
          JSON.stringify({ maybe: 'element' }) &&
        this.hostName(e.right, depth + 1) === 'document'
      )
        return 'document';
      const l = this.hostName(e.left, depth + 1);
      return l && l === this.hostName(e.right, depth + 1) ? l : undefined;
    }
    // (The argument, a name or a member of one, is not evaluated: reading
    // it has no effect.)
    const plain = (x: ts.Expression): boolean => {
      x = skipParens(x);
      return (
        ts.isIdentifier(x) ||
        x.kind === ts.SyntaxKind.ThisKeyword ||
        (ts.isPropertyAccessExpression(x) && plain(x.expression))
      );
    };
    // (`declared`: the initialiser of a constant, whose declaration
    // evaluates the argument: `const doc = getDocument(a() ?? b())`.)
    if (
      ts.isCallExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.arguments.length === 1 &&
      (declared || plain(e.arguments[0]))
    ) {
      const binding = this.binding(e.expression);
      if (binding?.kind === 'pack' && binding.label.startsWith('getWindow of')) return 'window';
      if (binding?.kind === 'pack' && binding.label.startsWith('getDocument of')) return 'document';
      // A function returning one of them (bits-ui's `getOwnerDocument(el)`:
      // `return el?.ownerDocument ?? document`).
      if (binding?.kind === 'host') return binding.name;
      return undefined;
    }
    // A call of a host function (a function value whose type returns the
    // window or the document: bits-ui's `getWindow()` option) through a
    // plain name: the object. (Host functions only return it, `function`.)
    if (ts.isCallExpression(e) && !e.arguments.length && plain(e.expression)) {
      const sig = this.checker.getResolvedSignature(e);
      const host = sig && this.types.hostOf(sig.getReturnType());
      if (host) return host;
    }
    // svelte-toolbelt's `domContext.getDocument()` and `getWindow()`, of a
    // DOMContext whose node is the program's (the receiver has no effect).
    if (
      ts.isCallExpression(e) &&
      !e.arguments.length &&
      ts.isPropertyAccessExpression(e.expression) &&
      ['getDocument', 'getWindow'].includes(e.expression.name.text) &&
      plain(e.expression.expression) &&
      this.checker.getTypeAtLocation(e.expression.expression).getSymbol()?.name === 'DOMContext'
    )
      return e.expression.name.text === 'getDocument' ? 'document' : 'window';
    if (!ts.isIdentifier(e)) return undefined;
    const s = this.symbol(e);
    const decl = s?.valueDeclaration ?? s?.declarations?.[0];
    if (decl && path.resolve(decl.getSourceFile().fileName) === DOM) return e.text;
    // A parameter every call passes one of them for.
    if (decl && ts.isParameter(decl)) return this.hostParam(decl);
    // A constant holding one of them.
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent) &&
      decl.parent.flags & ts.NodeFlags.Const
    )
      return this.hostName(decl.initializer, depth + 1, true);
    return undefined;
  }

  private hostParams = new Map<ts.ParameterDeclaration, 'document' | 'window' | null>();
  private callIndex?: Map<ts.Node, ts.CallExpression[]>;

  /**
   * Whether `p` is an untyped parameter of a function for which every
   * call of the program passes the document (or every one the window):
   * bits-ui's scroll lock `resetBodyStyle(documentObj)`, called through
   * the object holding it with `const documentObj = document`. The
   * parameter is that object (`hostName`), so the function has no IR
   * parameter for it and its calls pass none (`callArgs`, function types).
   */
  hostParam(p: ts.ParameterDeclaration): 'document' | 'window' | undefined {
    const known = this.hostParams.get(p);
    if (known !== undefined) return known ?? undefined;
    this.hostParams.set(p, null);
    const fn = p.parent;
    const t = this.checker.getTypeAtLocation(p);
    if (
      p.type ||
      p.dotDotDotToken ||
      !ts.isIdentifier(p.name) ||
      !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ||
      !(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn))
    )
      return undefined;
    if (!this.callIndex) {
      this.callIndex = new Map();
      for (const sf of this.program.getSourceFiles()) {
        if (sf.isDeclarationFile) continue;
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n)) {
            const d = this.checker.getResolvedSignature(n)?.declaration;
            if (d) this.callIndex!.set(d, [...(this.callIndex!.get(d) ?? []), n]);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
    const calls = this.callIndex.get(fn) ?? [];
    const i = fn.parameters.indexOf(p);
    const names = calls.map(c => {
      const a = c.arguments[i];
      return a && !ts.isSpreadElement(a) ? this.hostName(a) : undefined;
    });
    const name = names[0];
    if (!calls.length || (name !== 'document' && name !== 'window') || names.some(n => n !== name))
      return undefined;
    this.hostParams.set(p, name);
    return name;
  }

  /** Timer, microtask and clock host calls. */
  hostCall(name: string, e: ts.CallExpression, b: FnBuilder): Expr | undefined {
    const args = e.arguments.map(a => this.expr(a, b));
    const number = (i: number): Expr => args[i] ?? { op: 'lit', value: 0 };
    const builtin = (n: string, a: Expr[], type: Type): Expr => ({
      op: 'builtin',
      name: n,
      args: a,
      type,
    });
    switch (name) {
      // getComputedStyle(element): the element, whose properties are read
      // through getPropertyValue (elementMethod).
      case 'getComputedStyle':
        if (e.arguments.length !== 1)
          return this.fail(e, 'E_CALL', 'getComputedStyle takes an element (no pseudo-element)');
        return this.coerce(e.arguments[0], b, 'element');
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

  /**
   * Host-service calls (docs/design/M5-PLATFORM.md): console, the
   * clipboard, session history and randomness. Undefined for other calls.
   */
  private hostServiceCall(
    e: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    b: FnBuilder,
  ): Expr | undefined {
    const method = callee.name.text;
    const owner = skipParens(callee.expression);
    const host = this.hostName(owner);
    const builtin = (name: string, args: Expr[], type: Type): Expr => ({
      op: 'builtin',
      name,
      args,
      type,
    });
    const noSpread = () => {
      const s = e.arguments.find(ts.isSpreadElement);
      if (s) this.fail(s, 'E_HOST', `Spread arguments to ${host}.${method} are unsupported`);
    };
    if (this.globalName(owner) === 'Math' && method === 'random') {
      if (e.arguments.length) this.fail(e, 'E_CALL', 'Math.random takes no arguments');
      return builtin('random.number', [], NUMBER);
    }
    if (host === 'crypto') {
      if (method === 'randomUUID') return builtin('random.uuid', [], STRING);
      if (method === 'getRandomValues')
        return this.fail(
          e,
          'E_HOST',
          'crypto.getRandomValues fills a typed array; typed arrays are outside the value model (use crypto.randomUUID or Math.random)',
        );
      return this.fail(e, 'E_MEMBER', `crypto.${method} is unsupported`);
    }
    if (host === 'console') {
      if (!['log', 'info', 'warn', 'error', 'debug'].includes(method))
        return this.fail(e, 'E_MEMBER', `console.${method} is unsupported`);
      noSpread();
      if (!e.arguments.length)
        this.fail(
          e,
          'E_HOST',
          `console.${method}() without arguments is unsupported (Chromium reports no message for it)`,
        );
      // null and undefined literals print as such whatever their type.
      const args = e.arguments.map((a): Expr => {
        const n = skipParens(a);
        if (n.kind === ts.SyntaxKind.NullKeyword) return { op: 'null', type: { maybe: STRING } };
        if (ts.isIdentifier(n) && n.text === 'undefined' && !this.binding(n))
          return { op: 'undefined', type: { maybe: STRING } };
        return this.expr(a, b);
      });
      args.forEach((a, i) => {
        const t = this.irType(a, b);
        const inner = maybeInner(t) ?? t;
        if (!['string', 'number', 'boolean'].includes(inner as string))
          this.fail(
            e.arguments[i],
            'E_HOST',
            `console arguments must be strings, numbers, booleans, null or undefined (Chromium previews objects; found ${JSON.stringify(t)})`,
          );
      });
      // A first string argument followed by more arguments is a format
      // string: Chromium's message text keeps it and converts the arguments
      // of %d/%i/%f/%s, while DevTools substitutes them.
      if (args.length > 1) {
        const first = skipParens(e.arguments[0]);
        const t = this.irType(args[0], b);
        const literal = ts.isStringLiteralLike(first) ? first.text : undefined;
        if ((t === 'string' || maybeInner(t) === 'string') && (literal ?? '%').includes('%'))
          this.fail(
            first,
            'E_HOST',
            'A console call with more arguments needs a first argument that is a string literal without % (or not a string): Chromium treats a first string argument as a format string',
          );
      }
      return builtin(`console.${method}`, args, 'void');
    }
    if (
      ts.isPropertyAccessExpression(owner) &&
      owner.name.text === 'clipboard' &&
      this.hostName(skipParens(owner.expression)) === 'navigator'
    ) {
      if (method === 'writeText') {
        if (e.arguments.length !== 1)
          this.fail(e, 'E_CALL', 'navigator.clipboard.writeText takes the text');
        return builtin('clipboard.write', [this.coerce(e.arguments[0], b, STRING)], {
          promise: 'void',
        });
      }
      if (method === 'readText') {
        if (e.arguments.length) this.fail(e, 'E_CALL', 'readText takes no arguments');
        return builtin('clipboard.read', [], { promise: STRING });
      }
      return this.fail(
        e,
        'E_MEMBER',
        `navigator.clipboard.${method} is unsupported (only text: writeText, readText)`,
      );
    }
    if (host === 'navigator') return this.fail(e, 'E_MEMBER', `navigator.${method} is unsupported`);
    if (host === 'history') {
      noSpread();
      if (method === 'pushState' || method === 'replaceState') {
        const [state, title, url] = e.arguments;
        const nullish = (n: ts.Expression | undefined) =>
          n !== undefined &&
          (skipParens(n).kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(skipParens(n)) &&
              (skipParens(n) as ts.Identifier).text === 'undefined'));
        // States are null or strings (M6); objects are untyped structured clones.
        let stateArg: Expr | undefined;
        if (!nullish(state)) {
          // Checked by type first: an object literal has no string type.
          const st = state && this.types.typeOrUndefined(state);
          if (!state || (st !== STRING && maybeInner(st ?? 'void') !== STRING))
            this.fail(
              state ?? e,
              'E_HOST',
              `history.${method} states are null or strings (state objects are untyped structured clones)`,
            );
          const v = state && this.expr(state, b);
          const t = v && this.irType(v, b);
          if (!v || (t !== STRING && maybeInner(t!) !== STRING))
            this.fail(
              state ?? e,
              'E_HOST',
              `history.${method} states are null or strings (state objects are untyped structured clones)`,
            );
          stateArg = t === STRING ? { op: 'some', value: v! } : v;
        }
        if (!title || !ts.isStringLiteralLike(skipParens(title)))
          this.fail(
            title ?? e,
            'E_HOST',
            `history.${method} takes a string literal title (ignored)`,
          );
        if (e.arguments.length > 3) this.fail(e.arguments[3], 'E_CALL', 'Extra arguments');
        const args: Expr[] = [];
        if (url && !nullish(url)) {
          const v = this.expr(url, b);
          const t = this.irType(v, b);
          if (t !== 'string' && maybeInner(t) !== 'string')
            this.fail(url, 'E_HOST', `history.${method} takes a string URL`);
          args.push(v);
        }
        if (stateArg) {
          if (!args.length) args.push({ op: 'undefined', type: { maybe: STRING } });
          args.push(stateArg);
        }
        return builtin(`history.${method === 'pushState' ? 'push' : 'replace'}`, args, 'void');
      }
      if (method === 'back' || method === 'forward') {
        if (e.arguments.length) this.fail(e, 'E_CALL', `history.${method} takes no arguments`);
        return builtin(`history.${method}`, [], 'void');
      }
      if (method === 'go') {
        const arg = e.arguments[0] && skipParens(e.arguments[0]);
        let delta: number | undefined;
        // A computed delta (M6): checked when it runs (0 reloads, unsupported).
        if (
          arg &&
          e.arguments.length === 1 &&
          !ts.isNumericLiteral(arg) &&
          !(ts.isPrefixUnaryExpression(arg) && ts.isNumericLiteral(arg.operand))
        )
          return builtin('history.go', [this.coerce(arg, b, NUMBER)], 'void');
        if (arg && ts.isNumericLiteral(arg)) delta = Number(arg.text);
        else if (
          arg &&
          ts.isPrefixUnaryExpression(arg) &&
          arg.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(arg.operand)
        )
          delta = -Number(arg.operand.text);
        if (
          delta === undefined ||
          delta === 0 ||
          !Number.isInteger(delta) ||
          e.arguments.length > 1
        )
          this.fail(
            arg ?? e,
            'E_HOST',
            'history.go takes a non-zero integer literal (go(0) and go() reload the page)',
          );
        return builtin('history.go', [{ op: 'lit', value: delta! }], 'void');
      }
      return this.fail(e, 'E_MEMBER', `history.${method} is unsupported`);
    }
    if (host === 'location')
      return this.fail(
        e,
        'E_HOST',
        `location.${method} navigates to another document, which is unsupported (assign location.hash or use history.pushState)`,
      );
    // M6 overlays: `document.elementFromPoint(x, y)`: the element at a
    // viewport point, by the native layout's hit test.
    if (host === 'document' && method === 'elementFromPoint') {
      if (e.arguments.length !== 2)
        return this.fail(e, 'E_CALL', 'elementFromPoint takes the coordinates x and y');
      return builtin(
        'document.elementFromPoint',
        e.arguments.map(a => this.coerce(a, b, NUMBER)),
        { maybe: 'element' },
      );
    }
    // M6 overlays: `document.contains(node)`: whether it is in the document.
    if (host === 'document' && method === 'contains') {
      const [other] = e.arguments;
      if (!other || e.arguments.length !== 1)
        return this.fail(e, 'E_CALL', 'contains takes a node');
      return this.maybeElementTest(this.expr(other, b), b, e, x => ({
        op: 'builtin',
        name: 'element.isConnected',
        args: [x],
        type: BOOLEAN,
      }));
    }
    // M6 overlays: `querySelector` of a literal selector the model covers:
    // `body` (where imperative mounts append) and `#id`; other selectors,
    // and selectors computed at run time (bits-ui's portal target), search
    // the document with runic_js's selector subset.
    if (host === 'document' && method === 'querySelector') {
      const [sel] = e.arguments;
      if (e.arguments.length !== 1)
        return this.fail(e, 'E_CALL', 'document.querySelector takes a selector');
      const text = ts.isStringLiteralLike(sel) ? sel.text.trim() : undefined;
      if (text === undefined)
        return builtin('document.querySelector', [this.coerce(sel, b, STRING)], {
          maybe: 'element',
        });
      if (text === 'body')
        return {
          op: 'some',
          value: builtin('document.body', [], 'element'),
        };
      if (/^#[A-Za-z_][\w-]*$/.test(text))
        return builtin('document.getElementById', [{ op: 'lit', value: text.slice(1) }], {
          maybe: 'element',
        });
      return this.fail(
        sel,
        'E_CALL',
        `document.querySelector supports the selectors body and #id, not ${JSON.stringify(text)}`,
      );
    }
    if (host === 'document' && method === 'getElementById') {
      if (e.arguments.length !== 1) this.fail(e, 'E_CALL', 'getElementById takes an id');
      return builtin('document.getElementById', [this.coerce(e.arguments[0], b, STRING)], {
        maybe: 'element',
      });
    }
    if (host === '__runic') return this.intrinsic(method, e, b);
    return undefined;
  }

  /** Runic intrinsics of compiler-generated support code (frontend/dom.d.ts `__runic`). */
  private intrinsic(method: string, e: ts.CallExpression, b: FnBuilder): Expr {
    const arg = (i: number, t: Type): Expr => {
      const a = e.arguments[i];
      if (!a) return this.fail(e, 'E_CALL', `__runic.${method} takes more arguments`);
      return this.coerce(a, b, t);
    };
    const builtin = (name: string, args: Expr[], type: Type): Expr => ({
      op: 'builtin',
      name,
      args,
      type,
    });
    switch (method) {
      case 'parent':
        return builtin('element.parent', [arg(0, 'element')], { maybe: 'element' });
      case 'focused':
        return builtin('focus.current', [], { maybe: 'element' });
      case 'resetFocus':
        return builtin('focus.reset', [], 'void');
      case 'focusStart':
        return builtin('focus.start', [arg(0, 'element')], 'void');
      case 'resolve':
        return builtin('url.resolve', [arg(0, STRING), arg(1, STRING)], { maybe: STRING });
      case 'queryPairs':
        return builtin('url.query-pairs', [arg(0, STRING)], { array: { array: STRING } });
      case 'hostReply':
        return builtin('host.reply', [], { promise: 'void' });
      case 'unsupported':
        return builtin('host.unsupported', [arg(0, STRING)], 'void');
      // A value as Svelte renders it in text: nullish as empty, others as String(v).
      case 'text': {
        const v = this.expr(e.arguments[0], b);
        const t = this.irType(v, b);
        if (t === STRING) return v;
        const inner = maybeInner(t);
        if (!inner) return { op: 'to-string', arg: v };
        const local = b.local('$text', t);
        const value: Expr = { op: 'unwrap', value: { op: 'local', local } };
        return {
          op: 'with',
          local,
          value: v,
          body: {
            op: 'cond',
            test: {
              op: 'builtin',
              name: 'maybe.is-nullish',
              args: [{ op: 'local', local }],
              type: BOOLEAN,
            },
            then: { op: 'lit', value: '' },
            else: inner === STRING ? value : { op: 'to-string', arg: value },
          },
        };
      }
    }
    return this.fail(e, 'E_MEMBER', `__runic.${method} is unknown`);
  }

  /** Reads of host-service properties: `history.length`, `location.*`. */
  private hostServiceRead(e: ts.PropertyAccessExpression): Expr | undefined {
    const name = e.name.text;
    const host = this.hostName(skipParens(e.expression));
    if (host === 'history') {
      if (name === 'length')
        return { op: 'builtin', name: 'history.length', args: [], type: NUMBER };
      if (name === 'state')
        return { op: 'builtin', name: 'history.state', args: [], type: { maybe: STRING } };
      return this.fail(e, 'E_MEMBER', `history.${name} is unsupported`);
    }
    if (host === 'location') {
      if (['pathname', 'search', 'hash'].includes(name))
        return { op: 'builtin', name: `location.${name}`, args: [], type: STRING };
      if (['href', 'origin', 'host', 'hostname', 'port', 'protocol'].includes(name))
        return this.fail(
          e,
          'E_HOST',
          `location.${name} includes the origin, which differs between the browser and the native app; use pathname, search and hash`,
        );
      return this.fail(e, 'E_MEMBER', `location.${name} is unsupported`);
    }
    // The platform (M6 overlays: bits-ui's isIOS): the runtime's user agent,
    // and no touch points.
    if (host === 'navigator' && name === 'userAgent')
      return { op: 'builtin', name: 'navigator.user-agent', args: [], type: STRING };
    if (host === 'navigator' && name === 'maxTouchPoints') return { op: 'lit', value: 0 };
    if (host === 'navigator' || host === 'console' || host === 'crypto')
      return this.fail(e, 'E_MEMBER', `${host}.${name} is unsupported here; call its methods`);
    // The document element as an element value (getComputedStyle's argument).
    if (host === 'document' && name === 'documentElement')
      return { op: 'builtin', name: 'document.element', args: [], type: 'element' };
    if (host === 'document' && name === 'title')
      return { op: 'builtin', name: 'document.title', args: [], type: STRING };
    if (host === 'document' && name === 'body')
      return { op: 'builtin', name: 'document.body', args: [], type: 'element' };
    // The focused element, the body when none is.
    if (host === 'document' && name === 'activeElement')
      return {
        op: 'nullish',
        left: { op: 'builtin', name: 'focus.current', args: [], type: { maybe: 'element' } },
        right: { op: 'builtin', name: 'document.body', args: [], type: 'element' },
      };
    return undefined;
  }

  private property(e: ts.PropertyAccessExpression, b: FnBuilder): Expr {
    // A property of an untyped constant a test proved present (`presentIn`).
    const path = this.pathKey(e);
    if (path && this.present.has(path)) {
      this.present.delete(path);
      try {
        const v = this.property(e, b);
        return maybeInner(this.irType(v, b)) !== undefined ? { op: 'unwrap', value: v } : v;
      } finally {
        this.present.add(path);
      }
    }
    const name = e.name.text;
    if (e.expression.kind === ts.SyntaxKind.SuperKeyword) return this.classes.superRead(e, b);
    // `this.name` in a static member: the class's static member.
    if (e.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const cls = this.classes.staticThis(e.expression);
      if (cls) return this.classes.staticRead(cls, e, b);
    }
    // The document element's client size (M6 overlays: floating-ui's
    // observeMove): the viewport's, without scrollbars.
    if ((name === 'clientWidth' || name === 'clientHeight') && this.isRoot(e.expression))
      return { op: 'builtin', name: `document.${name}`, args: [], type: NUMBER };
    // A computed style's property by its camelCase name (bits-ui's
    // `getComputedStyle(node).zIndex`): as getPropertyValue reads it.
    const styleOf = skipParens(e.expression);
    const computedCall =
      ts.isCallExpression(styleOf) &&
      ((ts.isPropertyAccessExpression(styleOf.expression) &&
        styleOf.expression.name.text === 'getComputedStyle' &&
        this.hostName(styleOf.expression.expression) === 'window') ||
        (ts.isIdentifier(styleOf.expression) &&
          this.hostName(styleOf.expression) === 'getComputedStyle'));
    if (
      computedCall ||
      this.checker.getTypeAtLocation(e.expression).getProperty('__runicComputedStyle')
    ) {
      const kebab = name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
      if (!COMPUTED_PROPERTIES.has(kebab))
        return this.fail(
          e,
          'E_MEMBER',
          `getComputedStyle(…) reads ${[...COMPUTED_PROPERTIES].join(', ')}`,
        );
      return {
        op: 'builtin',
        name: 'element.computed-style',
        args: [this.expr(e.expression, b), { op: 'lit', value: kebab }],
        type: STRING,
      };
    }
    // `collator.compare` as a function value; other members of Intl constants.
    const intl = this.intlObject(e.expression);
    if (intl) {
      if (intl.kind === 'collator' && name === 'compare') return this.intlComparator(intl, b);
      const calls = {
        collator: 'compare(a, b), or compare as a comparator',
        plural: 'select(n), and resolvedOptions().pluralCategories',
        names: 'of(code)',
      } as Record<string, string>;
      return this.fail(
        e,
        'E_INTL',
        `Intl.${intl.ctor} members are supported as calls (${calls[intl.kind] ?? 'format(x)'})`,
      );
    }
    // `new Intl.PluralRules(…).resolvedOptions().pluralCategories`.
    const resolved = this.intlResolvedOptions(e.expression);
    if (resolved) return this.intlResolvedMember(resolved, name, e, b);
    const service = this.hostServiceRead(e);
    if (service) return service;
    // A program-wide variable on the global object (`globalThis.bitsIdCounter`).
    const shared = this.globalThisVar(e);
    if (shared) return shared;
    // A member of a module namespace (`kbd.SPACE`): the export it names.
    if (this.namespaceOf(e.expression)) {
      const member = this.symbol(e.name);
      const found = member && this.bindingOf(member);
      if (!found || !ts.isIdentifier(e.name))
        return this.fail(e, 'E_IMPORT', `${e.getText()} is not a supported binding`);
      return this.bindingExpr(found, e.name, b);
    }
    // A member of a constant evaluated at build time.
    const constant = this.constantMember(e);
    if (constant) return this.constantExpr(constant.value, constant.label, e);
    // An element's inline style property (`node.style.transitionDuration`).
    const style = this.elementStyle(e, b);
    if (style)
      return {
        op: 'builtin',
        name: 'element.style-get',
        args: [style.element, { op: 'lit', value: style.property }],
        type: 'string',
      };
    if (ts.isIdentifier(e.expression)) {
      const special = this.binding(e.expression);
      if (special?.kind === 'props')
        return special.values.get(name) ?? this.fail(e, 'E_PROPS', `Prop ${name} is not passed`);
      if (special?.kind === 'class') return this.classes.staticRead(special.cls, e, b);
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
    // An element's data attribute (bits-ui's Select `node.dataset.value`):
    // undefined when absent.
    const data = skipParens(e.expression);
    if (
      ts.isPropertyAccessExpression(data) &&
      data.name.text === 'dataset' &&
      this.types.typeOrUndefined(data.expression) === 'element'
    ) {
      const tmp = b.local('$data', { maybe: STRING });
      const t: Expr = { op: 'local', local: tmp };
      return {
        op: 'with',
        local: tmp,
        value: {
          op: 'builtin',
          name: 'element.getAttribute',
          args: [
            this.expr(data.expression, b),
            { op: 'lit', value: 'data-' + name.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) },
          ],
          type: { maybe: STRING },
        },
        body: {
          op: 'cond',
          test: { op: 'builtin', name: 'maybe.is-null', args: [t], type: BOOLEAN },
          then: { op: 'undefined', type: { maybe: STRING } },
          else: t,
        },
      };
    }
    // The document element and matchMedia(query).matches.
    const root = this.rootMember(e);
    if (root?.kind === 'style')
      return {
        op: 'builtin',
        name: `${root.family}.style-get`,
        args: [{ op: 'lit', value: root.name }],
        type: 'string',
      };
    if (root) {
      const read: Expr = {
        op: 'builtin',
        name: `${root.family}.get-attr`,
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
    let object = this.expr(e.expression, b);
    let t = this.irType(object, b);
    // An untyped nullable value (untyped JavaScript specialised for a
    // nullable argument: bits-ui's `polygon.length` of a polygon a switch
    // without default may leave undefined), or one TypeScript narrowed to a
    // present one (`if (!geo) return; geo.corridor` of a record typed from
    // untyped code): reading a property of nullish throws a TypeError, as
    // unwrapping does.
    const inner = maybeInner(t);
    if (inner !== undefined && !e.questionDotToken && this.tsPresent(e.expression)) {
      object = { op: 'unwrap', value: object };
      t = inner;
    }
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
    // Animation objects (M6, `element.getAnimations()`).
    if (kind === 'animation') {
      const type = ANIMATION_MEMBERS[name];
      if (type === undefined)
        return this.fail(
          e,
          'E_MEMBER',
          `Animation ${name} is unsupported (finished, playState and pending are supported)`,
        );
      return { op: 'builtin', name: `animation.${name}`, args: [object], type };
    }
    if (kind === 'element' && name === 'localName')
      return { op: 'builtin', name: 'element.localName', args: [object], type: STRING };
    // `element.textContent` (M6 overlays: bits-ui's typeahead): the text of
    // its descendant text nodes in tree order.
    if (kind === 'element' && name === 'textContent')
      return { op: 'builtin', name: 'element.textContent', args: [object], type: STRING };
    // `element.id`: the id attribute, or empty.
    if (kind === 'element' && name === 'id')
      return {
        op: 'nullish',
        left: {
          op: 'builtin',
          name: 'element.getAttribute',
          args: [object, { op: 'lit', value: 'id' }],
          type: { maybe: STRING },
        },
        right: { op: 'lit', value: '' },
      };
    if (kind === 'element' && name === 'isConnected')
      return { op: 'builtin', name: 'element.isConnected', args: [object], type: 'boolean' };
    // `element.hidden`: whether the attribute is present (its `until-found`
    // state, a string, is not covered: RunicUnsupportedError).
    if (kind === 'element' && name === 'hidden') {
      const local = b.local('$hidden', { maybe: STRING });
      const read: Expr = { op: 'local', local };
      return {
        op: 'with',
        local,
        value: {
          op: 'builtin',
          name: 'element.getAttribute',
          args: [object, { op: 'lit', value: 'hidden' }],
          type: { maybe: STRING },
        },
        body: {
          op: 'cond',
          test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: BOOLEAN },
          then: { op: 'lit', value: false },
          else: {
            op: 'cond',
            test: {
              op: 'eq',
              left: {
                op: 'builtin',
                name: 'string.toLowerCase',
                args: [{ op: 'unwrap', value: read }],
                type: STRING,
              },
              right: { op: 'lit', value: 'until-found' },
            },
            then: this.unsupportedValue(
              'element$hiddenUntilFound',
              BOOLEAN,
              'element.hidden of hidden="until-found"',
            ),
            else: { op: 'lit', value: true },
          },
        },
      };
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
          'Event objects support type, key, code, ctrlKey/shiftKey/altKey/metaKey, repeat, isComposing, clientX/clientY, button/buttons, deltaX/deltaY, detail, pointerType, pointerId, target, currentTarget, defaultPrevented, target.value/checked, preventDefault(), stopPropagation() and stopImmediatePropagation()',
        );
      return { op: 'builtin', name: `event.${name}`, args: [object], type };
    }
    if (this.classes.isClass(t)) return this.classes.read(t, object, e, b);
    if (typeof t === 'object' && 'classes' in t) {
      const read = this.packUnionRead(e, object, t.classes, b);
      if (read) return read;
    }
    const members = kind === 'record' && this.recordMembers.get((t as { record: number }).record);
    if (members) return members.read(name, object, e, b);
    if (kind === 'record') {
      const record = (t as { record: number }).record;
      if (this.types.accessors.has(record)) return this.accessorRead(object, record, name, e);
      const field = this.types.fieldIndex(record, name, e);
      const read: Expr = { op: 'get', object, field };
      return this.types.merged.has(record) ? this.mergedRead(read, record, field, e) : read;
    }
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
    if (t === 'attrs') {
      // An attribute bag's entry (bits-ui's hidden input reads
      // `mergedProps.type`): undefined when absent; a value of another kind
      // than TypeScript's type throws (`attrs.get`).
      // TypeScript's type, by kind: svelte/elements' `type` is a union of
      // literals and `string & {}`.
      const parts = this.checker.getTypeAtLocation(e);
      const members = parts.isUnion() ? parts.types : [parts];
      const F = ts.TypeFlags;
      const nullable = members.some(m => m.flags & (F.Null | F.Undefined | F.Void));
      const present = members.filter(m => !(m.flags & (F.Null | F.Undefined | F.Void)));
      const stringLike = (m: ts.Type): boolean =>
        !!(m.flags & F.StringLike) || (m.isIntersection() && m.types.some(stringLike));
      // `style` holding a style object (bits-ui's Select content reads
      // `contentState.props.style`): a map of its properties (`attrs.get`).
      const styleObject =
        name === 'style' && present.length > 0 && present.every(m => m.flags & F.Object);
      const inner: Type | undefined = styleObject
        ? { map: [STRING, { maybe: STRING }] }
        : present.every(stringLike)
          ? STRING
          : present.every(m => m.flags & F.BooleanLike)
            ? 'boolean'
            : undefined;
      if ((!nullable && !styleObject) || !present.length || !inner)
        return this.fail(
          e,
          'E_ATTRS',
          `Reading ${name} of an attribute bag needs a nullable string or boolean type (or a style object)`,
        );
      return {
        op: 'builtin',
        name: 'attrs.get',
        args: [object, { op: 'lit', value: name }],
        type: { maybe: inner },
      };
    }
    return this.fail(e, 'E_MEMBER', `Unsupported property ${name} on ${kind ?? 'this value'}`);
  }

  // Optional chaining ---------------------------------------------------------
  //
  // The innermost pending `?.` link is lowered first: its base is evaluated,
  // bound to a temporary and substituted (`overrides`) while the rest of the
  // chain is lowered; outer `?.` links resolve recursively. Chain members are
  // typed with their own declared types (without the chain's short-circuit
  // `undefined`).

  private readonly overrides = new Map<ts.Node, { expr: Expr; type: Type; link?: true }>();

  /**
   * The IR type an expression is expected to have where TypeScript cannot
   * type it (untyped package JavaScript): a function literal whose
   * parameters (or result) TypeScript types `any` takes its parameter and
   * result types from it, a call of an untyped function specialised for it
   * returns it. Set for returned expressions of functions with a known
   * result, initialisers of declared constants and arguments of
   * specialised calls.
   */
  readonly expected = new Map<ts.Node, Type>();
  /**
   * Parameter types of untyped function literals passed to untyped
   * functions, from the calls the callee makes of its parameter (the
   * result stays the one the body returns).
   */
  private readonly expectedParams = new Map<ts.Node, Type[]>();

  /**
   * The function type an untyped function's parameter `param` is called
   * with in its body: the IR types of the arguments of its calls, which must
   * agree, as TypeScript types them there. Undefined when it is not called,
   * or an argument has no type.
   */
  private calledWith(decl: ts.FunctionLikeDeclaration, param: ts.ParameterDeclaration) {
    const sym = ts.isIdentifier(param.name)
      ? this.checker.getSymbolAtLocation(param.name)
      : undefined;
    if (!sym || !decl.body) return undefined;
    let found: Type[] | undefined;
    let conflict = false;
    const visit = (n: ts.Node) => {
      if (conflict) return;
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(skipParens(n.expression)) &&
        this.checker.getSymbolAtLocation(skipParens(n.expression)) === sym
      ) {
        const types = n.arguments.map(a => {
          const t = this.checker.getTypeAtLocation(a);
          return t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
            ? undefined
            : this.types.tryMap(t, a);
        });
        if (types.some(t => t === undefined)) conflict = true;
        else if (!found) found = types as Type[];
        else if (JSON.stringify(found) !== JSON.stringify(types)) conflict = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(decl.body);
    return conflict ? undefined : found;
  }

  /**
   * Untyped locals (TypeScript types them `any`) known to hold a value in
   * the code being lowered: the branch of a test that excludes `undefined`
   * and `null` (`x != null`, `x !== undefined && x !== null`, `x`). A
   * nullable value read there converts to its value where one is expected,
   * as TypeScript narrows typed code.
   */
  /** Untyped locals (symbols) and their properties (`pathKey`) known present. */
  private readonly present = new Set<ts.Symbol | string>();
  private readonly symbolIds = new Map<ts.Symbol, number>();

  /** The key of `local.name` for a constant local. */
  private pathKey(e: ts.Expression): string | undefined {
    e = skipParens(e);
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    const sym = this.symbol(e.expression);
    const decl = sym?.valueDeclaration;
    if (
      !sym ||
      !decl ||
      !ts.isVariableDeclaration(decl) ||
      !(decl.parent.flags & ts.NodeFlags.Const)
    )
      return undefined;
    let id = this.symbolIds.get(sym);
    if (id === undefined) this.symbolIds.set(sym, (id = this.symbolIds.size));
    return `${id}.${e.name.text}`;
  }

  /** The expected function type of an untyped function literal, if one is known. */
  private expectedFunction(
    decl: ts.FunctionLikeDeclaration,
  ): { params: Type[]; result: Type | undefined } | undefined {
    const expected = this.expected.get(decl);
    const want =
      expected && typeof expected === 'object' && 'fn' in expected
        ? expected.fn
        : this.expectedParams.has(decl)
          ? { params: this.expectedParams.get(decl)!, result: undefined }
          : undefined;
    if (!want) return undefined;
    const untyped = (t: ts.Type) => !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    // A rest parameter of untyped values (`(...args) =>`) takes the
    // remaining expected parameters.
    const last = decl.parameters[decl.parameters.length - 1];
    const rest =
      last?.dotDotDotToken && containsAny(this.checker.getTypeAtLocation(last), this.checker)
        ? last
        : undefined;
    const fixed = rest ? decl.parameters.slice(0, -1) : decl.parameters;
    const anyParam = !!rest || fixed.some(p => untyped(this.checker.getTypeAtLocation(p)));
    const ret = this.checker.getSignatureFromDeclaration(decl)?.getReturnType();
    const anyResult = !!ret && untyped(ret);
    if ((!anyParam && !anyResult) || fixed.length > want.params.length) return undefined;
    return {
      params: [
        ...fixed.map((p, i) =>
          untyped(this.checker.getTypeAtLocation(p))
            ? want.params[i]
            : this.types.map(this.checker.getTypeAtLocation(p), p),
        ),
        ...(rest ? want.params.slice(fixed.length) : []),
      ],
      result: anyResult ? want.result : undefined,
    };
  }

  /**
   * The symbols of untyped locals a test proves present when it is true
   * (`negated`: when it is false).
   */
  private presentIn(
    test: ts.Expression,
    negated: boolean,
    branch?: ts.Statement,
  ): (ts.Symbol | string)[] {
    test = skipParens(test);
    const K = ts.SyntaxKind;
    const local = (e: ts.Expression): ts.Symbol | string | undefined => {
      e = skipParens(e);
      // (A property of an untyped constant: bits-ui's `if (record.node)`
      // over the registry's records.)
      const path = this.pathKey(e);
      if (path) return path;
      if (!ts.isIdentifier(e)) return undefined;
      const sym = this.symbol(e);
      const decl = sym?.valueDeclaration;
      if (!sym || !decl || !(this.checker.getTypeAtLocation(e).flags & ts.TypeFlags.Any))
        return undefined;
      // Constants and parameters the function never assigns; a variable in
      // the branch the test leads to, up to its first assignment there
      // (bits-ui's `else if (scope) { scope.unmount(); scope = null; }`).
      if (ts.isVariableDeclaration(decl))
        return decl.parent.flags & ts.NodeFlags.Const ||
          (branch && this.readBeforeAssigned(sym, branch))
          ? sym
          : undefined;
      return ts.isParameter(decl) && !this.assigned(sym, decl.parent) ? sym : undefined;
    };
    if (ts.isPrefixUnaryExpression(test) && test.operator === K.ExclamationToken)
      return this.presentIn(test.operand, !negated, branch);
    if (ts.isBinaryExpression(test)) {
      const op = test.operatorToken.kind;
      if (op === K.AmpersandAmpersandToken && !negated)
        return [
          ...this.presentIn(test.left, false, branch),
          ...this.presentIn(test.right, false, branch),
        ];
      if (op === K.BarBarToken && negated)
        return [
          ...this.presentIn(test.left, true, branch),
          ...this.presentIn(test.right, true, branch),
        ];
      const nothing = (x: ts.Expression) =>
        x.kind === K.NullKeyword ||
        (ts.isIdentifier(x) && x.text === 'undefined') ||
        ts.isVoidExpression(x);
      const [l, r] = [skipParens(test.left), skipParens(test.right)];
      const operand = nothing(r) ? l : nothing(l) ? r : undefined;
      if (!operand) return [];
      const sym = local(operand);
      if (!sym) return [];
      const excludes = op === K.ExclamationEqualsToken || op === K.ExclamationEqualsEqualsToken;
      const includes = op === K.EqualsEqualsToken || op === K.EqualsEqualsEqualsToken;
      if (!excludes && !includes) return [];
      if (excludes === negated) return [];
      // A strict test (`x !== undefined`) excludes one of null and
      // undefined, and the IR's nullable values hold either. The value only
      // converts where a non-nullable type is expected (declared by the
      // package's types, as bits-ui's `ReadableBox<string | Element>`), so
      // the other one would break those types: the conversion throws a
      // TypeError there (`unwrap`), as other broken types do.
      return [sym];
    }
    const sym = local(test);
    return sym && !negated ? [sym] : [];
  }

  /**
   * The untyped variable `if (!x) x = new C(…)` (or `{ x = new C(…); }`)
   * creates where it is absent, if `s` is such a statement.
   */
  private createdIn(s: ts.IfStatement): ts.Symbol | undefined {
    const test = skipParens(s.expression);
    if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken)
      return undefined;
    const x = skipParens(test.operand);
    if (!ts.isIdentifier(x) || !(this.checker.getTypeAtLocation(x).flags & ts.TypeFlags.Any))
      return undefined;
    let body: ts.Statement = s.thenStatement;
    if (ts.isBlock(body)) {
      if (body.statements.length !== 1) return undefined;
      body = body.statements[0];
    }
    if (!ts.isExpressionStatement(body)) return undefined;
    const e = skipParens(body.expression);
    if (
      !ts.isBinaryExpression(e) ||
      e.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(skipParens(e.left)) ||
      !ts.isNewExpression(skipParens(e.right))
    )
      return undefined;
    const sym = this.symbol(x);
    return sym && this.symbol(skipParens(e.left)) === sym ? sym : undefined;
  }

  /**
   * Whether `branch` reads variable `sym` only before it assigns it: no
   * closure there refers to it, and the statements from the first one that
   * assigns it read it no more.
   */
  private readBeforeAssigned(sym: ts.Symbol, branch: ts.Statement): boolean {
    const statements = ts.isBlock(branch) ? [...branch.statements] : [branch];
    let ok = true;
    const refs = (n: ts.Node, inClosure: boolean, reads: boolean) => {
      if (!ok) return;
      if (ts.isIdentifier(n) && this.symbol(n) === sym) {
        const target =
          ts.isBinaryExpression(n.parent) &&
          n.parent.left === n &&
          n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        if (inClosure || (!target && !reads)) ok = false;
      }
      ts.forEachChild(n, c => refs(c, inClosure || ts.isFunctionLike(c), reads));
    };
    const first = statements.findIndex(st => this.assigned(sym, st));
    statements.forEach((st, i) => refs(st, false, first < 0 || i < first));
    return ok;
  }

  /** Whether `sym` is assigned anywhere in `scope`. */
  private assigned(sym: ts.Symbol, scope: ts.Node): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (
        ts.isBinaryExpression(n) &&
        isAssignmentOperator(n.operatorToken.kind) &&
        ts.isIdentifier(skipParens(n.left)) &&
        this.symbol(skipParens(n.left)) === sym
      )
        found = true;
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return found;
  }

  /** Lower with `symbols` known present. */
  private withPresent<T>(symbols: (ts.Symbol | string)[], f: () => T): T {
    const added = symbols.filter(x => !this.present.has(x));
    for (const x of added) this.present.add(x);
    try {
      return f();
    } finally {
      for (const x of added) this.present.delete(x);
    }
  }

  /** Whether `e` reads an untyped local known present here. */
  private knownPresent(e: ts.Expression): boolean {
    e = skipParens(e);
    if (!ts.isIdentifier(e)) return false;
    const sym = this.symbol(e);
    return !!sym && this.present.has(sym);
  }

  /** The IR type of a node, honouring chain substitutions and link types. */
  typeAt(n: ts.Expression, b?: FnBuilder): Type {
    const o = this.overrides.get(n);
    if (o) return o.type;
    // (With a builder: where TypeScript cannot type it, the IR type of what it reads.)
    if (b && !ts.isOptionalChain(n) && this.types.typeOrUndefined(n) === undefined)
      return this.irType(this.expr(n, b), b);
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
      // (A base an enclosing `?.` already substituted; not another
      // override, such as a constructor's early field value.)
      // (A `?.` call of a declared method is a plain call.)
      const plainCall =
        ts.isCallExpression(cur) &&
        ts.isPropertyAccessExpression(cur.expression) &&
        !cur.expression.questionDotToken &&
        this.declaredFunction(cur.expression);
      if (
        'questionDotToken' in cur &&
        cur.questionDotToken &&
        !plainCall &&
        !this.overrides.get(cur.expression)?.link
      )
        found = cur;
      if (!ts.isOptionalChain(cur)) break;
      cur = cur.expression;
    }
    return found;
  }

  private optionalChain(e: ts.Expression, link: ts.Expression, b: FnBuilder): Expr {
    const base = (link as ts.PropertyAccessExpression).expression;
    // Untyped JavaScript (a local TypeScript types `any`): the lowered value's type.
    const untyped =
      !this.overrides.has(base) &&
      !ts.isOptionalChain(base) &&
      !!(this.checker.getTypeAtLocation(base).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    const bv = this.expr(base, b);
    // The lowered value's own nullable type where it is more precise (match
    // arrays with captures that may be undefined).
    const lowered = this.irType(bv, b);
    let bt = untyped ? lowered : this.typeAt(base);
    if (maybeInner(bt) && maybeInner(lowered)) bt = lowered;
    // A value the IR has as nullable where TypeScript's inference of untyped
    // JavaScript does not (bits-ui's `this.tether?.registry`, the field
    // typed by its declaration file): `?.` tests the value.
    if (!maybeInner(bt) && maybeInner(lowered) && this.isUntypedSource(base)) bt = lowered;
    // A value the IR has as never nullish where TypeScript allows null (a
    // cast such as `e.target as HTMLInputElement | null`): `?.` is `.`.
    const inner = maybeInner(bt);
    if (inner !== undefined && JSON.stringify(inner) === JSON.stringify(lowered)) bt = lowered;
    if (!(typeof bt === 'object' && 'maybe' in bt)) {
      // `?.` on a value that cannot be nullish behaves like `.`.
      this.overrides.set(base, { expr: bv, type: bt, link: true });
      try {
        return this.expr(e, b);
      } finally {
        this.overrides.delete(base);
      }
    }
    const tmp = b.local('$optional', bt.maybe);
    this.overrides.set(base, { expr: { op: 'local', local: tmp }, type: bt.maybe, link: true });
    let then: Expr;
    let alreadyMaybe: boolean;
    try {
      // A further `?.` in the chain makes the rest a Maybe already.
      const nested = this.pendingLink(e) !== undefined;
      then = this.expr(e, b);
      // (Also where TypeScript types the result `any` or `unknown`: a field
      // the program types, such as a payload only nothing reaches.)
      const untypedResult = !!(
        this.checker.getTypeAtLocation(e).flags &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
      );
      const thenType = untyped || untypedResult ? this.irType(then, b) : this.typeAt(e);
      // What the lowered chain gives decides (TypeScript adds `undefined`
      // to the type of an optional call through a nullable function).
      alreadyMaybe =
        maybeInner(this.irType(then, b)) !== undefined ||
        ((nested || (typeof thenType === 'object' && 'maybe' in thenType)) &&
          this.irType(then, b) === 'void');
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
    let object = this.expr(e.expression, b);
    let t = this.irType(object, b);
    // An untyped nullable value, or one TypeScript narrowed to a present one
    // (an iterator result's `value` after its `done`): indexing nullish throws
    // a TypeError (see `property`).
    const inner = maybeInner(t);
    if (inner !== undefined && !e.questionDotToken && this.tsPresent(e.expression)) {
      object = { op: 'unwrap', value: object };
      t = inner;
    }
    const kind = this.receiverKind(t);
    if (kind === 'array') {
      const index = this.expr(e.argumentExpression, b);
      const el = (t as { array: Type }).array;
      const here = this.types.typeOrUndefined(e);
      // The left operand of `||` or `??` (bits-ui's `tabbables[0] || null`):
      // undefined past the end, as JavaScript reads it (`array.get`).
      let user: ts.Node = e;
      while (ts.isParenthesizedExpression(user.parent)) user = user.parent;
      // (Also where a nullable value is expected: returned by a function
      // declared to return `T | undefined`, bits-ui's FocusScopeManager
      // `getActive() { return this.#scopeStack.current[0]; }`.)
      const nullableResult =
        ts.isReturnStatement(user.parent) &&
        b.result !== undefined &&
        maybeInner(b.result) !== undefined &&
        sameType(maybeInner(b.result)!, el);
      const nullableExpected = (() => {
        const w = this.expected.get(e);
        return w !== undefined && maybeInner(w) !== undefined && sameType(maybeInner(w)!, el);
      })();
      if (
        ((ts.isBinaryExpression(user.parent) &&
          user.parent.left === user &&
          [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
            user.parent.operatorToken.kind,
          )) ||
          nullableResult ||
          nullableExpected) &&
        !maybeInner(el)
      )
        return {
          op: 'builtin',
          name: 'array.get',
          args: [object, index],
          type: { maybe: el },
        };
      if (maybeInner(el) && here !== undefined && !maybeInner(here))
        return this.captureRead(e, object, index, b);
      // An element of a class reference type narrowed by TypeScript (`xs[0] instanceof C`).
      return this.classes.narrow({ op: 'index', array: object, index }, el, here);
    }
    if (kind === 'string')
      return {
        op: 'builtin',
        name: 'string.index',
        args: [object, this.expr(e.argumentExpression, b)],
        type: { maybe: STRING },
      };
    // A tuple's item by a literal index.
    if (
      kind === 'record' &&
      this.types.isTuple((t as { record: number }).record) &&
      ts.isNumericLiteral(e.argumentExpression)
    ) {
      const i = Number(e.argumentExpression.text);
      const fields = this.types.records[(t as { record: number }).record].fields;
      if (!Number.isInteger(i) || i >= fields.length)
        return this.fail(e, 'E_MEMBER', `The tuple has no item ${e.argumentExpression.text}`);
      return { op: 'get', object, field: i };
    }
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
    if (kind === 'record' && !this.classes.isClass(t)) return this.dynamicField(e, object, t, b);
    if (kind === 'map' && (t as { map: [Type, Type] }).map[0] === STRING) {
      // A dictionary object (`keyToIndex[e.key]`): undefined for keys it lacks.
      const value = (t as { map: [Type, Type] }).map[1];
      const m = b.local('$dictionary', t);
      const k = b.local('$key', STRING);
      const key: Expr = { op: 'local', local: k };
      const dict: Expr = { op: 'local', local: m };
      return {
        op: 'with',
        local: m,
        value: object,
        body: {
          op: 'with',
          local: k,
          value: this.coerce(e.argumentExpression, b, STRING),
          body: {
            op: 'cond',
            test: { op: 'builtin', name: 'map.has', args: [dict, key], type: BOOLEAN },
            then: { op: 'builtin', name: 'map.get', args: [dict, key], type: { maybe: value } },
            else: { op: 'call', function: this.prototypeGuard({ maybe: value }), args: [key] },
          },
        },
      };
    }
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
    if (CLASS_DATA_BUILTINS.has(name)) {
      this.classes.plainData(
        name,
        args.map(a => this.irType(a, b)),
        at,
      );
      for (const a of args) {
        const t = this.irType(a, b);
        // Tuples are arrays in JavaScript, records here: what these see differs.
        if (name !== 'structuredClone' && this.types.containsTuple(t))
          this.fail(at, 'E_OBJECT', `${name} of a tuple of different types is unsupported`);
        if (typeof t === 'object' && 'record' in t && this.types.packageRecords.has(t.record))
          this.fail(
            at,
            'E_OBJECT',
            `${name} of a ${this.types.records[t.record].name} (an options type a package declares) is unsupported: its key order is not tracked`,
          );
      }
    }
    // Items added to an array of nullable elements (TypeScript narrowed the
    // value): wrapped into the element type.
    if ((name === 'array.push' || name === 'array.unshift') && args.length > 1) {
      const element = arrayElement(this.irType(args[0], b));
      const inner = element && maybeInner(element);
      if (inner)
        args = args.map((a, i) =>
          i > 0 && JSON.stringify(this.irType(a, b)) === JSON.stringify(inner)
            ? { op: 'some', value: a }
            : a,
        );
    }
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
    const first = this.firstIteration(e, b);
    if (first) return first;
    const callee = e.expression;
    const args = () => e.arguments.map(a => this.expr(a, b));
    if (callee.kind === ts.SyntaxKind.SuperKeyword)
      return this.fail(
        e,
        'E_CLASS',
        'super(…) is supported as a statement at the top level of a constructor',
      );
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.kind === ts.SyntaxKind.SuperKeyword
    )
      return this.classes.superCall(callee, e, b);
    if (ts.isIdentifier(callee)) {
      const host = this.hostName(callee);
      const hosted = host && this.hostCall(host, e, b);
      if (hosted) return hosted;
      const global = this.globalName(callee);
      if (global === 'RegExp') return this.regexpNew(e, e.arguments, b);
      // Date() without new: the current time as a string.
      if (global === 'Date')
        return this.builtin(
          'date.toString',
          [this.builtin('date.new', [this.builtin('clock.date', [], NUMBER)], 'date')],
          STRING,
        );
      // A copy of a match array keeps index, input and groups in JavaScript.
      if (global === 'structuredClone' && e.arguments[0] && this.isMatchArray(e.arguments[0]))
        return this.fail(e, 'E_REGEXP', 'structuredClone of a match array is unsupported');
      if (global && GLOBAL_FUNCTIONS.has(global))
        return this.builtinCall(global, args(), b, this.tsCallType(e), e);
      const binding = this.binding(callee);
      if (binding?.kind === 'pack' && binding.call) return binding.call(e, b, this);
      if (binding?.kind === 'function')
        return { op: 'call', function: binding.fn, args: this.callArgs(e, b) };
      if (binding?.kind === 'generic') return this.specialise(binding, e, b);
      if (binding)
        return {
          op: 'call-value',
          callee: this.calleeOf(this.expr(callee, b), b),
          args: this.callArgs(e, b),
        };
      return this.fail(callee, 'E_UNRESOLVED', `${callee.text} is not a supported function`);
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      // A function of a build-time constant called with literal arguments
      // (bits-ui's `popoverAttrs.selector("trigger")`): called at build time,
      // as the constant was made (an import-free module's code).
      if (
        ts.isIdentifier(callee.expression) &&
        this.binding(callee.expression)?.kind === 'constant'
      ) {
        const member = this.constantMember(callee)!;
        if (typeof member.value === 'function') {
          const object = (this.binding(callee.expression) as { value: unknown }).value;
          const apply = (args: unknown[]) =>
            (member.value as (...a: unknown[]) => unknown).apply(object, args);
          const args = e.arguments.map(a => this.staticValue(a));
          if (args.every(a => a !== undefined))
            return this.constantExpr(apply(args.map(a => a!.value)), `${member.label}(…)`, e);
          // Arguments over finite sets of values (bits-ui's
          // `dialogAttrs.getAttr(part, this.opts.variant.current)`, both
          // unions of string literals): called for each combination, the
          // program selecting the result (frontend/packs/choice.ts).
          const ctx = { lower: this, b, label: `${member.label} (called at build time)` };
          const choice = graftChoice(
            choiceSequence(
              ctx,
              e,
              e.arguments.map(a => valueChoice(ctx, a)),
            ),
            values => choiceLeaf(apply(values as unknown[])),
          );
          return choiceExpr(ctx, choice, v => this.constantExpr(v, `${member.label}(…)`, e));
        }
      }
      const kept = this.filterBoolean(e, b);
      if (kept) return kept;
      if (method === 'snapshot' && ts.isIdentifier(callee.expression)) {
        const decl = this.checker.getSymbolAtLocation(callee.expression)?.declarations?.[0];
        if (
          callee.expression.text === '$state' &&
          decl &&
          /(svelte-runes\.d\.ts|[\\/]node_modules[\\/]svelte[\\/].*\.d\.ts)$/.test(
            decl.getSourceFile().fileName,
          )
        )
          return this.stateSnapshot(e, b);
      }
      if (method === 'bind') {
        const bound = this.classes.bind(e, b);
        if (bound) return bound;
      }
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
      if (global === 'Date') return this.dateStatic(method, e, b);
      if (global === 'Intl') return this.fail(e, 'E_INTL', `Intl.${method} is unsupported`);
      // Methods of Intl constants.
      const intl = this.intlObject(callee.expression);
      if (intl) return this.intlCall(intl, method, e, b);
      if (this.hostName(callee.expression) === 'performance' && method === 'now')
        return { op: 'builtin', name: 'clock.now', args: [], type: NUMBER };
      // Document element methods.
      const owner = skipParens(callee.expression);
      const partOf = ts.isPropertyAccessExpression(owner)
        ? this.hostElement(owner.expression)
        : undefined;
      const rootPart = partOf ? (owner as ts.PropertyAccessExpression).name.text : undefined;
      const family = this.hostElement(callee.expression) ?? partOf;
      if (
        family &&
        (rootPart === 'classList' ||
          rootPart === 'style' ||
          (this.hostElement(callee.expression) &&
            // (The body's other methods are an element's: `document.body.focus()`.)
            (family === 'root' ||
              ['setAttribute', 'removeAttribute', 'getAttribute'].includes(method))))
      ) {
        const a = e.arguments.map(x => this.expr(x, b));
        const op = (n: string, args: Expr[], type: Type): Expr => ({
          op: 'builtin',
          name: `${family}.${n}`,
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
          // (M6 overlays: every element in the document is in the html
          // element, as is the html element itself.)
          if (method === 'contains' && a.length === 1)
            return this.maybeElementTest(a[0], b, e, x => ({
              op: 'builtin',
              name: 'element.isConnected',
              args: [x],
              type: BOOLEAN,
            }));
        }
        return this.fail(
          e,
          'E_CALL',
          `document.${family === 'root' ? 'documentElement' : 'body'} ${rootPart ? rootPart + '.' : ''}${method} is unsupported`,
        );
      }
      const host = this.hostName(callee.expression);
      // Timers and microtasks through `window.` are the global functions.
      if (host === 'window' && WINDOW_FUNCTIONS.has(method)) {
        const hosted = this.hostCall(method, e, b);
        if (hosted) return hosted;
      }
      // getComputedStyle(element): the element, whose properties are read
      // through getPropertyValue (elementMethod).
      if (host === 'window' && method === 'getComputedStyle') {
        if (e.arguments.length !== 1)
          return this.fail(e, 'E_CALL', 'getComputedStyle takes an element (no pseudo-element)');
        return this.coerce(e.arguments[0], b, 'element');
      }
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
        // `{ once: true }` with an inline function (bits-ui's trigger: `pointerup`
        // on the document): no other code can name the function to remove it.
        const once =
          !!options &&
          method === 'addEventListener' &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.length === 1 &&
          ts.isPropertyAssignment(options.properties[0]) &&
          options.properties[0].name.getText() === 'once' &&
          options.properties[0].initializer.kind === ts.SyntaxKind.TrueKeyword &&
          !!listener &&
          (ts.isArrowFunction(skipParens(listener)) ||
            ts.isFunctionExpression(skipParens(listener)));
        // `true` or `{ capture: true }`: a capture listener (bits-ui's submenu
        // intent: `doc.addEventListener("pointermove", f, true)`), removed by
        // the same flag.
        const capture =
          !!options &&
          (options.kind === ts.SyntaxKind.TrueKeyword ||
            (ts.isObjectLiteralExpression(options) &&
              options.properties.length === 1 &&
              ts.isPropertyAssignment(options.properties[0]) &&
              options.properties[0].name.getText() === 'capture' &&
              options.properties[0].initializer.kind === ts.SyntaxKind.TrueKeyword));
        if (options && !once && !capture)
          this.fail(
            options,
            'E_EVENT',
            'Listener options other than capture (passive, once with a named function) are planned for a later milestone; once is supported with an inline function',
          );
        const supported = (k: string) =>
          EVENT_KINDS.includes(k as EventKind) ||
          (host === 'window' && WINDOW_EVENT_KINDS.includes(k as EventKind));
        if (!type || !ts.isStringLiteralLike(type) || !supported(type.text))
          this.fail(type ?? e, 'E_EVENT', `${host}.${method} takes a supported event name literal`);
        if (once)
          return this.onceListener(
            `${host}`,
            (type as ts.StringLiteral).text,
            this.expr(listener!, b),
            b,
          );
        return {
          op: 'builtin',
          name: `${host}.${method === 'addEventListener' ? 'listen' : 'unlisten'}${capture ? '-capture' : ''}`,
          args: [{ op: 'lit', value: (type as ts.StringLiteral).text }, this.expr(listener, b)],
          type: 'void',
        };
      }
      // The visual viewport's listeners (M6 overlays).
      if (
        host === 'visualViewport' &&
        (method === 'addEventListener' || method === 'removeEventListener')
      ) {
        const [type, listener, options] = e.arguments;
        if (options)
          this.fail(
            options,
            'E_EVENT',
            'Listener options (capture, passive, once) are planned for a later milestone',
          );
        if (!type || !ts.isStringLiteralLike(type) || !['resize', 'scroll'].includes(type.text))
          this.fail(type ?? e, 'E_EVENT', `visualViewport.${method} takes resize or scroll`);
        if (!listener) return this.fail(e, 'E_EVENT', `${method} takes a listener`);
        return {
          op: 'builtin',
          name: `visual-viewport.${method === 'addEventListener' ? 'listen' : 'unlisten'}`,
          args: [{ op: 'lit', value: (type as ts.StringLiteral).text }, this.expr(listener, b)],
          type: 'void',
        };
      }
      const service = this.hostServiceCall(e, callee, b);
      if (service) return service;
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
      if (
        global === 'Number' &&
        ['isNaN', 'isFinite', 'isInteger', 'isSafeInteger'].includes(method) &&
        e.arguments.length === 1
      ) {
        // Not a number (untyped JavaScript specialised for strings: bits-ui's
        // isEqual): false, as these never convert their argument.
        const v = this.expr(e.arguments[0], b);
        const t = this.irType(v, b);
        if (t !== NUMBER && maybeInner(t) !== NUMBER)
          return {
            op: 'with',
            local: b.local('$value', t),
            value: v,
            body: { op: 'lit', value: false },
          };
      }
      if (global === 'Object' && method === 'is' && e.arguments.length === 2)
        return this.objectIs(e, b);
      // A dictionary object's keys or values (bits-ui's
      // `Object.values(this.#interceptedEvents)`), in its own-key order.
      if (
        global === 'Object' &&
        (method === 'keys' || method === 'values') &&
        e.arguments.length === 1
      ) {
        const v = this.expr(e.arguments[0], b);
        const t = this.irType(v, b);
        if (typeof t === 'object' && 'map' in t && t.map[0] === STRING)
          return {
            op: 'builtin',
            name: `map.dictionary-${method}`,
            args: [v],
            type: { array: method === 'keys' ? STRING : t.map[1] },
          };
      }
      // `Array.isArray(x.m)` of a member whose type differs between the
      // classes of `x` (bits-ui's Select root template tests its value box,
      // `packUnionRead`): whether the instance's class holds an array there.
      const tested = e.arguments.length === 1 ? skipParens(e.arguments[0]) : undefined;
      const union =
        global === 'Array' &&
        method === 'isArray' &&
        tested &&
        ts.isPropertyAccessExpression(tested)
          ? this.types.typeOrUndefined(tested.expression)
          : undefined;
      if (
        typeof union === 'object' &&
        'classes' in union &&
        union.classes.every(r => this.recordMembers.has(r))
      ) {
        const access = tested as ts.PropertyAccessExpression;
        const object = this.expr(access.expression, b);
        return {
          op: 'match-class',
          value: object,
          cases: union.classes.map(record => {
            const local = b.local(`$${this.types.records[record].name}`, { record });
            const read = this.memberOf(record, { op: 'local', local }, access.name, access, b);
            const t = this.irType(read, b);
            const value = b.local('$tested', t);
            return {
              record,
              local,
              body: {
                op: 'with',
                local: value,
                value: read,
                body: { op: 'lit', value: typeof t === 'object' && 'array' in t },
              },
            };
          }),
        };
      }
      if (global && STATIC_NAMESPACES.has(global))
        return this.builtinCall(`${global}.${method}`, args(), b, this.tsCallType(e), e);
      if (global === 'Promise') {
        if (!['resolve', 'reject', 'all'].includes(method))
          return this.fail(e, 'E_BUILTIN', `Promise.${method} is planned for later`);
        // Promise.resolve(): fulfilled with undefined.
        if (method === 'resolve' && !e.arguments.length)
          return {
            op: 'builtin',
            name: 'promise.resolve',
            args: [{ op: 'undefined', type: 'void' }],
            type: { promise: 'void' },
          };
        return this.builtinCall(`promise.${method}`, args(), b, this.tsCallType(e), e);
      }
      if (ts.isIdentifier(callee.expression)) {
        const special = this.binding(callee.expression);
        if (special?.kind === 'props')
          return { op: 'call-value', callee: this.property(callee, b), args: this.callArgs(e, b) };
        if (special?.kind === 'class') return this.classes.callStatic(special.cls, callee, e, b);
        if (special?.kind === 'pack') {
          const m = special.methods?.[method];
          if (!m) return this.fail(e, 'E_PACK', `${special.label}: .${method}() is not covered`);
          return m(e, b, this);
        }
      }
      // A function of a module namespace (`ns.f(…)`).
      if (this.namespaceOf(callee.expression)) {
        const member = this.symbol(callee.name);
        const found = member && this.bindingOf(member);
        if (found?.kind === 'function')
          return { op: 'call', function: found.fn, args: this.callArgs(e, b) };
        if (found?.kind === 'generic') return this.specialise(found, e, b);
        if (found?.kind === 'pack' && found.call) return found.call(e, b, this);
      }
      let receiver = this.expr(callee.expression, b);
      // An element TypeScript knows is there (`e.currentTarget` during the
      // dispatch): calling a method on null would throw a TypeError.
      const rt = this.irType(receiver, b);
      const receiverTs = this.checker.getTypeAtLocation(callee.expression);
      if (
        typeof rt === 'object' &&
        'maybe' in rt &&
        rt.maybe === 'element' &&
        !(receiverTs.flags & ts.TypeFlags.Any) &&
        this.checker.getNonNullableType(receiverTs) === receiverTs
      )
        receiver = { op: 'unwrap', value: receiver };
      // An untyped nullable element (untyped JavaScript specialised for a
      // nullable argument: bits-ui's `isValidEvent(e, node)` with
      // `node.closest(…)`): calling a method of null throws a TypeError,
      // as unwrapping does.
      if (
        typeof rt === 'object' &&
        'maybe' in rt &&
        rt.maybe === 'element' &&
        receiverTs.flags & ts.TypeFlags.Any
      )
        receiver = { op: 'unwrap', value: receiver };
      const kind = this.receiverKind(this.irType(receiver, b));
      if (kind === 'promise') return this.promiseMethod(method, receiver, e, b);
      if (kind === 'date') return this.dateMethod(method, receiver, e, b);
      if (kind === 'number' || kind === 'string') {
        const local = this.localeMethod(kind, method, receiver, e, b);
        if (local) return local;
      }
      if (kind === 'regexp') return this.regexpMethod(method, receiver, callee.expression, e, b);
      if (
        kind === 'string' &&
        REGEXP_STRING_METHODS.has(method) &&
        e.arguments[0] &&
        this.types.typeOrUndefined(e.arguments[0]) === 'regexp'
      )
        return this.stringRegexp(method, receiver, e, b);
      if (this.classes.isClass(this.irType(receiver, b)))
        return this.classes.callMethod(this.irType(receiver, b), receiver, callee, e, b);
      // ResizeObserver methods (M6): observe with a literal box option.
      if (
        kind === 'record' &&
        (this.irType(receiver, b) as { record: number }).record === this.types.resizeObserver
      ) {
        const [target, options, ...rest] = e.arguments;
        if (method === 'disconnect' && !e.arguments.length)
          return { op: 'builtin', name: 'resize.disconnect', args: [receiver], type: 'void' };
        if (method === 'unobserve' && target && !options)
          return {
            op: 'builtin',
            name: 'resize.unobserve',
            args: [receiver, this.coerce(target, b, 'element')],
            type: 'void',
          };
        if (method !== 'observe' || !target || rest.length)
          return this.fail(e, 'E_CALL', `ResizeObserver ${method}() is unsupported`);
        let box = 'content-box';
        if (options) {
          const o = skipParens(options);
          const p = ts.isObjectLiteralExpression(o) ? o.properties : undefined;
          const boxProp = p?.[0];
          if (
            !p ||
            p.length > 1 ||
            (boxProp &&
              !(
                ts.isPropertyAssignment(boxProp) &&
                boxProp.name.getText() === 'box' &&
                ts.isStringLiteralLike(boxProp.initializer)
              ))
          )
            return this.fail(
              options,
              'E_CALL',
              'ResizeObserver observe takes { box: "content-box" | "border-box" | "device-pixel-content-box" }',
            );
          if (boxProp)
            box = ((boxProp as ts.PropertyAssignment).initializer as ts.StringLiteral).text;
        }
        return {
          op: 'builtin',
          name: 'resize.observe',
          args: [receiver, this.coerce(target, b, 'element'), { op: 'lit', value: box }],
          type: 'void',
        };
      }
      // IntersectionObserver methods (M6 overlays).
      if (
        kind === 'record' &&
        (this.irType(receiver, b) as { record: number }).record === this.types.intersectionObserver
      ) {
        const [target, ...rest] = e.arguments;
        if (method === 'disconnect' && !e.arguments.length)
          return { op: 'builtin', name: 'intersection.disconnect', args: [receiver], type: 'void' };
        if ((method === 'observe' || method === 'unobserve') && target && !rest.length)
          return {
            op: 'builtin',
            name: `intersection.${method}`,
            args: [receiver, this.coerce(target, b, 'element')],
            type: 'void',
          };
        return this.fail(e, 'E_CALL', `IntersectionObserver ${method}() is unsupported`);
      }
      // MutationObserver methods.
      if (
        kind === 'record' &&
        (this.irType(receiver, b) as { record: number }).record === this.types.mutationObserver
      ) {
        if (method === 'disconnect')
          return { op: 'builtin', name: 'mutation.disconnect', args: [receiver], type: 'void' };
        if (method !== 'observe')
          return this.fail(e, 'E_CALL', `MutationObserver ${method}() is unsupported`);
        const [target, options] = e.arguments;
        const o = options && skipParens(options);
        // { childList: true, subtree } (M6 overlays: bits-ui's focus scope).
        const flags = new Map<string, boolean>();
        if (o && ts.isObjectLiteralExpression(o))
          for (const p of o.properties) {
            const v = ts.isPropertyAssignment(p) ? skipParens(p.initializer).kind : undefined;
            if (p.name && (v === ts.SyntaxKind.TrueKeyword || v === ts.SyntaxKind.FalseKeyword))
              flags.set(p.name.getText(), v === ts.SyntaxKind.TrueKeyword);
          }
        if (
          target &&
          o &&
          ts.isObjectLiteralExpression(o) &&
          flags.get('childList') === true &&
          flags.size === o.properties.length &&
          [...flags.keys()].every(k => k === 'childList' || k === 'subtree')
        )
          return {
            op: 'builtin',
            name: 'mutation.observe-children',
            args: [
              receiver,
              this.coerce(target, b, 'element'),
              { op: 'lit', value: flags.get('subtree') === true },
            ],
            type: 'void',
          };
        const filter =
          o && ts.isObjectLiteralExpression(o)
            ? o.properties.find(p => p.name?.getText() === 'attributeFilter')
            : undefined;
        const attributes =
          o && ts.isObjectLiteralExpression(o)
            ? o.properties.find(p => p.name?.getText() === 'attributes')
            : undefined;
        if (
          !target ||
          !o ||
          !ts.isObjectLiteralExpression(o) ||
          o.properties.length !== 2 ||
          !filter ||
          !ts.isPropertyAssignment(filter) ||
          !attributes ||
          !ts.isPropertyAssignment(attributes) ||
          attributes.initializer.kind !== ts.SyntaxKind.TrueKeyword
        )
          return this.fail(
            e,
            'E_CALL',
            'MutationObserver observe is supported with { attributes: true, attributeFilter: [...] }',
          );
        return {
          op: 'builtin',
          name: 'mutation.observe',
          args: [
            receiver,
            this.coerce(target, b, 'element'),
            this.coerce((filter as ts.PropertyAssignment).initializer, b, { array: STRING }),
          ],
          type: 'void',
        };
      }
      const recordType = this.irType(receiver, b);
      const members =
        kind === 'record' && this.recordMembers.get((recordType as { record: number }).record);
      if (members && members.call) return members.call(method, receiver, e, b);
      if (kind === 'record')
        return {
          op: 'call-value',
          callee: this.calleeOf(this.expr(callee, b), b),
          args: this.callArgs(e, b),
        };
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
      if (
        kind === 'array' &&
        (method === 'includes' || method === 'indexOf' || method === 'lastIndexOf') &&
        e.arguments.length === 1
      ) {
        // A nullable value searched in an array of non-nullable elements
        // (bits-ui's `value.includes(this.opts.value.current)`): nullish is
        // never found.
        const elem = (this.irType(receiver, b) as { array: Type }).array;
        const x = this.expr(e.arguments[0], b);
        const xt = this.irType(x, b);
        if (!maybeInner(elem) && maybeInner(xt) && sameType(maybeInner(xt)!, elem)) {
          const arr = b.local('$array', { array: elem });
          const v = b.local('$value', xt);
          const read: Expr = { op: 'local', local: v };
          return {
            op: 'with',
            local: arr,
            value: receiver,
            body: {
              op: 'with',
              local: v,
              value: x,
              body: {
                op: 'cond',
                test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: BOOLEAN },
                then:
                  method === 'includes' ? { op: 'lit', value: false } : { op: 'lit', value: -1 },
                else: this.builtinCall(
                  `array.${method}`,
                  [
                    { op: 'local', local: arr },
                    { op: 'unwrap', value: read },
                  ],
                  b,
                  this.tsCallType(e),
                  e,
                ),
              },
            },
          };
        }
      }
      if (kind === 'array' && ARRAY_CALLBACKS.has(method)) {
        // A callback whose parameters TypeScript does not type (untyped
        // JavaScript specialised per call site: bits-ui's arraysAreEqual)
        // takes the element type, the index and the array.
        const at = this.irType(receiver, b) as { array: Type };
        const typed = e.arguments.map(a => {
          const f = skipParens(a);
          const callbackParams = (n: number): Type[] =>
            (method === 'sort' || method === 'toSorted'
              ? [at.array, at.array]
              : [at.array, NUMBER, at]
            ).slice(0, n);
          // An untyped function passed by name (bits-ui's
          // `boundary.filter(isNotNull)`): specialised for the parameters.
          // The global `Boolean` as a predicate (bits-ui's
          // `Object.values(…).some(Boolean)`): the truthiness of the element.
          if (
            ts.isIdentifier(f) &&
            f.text === 'Boolean' &&
            this.symbol(f)?.declarations?.some(d =>
              /[\\/]lib\.es5\.d\.ts$/.test(d.getSourceFile().fileName),
            ) &&
            method !== 'sort' &&
            method !== 'toSorted'
          ) {
            const index = this.reserve();
            this.functions[index] = {
              name: 'Boolean',
              params: [{ name: 'value', type: at.array }],
              locals: [],
              result: BOOLEAN,
              body: [
                {
                  op: 'return',
                  value: { op: 'to-boolean', arg: { op: 'local', local: 0 } } as Expr,
                },
              ],
            };
            return { op: 'closure', function: index, captures: [] } as Expr;
          }
          const named = ts.isIdentifier(f) ? this.binding(f) : undefined;
          if (named?.kind === 'generic' && !named.outer)
            return this.genericValue(named, callbackParams(named.decl.parameters.length), f, b);
          const untyped =
            (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) &&
            f.parameters.some(
              p =>
                !p.type &&
                this.checker.getTypeAtLocation(p).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown),
            );
          if (!untyped) return this.expr(a, b);
          const params: Type[] =
            method === 'sort' || method === 'toSorted'
              ? [at.array, at.array]
              : [at.array, NUMBER, at];
          const { index, builder } = this.function(
            f as ts.ArrowFunction,
            `${b.name}.${method}$callback`,
            b,
            b.component,
            undefined,
            params.slice(0, (f as ts.ArrowFunction).parameters.length),
          );
          return {
            op: 'closure',
            function: index,
            captures: builder.captureSources.map(c => c.local),
          } as Expr;
        });
        // (filter keeps the receiver's items: its type, whatever narrowing
        // TypeScript applies through a type predicate, which follows.)
        const out = this.builtinCall(
          `array.${method}`,
          [receiver, ...typed],
          b,
          method === 'filter' ? this.irType(receiver, b) : this.tsCallType(e),
          e,
        );
        // filter with a type predicate excluding null (bits-ui's
        // `filter(isNotNull)`): the kept values, of the narrowed type.
        const ot = this.irType(out, b);
        const kept = typeof ot === 'object' && 'array' in ot ? maybeInner(ot.array) : undefined;
        const sig = e.arguments[0] && this.checker.getResolvedSignature(e);
        const callback =
          sig?.parameters[0] && this.checker.getTypeOfSymbolAtLocation(sig.parameters[0], e);
        const predicate = callback
          ?.getCallSignatures()
          .some(s => this.checker.getTypePredicateOfSignature(s) !== undefined);
        const tsResult = this.tsCallType(e);
        // (An untyped package function whose declaration file declares it
        // `(value: T | null) => value is T`: bits-ui's isNotNull.)
        const arg0 = e.arguments[0] && skipParens(e.arguments[0]);
        const generic = arg0 && ts.isIdentifier(arg0) ? this.binding(arg0) : undefined;
        const dropsNull = generic?.kind === 'generic' && declaredNotNull(generic.decl);
        if (
          method === 'filter' &&
          kept !== undefined &&
          ((predicate &&
            tsResult &&
            typeof tsResult === 'object' &&
            'array' in tsResult &&
            sameType(tsResult.array, kept)) ||
            dropsNull)
        ) {
          const unwrap = this.reserve();
          this.functions[unwrap] = {
            name: 'filter$narrowed',
            params: [{ name: 'v', type: { maybe: kept } }],
            locals: [],
            result: kept,
            body: [{ op: 'return', value: { op: 'unwrap', value: { op: 'local', local: 0 } } }],
          };
          return {
            op: 'builtin',
            name: 'array.map',
            args: [out, { op: 'closure', function: unwrap, captures: [] }],
            type: { array: kept },
          };
        }
        return out;
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

  /** Member `name` of a record a pack reads. */
  private memberOf(
    record: number,
    object: Expr,
    name: ts.MemberName,
    at: ts.PropertyAccessExpression,
    b: FnBuilder,
  ): Expr {
    return this.recordMembers.get(record)!.read(name.text, object, at, b);
  }

  /**
   * A member of a class reference to records a mapping pack reads
   * (svelte-toolbelt's boxes: bits-ui's Select reads
   * `rootState.opts.value.current` of a `WritableBox<string> |
   * WritableBox<string[]>`), where the member's type differs between the
   * classes: read as the classes whose member has the type TypeScript gives
   * the read, as narrowed (`Array.isArray`) or asserted (`as string`)
   * there. The downcast to them throws a TypeError only where the static
   * types were unsound. Undefined for other class references.
   */
  private packUnionRead(
    e: ts.PropertyAccessExpression,
    object: Expr,
    classes: number[],
    b: FnBuilder,
  ): Expr | undefined {
    if (!classes.every(r => this.recordMembers.has(r))) return undefined;
    const name = e.name.text;
    let at: ts.Node = e;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    if (ts.isAsExpression(at.parent) || ts.isTypeAssertionExpression(at.parent)) at = at.parent;
    const want = this.types.tryMap(this.checker.getTypeAtLocation(at), at);
    const cases = classes.map(record => {
      const local = b.local(`$${this.types.records[record].name}`, { record });
      return { record, local, body: this.memberOf(record, { op: 'local', local }, e.name, e, b) };
    });
    const types = cases.map(c => this.irType(c.body, b));
    if (types.every(t => sameType(t, types[0]))) return { op: 'match-class', value: object, cases };
    const matching = cases.filter((_, i) => want !== undefined && sameType(types[i], want));
    if (!matching.length)
      return this.fail(
        e,
        'E_MEMBER',
        `${name} has another type in each class of this value; narrow it (Array.isArray, typeof) or assert its type`,
      );
    if (matching.length === 1)
      return {
        op: 'with',
        local: matching[0].local,
        value: { op: 'downcast', value: object, type: { record: matching[0].record } },
        body: matching[0].body,
      };
    return {
      op: 'match-class',
      value: { op: 'downcast', value: object, type: { classes: matching.map(c => c.record) } },
      cases: matching,
    };
  }

  /**
   * Whether type `want` is `have` with more optional fields in its records
   * (an array of them, or one): every field of `have`'s record with the
   * same type, the others nullable. A literal of `have` written where
   * `want` is expected has the type `want` in TypeScript (its other fields
   * undefined).
   */
  widens(have: Type, want: Type): boolean {
    if (typeof have !== 'object' || typeof want !== 'object') return false;
    if ('array' in have && 'array' in want) return this.widens(have.array, want.array);
    if (!('record' in have) || !('record' in want) || have.record === want.record) return false;
    const a = this.types.records[have.record];
    const w = this.types.records[want.record];
    if (a.class || w.class || this.types.accessors.has(want.record)) return false;
    return (
      a.fields.every(f => w.fields.some(g => g.name === f.name && sameType(g.type, f.type))) &&
      w.fields.every(g => a.fields.some(f => f.name === g.name) || maybeInner(g.type) !== undefined)
    );
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
      // No pointer is ever captured (see frontend/dom.d.ts): the receiver
      // and the id are evaluated, the answer is false.
      case 'hasPointerCapture': {
        const [id] = e.arguments;
        if (!id || e.arguments.length !== 1)
          return this.fail(e, 'E_CALL', 'hasPointerCapture takes a pointer id');
        const el = b.local('$element', 'element');
        const pid = b.local('$pointerId', NUMBER);
        return {
          op: 'with',
          local: el,
          value: receiver,
          body: {
            op: 'with',
            local: pid,
            value: this.coerce(id, b, NUMBER),
            body: { op: 'lit', value: false },
          },
        };
      }
      case 'releasePointerCapture':
        return this.unsupportedValue(
          'element$releasePointerCapture',
          'void',
          'releasePointerCapture (no pointer is captured natively)',
        );
      // `select()` (bits-ui's focus helper): the text of a text control.
      case 'select':
      // `click()` (bits-ui's menu items on Enter): a click nested in the script.
      case 'click':
        if (e.arguments.length) this.fail(e, 'E_CALL', `${method}() takes no arguments`);
        return call(method, [], 'void');
      case 'focus':
      case 'blur': {
        // `focus({ preventScroll: true })` (bits-ui's focus helper): the
        // runtime's focus never scrolls the element into view.
        const [options, ...more] = e.arguments;
        const o = options && skipParens(options);
        const preventScroll =
          method === 'focus' &&
          !!o &&
          !more.length &&
          ts.isObjectLiteralExpression(o) &&
          o.properties.length === 1 &&
          ts.isPropertyAssignment(o.properties[0]) &&
          o.properties[0].name.getText() === 'preventScroll' &&
          o.properties[0].initializer.kind === ts.SyntaxKind.TrueKeyword;
        if (e.arguments.length && !preventScroll)
          this.fail(
            e.arguments[0],
            'E_CALL',
            `${method}() options are unsupported (focus({ preventScroll: true }) is covered)`,
          );
        return call(method, [], 'void');
      }
      // (Untyped JavaScript: the result type frontend/dom.d.ts declares.)
      case 'getBoundingClientRect':
      case 'getClientRects':
        return call(method, [], this.tsCallType(e) ?? this.domMethodResult(method, e));
      case 'scrollTo':
      case 'scrollBy':
        return call(method, this.scrollCoordinates(e, b), 'void');
      // `a.contains(b)`: b is a or a descendant (false for null).
      case 'contains': {
        const [other] = e.arguments;
        if (!other || e.arguments.length !== 1)
          return this.fail(e, 'E_CALL', 'contains takes a node');
        return this.maybeElementTest(this.expr(other, b), b, e, x =>
          call('contains', [x], BOOLEAN),
        );
      }
      case 'hasAttribute':
        if (e.arguments.length !== 1) this.fail(e, 'E_CALL', 'hasAttribute takes a name');
        return call(method, [this.coerce(e.arguments[0], b, STRING)], BOOLEAN);
      case 'getAttribute':
        if (e.arguments.length !== 1) this.fail(e, 'E_CALL', 'getAttribute takes a name');
        return call(method, [this.coerce(e.arguments[0], b, STRING)], { maybe: STRING });
      case 'getPropertyValue': {
        // Computed values that are also the resolved values getComputedStyle
        // gives (no layout-dependent properties).
        const [p] = e.arguments;
        if (
          e.arguments.length !== 1 ||
          !ts.isStringLiteralLike(p) ||
          !COMPUTED_PROPERTIES.has(p.text)
        )
          return this.fail(
            e,
            'E_CALL',
            `getComputedStyle(…).getPropertyValue reads ${[...COMPUTED_PROPERTIES].join(', ')}`,
          );
        return call('computed-style', [lit(p.text)], STRING);
      }
      case 'querySelectorAll':
      case 'querySelector':
        if (e.arguments.length !== 1) this.fail(e, 'E_CALL', `${method} takes a selector`);
        return call(
          method,
          [this.coerce(e.arguments[0], b, STRING)],
          method === 'querySelector' ? { maybe: 'element' } : { array: 'element' },
        );
      case 'closest':
        // A selector of runic_js's subset (bits-ui: `closest("form")`,
        // `closest(\`[${CONTEXT_MENU_TRIGGER_ATTR}]\`)`).
        if (e.arguments.length !== 1) this.fail(e, 'E_CALL', 'closest takes a selector');
        return call(method, [this.coerce(e.arguments[0], b, STRING)], { maybe: 'element' });
      case 'requestSubmit':
        // No form element can be rendered (the tag allow-list); reported
        // unsupported if it ever ran.
        if (e.arguments.length) this.fail(e, 'E_CALL', 'requestSubmit takes no submitter');
        return call(method, [], 'void');
      case 'getAnimations': {
        if (e.arguments.length)
          this.fail(e, 'E_CALL', 'getAnimations options (subtree) are unsupported');
        const type = this.tsCallType(e);
        if (!type)
          return this.fail(e, 'E_TYPE_UNSUPPORTED', 'getAnimations needs the Animation type');
        return call(method, [], type);
      }
      case 'scrollIntoView': {
        // Defaults: block start, inline nearest; false aligns the block end.
        let block = 'start';
        let inline = 'nearest';
        const [arg] = e.arguments;
        // An alignment typed as a union of alignments (bits-ui's Select
        // `block: this.opts.scrollAlignment.current`, "nearest" | "center"):
        // a call per alignment, chosen by the value.
        let chosen: { value: Expr; alignments: string[] } | undefined;
        const o = arg && skipParens(arg);
        const dynamic =
          o &&
          ts.isObjectLiteralExpression(o) &&
          o.properties.find(
            p =>
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === 'block' &&
              !ts.isStringLiteralLike(p.initializer),
          );
        if (dynamic && ts.isPropertyAssignment(dynamic)) {
          const t = this.checker.getTypeAtLocation(dynamic.initializer);
          const alignments = (t.isUnion() ? t.types : [t]).map(m =>
            m.isStringLiteral() ? m.value : undefined,
          );
          if (
            alignments.some(
              a => a === undefined || !['start', 'center', 'end', 'nearest'].includes(a),
            ) ||
            (o as ts.ObjectLiteralExpression).properties.some(
              p =>
                p !== dynamic && !(p.name && ts.isIdentifier(p.name) && p.name.text === 'behavior'),
            )
          )
            return this.fail(
              dynamic.initializer,
              'E_CALL',
              'scrollIntoView takes a literal block alignment, or one typed as a union of start, center, end and nearest (with behavior)',
            );
          const rest = ts.factory.updateObjectLiteralExpression(
            o as ts.ObjectLiteralExpression,
            (o as ts.ObjectLiteralExpression).properties.filter(p => p !== dynamic),
          );
          const options = new Map<string, string>();
          for (const p of rest.properties) {
            const init = (p as ts.PropertyAssignment).initializer;
            if (!ts.isStringLiteralLike(init))
              this.fail(p, 'E_CALL', 'Scroll behavior is a literal');
            options.set('behavior', (init as ts.StringLiteral).text);
          }
          this.instantScroll(arg!, options);
          chosen = {
            value: this.coerce(dynamic.initializer, b, STRING),
            alignments: alignments as string[],
          };
        } else if (arg?.kind === ts.SyntaxKind.FalseKeyword) block = 'end';
        else if (arg && arg.kind !== ts.SyntaxKind.TrueKeyword) {
          const options = this.literalOptions(arg, ['block', 'inline', 'behavior']);
          block = options.get('block') ?? block;
          inline = options.get('inline') ?? inline;
          this.instantScroll(arg, options);
        }
        if (!chosen) return call(method, [lit(block), lit(inline)], 'void');
        // The receiver, then the alignment, as evaluated in order.
        const el = b.local('$element', 'element');
        const v = b.local('$block', STRING);
        const scroll = (a: string): Expr => ({
          op: 'builtin',
          name: 'element.scrollIntoView',
          args: [{ op: 'local', local: el }, lit(a), lit(inline)],
          type: 'void',
        });
        const last = chosen.alignments[chosen.alignments.length - 1];
        let chain = scroll(last);
        for (const a of chosen.alignments.slice(0, -1).reverse())
          chain = {
            op: 'cond',
            test: { op: 'eq', left: { op: 'local', local: v }, right: lit(a) },
            then: scroll(a),
            else: chain,
          };
        return {
          op: 'with',
          local: el,
          value: receiver,
          body: { op: 'with', local: v, value: chosen.value, body: chain },
        };
      }
      // Listeners added by script (M6 overlays: floating-ui's autoUpdate
      // listens for its overflow ancestors' `scroll`), identified by their
      // function value as in the browser.
      // An event created by script dispatched at the element (M6 overlays:
      // bits-ui's `MenuOpenEvent.dispatch(node)`): its custom listeners run.
      case 'dispatchEvent': {
        const [event] = e.arguments;
        if (!event || e.arguments.length !== 1)
          return this.fail(e, 'E_CALL', 'dispatchEvent takes an event');
        return call('dispatchEvent', [this.coerce(event, b, 'event')], BOOLEAN);
      }
      case 'addEventListener':
      case 'removeEventListener': {
        const [type, listener, options] = e.arguments;
        if (options)
          this.fail(
            options,
            'E_EVENT',
            'Listener options (capture, passive, once) are planned for a later milestone',
          );
        if (!type || !ts.isStringLiteralLike(type) || !ELEMENT_SCRIPT_EVENTS.includes(type.text))
          this.fail(
            type ?? e,
            'E_EVENT',
            `Element listeners added by script are supported for ${ELEMENT_SCRIPT_EVENTS.join(', ')}`,
          );
        if (!listener) return this.fail(e, 'E_EVENT', `${method} takes a listener`);
        return call(
          method === 'addEventListener' ? 'listen' : 'unlisten',
          [{ op: 'lit', value: (type as ts.StringLiteral).text }, this.expr(listener, b)],
          'void',
        );
      }
    }
    // `element.matches(":focus-visible")` (bits-ui's isFocusVisible): whether
    // it is focused and its focus is visible, by the input modality.
    if (
      method === 'matches' &&
      e.arguments.length === 1 &&
      ts.isStringLiteralLike(e.arguments[0]) &&
      e.arguments[0].text === ':focus-visible'
    )
      return call('focus-visible', [], BOOLEAN);
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
    // A curried function's result: the outer function's values come first.
    const outer = g.outer;
    const outerArgs: Expr[] = (outer?.locals ?? []).map(l => ({
      op: 'local',
      local: b.resolve(outer!.owner, l),
    }));
    const outerTypes = outerArgs.map(a => this.irType(a, b));
    // An untyped function literal passed for a parameter the callee calls:
    // its parameters take the types of the callee's arguments there. Where
    // the callee calls it with arguments of different types (bits-ui's
    // config resolver: `getter(currentOpts)`, `getter(parent.opts)`), a
    // closed literal it only calls is applied at each call instead, lowered
    // for that call's arguments (it captures nothing, so where it is lowered
    // does not matter).
    const inline = new Map<number, ts.FunctionLikeDeclaration>();
    const args: Expr[] = [];
    e.arguments.forEach((a, i) => {
      const fn = skipParens(a);
      const param = g.decl.parameters[i];
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && param) {
        const params = this.calledWith(g.decl, param);
        if (params) this.expectedParams.set(fn, params);
        else if (
          fn.parameters.some(
            q =>
              this.checker.getTypeAtLocation(q).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown),
          ) &&
          this.onlyCalled(g.decl, param) &&
          this.isClosed(fn)
        ) {
          inline.set(i, fn);
          return;
        }
      }
      // A nullable value TypeScript narrowed to its value (bits-ui's
      // `corridorPoly && isPointInPolygon(clientPoint, corridorPoly)`).
      const v = this.expr(a, b);
      const at = this.checker.getTypeAtLocation(a);
      if (
        maybeInner(this.irType(v, b)) !== undefined &&
        !(at.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
        this.checker.getNonNullableType(at) === at
      )
        args.push({ op: 'unwrap', value: v });
      else args.push(v);
    });
    const types = args.map(a => this.irType(a, b));
    if (e.arguments.length < g.decl.parameters.length)
      this.fail(
        e,
        'E_TYPE_UNSUPPORTED',
        `Untyped ${g.name} needs all ${g.decl.parameters.length} arguments (or type annotations)`,
      );
    // A call whose value TypeScript cannot type, where a type is expected
    // (a declared constant, a returned value): the specialisation returns it.
    const tsType = this.checker.getTypeAtLocation(e);
    const want =
      tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
      this.types.tryMap(tsType, e) === undefined
        ? this.expected.get(e)
        : undefined;
    const literals = [...inline].map(([i, fn]) => `${i}@${fn.getSourceFile().fileName}:${fn.pos}`);
    const key = JSON.stringify([outerTypes, types, want ?? null, literals]);
    let index = g.specs.get(key);
    if (index === undefined) {
      index = this.reserve();
      g.specs.set(key, index);
      this.inProgress.add(index);
      const all = [...outerTypes, ...types];
      const restore = this.bindTypeParameters(g.decl, types);
      try {
        this.function(
          g.decl,
          `${g.name}<${all.map(t => JSON.stringify(t)).join(',')}>`,
          undefined,
          g.component,
          index,
          all,
          {
            ...(want !== undefined ? { result: want } : {}),
            ...(outer ? { outer: outer.params } : {}),
            ...(inline.size
              ? {
                  inline: new Map(
                    [...inline].map(([i, fn]) => [
                      i + (outer?.params.length ?? 0),
                      {
                        kind: 'generic' as const,
                        decl: fn,
                        name: `${g.name}.${g.decl.parameters[i].name.getText()}`,
                        component: g.component,
                        specs: new Map<string, number>(),
                      },
                    ]),
                  ),
                }
              : {}),
          },
        );
      } finally {
        restore();
      }
      this.inProgress.delete(index);
    } else if (this.inProgress.has(index))
      this.fail(e, 'E_TYPE_UNSUPPORTED', `Recursive untyped ${g.name}: add type annotations`);
    return {
      op: 'call',
      function: index,
      args: [...outerArgs, ...args.slice(0, g.decl.parameters.length - inline.size)],
    };
  }

  /**
   * Whether `e` names a parameter (of a function or method) for which no
   * call of the program passes an argument: it holds undefined (bits-ui's
   * `listen(element, callback, options?)`, always called with two).
   */
  unpassedParameter(e: ts.Expression): boolean {
    e = skipParens(e);
    if (!ts.isIdentifier(e)) return false;
    const decl = this.symbol(e)?.valueDeclaration;
    if (!decl || !ts.isParameter(decl) || decl.dotDotDotToken || decl.initializer) return false;
    const fn = decl.parent;
    const index = fn.parameters.indexOf(decl);
    if (this.assigned(this.symbol(e)!, fn)) return false;
    let passed = false;
    let called = false;
    const visit = (n: ts.Node) => {
      if (passed) return;
      if (
        (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
        this.checker.getResolvedSignature(n)?.declaration === fn
      ) {
        called = true;
        if ((n.arguments?.length ?? 0) > index || n.arguments?.some(ts.isSpreadElement))
          passed = true;
      }
      // (A function passed as a value may be called with it.)
      if (
        ts.isIdentifier(n) &&
        !ts.isCallExpression(n.parent) &&
        fn.name &&
        this.symbol(n) === this.symbol(fn.name as ts.Identifier) &&
        n !== fn.name
      )
        passed = true;
      ts.forEachChild(n, visit);
    };
    for (const sf of this.program.getSourceFiles()) if (!sf.isDeclarationFile) visit(sf);
    return called && !passed;
  }

  /** The type arguments of the generic function specialisations being lowered, by type parameter. */
  private readonly functionTypeArgs = new Map<ts.Symbol, Type>();

  /**
   * Bind the type parameters of generic function `decl` (a package function
   * annotated from its declaration file: bits-ui's `boxAutoReset<T>`) for
   * one specialisation, from the IR types of its arguments (`types`): each
   * from a parameter declared of that type (`T`, `T[]`, `Array<T>`).
   * Returns the function restoring the previous bindings. While bound,
   * records of types using them are not cached by TypeScript type (another
   * specialisation binds them otherwise).
   */
  private bindTypeParameters(decl: ts.FunctionLikeDeclaration, types: Type[]): () => void {
    const params = (decl.typeParameters ?? []).map(tp => ({
      name: tp.name.text,
      sym: this.checker.getSymbolAtLocation(tp.name),
      type: this.checker.getTypeAtLocation(tp),
    }));
    if (!params.length) return () => {};
    const saved = params.map(p => (p.sym ? this.functionTypeArgs.get(p.sym) : undefined));
    const bind = (name: string, t: Type) => {
      const p = params.find(x => x.name === name);
      if (p?.sym) this.functionTypeArgs.set(p.sym, t);
    };
    const names = new Set(params.map(p => p.name));
    const match = (node: ts.TypeNode, t: Type) => {
      if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword)
        return match(node.type, t);
      if (ts.isParenthesizedTypeNode(node)) return match(node.type, t);
      const element = typeof t === 'object' && 'array' in t ? t.array : undefined;
      if (ts.isArrayTypeNode(node)) {
        if (element !== undefined) match(node.elementType, element);
        return;
      }
      if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return;
      const ref = node.typeName.text;
      if (names.has(ref) && !node.typeArguments) return bind(ref, t);
      if ((ref === 'Array' || ref === 'ReadonlyArray') && node.typeArguments?.length === 1)
        if (element !== undefined) match(node.typeArguments[0], element);
    };
    for (const p of params) if (p.sym) this.functionTypeArgs.delete(p.sym);
    decl.parameters.forEach((p, k) => {
      if (p.type && !p.dotDotDotToken && types[k] !== undefined) match(p.type, types[k]);
    });
    const bound = new Set(params.map(p => p.type));
    const uncached = this.types.uncached;
    this.types.uncached = t => !!uncached?.(t) || usesTypeParameter(t, bound, this.checker);
    return () => {
      this.types.uncached = uncached;
      params.forEach((p, i) => {
        if (!p.sym) return;
        if (saved[i] === undefined) this.functionTypeArgs.delete(p.sym);
        else this.functionTypeArgs.set(p.sym, saved[i]!);
      });
    };
  }

  /**
   * An untyped function (`g`) as a value of a function type: its
   * specialisation for parameter types `params`, which the value forwards to.
   */
  private genericValue(
    g: Extract<Binding, { kind: 'generic' }>,
    params: Type[],
    at: ts.Node,
    b: FnBuilder,
  ): Expr {
    const key = JSON.stringify([[], params, null, []]);
    let index = g.specs.get(key);
    if (index === undefined) {
      index = this.reserve();
      g.specs.set(key, index);
      this.inProgress.add(index);
      this.function(
        g.decl,
        `${g.name}<${params.map(t => JSON.stringify(t)).join(',')}>`,
        undefined,
        g.component,
        index,
        params,
      );
      this.inProgress.delete(index);
    } else if (this.inProgress.has(index))
      this.fail(at, 'E_TYPE_UNSUPPORTED', `Recursive untyped ${g.name}: add type annotations`);
    return this.functionValue(index, true, at as ts.Identifier, b);
  }

  /** Whether untyped parameter `param` is only called directly in `decl`. */
  private onlyCalled(decl: ts.FunctionLikeDeclaration, param: ts.ParameterDeclaration): boolean {
    const sym = ts.isIdentifier(param.name)
      ? this.checker.getSymbolAtLocation(param.name)
      : undefined;
    if (!sym || !decl.body) return false;
    let ok = true;
    const visit = (n: ts.Node) => {
      if (!ok) return;
      if (ts.isIdentifier(n) && n !== param.name && this.checker.getSymbolAtLocation(n) === sym) {
        const call = n.parent;
        if (!(ts.isCallExpression(call) && call.expression === n)) ok = false;
      }
      ts.forEachChild(n, visit);
    };
    visit(decl.body);
    return ok;
  }

  /**
   * Whether a function literal captures nothing: every name it uses is
   * declared inside it or at the top level of a module.
   */
  private isClosed(fn: ts.FunctionLikeDeclaration): boolean {
    let ok = true;
    const inside = (n: ts.Node) => n.pos >= fn.pos && n.end <= fn.end;
    const visit = (n: ts.Node) => {
      if (!ok) return;
      if (ts.isIdentifier(n) && !ts.isPropertyAccessExpression(n.parent)) {
        const decl = this.checker.getSymbolAtLocation(n)?.valueDeclaration;
        if (decl && !inside(decl)) {
          let p: ts.Node | undefined = decl.parent;
          while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p) && !ts.isClassLike(p))
            p = p.parent;
          if (!p || !ts.isSourceFile(p)) ok = false;
        }
      }
      if (n.kind === ts.SyntaxKind.ThisKeyword) ok = false;
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    return ok;
  }

  /**
   * A constant initialised by calling an untyped function whose body only
   * returns a function literal with untyped parameters (bits-ui's
   * `const resolveConfigOption = createConfigResolver(parent, opts)`): the
   * arguments are evaluated now, and each call of the constant calls the
   * literal specialised with them (the outer parameters it uses are the
   * arguments). Undefined for other declarations.
   */
  private curried(d: ts.VariableDeclaration, b: FnBuilder): Stmt[] | undefined {
    if (!ts.isIdentifier(d.name) || !d.initializer || d.type) return undefined;
    if (!(d.parent.flags & ts.NodeFlags.Const)) return undefined;
    const call = skipParens(d.initializer);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined;
    const g = this.binding(call.expression);
    if (g?.kind !== 'generic' || g.outer || !g.decl.body) return undefined;
    let result: ts.Expression | undefined;
    if (ts.isBlock(g.decl.body)) {
      const [only] = g.decl.body.statements;
      if (g.decl.body.statements.length === 1 && ts.isReturnStatement(only))
        result = only.expression;
    } else result = g.decl.body;
    const inner = result && skipParens(result);
    if (!inner || !(ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))) return undefined;
    if (
      !inner.parameters.some(
        q => this.checker.getTypeAtLocation(q).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown),
      ) ||
      g.decl.parameters.some(q => !ts.isIdentifier(q.name) || q.initializer || q.dotDotDotToken) ||
      call.arguments.length !== g.decl.parameters.length
    )
      return undefined;
    const out: Stmt[] = [];
    const locals = call.arguments.map((a, i) => {
      const v = this.expr(a, b);
      const local = b.local(`${d.name.getText()}$${i}`, this.irType(v, b));
      out.push({ op: 'let', local, value: v, ...this.src(a) });
      return local;
    });
    const sym = this.checker.getSymbolAtLocation(d.name)!;
    this.bindings.set(sym, {
      kind: 'generic',
      decl: inner,
      name: `${g.name}.result`,
      component: g.component,
      specs: new Map(),
      outer: { params: g.decl.parameters, owner: b, locals },
    });
    return out;
  }
  private readonly inProgress = new Set<number>();

  /** Register a function declaration: typed functions now, untyped ones per call site. */
  declare(
    sym: ts.Symbol,
    decl: ts.FunctionLikeDeclaration,
    name: string,
    component: number | undefined,
  ): (() => void) | undefined {
    // A function returning the window or the document: its calls are that
    // object.
    const only =
      decl.body && ts.isBlock(decl.body) && decl.body.statements.length === 1
        ? decl.body.statements[0]
        : undefined;
    const host =
      only && ts.isReturnStatement(only) && only.expression
        ? this.hostName(only.expression)
        : undefined;
    if (host === 'window' || host === 'document') {
      this.bindings.set(sym, { kind: 'host', name: host });
      return undefined;
    }
    // Parameters without a type, or typed `unknown`/`any` (package
    // functions whose declarations take `unknown`: bits-ui's isHTMLElement),
    // are specialised per call site.
    // (Also parameters whose types use the function's type parameters: a
    // generic package function annotated from its declaration file.)
    const generic = new Set(
      (decl.typeParameters ?? []).map(t => this.checker.getTypeAtLocation(t)),
    );
    const untyped = decl.parameters.some(
      p =>
        (generic.size > 0 &&
          usesTypeParameter(this.checker.getTypeAtLocation(p), generic, this.checker)) ||
        (!p.type && this.types.typeOrUndefined(p) === undefined) ||
        !!(this.checker.getTypeAtLocation(p).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)),
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
        // A function that never returns normally (it throws): no value.
        result: ret.flags & ts.TypeFlags.Never ? 'void' : this.types.map(ret, decl),
        body: [],
      };
    return () => this.function(decl, name, undefined, component, index);
  }

  /** Arguments with optional parameters widened to Maybe and missing ones as undefined. */
  callArgs(e: ts.CallExpression | ts.NewExpression, b: FnBuilder): Expr[] {
    // A rest parameter spread into the call: its parameters, one argument each.
    const spreadRest = (e.arguments ?? []).some(
      a =>
        ts.isSpreadElement(a) &&
        ts.isIdentifier(a.expression) &&
        this.binding(a.expression)?.kind === 'rest',
    );
    if (spreadRest) {
      const items: (ts.Expression | Expr)[] = [];
      for (const a of e.arguments ?? []) {
        const rest =
          ts.isSpreadElement(a) && ts.isIdentifier(a.expression) && this.binding(a.expression);
        if (rest && rest.kind === 'rest')
          for (const l of rest.locals) items.push({ op: 'local', local: b.resolve(rest.owner, l) });
        else items.push(a);
      }
      const sig = this.checker.getResolvedSignature(e);
      const callee = sig?.getDeclaration();
      // An untyped function value (bits-ui's debounce: `fn(...args)`), or one
      // of a generic class's type parameter (TimeoutFn's `this.#cb(...args)`,
      // TypeScript calls its constraint): the parameters of its IR function type.
      const calleeType = this.checker.getTypeAtLocation(e.expression);
      const valueParams =
        ((!sig || !callee) &&
          ts.isIdentifier(e.expression) &&
          calleeType.flags & ts.TypeFlags.Any) ||
        (calleeType.flags & ts.TypeFlags.TypeParameter && this.types.typeParameter?.(calleeType))
          ? (() => {
              const t = this.irType(this.functionOf(this.expr(e.expression, b), b), b);
              return typeof t === 'object' && 'fn' in t ? t.fn.params : undefined;
            })()
          : undefined;
      if (valueParams && valueParams.length >= items.length)
        return valueParams.map((pt, i) => {
          const arg = items[i];
          if (!arg) return { op: 'undefined', type: pt } as Expr;
          if (!('op' in arg)) return this.coerce(arg, b, pt);
          const at = this.irType(arg, b);
          if (sameType(at, pt)) return arg;
          if (maybeInner(pt) && sameType(at, maybeInner(pt)!)) return { op: 'some', value: arg };
          return this.fail(
            e,
            'E_CALL',
            `A spread parameter of type ${JSON.stringify(at)} is passed where ${JSON.stringify(pt)} is expected`,
          );
        });
      if (!sig || !callee || sig.parameters.length < items.length)
        return this.fail(e, 'E_CALL', 'A rest parameter is spread into a call of known parameters');
      return sig.parameters.map((p, i) => {
        const pt = this.types.map(this.checker.getTypeOfSymbol(p), e);
        const arg = items[i];
        if (!arg) return { op: 'undefined', type: pt } as Expr;
        if (!('op' in arg)) return this.coerce(arg, b, pt);
        const at = this.irType(arg, b);
        if (sameType(at, pt)) return arg;
        if (maybeInner(pt) && sameType(at, maybeInner(pt)!)) return { op: 'some', value: arg };
        return this.fail(
          e,
          'E_CALL',
          `A spread parameter of type ${JSON.stringify(at)} is passed where ${JSON.stringify(pt)} is expected`,
        );
      });
    }
    const argNodes = e.arguments ?? [];
    const sig = this.checker.getResolvedSignature(e);
    const callee = sig?.getDeclaration();
    // An untyped callee (e.g. a JavaScript callback prop) has no parameter list.
    const untyped = this.checker.getTypeAtLocation(e.expression).flags & ts.TypeFlags.Any;
    if (!sig || untyped) return argNodes.map(a => this.expr(a, b));
    // A callee with an overridden function type (a promise's resolve) takes its parameters.
    const given = this.types.overridden(e.expression);
    if (typeof given === 'object' && 'fn' in given)
      return given.fn.params.map((pt, i) => {
        const arg = argNodes[i];
        return arg ? this.coerce(arg, b, pt) : ({ op: 'undefined', type: pt } as Expr);
      });
    // Parameters TypeScript types outside the value model (svelte-toolbelt's
    // `executeCallbacks(…)` result, `(...args: unknown[]) => void`) of a
    // function value whose IR type is known: its IR parameters.
    // (Not a method, which is no value: `MenuOpenEvent.dispatch(node)`.)
    const method = !!callee && (ts.isMethodDeclaration(callee) || ts.isMethodSignature(callee));
    if (
      plainName(e.expression) &&
      !method &&
      sig.parameters.some(
        p => this.types.tryMap(this.checker.getTypeOfSymbolAtLocation(p, e), e) === undefined,
      )
    ) {
      const ft = this.irType(this.functionOf(this.expr(e.expression, b), b), b);
      if (typeof ft === 'object' && 'fn' in ft && argNodes.length <= ft.fn.params.length)
        return ft.fn.params.map((pt, i) => {
          const arg = argNodes[i];
          return arg ? this.coerce(arg, b, pt) : ({ op: 'undefined', type: pt } as Expr);
        });
    }
    return sig.parameters.flatMap((p, i) => {
      let t = this.checker.getTypeOfSymbolAtLocation(p, e);
      // (A parameter declared of a bound type parameter, `detail?: T` of a
      // generic class's instantiation: the binding, `TypeMapper.typeParameter`.)
      const declared = callee && 'parameters' in callee ? callee.parameters[i]?.type : undefined;
      if (
        t.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any) &&
        declared &&
        ts.isTypeReferenceNode(declared)
      ) {
        const tp = this.checker.getTypeAtLocation(declared);
        if (tp.flags & ts.TypeFlags.TypeParameter && this.types.typeParameter?.(tp) !== undefined)
          t = tp;
      }
      // A rest parameter of a tuple type: one argument per item (its
      // parameters, frontend/types.ts).
      const decl = p.valueDeclaration;
      // (The document or the window as a parameter: none, `hostParam`.)
      if (decl && ts.isParameter(decl) && this.hostParam(decl)) return [];
      const items =
        decl && ts.isParameter(decl) && decl.dotDotDotToken
          ? this.types.restParams(t, e)
          : undefined;
      return (items ?? [this.types.map(t, e)]).map((pt, j) => {
        const arg = argNodes[i + j];
        if (!arg) return { op: 'undefined', type: pt } as Expr;
        return this.coerce(arg, b, pt);
      });
    });
  }

  /** `test(x)` of an element value, false where a nullable one is null or undefined. */
  maybeElementTest(v: Expr, b: FnBuilder, at: ts.Node, test: (x: Expr) => Expr): Expr {
    const t = this.irType(v, b);
    if (t === 'element') return test(v);
    if (JSON.stringify(t) !== JSON.stringify({ maybe: 'element' }))
      return this.fail(at, 'E_CALL', 'contains takes an element');
    const local = b.local('$node', t);
    const read: Expr = { op: 'local', local };
    return {
      op: 'with',
      local,
      value: v,
      body: {
        op: 'cond',
        test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: BOOLEAN },
        then: { op: 'lit', value: false },
        else: test({ op: 'unwrap', value: read }),
      },
    };
  }

  /** The IR type of the result of element method `name` as frontend/dom.d.ts declares it. */
  private domMethodResult(name: string, at: ts.Node): Type {
    const dom = this.program.getSourceFiles().find(f => path.resolve(f.fileName) === DOM);
    const decl = dom?.statements.find(
      (s): s is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(s) && s.name.text === 'HTMLElement',
    );
    const member = decl?.members.find(
      (m): m is ts.MethodSignature =>
        ts.isMethodSignature(m) && ts.isIdentifier(m.name) && m.name.text === name,
    );
    const sig = member && this.checker.getSignatureFromDeclaration(member);
    if (!sig) return this.fail(at, 'E_MEMBER', `Element ${name} is not declared`);
    return this.types.map(sig.getReturnType(), at);
  }

  /**
   * A call of a function (named `name`, of result type `type`) that throws
   * RunicUnsupportedError with `message`: a value the native runtime does
   * not cover, where it is computed.
   */
  /** A call throwing a TypeError with `message` where a value of `type` is expected. */
  typeErrorValue(name: string, type: Type, message: string): Expr {
    const index = this.reserve();
    this.functions[index] = {
      name,
      params: [],
      locals: [],
      result: type,
      body: [
        {
          op: 'throw',
          value: {
            op: 'record',
            record: this.errorRecord(),
            fields: [
              { op: 'lit', value: 'TypeError' },
              { op: 'lit', value: message },
            ],
          },
        },
      ],
    };
    return { op: 'call', function: index, args: [] };
  }

  unsupportedValue(name: string, type: Type, message: string): Expr {
    const index = this.reserve();
    this.functions[index] = {
      name,
      params: [],
      locals: [],
      result: type,
      body: [
        {
          op: 'throw',
          value: {
            op: 'record',
            record: this.errorRecord(),
            fields: [
              { op: 'lit', value: 'RunicUnsupportedError' },
              { op: 'lit', value: message },
            ],
          },
        },
      ],
    };
    return { op: 'call', function: index, args: [] };
  }

  private newExpression(e: ts.NewExpression, b: FnBuilder): Expr {
    const svelteMap = newSvelteMap(e, this);
    if (svelteMap) return svelteMap;
    // Image objects load images over the network or from files, which the
    // native runtime does not (no <img> either): `new Image()` throws
    // RunicUnsupportedError when it runs (frontend/dom.d.ts).
    if (this.hostName(e.expression) === 'Image') {
      const type = this.types.of(e);
      const index = this.reserve();
      this.functions[index] = {
        name: 'Image$new',
        params: [],
        locals: [],
        result: type,
        body: [
          {
            op: 'throw',
            value: {
              op: 'record',
              record: this.errorRecord(),
              fields: [
                { op: 'lit', value: 'RunicUnsupportedError' },
                {
                  op: 'lit',
                  value: 'new Image(): the native runtime loads no images',
                },
              ],
            },
          },
        ],
      };
      return { op: 'call', function: index, args: [] };
    }
    const global = this.globalName(e.expression);
    if (ts.isIdentifier(e.expression)) {
      const cls = this.binding(e.expression);
      if (cls?.kind === 'class') return this.classes.construct(cls.cls, e, b);
      if (cls?.kind === 'pack' && cls.construct) return cls.construct(e, b, this);
    }
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
    if (global === 'Date') return this.dateNew(e, b);
    // new ResizeObserver(callback) (M6): an observer record holding the
    // callback, registered in creation order (deliveries follow it).
    if (this.hostName(e.expression) === 'ResizeObserver') {
      const [cb] = e.arguments ?? [];
      const type = this.types.of(e);
      if (!cb || e.arguments!.length !== 1 || typeof type !== 'object' || !('record' in type))
        return this.fail(e, 'E_NEW', 'new ResizeObserver takes a callback');
      return {
        op: 'builtin',
        name: 'resize.new',
        args: [this.coerce(cb, b, this.types.records[type.record].fields[0].type)],
        type,
      };
    }
    // new IntersectionObserver(callback, { root, rootMargin, threshold })
    // (M6 overlays): an observer record holding the callback; the root is
    // the document's viewport (`root` absent, null or the document).
    if (this.hostName(e.expression) === 'IntersectionObserver') {
      const [cb, options, ...rest] = e.arguments ?? [];
      const type = this.types.of(e);
      if (!cb || rest.length || typeof type !== 'object' || !('record' in type))
        return this.fail(e, 'E_NEW', 'new IntersectionObserver takes a callback and options');
      let rootMargin: Expr = { op: 'lit', value: '0px' };
      let thresholds: Expr = { op: 'array', type: { array: NUMBER }, items: [] };
      if (options) {
        const o = skipParens(options);
        if (!ts.isObjectLiteralExpression(o))
          return this.fail(options, 'E_NEW', 'IntersectionObserver options are an object literal');
        for (const p of o.properties) {
          const name = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
          if (!name || !(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)))
            return this.fail(p, 'E_NEW', 'IntersectionObserver options are named properties');
          const value = ts.isPropertyAssignment(p) ? p.initializer : p.name;
          if (name === 'root') {
            const v = skipParens(value);
            if (
              v.kind !== ts.SyntaxKind.NullKeyword &&
              !(ts.isIdentifier(v) && v.text === 'undefined' && !this.binding(v)) &&
              this.hostName(v) !== 'document'
            )
              return this.fail(
                p,
                'E_NEW',
                'IntersectionObserver roots other than the document (an element, scrolling) are planned for later',
              );
          } else if (name === 'rootMargin') rootMargin = this.coerce(value, b, STRING);
          else if (name === 'threshold') {
            // A number or an array of numbers.
            const v = this.expr(value, b);
            const t = this.irType(v, b);
            if (t === NUMBER) thresholds = { op: 'array', type: { array: NUMBER }, items: [v] };
            else if (sameType(t, { array: NUMBER })) thresholds = v;
            else
              return this.fail(p, 'E_NEW', 'IntersectionObserver threshold is a number or numbers');
          } else return this.fail(p, 'E_NEW', `IntersectionObserver option ${name} is unsupported`);
        }
      }
      return {
        op: 'builtin',
        name: 'intersection.new',
        args: [
          this.coerce(cb, b, this.types.records[type.record].fields[0].type),
          rootMargin,
          thresholds,
        ],
        type,
      };
    }
    // new CustomEvent(type, init) (M6 overlays): an event created by script,
    // passed to a callback (which may cancel it) or dispatched at an element
    // (`element.dispatchEvent`). The options are `bubbles`, `cancelable`,
    // `composed` (no shadow roots exist: no effect) and a `detail` that holds
    // nothing; given as an object literal or as a record (bits-ui's
    // `{ ...this.options, detail }`).
    if (this.hostName(e.expression) === 'CustomEvent') {
      const [type, init, ...rest] = e.arguments ?? [];
      if (!type || rest.length)
        return this.fail(e, 'E_NEW', 'new CustomEvent takes a type and options');
      let cancelable: Expr = { op: 'lit', value: false };
      let bubbles: Expr = { op: 'lit', value: false };
      const nothing = (v: Expr) => {
        const t = this.irType(v, b);
        return t === 'void' || (typeof t === 'object' && 'maybe' in t && t.maybe === 'void');
      };
      const o = init && skipParens(init);
      const staticKeys =
        o &&
        ts.isObjectLiteralExpression(o) &&
        o.properties.every(
          p =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            ts.isIdentifier(p.name),
        );
      // (Values evaluated before the event is created, in order.)
      const setups: { local: number; value: Expr }[] = [];
      const evaluate = (value: Expr) =>
        setups.push({ local: b.local('$option', this.irType(value, b)), value });
      if (o && staticKeys) {
        for (const p of (o as ts.ObjectLiteralExpression).properties) {
          const key = (p.name as ts.Identifier).text;
          const value = ts.isPropertyAssignment(p)
            ? p.initializer
            : (p as ts.ShorthandPropertyAssignment).name;
          if (key === 'cancelable') cancelable = this.coerce(value, b, BOOLEAN);
          else if (key === 'bubbles') bubbles = this.coerce(value, b, BOOLEAN);
          else if (key === 'composed') evaluate(this.expr(value, b));
          else if (key === 'detail') {
            const v = this.expr(value, b);
            if (!nothing(v))
              return this.fail(
                p,
                'E_NEW',
                'A CustomEvent detail other than undefined is not covered',
              );
            evaluate(v);
          } else return this.fail(p, 'E_NEW', `CustomEvent option ${key} is not covered`);
        }
      } else if (init) {
        // A record of the options: its fields (absent: false).
        const v = this.expr(init, b);
        const t = this.irType(v, b);
        const record =
          typeof t === 'object' && 'record' in t ? this.types.records[t.record] : undefined;
        if (!record)
          return this.fail(init, 'E_NEW', 'CustomEvent options are an object or a record of them');
        const local = b.local('$init', t);
        setups.push({ local, value: v });
        const flag = (name: string): Expr | undefined => {
          const field = record.fields.findIndex(f => f.name === name);
          if (field < 0) return undefined;
          const ft = record.fields[field].type;
          const get: Expr = { op: 'get', object: { op: 'local', local }, field };
          return maybeInner(ft)
            ? { op: 'nullish', left: get, right: { op: 'lit', value: false } }
            : get;
        };
        for (const f of record.fields)
          if (!['bubbles', 'cancelable', 'composed', 'detail'].includes(f.name))
            return this.fail(init, 'E_NEW', `CustomEvent option ${f.name} is not covered`);
        const detail = record.fields.find(f => f.name === 'detail');
        if (
          detail &&
          !(
            detail.type === 'void' ||
            (typeof detail.type === 'object' &&
              'maybe' in detail.type &&
              detail.type.maybe === 'void')
          )
        )
          return this.fail(
            init,
            'E_NEW',
            'A CustomEvent detail other than undefined is not covered',
          );
        cancelable = flag('cancelable') ?? cancelable;
        bubbles = flag('bubbles') ?? bubbles;
      }
      const created: Expr = {
        op: 'builtin',
        name: 'event.new',
        args: [this.coerce(type, b, STRING), cancelable, bubbles],
        type: 'event',
      };
      return setups.reduceRight<Expr>(
        (body, { local, value }) => ({ op: 'with', local, value, body }),
        created,
      );
    }
    // new Proxy(target, handler) (bits-ui's dismissible layer wraps a
    // cancelled event): the target, then RunicUnsupportedError (a handler of
    // function literals, whose creation has no effect).
    if (
      ts.isIdentifier(e.expression) &&
      e.expression.text === 'Proxy' &&
      this.symbol(e.expression)?.declarations?.some(d =>
        /[\\/]lib\.es2015\.proxy\.d\.ts$/.test(d.getSourceFile().fileName),
      )
    ) {
      const [target, handler, ...rest] = e.arguments ?? [];
      const h = handler && skipParens(handler);
      const literal = (x: ts.Expression) => {
        x = skipParens(x);
        return ts.isArrowFunction(x) || ts.isFunctionExpression(x);
      };
      if (
        !target ||
        !h ||
        rest.length ||
        !ts.isObjectLiteralExpression(h) ||
        !h.properties.every(
          p => ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && literal(p.initializer)),
        )
      )
        return this.fail(
          e,
          'E_NEW',
          'new Proxy takes a target and an object literal of handler functions',
        );
      const v = this.expr(target, b);
      const t = this.irType(v, b);
      return {
        op: 'with',
        local: b.local('$target', t),
        value: v,
        body: this.unsupportedValue('Proxy$new', t, 'new Proxy(…)'),
      };
    }
    // new PointerEvent(type, e) (bits-ui's dismissible layer wraps a
    // cancelled event in a Proxy of one): its arguments, then
    // RunicUnsupportedError.
    if (this.hostName(e.expression) === 'PointerEvent') {
      let out = this.unsupportedValue(
        'PointerEvent$new',
        'event',
        'new PointerEvent(…) (an event created by script with pointer members)',
      );
      // (The arguments are evaluated first; an options literal's values in order.)
      const values = (e.arguments ?? []).flatMap(a => {
        const o = skipParens(a);
        if (!ts.isObjectLiteralExpression(o)) return [a];
        return o.properties.map(p => {
          if (ts.isPropertyAssignment(p)) return p.initializer;
          if (ts.isShorthandPropertyAssignment(p)) return p.name;
          return this.fail(p, 'E_NEW', 'PointerEvent options are plain properties');
        });
      });
      for (const a of [...values].reverse()) {
        const v = this.expr(a, b);
        out = { op: 'with', local: b.local('$argument', this.irType(v, b)), value: v, body: out };
      }
      return out;
    }
    // new KeyboardEvent(type, e) of another event (M6 overlays: bits-ui's
    // escape layer): a copy of its key, modifiers and cancelability.
    if (this.hostName(e.expression) === 'KeyboardEvent') {
      const [type, init, ...rest] = e.arguments ?? [];
      const source = init && this.expr(init, b);
      if (!type || !source || rest.length || this.irType(source, b) !== 'event')
        return this.fail(e, 'E_NEW', 'new KeyboardEvent takes a type and an event to copy');
      return {
        op: 'builtin',
        name: 'event.keyboard',
        args: [this.coerce(type, b, STRING), source],
        type: 'event',
      };
    }
    // new MutationObserver(callback): a record holding the callback,
    // registered in creation order (notifications follow it).
    if (this.hostName(e.expression) === 'MutationObserver') {
      const [cb] = e.arguments ?? [];
      const type = this.types.of(e);
      if (!cb || e.arguments!.length !== 1 || typeof type !== 'object' || !('record' in type))
        return this.fail(e, 'E_NEW', 'new MutationObserver takes a callback');
      return {
        op: 'builtin',
        name: 'mutation.new',
        args: [this.coerce(cb, b, { fn: { params: [], result: 'void' } })],
        type,
      };
    }
    if (
      ts.isPropertyAccessExpression(e.expression) &&
      this.globalName(e.expression.expression) === 'Intl'
    ) {
      this.intlObject(e);
      return this.fail(
        e,
        'E_INTL',
        'Intl formatters and collators are supported as constants (const f = new Intl.NumberFormat(…)) and in expressions calling format or compare',
      );
    }
    const args = (e.arguments ?? []).map(a => this.expr(a, b));
    if (global === 'Map' || global === 'Set')
      return { op: 'builtin', name: `${global}.new`, args, type: this.exprType(e) };
    // A WeakMap or WeakSet is a Map or Set (frontend/types.ts).
    if ((global === 'WeakMap' || global === 'WeakSet') && !args.length)
      return { op: 'builtin', name: `${global.slice(4)}.new`, args, type: this.exprType(e) };
    if (global && ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(global))
      return {
        op: 'record',
        record: this.errorRecord(),
        fields: [{ op: 'lit', value: global }, args[0] ?? { op: 'lit', value: '' }],
      };
    return this.fail(e, 'E_NEW', 'Unsupported constructor');
  }

  /**
   * A literal of an object type implemented with getters (frontend/types.ts
   * `accessors`): each property a getter, called where it is read.
   */
  /** Whether code in `sf` assigns the binding `sym`. */
  private assignedSymbol(sym: ts.Symbol, sf: ts.SourceFile): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(skipParens(n.left)) &&
        this.checker.getSymbolAtLocation(skipParens(n.left)) === sym
      )
        found = true;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }

  private accessorLiteral(e: ts.ObjectLiteralExpression, record: number, b: FnBuilder): Expr {
    const r = this.types.records[record];
    const values: (Expr | undefined)[] = r.fields.map(() => undefined);
    for (const p of e.properties) {
      // A property holding a constant (bits-ui's useFloating returns
      // `{ floating, reference, get placement() { … } }`): a getter of it,
      // which reads the same value.
      const constant =
        ts.isShorthandPropertyAssignment(p) && !p.objectAssignmentInitializer
          ? p.name
          : ts.isPropertyAssignment(p) && ts.isIdentifier(skipParens(p.initializer))
            ? (skipParens(p.initializer) as ts.Identifier)
            : undefined;
      const sym =
        constant &&
        (ts.isShorthandPropertyAssignment(p)
          ? this.checker.getShorthandAssignmentValueSymbol(p)
          : this.checker.getSymbolAtLocation(constant));
      const decl = sym?.valueDeclaration;
      // (A function declaration nothing assigns is one too: bits-ui's
      // scroll lock returns `{ get lockMap() { … }, resetBodyStyle, … }`.)
      const isConst =
        !!decl &&
        ((ts.isVariableDeclaration(decl) &&
          ts.isVariableDeclarationList(decl.parent) &&
          !!(decl.parent.flags & ts.NodeFlags.Const)) ||
          (ts.isFunctionDeclaration(decl) && !this.assignedSymbol(sym!, decl.getSourceFile())));
      if (constant && isConst && p.name && ts.isIdentifier(p.name)) {
        const i = this.types.fieldIndex(record, p.name.text, p);
        const want = r.fields[i].type as { fn: { params: Type[]; result: Type } };
        values[i] = this.expressionClosure(
          constant,
          b,
          `get ${p.name.text}`,
          want.fn.result,
          inner => {
            const binding = this.bindingOf(sym!);
            return binding
              ? this.bindingExpr(binding, constant, inner)
              : this.fail(p, 'E_UNRESOLVED', `${constant.text} is not a supported binding`);
          },
        );
        continue;
      }
      if (!ts.isGetAccessorDeclaration(p) || !ts.isIdentifier(p.name))
        return this.fail(
          p,
          'E_OBJECT',
          'Objects of this type are implemented with getters elsewhere: write every property as a getter (get name() { … }) or a constant',
        );
      const i = this.types.fieldIndex(record, p.name.text, p);
      const want = r.fields[i].type as { fn: { params: Type[]; result: Type } };
      values[i] = this.closure(p, b, `get ${p.name.text}`, [], want.fn.result);
    }
    const fields = r.fields.map(
      (f, i): Expr =>
        values[i] ??
        this.fail(
          e,
          'E_OBJECT',
          `Missing getter ${f.name} (objects of this type are implemented with a getter per property)`,
        ),
    );
    return { op: 'record', record, fields };
  }

  /**
   * A property read of a record implemented with getters: the getter's
   * call. An optional property TypeScript types as present (`Required<…>`)
   * read as a receiver is unwrapped (JavaScript throws a TypeError there
   * too); elsewhere it stays nullable.
   */
  accessorRead(object: Expr, record: number, name: string, at: ts.PropertyAccessExpression): Expr {
    const field = this.types.fieldIndex(record, name, at);
    const read: Expr = { op: 'call-value', callee: { op: 'get', object, field }, args: [] };
    const result = (this.types.records[record].fields[field].type as { fn: { result: Type } }).fn
      .result;
    const here = this.types.tryMap(this.checker.getTypeAtLocation(at), at);
    if (maybeInner(result) && here !== undefined && !maybeInner(here) && this.isReceiver(at))
      return this.classes.narrow({ op: 'unwrap', value: read }, maybeInner(result)!, here);
    return read;
  }

  private object(e: ts.ObjectLiteralExpression, b: FnBuilder): Expr {
    // A literal TypeScript cannot type (untyped JavaScript: a custom
    // floating-ui middleware) where a record is expected: that record, its
    // properties by name (a pack may build the record: `recordLiterals`).
    const want = this.expected.get(e);
    if (
      want !== undefined &&
      typeof want === 'object' &&
      'record' in want &&
      containsAny(this.checker.getTypeAtLocation(e), this.checker)
    ) {
      const hook = this.recordLiterals.get(want.record);
      if (hook) return hook(e, b);
      if (this.types.accessors.has(want.record)) return this.accessorLiteral(e, want.record, b);
      return this.byName(e, want.record, b);
    }
    // The contextual type, unless it says nothing about the value (unknown: a
    // `satisfies` of a function returning unknown; `T | PromiseLike<T>`: an
    // async function's return); then the literal's own type.
    // (Not the type a destructuring pattern implies, `const { a, b } = { … }`
    // without an annotation: its members are `any`.)
    let holder: ts.Node = e.parent;
    while (ts.isParenthesizedExpression(holder)) holder = holder.parent;
    const pattern =
      ts.isVariableDeclaration(holder) && !holder.type && !ts.isIdentifier(holder.name);
    const contextual = pattern ? undefined : this.checker.getContextualType(e);
    const usable = (c: ts.Type) =>
      !(c.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) &&
      !(c.isUnion() && c.types.some(p => !!p.getProperty('then')));
    // (A literal with getters whose contextual type is not implemented with
    // getters elsewhere: its own type, which is.)
    const getters =
      e.properties.some(ts.isGetAccessorDeclaration) &&
      !(contextual && this.types.accessorTypes.has(contextual));
    const t =
      contextual && usable(contextual) && !getters ? contextual : this.checker.getTypeAtLocation(e);
    // Attribute bags: literals with computed keys or spreads of bags, or
    // typed as one (frontend/package-modules.ts types bits-ui's `props`).
    // A dictionary (a string index signature of one value type), also with
    // computed keys.
    // (A literal returned where a bag is declared is one, also with keys
    // computed at run time, which its own type gives an index signature.)
    const mapped = this.types.tryMap(t, e);
    if (mapped === 'attrs' || this.returnsBag(e, b)) return this.bagLiteral(e, b);
    if (typeof mapped === 'object' && 'map' in mapped && mapped.map[0] === STRING)
      return this.dictionaryLiteral(e, mapped, b);
    if (this.isBagLiteral(e)) return this.bagLiteral(e, b);
    // Without a contextual type (untyped JavaScript), a record expected
    // here (a class field's declared type, bits-ui's derived
    // `detectOverflowOptions`) is the literal's type.
    // (Also where the contextual type differs from an expected record of
    // generic call such as `$derived.by(() => ({ … }))`, and a record of the
    // same keys is expected: a class field's declared type, which an
    // untyped predicate narrowed better than TypeScript can.)
    const wantRecord =
      typeof want === 'object'
        ? 'record' in want
          ? want.record
          : 'maybe' in want && typeof want.maybe === 'object' && 'record' in want.maybe
            ? want.maybe.record
            : undefined
        : undefined;
    const sameKeys =
      wantRecord !== undefined &&
      !this.types.records[wantRecord].class &&
      e.properties.every(
        p =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          this.types.records[wantRecord].fields.some(
            f => f.name === (p.name as ts.Identifier).text,
          ),
      ) &&
      // (Fields the literal leaves out are optional: undefined.)
      this.types.records[wantRecord].fields.every(
        f =>
          maybeInner(f.type) !== undefined ||
          e.properties.some(p => p.name && (p.name as ts.Identifier).text === f.name),
      );
    // A literal TypeScript types with `any` in it and nothing expects
    // (untyped JavaScript: bits-ui's submenu intent returns `{ corridor:
    // getCorridorPolygon(…), … }`, whose helpers are specialised per call):
    // a record of its properties' lowered types, in the literal's order.
    if (
      wantRecord === undefined &&
      mapped === undefined &&
      containsAny(t, this.checker) &&
      e.properties.every(
        p =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)),
      )
    ) {
      const values = e.properties.map(p =>
        ts.isPropertyAssignment(p)
          ? this.expr(p.initializer, b)
          : this.expr((p as ts.ShorthandPropertyAssignment).name, b),
      );
      const fields = e.properties.map((p, i) => ({
        name: (p.name as ts.Identifier | ts.StringLiteral).text,
        type: this.irType(values[i], b),
      }));
      return {
        op: 'record',
        record: this.types.shapeRecord(fields),
        fields: values,
      };
    }
    const type =
      (!(contextual && usable(contextual)) || sameKeys) &&
      typeof want === 'object' &&
      ('record' in want ||
        ('maybe' in want && typeof want.maybe === 'object' && 'record' in want.maybe))
        ? want
        : this.types.map(t, e);
    const recordType = typeof type === 'object' && 'maybe' in type ? type.maybe : type;
    if (typeof recordType === 'object' && 'map' in recordType)
      return this.dictionaryLiteral(e, recordType, b);
    if (!(typeof recordType === 'object' && 'record' in recordType))
      return this.fail(e, 'E_OBJECT', 'Object literal without a record type');
    if (this.types.records[recordType.record].class)
      return this.fail(
        e,
        'E_CLASS',
        `An object literal is not a ${this.types.records[recordType.record].name} instance (construct one with new)`,
      );
    const declared = this.types.records[recordType.record];
    if (this.types.accessors.has(recordType.record))
      return this.accessorLiteral(e, recordType.record, b);
    // Keys are observable (Object.keys, JSON.stringify): the record has the
    // literal's key order.
    const order = this.types.keyOrder(e, declared.fields);
    if (
      order.some((n, i) => declared.fields[i].name !== n) &&
      this.types.packageRecords.has(recordType.record)
    )
      return this.byName(e, recordType.record, b);
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
        if (!this.classes.isClass(st) && !(typeof st === 'object' && 'record' in st))
          this.fail(p, 'E_OBJECT', 'Spread requires a record value');
        if (this.classes.isClass(st))
          this.fail(
            p,
            'E_CLASS',
            'Spreading a class instance copies only its public own fields; spread a plain object instead',
          );
        const source = b.local('$spread', st);
        const src = this.types.records[(st as { record: number }).record];
        // Each field that exists in the source overrides earlier values.
        // (An optional one over an earlier spread's field where the
        // literal's type has it present, `{ ...defaults, ...options }`: the
        // earlier value where it is undefined, which is where the object
        // lacks the key, checked over the program, `checkStyleSpreads`.)
        record.fields.forEach((f, i) => {
          const j = src.fields.findIndex(sf => sf.name === f.name);
          if (j < 0) return;
          const read: Expr = { op: 'get', object: { op: 'local', local: source }, field: j };
          const earlier = values[i];
          if (
            maybeInner(src.fields[j].type) &&
            !maybeInner(f.type) &&
            earlier?.op === 'get' &&
            earlier.object.op === 'local'
          ) {
            // (A function of fewer parameters, `noop` for `onChange`: adapted.)
            const have = this.irType(earlier, b);
            const right =
              JSON.stringify(have) === JSON.stringify(f.type)
                ? earlier
                : (this.adaptFunction(earlier, have, f.type) ?? earlier);
            values[i] = { op: 'nullish', left: read, right };
            this.recordSpreadChecks.push({
              record: (st as { record: number }).record,
              field: f.name,
              at: p,
            });
          } else values[i] = read;
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
        // (A function for an optional property is present.)
        if (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))
          value = this.fitValue(this.closure(p.initializer, b, name), record.fields[i].type, b);
        else value = this.coerce(p.initializer, b, record.fields[i].type);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        name = p.name.text;
        const i = this.types.fieldIndex(recordType.record, name, p);
        const sym = this.checker.getShorthandAssignmentValueSymbol(p);
        const binding = sym && this.bindingOf(sym);
        // (Untyped JavaScript: the binding's own type.)
        value = binding
          ? this.bindingExpr(binding, p.name, b, this.types.typeOrUndefined(p.name))
          : this.fail(p, 'E_UNRESOLVED', `${name} is not a supported binding`);
        // (The value's IR type: an untyped `let` widened to nullable is
        // nullable where TypeScript says otherwise.)
        const vt = this.irType(value, b);
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

  /** Whether an object literal builds an attribute bag: a computed key, or a spread of a bag. */
  /**
   * Whether `e` is what a function returns whose declared result is a bag
   * (a derived value of a field typed `Record<string, unknown>`).
   */
  private returnsBag(e: ts.ObjectLiteralExpression, b: FnBuilder): boolean {
    if (b.result !== 'attrs') return false;
    let n: ts.Node = e;
    while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
    return (
      ts.isReturnStatement(n.parent) ||
      ((ts.isArrowFunction(n.parent) || ts.isFunctionExpression(n.parent)) && n.parent.body === n)
    );
  }

  private isBagLiteral(e: ts.ObjectLiteralExpression): boolean {
    return e.properties.some(
      p =>
        (p.name && ts.isComputedPropertyName(p.name)) ||
        (ts.isSpreadAssignment(p) &&
          this.types.tryMap(this.checker.getTypeAtLocation(p.expression), p) === 'attrs'),
    );
  }

  /**
   * An object literal as an attribute bag (docs/IR.md `attrs`): its entries
   * in order, names static or build-time constants (`[attrs.root]: ""`).
   * Values: strings, booleans and nullable ones (absent when nullish),
   * numbers as their string, `on<event>` listeners, a `style` object of
   * property values; spreads of bags (attachments), of records (their
   * fields) and of conditionals between literals.
   */
  bagLiteral(e: ts.ObjectLiteralExpression, b: FnBuilder): Expr {
    const items: AttrItem[] = [];
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) {
        items.push({ spread: this.bagValue(p.expression, b) });
        continue;
      }
      let name: string | undefined;
      if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) name = p.name.text;
      else if (p.name && ts.isComputedPropertyName(p.name)) {
        const inner = skipParens(p.name.expression);
        const c = ts.isStringLiteralLike(inner)
          ? { value: inner.text }
          : this.constantMember(inner);
        if (c && typeof c.value === 'string') name = c.value;
        // A key from a finite set of names (bits-ui's
        // `[this.root.getBitsAttr("trigger")]`, which depends on the
        // dialog's variant): the entry of the name the key evaluates to.
        const names = name === undefined ? this.keyNames(p.name.expression) : undefined;
        if (names && ts.isPropertyAssignment(p)) {
          items.push({ spread: this.chosenEntry(p.name.expression, names, p, b) });
          continue;
        }
      }
      if (name === undefined)
        return this.fail(
          p,
          'E_ATTRS',
          'Attribute bag keys are static names, build-time constants or one of a finite set of names (not on<event>, style or class)',
        );
      let value: Expr;
      if (ts.isPropertyAssignment(p)) {
        if (name === 'style' && ts.isObjectLiteralExpression(skipParens(p.initializer))) {
          items.push({
            name,
            value: this.styleObject(skipParens(p.initializer) as ts.ObjectLiteralExpression, b),
          });
          continue;
        }
        value = this.expr(p.initializer, b);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        // `{ type }`: the variable the shorthand names.
        const sym = this.checker.getShorthandAssignmentValueSymbol(p);
        const binding = sym && this.bindingOf(sym);
        value = binding
          ? this.bindingExpr(binding, p.name, b, this.types.of(p.name))
          : this.fail(p, 'E_UNRESOLVED', `${p.name.text} is not a supported binding`);
      } else return this.fail(p, 'E_ATTRS', 'Unsupported attribute bag member');
      items.push({ name, value: this.bagEntry(name, value, p, b) });
    }
    return { op: 'attrs', items };
  }

  /**
   * The names a computed bag key can evaluate to (`valueSet`, a superset),
   * where they are finitely many plain attribute names; undefined otherwise.
   */
  keyNames(e: ts.Expression): string[] | undefined {
    const names = valueSet({ lower: this, label: 'attribute names' }, e);
    return names?.length &&
      names.every(
        n => typeof n === 'string' && n !== 'style' && n !== 'class' && !n.startsWith('on'),
      )
      ? (names as string[])
      : undefined;
  }

  /**
   * A bag entry under a key computed at run time from `names`: the key and
   * then the value evaluated, as JavaScript evaluates them, and the entry of
   * the name it is (a name outside the set throws).
   */
  private chosenEntry(
    key: ts.Expression,
    names: string[],
    p: ts.PropertyAssignment,
    b: FnBuilder,
  ): Expr {
    const k = b.local('$key', STRING);
    const keyValue = this.coerce(key, b, STRING);
    const v = this.bagEntry(names[0], this.expr(p.initializer, b), p, b);
    const local = b.local('$entry', this.irType(v, b));
    let chain: Expr = this.throwing(
      'attrs',
      'TypeError',
      'An attribute name outside the names known at build time',
    );
    for (const n of [...names].reverse())
      chain = {
        op: 'cond',
        test: { op: 'eq', left: { op: 'local', local: k }, right: { op: 'lit', value: n } },
        then: { op: 'attrs', items: [{ name: n, value: { op: 'local', local } }] },
        else: chain,
      };
    return {
      op: 'with',
      local: k,
      value: keyValue,
      body: { op: 'with', local, value: v, body: chain },
    };
  }

  private destroyRoot?: number;

  /** The function a `$effect.root` returns: destroys the root it captures (its id). */
  destroyRootFunction(): number {
    if (this.destroyRoot === undefined) {
      this.destroyRoot = this.reserve();
      this.functions[this.destroyRoot] = {
        name: 'effect$destroyRoot',
        captures: [{ name: 'root', type: NUMBER }],
        params: [],
        locals: [],
        result: 'void',
        body: [
          {
            op: 'expr',
            value: {
              op: 'builtin',
              name: 'effect.destroy-root',
              args: [{ op: 'local', local: 0 }],
              type: 'void',
            },
          },
        ],
      };
    }
    return this.destroyRoot;
  }

  private readonly throwingHelpers = new Map<string, number>();

  /** A call that throws `name: message`, typed `type` (for branches that cannot be reached). */
  throwing(type: Type, name: string, message: string): Expr {
    const key = JSON.stringify([type, name, message]);
    let index = this.throwingHelpers.get(key);
    if (index === undefined) {
      index = this.reserve();
      this.throwingHelpers.set(key, index);
      this.functions[index] = {
        name: `throw$${this.throwingHelpers.size}`,
        params: [],
        locals: [],
        result: type,
        body: [
          {
            op: 'throw',
            value: {
              op: 'record',
              record: this.errorRecord(),
              fields: [
                { op: 'lit', value: name },
                { op: 'lit', value: message },
              ],
            },
          },
        ],
      };
    }
    return { op: 'call', function: index, args: [] };
  }

  /** A value as a bag entry: strings, booleans (or nullable), numbers as strings, listeners. */
  private bagEntry(name: string, v: Expr, at: ts.Node, b: FnBuilder): Expr {
    const t = this.irType(v, b);
    const inner = maybeInner(t) ?? t;
    if (inner === 'string' || inner === 'boolean') return v;
    // An element (or none) under a component prop's camelCase name (bits-ui's
    // tooltip content merges `customAnchor ?? triggerNode` into the floating
    // layer's props): the value, for a component declaring the prop. Set on
    // an element (where Svelte writes `[object HTML…Element]`), it is
    // unsupported: the native runtime reports it, the interpreter throws.
    if (inner === 'element' && /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(name)) return v;
    // A number under a component prop's camelCase name (bits-ui's tooltip
    // merges `sideOffset` into the floating layer's props): the number, for a
    // component declaring the prop (set on an element, its text).
    if (inner === 'number' && /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(name)) return v;
    if (inner === 'number') {
      if (!maybeInner(t)) return { op: 'to-string', arg: v };
      const tmp = b.local('$entry', t);
      return {
        op: 'with',
        local: tmp,
        value: v,
        body: {
          op: 'cond',
          test: {
            op: 'builtin',
            name: 'maybe.is-nullish',
            args: [{ op: 'local', local: tmp }],
            type: 'boolean',
          },
          then: { op: 'undefined', type: { maybe: 'string' } },
          else: {
            op: 'some',
            value: { op: 'to-string', arg: { op: 'unwrap', value: { op: 'local', local: tmp } } },
          },
        },
      };
    }
    // A bag used as a style object (bits-ui's arrow: a derived object with a
    // computed key): its entries as style properties.
    if (name === 'style' && t === 'attrs')
      return {
        op: 'builtin',
        name: 'attrs.style-map',
        args: [v],
        type: { map: [STRING, { maybe: STRING }] },
      };
    // A style object, or none (bits-ui's Avatar.Fallback: `style: this.style`).
    if (name === 'style' && typeof inner === 'object' && 'record' in inner) {
      const fields = this.types.records[inner.record].fields;
      if (fields.every(f => f.type === STRING || maybeInner(f.type) === STRING)) return v;
      // With numbers (bits-ui's scroll buttons: `style: { flexShrink: 0 }` of
      // a typed props record): a style record of their text, as
      // svelte-toolbelt prints them (`${v}`).
      const printable = (f: Type) => {
        const x = maybeInner(f) ?? f;
        return x === STRING || x === NUMBER;
      };
      if (fields.every(f => printable(f.type)) && !this.types.records[inner.record].class) {
        const tmp = b.local('$style', inner);
        const values = fields.map((f, i) =>
          this.bagEntry(
            'value',
            { op: 'get', object: { op: 'local', local: tmp }, field: i },
            at,
            b,
          ),
        );
        const record = this.types.shapeRecord(
          fields.map((f, i) => ({ name: f.name, type: this.irType(values[i], b) })),
        );
        const built: Expr = { op: 'record', record, fields: values };
        return maybeInner(t)
          ? { op: 'optional', value: v, local: tmp, then: built }
          : { op: 'with', local: tmp, value: v, body: built };
      }
    }
    // A style object of keys that may be absent (`styleObject`): a map
    // (or none: a nullable style prop).
    if (
      name === 'style' &&
      typeof inner === 'object' &&
      'map' in inner &&
      inner.map[0] === STRING &&
      (maybeInner(inner.map[1]) === STRING || inner.map[1] === STRING)
    )
      return v;
    if (typeof t === 'object' && 'fn' in t) {
      // Listeners under `on<event>` (or `on<event>capture`: the capture
      // phase); other functions are callbacks (never attributes).
      const named = /^on([a-z]+)$/.exec(name)?.[1];
      const kind =
        named && !EVENT_KINDS.includes(named as EventKind) && named.endsWith('capture')
          ? named.slice(0, -'capture'.length)
          : named;
      const listener =
        !kind ||
        (EVENT_KINDS.includes(kind as EventKind) &&
          (t.fn.params.length === 0 || (t.fn.params.length === 1 && t.fn.params[0] === 'event')));
      if (!listener)
        return this.fail(
          at,
          'E_ATTRS',
          `${name}: on<event> functions in attribute bags are listeners of supported events`,
        );
      return v;
    }
    return this.fail(
      at,
      'E_ATTRS',
      `${name}: values of type ${JSON.stringify(t)} are unsupported in attribute bags`,
    );
  }

  /** `styleMapSpread` functions, by the spread dictionary's type. */
  private readonly styleMapSpreads = new Map<string, number>();

  /**
   * A function setting the entries of a dictionary of style values (`source`,
   * a `map<string, string>` or of nullable strings) into a copy of a style
   * map, in order, and returning the copy (a function changing a value it
   * did not create would be one a derived value could not call).
   */
  private styleMapSpread(source: Type): number {
    const key = JSON.stringify(source);
    const known = this.styleMapSpreads.get(key);
    if (known !== undefined) return known;
    const M: Type = { map: [STRING, { maybe: STRING }] };
    const [k, v] = (source as { map: [Type, Type] }).map;
    const entry = this.types.tupleRecord([k, v]);
    const index = this.reserve();
    this.styleMapSpreads.set(key, index);
    const local = (l: number): Expr => ({ op: 'local', local: l });
    const value: Expr = { op: 'get', object: local(2), field: 1 };
    this.functions[index] = {
      name: 'style$spreadMap',
      params: [
        { name: 'm', type: M },
        { name: 'source', type: source },
      ],
      locals: [
        { name: 'entry', type: { record: entry } },
        { name: 'copy', type: M },
      ],
      result: M,
      body: [
        {
          op: 'let',
          local: 3,
          value: { op: 'builtin', name: 'Map.new', args: [local(0)], type: M },
        },
        {
          op: 'for-of',
          local: 2,
          iterable: {
            op: 'builtin',
            name: 'map.entries',
            args: [local(1)],
            type: { array: { record: entry } },
          },
          body: [
            {
              op: 'expr',
              value: {
                op: 'builtin',
                name: 'map.set',
                args: [
                  local(3),
                  { op: 'get', object: local(2), field: 0 },
                  maybeInner(v) ? value : { op: 'some', value },
                ],
                type: M,
              },
            },
          ],
        },
        { op: 'return', value: local(3) },
      ],
    };
    return index;
  }

  /** A `style` object of an attribute bag: a record of nullable property values. */
  /** A style object literal's value (a style record or map, `styleObject`). */
  styleValue(o: ts.ObjectLiteralExpression, b: FnBuilder): Expr {
    return this.styleObject(o, b);
  }

  private styleObject(o: ts.ObjectLiteralExpression, b: FnBuilder): Expr {
    const S: Type = { maybe: STRING };
    /**
     * The literal's entries in order: a value for a name, or entries that
     * only exist where a test holds (`...(c && { k: v })`, a spread of a
     * nullable style record) or that read a spread value bound first.
     */
    type Step =
      | { set: string; value: Expr }
      | { test: Expr; steps: Step[] }
      | { bind: number; value: Expr; steps: Step[] }
      /** A record spread: `m = f(m, object)` (`checkStyleSpreads` writes `f`). */
      | { call: number; arg: Expr };
    const steps: Step[] = [];
    const styleValue = (x: ts.Expression, at: ts.Node): Expr => {
      let v = this.expr(x, b);
      let t = this.irType(v, b);
      // A number (bits-ui's `"--bits-dialog-depth": this.root.depth`) is
      // printed as its string, as svelte-toolbelt's styleToCSS does (`${v}`).
      if (t === 'number') {
        v = { op: 'builtin', name: 'String', args: [v], type: 'string' };
        t = 'string';
      }
      if (t !== 'string' && maybeInner(t) !== 'string')
        return this.fail(at, 'E_ATTRS', 'Style object values are strings or undefined');
      return t === 'string' ? { op: 'some', value: v } : v;
    };
    for (const p of o.properties) {
      if (ts.isSpreadAssignment(p)) {
        const spread = skipParens(p.expression);
        // `...(c && { k: v })` (bits-ui's floating layer): the keys exist
        // where `c` is truthy.
        if (
          ts.isBinaryExpression(spread) &&
          spread.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          ts.isObjectLiteralExpression(skipParens(spread.right))
        ) {
          const test = this.condition(spread.left, b);
          const inner: Step[] = [];
          for (const q of (skipParens(spread.right) as ts.ObjectLiteralExpression).properties) {
            if (
              !ts.isPropertyAssignment(q) ||
              !(ts.isIdentifier(q.name) || ts.isStringLiteral(q.name))
            )
              return this.fail(q, 'E_ATTRS', 'Style objects have static property names');
            inner.push({ set: q.name.text, value: styleValue(q.initializer, q) });
          }
          steps.push({ test, steps: inner });
          continue;
        }
        const c = ts.isIdentifier(p.expression) ? this.binding(p.expression) : undefined;
        if (c?.kind !== 'constant') {
          // A style record (bits-ui's `floatingStyles`): its fields in order;
          // a nullable one adds nothing where it is undefined.
          const v = this.expr(p.expression, b);
          const t = this.irType(v, b);
          const inner = maybeInner(t) ?? t;
          if (
            typeof inner === 'object' &&
            'record' in inner &&
            !this.types.records[inner.record].class &&
            this.types.records[inner.record].fields.every(
              f => f.type === 'string' || maybeInner(f.type) === 'string',
            )
          ) {
            const tmp = b.local('$style', t);
            const src: Expr = { op: 'local', local: tmp };
            const object: Expr = maybeInner(t) ? { op: 'unwrap', value: src } : src;
            // The record's keys in the order its objects have them, a key
            // that may be undefined set only where it is not (the object
            // lacks it: `...(c && { willChange })` in bits-ui's
            // floatingStyles): a function written once the program is
            // lowered (`checkStyleSpreads`), from the record's
            // constructions.
            const fill = this.reserve();
            this.styleSpreadChecks.push({ record: inner.record, fn: fill, at: p });
            const call: Step = { call: fill, arg: object };
            steps.push({
              bind: tmp,
              value: v,
              steps: maybeInner(t)
                ? [
                    {
                      test: {
                        op: 'not',
                        arg: {
                          op: 'builtin',
                          name: 'maybe.is-nullish',
                          args: [src],
                          type: BOOLEAN,
                        },
                      },
                      steps: [call],
                    },
                  ]
                : [call],
            });
            continue;
          }
          // A dictionary of property values (bits-ui's Select content spreads
          // `#styles`, `getFloatingContentCSSVars(…)`'s CSS variables): its
          // entries in order.
          const values = typeof inner === 'object' && 'map' in inner ? inner.map : undefined;
          if (
            values &&
            values[0] === STRING &&
            (values[1] === STRING || maybeInner(values[1]) === STRING)
          ) {
            const tmp = b.local('$style', t);
            const src: Expr = { op: 'local', local: tmp };
            const object: Expr = maybeInner(t) ? { op: 'unwrap', value: src } : src;
            const call: Step = { call: this.styleMapSpread(inner as Type), arg: object };
            steps.push({
              bind: tmp,
              value: v,
              steps: maybeInner(t)
                ? [
                    {
                      test: {
                        op: 'not',
                        arg: {
                          op: 'builtin',
                          name: 'maybe.is-nullish',
                          args: [src],
                          type: BOOLEAN,
                        },
                      },
                      steps: [call],
                    },
                  ]
                : [call],
            });
            continue;
          }
          // A derived field whose function never returns a value (bits-ui's
          // `#transformedStyle`, whose tests the types decide) is undefined:
          // it adds nothing.
          if (v.op === 'get') {
            const rt = this.irType(v.object, b);
            const field =
              typeof rt === 'object' && 'record' in rt
                ? this.types.records[rt.record].fields[v.field]
                : undefined;
            const fn = field?.derived !== undefined ? this.functions[field.derived] : undefined;
            if (fn && !returnsValue(fn.body)) continue;
          }
          return this.fail(p, 'E_ATTRS', 'Style objects spread style records of string values');
        }
        // A build-time constant style object (svelte-toolbelt's `srOnlyStyles`).
        const value = c.value;
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !Object.values(value).every(x => typeof x === 'string')
        )
          return this.fail(p, 'E_ATTRS', 'Style objects spread constant style objects only');
        for (const [k, x] of Object.entries(value as Record<string, string>))
          steps.push({ set: k, value: { op: 'some', value: { op: 'lit', value: x } } });
        continue;
      }
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
        return this.fail(p, 'E_ATTRS', 'Style objects have static property names');
      steps.push({ set: p.name.text, value: styleValue(p.initializer, p) });
    }
    // Where every key exists (no test): a record. JavaScript's object
    // literal semantics: a repeated key keeps its place and takes the later
    // value; a spread value is read where it stands.
    // (A key set twice would be evaluated out of order in a record.)
    const conditional = (list: Step[]): boolean =>
      list.some(s => 'test' in s || 'call' in s || ('bind' in s && conditional(s.steps)));
    const names: string[] = [];
    const collect = (list: Step[]) =>
      list.forEach(s =>
        'set' in s ? names.push(s.set) : 'steps' in s ? collect(s.steps) : undefined,
      );
    collect(steps);
    if (!conditional(steps) && new Set(names).size === names.length) {
      const fields: { name: string; type: Type }[] = [];
      const values: Expr[] = [];
      const binds: { local: number; value: Expr; at: number }[] = [];
      const flat = (list: Step[]) => {
        for (const s of list) {
          if ('bind' in s) {
            binds.push({ local: s.bind, value: s.value, at: values.length });
            flat(s.steps);
          } else if ('set' in s) {
            fields.push({ name: s.set, type: S });
            values.push(s.value);
          }
        }
      };
      flat(steps);
      // A spread value is bound around the first value after it (or the
      // record, where none follows).
      const record = this.types.records.length;
      this.types.records.push({ name: 'Style', fields });
      let out: Expr = { op: 'record', record, fields: values };
      for (const bind of [...binds].reverse()) {
        if (bind.at < values.length)
          values[bind.at] = {
            op: 'with',
            local: bind.local,
            value: bind.value,
            body: values[bind.at],
          };
        else out = { op: 'with', local: bind.local, value: bind.value, body: out };
      }
      return out;
    }
    // Otherwise a map of the keys in insertion order (a map keeps a key's
    // place when it is set again, as an object does).
    const M: Type = { map: [STRING, S] };
    const apply = (m: Expr, list: Step[]): Expr => {
      for (const s of list) {
        if ('set' in s)
          m = {
            op: 'builtin',
            name: 'map.set',
            args: [m, { op: 'lit', value: s.set }, s.value],
            type: M,
          };
        else if ('call' in s) {
          // (Written in place once the program is lowered: `checkStyleSpreads`.)
          const prev = b.local('$styleSpread', M);
          m = {
            op: 'with',
            local: prev,
            value: m,
            body: { op: 'call', function: s.call, args: [{ op: 'local', local: prev }, s.arg] },
          };
        } else {
          const prev = b.local('$styleMap', M);
          const read: Expr = { op: 'local', local: prev };
          const body: Expr =
            'test' in s
              ? { op: 'cond', test: s.test, then: apply(read, s.steps), else: read }
              : { op: 'with', local: s.bind, value: s.value, body: apply(read, s.steps) };
          m = { op: 'with', local: prev, value: m, body };
        }
      }
      return m;
    };
    return apply({ op: 'builtin', name: 'Map.new', args: [], type: M }, steps);
  }

  /** A bag-valued expression: a bag, a record spread as entries, or a conditional of literals. */
  bagValue(e: ts.Expression, b: FnBuilder): Expr {
    const x = skipParens(e);
    if (ts.isObjectLiteralExpression(x)) return this.bagLiteral(x, b);
    if (ts.isConditionalExpression(x))
      return {
        op: 'cond',
        test: this.condition(x.condition, b),
        then: this.bagValue(x.whenTrue, b),
        else: this.bagValue(x.whenFalse, b),
      };
    let v = this.expr(e, b);
    let t = this.irType(v, b);
    // A nullable object or bag (an optional prop: shadcn-svelte's
    // `{...portalProps}`): spreading nullish spreads nothing.
    const inner = maybeInner(t);
    if (
      inner !== undefined &&
      (inner === 'attrs' ||
        (typeof inner === 'object' && 'record' in inner && !this.types.records[inner.record].class))
    ) {
      const held = b.local('$spread', t);
      const read: Expr = { op: 'local', local: held };
      const rest = this.bagOf({ op: 'unwrap', value: read }, inner, e, b);
      return {
        op: 'with',
        local: held,
        value: v,
        body: {
          op: 'cond',
          test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: BOOLEAN },
          then: { op: 'attrs', items: [] },
          else: rest,
        },
      };
    }
    return this.bagOf(v, t, e, b);
  }

  /** A bag of value `v` of type `t` (a bag, or a plain record's fields). */
  private bagOf(v: Expr, t: Type, e: ts.Expression, b: FnBuilder): Expr {
    if (t === 'attrs') return v;
    if (typeof t === 'object' && 'record' in t && !this.types.records[t.record].class) {
      const tmp = b.local('$spread', t);
      const r = this.types.records[t.record];
      return {
        op: 'with',
        local: tmp,
        value: v,
        body: {
          op: 'attrs',
          items: r.fields.map((f, i) => ({
            name: f.name,
            value: this.bagEntry(
              f.name,
              { op: 'get', object: { op: 'local', local: tmp }, field: i },
              e,
              b,
            ),
          })),
        },
      };
    }
    return this.fail(
      e,
      'E_ATTRS',
      'Spreads in attribute bags take bags, records or object literals',
    );
  }

  /**
   * An object literal for a record a package's declaration file declares
   * (`PresenceManagerOpts`), its properties in another order: the values in
   * the literal's order, the record in the declaration's. Key order of such
   * records is not tracked: key-observing built-ins reject them.
   */
  private byName(e: ts.ObjectLiteralExpression, record: number, b: FnBuilder): Expr {
    const r = this.types.records[record];
    /** Temporaries undefined only where the object lacks the key (`absentWhenUndefined`). */
    const absentLocals = new Set<number>();
    const temps = new Map<string, number>();
    const values: { local: number; value: Expr }[] = [];
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) {
        // `...(c && { k: v, … })`: each key takes its value where `c` is
        // truthy and keeps the earlier one otherwise.
        const guarded = skipParens(p.expression);
        if (
          ts.isBinaryExpression(guarded) &&
          guarded.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          ts.isObjectLiteralExpression(skipParens(guarded.right))
        ) {
          const test = b.local('$spreadIf', BOOLEAN);
          values.push({ local: test, value: this.condition(guarded.left, b) });
          for (const q of (skipParens(guarded.right) as ts.ObjectLiteralExpression).properties) {
            const key =
              q.name && (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name))
                ? q.name.text
                : undefined;
            if (!key || !ts.isPropertyAssignment(q))
              return this.fail(q, 'E_OBJECT', 'A conditional spread holds static keys with values');
            const i = this.types.fieldIndex(record, key, q);
            const t = r.fields[i].type;
            const earlier = temps.get(key);
            const otherwise: Expr =
              earlier !== undefined
                ? { op: 'local', local: earlier }
                : maybeInner(t)
                  ? { op: 'undefined', type: t }
                  : this.fail(
                      q,
                      'E_OBJECT',
                      `${key} is absent where the spread's condition is false`,
                    );
            this.expected.set(skipParens(q.initializer), maybeInner(t) ?? t);
            const local = b.local(key, t);
            const then = this.coerce(q.initializer, b, t);
            values.push({
              local,
              value: {
                op: 'cond',
                test: { op: 'local', local: test },
                then,
                else: otherwise,
              },
            });
            temps.set(key, local);
            // (Undefined exactly where the key is absent: the spread adds it
            // with a value that is never undefined.)
            if (
              earlier === undefined &&
              (then.op === 'some' || maybeInner(this.irType(then, b)) === undefined)
            )
              absentLocals.add(local);
            else absentLocals.delete(local);
          }
          continue;
        }
        // A record's fields, read where the spread stands (none where the
        // value is undefined or null: spreading them adds nothing).
        const sv = this.expr(p.expression, b);
        const st = this.irType(sv, b);
        const inner = maybeInner(st) ?? st;
        if (!(typeof inner === 'object' && 'record' in inner) || this.classes.isClass(inner))
          return this.fail(p, 'E_OBJECT', 'Spread requires a plain record value');
        const source = b.local('$spread', st);
        values.push({ local: source, value: sv });
        const read: Expr = { op: 'local', local: source };
        const nullable = maybeInner(st) !== undefined;
        this.types.records[inner.record].fields.forEach((f, j) => {
          if (!r.fields.some(x => x.name === f.name)) return;
          const i = this.types.fieldIndex(record, f.name, p);
          const t = r.fields[i].type;
          let v: Expr = {
            op: 'get',
            object: nullable ? { op: 'unwrap', value: read } : read,
            field: j,
          };
          if (maybeInner(t) && !maybeInner(f.type)) v = { op: 'some', value: v };
          // An optional field over an earlier value where the literal's
          // type has it present (bits-ui's `{ ...defaultOptions, ...options }`):
          // the earlier value where the spread's is undefined, which is
          // where the object lacks the key (checked over the program,
          // `checkStyleSpreads`).
          const before = temps.get(f.name);
          if (maybeInner(f.type) && !maybeInner(t) && before !== undefined) {
            v = { op: 'nullish', left: v, right: { op: 'local', local: before } };
            this.recordSpreadChecks.push({ record: inner.record, field: f.name, at: p });
          }
          if (nullable) {
            const earlier = temps.get(f.name);
            v = {
              op: 'cond',
              test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: BOOLEAN },
              then:
                earlier !== undefined
                  ? { op: 'local', local: earlier }
                  : maybeInner(t)
                    ? { op: 'undefined', type: t }
                    : this.fail(
                        p,
                        'E_OBJECT',
                        `${f.name} is absent where the spread value is undefined`,
                      ),
              else: v,
            };
          }
          const local = b.local(`${f.name}`, t);
          temps.set(f.name, local);
          absentLocals.delete(local);
          values.push({ local, value: v });
        });
        continue;
      }
      const name =
        p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
      if (
        !name ||
        !(
          ts.isPropertyAssignment(p) ||
          ts.isShorthandPropertyAssignment(p) ||
          ts.isMethodDeclaration(p)
        )
      )
        return this.fail(p, 'E_OBJECT', 'Unsupported object member');
      const i = this.types.fieldIndex(record, name, p);
      const t = r.fields[i].type;
      let value: Expr;
      // Untyped values take the field's type where they stand.
      const fn = ts.isMethodDeclaration(p)
        ? p
        : ts.isPropertyAssignment(p) &&
            (ts.isArrowFunction(skipParens(p.initializer)) ||
              ts.isFunctionExpression(skipParens(p.initializer)))
          ? (skipParens(p.initializer) as ts.ArrowFunction)
          : undefined;
      if (fn) {
        this.expected.set(fn, maybeInner(t) ?? t);
        const typed = this.expectedFunction(fn);
        value = typed
          ? this.closure(fn, b, name, typed.params, typed.result)
          : this.closure(fn, b, name);
        // (A function of a compatible type: a result widened to nullable.)
        const have = this.irType(value, b);
        const want = maybeInner(t) ?? t;
        if (!sameType(have, want)) value = this.adaptFunction(value, have, want) ?? value;
      } else if (ts.isPropertyAssignment(p)) {
        this.expected.set(skipParens(p.initializer), maybeInner(t) ?? t);
        value = this.coerce(p.initializer, b, t);
      } else {
        const short = p as ts.ShorthandPropertyAssignment;
        const sym = this.checker.getShorthandAssignmentValueSymbol(short);
        const binding = sym && this.bindingOf(sym);
        value = binding
          ? this.bindingExpr(
              binding,
              short.name,
              b,
              this.types.tryMap(this.checker.getTypeAtLocation(short.name), short.name),
            )
          : this.fail(p, 'E_UNRESOLVED', `${name} is not a supported binding`);
      }
      if (maybeInner(t) && !maybeInner(this.irType(value, b))) value = { op: 'some', value };
      const local = b.local(`${name}`, t);
      temps.set(name, local);
      values.push({ local, value });
      // (A value that is never undefined.)
      if (value.op === 'some' || maybeInner(this.irType(value, b)) === undefined)
        absentLocals.add(local);
    }
    const fields = r.fields.map((f): Expr => {
      const t = temps.get(f.name);
      if (t !== undefined) {
        const read: Expr = { op: 'local', local: t };
        if (absentLocals.has(t)) this.absentWhenUndefined.add(read);
        return read;
      }
      // (A key the literal does not have.)
      if (maybeInner(f.type)) {
        const absent: Expr = { op: 'undefined', type: f.type };
        this.absentWhenUndefined.add(absent);
        return absent;
      }
      return this.fail(e, 'E_OBJECT', `Missing field ${f.name}`);
    });
    let out: Expr = { op: 'record', record, fields };
    this.literalOrder.set(out, [...temps.keys()]);
    for (const v of values.reverse())
      out = { op: 'with', local: v.local, value: v.value, body: out };
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

  // Dates and Intl ------------------------------------------------------------
  //
  // Date objects are IR values (type `date`); Date.now() and new Date() read
  // the runtime clock. Intl formatters and collators are compile-time
  // constants: their locales and options must be literals, and each use
  // (format, compare) lowers to an `intl.*` built-in carrying the option
  // string (frontend/intl.ts). The locale arguments of the toLocale* methods
  // and localeCompare may also be strings computed at runtime, which must
  // name a verified locale when the program runs.

  private builtin(name: string, args: Expr[], type: Type): Expr {
    return { op: 'builtin', name, args, type };
  }

  /** A number argument (primitives convert as in JavaScript). */
  private numberArg(a: ts.Expression, b: FnBuilder): Expr {
    const v = this.expr(a, b);
    const t = this.irType(v, b);
    if (t === 'number') return v;
    if (t === 'string' || t === 'boolean' || maybeInner(t)) return { op: 'to-number', arg: v };
    return this.fail(a, 'E_DATE', 'Date arguments must be numbers');
  }

  /** Year, month, day, hours, minutes, seconds, ms with the missing ones defaulted. */
  private dateComponents(args: readonly ts.Expression[], b: FnBuilder): Expr[] {
    if (args.length > 7) this.fail(args[7], 'E_DATE', 'Date takes at most 7 components');
    const defaults: Expr[] = [
      this.builtin('Number.NaN', [], NUMBER),
      { op: 'lit', value: 0 },
      { op: 'lit', value: 1 },
      { op: 'lit', value: 0 },
      { op: 'lit', value: 0 },
      { op: 'lit', value: 0 },
      { op: 'lit', value: 0 },
    ];
    return defaults.map((d, i) => (args[i] ? this.numberArg(args[i], b) : d));
  }

  /** `new Date(…)`. */
  private dateNew(e: ts.NewExpression, b: FnBuilder): Expr {
    const args = e.arguments ?? [];
    const date = (tv: Expr): Expr => this.builtin('date.new', [tv], 'date');
    if (args.length === 0) return date(this.builtin('clock.date', [], NUMBER));
    if (args.length === 1) {
      const v = this.expr(args[0], b);
      const t = this.irType(v, b);
      if (t === 'date') return date(this.builtin('date.getTime', [v], NUMBER));
      if (t === 'string') return date(this.builtin('date.parse', [v], NUMBER));
      if (t === 'number') return date(v);
      return this.fail(
        args[0],
        'E_DATE',
        'new Date takes a Date, a date string or a time value (number)',
      );
    }
    return date(this.builtin('date.local', this.dateComponents(args, b), NUMBER));
  }

  /** Static `Date` functions. */
  private dateStatic(method: string, e: ts.CallExpression, b: FnBuilder): Expr {
    const a = e.arguments;
    if (method === 'now' && !a.length) return this.builtin('clock.date', [], NUMBER);
    if (method === 'UTC') return this.builtin('date.utc', this.dateComponents(a, b), NUMBER);
    if (method === 'parse' && a.length === 1) {
      const v = this.expr(a[0], b);
      if (this.irType(v, b) !== 'string')
        return this.fail(a[0], 'E_DATE', 'Date.parse takes a string');
      return this.builtin('date.parse', [v], NUMBER);
    }
    return this.fail(e, 'E_DATE', `Date.${method} is unsupported (now, UTC and parse are)`);
  }

  /** Methods of a Date object. */
  private dateMethod(method: string, receiver: Expr, e: ts.CallExpression, b: FnBuilder): Expr {
    const a = e.arguments;
    const name =
      method === 'valueOf' ? 'getTime' : method === 'toGMTString' ? 'toUTCString' : method;
    const none = () => {
      if (a.length) this.fail(e, 'E_DATE', `${method} takes no arguments`);
    };
    if (name === 'getTime' || DATE_GETTERS.has(name)) {
      none();
      return this.builtin(`date.${name}`, [receiver], NUMBER);
    }
    const setter = Object.hasOwn(DATE_SETTERS, name) ? DATE_SETTERS[name] : undefined;
    if (setter) {
      if (a.length < 1 || a.length > setter)
        return this.fail(e, 'E_DATE', `${method} takes 1 to ${setter} numbers`);
      return this.builtin(`date.${name}`, [receiver, ...a.map(x => this.numberArg(x, b))], NUMBER);
    }
    if (['toString', 'toDateString', 'toTimeString', 'toUTCString', 'toISOString'].includes(name)) {
      none();
      return this.builtin(`date.${name}`, [receiver], STRING);
    }
    if (name === 'toJSON') {
      // null for an invalid date, where TypeScript says string.
      if (!this.undefinedHandled(e))
        return this.fail(
          e,
          'E_DATE',
          'toJSON returns null for an invalid Date; handle null (?? or a condition) or use toISOString()',
        );
      return this.builtin('date.toJSON', [receiver], { maybe: STRING });
    }
    const locale = new Map([
      ['toLocaleString', 'a'],
      ['toLocaleDateString', 'd'],
      ['toLocaleTimeString', 't'],
    ]).get(name);
    if (locale)
      return this.localeCall(
        'date',
        locale,
        [this.builtin('date.getTime', [receiver], NUMBER)],
        a[0],
        a[1],
        e,
        b,
      );
    return this.fail(
      e,
      'E_DATE',
      `Date.prototype.${method} is unsupported${['getYear', 'setYear'].includes(method) ? ' (use getFullYear/setFullYear)' : ''}`,
    );
  }

  /** A literal value: a literal, `undefined`, or a const bound to one. */
  private literalOf(e: ts.Expression, depth = 0): { value: Literal | undefined } | undefined {
    e = skipParens(e);
    if (ts.isStringLiteralLike(e)) return { value: e.text };
    if (ts.isNumericLiteral(e)) return { value: Number(e.text) };
    if (
      ts.isPrefixUnaryExpression(e) &&
      e.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(e.operand)
    )
      return { value: -Number(e.operand.text) };
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
    if (ts.isIdentifier(e) && e.text === 'undefined' && !this.binding(e))
      return { value: undefined };
    const init = this.constInitializer(e, depth);
    return init ? this.literalOf(init, depth + 1) : undefined;
  }

  /** The initialiser of a `const` that `e` names. */
  private constInitializer(e: ts.Expression, depth: number): ts.Expression | undefined {
    if (!ts.isIdentifier(e) || depth > 8) return undefined;
    const decl = this.symbol(e)?.valueDeclaration;
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

  /** Literal Intl options: an object literal (or a const bound to one). */
  private intlOptions(node: ts.Expression | undefined): [string, Literal | undefined, ts.Node][] {
    if (!node) return [];
    let e = skipParens(node);
    for (let depth = 0; ts.isIdentifier(e) && depth < 8; depth++) {
      if (e.text === 'undefined' && !this.binding(e)) return [];
      const init = this.constInitializer(e, depth);
      if (!init) break;
      e = skipParens(init);
    }
    if (!ts.isObjectLiteralExpression(e))
      return this.fail(
        node,
        'E_INTL',
        'Intl options must be an object literal (or a const holding one)',
      );
    return e.properties.map(p => {
      if (ts.isShorthandPropertyAssignment(p)) {
        const v = this.literalOf(p.name);
        if (!v) return this.fail(p, 'E_INTL', 'Intl option values must be literals');
        return [p.name.text, v.value, p];
      }
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
        return this.fail(p, 'E_INTL', 'Intl options must be plain properties with literal values');
      const v = this.literalOf(p.initializer);
      if (!v) return this.fail(p.initializer, 'E_INTL', 'Intl option values must be literals');
      return [p.name.text, v.value, p];
    });
  }

  /** A locales argument: absent, a literal (or one-element list), or a runtime string. */
  private localeArg(
    node: ts.Expression | undefined,
    b: FnBuilder,
  ): { literal?: string; runtime?: Expr } {
    if (!node) return {};
    const lit = this.literalOf(node);
    if (lit) {
      if (lit.value === undefined) return {};
      if (typeof lit.value !== 'string')
        return this.fail(node, 'E_INTL', 'A locale is a language tag string');
      return { literal: lit.value };
    }
    let e = skipParens(node);
    const init = this.constInitializer(e, 0);
    if (init && ts.isArrayLiteralExpression(skipParens(init))) e = skipParens(init);
    if (ts.isArrayLiteralExpression(e)) {
      if (e.elements.length === 0) return {};
      if (e.elements.length > 1)
        return this.fail(e, 'E_INTL', 'Lists of several locales are unsupported; pass one locale');
      return this.localeArg(e.elements[0], b);
    }
    const v = this.expr(node, b);
    const t = this.irType(v, b);
    if (t === 'string' || (maybeInner(t) === 'string' && typeof t === 'object'))
      return { runtime: v };
    return this.fail(node, 'E_INTL', 'A locale is a language tag string');
  }

  /**
   * An `intl.*` call for operands with locales and options: a literal locale
   * goes into the option string, a runtime one is the last argument
   * (evaluated after the operands, as in JavaScript).
   */
  private localeCall(
    kind: IntlKind,
    method: string,
    operands: Expr[],
    localesNode: ts.Expression | undefined,
    optionsNode: ts.Expression | undefined,
    at: ts.Node,
    b: FnBuilder,
  ): Expr {
    const { literal, runtime } = this.localeArg(localesNode, b);
    const options = this.intlOptions(optionsNode);
    const result = intlSpec(
      kind,
      method,
      literal,
      options.map(([k, v]) => [k, k === 'currency' && typeof v === 'string' ? v.toUpperCase() : v]),
    );
    if ('error' in result) {
      const node =
        options.find(o => o[0] === result.key)?.[2] ??
        (result.key ? optionsNode : localesNode) ??
        at;
      return this.fail(node, 'E_INTL', result.error);
    }
    const name =
      kind === 'date'
        ? 'intl.format-date'
        : kind === 'number'
          ? 'intl.format-number'
          : 'intl.compare';
    const type = kind === 'collator' ? NUMBER : STRING;
    const spec: Expr = { op: 'lit', value: result.spec };
    if (!runtime) return this.builtin(name, [...operands, spec], type);
    const rt = this.irType(runtime, b);
    if (rt === 'string') return this.builtin(name, [...operands, spec, runtime], type);
    // A locale that may be undefined: the default locale then.
    const temps = operands.map((o, i) => b.local(`$operand${i}`, this.irType(o, b)));
    const loc = b.local('$locale', rt);
    const read = (l: number): Expr => ({ op: 'local', local: l });
    const reads = temps.map(read);
    let body: Expr = {
      op: 'cond',
      test: this.builtin('maybe.is-nullish', [read(loc)], BOOLEAN),
      then: this.builtin(name, [...reads, spec], type),
      else: this.builtin(name, [...reads, spec, { op: 'unwrap', value: read(loc) }], type),
    };
    body = { op: 'with', local: loc, value: runtime, body };
    for (let i = temps.length - 1; i >= 0; i--)
      body = { op: 'with', local: temps[i], value: operands[i], body };
    return body;
  }

  /** An Intl formatter or collator constructed from literals, through consts. */
  intlObject(
    e: ts.Expression,
    depth = 0,
  ):
    | {
        kind: IntlKind;
        ctor: string;
        args: readonly ts.Expression[];
        node: ts.Expression;
        /** Constructed where it is used (not through a const). */
        inline: boolean;
      }
    | undefined {
    e = skipParens(e);
    if (
      (ts.isNewExpression(e) || ts.isCallExpression(e)) &&
      ts.isPropertyAccessExpression(e.expression) &&
      this.globalName(e.expression.expression) === 'Intl'
    ) {
      const ctor = e.expression.name.text;
      const kind = Object.hasOwn(INTL_KINDS, ctor) ? INTL_KINDS[ctor] : undefined;
      if (!kind)
        return this.fail(
          e,
          'E_INTL',
          `Intl.${ctor} is unsupported (Intl.DateTimeFormat, Intl.NumberFormat, Intl.Collator, Intl.PluralRules and Intl.DisplayNames are)`,
        );
      return { kind, ctor, args: e.arguments ?? [], node: e, inline: depth === 0 };
    }
    const init = this.constInitializer(e, depth);
    return init ? this.intlObject(init, depth + 1) : undefined;
  }

  /**
   * Whether `d` declares a pack constant such as `const button = tv({...})`
   * (bound to a pack function; no runtime value: its calls are lowered).
   */
  isPackConstant(d: ts.VariableDeclaration): boolean {
    return bindPackConstant(d, this);
  }

  /** Whether `d` declares an Intl constant (no runtime value: its uses are lowered). */
  isIntlConstant(d: ts.VariableDeclaration): boolean {
    if (!d.initializer || !ts.isIdentifier(d.name)) return false;
    const init = skipParens(d.initializer);
    const isIntl =
      (ts.isNewExpression(init) || ts.isCallExpression(init)) &&
      ts.isPropertyAccessExpression(init.expression) &&
      this.globalName(init.expression.expression) === 'Intl';
    if (!isIntl) return false;
    if (!(ts.isVariableDeclarationList(d.parent) && d.parent.flags & ts.NodeFlags.Const))
      this.fail(d, 'E_INTL', 'Intl formatters and collators must be const');
    this.intlObject(init);
    return true;
  }

  /** The option string of an Intl object for method `method`. */
  private intlObjectSpec(
    o: NonNullable<ReturnType<Lowerer['intlObject']>>,
    method: string,
    b: FnBuilder,
  ): string {
    const [locales, options] = o.args;
    const { literal, runtime } = this.localeArg(locales, b);
    if (runtime) this.fail(locales, 'E_INTL', `The locale of an Intl.${o.ctor} must be a literal`);
    const opts = this.intlOptions(options);
    const result = intlSpec(
      o.kind,
      method,
      literal,
      opts.map(([k, v]) => [k, k === 'currency' && typeof v === 'string' ? v.toUpperCase() : v]),
    );
    if ('error' in result)
      return this.fail(
        opts.find(x => x[0] === result.key)?.[2] ?? options ?? locales ?? o.node,
        'E_INTL',
        result.error,
      );
    return result.spec;
  }

  /** `f.format(x)` and `c.compare(a, b)` of an Intl constant. */
  private intlCall(
    o: NonNullable<ReturnType<Lowerer['intlObject']>>,
    method: string,
    e: ts.CallExpression,
    b: FnBuilder,
  ): Expr {
    if (o.kind === 'plural' || o.kind === 'names') return this.intlLocaleCall(o, method, e, b);
    const a = e.arguments;
    const lit = (spec: string): Expr => ({ op: 'lit', value: spec });
    if (o.kind === 'date' && method === 'format' && a.length <= 1) {
      let tv: Expr = this.builtin('clock.date', [], NUMBER);
      if (a[0]) {
        const v = this.expr(a[0], b);
        const t = this.irType(v, b);
        if (t === 'date') tv = this.builtin('date.getTime', [v], NUMBER);
        else if (t === 'number') tv = v;
        else return this.fail(a[0], 'E_INTL', 'format takes a Date or a time value');
      }
      return this.builtin('intl.format-date', [tv, lit(this.intlObjectSpec(o, 'f', b))], STRING);
    }
    if (o.kind === 'number' && method === 'format' && a.length === 1) {
      const v = this.expr(a[0], b);
      if (this.irType(v, b) !== 'number') return this.fail(a[0], 'E_INTL', 'format takes a number');
      return this.builtin('intl.format-number', [v, lit(this.intlObjectSpec(o, 'f', b))], STRING);
    }
    if (o.kind === 'collator' && method === 'compare' && a.length === 2) {
      const [x, y] = a.map(n => this.expr(n, b));
      if (this.irType(x, b) !== 'string' || this.irType(y, b) !== 'string')
        return this.fail(e, 'E_INTL', 'compare takes two strings');
      return this.builtin('intl.compare', [x, y, lit(this.intlObjectSpec(o, 'c', b))], NUMBER);
    }
    return this.fail(
      e,
      'E_INTL',
      `Intl.${o.ctor}.prototype.${method} is unsupported here (${o.kind === 'collator' ? 'compare(a, b)' : 'format(x)'} is supported)`,
    );
  }

  // Intl.PluralRules and Intl.DisplayNames take locales computed at run time
  // (the editor names any project locale) and options chosen by a
  // condition (`ordinal ? { type: 'ordinal' } : undefined`). A use evaluates
  // as JavaScript does: the locale, the condition, the constructor's check
  // of the locale (`intl.locale`: a RangeError for a malformed tag, an
  // unsupported report outside the verified data), then the method's
  // arguments and the call.

  /** `rules.select(n)` and `names.of(code)`. */
  private intlLocaleCall(
    o: NonNullable<ReturnType<Lowerer['intlObject']>>,
    method: string,
    e: ts.CallExpression,
    b: FnBuilder,
  ): Expr {
    const a = e.arguments;
    if (o.kind === 'plural' && method === 'select' && a.length === 1) {
      const x = this.expr(a[0], b);
      if (this.irType(x, b) !== 'number') return this.fail(a[0], 'E_INTL', 'select takes a number');
      return this.intlLocaleUse(o, 'p', [x], b, (spec, ops, loc) =>
        this.builtin('intl.plural-select', [...ops, lit(spec), ...loc], STRING),
      );
    }
    if (o.kind === 'names' && method === 'of' && a.length === 1) {
      const code = this.expr(a[0], b);
      if (this.irType(code, b) !== 'string')
        return this.fail(a[0], 'E_INTL', 'of takes a code string');
      return this.intlLocaleUse(o, 'n', [code], b, (spec, ops, loc) =>
        this.builtin('intl.display-of', [...ops, lit(spec), ...loc], { maybe: STRING }),
      );
    }
    const supported =
      o.kind === 'plural' ? 'select(n) and resolvedOptions().pluralCategories' : 'of(code)';
    return this.fail(
      e,
      'E_INTL',
      `Intl.${o.ctor}.prototype.${method} is unsupported here (${supported} are supported)`,
    );
  }

  /** `new Intl.PluralRules(…).resolvedOptions()` when `e` is that call. */
  private intlResolvedOptions(e: ts.Expression) {
    e = skipParens(e);
    if (
      !ts.isCallExpression(e) ||
      e.arguments.length ||
      !ts.isPropertyAccessExpression(e.expression) ||
      e.expression.name.text !== 'resolvedOptions'
    )
      return undefined;
    const o = this.intlObject(e.expression.expression);
    return o && (o.kind === 'plural' || o.kind === 'names') ? o : undefined;
  }

  /** `rules.resolvedOptions().pluralCategories` and `.type`. */
  private intlResolvedMember(
    o: NonNullable<ReturnType<Lowerer['intlObject']>>,
    name: string,
    e: ts.Expression,
    b: FnBuilder,
  ): Expr {
    if (o.kind === 'plural' && name === 'pluralCategories')
      return this.intlLocaleUse(o, 'p', [], b, (spec, _, loc) =>
        this.builtin('intl.plural-categories', [lit(spec), ...loc], { array: STRING }),
      );
    if (name === 'type')
      return this.intlLocaleUse(o, o.kind === 'plural' ? 'p' : 'n', [], b, spec => {
        const type = /(?:^|;)type=([^;]*)/.exec(spec)?.[1];
        return lit(type ?? 'cardinal');
      });
    return this.fail(
      e,
      'E_INTL',
      `Intl.${o.ctor} resolvedOptions().${name} is unsupported (${o.kind === 'plural' ? 'pluralCategories and type are' : 'type is'} supported)`,
    );
  }

  /**
   * A use of a plural rules or display names object: `make` builds the
   * result for an option string, the operands (read from temporaries) and
   * the runtime locale (absent: the literal or default locale).
   */
  private intlLocaleUse(
    o: NonNullable<ReturnType<Lowerer['intlObject']>>,
    method: string,
    operands: Expr[],
    b: FnBuilder,
    make: (spec: string, operands: Expr[], locale: Expr[]) => Expr,
  ): Expr {
    const [locales, options] = o.args;
    const temps: [number, Expr][] = [];
    const temp = (name: string, value: Expr, type: Type): (() => Expr) => {
      const l = b.local(name, type);
      temps.push([l, value]);
      return () => ({ op: 'local', local: l });
    };
    const { literal, runtime } = this.localeArg(locales, b);
    // Options: a literal object (or undefined), or a condition choosing one.
    let test: Expr | undefined;
    let branches: (ts.Expression | undefined)[] = [options];
    const choice = options && skipParens(options);
    if (choice && ts.isConditionalExpression(choice)) {
      test = this.condition(choice.condition, b);
      branches = [choice.whenTrue, choice.whenFalse];
    }
    if ((runtime || test) && !o.inline)
      return this.fail(
        locales ?? o.node,
        'E_INTL',
        `An Intl.${o.ctor} with a locale computed at run time or options chosen by a condition must be constructed where it is used (new Intl.${o.ctor}(locale, options).${o.kind === 'plural' ? 'select(n)' : 'of(code)'})`,
      );
    const specs = branches.map(node => {
      const opts = this.intlOptions(node);
      const result = intlSpec(
        o.kind,
        method,
        literal,
        opts.map(([k, v]) => [k, v]),
      );
      if ('error' in result)
        return this.fail(
          opts.find(x => x[0] === result.key)?.[2] ?? node ?? locales ?? o.node,
          'E_INTL',
          result.error,
        );
      return result.spec;
    });
    const locale = runtime && temp('$locale', runtime, this.irType(runtime, b));
    const nullable = runtime !== undefined && this.irType(runtime, b) !== 'string';
    const chosen = test && temp('$options', test, BOOLEAN);
    const present = (): Expr => (nullable ? { op: 'unwrap', value: locale!() } : locale!());
    const isNullish = (): Expr => this.builtin('maybe.is-nullish', [locale!()], BOOLEAN);
    if (locale) {
      // The constructor checks the locale (an undefined one is the default).
      const kind = lit(o.kind === 'plural' ? 'p' : 'n');
      const check = this.builtin('intl.locale', [present(), kind], STRING);
      temp(
        '$checked',
        nullable ? { op: 'cond', test: isNullish(), then: lit(''), else: check } : check,
        STRING,
      );
    }
    const ops = operands.map((x, i) => temp(`$operand${i}`, x, this.irType(x, b)));
    const pick = (loc: () => Expr[]): Expr => {
      const at = (spec: string) =>
        make(
          spec,
          ops.map(r => r()),
          loc(),
        );
      return chosen
        ? { op: 'cond', test: chosen(), then: at(specs[0]), else: at(specs[1]) }
        : at(specs[0]);
    };
    const body: Expr = !locale
      ? pick(() => [])
      : nullable
        ? { op: 'cond', test: isNullish(), then: pick(() => []), else: pick(() => [present()]) }
        : pick(() => [present()]);
    return this.wrapTemps(body, temps);
  }

  /** `body` inside `with` bindings of `temps`, the first outermost. */
  private wrapTemps(body: Expr, temps: [number, Expr][]): Expr {
    for (let i = temps.length - 1; i >= 0; i--)
      body = { op: 'with', local: temps[i][0], value: temps[i][1], body };
    return body;
  }

  private readonly comparators = new Map<string, number>();

  /** `collator.compare` as a function value (`list.sort(collator.compare)`). */
  private intlComparator(o: NonNullable<ReturnType<Lowerer['intlObject']>>, b: FnBuilder): Expr {
    const spec = this.intlObjectSpec(o, 'c', b);
    let fn = this.comparators.get(spec);
    if (fn === undefined) {
      fn = this.reserve();
      this.functions[fn] = {
        name: 'Intl.Collator.compare',
        params: [
          { name: 'a', type: STRING },
          { name: 'b', type: STRING },
        ],
        locals: [],
        result: NUMBER,
        body: [
          {
            op: 'return',
            value: this.builtin(
              'intl.compare',
              [
                { op: 'local', local: 0 },
                { op: 'local', local: 1 },
                { op: 'lit', value: spec },
              ],
              NUMBER,
            ),
          },
        ],
      };
      this.comparators.set(spec, fn);
    }
    return { op: 'closure', function: fn, captures: [], stable: true };
  }

  /** Locale-sensitive methods of numbers and strings. */
  private localeMethod(
    kind: 'number' | 'string',
    method: string,
    receiver: Expr,
    e: ts.CallExpression,
    b: FnBuilder,
  ): Expr | undefined {
    const a = e.arguments;
    if (kind === 'number' && method === 'toLocaleString')
      return this.localeCall('number', 'n', [receiver], a[0], a[1], e, b);
    if (kind !== 'string') return undefined;
    if (method === 'localeCompare') {
      if (a.length === 0) return this.fail(e, 'E_CALL', 'localeCompare takes a string');
      const that = this.expr(a[0], b);
      if (this.irType(that, b) !== 'string')
        return this.fail(a[0], 'E_CALL', 'localeCompare takes a string');
      if (a.length === 1) return this.builtin('string.localeCompare', [receiver, that], NUMBER);
      return this.localeCall('collator', 'l', [receiver, that], a[1], a[2], e, b);
    }
    if (method === 'toLocaleLowerCase' || method === 'toLocaleUpperCase') {
      // Every verified locale cases as the default (no Turkic, Lithuanian or
      // Greek rules), so these are toLowerCase/toUpperCase.
      if (a.length > 1) return this.fail(e, 'E_CALL', `${method} takes one locale`);
      if (a[0]) {
        const lit = this.literalOf(a[0]);
        if (
          !lit ||
          (lit.value !== undefined && (typeof lit.value !== 'string' || !verifiedLocale(lit.value)))
        )
          return this.fail(
            a[0],
            'E_INTL',
            `${method} supports no locale or a verified literal locale (${LOCALES.join(', ')})`,
          );
      }
      const name = method === 'toLocaleLowerCase' ? 'toLowerCase' : 'toUpperCase';
      return this.builtin(`string.${name}`, [receiver], STRING);
    }
    return undefined;
  }

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
    // `[...map]` (bits-ui's escape layer): the map's entries, tuple records.
    if (e.elements.length === 1 && ts.isSpreadElement(only)) {
      const m = this.expr(only.expression, b);
      const mt = this.irType(m, b);
      if (typeof mt === 'object' && 'map' in mt) {
        const entry = this.types.tupleRecord([mt.map[0], mt.map[1]]);
        return {
          op: 'builtin',
          name: 'map.entries',
          args: [m],
          type: { array: { record: entry } },
        };
      }
    }
    // An empty literal where an array type is expected (`simpleBox([])` of a
    // box of an array): that type (TypeScript's may be `never[]`).
    const want = this.expected.get(e);
    if (!e.elements.length && typeof want === 'object' && 'array' in want)
      return { op: 'array', type: want, items: [] };
    // Untyped JavaScript (`any[]`): the one IR type of the elements.
    const tsType = this.checker.getTypeAtLocation(e);
    if (
      !this.checker.getContextualType(e) &&
      e.elements.length &&
      !e.elements.some(ts.isSpreadElement) &&
      containsAny(tsType, this.checker) &&
      this.types.tryMap(tsType, e) === undefined
    ) {
      const items = e.elements.map(el => this.expr(el, b));
      const types = items.map(v => this.irType(v, b));
      if (types.every(t => sameType(t, types[0])))
        return { op: 'array', type: { array: types[0] }, items };
    }
    // An untyped literal (TypeScript: `any[]`) where an array is expected
    // (bits-ui's `polygon[i] ?? [0, 0]`): that array type.
    const context = this.checker.getContextualType(e);
    // (Also an array of records with more optional fields than the literal
    // gives, `widens`: a constant typed by the prop it is passed to.)
    // (Only a literal without a contextual type: the constant's initialiser.)
    const widened = () => {
      if (context !== undefined || !(typeof want === 'object' && 'array' in want)) return false;
      const el = want.array;
      if (!(typeof el === 'object' && 'record' in el)) return false;
      const own = this.types.tryMap(tsType, e);
      return own !== undefined && this.widens(own, want);
    };
    const type =
      typeof want === 'object' &&
      'array' in want &&
      ((containsAny(tsType, this.checker) && this.types.tryMap(tsType, e) === undefined) ||
        (context !== undefined && context.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ||
        widened())
        ? want
        : this.exprType(e);
    const t = typeof type === 'object' && 'maybe' in type ? type.maybe : type;
    // A tuple of different types (frontend/types.ts `tupleRecord`): its record.
    if (typeof t === 'object' && 'record' in t && this.types.isTuple(t.record)) {
      const fields = this.types.records[t.record].fields;
      if (e.elements.length !== fields.length || e.elements.some(ts.isSpreadElement))
        return this.fail(e, 'E_ARRAY', 'A tuple literal lists its items');
      const items = e.elements.map((el, i) => {
        this.expected.set(skipParens(el), fields[i].type);
        return this.fitValue(this.coerce(el, b, fields[i].type), fields[i].type, b);
      });
      const record: Expr = { op: 'record', record: t.record, fields: items };
      return t === type ? record : { op: 'some', value: record };
    }
    if (!(typeof t === 'object' && 'array' in t))
      return this.fail(e, 'E_ARRAY', 'Array literal without an array type');
    const items = e.elements.map(el => {
      if (ts.isSpreadElement(el)) return { spread: this.expr(el.expression, b) };
      this.expected.set(skipParens(el), t.array);
      return this.coerce(el, b, t.array);
    });
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
  'decodeURI',
]);
/** Properties getComputedStyle reads (their resolved value is the computed value). */
const COMPUTED_PROPERTIES = new Set([
  'direction',
  'z-index',
  // M6 overlays (bits-ui's scroll lock): computed lengths (a percentage is
  // reported unsupported at run time; the resolved value would be the used
  // one), and scrollbar-gutter, which the style engine does not support for
  // stylesheets (always auto).
  'scrollbar-gutter',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
]);

/** Array methods whose callbacks take (element, index, array), or two elements (sort). */
const ARRAY_CALLBACKS = new Set([
  'every',
  'some',
  'map',
  'filter',
  'forEach',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'sort',
  'toSorted',
]);
const STATIC_NAMESPACES = new Set(['Math', 'Number', 'String', 'Array', 'Object', 'JSON']);
/** Built-ins over plain data, which class instances are not (frontend/classes.ts). */
const CLASS_DATA_BUILTINS = new Set([
  'structuredClone',
  'JSON.stringify',
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.assign',
]);

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
/** Date getters (`date.*` built-ins of the same name). */
const DATE_GETTERS = new Set([
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'getUTCFullYear',
  'getUTCMonth',
  'getUTCDate',
  'getUTCDay',
  'getUTCHours',
  'getUTCMinutes',
  'getUTCSeconds',
  'getUTCMilliseconds',
  'getTimezoneOffset',
]);

/** Date setters and their largest argument count. */
const DATE_SETTERS: Record<string, number> = {
  setFullYear: 3,
  setMonth: 2,
  setDate: 1,
  setHours: 4,
  setMinutes: 3,
  setSeconds: 2,
  setMilliseconds: 1,
  setUTCFullYear: 3,
  setUTCMonth: 2,
  setUTCDate: 1,
  setUTCHours: 4,
  setUTCMinutes: 3,
  setUTCSeconds: 2,
  setUTCMilliseconds: 1,
  setTime: 1,
};

/** Supported Intl constructors. */
const INTL_KINDS: Record<string, IntlKind> = {
  DateTimeFormat: 'date',
  NumberFormat: 'number',
  Collator: 'collator',
  PluralRules: 'plural',
  DisplayNames: 'names',
};

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

/** Whether statements return a value anywhere (closures are functions of their own). */
function returnsValue(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(returnsValue);
  if (!body || typeof body !== 'object') return false;
  const node = body as { op?: string; value?: unknown };
  if (node.op === 'return' && node.value !== undefined) return true;
  return Object.values(node).some(returnsValue);
}

export function isAssignmentOperator(k: ts.SyntaxKind) {
  return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
}

/** Whether a statement always leaves its block (`return`, `throw`, `break`, `continue`). */
function exits(s: ts.Statement): boolean {
  if (ts.isBlock(s)) return s.statements.length > 0 && exits(s.statements[s.statements.length - 1]);
  return (
    ts.isReturnStatement(s) ||
    ts.isThrowStatement(s) ||
    ts.isBreakStatement(s) ||
    ts.isContinueStatement(s)
  );
}

/** A name, `this` or a member of one (reading it has no effect). */
function plainName(x: ts.Expression): boolean {
  x = skipParens(x);
  return (
    ts.isIdentifier(x) ||
    x.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isPropertyAccessExpression(x) && plainName(x.expression))
  );
}

export function skipParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))
    e = e.expression;
  return e;
}

/** Rewrite provisional local indices in a function body (not nested functions). */
/** Renumber the local indices in an IR fragment. */
/**
 * Facts about IR expressions the frontend checks once the program is
 * lowered (`Lowerer.checkStyleSpreads`), carried over to the copies
 * `remapLocals` makes.
 */
const EXPR_TAGS = new WeakMap<object, { absent?: boolean; order?: string[] }>();

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
    const tag = EXPR_TAGS.get(o);
    if (tag) EXPR_TAGS.set(out, tag);
    return out;
  };
  return visit(node) as T;
}

const lit = (value: string): Expr => ({ op: 'lit', value });

/** Whether type `t` refers to one of the type parameters `params`. */
function usesTypeParameter(
  t: ts.Type,
  params: Set<ts.Type>,
  checker: ts.TypeChecker,
  depth = 0,
): boolean {
  if (depth > 6) return false;
  if (params.has(t)) return true;
  const more: ts.Type[] = [];
  if (t.isUnionOrIntersection()) more.push(...t.types);
  if (t.flags & ts.TypeFlags.Object) {
    more.push(...checker.getTypeArguments(t as ts.TypeReference));
    if (t.aliasTypeArguments) more.push(...t.aliasTypeArguments);
    for (const s of t.getCallSignatures()) {
      more.push(s.getReturnType());
      for (const p of s.parameters) more.push(checker.getTypeOfSymbol(p));
    }
    for (const p of checker.getPropertiesOfType(t).slice(0, 40))
      more.push(checker.getTypeOfSymbol(p));
  }
  return more.some(m => usesTypeParameter(m, params, checker, depth + 1));
}

/** Global host functions also called as `window.f(…)`. */
const WINDOW_FUNCTIONS = new Set([
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'queueMicrotask',
]);

/** The runtime's user agent on this platform (runic_js::user_agent). */
function platformUserAgent(): string {
  if (platform() === 'win32') return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Runic';
  if (platform() === 'darwin') return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Runic';
  return 'Mozilla/5.0 (X11; Linux x86_64) Runic';
}
