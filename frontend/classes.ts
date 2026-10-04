// Plain JavaScript/TypeScript classes (M6 step 4, stage A;
// docs/design/M6-LIBRARIES.md, "Classes are records with methods").
//
// A class instance is a nominal IR record (`class: true`): one field per
// instance field, `#private` ones included (named `#x`), plus the fields a
// constructor creates by assignment (`this.f = …`, also bound methods
// `this.m = this.m.bind(this)`). Methods, getters and setters are IR
// functions taking the instance as their first parameter, dispatched
// statically: an instance's class is its IR type, and there is no
// inheritance. The constructor is a function returning the instance:
//
// 1. field initialisers run in declaration order into temporaries, as do
//    the leading `this.f = …` statements of the constructor;
// 2. the record is built from them;
// 3. the rest of the constructor runs with `this` bound to the record.
//
// Before the record exists, `this` may only be read as an earlier field
// (`this.f`, from its temporary), inside an arrow function stored whole in
// a field, or as `this.m.bind(this)`: those closures capture a boxed
// `maybe` local that is set once the record is built, and read it when they
// run. Static methods are functions, static fields program globals (module
// constants). Everything else is rejected with E_CLASS.
import ts from 'typescript';
import type { Expr, Local, Stmt, Type } from './ir.ts';
import { FnBuilder, remapLocals, skipParens, type Lowerer } from './language.ts';
import { maybeInner } from './irtype.ts';

/** A method, accessor or constructor. */
interface Callable {
  decl: ts.FunctionLikeDeclaration;
  name: string;
  /** The IR function (typed parameters). */
  fn?: number;
  /** Untyped parameters (JavaScript): an IR function per call site's argument types. */
  specs?: Map<string, number>;
}

interface Field {
  name: string;
  type: Type;
  /** Where the field is declared (or first assigned). */
  node: ts.Node;
  /** A TypeScript parameter property. */
  param?: ts.ParameterDeclaration;
  /** A field declaration. */
  decl?: ts.PropertyDeclaration;
}

interface Member {
  method?: Callable;
  get?: Callable;
  set?: Callable;
}

type Static =
  | { kind: 'method'; method: Callable }
  | { kind: 'field'; global: number; decl: ts.PropertyDeclaration };

export interface ClassInfo {
  name: string;
  decl: ts.ClassDeclaration;
  symbol: ts.Symbol;
  /** The instance record. */
  record: number;
  /** Instance fields in record order. */
  fields: Field[];
  /** Instance methods and accessors by name (`#name` for private ones). */
  members: Map<string, Member>;
  statics: Map<string, Static>;
  ctor?: ts.ConstructorDeclaration;
  /** The constructor (an implicit one has no declaration). */
  construct?: Callable | { fn: number };
  /** The component whose script declares the class (its members may read the component's state). */
  component?: number;
  declared: boolean;
  /** Construction creates closures holding `this` (arrow fields, bound methods). */
  rawThis: boolean;
  /** Bound-method functions by method name and receiver form. */
  bound: Map<string, number>;
}

const RUNES = /^\$(state|derived)(\.|$)/;

export class Classes {
  private readonly lower: Lowerer;
  private readonly bySymbol = new Map<ts.Symbol, ClassInfo>();
  private readonly byRecord = new Map<number, ClassInfo>();
  private readonly inProgress = new Set<number>();
  /** `f.bind(x)` wrappers by function type. */
  private readonly valueWrappers = new Map<string, number>();

  constructor(lower: Lowerer) {
    this.lower = lower;
  }

  private fail(n: ts.Node, message: string): never {
    return this.lower.fail(n, 'E_CLASS', message);
  }

  /** The class whose instances have IR type `t`, if any. */
  of(t: Type | undefined): ClassInfo | undefined {
    return t !== undefined && typeof t === 'object' && 'record' in t
      ? this.byRecord.get(t.record)
      : undefined;
  }

  /** The record of the instances of class `cls` (TypeMapper hook). */
  record(cls: ts.Symbol, t: ts.Type, at: ts.Node): number {
    const checker = this.lower.checker;
    if ((t as ts.TypeReference).target && checker.getTypeArguments(t as ts.TypeReference).length)
      this.fail(at, `Generic classes (${cls.name}) are planned for later`);
    return this.layout(cls, at).record;
  }

  // -------------------------------------------------------------------------
  // Declarations

  private layout(sym: ts.Symbol, at: ts.Node): ClassInfo {
    const known = this.bySymbol.get(sym);
    if (known) return known;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl || !ts.isClassDeclaration(decl))
      return this.fail(at, `${sym.name}: class expressions are unsupported (declare the class)`);
    if (decl.getSourceFile().isDeclarationFile)
      return this.fail(
        at,
        `${sym.name} is a library class; its instances are unsupported (only classes compiled from source are)`,
      );
    this.check(decl);
    const types = this.lower.types;
    const record = types.records.length;
    // Registered before the fields are typed, so recursive types terminate.
    types.records.push({ name: sym.name, fields: [], class: true });
    const ctor = decl.members.find(
      (m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body,
    );
    const info: ClassInfo = {
      name: sym.name,
      decl,
      symbol: sym,
      record,
      fields: [],
      members: new Map(),
      statics: new Map(),
      ...(ctor ? { ctor } : {}),
      declared: false,
      rawThis: false,
      bound: new Map(),
    };
    this.bySymbol.set(sym, info);
    this.byRecord.set(record, info);
    // Methods and accessors.
    for (const m of decl.members) {
      if (isStatic(m)) continue;
      if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
        const name = memberName(m.name!);
        const entry = info.members.get(name) ?? {};
        const callable: Callable = { decl: m, name: `${sym.name}.${name}` };
        if (ts.isMethodDeclaration(m)) entry.method = callable;
        else if (ts.isGetAccessor(m)) entry.get = { ...callable, name: `${sym.name}.get ${name}` };
        else entry.set = { ...callable, name: `${sym.name}.set ${name}` };
        info.members.set(name, entry);
      }
    }
    // Fields: parameter properties, declarations, then fields the
    // constructor creates by assignment (the instance's own properties in
    // order; their order is not observable, as keys and spreads of
    // instances are rejected).
    const fields: Field[] = [];
    const add = (f: Omit<Field, 'type'>) => {
      if (!fields.some(x => x.name === f.name)) fields.push({ ...f, type: 'void' });
    };
    for (const p of ctor?.parameters ?? [])
      if (ts.isParameterPropertyDeclaration(p, ctor!)) {
        if (!ts.isIdentifier(p.name)) this.fail(p, 'Parameter properties are plain names');
        add({ name: (p.name as ts.Identifier).text, node: p, param: p });
      }
    for (const m of decl.members)
      if (ts.isPropertyDeclaration(m) && !isStatic(m))
        add({ name: memberName(m.name), node: m, decl: m });
    for (const s of ctor?.body?.statements ?? []) {
      const target = thisAssignment(s);
      if (!target) continue;
      const name = target.name.text;
      const member = info.members.get(name);
      if (member?.get || member?.set) continue; // an accessor call, not a field
      add({ name, node: target });
    }
    // `this.f = …` elsewhere (JavaScript): fields that exist from construction on, undefined until set.
    const visit = (n: ts.Node) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const t = skipParens(n.left);
        if (
          ts.isPropertyAccessExpression(t) &&
          t.expression.kind === ts.SyntaxKind.ThisKeyword &&
          !info.members.has(t.name.text)
        )
          add({ name: t.name.text, node: t });
      }
      ts.forEachChild(n, visit);
    };
    for (const m of decl.members) if (!isStatic(m)) visit(m);
    for (const f of fields) f.type = this.fieldType(f, info);
    info.fields = fields;
    types.records[record].fields = fields.map(f => ({ name: f.name, type: f.type }));
    info.rawThis = this.capturesThis(info);
    return info;
  }

  /** Structural checks: what stage A supports. */
  private check(decl: ts.ClassDeclaration) {
    if (decl.typeParameters?.length)
      this.fail(decl.typeParameters[0], 'Generic classes are planned for later');
    for (const h of decl.heritageClauses ?? [])
      if (h.token === ts.SyntaxKind.ExtendsKeyword)
        this.fail(
          h,
          'Inheritance (extends) is unsupported: classes have no inheritance until a reached source needs it',
        );
    if (ts.getDecorators(decl)?.length) this.fail(decl, 'Decorators are unsupported');
    if (modifier(decl, ts.SyntaxKind.AbstractKeyword))
      this.fail(decl, 'Abstract classes are unsupported');
    if (!decl.name) this.fail(decl, 'Anonymous classes are unsupported (name the class)');
    if (modifier(decl, ts.SyntaxKind.DefaultKeyword))
      this.fail(decl, 'Default-exported classes are unsupported (export the class by name)');
    const ctors = decl.members.filter(ts.isConstructorDeclaration);
    if (ctors.length > 1 || ctors.some(c => !c.body))
      this.fail(ctors[0], 'Constructor overloads are unsupported');
    const seen = new Map<string, ts.Node>();
    for (const m of decl.members) {
      if (ts.isSemicolonClassElement(m)) continue;
      if (ts.canHaveDecorators(m) && ts.getDecorators(m)?.length)
        this.fail(m, 'Decorators are unsupported');
      if (modifier(m, ts.SyntaxKind.AbstractKeyword))
        this.fail(m, 'Abstract members are unsupported');
      if (modifier(m, ts.SyntaxKind.DeclareKeyword))
        this.fail(m, 'declare fields are unsupported (declare the field with a type)');
      if (modifier(m, ts.SyntaxKind.AccessorKeyword))
        this.fail(m, 'accessor fields are unsupported (write a getter and setter)');
      if (ts.isClassStaticBlockDeclaration(m)) this.fail(m, 'Static blocks are unsupported');
      if (ts.isIndexSignatureDeclaration(m)) this.fail(m, 'Index signatures are unsupported');
      if (ts.isConstructorDeclaration(m)) continue;
      const name = m.name;
      if (!name || !(ts.isIdentifier(name) || ts.isPrivateIdentifier(name)))
        this.fail(
          m,
          'Class members need a plain or #private name (computed and quoted names are unsupported)',
        );
      if (ts.isMethodDeclaration(m)) {
        if (!m.body) this.fail(m, 'Method overloads are unsupported');
        if (m.asteriskToken) this.fail(m, 'Generator methods are unsupported');
      }
      if ((ts.isGetAccessor(m) || ts.isSetAccessor(m)) && isStatic(m))
        this.fail(m, 'Static accessors are unsupported');
      if (ts.isPropertyDeclaration(m) && m.initializer) {
        const init = skipParens(m.initializer);
        if (ts.isCallExpression(init) && RUNES.test(init.expression.getText()))
          this.fail(
            m,
            'Reactive class fields ($state, $derived) are M6 stage B; declare the state in a component',
          );
      }
      // Methods and accessors may share a name (get/set pairs); fields not.
      const key = `${isStatic(m) ? 'static ' : ''}${memberName(name!)}`;
      const other = seen.get(key);
      if (
        other &&
        !(
          (ts.isGetAccessor(m) && ts.isSetAccessor(other)) ||
          (ts.isSetAccessor(m) && ts.isGetAccessor(other))
        )
      )
        this.fail(m, `Duplicate member ${memberName(name!)}`);
      seen.set(key, m);
    }
  }

  private fieldType(f: Omit<Field, 'type'>, info: ClassInfo): Type {
    const checker = this.lower.checker;
    let t: ts.Type;
    if (f.param) t = checker.getTypeAtLocation(f.param.name);
    else if (f.decl) {
      const sym = checker.getSymbolAtLocation(f.decl.name);
      t = sym ? checker.getTypeOfSymbolAtLocation(sym, f.decl) : checker.getTypeAtLocation(f.decl);
      if (f.decl.questionToken) t = checker.getNullableType(t, ts.TypeFlags.Undefined);
    } else {
      // A property created by assignment (JavaScript): its declared type.
      const name = ts.isPropertyAccessExpression(f.node) ? f.node.name : f.node;
      const sym = checker.getSymbolAtLocation(name);
      t = sym ? checker.getTypeOfSymbolAtLocation(sym, f.node) : checker.getTypeAtLocation(f.node);
    }
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      this.fail(
        f.node,
        `Field ${info.name}.${f.name} needs a type (a TypeScript annotation, or a JSDoc @type in JavaScript)`,
      );
    return this.lower.types.map(t, f.node);
  }

  /** Whether constructing an instance creates closures that hold the raw `this`. */
  private capturesThis(info: ClassInfo): boolean {
    let found = false;
    const visit = (n: ts.Node, arrow: boolean) => {
      if (found) return;
      if (n.kind === ts.SyntaxKind.ThisKeyword && arrow) found = true;
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'bind'
      )
        found = true;
      // A nested function or class member has a `this` of its own.
      if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return;
      ts.forEachChild(n, c => visit(c, arrow || ts.isArrowFunction(n)));
    };
    for (const m of info.decl.members)
      if (ts.isPropertyDeclaration(m) && !isStatic(m) && m.initializer) visit(m.initializer, false);
    if (info.ctor?.body) visit(info.ctor.body, false);
    return found;
  }

  /**
   * Declare `decl` (a statement of a module, `component` undefined, or of a
   * component script): bind its name and reserve its functions. Returns the
   * work that lowers its members, run once every declaration is known.
   */
  declare(decl: ts.ClassDeclaration, component: number | undefined): (() => void)[] {
    const lower = this.lower;
    if (!decl.name) this.check(decl);
    const sym = lower.checker.getSymbolAtLocation(decl.name!)!;
    const info = this.layout(sym, decl);
    if (info.declared) return [];
    info.declared = true;
    if (component !== undefined) info.component = component;
    lower.bindings.set(sym, { kind: 'class', cls: info });
    const self: Type = { record: info.record };
    const pending: (() => void)[] = [];
    // The constructor.
    if (info.ctor) {
      const c = this.callable(info.ctor, `${info.name}.constructor`, info, false);
      info.construct = c;
      if (c.fn !== undefined) pending.push(() => this.lowerConstructor(info, c.fn!));
    } else {
      const fn = lower.reserve();
      lower.functions[fn] = this.placeholder(`${info.name}.constructor`, info, [], self);
      info.construct = { fn };
      pending.push(() => this.lowerConstructor(info, fn));
    }
    // Methods and accessors.
    for (const [, member] of info.members)
      for (const kind of ['method', 'get', 'set'] as const) {
        const c = member[kind];
        if (!c) continue;
        const typed = this.callable(c.decl, c.name, info, true);
        member[kind] = typed;
        if (kind !== 'method' && typed.fn === undefined)
          this.fail(c.decl, 'Accessors need typed values');
        if (typed.fn !== undefined)
          pending.push(() =>
            lower.function(c.decl, c.name, undefined, info.component, typed.fn, undefined, {
              self,
            }),
          );
      }
    // Statics: methods are functions, fields program globals (module constants).
    for (const m of decl.members) {
      if (!isStatic(m)) continue;
      const name = memberName((m as ts.ClassElement).name!);
      if (ts.isMethodDeclaration(m)) {
        const c = this.callable(m, `${info.name}.${name}`, info, false);
        info.statics.set(name, { kind: 'method', method: c });
        if (c.fn !== undefined)
          pending.push(() => lower.function(m, c.name, undefined, info.component, c.fn));
      } else if (ts.isPropertyDeclaration(m)) {
        if (component !== undefined)
          this.fail(
            m,
            'Static fields of a class declared in a component script would belong to each instance; declare the class in a module',
          );
        if (!m.initializer) this.fail(m, 'Static fields need an initialiser');
        if (!modifier(m, ts.SyntaxKind.ReadonlyKeyword) && this.assignedStatic(info, name))
          this.fail(m, 'Static fields are module constants; assigning them is unsupported');
        const type = lower.exprType(m.initializer!);
        const global = lower.globals.length;
        lower.globals.push({
          name: `${info.name}.${name}`,
          type,
          init: { op: 'undefined', type: { maybe: 'number' } },
        });
        info.statics.set(name, { kind: 'field', global, decl: m });
        pending.push(() => {
          lower.globals[global].init = lower.value(
            m.initializer!,
            undefined,
            `${info.name}.${name}`,
          );
        });
      }
    }
    return pending;
  }

  /** Whether code assigns static field `name` of `info` (`C.name = …`). */
  private assignedStatic(info: ClassInfo, name: string): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const t = skipParens(n.left);
        if (
          ts.isPropertyAccessExpression(t) &&
          t.name.text === name &&
          ts.isIdentifier(t.expression) &&
          this.lower.symbol(t.expression) === info.symbol
        )
          found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(info.decl.getSourceFile());
    return found;
  }

  /** A callable member: a reserved function with its signature's types, or untyped (specialised per call). */
  private callable(
    decl: ts.FunctionLikeDeclaration,
    name: string,
    info: ClassInfo,
    self: boolean,
  ): Callable {
    const lower = this.lower;
    const untyped = decl.parameters.some(
      p => !p.type && lower.types.typeOrUndefined(p) === undefined,
    );
    if (untyped) return { decl, name, specs: new Map() };
    const fn = lower.reserve();
    const sig = lower.checker.getSignatureFromDeclaration(decl);
    const ret = sig?.getReturnType();
    const result: Type = ts.isConstructorDeclaration(decl)
      ? { record: info.record }
      : ts.isSetAccessor(decl)
        ? 'void'
        : ret && !(ret.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
          ? lower.types.map(ret, decl)
          : 'void';
    const params: Local[] = [
      ...(self ? [{ name: 'this', type: { record: info.record } as Type }] : []),
      ...decl.parameters.map(p => ({
        name: ts.isIdentifier(p.name) ? p.name.text : 'arg',
        type: lower.types.map(lower.checker.getTypeAtLocation(p), p),
      })),
    ];
    lower.functions[fn] = this.placeholder(name, info, params, result);
    return { decl, name, fn };
  }

  private placeholder(name: string, info: ClassInfo, params: Local[], result: Type) {
    return {
      name,
      ...(info.component !== undefined ? { component: info.component } : {}),
      params,
      locals: [],
      result,
      body: [],
    };
  }

  /** The function of an untyped callable for these argument types. */
  private specialise(c: Callable, info: ClassInfo, types: Type[], at: ts.Node): number {
    const lower = this.lower;
    const key = JSON.stringify(types);
    let index = c.specs!.get(key);
    if (index === undefined) {
      index = lower.reserve();
      c.specs!.set(key, index);
      this.inProgress.add(index);
      if (ts.isConstructorDeclaration(c.decl)) this.lowerConstructor(info, index, types);
      else
        lower.function(
          c.decl,
          `${c.name}<${types.map(t => JSON.stringify(t)).join(',')}>`,
          undefined,
          info.component,
          index,
          types,
          isStatic(c.decl) ? undefined : { self: { record: info.record } },
        );
      this.inProgress.delete(index);
    } else if (this.inProgress.has(index))
      this.fail(at, `Recursive untyped ${c.name}: add parameter types`);
    return index;
  }

  /** Arguments of a call to untyped `c`, and the function specialised to their types. */
  private untypedCall(
    c: Callable,
    info: ClassInfo,
    e: ts.CallExpression | ts.NewExpression,
    b: FnBuilder,
  ): { fn: number; args: Expr[] } {
    const lower = this.lower;
    const nodes = e.arguments ?? [];
    if (nodes.length < c.decl.parameters.length)
      this.fail(
        e,
        `Untyped ${c.name} needs all ${c.decl.parameters.length} arguments (or parameter types)`,
      );
    const args = nodes.map(a => lower.expr(a, b));
    const types = args.map(a => lower.irType(a, b));
    const fn = this.specialise(c, info, types, e);
    return { fn, args: args.slice(0, c.decl.parameters.length) };
  }

  private declaredOnly(info: ClassInfo, at: ts.Node) {
    if (!info.declared)
      this.fail(at, `${info.name} is not declared in a module or component script`);
  }

  private ensureDeclared(info: ClassInfo, at: ts.Node) {
    if (!info.declared)
      this.fail(at, `${info.name} is not declared in a module or component script`);
    // A class is not hoisted: using it above its declaration throws.
    if (at.getSourceFile() === info.decl.getSourceFile() && at.end <= info.decl.pos) {
      for (let p = at.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return;
      this.fail(at, `${info.name} is used before its declaration (classes are not hoisted)`);
    }
  }

  // -------------------------------------------------------------------------
  // The constructor

  private lowerConstructor(info: ClassInfo, index: number, paramTypes?: Type[]) {
    const lower = this.lower;
    const self: Type = { record: info.record };
    if (info.ctor) {
      lower.function(
        info.ctor,
        `${info.name}.constructor`,
        undefined,
        info.component,
        index,
        paramTypes,
        {
          body: b => this.constructorBody(info, b),
        },
      );
      return;
    }
    const b = new FnBuilder(
      `${info.name}.constructor`,
      undefined,
      info.component,
      new Set(),
      false,
    );
    const body = this.constructorBody(info, b);
    body.unshift(...lower.hoistedLets(b));
    const source = lower.sourceOf(info.decl);
    lower.functions[index] = {
      name: `${info.name}.constructor`,
      ...(info.component !== undefined ? { component: info.component } : {}),
      params: [],
      locals: b.locals,
      result: self,
      body: remapLocals(body, i => b.final(i)),
      ...(source ? { source } : {}),
    };
  }

  private constructorBody(info: ClassInfo, b: FnBuilder): Stmt[] {
    const lower = this.lower;
    const self: Type = { record: info.record };
    const out: Stmt[] = [];
    const local = (l: number): Expr => ({ op: 'local', local: l });
    // `this` before the record exists: closures created meanwhile read it later.
    const early = b.local('this?', { maybe: self }, true);
    out.push({ op: 'let', local: early, value: { op: 'undefined', type: { maybe: self } } });
    const containers: ts.Node[] = info.decl.members.filter(
      m => ts.isPropertyDeclaration(m) && !isStatic(m),
    );
    if (info.ctor) containers.push(info.ctor);
    for (const c of containers) lower.thisBindings.set(c, { owner: b, local: early, maybe: true });
    /** Field → the temporary holding its value until the record is built. */
    const temps = new Map<string, number>();
    const assign = (field: Field, value: Expr, at: ts.Node) => {
      const have = lower.irType(value, b);
      if (maybeInner(field.type) && !maybeInner(have) && have !== 'void')
        value = { op: 'some', value };
      const known = temps.get(field.name);
      if (known !== undefined) {
        out.push({ op: 'assign', target: { place: 'local', local: known }, value, ...src(at) });
        return;
      }
      const t = b.local(field.name, field.type);
      temps.set(field.name, t);
      out.push({ op: 'let', local: t, value, ...src(at) });
    };
    const src = (n: ts.Node) => {
      const s = lower.sourceOf(n);
      return s ? { source: s } : {};
    };
    // 1. Parameter properties, then field initialisers in declaration order.
    for (const f of info.fields)
      if (f.param) {
        const name = (f.param.name as ts.Identifier).text;
        const binding = lower.bindings.get(
          lower.checker.getSymbolsOfParameterPropertyDeclaration(f.param as never, name)[0],
        );
        if (binding?.kind !== 'local') return this.fail(f.param, 'Unresolved parameter property');
        assign(f, local(binding.local), f.param);
      }
    for (const f of info.fields)
      if (f.decl?.initializer)
        assign(f, this.early(f.decl.initializer, b, info, temps, 'initialiser'), f.decl);
    // 2. Leading `this.f = …` statements and statements that do not use `this`.
    const statements = info.ctor?.body?.statements ?? [];
    let i = 0;
    for (; i < statements.length; i++) {
      const s = statements[i];
      this.noReturn(s);
      const target = thisAssignment(s);
      const field = target && info.fields.find(f => f.name === target.name.text);
      if (target && field) {
        const rhs = ((s as ts.ExpressionStatement).expression as ts.BinaryExpression).right;
        if (!this.earlyForm(rhs, info, temps)) break;
        assign(field, this.early(rhs, b, info, temps, 'constructor'), s);
        continue;
      }
      if (mentionsThis(s)) break;
      out.push(...lower.statement(s, b));
    }
    // 3. The record.
    const fields: Expr[] = info.fields.map(f => {
      const t = temps.get(f.name);
      if (t !== undefined) return local(t);
      if (maybeInner(f.type)) return { op: 'undefined', type: f.type };
      return this.fail(
        f.node,
        `${info.name}.${f.name} is not set before the constructor otherwise uses this: give it an initialiser, assign it at the start of the constructor, or make it optional`,
      );
    });
    const instance = b.local('this', self);
    out.push({ op: 'let', local: instance, value: { op: 'record', record: info.record, fields } });
    out.push({
      op: 'assign',
      target: { place: 'local', local: early },
      value: { op: 'some', value: local(instance) },
    });
    // 4. The rest of the constructor, with `this` the instance.
    if (info.ctor) lower.thisBindings.set(info.ctor, { owner: b, local: instance });
    for (; i < statements.length; i++) {
      this.noReturn(statements[i]);
      out.push(...lower.statement(statements[i], b));
    }
    out.push({ op: 'return', value: local(instance) });
    return out;
  }

  /** Constructors return their instance: `return` statements are rejected. */
  private noReturn(s: ts.Node) {
    const visit = (n: ts.Node) => {
      if (ts.isReturnStatement(n))
        this.fail(
          n,
          'return in a constructor is unsupported (the constructor returns its instance)',
        );
      if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
    };
    visit(s);
  }

  /** Whether `e` can be evaluated before the record exists (see `early`). */
  private earlyForm(e: ts.Expression, info: ClassInfo, temps: Map<string, number>): boolean {
    const inner = skipParens(e);
    if (ts.isArrowFunction(inner) || this.ownBind(inner, info, temps)) return true;
    let ok = true;
    const visit = (n: ts.Node, nested: boolean) => {
      if (n.kind === ts.SyntaxKind.ThisKeyword && !this.earlyRead(n, nested, info, temps))
        ok = false;
      ts.forEachChild(n, c => visit(c, nested || ts.isFunctionLike(n)));
    };
    visit(inner, false);
    return ok;
  }

  /** `this.f` read before the record exists: an earlier field that holds no function. */
  private earlyRead(
    n: ts.Node,
    nested: boolean,
    info: ClassInfo,
    temps: Map<string, number>,
  ): Field | undefined {
    const p = n.parent;
    if (nested || !ts.isPropertyAccessExpression(p) || p.expression !== n) return undefined;
    const field = info.fields.find(f => f.name === p.name.text);
    if (!field || !temps.has(field.name)) return undefined;
    const fnType = (t: Type | undefined) => typeof t === 'object' && 'fn' in t;
    if (fnType(field.type) || fnType(maybeInner(field.type))) return undefined;
    const g = p.parent;
    if (ts.isCallExpression(g) && g.expression === p) return undefined;
    if (
      (ts.isBinaryExpression(g) &&
        g.left === p &&
        g.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        g.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(g) || ts.isPostfixUnaryExpression(g)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(g.operator))
    )
      return undefined;
    return field;
  }

  /**
   * A field initialiser or leading constructor assignment, evaluated before
   * the record exists: without `this`, a whole arrow function (its `this`
   * is read when it runs), `this.m.bind(this)`, or reading earlier fields.
   */
  private early(
    e: ts.Expression,
    b: FnBuilder,
    info: ClassInfo,
    temps: Map<string, number>,
    where: 'initialiser' | 'constructor',
  ): Expr {
    const lower = this.lower;
    const inner = skipParens(e);
    if (ts.isCallExpression(inner) && RUNES.test(inner.expression.getText()))
      this.fail(
        inner,
        'Reactive class fields ($state, $derived) are M6 stage B; declare the state in a component',
      );
    if (ts.isArrowFunction(inner)) return lower.expr(e, b);
    if (ts.isCallExpression(inner) && this.ownBind(inner, info, temps))
      return this.bind(inner, b, temps)!;
    const overrides = new Map<ts.Node, { expr: Expr; type: Type }>();
    const visit = (n: ts.Node, nested: boolean) => {
      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        const field = this.earlyRead(n, nested, info, temps);
        if (!field)
          this.fail(
            n,
            nested
              ? 'this inside a function that may run while the instance is built (a callback) is unsupported; store an arrow function whole in a field, or use it after the fields are set'
              : 'this is used before the instance is complete: only earlier fields can be read here (methods, accessors and function-valued fields need the instance)',
          );
        if (where === 'initialiser' && field.param)
          this.fail(
            n,
            'A field initialiser reading a parameter property depends on the TypeScript emit order; read the constructor parameter in the constructor instead',
          );
        overrides.set(n.parent, {
          expr: { op: 'local', local: temps.get(field.name)! },
          type: field.type,
        });
        return;
      }
      ts.forEachChild(n, c => visit(c, nested || ts.isFunctionLike(n)));
    };
    visit(inner, false);
    return lower.withOverrides(overrides, () => lower.expr(e, b));
  }

  // -------------------------------------------------------------------------
  // `this` and members

  /** `this` in a class member (or an arrow function inside one). */
  thisValue(node: ts.Expression, b: FnBuilder): Expr {
    const lower = this.lower;
    let deferred = false;
    let container: ts.Node | undefined;
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isArrowFunction(p)) {
        deferred = true;
        continue;
      }
      if (
        ts.isFunctionLike(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isClassStaticBlockDeclaration(p)
      ) {
        container = p;
        break;
      }
    }
    const binding = container && lower.thisBindings.get(container);
    if (!binding) {
      if (container && ts.isClassElement(container) && isStatic(container))
        return this.fail(node, 'this in a static member is the class itself; use the class name');
      if (container && (ts.isFunctionDeclaration(container) || ts.isFunctionExpression(container)))
        return this.fail(
          node,
          "this inside a function is its caller's receiver; use an arrow function inside class members",
        );
      return this.fail(
        node,
        'this is supported in class methods, accessors, constructors and field initialisers',
      );
    }
    if (binding.maybe && !deferred)
      return this.fail(
        node,
        'this is used before the instance is complete: only earlier fields can be read here',
      );
    const local: Expr = { op: 'local', local: b.resolve(binding.owner, binding.local) };
    return binding.maybe ? { op: 'unwrap', value: local } : local;
  }

  /** The class of the instances `e` evaluates to (by TypeScript's type), if any. */
  private classOfNode(e: ts.Expression): ClassInfo | undefined {
    const checker = this.lower.checker;
    let t = checker.getNonNullableType(checker.getTypeAtLocation(e));
    if (t.flags & ts.TypeFlags.TypeParameter && (t as { isThisType?: boolean }).isThisType)
      t = checker.getBaseConstraintOfType(t) ?? t;
    const sym = t.symbol;
    if (!sym || !(sym.flags & ts.SymbolFlags.Class) || t.getConstructSignatures().length)
      return undefined;
    const it = this.lower.typeAt(e);
    return this.of(maybeInner(it) ?? it);
  }

  private fieldIndex(info: ClassInfo, name: string): number {
    return info.fields.findIndex(f => f.name === name);
  }

  /** `obj.name` on an instance. */
  read(info: ClassInfo, object: Expr, e: ts.PropertyAccessExpression, _b: FnBuilder): Expr {
    this.declaredOnly(info, e);
    const name = e.name.text;
    const field = this.fieldIndex(info, name);
    if (field >= 0) return { op: 'get', object, field };
    const member = info.members.get(name);
    if (member?.get) return { op: 'call', function: member.get.fn!, args: [object] };
    if (member?.set)
      return this.fail(
        e,
        `${info.name}.${name} has a setter but no getter: reading it gives undefined`,
      );
    if (member?.method)
      return this.fail(
        e,
        `${info.name}.${name} is a method used as a value; its this would be undefined when called. Bind it (this.${name} = this.${name}.bind(this) in the constructor), use an arrow function field, or call it`,
      );
    return this.lower.fail(e, 'E_MEMBER', `${info.name} has no member ${name}`);
  }

  /** `obj.name(…)` on an instance. */
  callMethod(
    info: ClassInfo,
    receiver: Expr,
    callee: ts.PropertyAccessExpression,
    e: ts.CallExpression,
    b: FnBuilder,
  ): Expr {
    const lower = this.lower;
    const name = callee.name.text;
    const field = this.fieldIndex(info, name);
    this.declaredOnly(info, e);
    if (field >= 0)
      return {
        op: 'call-value',
        callee: { op: 'get', object: receiver, field },
        args: lower.callArgs(e, b),
      };
    const member = info.members.get(name);
    const method = member?.method;
    if (method) {
      if (method.fn !== undefined)
        return { op: 'call', function: method.fn, args: [receiver, ...lower.callArgs(e, b)] };
      // Untyped parameters: the receiver is bound first (evaluated before the arguments).
      const tmp = b.local('$receiver', { record: info.record });
      const { fn, args } = this.untypedCall(method, info, e, b);
      return {
        op: 'with',
        local: tmp,
        value: receiver,
        body: { op: 'call', function: fn, args: [{ op: 'local', local: tmp }, ...args] },
      };
    }
    if (member?.get)
      return {
        op: 'call-value',
        callee: { op: 'call', function: member.get.fn!, args: [receiver] },
        args: lower.callArgs(e, b),
      };
    return lower.fail(e, 'E_MEMBER', `${info.name} has no method ${name}`);
  }

  /** `obj.name = value` on an instance or `C.name = value`; undefined for plain fields. */
  write(target: ts.PropertyAccessExpression, value: Expr, b: FnBuilder): Stmt[] | undefined {
    const lower = this.lower;
    const name = target.name.text;
    if (ts.isIdentifier(target.expression)) {
      const cls = lower.binding(target.expression);
      if (cls?.kind === 'class')
        return this.fail(
          target,
          'Static fields are module constants; assigning them is unsupported',
        );
    }
    const info = this.classOfNode(target.expression);
    if (!info || this.fieldIndex(info, name) >= 0) return undefined;
    this.declaredOnly(info, target);
    const member = info.members.get(name);
    const source = lower.sourceOf(target);
    if (member?.set) {
      const want = lower.functions[member.set.fn!].params[1]?.type;
      const have = lower.irType(value, b);
      if (want && maybeInner(want) && !maybeInner(have) && have !== 'void')
        value = { op: 'some', value };
      return [
        {
          op: 'expr',
          value: {
            op: 'call',
            function: member.set.fn!,
            args: [lower.expr(target.expression, b), value],
          },
          ...(source ? { source } : {}),
        },
      ];
    }
    if (member?.get)
      return this.fail(
        target,
        `${info.name}.${name} has a getter but no setter: assigning it throws a TypeError`,
      );
    if (member?.method)
      return this.fail(
        target,
        `Assigning method ${info.name}.${name} is supported only at the start of the constructor (this.${name} = this.${name}.bind(this))`,
      );
    return undefined;
  }

  /** `C.name` */
  staticRead(info: ClassInfo, e: ts.PropertyAccessExpression, _b: FnBuilder): Expr {
    this.ensureDeclared(info, e);
    const s = info.statics.get(e.name.text);
    if (s?.kind === 'field') return { op: 'global', global: s.global };
    if (s?.kind === 'method') {
      if (s.method.fn === undefined)
        return this.fail(
          e,
          `${s.method.name} has untyped parameters, so it can only be called directly; add parameter types to pass it as a value`,
        );
      return { op: 'closure', function: s.method.fn, captures: [], stable: true };
    }
    if (e.name.text === 'name' || e.name.text === 'prototype' || e.name.text === 'length')
      return this.fail(e, `${info.name}.${e.name.text} is unsupported (classes are not values)`);
    return this.lower.fail(e, 'E_MEMBER', `${info.name} has no static member ${e.name.text}`);
  }

  /** `C.name(…)` */
  callStatic(
    info: ClassInfo,
    callee: ts.PropertyAccessExpression,
    e: ts.CallExpression,
    b: FnBuilder,
  ): Expr {
    const lower = this.lower;
    this.ensureDeclared(info, e);
    const s = info.statics.get(callee.name.text);
    if (s?.kind === 'method') {
      if (s.method.fn !== undefined)
        return { op: 'call', function: s.method.fn, args: lower.callArgs(e, b) };
      const { fn, args } = this.untypedCall(s.method, info, e, b);
      return { op: 'call', function: fn, args };
    }
    if (s?.kind === 'field')
      return {
        op: 'call-value',
        callee: { op: 'global', global: s.global },
        args: lower.callArgs(e, b),
      };
    return lower.fail(e, 'E_MEMBER', `${info.name} has no static method ${callee.name.text}`);
  }

  /** `new C(…)` */
  construct(info: ClassInfo, e: ts.NewExpression, b: FnBuilder): Expr {
    const lower = this.lower;
    this.ensureDeclared(info, e);
    const c = info.construct!;
    if (!('decl' in c)) {
      if (e.arguments?.length)
        this.fail(e.arguments[0], `${info.name} has no constructor parameters`);
      return { op: 'call', function: c.fn, args: [] };
    }
    if (c.fn !== undefined) return { op: 'call', function: c.fn, args: lower.callArgs(e, b) };
    const { fn, args } = this.untypedCall(c, info, e, b);
    return { op: 'call', function: fn, args };
  }

  /** `x instanceof C`: decided by the static type of `x` (no inheritance, no unions). */
  instanceOf(info: ClassInfo, left: ts.Expression, b: FnBuilder): Expr {
    const lower = this.lower;
    this.ensureDeclared(info, left.parent);
    if (lower.checker.getTypeAtLocation(left).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      return this.fail(
        left,
        'instanceof needs an operand whose static type decides it (values of unknown type, such as caught exceptions, are unsupported)',
      );
    const v = lower.expr(left, b);
    const t = lower.irType(v, b);
    const inner = maybeInner(t) ?? t;
    const same = typeof inner === 'object' && 'record' in inner && inner.record === info.record;
    if (same && maybeInner(t))
      return {
        op: 'not',
        arg: { op: 'builtin', name: 'maybe.is-nullish', args: [v], type: 'boolean' },
      };
    // Evaluated for its effects; the answer is static.
    const tmp = b.local('$instanceof', t);
    return { op: 'with', local: tmp, value: v, body: { op: 'lit', value: same } };
  }

  // -------------------------------------------------------------------------
  // bind

  /** `X.m.bind(…)` where `m` is a method of `X`'s class (not a field holding a function). */
  private ownBind(e: ts.Expression, info?: ClassInfo, temps?: Map<string, number>): boolean {
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
    if (e.expression.name.text !== 'bind') return false;
    const target = skipParens(e.expression.expression);
    if (!ts.isPropertyAccessExpression(target)) return false;
    const cls = this.classOfNode(target.expression);
    if (!cls || (info && cls !== info)) return false;
    // A method also bound into a field of its name (`this.m = this.m.bind(this)`)
    // is read from the prototype only until that field is set.
    const name = target.name.text;
    return (
      !!cls.members.get(name)?.method &&
      (this.fieldIndex(cls, name) < 0 || (temps !== undefined && !temps.has(name)))
    );
  }

  /**
   * `obj.m.bind(x)` for a method `m` (a closure calling it with `x`), and
   * `f.bind(x)` for a function value (a new closure calling `f`; an arrow
   * function ignores `x`). Undefined for other `bind` calls.
   */
  bind(e: ts.CallExpression, b: FnBuilder, temps?: Map<string, number>): Expr | undefined {
    const lower = this.lower;
    if (!ts.isPropertyAccessExpression(e.expression) || e.expression.name.text !== 'bind')
      return undefined;
    const target = skipParens(e.expression.expression);
    if (e.arguments.length !== 1) {
      const t = lower.types.typeOrUndefined(target);
      if (this.ownBind(e, undefined, temps) || (typeof t === 'object' && 'fn' in t))
        return this.fail(
          e,
          'bind takes exactly the this value (partial application is unsupported)',
        );
      return undefined;
    }
    const thisArg = skipParens(e.arguments[0]);
    if (this.ownBind(e, undefined, temps)) {
      const access = target as ts.PropertyAccessExpression;
      const info = this.classOfNode(access.expression)!;
      const method = info.members.get(access.name.text)!.method!;
      if (method.fn === undefined)
        return this.fail(
          e,
          `${method.name} has untyped parameters, so it cannot be bound; add parameter types`,
        );
      // The receiver only supplies the method (statically known): it must be free of effects.
      if (!pure(access.expression))
        return this.fail(
          access.expression,
          'The receiver of a bound method must be this, a variable or a property',
        );
      const thisType = lower.typeAt(thisArg);
      if (this.of(thisType) !== info)
        return this.fail(
          thisArg,
          `${info.name}.${access.name.text} must be bound to a ${info.name} instance`,
        );
      // `this` while the instance is being built: the boxed early local.
      if (thisArg.kind === ts.SyntaxKind.ThisKeyword) {
        const early = this.earlyThis(thisArg);
        if (early)
          return {
            op: 'closure',
            function: this.boundMethod(info, method, true),
            captures: [b.resolve(early.owner, early.local)],
          };
      }
      const tmp = b.local('$bound', { record: info.record });
      return {
        op: 'with',
        local: tmp,
        value: lower.expr(thisArg, b),
        body: { op: 'closure', function: this.boundMethod(info, method, false), captures: [tmp] },
      };
    }
    const t = lower.types.typeOrUndefined(target);
    if (!(typeof t === 'object' && 'fn' in t)) return undefined;
    // Function values never read `this` (it is rejected outside class members),
    // so the receiver is ignored; it must be free of effects.
    if (!(
      thisArg.kind === ts.SyntaxKind.ThisKeyword ||
      thisArg.kind === ts.SyntaxKind.NullKeyword ||
      ts.isIdentifier(thisArg)
    ))
      return this.fail(
        thisArg,
        'Binding a function value is supported with this, null, undefined or a variable as the receiver (the function ignores it)',
      );
    const f = lower.expr(target, b);
    const ft = lower.irType(f, b) as { fn: { params: Type[]; result: Type } };
    const tmp = b.local('$bind', ft);
    return {
      op: 'with',
      local: tmp,
      value: f,
      body: { op: 'closure', function: this.valueWrapper(ft), captures: [tmp] },
    };
  }

  /** The early (`maybe`) binding of `this` at `node`, if the instance is not built there. */
  private earlyThis(node: ts.Node) {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isArrowFunction(p)) return undefined;
      if (ts.isFunctionLike(p) || ts.isPropertyDeclaration(p)) {
        const binding = this.lower.thisBindings.get(p);
        return binding?.maybe ? binding : undefined;
      }
    }
    return undefined;
  }

  /** A function calling method `m` with its captured receiver (a `maybe` one for `early`). */
  private boundMethod(info: ClassInfo, m: Callable, early: boolean): number {
    const lower = this.lower;
    const key = `${m.name}${early ? '?' : ''}`;
    const known = info.bound.get(key);
    if (known !== undefined) return known;
    const target = lower.functions[m.fn!];
    const self: Type = { record: info.record };
    const params = target.params.slice(1);
    const receiver: Expr = early
      ? { op: 'unwrap', value: { op: 'local', local: 0 } }
      : { op: 'local', local: 0 };
    const call: Expr = {
      op: 'call',
      function: m.fn!,
      args: [receiver, ...params.map((_, i) => ({ op: 'local', local: i + 1 }) as Expr)],
    };
    const index = lower.reserve();
    lower.functions[index] = {
      name: `${m.name} (bound)`,
      ...(info.component !== undefined ? { component: info.component } : {}),
      captures: [
        { name: 'this', type: early ? { maybe: self } : self, ...(early ? { boxed: true } : {}) },
      ],
      params: params.map(p => ({ name: p.name, type: p.type })),
      locals: [],
      result: target.result,
      body:
        target.result === 'void' ? [{ op: 'expr', value: call }] : [{ op: 'return', value: call }],
    };
    info.bound.set(key, index);
    return index;
  }

  /** A function calling its captured function value (`f.bind(x)`). */
  private valueWrapper(t: { fn: { params: Type[]; result: Type } }): number {
    const lower = this.lower;
    const key = JSON.stringify(t);
    const known = this.valueWrappers.get(key);
    if (known !== undefined) return known;
    const call: Expr = {
      op: 'call-value',
      callee: { op: 'local', local: 0 },
      args: t.fn.params.map((_, i) => ({ op: 'local', local: i + 1 }) as Expr),
    };
    const index = lower.reserve();
    lower.functions[index] = {
      name: 'bound function',
      captures: [{ name: 'target', type: t }],
      params: t.fn.params.map((type, i) => ({ name: `arg${i}`, type })),
      locals: [],
      result: t.fn.result,
      body:
        t.fn.result === 'void' ? [{ op: 'expr', value: call }] : [{ op: 'return', value: call }],
    };
    this.valueWrappers.set(key, index);
    return index;
  }

  // -------------------------------------------------------------------------
  // Plain-data operations

  /** The name of a class whose instances a value of type `t` can hold, if any. */
  holdsClass(t: Type, seen = new Set<number>()): string | undefined {
    if (typeof t !== 'object') return undefined;
    if ('maybe' in t) return this.holdsClass(t.maybe, seen);
    if ('array' in t) return this.holdsClass(t.array, seen);
    if ('set' in t) return this.holdsClass(t.set, seen);
    if ('promise' in t) return this.holdsClass(t.promise, seen);
    if ('map' in t) return this.holdsClass(t.map[0], seen) ?? this.holdsClass(t.map[1], seen);
    if ('record' in t) {
      if (seen.has(t.record)) return undefined;
      seen.add(t.record);
      const r = this.lower.types.records[t.record];
      if (r.class) return r.name;
      for (const f of r.fields) {
        const found = this.holdsClass(f.type, seen);
        if (found) return found;
      }
    }
    return undefined;
  }

  /** Built-ins over plain data (keys, JSON, structured clones) reject class instances. */
  plainData(name: string, args: Type[], at: ts.Node) {
    for (const t of args) {
      const cls = this.holdsClass(t);
      if (cls)
        this.fail(
          at,
          `${name} of a ${cls} instance is unsupported: instances are not plain data (private fields, accessors and methods are not copied)`,
        );
    }
  }

  /**
   * The name of a class reachable from `t` whose construction keeps the raw
   * `this` in closures (Vue's reactive proxy does not see writes through
   * them).
   */
  rawThis(t: Type, seen = new Set<number>()): string | undefined {
    if (typeof t !== 'object') return undefined;
    if ('maybe' in t) return this.rawThis(t.maybe, seen);
    if ('array' in t) return this.rawThis(t.array, seen);
    if ('set' in t) return this.rawThis(t.set, seen);
    if ('map' in t) return this.rawThis(t.map[0], seen) ?? this.rawThis(t.map[1], seen);
    if ('record' in t && !seen.has(t.record)) {
      seen.add(t.record);
      const info = this.byRecord.get(t.record);
      if (info?.rawThis) return info.name;
      for (const f of this.lower.types.records[t.record].fields) {
        const found = this.rawThis(f.type, seen);
        if (found) return found;
      }
    }
    return undefined;
  }
}

// Helpers -----------------------------------------------------------------------

function isStatic(m: ts.Node): boolean {
  return modifier(m, ts.SyntaxKind.StaticKeyword);
}

function modifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some(m => m.kind === kind);
}

function memberName(n: ts.PropertyName): string {
  return ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? n.text : n.getText();
}

/** `this.name = …` as a statement: its target. */
function thisAssignment(s: ts.Statement): ts.PropertyAccessExpression | undefined {
  if (!ts.isExpressionStatement(s)) return undefined;
  const e = skipParens(s.expression);
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    return undefined;
  const t = skipParens(e.left);
  return ts.isPropertyAccessExpression(t) && t.expression.kind === ts.SyntaxKind.ThisKeyword
    ? t
    : undefined;
}

function mentionsThis(n: ts.Node): boolean {
  if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) return true;
  return !!ts.forEachChild(n, c => mentionsThis(c) || undefined);
}

/** `this`, a variable or a property chain of them (reading has no effects). */
function pure(e: ts.Expression): boolean {
  e = skipParens(e);
  if (e.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(e)) return true;
  return ts.isPropertyAccessExpression(e) && pure(e.expression);
}
