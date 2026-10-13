// JavaScript/TypeScript classes (M6 step 4: stage A, plain classes; stage
// B, reactive fields; inheritance and class unions.
// docs/design/M6-LIBRARIES.md, "Classes are records with methods" and
// "Inheritance and class unions").
//
// A class instance is a nominal IR record (`class: true`): one field per
// instance field, `#private` ones included (named `#x`), plus the fields a
// constructor creates by assignment (`this.f = …`, also bound methods
// `this.m = this.m.bind(this)`). A subclass's record starts with its base's
// fields (`extends`), so a field has one index in a whole hierarchy. Methods,
// getters and setters are IR functions taking the instance as their first
// parameter. The constructor of a class is a function returning the
// instance; for a subclass it runs the whole chain in JavaScript's order:
//
// 1. the statements before each `super(…)` call, from the class up to the
//    root, each followed by its arguments;
// 2. from the root down, each class's parameter properties, field
//    initialisers and the statements after its `super(…)`, into
//    temporaries, as long as they do not need the instance;
// 3. the record is built from them;
// 4. the rest of the constructors runs with `this` bound to the record.
//
// Before the record exists, `this` may only be read as an earlier field
// (`this.f`, from its temporary), inside an arrow function stored whole in
// a field, or as `this.m.bind(this)`: those closures capture a boxed
// `maybe` local that is set once the record is built, and read it when they
// run. A class whose constructor needs the instance before a subclass's
// fields exist is rejected for that subclass (JavaScript runs the
// subclass's field initialisers after `super(…)` returns).
//
// Types: an instance of a class without subclasses has its record type;
// a value TypeScript types as a class with subclasses, or as a union of
// classes, is a class reference (`{class}`, `{classes}`), which carries the
// instance's class. Members are resolved statically when every class the
// value can have resolves them alike, and otherwise by a `match-class` over
// those classes (the closed world: every class of the program's sources is
// known). Static methods are functions, static fields program globals
// (module constants). Everything else is rejected with E_CLASS.
import ts from 'typescript';
import type { Expr, Local, Stmt, Type } from './ir.ts';
import { FnBuilder, remapLocals, skipParens, type Lowerer } from './language.ts';
import { classMembers, concreteMembers, fitType, maybeInner } from './irtype.ts';

/** A method, accessor or constructor. */
interface Callable {
  decl: ts.FunctionLikeDeclaration;
  name: string;
  /** The IR function (typed parameters). */
  fn?: number;
  /** Untyped parameters (JavaScript): an IR function per call site's argument types. */
  specs?: Map<string, number>;
  /** Parameter types of a generic class's instantiation (`Classes.instantiate`). */
  params?: Type[];
}

/** The one instantiation of a generic class in the program. */
interface Instance {
  /** The instance type with its type arguments. */
  type: ts.Type;
  /** A `new` of it, whose resolved signature is the constructor's. */
  construct?: ts.NewExpression;
}

interface Field {
  /** The source name (`#x` for private fields). */
  name: string;
  /** The record field's name (a private name a base class uses too is qualified). */
  key: string;
  type: Type;
  /** The class declaring it. */
  owner: ClassInfo;
  /** Where the field is declared (or first assigned). */
  node: ts.Node;
  /** A TypeScript parameter property. */
  param?: ts.ParameterDeclaration;
  /** A field declaration. */
  decl?: ts.PropertyDeclaration;
  /**
   * A reactive field (M6 stage B): the Svelte rune creating it, in the
   * field's initialiser or a top-level constructor assignment.
   */
  rune?: { kind: Rune; call: ts.CallExpression; container: ts.Node };
  /** The function computing a derived field from the instance. */
  derived?: number;
  /**
   * Set by a statement of the constructor's top level after the instance
   * exists, and not read before (`lateFields`): stored as a nullable value
   * that is undefined until then; reads unwrap it.
   */
  late?: boolean;
}

/** The runes that declare reactive class fields. */
type Rune = '$state' | '$state.raw' | '$derived' | '$derived.by';

interface Member {
  method?: Callable;
  get?: Callable;
  set?: Callable;
  /** An abstract method or property: implemented by the subclasses. */
  abstract?: ts.ClassElement;
}

type Static =
  | { kind: 'method'; method: Callable }
  | { kind: 'field'; global: number; decl: ts.PropertyDeclaration }
  /**
   * A static field the class assigns (FocusScopeManager's lazily created
   * `static instance`): a global record of one field holding its value.
   */
  | { kind: 'cell'; global: number; type: Type; decl: ts.PropertyDeclaration };

/** What a member name means on an instance of one class. */
type Target =
  | { kind: 'field'; field: Field }
  | { kind: 'method'; method: Callable; owner: ClassInfo }
  | { kind: 'accessor'; get?: Callable; set?: Callable; owner: ClassInfo }
  | { kind: 'abstract'; owner: ClassInfo };

export interface ClassInfo {
  name: string;
  decl: ts.ClassDeclaration;
  symbol: ts.Symbol;
  /** The instance record. */
  record: number;
  /** The class it extends (M6 inheritance). */
  base?: ClassInfo;
  /** Its direct subclasses (every class of the program's sources). */
  subclasses: ClassInfo[];
  abstract: boolean;
  /** The fields it declares, after its base's in record order. */
  own: Field[];
  /** Instance fields in record order (the base's first). */
  fields: Field[];
  /** The methods and accessors it declares by name (`#name` for private ones). */
  members: Map<string, Member>;
  statics: Map<string, Static>;
  ctor?: ts.ConstructorDeclaration;
  /** The constructor (an implicit one without parameters has no declaration). */
  construct?: Callable | { fn: number };
  /** The component whose script declares the class (its members may read the component's state). */
  component?: number;
  declared: boolean;
  /** Construction creates closures holding `this` (arrow fields, bound methods). */
  rawThis: boolean;
  /**
   * Fields of its base classes that it declares again without an
   * initialiser and assigns at the top level of its constructor (bits-ui's
   * `opts` of a narrower options type): one field, of a record merging the
   * declared types.
   */
  redeclared?: ts.PropertyDeclaration[];
  /**
   * Plain data fields of its base classes that it declares again with an
   * initialiser (bits-ui's SliderMultiRootState `getAllThumbs = () => …`):
   * the base's field, assigned the initialiser in its place among this
   * class's field initialisers (`fieldOverride`).
   */
  overrides?: ts.PropertyDeclaration[];
}

const RUNES = /^\$(state|derived)(\.|$)/;
const FIELD_RUNES: Rune[] = ['$state', '$state.raw', '$derived', '$derived.by'];

/**
 * Svelte compiles runes in components and in `.svelte.js`/`.svelte.ts`
 * modules only (package modules are read through typed virtual modules,
 * `x.svelte.js.__runic.ts`, frontend/package-modules.ts).
 */
const RUNE_FILES = /\.svelte(\.__runic\.ts|\.ts|\.js|\.js\.__runic\.ts)$/;

export class Classes {
  private readonly lower: Lowerer;
  private readonly bySymbol = new Map<ts.Symbol, ClassInfo>();
  private readonly byRecord = new Map<number, ClassInfo>();
  private readonly inProgress = new Set<number>();
  /** `f.bind(x)` wrappers by function type. */
  private readonly valueWrappers = new Map<string, number>();
  /** Bound-method functions by method and receiver type. */
  private readonly bound = new Map<string, number>();
  /** Subclass declarations by base class symbol (the program's sources). */
  private subclassIndex?: Map<ts.Symbol, ts.ClassDeclaration[]>;
  /** Type parameters of generic classes, bound to their instantiation's types. */
  private readonly typeArgs = new Map<ts.Symbol, Type>();
  /** The instantiation of each generic class. */
  private readonly instances = new Map<ts.ClassDeclaration, Instance>();

  constructor(lower: Lowerer) {
    this.lower = lower;
    lower.types.typeParameter = t => (t.symbol ? this.typeArgs.get(t.symbol) : undefined);
  }

  private fail(n: ts.Node, message: string): never {
    return this.lower.fail(n, 'E_CLASS', message);
  }

  private get records() {
    return this.lower.types.records;
  }

  /**
   * The rune `e` calls if it is a Svelte field rune (`$state`, `$state.raw`,
   * `$derived`, `$derived.by`, declared by the Svelte rune declarations of
   * Svelte programs) in a file Svelte compiles runes in. Other calls of
   * rune-like names in class fields are rejected.
   */
  private rune(e: ts.Expression | undefined): Rune | undefined {
    if (!e) return undefined;
    const call = skipParens(e);
    if (!ts.isCallExpression(call)) return undefined;
    const text = call.expression.getText();
    if (!RUNES.test(text)) return undefined;
    const id = ts.isPropertyAccessExpression(call.expression)
      ? call.expression.expression
      : call.expression;
    const decl = this.lower.checker.getSymbolAtLocation(id)?.declarations?.[0];
    // The runes Svelte declares (its package types, or the adapter's declarations).
    const declared =
      !!decl &&
      /(svelte-runes\.d\.ts|[\\/]node_modules[\\/]svelte[\\/].*\.d\.ts)$/.test(
        decl.getSourceFile().fileName,
      );
    if (!declared || !FIELD_RUNES.includes(text as Rune))
      return this.fail(
        call,
        `${text} in a class field is unsupported (the reactive fields are Svelte's $state, $state.raw, $derived and $derived.by)`,
      );
    if (!RUNE_FILES.test(call.getSourceFile().fileName))
      return this.fail(
        call,
        `${text}: Svelte compiles runes only in components and .svelte.js/.svelte.ts modules`,
      );
    return text as Rune;
  }

  // -------------------------------------------------------------------------
  // Types

  /** The exact class whose instances have IR record type `t`, if any. */
  of(t: Type | undefined): ClassInfo | undefined {
    return t !== undefined && typeof t === 'object' && 'record' in t
      ? this.byRecord.get(t.record)
      : undefined;
  }

  /** The classes a value of class type `t` (a class record or reference) can have; undefined for other types. */
  classesOf(t: Type | undefined): ClassInfo[] | undefined {
    if (t === undefined) return undefined;
    return concreteMembers(t, this.records)?.map(r => this.byRecord.get(r)!);
  }

  /**
   * Whether TypeScript types `e` as an instance of source classes (one, or
   * a union of them), not nullable; decided without mapping the type.
   */
  /**
   * Whether TypeScript types `e` as `any` or as instances of classes (also
   * as declared by a package's declaration files), null and undefined aside.
   */
  private untypedInstance(e: ts.Expression): boolean {
    const t = this.lower.checker.getTypeAtLocation(e);
    if (t.flags & ts.TypeFlags.Any) return true;
    const parts = (t.isUnion() ? t.types : [t]).filter(
      p => !(p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)),
    );
    return (
      parts.length > 0 &&
      parts.every(
        p => !!(p.flags & ts.TypeFlags.Object) && !!(p.symbol?.flags & ts.SymbolFlags.Class),
      )
    );
  }

  private tsClass(e: ts.Expression): boolean {
    const checker = this.lower.checker;
    let t = checker.getTypeAtLocation(e);
    if (t.flags & ts.TypeFlags.TypeParameter && (t as { isThisType?: boolean }).isThisType)
      t = checker.getBaseConstraintOfType(t) ?? t;
    // (A nullable instance: its class; null and undefined have none.)
    const parts = (t.isUnion() ? t.types : [t]).filter(
      p => !(p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)),
    );
    return (
      parts.length > 0 &&
      parts.every(p => {
        const sym = p.symbol;
        const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
        return (
          !!(p.flags & ts.TypeFlags.Object) &&
          !!sym &&
          !!(sym.flags & ts.SymbolFlags.Class) &&
          !p.getConstructSignatures().length &&
          !!decl &&
          !decl.getSourceFile().isDeclarationFile
        );
      })
    );
  }

  /**
   * Whether `t` is a class type: a class record or a class reference of
   * classes compiled from source (not a nominal built-in record such as
   * MutationObserver's).
   */
  isClass(t: Type | undefined): boolean {
    const members = t !== undefined ? classMembers(t, this.records) : undefined;
    return members !== undefined && members.every(r => this.byRecord.has(r));
  }

  /** The type of the instances of `info` and its subclasses. */
  selfType(info: ClassInfo): Type {
    return info.subclasses.length ? { class: info.record } : { record: info.record };
  }

  /** The IR type of class instance type `t` (TypeMapper hook). */
  typeOf(cls: ts.Symbol, t: ts.Type, at: ts.Node): Type {
    const info = this.layout(cls, at);
    const checker = this.lower.checker;
    const args = (t as ts.TypeReference).target
      ? checker.getTypeArguments(t as ts.TypeReference)
      : [];
    // A generic class: the instantiation the program uses (`instantiate`).
    info.decl.typeParameters?.forEach((p, i) => {
      const bound = this.typeArgs.get(checker.getSymbolAtLocation(p.name)!);
      const arg = args[i];
      if (
        !arg ||
        !bound ||
        (arg.flags & ts.TypeFlags.TypeParameter && arg.symbol?.declarations?.includes(p)) ||
        // (`unknown` the instantiation found holds nothing, `neverPassed`.)
        (arg.flags & ts.TypeFlags.Unknown && JSON.stringify(bound) === '{"maybe":"void"}')
      )
        return;
      const got = this.lower.types.map(arg, at);
      if (JSON.stringify(got) !== JSON.stringify(bound))
        this.fail(
          at,
          `${info.name} is used with ${p.name.text} = ${checker.typeToString(arg)} here and another type elsewhere; a generic class takes one instantiation per program`,
        );
    });
    return this.selfType(info);
  }

  /**
   * Bind the type parameters of generic class `decl` to the one
   * instantiation the program uses: the type arguments of its `new`
   * expressions and type references (inside the class, references to
   * itself with its own parameters do not count). Another instantiation is
   * rejected where it is written (specialisation per instantiation is not
   * implemented). A type parameter no member mentions (bits-ui's
   * `TooltipTether<Payload = never>`) types no value and is left unbound.
   */
  private instantiate(decl: ts.ClassDeclaration, sym: ts.Symbol) {
    const checker = this.lower.checker;
    const all = decl.typeParameters!;
    const own = new Set(all.map(p => checker.getSymbolAtLocation(p.name)));
    const mentioned = new Set<ts.Symbol>();
    const mentions = (n: ts.Node) => {
      if (ts.isIdentifier(n)) {
        const s = checker.getSymbolAtLocation(n);
        if (s && own.has(s)) mentioned.add(s);
      }
      ts.forEachChild(n, mentions);
    };
    decl.members.forEach(mentions);
    const used = all.flatMap((p, i) =>
      mentioned.has(checker.getSymbolAtLocation(p.name)!) ? [i] : [],
    );
    if (!used.length) return;
    const params = used.map(i => all[i]);
    const ofClass = (t: ts.Type) => t.symbol === sym && !!(t as ts.TypeReference).target;
    const sites: { node: ts.Node; type: ts.Type }[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n) || ts.isTypeReferenceNode(n) || ts.isImportTypeNode(n)) {
        const t = ts.isNewExpression(n)
          ? checker.getTypeAtLocation(n)
          : checker.getTypeFromTypeNode(n);
        if (ofClass(t)) {
          const args = checker.getTypeArguments(t as ts.TypeReference);
          if (!args.every(a => a.symbol && own.has(a.symbol))) sites.push({ node: n, type: t });
        }
      }
      ts.forEachChild(n, visit);
    };
    for (const sf of this.lower.program.getSourceFiles()) if (!sf.isDeclarationFile) visit(sf);
    if (!sites.length)
      this.fail(
        decl.name ?? decl,
        `Generic class ${sym.name} is never instantiated with type arguments`,
      );
    const mapped = sites.map(site =>
      used.map((u, i) => {
        const a = checker.getTypeArguments(site.type as ts.TypeReference)[u];
        // `unknown` (a default: bits-ui's `CustomEventDispatcher<T =
        // unknown>`) where no value of it is ever passed: it holds nothing.
        if (a.flags & ts.TypeFlags.Unknown && this.neverPassed(decl, params[i]))
          return { maybe: 'void' } as Type;
        if (a.flags & ts.TypeFlags.TypeParameter)
          this.fail(
            site.node,
            `${sym.name}<${params[i].name.text}> is instantiated with a type parameter; a generic class takes one concrete instantiation per program`,
          );
        return this.lower.types.map(a, site.node);
      }),
    );
    const first = JSON.stringify(mapped[0]);
    const other = mapped.findIndex(m => JSON.stringify(m) !== first);
    if (other >= 0)
      this.fail(
        sites[other].node,
        `${sym.name} is instantiated with ${checker.typeToString(sites[other].type)} here and ${checker.typeToString(sites[0].type)} elsewhere; a generic class takes one instantiation per program`,
      );
    params.forEach((p, i) => this.typeArgs.set(checker.getSymbolAtLocation(p.name)!, mapped[0][i]));
    const construct = sites.find(x => ts.isNewExpression(x.node))?.node as
      ts.NewExpression | undefined;
    this.instances.set(decl, { type: sites[0].type, ...(construct ? { construct } : {}) });
  }

  /**
   * Whether no call of the program passes a value (other than null or
   * undefined) for a parameter of `decl`'s methods or constructor declared
   * of exactly type parameter `tp` (bits-ui's `dispatch(element, detail?:
   * T)`, always called without `detail`), and no field is declared of it.
   */
  private neverPassed(decl: ts.ClassDeclaration, tp: ts.TypeParameterDeclaration): boolean {
    const checker = this.lower.checker;
    const exactly = (t: ts.TypeNode | undefined) =>
      !!t &&
      ts.isTypeReferenceNode(t) &&
      ts.isIdentifier(t.typeName) &&
      t.typeName.text === tp.name.text;
    const slots = new Map<ts.Node, number[]>();
    for (const m of decl.members) {
      if (ts.isPropertyDeclaration(m) && exactly(m.type)) return false;
      if (!(ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m))) continue;
      const at = m.parameters.flatMap((p, k) => (exactly(p.type) ? [k] : []));
      if (at.length) slots.set(m, at);
    }
    if (!slots.size) return false;
    let passed = false;
    // (Also one of these parameters passed on: `dispatch` forwards its
    // `detail` to `createEvent(detail)`.)
    const slotParams = new Set<ts.Node>(
      [...slots].flatMap(([m, at]) =>
        at.map(k => (m as ts.FunctionLikeDeclaration).parameters[k] as ts.Node),
      ),
    );
    const nothing = (e: ts.Expression) => {
      const x = skipParens(e);
      const d = ts.isIdentifier(x) ? checker.getSymbolAtLocation(x)?.valueDeclaration : undefined;
      return (
        x.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(x) && x.text === 'undefined') ||
        ts.isVoidExpression(x) ||
        (!!d && slotParams.has(d))
      );
    };
    const visit = (n: ts.Node) => {
      if (passed) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const target = checker.getResolvedSignature(n)?.declaration;
        const at = target && slots.get(target);
        if (at)
          for (const k of at) {
            const a = n.arguments?.[k];
            if (a && (ts.isSpreadElement(a) || !nothing(a))) passed = true;
          }
        // (A spread passes what it holds.)
        if (n.arguments?.some(ts.isSpreadElement) && at) passed = true;
      }
      ts.forEachChild(n, visit);
    };
    for (const sf of this.lower.program.getSourceFiles()) if (!sf.isDeclarationFile) visit(sf);
    return !passed;
  }

  /**
   * The parameter types of constructor or method `decl` of a generic class
   * in its instantiation, as TypeScript instantiates the signature (`...args:
   * Parameters<T> | []` resolved): one type per parameter, a tuple rest
   * parameter's items each.
   */
  private instanceParams(decl: ts.FunctionLikeDeclaration, info: ClassInfo): Type[] | undefined {
    const inst = this.instances.get(info.decl);
    if (!inst) return undefined;
    const checker = this.lower.checker;
    let sig: ts.Signature | undefined;
    if (ts.isConstructorDeclaration(decl))
      sig = inst.construct ? checker.getResolvedSignature(inst.construct) : undefined;
    else if (ts.isMethodDeclaration(decl)) {
      const prop = checker.getPropertiesOfType(inst.type).find(p => p.declarations?.includes(decl));
      sig = prop ? checker.getTypeOfSymbol(prop).getCallSignatures()[0] : undefined;
    }
    if (!sig) return undefined;
    return sig.parameters.flatMap((p, i) => {
      const t = checker.getTypeOfSymbol(p);
      const d = p.valueDeclaration;
      // A parameter declared of a type parameter the instantiation binds
      // (`detail?: T` with T holding nothing): the binding.
      const declared = decl.parameters[i]?.type;
      const bound =
        declared && ts.isTypeReferenceNode(declared) && ts.isIdentifier(declared.typeName)
          ? this.typeArgs.get(checker.getSymbolAtLocation(declared.typeName)!)
          : undefined;
      if (bound !== undefined && t.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) {
        const optional = !!decl.parameters[i].questionToken && !maybeInner(bound);
        return [optional ? { maybe: bound } : bound];
      }
      const items =
        d && ts.isParameter(d) && d.dotDotDotToken
          ? this.lower.types.restParams(t, decl)
          : undefined;
      return items ?? [this.lower.types.map(t, decl)];
    });
  }

  /** The IR type of a union of class instance types (TypeMapper hook). */
  unionOf(parts: ts.Type[], at: ts.Node): Type {
    return this.canonical(
      parts.map(p => {
        this.typeOf(p.symbol, p, at);
        return this.layout(p.symbol, at);
      }),
    );
  }

  /** The type of the instances of any of `classes` (and their subclasses). */
  private canonical(classes: ClassInfo[]): Type {
    const set = [...new Set(classes)];
    const roots = set.filter(c => !set.some(o => o !== c && this.extendsClass(c, o)));
    if (roots.length === 1) return this.selfType(roots[0]);
    return { classes: roots.map(c => c.record).sort((a, b) => a - b) };
  }

  private extendsClass(c: ClassInfo, base: ClassInfo): boolean {
    for (let x: ClassInfo | undefined = c; x; x = x.base) if (x === base) return true;
    return false;
  }

  private members(t: Type): number[] | undefined {
    return classMembers(t, this.records);
  }

  /**
   * `v` (of type `have`) where a value of type `want` is expected: a Maybe
   * wraps it, a class instance widens to a class reference (`upcast`).
   * Other values are returned as they are.
   */
  fit(v: Expr, have: Type, want: Type): Expr {
    return fitType(v, have, want, this.records);
  }

  /**
   * `fit` at `at`, where an array, set, map, promise or function of one
   * class type is used as one of another (it keeps its identity, so no
   * conversion exists): rejected.
   */
  fitAt(v: Expr, have: Type, want: Type, at: ts.Node): Expr {
    const out = this.fit(v, have, want);
    if (out === v && this.nestedMismatch(have, want))
      this.fail(
        at,
        'A collection or function of one class type is used as one of another class type; arrays, maps, sets and functions keep their identity, so create this one with the expected element types',
      );
    return out;
  }

  /** Whether `a` and `b` differ only in class types inside collections or functions. */
  private nestedMismatch(a: Type, b: Type, nested = false): boolean {
    if (JSON.stringify(a) === JSON.stringify(b)) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (this.isClass(a) && this.isClass(b)) return nested;
    const pair = <K extends string>(k: K) => k in a && k in b;
    if (pair('maybe'))
      return this.nestedMismatch(
        (a as { maybe: Type }).maybe,
        (b as { maybe: Type }).maybe,
        nested,
      );
    for (const k of ['array', 'set', 'promise'] as const)
      if (pair(k))
        return this.nestedMismatch(
          (a as Record<string, Type>)[k],
          (b as Record<string, Type>)[k],
          true,
        );
    if ('map' in a && 'map' in b)
      return (
        this.nestedMismatch(a.map[0], b.map[0], true) ||
        this.nestedMismatch(a.map[1], b.map[1], true)
      );
    if ('fn' in a && 'fn' in b)
      return (
        this.nestedMismatch(a.fn.result, b.fn.result, true) ||
        a.fn.params.some((p, i) => b.fn.params[i] && this.nestedMismatch(p, b.fn.params[i], true))
      );
    return false;
  }

  /** `v` of class type `have` as class type `want` (wider: upcast; narrower: downcast). */
  private convert(v: Expr, have: Type, want: Type, at: ts.Node): Expr {
    if (JSON.stringify(have) === JSON.stringify(want)) return v;
    const hm = this.members(maybeInner(have) ?? have);
    const wm = this.members(maybeInner(want) ?? want);
    if (hm && wm && hm.every(r => wm.includes(r))) return { op: 'upcast', value: v, type: want };
    if (hm && wm && wm.every(r => hm.includes(r))) return { op: 'downcast', value: v, type: want };
    return this.fail(
      at,
      `Internal: cannot convert ${JSON.stringify(have)} to ${JSON.stringify(want)}`,
    );
  }

  /**
   * `e` (of class type `have`, read where TypeScript narrowed it to `want`,
   * by `instanceof` or a discriminant): downcast to the narrower class type.
   */
  narrow(e: Expr, have: Type, want: Type | undefined): Expr {
    if (want === undefined || JSON.stringify(have) === JSON.stringify(want)) return e;
    const maybe = maybeInner(have) !== undefined;
    if (maybe !== (maybeInner(want) !== undefined)) return e;
    const hm = this.members(maybeInner(have) ?? have);
    const wm = this.members(maybeInner(want) ?? want);
    if (!hm || !wm || hm.length === 1 || !wm.every(r => hm.includes(r))) return e;
    return { op: 'downcast', value: e, type: want };
  }

  /** The common type of two class types (for `===`), if both are. */
  join(a: Type, b: Type): Type | undefined {
    const ai = maybeInner(a) ?? a;
    const bi = maybeInner(b) ?? b;
    const am = this.classesOf(ai);
    const bm = this.classesOf(bi);
    if (!am || !bm || !this.isClass(ai) || !this.isClass(bi)) return undefined;
    const roots = (t: Type) => {
      if (typeof t === 'object' && 'classes' in t) return t.classes.map(r => this.byRecord.get(r)!);
      const r = typeof t === 'object' && 'class' in t ? t.class : (t as { record: number }).record;
      return [this.byRecord.get(r)!];
    };
    const joined = this.canonical([...roots(ai), ...roots(bi)]);
    return maybeInner(a) !== undefined || maybeInner(b) !== undefined ? { maybe: joined } : joined;
  }

  // -------------------------------------------------------------------------
  // Declarations

  /** Direct subclass declarations of the class `sym` among the program's sources. */
  /**
   * Whether the constructor assigns `this.name` at its top level after
   * super(…) and before any other statement uses `this`.
   */
  private reassigned(name: string, ctor: ts.ConstructorDeclaration | undefined): boolean {
    const statements = ctor?.body?.statements ?? [];
    const sup = statements.findIndex(
      s =>
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        s.expression.expression.kind === ts.SyntaxKind.SuperKeyword,
    );
    for (const s of statements.slice(sup + 1)) {
      const target = thisAssignment(s);
      if (target?.name.text === name) return true;
      let usesThis = false;
      const visit = (n: ts.Node) => {
        if (n.kind === ts.SyntaxKind.ThisKeyword) usesThis = true;
        ts.forEachChild(n, visit);
      };
      visit(s);
      if (usesThis) return false;
    }
    return false;
  }

  /**
   * Whether the field declaration `decl` of the class `info` (extending
   * `base`), with an initialiser, declares again a plain data field of a
   * base class that can take its value: no rune initialises either, no
   * class of the chain has an accessor or method of the name, and the base
   * field's type accepts the initialiser's. JavaScript then defines the
   * field again after super(…) returns ([[Define]]), which, on an own
   * writable data property, is setting it ([[Set]]): the base's field,
   * assigned at that point.
   */
  private fieldOverride(decl: ts.PropertyDeclaration, info: ClassInfo, base: ClassInfo): boolean {
    const checker = this.lower.checker;
    const name = memberName(decl.name);
    const init = decl.initializer!;
    const inner = skipParens(init);
    if (
      this.rune(init) ||
      (ts.isCallExpression(inner) && RUNES.test(inner.expression.getText())) ||
      decl.questionToken ||
      decl.exclamationToken ||
      info.members.has(name)
    )
      return false;
    let field: Field | undefined;
    for (let b: ClassInfo | undefined = base; b; b = b.base) {
      if (b.members.has(name)) return false;
      field ??= b.own.find(f => f.name === name);
    }
    // (A host field holds its host object, not its initialiser's value.)
    if (
      !field ||
      field.param ||
      field.rune ||
      (field.decl && this.hostFieldOf(field.decl)) ||
      this.hostFieldOf(decl)
    )
      return false;
    let declared: ts.Type;
    if (field.decl) declared = this.declaredType(field.decl);
    else {
      const id = ts.isPropertyAccessExpression(field.node) ? field.node.name : field.node;
      const sym = checker.getSymbolAtLocation(id);
      if (!sym) return false;
      declared = checker.getTypeOfSymbolAtLocation(sym, field.node);
    }
    if (declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    return checker.isTypeAssignableTo(checker.getTypeAtLocation(init), declared);
  }

  private subclassDecls(sym: ts.Symbol): ts.ClassDeclaration[] {
    if (!this.subclassIndex) {
      const index = new Map<ts.Symbol, ts.ClassDeclaration[]>();
      for (const sf of this.lower.program.getSourceFiles()) {
        // Package modules compiled from source are typed virtual modules.
        if (
          sf.isDeclarationFile ||
          (/[\\/]node_modules[\\/]/.test(sf.fileName) && !sf.fileName.endsWith('.__runic.ts'))
        )
          continue;
        for (const s of sf.statements) {
          if (!ts.isClassDeclaration(s) || !s.name) continue;
          const base = this.baseExpression(s);
          if (!base || !ts.isIdentifier(base)) continue;
          const b = this.lower.symbol(base);
          if (!b) continue;
          index.set(b, [...(index.get(b) ?? []), s]);
        }
      }
      this.subclassIndex = index;
    }
    return this.subclassIndex.get(sym) ?? [];
  }

  private baseExpression(decl: ts.ClassDeclaration): ts.Expression | undefined {
    const h = decl.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    return h?.types[0]?.expression;
  }

  /** The class declaration `decl` extends, checked: a class compiled from source. */
  private baseDecl(decl: ts.ClassDeclaration): ts.ClassDeclaration | undefined {
    const h = decl.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    if (!h) return undefined;
    const type = h.types[0];
    if (type.typeArguments?.length)
      this.fail(type, 'Extending a generic class is planned for later');
    const e = type.expression;
    if (!ts.isIdentifier(e))
      this.fail(e, 'extends needs a class name (mixins and other expressions are unsupported)');
    const sym = this.lower.symbol(e);
    if (sym?.declarations?.some(d => d.getSourceFile().isDeclarationFile))
      return this.fail(
        e,
        `${e.getText()} is a library class; extending library classes is unsupported (mapping packs will provide them)`,
      );
    const base = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!base || !ts.isClassDeclaration(base))
      return this.fail(
        e,
        `${e.getText()} is not a class declaration (class expressions are unsupported)`,
      );
    return base;
  }

  private layout(sym: ts.Symbol, at: ts.Node): ClassInfo {
    const known = this.bySymbol.get(sym);
    if (known) return known;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl || !ts.isClassDeclaration(decl))
      return this.fail(at, `${sym.name}: class expressions are unsupported (declare the class)`);
    // A package's declaration of a class compiled from source: its implementation.
    const impl = decl.getSourceFile().isDeclarationFile
      ? this.lower.implementation?.(sym)
      : undefined;
    if (impl && impl !== sym) {
      const info = this.layout(impl, at);
      this.bySymbol.set(sym, info);
      return info;
    }
    if (decl.getSourceFile().isDeclarationFile)
      return this.fail(
        at,
        `${sym.name} is a library class; its instances are unsupported (only classes compiled from source are)`,
      );
    // A hierarchy is laid out as a whole, from its root down.
    let root = decl;
    const seen = new Set<ts.ClassDeclaration>([decl]);
    for (let b = this.baseDecl(root); b; b = this.baseDecl(root)) {
      if (seen.has(b)) return this.fail(at, `${sym.name}: its base classes form a cycle`);
      seen.add(b);
      root = b;
    }
    const infos: ClassInfo[] = [];
    const visit = (d: ts.ClassDeclaration, base?: ClassInfo) => {
      const s = d === decl ? sym : this.lower.checker.getSymbolAtLocation(d.name!)!;
      const info = this.declareShape(d, s, base);
      infos.push(info);
      for (const sub of this.subclassDecls(s)) visit(sub, info);
    };
    visit(root);
    // Fields declared again with other options types (`opts`): one record
    // for all of the declared types (frontend/types.ts `mergeRecords`).
    for (const info of infos)
      for (const decl of info.redeclared ?? []) {
        const name = memberName(decl.name);
        const declared: ts.Type[] = [];
        for (const x of infos) {
          const f = x.own.find(o => o.name === name && o.decl);
          if (f?.decl) declared.push(this.declaredType(f.decl));
          for (const r of x.redeclared ?? [])
            if (memberName(r.name) === name) declared.push(this.declaredType(r));
          // A constructor parameter passed on to the base constructor that
          // sets the field (bits-ui's AccordionMultiState keeps `opts` as
          // its base sets it): its type shares the record too.
          const forwarded = this.forwardedTo(x, name);
          if (forwarded) declared.push(this.lower.checker.getTypeAtLocation(forwarded));
        }
        if (!this.lower.types.mergeRecords(declared, decl))
          this.fail(
            decl,
            `${info.name} declares the field ${name} again with a type that cannot share its base's record`,
          );
      }
    // Fields are typed once every class of the hierarchy has its record.
    for (const info of infos) for (const f of info.own) f.type = this.fieldType(f, info);
    for (const info of infos) this.assemble(info);
    return this.bySymbol.get(sym)!;
  }

  /** Register class `decl` (extending `base`): its record, members and own field names. */
  private declareShape(
    decl: ts.ClassDeclaration,
    sym: ts.Symbol,
    base: ClassInfo | undefined,
  ): ClassInfo {
    this.check(decl);
    if (decl.typeParameters?.length) this.instantiate(decl, sym);
    const types = this.lower.types;
    const record = types.records.length;
    // Registered before the fields are typed, so recursive types terminate.
    types.records.push({ name: sym.name, fields: [], class: true });
    if (base) types.records[record].extends = base.record;
    const abstract = modifier(decl, ts.SyntaxKind.AbstractKeyword);
    if (abstract) types.records[record].abstract = true;
    const ctor = decl.members.find(
      (m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body,
    );
    const info: ClassInfo = {
      name: sym.name,
      decl,
      symbol: sym,
      record,
      ...(base ? { base } : {}),
      subclasses: [],
      abstract,
      own: [],
      fields: [],
      members: new Map(),
      statics: new Map(),
      ...(ctor ? { ctor } : {}),
      declared: false,
      rawThis: false,
    };
    base?.subclasses.push(info);
    this.bySymbol.set(sym, info);
    this.byRecord.set(record, info);
    // Methods and accessors.
    for (const m of decl.members) {
      if (isStatic(m)) continue;
      if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
        const name = memberName(m.name!);
        const entry = info.members.get(name) ?? {};
        if (modifier(m, ts.SyntaxKind.AbstractKeyword)) entry.abstract = m;
        else {
          const callable: Callable = { decl: m, name: `${sym.name}.${name}` };
          if (ts.isMethodDeclaration(m)) entry.method = callable;
          else if (ts.isGetAccessor(m))
            entry.get = { ...callable, name: `${sym.name}.get ${name}` };
          else entry.set = { ...callable, name: `${sym.name}.set ${name}` };
        }
        info.members.set(name, entry);
      } else if (ts.isPropertyDeclaration(m) && modifier(m, ts.SyntaxKind.AbstractKeyword))
        info.members.set(memberName(m.name), { abstract: m });
    }
    // A name the base classes give a field or a member (abstract properties
    // are implemented by the subclasses' fields).
    const inherited = (name: string) => {
      if (name.startsWith('#')) return false;
      for (let b = base; b; b = b.base) {
        const m = b.members.get(name);
        if (b.own.some(f => f.name === name) || m?.method || m?.get || m?.set) return true;
      }
      return false;
    };
    const inheritedField = (name: string) => {
      if (name.startsWith('#')) return false;
      for (let b = base; b; b = b.base) if (b.own.some(f => f.name === name)) return true;
      return false;
    };
    // Fields: parameter properties, declarations, then fields the
    // constructor creates by assignment (the instance's own properties in
    // order; their order is not observable, as keys and spreads of
    // instances are rejected).
    const fields: Field[] = [];
    const add = (f: Omit<Field, 'type' | 'owner' | 'key'>) => {
      if (fields.some(x => x.name === f.name)) return;
      // A field declared again without an initialiser and assigned at the top
      // level of the constructor before it is read: JavaScript sets it to
      // undefined after super(…) and then to the assigned value, which is all
      // anything can see. It stays the base's field.
      if (
        inheritedField(f.name) &&
        f.decl &&
        !f.decl.initializer &&
        this.reassigned(f.name, ctor)
      ) {
        (info.redeclared ??= []).push(f.decl);
        return;
      }
      if (
        inheritedField(f.name) &&
        !f.param &&
        f.decl?.initializer &&
        this.fieldOverride(f.decl, info, base!)
      ) {
        (info.overrides ??= []).push(f.decl);
        return;
      }
      if (inheritedField(f.name) && (f.param || f.decl))
        this.fail(
          f.node,
          `${sym.name} redeclares the field ${f.name} of a base class; assign it in the constructor instead`,
        );
      if (inherited(f.name)) return;
      fields.push({ ...f, type: 'void', owner: info, key: f.name });
    };
    for (const p of ctor?.parameters ?? [])
      if (ts.isParameterPropertyDeclaration(p, ctor!)) {
        if (!ts.isIdentifier(p.name)) this.fail(p, 'Parameter properties are plain names');
        add({ name: (p.name as ts.Identifier).text, node: p, param: p });
      }
    for (const m of decl.members)
      if (
        ts.isPropertyDeclaration(m) &&
        !isStatic(m) &&
        !modifier(m, ts.SyntaxKind.AbstractKeyword)
      )
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
    // Reactive fields (M6 stage B): a rune initialising a field declaration
    // or assigned to a field at the top level of the constructor (Svelte
    // rejects other placements, and a second declaration, when it compiles).
    for (const m of decl.members)
      if (ts.isPropertyDeclaration(m) && !isStatic(m)) {
        const kind = this.rune(m.initializer);
        const field = fields.find(f => f.decl === m);
        if (kind && field)
          field.rune = {
            kind,
            call: skipParens(m.initializer!) as ts.CallExpression,
            container: m,
          };
      } else if (isStatic(m) && ts.isPropertyDeclaration(m) && this.rune(m.initializer))
        this.fail(m, 'Static reactive fields are unsupported (Svelte rejects them)');
    for (const s of ctor?.body?.statements ?? []) {
      const target = thisAssignment(s);
      if (!target) continue;
      const rhs = ((s as ts.ExpressionStatement).expression as ts.BinaryExpression).right;
      const kind = this.rune(rhs);
      const field = fields.find(f => f.name === target.name.text);
      if (kind && field) {
        if (field.rune || field.decl?.initializer)
          this.fail(s, `${target.name.text} has already been declared on this class`);
        field.rune = { kind, call: skipParens(rhs) as ts.CallExpression, container: ctor! };
      }
    }
    info.own = fields;
    return info;
  }

  /** The record of `info`: its base's fields, then its own (typed). */
  private assemble(info: ClassInfo) {
    const base = info.base?.fields ?? [];
    const keys = new Set(base.map(f => f.key));
    for (const f of info.own) {
      // A private name a base class also declares: qualified by the class.
      let key = f.name;
      for (let n = 1; keys.has(key); n++) key = `${info.name}${f.name}${n > 1 ? `$${n}` : ''}`;
      f.key = key;
      keys.add(key);
    }
    info.fields = [...base, ...info.own];
    this.lateFields(info);
    this.records[info.record].fields = info.fields.map(f => ({
      name: f.key,
      type: f.type,
      ...(f.rune ? { reactive: reactiveKind(f.rune.kind) } : {}),
    }));
    info.rawThis = this.capturesThis(info) || !!info.base?.rawThis;
  }

  /**
   * Fields the constructor sets only after the instance exists (bits-ui's
   * `this.contentPresence = new PresenceManager({ ref: boxWith(() =>
   * this.contentNode) })`): an own field of `info` without initialiser, not
   * set by the leading statements that run before the record is built (see
   * `constructorBody`, whose steps 2 and 3 this follows over the chain: the
   * record must be built in `info`'s own constructor, after its `super(…)`),
   * assigned by a statement at the constructor's top level afterwards, and
   * not read until then. JavaScript holds `undefined` there meanwhile; the
   * field is stored as a nullable value, undefined until that statement,
   * and reads unwrap it. The statements before the assignment (and its
   * value) must not use `this` other than to read or write other fields
   * that hold no functions (nor `super`), so no method, accessor or function
   * given `this` can observe the field early.
   */
  /**
   * A closure passed to a registration that runs it after the code creating
   * it: `$effect(fn)`, svelte-toolbelt's `onMountEffect(fn)`, and the
   * callback of its `attachRef(ref, fn)` (run when the attachment runs, at
   * the element's mount).
   */
  private deferredClosure(n: ts.Node): boolean {
    if (!(ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return false;
    const call = n.parent;
    if (!ts.isCallExpression(call)) return false;
    const at = call.arguments.indexOf(n as ts.Expression);
    const callee = skipParens(call.expression);
    if (callee.getText() === '$effect') return at === 0;
    const position: Record<string, number> = { onMountEffect: 0, attachRef: 1 };
    if (!ts.isIdentifier(callee) || position[callee.text] !== at) return false;
    const decl = this.lower.checker.getSymbolAtLocation(callee)?.declarations?.[0];
    return (
      !!decl &&
      ts.isImportSpecifier(decl) &&
      ts.isStringLiteral(decl.parent.parent.parent.moduleSpecifier) &&
      decl.parent.parent.parent.moduleSpecifier.text === 'svelte-toolbelt'
    );
  }

  /** `this` stored in a plain (not accessor) property: `a.b = this`. */
  private storedInPlainField(n: ts.Node): boolean {
    const p = n.parent;
    if (
      !ts.isBinaryExpression(p) ||
      p.right !== n ||
      p.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    )
      return false;
    const left = skipParens(p.left);
    if (!ts.isPropertyAccessExpression(left)) return false;
    const decls = this.lower.checker.getSymbolAtLocation(left.name)?.declarations ?? [];
    return (
      decls.length > 0 && decls.every(d => ts.isPropertyDeclaration(d) || ts.isPropertySignature(d))
    );
  }

  /**
   * Whether every read of field `f` in the program (other than the
   * assignment `assigned`) reads a member of its value or calls it
   * (`this.f.x`, `this.f.m()`, `this.f()`, not through `?.`): before it
   * is set, such a read throws a
   * TypeError in JavaScript, as reading the late field's undefined does
   * (bits-ui's MenuContentState `rovingFocusGroup`, set after the
   * constructor has passed closures to other classes).
   */
  private onlyDereferenced(f: Field, assigned: ts.PropertyAccessExpression): boolean {
    const checker = this.lower.checker;
    const name = f.decl?.name ?? (ts.isPropertyAccessExpression(f.node) ? f.node.name : undefined);
    const sym = name && checker.getSymbolAtLocation(name);
    if (!sym) return false;
    let ok = true;
    const visit = (n: ts.Node) => {
      if (!ok) return;
      if (ts.isPropertyAccessExpression(n) && n !== assigned && n.name.text === f.name) {
        const s = checker.getSymbolAtLocation(n.name);
        if (s === sym) {
          const p = n.parent;
          const member =
            (ts.isPropertyAccessExpression(p) ||
              ts.isElementAccessExpression(p) ||
              ts.isCallExpression(p)) &&
            p.expression === n &&
            !p.questionDotToken;
          if (!member) ok = false;
        }
      }
      ts.forEachChild(n, visit);
    };
    for (const sf of this.lower.program.getSourceFiles()) if (!sf.isDeclarationFile) visit(sf);
    return ok;
  }

  private lateFields(info: ClassInfo) {
    /** Fields set before the record is built (`constructorBody`'s temporaries). */
    const temps = new Map<Field, number>();
    let statements: readonly ts.Statement[] = [];
    let i = 0;
    for (const x of this.chain(info)) {
      for (const f of x.own) if (f.param || (f.decl?.initializer && !isDerived(f))) temps.set(f, 0);
      const all = x.ctor?.body?.statements ?? [];
      const sc = x.base ? all.findIndex(s => superCallStatement(s)) : -1;
      if (x.base && x.ctor && sc < 0) return; // rejected when the constructor is lowered
      statements = all.slice(sc + 1);
      for (i = 0; i < statements.length; i++) {
        const s = statements[i];
        const target = thisAssignment(s);
        const field = target && this.fieldNamed(info, target.name);
        if (target && field) {
          const rhs = ((s as ts.ExpressionStatement).expression as ts.BinaryExpression).right;
          if (field.rune && skipParens(rhs) === field.rune.call) {
            if (isDerived(field)) continue;
            const arg = field.rune.call.arguments[0];
            if (arg && !this.earlyForm(arg, info, temps)) break;
          } else if (!this.earlyForm(rhs, info, temps)) break;
          temps.set(field, 0);
          continue;
        }
        if (mentionsThis(s)) break;
      }
      if (i < statements.length) {
        // The record is built in a base constructor: `info` declares no
        // fields (`constructorBody` rejects them otherwise).
        if (x !== info) return;
        break;
      }
    }
    if (i >= statements.length) return;
    const fnType = (t: Type | undefined) => typeof t === 'object' && 'fn' in t;
    /** Whether `name` is a method or accessor of `info` or a base class. */
    const member = (name: ts.MemberName) => {
      if (ts.isPrivateIdentifier(name)) return !!this.privateOwner(name)?.members.has(name.text);
      for (let x: ClassInfo | undefined = info; x; x = x.base)
        if (x.members.has(name.text)) return true;
      return false;
    };
    for (const f of info.own) {
      if (temps.has(f) || f.rune || maybeInner(f.type) || f.type === 'void') continue;
      const j = statements.findIndex((s, k) => {
        const target = k >= i ? thisAssignment(s) : undefined;
        return !!target && this.fieldNamed(info, target.name) === f;
      });
      if (j < 0) continue;
      const assigned = thisAssignment(statements[j]);
      // `this` in the window may only reach other fields, be stored in a
      // plain field of another object (bits-ui's `this.tether.root = this`:
      // no code runs), or be captured by a closure an effect registration
      // runs after the constructor (svelte-toolbelt's `onMountEffect`).
      let safe = true;
      const visit = (n: ts.Node) => {
        if (!safe) return;
        if (this.deferredClosure(n)) return;
        if (n.kind === ts.SyntaxKind.SuperKeyword) safe = false;
        if (n.kind === ts.SyntaxKind.ThisKeyword) {
          const p = n.parent;
          if (this.storedInPlainField(n)) {
            ts.forEachChild(n, visit);
            return;
          }
          const other =
            ts.isPropertyAccessExpression(p) && p.expression === n
              ? this.fieldNamed(info, p.name)
              : undefined;
          const ok =
            !!other &&
            other !== f &&
            (!isDerived(other) || !this.derivedReaches(info, other, f, new Set())) &&
            !fnType(other.type) &&
            !fnType(maybeInner(other.type)) &&
            !member((p as ts.PropertyAccessExpression).name);
          if (!ok && p !== assigned) safe = false;
        }
        ts.forEachChild(n, visit);
      };
      for (let k = i; k <= j; k++) visit(statements[k]);
      if (!safe && !this.onlyDereferenced(f, assigned!)) continue;
      f.late = true;
      f.type = { maybe: f.type };
    }
  }

  /**
   * Whether the derived field `d` may read the field `f` through `this`: its
   * initialiser names `this.f`, calls a method or accessor of `this`, or
   * reads another derived field that may (bits-ui's AccordionItemState reads
   * `this.isActive`, which reads `this.root` and `this.opts`, while
   * constructing the `contentPresence` it sets).
   */
  private derivedReaches(info: ClassInfo, d: Field, f: Field, seen: Set<Field>): boolean {
    if (seen.has(d)) return false;
    seen.add(d);
    const init = d.decl?.initializer;
    if (!init) return true;
    let reaches = false;
    const visit = (n: ts.Node) => {
      if (reaches) return;
      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        const p = n.parent;
        if (!ts.isPropertyAccessExpression(p) || p.expression !== n) reaches = true;
        else {
          const other = this.fieldNamed(info, p.name);
          if (!other) reaches = true;
          else if (other === f) reaches = true;
          else if (isDerived(other) && this.derivedReaches(info, other, f, seen)) reaches = true;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(init);
    return reaches;
  }

  /** Structural checks: what the class lowering supports. */
  private check(decl: ts.ClassDeclaration) {
    if (ts.getDecorators(decl)?.length) this.fail(decl, 'Decorators are unsupported');
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
      const abstract = modifier(m, ts.SyntaxKind.AbstractKeyword);
      if (abstract && !modifier(decl, ts.SyntaxKind.AbstractKeyword))
        this.fail(m, 'Abstract members belong to abstract classes');
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
        if (!m.body && !abstract) this.fail(m, 'Method overloads are unsupported');
        if (m.asteriskToken) this.fail(m, 'Generator methods are unsupported');
      }
      if ((ts.isGetAccessor(m) || ts.isSetAccessor(m)) && isStatic(m))
        this.fail(m, 'Static accessors are unsupported');
      if ((ts.isGetAccessor(m) || ts.isSetAccessor(m)) && abstract)
        this.fail(m, 'Abstract accessors are unsupported (declare an abstract property)');
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

  /**
   * The parameter of `info`'s constructor that its top-level `super(…)`
   * passes on to a base constructor setting `this.name` to it (directly or
   * passing it on again), if any.
   */
  private forwardedTo(info: ClassInfo, name: string): ts.ParameterDeclaration | undefined {
    const sets = (x: ClassInfo | undefined, index: number): boolean => {
      const ctor = x?.ctor;
      const p = ctor?.parameters[index];
      if (!x || !ctor || !p || !ts.isIdentifier(p.name)) return false;
      const own = (p.name as ts.Identifier).text;
      for (const s of ctor.body?.statements ?? []) {
        const target = thisAssignment(s);
        if (target?.name.text === name) {
          const value = skipParens(
            ((s as ts.ExpressionStatement).expression as ts.BinaryExpression).right,
          );
          if (ts.isIdentifier(value) && value.text === own) return true;
        }
        const i = superArgIndex(s, own);
        if (i !== undefined && sets(x.base && this.explicitOwner(x.base), i)) return true;
      }
      return false;
    };
    const ctor = info.ctor;
    if (!ctor || !info.base) return undefined;
    for (const s of ctor.body?.statements ?? [])
      for (const p of ctor.parameters) {
        if (!ts.isIdentifier(p.name)) continue;
        const i = superArgIndex(s, p.name.text);
        if (i !== undefined && sets(this.explicitOwner(info.base), i)) return p;
      }
    return undefined;
  }

  /** The nearest of `info` and its base classes with a declared constructor. */
  private explicitOwner(info: ClassInfo | undefined): ClassInfo | undefined {
    for (let x = info; x; x = x.base) if (x.ctor) return x;
    return undefined;
  }

  /** The TypeScript type a field declaration gives. */
  private declaredType(decl: ts.PropertyDeclaration): ts.Type {
    const checker = this.lower.checker;
    const sym = checker.getSymbolAtLocation(decl.name);
    return sym ? checker.getTypeOfSymbolAtLocation(sym, decl) : checker.getTypeAtLocation(decl);
  }

  /**
   * An arrow function whose one parameter is an array pattern of a tuple
   * (bits-ui's `#updateDimensions = ([_, node]) => …`, an effect of runed's
   * `watch` over several sources): a function of the tuple's elements, one
   * parameter each (runed's pack calls it so).
   */
  private tupleArrow(e: ts.Expression | undefined): ts.ArrowFunction | undefined {
    const inner = e && skipParens(e);
    if (!inner || !ts.isArrowFunction(inner) || inner.parameters.length !== 1) return undefined;
    const p = inner.parameters[0];
    if (!ts.isArrayBindingPattern(p.name)) return undefined;
    return this.lower.checker.isTupleType(this.lower.checker.getTypeAtLocation(p))
      ? inner
      : undefined;
  }

  /** Host fields by declaration (`hostFieldOf`), null for other fields. */
  private readonly hostFields = new Map<ts.PropertyDeclaration, 'document' | 'window' | null>();

  /**
   * A field holding the document or the window once the class assigns it
   * (bits-ui's `#documentObj = undefined`, assigned
   * `getOwnerDocument(this.opts.ref.current)` in an effect): initialised to
   * undefined or null, and assigned only that host object (a name for it
   * that reading has no effect for, `Lowerer.hostName`) or undefined or
   * null. Its value is whether it holds the object (a boolean); listening
   * to it throws a TypeError while it does not (svelte/events' `on`).
   */
  hostFieldOf(decl: ts.PropertyDeclaration): 'document' | 'window' | undefined {
    const known = this.hostFields.get(decl);
    if (known !== undefined) return known ?? undefined;
    this.hostFields.set(decl, null);
    const nothing = (x: ts.Expression | undefined) => {
      if (!x) return false;
      x = skipParens(x);
      return x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined');
    };
    const cls = decl.parent;
    if (!ts.isClassDeclaration(cls) || isStatic(decl) || !nothing(decl.initializer))
      return undefined;
    const name = decl.name.getText();
    let host: string | undefined;
    let other = false;
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        n.left.name.getText() === name
      ) {
        if (n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) other = true;
        else if (!nothing(n.right)) {
          const h = this.lower.hostName(n.right);
          if (!h || (host !== undefined && h !== host)) other = true;
          host = h;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(cls);
    const out = !other && (host === 'document' || host === 'window') ? host : undefined;
    this.hostFields.set(decl, out ?? null);
    return out;
  }

  /** `this.f` of a host field (`hostFieldOf`). */
  hostField(e: ts.Expression): 'document' | 'window' | undefined {
    e = skipParens(e);
    if (!ts.isPropertyAccessExpression(e) || e.expression.kind !== ts.SyntaxKind.ThisKeyword)
      return undefined;
    const decl = this.lower.checker.getSymbolAtLocation(e.name)?.valueDeclaration;
    return decl && ts.isPropertyDeclaration(decl) ? this.hostFieldOf(decl) : undefined;
  }

  private fieldType(f: Field, info: ClassInfo): Type {
    const checker = this.lower.checker;
    if (f.decl && ts.isPropertyDeclaration(f.decl) && this.hostFieldOf(f.decl)) return 'boolean';
    const arrow = this.tupleArrow(f.decl?.initializer);
    if (arrow) {
      const tuple = checker.getTypeAtLocation(arrow.parameters[0]) as ts.TypeReference;
      const sig = checker.getSignatureFromDeclaration(arrow)!;
      return {
        fn: {
          params: checker.getTypeArguments(tuple).map(t => this.lower.types.map(t, arrow)),
          result: this.lower.types.map(sig.getReturnType(), arrow),
        },
      };
    }
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
    // A field typed as a function with `any` in it (svelte/elements'
    // `MouseEventHandler`, whose result is `any`): the type of the functions
    // given to it (its initialiser, assignments).
    const named = f.decl ? f.decl.name : f.param ? undefined : f.node;
    const given = named && this.lower.types.givenFunction(named);
    if (given) t = given;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      this.fail(
        f.node,
        `Field ${info.name}.${f.name} needs a type (a TypeScript annotation, or a JSDoc @type in JavaScript)`,
      );
    // A field only ever null (untyped JavaScript that never sets it, bits-ui's
    // PopoverTriggerState.#closeTimeout): a nullable number, as an untyped
    // `null` is; code reading it as a value is unreachable.
    if (t.flags & ts.TypeFlags.Null) return { maybe: 'number' };
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

  /** The classes from the root of `info`'s hierarchy down to `info`. */
  private chain(info: ClassInfo): ClassInfo[] {
    const out: ClassInfo[] = [];
    for (let x: ClassInfo | undefined = info; x; x = x.base) out.unshift(x);
    return out;
  }

  /** The nearest declared constructor of `info` or its base classes. */
  private explicitCtor(info: ClassInfo | undefined): ts.ConstructorDeclaration | undefined {
    for (let x = info; x; x = x.base) if (x.ctor) return x.ctor;
    return undefined;
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
    // Classes of package modules are declared when first used; a base
    // declared above in the module first, its members lowered once this
    // class is declared too (they may dispatch over it).
    const basePending: (() => void)[] = [];
    if (info.base) {
      if (
        !info.base.declared &&
        component === undefined &&
        decl.getSourceFile().fileName.includes('/node_modules/') &&
        info.base.decl.getSourceFile() === decl.getSourceFile() &&
        info.base.decl.end <= decl.pos
      )
        basePending.push(...this.declare(info.base.decl, undefined));
      if (!info.base.declared)
        this.fail(
          this.baseExpression(decl)!,
          `${info.base.name} must be declared before ${info.name} (classes are not hoisted)`,
        );
      if (info.base.component !== component)
        this.fail(
          this.baseExpression(decl)!,
          `${info.name} and its base class ${info.base.name} must be declared in the same module or component script`,
        );
    }
    info.declared = true;
    if (component !== undefined) info.component = component;
    lower.bindings.set(sym, { kind: 'class', cls: info });
    const self = this.selfType(info);
    const pending: (() => void)[] = [];
    // The constructor (abstract classes are never constructed).
    if (!info.abstract) {
      const ctor = this.explicitCtor(info);
      if (ctor) {
        const c = this.callable(ctor, `${info.name}.constructor`, info, false);
        info.construct = c;
        if (c.fn !== undefined) pending.push(() => this.lowerConstructor(info, c.fn!, c.params));
      } else {
        const fn = lower.reserve();
        lower.functions[fn] = this.placeholder(`${info.name}.constructor`, info, [], {
          record: info.record,
        });
        info.construct = { fn };
        pending.push(() => this.lowerConstructor(info, fn));
      }
    }
    // Derived fields: functions of the instance, computed when read (M6 stage B).
    for (const f of info.own) {
      if (!isDerived(f)) continue;
      const fn = lower.reserve();
      f.derived = fn;
      // Subclass records share the field (and its function).
      for (const x of this.subtree(info)) {
        const i = x.fields.indexOf(f);
        this.records[x.record].fields[i].derived = fn;
      }
      lower.functions[fn] = this.placeholder(
        `${info.name}.${f.name}$derived`,
        info,
        [{ name: 'this', type: self }],
        f.type,
      );
      pending.push(() => this.lowerDeferrable(info, f, fn));
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
            lower.function(c.decl, c.name, undefined, info.component, typed.fn, typed.params, {
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
        const assigned =
          !modifier(m, ts.SyntaxKind.ReadonlyKeyword) && this.assignedStatic(info, name);
        if (!m.initializer || assigned) {
          // A static field the class assigns: a global record of its value
          // (undefined until assigned, without an initialiser).
          const declared = lower.types.typeOrUndefined(m.name);
          if (declared === undefined)
            this.fail(m, 'Static fields need an initialiser or a declared type');
          const type: Type =
            m.initializer || maybeInner(declared!) ? declared! : { maybe: declared! };
          const record = lower.types.records.length;
          lower.types.records.push({
            name: `${info.name}.${name}`,
            class: true,
            fields: [{ name: 'value', type }],
          });
          const global = lower.globals.length;
          lower.globals.push({
            name: `${info.name}.${name}`,
            type: { record },
            init: {
              op: 'record',
              record,
              fields: [{ op: 'undefined', type: maybeInner(type) ? type : { maybe: type } }],
            },
          });
          info.statics.set(name, { kind: 'cell', global, type, decl: m });
          if (m.initializer)
            pending.push(() => {
              lower.globals[global].init = {
                op: 'record',
                record,
                fields: [lower.value(m.initializer!, undefined, `${info.name}.${name}`)],
              };
            });
          else if (!maybeInner(type)) this.fail(m, 'Static fields need an initialiser');
          continue;
        }
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
    return [...basePending, ...pending];
  }

  /** `info` and every class below it. */
  private subtree(info: ClassInfo): ClassInfo[] {
    return [info, ...info.subclasses.flatMap(s => this.subtree(s))];
  }

  /** Whether code assigns static field `name` of `info` (`C.name = …`, `C.name++`). */
  private assignedStatic(info: ClassInfo, name: string): boolean {
    let found = false;
    const visit = (n: ts.Node) => {
      const K = ts.SyntaxKind;
      const target =
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= K.FirstAssignment &&
        n.operatorToken.kind <= K.LastAssignment
          ? n.left
          : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
              (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken)
            ? n.operand
            : undefined;
      if (target) {
        const t = skipParens(target);
        if (
          ts.isPropertyAccessExpression(t) &&
          t.name.text === name &&
          ((ts.isIdentifier(t.expression) &&
            this.subtree(info).some(c => this.lower.symbol(t.expression) === c.symbol)) ||
            // `this.name = …` in a static member of the class.
            (t.expression.kind === ts.SyntaxKind.ThisKeyword &&
              this.staticContainer(t.expression) === info.decl))
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
    // A member of a generic class: its parameters in the instantiation.
    const instance = this.instanceParams(decl, info);
    const untyped =
      !instance &&
      decl.parameters.some(p => !p.type && lower.types.typeOrUndefined(p) === undefined);
    if (untyped) return { decl, name, specs: new Map() };
    const sig = lower.checker.getSignatureFromDeclaration(decl);
    const ret = sig?.getReturnType();
    // A result type outside the value model or unknown in untyped package
    // JavaScript (tabbable's `FocusableElement[]`): the type of the values it returns,
    // as for untyped parameters.
    if (
      !ts.isConstructorDeclaration(decl) &&
      !ts.isSetAccessor(decl) &&
      ret &&
      /\.js\.__runic\.ts$/.test(decl.getSourceFile().fileName) &&
      (ret.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
        lower.types.tryMap(ret, decl) === undefined)
    )
      return { decl, name, specs: new Map() };
    const fn = lower.reserve();
    const result: Type = ts.isConstructorDeclaration(decl)
      ? { record: info.record }
      : ts.isSetAccessor(decl)
        ? 'void'
        : ret && !(ret.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
          ? lower.types.map(ret, decl)
          : 'void';
    const params: Local[] = [
      ...(self ? [{ name: 'this', type: this.selfType(info) }] : []),
      ...(instance
        ? instance.map((type, i) => ({ name: `arg${i}`, type }))
        : this.declaredParams(decl)),
    ];
    lower.functions[fn] = this.placeholder(name, info, params, result);
    return { decl, name, fn, ...(instance ? { params: instance } : {}) };
  }

  /** The parameters of `decl` as declared (a tuple rest parameter's items each). */
  private declaredParams(decl: ts.FunctionLikeDeclaration): Local[] {
    const lower = this.lower;
    return [
      ...decl.parameters.flatMap(p => {
        const name = ts.isIdentifier(p.name) ? p.name.text : 'arg';
        const t = lower.checker.getTypeAtLocation(p);
        // A rest parameter of a tuple type: one parameter per item, as the
        // function is lowered (`Lowerer.function`).
        const items = p.dotDotDotToken ? lower.types.restParams(t, p) : undefined;
        if (items) return items.map((type, j) => ({ name: `${name}${j}`, type }));
        return [{ name, type: lower.types.map(t, p) }];
      }),
    ];
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
          isStatic(c.decl) ? undefined : { self: this.selfType(info) },
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
    // Classes of package modules are declared when first used.
    if (!info.declared) this.lower.bindingOf(info.symbol);
    if (!info.declared)
      this.fail(at, `${info.name} is not declared in a module or component script`);
  }

  private ensureDeclared(info: ClassInfo, at: ts.Node) {
    if (!info.declared) this.lower.bindingOf(info.symbol);
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
    const ctor = this.explicitCtor(info);
    if (ctor) {
      lower.function(
        ctor,
        `${info.name}.constructor`,
        undefined,
        info.component,
        index,
        paramTypes,
        {
          body: b => this.constructorBody(info, b, ctor),
          result: self,
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
    const body = this.constructorBody(info, b, undefined);
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

  /**
   * Derived fields whose function could not be lowered, with the
   * diagnostic: Svelte computes a derived value only when it is read, so a
   * field the program never reads never runs (bits-ui's `arrowStyle` where
   * no arrow is rendered). Its function throws RunicUnsupportedError; a read
   * of it reports the diagnostic.
   */
  private readonly deferred = new Map<Field, Error>();
  /** Derived fields the program reads. */
  private readonly readDerived = new Set<Field>();

  /** `lowerDerived`, deferring the field's diagnostic while it is unread. */
  private lowerDeferrable(info: ClassInfo, f: Field, index: number) {
    const lower = this.lower;
    const count = lower.functions.length;
    try {
      this.lowerDerived(info, f, index);
    } catch (err) {
      // (Package classes only: a program's own fields are checked as written.)
      const code = (err as { code?: string }).code;
      const pkg = /\.js\.__runic\.ts$/.test(info.decl.getSourceFile().fileName);
      if (!pkg || !code?.startsWith('E_') || this.readDerived.has(f)) throw err;
      // (Functions reserved by the failed lowering stay as throwing stubs.)
      for (let i = count; i < lower.functions.length; i++)
        if (!lower.functions[i])
          lower.functions[i] = this.unreachable(
            `${info.name}.${f.name}$part`,
            info,
            [],
            'void',
            err as Error,
          );
      this.deferred.set(f, err as Error);
      lower.functions[index] = this.unreachable(
        `${info.name}.${f.name}$derived`,
        info,
        [{ name: 'this', type: this.selfType(info) }],
        f.type,
        err as Error,
      );
    }
  }

  /** A function that throws RunicUnsupportedError with diagnostic `err`. */
  private unreachable(name: string, info: ClassInfo, params: Local[], result: Type, err: Error) {
    const lower = this.lower;
    return {
      name,
      ...(info.component !== undefined ? { component: info.component } : {}),
      params,
      locals: [],
      result,
      body: [
        {
          op: 'throw' as const,
          value: {
            op: 'record' as const,
            record: lower.errorRecord(),
            fields: [
              { op: 'lit' as const, value: 'RunicUnsupportedError' },
              { op: 'lit' as const, value: err.message },
            ],
          },
        },
      ],
    };
  }

  /**
   * The function computing derived field `f` from the instance (its only
   * parameter): `$derived(expr)` returns `expr`, `$derived.by(fn)` is `fn`'s
   * body. Svelte creates the derived signal with a closure over `this` and
   * computes it when read; `this` in the expression is the parameter.
   */
  private lowerDerived(info: ClassInfo, f: Field, index: number) {
    const lower = this.lower;
    const self = this.selfType(info);
    const name = `${info.name}.${f.name}$derived`;
    const { call, kind, container } = f.rune!;
    const arg = call.arguments[0];
    if (!arg || call.arguments.length !== 1) this.fail(call, `${kind} takes one argument`);
    if (ts.isConstructorDeclaration(container)) this.constructorFree(arg, container, kind);
    const previous = lower.thisBindings.get(container);
    try {
      if (kind === '$derived.by') {
        if (!(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) || arg.parameters.length)
          this.fail(call, '$derived.by takes a function without parameters');
        if (
          (arg as ts.FunctionLikeDeclaration).modifiers?.some(
            m => m.kind === ts.SyntaxKind.AsyncKeyword,
          )
        )
          this.fail(call, '$derived.by with an async function is unsupported');
        const fn = arg as ts.ArrowFunction;
        // (The field's type, which its returned values take: in untyped
        // JavaScript the declaration file's.)
        lower.function(fn, name, undefined, info.component, index, undefined, {
          self,
          result: f.type,
          body: b => {
            lower.thisBindings.set(container, { owner: b, local: 0 });
            return lower.functionBody(fn, b);
          },
        });
      } else {
        const b = new FnBuilder(name, undefined, info.component, new Set(), false);
        const local = b.param('this', self);
        lower.thisBindings.set(container, { owner: b, local });
        const value = lower.expr(arg, b);
        const body: Stmt[] = [...lower.hoistedLets(b), { op: 'return', value }];
        const source = lower.sourceOf(call);
        lower.functions[index] = {
          name,
          ...(info.component !== undefined ? { component: info.component } : {}),
          params: b.params,
          locals: b.locals,
          result: lower.irType(value, b),
          body: remapLocals(body, i => b.final(i)),
          ...(source ? { source } : {}),
        };
      }
    } finally {
      if (previous) lower.thisBindings.set(container, previous);
      else lower.thisBindings.delete(container);
    }
    // The field's type: a value of the inner type is wrapped (`T | undefined` fields).
    const fn = lower.functions[index];
    if (JSON.stringify(fn.result) !== JSON.stringify(f.type)) {
      const inner = maybeInner(f.type);
      if (!inner || JSON.stringify(inner) !== JSON.stringify(fn.result))
        this.fail(
          call,
          `${info.name}.${f.name}: the derived value's type differs from the field's`,
        );
      fn.body = wrapReturns(fn.body);
      fn.result = f.type;
    }
  }

  /** A derived field assigned in the constructor computes later: it cannot read the constructor's parameters or locals. */
  private constructorFree(e: ts.Expression, ctor: ts.ConstructorDeclaration, kind: string) {
    const checker = this.lower.checker;
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) {
        const decl = checker.getSymbolAtLocation(n)?.valueDeclaration;
        let inside = false;
        for (let p = decl?.parent; p; p = p.parent) if (p === ctor) inside = true;
        let own = false;
        for (let p = decl?.parent; p; p = p.parent) if (p === e) own = true;
        if (decl && inside && !own)
          this.fail(
            n,
            `${kind} in the constructor reads ${n.text}, a constructor parameter or local; derived fields are computed from the instance (store the value in a field and read it through this)`,
          );
      }
      ts.forEachChild(n, visit);
    };
    visit(e);
  }

  /** The top-level `super(…)` statement of the constructor of subclass `x`. */
  private superStatement(x: ClassInfo): { index: number; call: ts.CallExpression } {
    const statements = x.ctor!.body!.statements;
    let found: { index: number; call: ts.CallExpression } | undefined;
    statements.forEach((s, index) => {
      if (
        ts.isExpressionStatement(s) &&
        ts.isCallExpression(s.expression) &&
        s.expression.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        if (found) this.fail(s, 'super(…) is called once');
        found = { index, call: s.expression };
      }
    });
    if (!found)
      return this.fail(
        x.ctor!,
        `The constructor of ${x.name} must call super(…) as a statement at its top level`,
      );
    // Elsewhere (in a condition, a callback) it would run conditionally.
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        n.expression.kind === ts.SyntaxKind.SuperKeyword &&
        n !== found!.call
      )
        this.fail(n, 'super(…) is supported as a statement at the top level of the constructor');
      ts.forEachChild(n, visit);
    };
    visit(x.ctor!.body!);
    return found;
  }

  /** Bind the parameters of base constructor `ctor` to the arguments of a `super(…)` call. */
  private bindParams(ctor: ts.ConstructorDeclaration, args: Expr[], b: FnBuilder): Stmt[] {
    const lower = this.lower;
    const checker = lower.checker;
    const out: Stmt[] = [];
    ctor.parameters.forEach((p, i) => {
      if (p.dotDotDotToken) this.fail(p, 'Rest parameters are planned for later');
      if (!ts.isIdentifier(p.name))
        this.fail(p, 'Destructured constructor parameters are planned for later');
      const name = (p.name as ts.Identifier).text;
      const symbol = ts.isParameterPropertyDeclaration(p, ctor)
        ? checker.getSymbolsOfParameterPropertyDeclaration(p, name)[0]
        : checker.getSymbolAtLocation(p.name);
      const untyped = !p.type && lower.types.typeOrUndefined(p) === undefined;
      const arg = args[i];
      if (!arg) return this.fail(p, `super(…) passes no argument for ${name}`);
      const type = untyped
        ? lower.irType(arg, b)
        : lower.types.map(checker.getTypeAtLocation(p), p);
      if (untyped && symbol) lower.types.override(symbol, type);
      const local = b.local(name, type, !!symbol && b.boxed.has(symbol));
      out.push({ op: 'let', local, value: arg });
      if (symbol) lower.bindings.set(symbol, { kind: 'local', owner: b, local });
      if (p.initializer)
        out.push({
          op: 'if',
          test: {
            op: 'builtin',
            name: 'maybe.is-undefined',
            args: [{ op: 'local', local }],
            type: 'boolean',
          },
          then: [
            {
              op: 'assign',
              target: { place: 'local', local },
              value: lower.expr(p.initializer, b),
            },
          ],
        });
    });
    return out;
  }

  /** The own field of the exact class `info` named by `name` (private names by their declaring class). */
  private fieldNamed(info: ClassInfo, name: ts.MemberName | string): Field | undefined {
    const text = typeof name === 'string' ? name : name.text;
    if (typeof name !== 'string' && ts.isPrivateIdentifier(name)) {
      const owner = this.privateOwner(name);
      return owner?.own.find(f => f.name === text);
    }
    return info.fields.find(f => f.name === text);
  }

  /**
   * Whether fields of the classes `later` can exist before `rest` (the
   * statements of a base constructor after it first used the instance) runs:
   * each is a literal, derived, a whole arrow function or `$state` of a
   * literal (creating it has no effect and reads nothing: an arrow function
   * reads `this` when it runs), as is each base field they declare again
   * (`overrides`), and `rest` reaches the instance only through fields of
   * the classes above them that no later class declares again (in closures
   * too, which it may call at once, and in the arrow functions those fields
   * hold, which it may call at once too: their bodies are checked the same
   * way) or in effects, which run later.
   *
   * JavaScript creates the later fields after `rest`, the record before it
   * (bits-ui's SliderSingleRootState and SliderMultiRootState, whose base
   * constructor ends with `new SvelteResizeObserver(() =>
   * this.opts.ref.current, this.#handleLayoutChange)`). Nothing can tell:
   * creating them has no effect, and `rest` cannot read them (where it
   * could, JavaScript would see them missing, or a re-declared field's
   * base value, and the class stays rejected).
   */
  private fieldsUnobserved(
    rest: readonly ts.Statement[],
    later: ClassInfo[],
    info: ClassInfo,
  ): boolean {
    const literal = (e: ts.Expression): boolean => {
      e = skipParens(e);
      return (
        ts.isStringLiteralLike(e) ||
        ts.isNumericLiteral(e) ||
        e.kind === ts.SyntaxKind.TrueKeyword ||
        e.kind === ts.SyntaxKind.FalseKeyword ||
        e.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(e) && e.text === 'undefined')
      );
    };
    /** Whether evaluating initialiser `e` has no effect and reads nothing. */
    const inert = (e: ts.Expression): boolean => {
      const inner = skipParens(e);
      return literal(inner) || ts.isArrowFunction(inner);
    };
    // (Declared with it: one the constructor assigns is created there.)
    const stateOfLiteral = (f: Field) =>
      (f.rune?.kind === '$state' || f.rune?.kind === '$state.raw') &&
      !!f.decl?.initializer &&
      skipParens(f.decl.initializer) === f.rune.call &&
      f.rune.call.arguments.every(literal);
    if (
      !later.every(
        y =>
          y.own.every(
            f =>
              isDerived(f) ||
              stateOfLiteral(f) ||
              (!f.param && !f.rune && !!f.decl?.initializer && inert(f.decl.initializer)),
          ) && (y.overrides ?? []).every(d => !!d.initializer && inert(d.initializer)),
      )
    )
      return false;
    const redefined = new Set(
      later.flatMap(y => (y.overrides ?? []).map(d => this.fieldNamed(info, memberName(d.name)))),
    );
    let ok = true;
    const checked = new Set<ts.Node>();
    const visit = (n: ts.Node): void => {
      if (!ok) return;
      // A function with its own `this`.
      if (ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isClassLike(n)) return;
      // Effects run after the constructor.
      if (
        ts.isCallExpression(n) &&
        /^\$effect(\.pre)?$/.test(n.expression.getText()) &&
        n.arguments.every(a => ts.isArrowFunction(skipParens(a)))
      )
        return;
      if (n.kind === ts.SyntaxKind.SuperKeyword) ok = false;
      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        const access = n.parent;
        const field =
          ts.isPropertyAccessExpression(access) &&
          access.expression === n &&
          !(ts.isCallExpression(access.parent) && access.parent.expression === access)
            ? this.fieldNamed(info, access.name)
            : undefined;
        if (!field || later.includes(field.owner) || redefined.has(field)) ok = false;
        // (An arrow function the field holds from its initialiser, which
        // whatever `rest` passes it to may call at once.)
        // A function it holds otherwise (assigned by a constructor, a bound
        // method) is not followed: not known not to reach them.
        const init = field?.decl?.initializer && skipParens(field.decl.initializer);
        const arrow = !!init && ts.isArrowFunction(init);
        const fnType = (t: Type | undefined) => typeof t === 'object' && 'fn' in t;
        if (field && !arrow && (fnType(field.type) || fnType(maybeInner(field.type)))) ok = false;
        if (ok && arrow && !checked.has(init)) {
          checked.add(init);
          visit((init as ts.ArrowFunction).body);
        }
      }
      ts.forEachChild(n, visit);
    };
    rest.forEach(visit);
    return ok;
  }

  private constructorBody(
    info: ClassInfo,
    b: FnBuilder,
    top: ts.ConstructorDeclaration | undefined,
  ): Stmt[] {
    // A constructor may be lowered while a member of a base class is (a
    // package class declared when first used): `this` of the chain's
    // members is the constructor's only while it is lowered.
    const saved = new Map(this.lower.thisBindings);
    try {
      return this.constructorSteps(info, b, top);
    } finally {
      this.lower.thisBindings.clear();
      for (const [k, v] of saved) this.lower.thisBindings.set(k, v);
    }
  }

  private constructorSteps(
    info: ClassInfo,
    b: FnBuilder,
    top: ts.ConstructorDeclaration | undefined,
  ): Stmt[] {
    const lower = this.lower;
    const self: Type = { record: info.record };
    const chain = this.chain(info);
    const out: Stmt[] = [];
    const local = (l: number): Expr => ({ op: 'local', local: l });
    const src = (n: ts.Node) => {
      const s = lower.sourceOf(n);
      return s ? { source: s } : {};
    };
    // Captured and mutated variables of the base constructors are boxed too.
    for (const x of chain)
      if (x.ctor && x.ctor !== top) for (const s of lower.analyseCaptures(x.ctor)) b.boxed.add(s);
    // `this` before the record exists: closures created meanwhile read it later.
    const early = b.local('this?', { maybe: self }, true);
    out.push({ op: 'let', local: early, value: { op: 'undefined', type: { maybe: self } } });
    for (const x of chain) {
      const containers: ts.Node[] = x.decl.members.filter(
        m => ts.isPropertyDeclaration(m) && !isStatic(m),
      );
      if (x.ctor) containers.push(x.ctor);
      for (const c of containers)
        lower.thisBindings.set(c, {
          owner: b,
          local: early,
          maybe: true,
          ...(chain.length > 1 ? { cls: info } : {}),
        });
    }
    /** Field → the temporary holding its value until the record is built. */
    const temps = new Map<Field, number>();
    const assign = (field: Field, value: Expr, at: ts.Node) => {
      value = this.fit(value, lower.irType(value, b), field.type);
      const known = temps.get(field);
      if (known !== undefined) {
        out.push({ op: 'assign', target: { place: 'local', local: known }, value, ...src(at) });
        return;
      }
      const t = b.local(field.name, field.type);
      temps.set(field, t);
      out.push({ op: 'let', local: t, value, ...src(at) });
    };
    // 1. From the class up to the root: the statements before each
    //    `super(…)` (which cannot use `this`), then its arguments.
    for (let i = chain.length - 1; i > 0; i--) {
      const x = chain[i];
      if (!x.ctor) continue; // implicit: super(...args) passes them on
      const sc = this.superStatement(x);
      for (const s of x.ctor.body!.statements.slice(0, sc.index)) {
        this.noReturn(s);
        if (mentionsThis(s))
          this.fail(s, 'this and super are used before super(…) (JavaScript throws)');
        out.push(...lower.statement(s, b));
      }
      const target = this.explicitCtor(x.base);
      const args = lower.callArgs(sc.call, b);
      if (target) out.push(...this.bindParams(target, args, b));
      else for (const a of args) out.push({ op: 'expr', value: a });
    }
    /** The initial value of a `$state`/`$state.raw` field (`undefined` without an argument). */
    const runeValue = (f: Field, where: 'initialiser' | 'constructor'): Expr => {
      const arg = f.rune!.call.arguments[0];
      if (f.rune!.call.arguments.length > 1)
        this.fail(f.rune!.call, `${f.rune!.kind} takes at most one argument`);
      // `$state(null)`: the literal takes the field's (nullable) type.
      const literal = arg && skipParens(arg);
      if (
        literal &&
        maybeInner(f.type) &&
        (literal.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(literal) && literal.text === 'undefined'))
      )
        return {
          op: literal.kind === ts.SyntaxKind.NullKeyword ? 'null' : 'undefined',
          type: f.type,
        };
      // `$state([])`: the empty array takes the field's element type.
      if (
        literal &&
        ts.isArrayLiteralExpression(literal) &&
        !literal.elements.length &&
        typeof f.type === 'object' &&
        'array' in f.type
      )
        return { op: 'array', type: f.type, items: [] };
      // `$state(new Map())`, `$state(new Set())`: the empty collection takes
      // the field's type (untyped JavaScript gives it none: bits-ui's
      // tooltip trigger registry).
      if (
        literal &&
        ts.isNewExpression(literal) &&
        !literal.arguments?.length &&
        ts.isIdentifier(literal.expression) &&
        typeof f.type === 'object' &&
        ((literal.expression.text === 'Map' && 'map' in f.type) ||
          (literal.expression.text === 'Set' && 'set' in f.type))
      )
        return { op: 'builtin', name: `${literal.expression.text}.new`, args: [], type: f.type };
      return arg ? this.early(arg, b, info, temps, where) : { op: 'undefined', type: f.type };
    };
    /** The statements of `x`'s constructor after its `super(…)` call. */
    const after = (x: ClassInfo): readonly ts.Statement[] => {
      const statements = x.ctor?.body?.statements ?? [];
      return x.base && x.ctor ? statements.slice(this.superStatement(x).index + 1) : statements;
    };
    /**
     * The initialiser of a base field declared again (`fieldOverride`), as
     * a value of the base field's type. TypeScript gives the declaration
     * its own object type, structurally the base field's (`{ n: number }`
     * written twice): an object literal is built as the base field's
     * record, and a value whose record differs (the keys in another order,
     * which is observable; getters where the base's objects have plain
     * properties) is rejected here.
     */
    const overrideValue = (f: Field, m: ts.PropertyDeclaration): Expr => {
      const init = skipParens(m.initializer!);
      if (ts.isObjectLiteralExpression(init) && !lower.expected.has(init))
        lower.expected.set(init, f.type);
      const value = this.early(m.initializer!, b, info, temps, 'initialiser');
      const have = lower.irType(value, b);
      if (
        this.fit(value, have, f.type) === value &&
        JSON.stringify(have) !== JSON.stringify(f.type)
      ) {
        const owner = ts.isClassLike(m.parent) && m.parent.name ? m.parent.name.text : info.name;
        this.fail(
          m,
          `${owner} declares the field ${f.name} of a base class again with a value the base field's type cannot hold here: the object types are structurally the same, but their objects differ in key order (which is observable) or in being implemented with getters; give the value the base field's key order and kind of properties`,
        );
      }
      return value;
    };
    /** Whether `s` assigns a reactive field its rune. */
    const runeStatement = (s: ts.Statement) => {
      const target = thisAssignment(s);
      const field = target && this.fieldNamed(info, target.name);
      const rhs = target && ((s as ts.ExpressionStatement).expression as ts.BinaryExpression).right;
      return field?.rune && rhs && field.rune.call === skipParens(rhs) ? field : undefined;
    };
    // 2. From the root down: parameter properties, field initialisers in
    //    declaration order, then the leading `this.f = …` statements and
    //    statements that do not use `this`.
    let broke: { cls: ClassInfo; rest: readonly ts.Statement[] } | undefined;
    let k = 0;
    for (; k < chain.length && !broke; k++) {
      const x = chain[k];
      for (const f of x.own)
        if (f.param) {
          const name = (f.param.name as ts.Identifier).text;
          const binding = lower.bindings.get(
            lower.checker.getSymbolsOfParameterPropertyDeclaration(f.param as never, name)[0],
          );
          if (binding?.kind !== 'local') return this.fail(f.param, 'Unresolved parameter property');
          assign(f, local(binding.local), f.param);
        }
      // (In declaration order, a base's field declared again among them.)
      for (const m of x.decl.members) {
        if (!ts.isPropertyDeclaration(m) || !m.initializer) continue;
        if (x.overrides?.includes(m)) {
          const f = this.fieldNamed(info, memberName(m.name))!;
          assign(f, overrideValue(f, m), m);
          continue;
        }
        const f = x.own.find(o => o.decl === m);
        if (!f) continue;
        // Derived fields are functions of the instance, computed when read.
        if (isDerived(f)) continue;
        assign(
          f,
          f.rune
            ? runeValue(f, 'initialiser')
            : this.early(m.initializer, b, info, temps, 'initialiser'),
          m,
        );
      }
      const statements = after(x);
      let i = 0;
      for (; i < statements.length; i++) {
        const s = statements[i];
        // (A statement using `this` goes to the rest, where `return;` ends the
        // constructor with its instance.)
        this.noReturn(s, mentionsThis(s));
        const reactive = runeStatement(s);
        if (reactive) {
          if (isDerived(reactive)) continue;
          const arg = reactive.rune!.call.arguments[0];
          if (arg && !this.earlyForm(arg, info, temps)) break;
          assign(reactive, runeValue(reactive, 'constructor'), s);
          continue;
        }
        const target = thisAssignment(s);
        const field = target && this.fieldNamed(info, target.name);
        if (target && field) {
          const rhs = ((s as ts.ExpressionStatement).expression as ts.BinaryExpression).right;
          if (!this.earlyForm(rhs, info, temps)) break;
          assign(field, this.early(rhs, b, info, temps, 'constructor'), s);
          continue;
        }
        if (mentionsThis(s)) break;
        out.push(...lower.statement(s, b));
      }
      if (i < statements.length) broke = { cls: x, rest: statements.slice(i) };
    }
    // The classes below one whose constructor uses the instance declare no
    // fields: JavaScript would initialise them only after that code ran.
    // Unless nothing can tell (bits-ui's SelectSingleRootState, the
    // slider's SliderSingleRootState): each is a literal, derived, an arrow
    // function or `$state` of a literal, and what that constructor runs at
    // once never reaches them (`fieldsUnobserved`); they are then in the
    // record from the start, as are the base fields they declare again.
    const later = chain.slice(k);
    if (broke) {
      const unobserved = this.fieldsUnobserved(broke.rest, later, info);
      for (const y of later) {
        if (y.own.length && !unobserved)
          this.fail(
            y.own[0].node,
            `${y.name} declares fields, but the constructor of its base class ${broke.cls.name} uses this before they exist (JavaScript initialises them after super(…) returns); move that code out of the constructor, or the fields into ${broke.cls.name}`,
          );
        // (A base's field declared again holds the base's value until then,
        // which that code may read.)
        if (!unobserved)
          for (const d of y.overrides ?? [])
            this.fail(
              d,
              `${y.name} declares the field ${memberName(d.name)} of a base class again, but the constructor of its base class ${broke.cls.name} uses this before it is set (JavaScript sets it after super(…) returns); assign it in the constructor instead`,
            );
        // (In declaration order, as JavaScript creates them.)
        for (const m of y.decl.members) {
          if (!ts.isPropertyDeclaration(m) || !m.initializer) continue;
          if (y.overrides?.includes(m)) {
            const f = this.fieldNamed(info, memberName(m.name))!;
            assign(f, overrideValue(f, m), m);
            continue;
          }
          const f = y.own.find(o => o.decl === m);
          if (!f || isDerived(f)) continue;
          assign(
            f,
            f.rune
              ? runeValue(f, 'initialiser')
              : ts.isArrowFunction(skipParens(m.initializer))
                ? this.early(m.initializer, b, info, temps, 'initialiser')
                : lower.expr(m.initializer, b),
            m,
          );
        }
      }
    }
    let rest = [...(broke?.rest ?? []), ...later.flatMap(y => [...after(y)])];
    // Methods bound into their fields later in the constructor
    // (`this.onfocus = this.onfocus.bind(this)` after `watch(…)`, bits-ui's
    // TabsTriggerState): bound when the record is built, if nothing before
    // the binding reads the method other than by calling it (a call through
    // the prototype's method or the bound one is the same call).
    const hoisted = new Set<ts.Statement>();
    rest.forEach((s, j) => {
      const target = thisAssignment(s);
      const field = target && this.fieldNamed(info, target.name);
      if (!target || !field || temps.has(field)) return;
      const rhs = ((s as ts.ExpressionStatement).expression as ts.BinaryExpression).right;
      if (!this.methodToBind(skipParens(rhs), info, temps)) return;
      const name = target.name.text;
      const readBefore = rest.slice(0, j).some(earlier => {
        let found = false;
        const visit = (n: ts.Node) => {
          if (
            ts.isPropertyAccessExpression(n) &&
            n.expression.kind === ts.SyntaxKind.ThisKeyword &&
            n.name.text === name &&
            !(ts.isCallExpression(n.parent) && n.parent.expression === n)
          )
            found = true;
          ts.forEachChild(n, visit);
        };
        visit(earlier);
        return found;
      });
      if (readBefore) return;
      assign(field, this.early(rhs, b, info, temps, 'constructor'), s);
      hoisted.add(s);
    });
    rest = rest.filter(s => !hoisted.has(s));
    for (const s of rest)
      if (runeStatement(s))
        this.fail(
          s,
          'Assign reactive fields ($state, $derived) at the start of the constructor, before it otherwise uses this',
        );
    // 3. The record (derived fields have no value: they are computed when read).
    const fields: Expr[] = info.fields
      .filter(f => !isDerived(f))
      .map(f => {
        const t = temps.get(f);
        if (t !== undefined) return local(t);
        if (maybeInner(f.type)) return { op: 'undefined', type: f.type };
        return this.fail(
          f.node,
          `${f.owner.name}.${f.name} is not set before the constructor otherwise uses this: give it an initialiser, assign it at the start of the constructor, or make it optional`,
        );
      });
    const instance = b.local('this', self);
    out.push({ op: 'let', local: instance, value: { op: 'record', record: info.record, fields } });
    out.push({
      op: 'assign',
      target: { place: 'local', local: early },
      value: { op: 'some', value: local(instance) },
    });
    // 4. The rest of the constructors, with `this` the instance.
    for (const x of chain)
      if (x.ctor)
        lower.thisBindings.set(x.ctor, {
          owner: b,
          local: instance,
          ...(chain.length > 1 ? { cls: info } : {}),
        });
    // (A `return;` there ends the constructor with its instance: bits-ui's
    // BodyScrollLock `if (!this.#countState) return;`.)
    const exits = (stmts: Stmt[]): Stmt[] =>
      JSON.parse(JSON.stringify(stmts), (_key, v) =>
        v && typeof v === 'object' && v.op === 'return' && !('value' in v)
          ? { ...v, value: local(instance) }
          : v,
      );
    for (const s of rest) {
      this.noReturn(s, true);
      out.push(...exits(lower.statement(s, b)));
    }
    out.push({ op: 'return', value: local(instance) });
    return out;
  }

  /**
   * Constructors return their instance: `return` statements are rejected
   * (`bare`: those without a value are not, where the instance exists).
   */
  private noReturn(s: ts.Node, bare = false) {
    const visit = (n: ts.Node) => {
      if (ts.isReturnStatement(n) && !(bare && !n.expression))
        this.fail(
          n,
          'return in a constructor is unsupported (the constructor returns its instance)',
        );
      if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
    };
    visit(s);
  }

  /**
   * Whether the outermost arrow function around `n` (inside `root`) is an
   * argument of `new C(…)` of a class a pack ports (frontend/packs/*:
   * reviewed code that calls it only after the constructor).
   */
  private toPortConstructor(n: ts.Node, root: ts.Node): boolean {
    let arrow: ts.Node | undefined;
    for (let p: ts.Node | undefined = n.parent; p && p !== root.parent; p = p.parent)
      if (ts.isArrowFunction(p)) arrow = p;
    if (!arrow) return false;
    let at: ts.Node = arrow;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    const call = at.parent;
    if (!ts.isNewExpression(call) || !call.arguments?.includes(at as ts.Expression)) return false;
    let sym = this.lower.checker.getSymbolAtLocation(call.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.lower.checker.getAliasedSymbol(sym);
    const file = sym?.valueDeclaration?.getSourceFile().fileName ?? '';
    return /[\\/]frontend[\\/]packs[\\/]/.test(file);
  }

  /**
   * Whether `n` is in an arrow function passed to a call of a function
   * that cannot call it during the call (bits-ui's `#handleInteractOutside
   * = debounce((e) => …, 10)`): the callee's parameters and body, outside
   * the function literals in them, make no calls (nor `new`, tagged
   * templates, spreads, `for…of`, `await` or `yield`), assign properties of
   * its own constants holding function literals only, and refer to the
   * parameter only inside function literals. So the arrow runs after the
   * instance exists, reading `this` from it.
   */
  private toStoringCall(n: ts.Node, root: ts.Node): boolean {
    let arrow: ts.Node | undefined;
    for (let p: ts.Node | undefined = n.parent; p && p !== root.parent; p = p.parent)
      if (ts.isArrowFunction(p)) arrow = p;
    if (!arrow) return false;
    let at: ts.Node = arrow;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    const call = at.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(at as ts.Expression)) return false;
    const checker = this.lower.checker;
    const decl = checker.getResolvedSignature(call)?.declaration;
    if (
      !decl ||
      !(
        ts.isFunctionDeclaration(decl) ||
        ts.isFunctionExpression(decl) ||
        ts.isArrowFunction(decl)
      ) ||
      !decl.body
    )
      return false;
    const index = call.arguments.indexOf(at as ts.Expression);
    const param = decl.parameters[index];
    if (!param || param.dotDotDotToken || !ts.isIdentifier(param.name)) return false;
    const sym = checker.getSymbolAtLocation(param.name);
    const fnConst = (x: ts.Expression): boolean => {
      if (!ts.isIdentifier(x)) return false;
      const d = checker.getSymbolAtLocation(x)?.valueDeclaration;
      return (
        !!d &&
        ts.isVariableDeclaration(d) &&
        !!(d.parent.flags & ts.NodeFlags.Const) &&
        !!d.initializer &&
        (ts.isArrowFunction(skipParens(d.initializer)) ||
          ts.isFunctionExpression(skipParens(d.initializer))) &&
        d.pos >= decl.pos &&
        d.end <= decl.end
      );
    };
    let ok = true;
    const visit = (x: ts.Node, nested: boolean) => {
      if (!ok) return;
      if (!nested) {
        if (
          ts.isCallExpression(x) ||
          ts.isNewExpression(x) ||
          ts.isTaggedTemplateExpression(x) ||
          ts.isSpreadElement(x) ||
          ts.isSpreadAssignment(x) ||
          ts.isForOfStatement(x) ||
          ts.isAwaitExpression(x) ||
          ts.isYieldExpression(x) ||
          ts.isDecorator(x)
        )
          ok = false;
        if (
          ts.isBinaryExpression(x) &&
          x.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          x.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          !ts.isIdentifier(x.left) &&
          !(ts.isPropertyAccessExpression(x.left) && fnConst(x.left.expression))
        )
          ok = false;
        if (ts.isIdentifier(x) && x !== param.name && sym && checker.getSymbolAtLocation(x) === sym)
          ok = false;
      }
      ts.forEachChild(x, c => visit(c, nested || (ts.isFunctionLike(x) && x !== decl)));
    };
    visit(decl, false);
    return ok;
  }

  /** Whether every function between `n` and `root` is an arrow function (it sees the class's `this`). */
  /**
   * Whether the arrow functions around `n` up to `root` sit in object and
   * array literals that are `root` (bits-ui's `popperProps = {
   * onCloseAutoFocus: (e) => this.onCloseAutoFocus(e) }`): building the
   * literal calls nothing, so the arrow runs once the instance exists.
   */
  private inStoredLiteral(n: ts.Node, root: ts.Node): boolean {
    let arrow: ts.Node | undefined;
    for (let p: ts.Node | undefined = n.parent; p && p !== root.parent; p = p.parent)
      if (ts.isArrowFunction(p)) arrow = p;
    if (!arrow || arrow === root) return false;
    for (let p: ts.Node = arrow; p !== root; p = p.parent) {
      const up = p.parent;
      const ok =
        ts.isParenthesizedExpression(up) ||
        ts.isObjectLiteralExpression(up) ||
        ts.isArrayLiteralExpression(up) ||
        (ts.isPropertyAssignment(up) && up.initializer === p);
      if (!ok) return false;
    }
    return true;
  }

  private arrowsUpTo(n: ts.Node, root: ts.Node): boolean {
    for (let p = n.parent; p && p !== root.parent; p = p.parent)
      if (ts.isFunctionLike(p) && !ts.isArrowFunction(p)) return false;
    return true;
  }

  /** Whether `e` can be evaluated before the record exists (see `early`). */
  private earlyForm(e: ts.Expression, info: ClassInfo, temps: Map<Field, number>): boolean {
    const inner = skipParens(e);
    if (ts.isArrowFunction(inner) || this.methodToBind(inner, info, temps)) return true;
    let ok = true;
    const visit = (n: ts.Node, nested: boolean) => {
      if (n.kind === ts.SyntaxKind.ThisKeyword && !this.earlyRead(n, nested, info, temps))
        ok = false;
      if (n.kind === ts.SyntaxKind.SuperKeyword) ok = false;
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
    temps: Map<Field, number>,
  ): Field | undefined {
    const p = n.parent;
    if (nested || !ts.isPropertyAccessExpression(p) || p.expression !== n) return undefined;
    const field = this.fieldNamed(info, p.name);
    if (!field || !temps.has(field)) return undefined;
    const fnType = (t: Type | undefined) => typeof t === 'object' && 'fn' in t;
    if (fnType(field.type) || fnType(maybeInner(field.type)))
      return this.storedInLiteral(p, info) ? field : undefined;
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
   * Whether the function-valued field read `p` is a property value of an
   * object literal that is a whole field initialiser (bits-ui's `props = {
   * onfocuscapture: this.#onfocuscapture }`), whose field nothing reads
   * before the instance exists (outside functions, in field initialisers
   * and the constructor): the function is stored, not called, until then.
   */
  private storedInLiteral(p: ts.PropertyAccessExpression, info: ClassInfo): boolean {
    const assignment = p.parent;
    if (!ts.isPropertyAssignment(assignment) || assignment.initializer !== p) return false;
    let literal: ts.Node = assignment.parent;
    while (ts.isParenthesizedExpression(literal.parent)) literal = literal.parent;
    const holder = literal.parent;
    if (
      !ts.isObjectLiteralExpression(assignment.parent) ||
      !ts.isPropertyDeclaration(holder) ||
      holder.initializer !== literal
    )
      return false;
    const name = holder.name.getText();
    let read = false;
    const visit = (n: ts.Node) => {
      if (read || (ts.isFunctionLike(n) && !ts.isConstructorDeclaration(n))) return;
      if (
        ts.isPropertyAccessExpression(n) &&
        n.expression.kind === ts.SyntaxKind.ThisKeyword &&
        n.name.getText() === name &&
        !(
          ts.isBinaryExpression(n.parent) &&
          n.parent.left === n &&
          n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
      )
        read = true;
      ts.forEachChild(n, visit);
    };
    for (const m of info.decl.members)
      if (ts.isPropertyDeclaration(m) && m.initializer) visit(m.initializer);
      else if (ts.isConstructorDeclaration(m) && m.body) visit(m.body);
    return !read;
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
    temps: Map<Field, number>,
    where: 'initialiser' | 'constructor',
  ): Expr {
    const lower = this.lower;
    const inner = skipParens(e);
    // A host field starts without its object.
    const holder = e.parent;
    if (ts.isPropertyDeclaration(holder) && holder.initializer === e && this.hostFieldOf(holder))
      return { op: 'lit', value: false };
    // A call TypeScript cannot type (untyped JavaScript: bits-ui's
    // `debounce(…)`) returns the field's type.
    const initialised =
      ts.isPropertyDeclaration(holder) && holder.initializer === e
        ? this.fieldNamed(info, holder.name as ts.MemberName)
        : undefined;
    if (initialised && ts.isCallExpression(inner) && !lower.expected.has(inner))
      lower.expected.set(inner, initialised.type);
    // A function of a compatible type (fewer parameters: bits-ui's
    // `#onPointerDownSnapshot = noopPointer`, `() => {}` for a handler,
    // `getBitsAttr = (part) => …` declared `typeof dialogAttrs.getAttr`).
    const adapt = (value: Expr): Expr => {
      if (!initialised) return value;
      const have = lower.irType(value, b);
      const want = maybeInner(initialised.type) ?? initialised.type;
      if (JSON.stringify(have) === JSON.stringify(want)) return value;
      const adapted = lower.adaptFunction(value, have, want);
      if (!adapted) return value;
      return maybeInner(initialised.type) ? { op: 'some', value: adapted } : adapted;
    };
    if (ts.isCallExpression(inner) && RUNES.test(inner.expression.getText()))
      this.fail(
        inner,
        'A rune here is unsupported: reactive fields are declared by a rune that is the whole field initialiser or constructor assignment',
      );
    if (this.tupleArrow(inner)) {
      const { index, builder } = lower.function(
        inner as ts.ArrowFunction,
        `${b.name}.closure`,
        b,
        b.component,
        undefined,
        undefined,
        { tupleParams: true },
      );
      return {
        op: 'closure',
        function: index,
        captures: builder.captureSources.map(c => c.local),
      };
    }
    if (ts.isArrowFunction(inner)) return adapt(lower.expr(e, b));
    if (ts.isCallExpression(inner) && this.methodToBind(inner, info, temps))
      return this.bind(inner, b, temps)!;
    const overrides = new Map<ts.Node, { expr: Expr; type: Type }>();
    const visit = (n: ts.Node, nested: boolean) => {
      if (n.kind === ts.SyntaxKind.SuperKeyword)
        this.fail(n, 'super is used before the instance is complete');
      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        // In an arrow function given to the constructor of a pack's port
        // (runed's ElementSize getter), which stores it and calls it once
        // the instance exists: read when it runs, from the instance (as an
        // arrow function stored whole in a field).
        if (
          nested &&
          this.arrowsUpTo(n, inner) &&
          (this.toPortConstructor(n, inner) ||
            this.toStoringCall(n, inner) ||
            this.inStoredLiteral(n, inner))
        )
          return;
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
          expr: { op: 'local', local: temps.get(field)! },
          type: field.type,
        });
        return;
      }
      ts.forEachChild(n, c => visit(c, nested || ts.isFunctionLike(n)));
    };
    visit(inner, false);
    return adapt(lower.withOverrides(overrides, () => lower.expr(e, b)));
  }

  // -------------------------------------------------------------------------
  // `this`, `super` and members

  /** The innermost function-like or field declaration whose `this` `node` sees (arrow functions see through). */
  private thisContainer(node: ts.Node): { container?: ts.Node; deferred: boolean } {
    let deferred = false;
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isArrowFunction(p)) {
        deferred = true;
        continue;
      }
      if (
        ts.isFunctionLike(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isClassStaticBlockDeclaration(p)
      )
        return { container: p, deferred };
    }
    return { deferred };
  }

  /** `this` in a class member (or an arrow function inside one). */
  thisValue(node: ts.Expression, b: FnBuilder): Expr {
    const lower = this.lower;
    const { container, deferred } = this.thisContainer(node);
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

  /** The class whose declaration directly contains member `m`. */
  private classOfMember(m: ts.Node): ClassInfo | undefined {
    const decl = m.parent;
    if (!decl || !ts.isClassDeclaration(decl) || !decl.name) return undefined;
    const sym = this.lower.checker.getSymbolAtLocation(decl.name);
    return sym && this.bySymbol.get(sym);
  }

  /** The class a `super` keyword refers to the base of, and whether it is in a static member. */
  private superContext(node: ts.Node): { cls: ClassInfo; base: ClassInfo; isStatic: boolean } {
    const { container } = this.thisContainer(node);
    const cls = container && this.classOfMember(container);
    if (!container || !cls) return this.fail(node, 'super is supported in class members');
    if (!cls.base) return this.fail(node, `${cls.name} has no base class`);
    return { cls, base: cls.base, isStatic: ts.isClassElement(container) && isStatic(container) };
  }

  /** `super.name` read: a base getter, called with this. */
  superRead(e: ts.PropertyAccessExpression, b: FnBuilder): Expr {
    const { base, isStatic: inStatic } = this.superContext(e.expression);
    const name = e.name.text;
    if (inStatic) return this.staticRead(base, e, b);
    const target = this.resolve(base, name, this.privateOwner(e.name));
    if (target?.kind === 'accessor' && target.get) {
      const recv = this.thisValue(e.expression, b);
      return {
        op: 'call',
        function: target.get.fn!,
        args: [this.receiver(recv, b, target.owner, e)],
      };
    }
    if (target?.kind === 'field')
      return this.fail(
        e,
        `super.${name} reads the base class's prototype, which has no field ${name} (fields belong to the instance: use this.${name})`,
      );
    if (target?.kind === 'method')
      return this.fail(e, `super.${name} is a method used as a value; call it (super.${name}(…))`);
    if (target?.kind === 'abstract')
      return this.fail(e, `${base.name}.${name} is abstract; super cannot call it`);
    return this.lower.fail(e, 'E_MEMBER', `${base.name} has no member ${name}`);
  }

  /** `super.name(…)`: the base class's method, called with this (statically). */
  superCall(callee: ts.PropertyAccessExpression, e: ts.CallExpression, b: FnBuilder): Expr {
    const lower = this.lower;
    const { base, isStatic: inStatic } = this.superContext(callee.expression);
    const name = callee.name.text;
    if (inStatic) return this.callStatic(base, callee, e, b);
    const target = this.resolve(base, name, this.privateOwner(callee.name));
    if (target?.kind === 'abstract')
      return this.fail(e, `${base.name}.${name} is abstract; super cannot call it`);
    if (target?.kind === 'field')
      return this.fail(
        callee,
        `super.${name} reads the base class's prototype, which has no field ${name}`,
      );
    const recv = this.thisValue(callee.expression, b);
    if (target?.kind === 'method') {
      const method = target.method;
      if (method.fn !== undefined)
        return {
          op: 'call',
          function: method.fn,
          args: [this.receiver(recv, b, target.owner, e), ...lower.callArgs(e, b)],
        };
      const self = this.selfType(target.owner);
      const tmp = b.local('$receiver', self);
      const { fn, args } = this.untypedCall(method, target.owner, e, b);
      return {
        op: 'with',
        local: tmp,
        value: this.receiver(recv, b, target.owner, e),
        body: { op: 'call', function: fn, args: [{ op: 'local', local: tmp }, ...args] },
      };
    }
    if (target?.kind === 'accessor' && target.get)
      return {
        op: 'call-value',
        callee: {
          op: 'call',
          function: target.get.fn!,
          args: [this.receiver(recv, b, target.owner, e)],
        },
        args: lower.callArgs(e, b),
      };
    return lower.fail(e, 'E_MEMBER', `${base.name} has no method ${name}`);
  }

  /** `recv` (an instance in the running code) as the `this` of a member declared by `owner`. */
  private receiver(recv: Expr, b: FnBuilder, owner: ClassInfo, at: ts.Node): Expr {
    return this.convert(recv, this.lower.irType(recv, b), this.selfType(owner), at);
  }

  /** The class declaring the private name `name` (`#x`). */
  private privateOwner(name: ts.MemberName): ClassInfo | undefined {
    if (!ts.isPrivateIdentifier(name)) return undefined;
    const decl = this.lower.checker.getSymbolAtLocation(name)?.valueDeclaration;
    return decl && this.classOfMember(decl);
  }

  /**
   * What `name` means on an instance of exactly `cls`: a field (the
   * instance's own properties shadow its prototype), else the member of the
   * nearest class declaring it. Private names are those of `owner`.
   */
  private resolve(cls: ClassInfo, name: string, owner?: ClassInfo): Target | undefined {
    const member = (m: Member, o: ClassInfo): Target | undefined => {
      if (m.method) return { kind: 'method', method: m.method, owner: o };
      if (m.get || m.set)
        return {
          kind: 'accessor',
          ...(m.get ? { get: m.get } : {}),
          ...(m.set ? { set: m.set } : {}),
          owner: o,
        };
      if (m.abstract) return { kind: 'abstract', owner: o };
      return undefined;
    };
    if (name.startsWith('#')) {
      if (!owner || !this.extendsClass(cls, owner)) return undefined;
      const f = owner.own.find(f => f.name === name);
      if (f) return { kind: 'field', field: f };
      const m = owner.members.get(name);
      return m ? member(m, owner) : undefined;
    }
    const f = cls.fields.find(f => f.name === name);
    if (f) return { kind: 'field', field: f };
    for (let x: ClassInfo | undefined = cls; x; x = x.base) {
      const m = x.members.get(name);
      if (m) return member(m, x);
    }
    return undefined;
  }

  /** Whether two targets are the same member. */
  private sameTarget(a: Target, b: Target): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'field') return a.field === (b as typeof a).field;
    if (a.kind === 'method') return a.method === (b as typeof a).method;
    if (a.kind === 'accessor')
      return a.get === (b as typeof a).get && a.set === (b as typeof a).set;
    return a.owner === (b as typeof a).owner;
  }

  /**
   * The member `name` on a receiver of class type `t`: the classes it can
   * have and their targets, and the target they share, if any.
   */
  private targets(
    t: Type,
    name: string,
    nameNode: ts.MemberName,
    at: ts.Node,
  ): { classes: ClassInfo[]; targets: Target[]; shared?: Target } {
    const owner = this.privateOwner(nameNode);
    const classes = this.classesOf(t) ?? [];
    for (const c of classes) this.declaredOnly(c, at);
    const targets = classes.map(c => {
      const target = this.resolve(c, name, owner);
      if (!target) return this.lower.fail(at, 'E_MEMBER', `${c.name} has no member ${name}`);
      return target;
    });
    if (!targets.length)
      return this.fail(at, `No class of this value can be constructed (its classes are abstract)`);
    const shared = targets.every(x => this.sameTarget(x, targets[0])) ? targets[0] : undefined;
    return { classes, targets, ...(shared ? { shared } : {}) };
  }

  /** A match over the classes of `value`: case `c` evaluates `body(local, c, target)`. */
  private matchClasses(
    value: Expr,
    classes: ClassInfo[],
    targets: Target[],
    b: FnBuilder,
    body: (local: Expr, c: ClassInfo, target: Target) => Expr,
  ): Expr {
    return {
      op: 'match-class',
      value,
      cases: classes.map((c, i) => {
        const local = b.local(`$${c.name}`, { record: c.record });
        return { record: c.record, local, body: body({ op: 'local', local }, c, targets[i]) };
      }),
    };
  }

  /** `obj.name` on an instance (of a class record or class reference type `t`). */
  read(t: Type, object: Expr, e: ts.PropertyAccessExpression, b: FnBuilder): Expr {
    return this.readMember(t, object, e.name, e, e, b);
  }

  /**
   * A member read by name: `obj.name` (`at` the access) or object
   * destructuring of an instance (`const { name } = obj`, `at` the binding
   * name, whose type is the read's).
   */
  readMember(
    t: Type,
    object: Expr,
    nameNode: ts.MemberName,
    at: ts.Node,
    typed: ts.Node,
    b: FnBuilder,
  ): Expr {
    const lower = this.lower;
    const name = nameNode.text;
    const e = at;
    const { classes, targets, shared } = this.targets(t, name, nameNode, e);
    const one = (recv: Expr, c: ClassInfo, target: Target): Expr => {
      switch (target.kind) {
        case 'field': {
          const f = target.field;
          // A derived field of a component-script class computes in that component.
          if (isDerived(f) && f.owner.component !== undefined && f.owner.component !== b.component)
            return this.fail(
              e,
              `${f.owner.name}.${name} is a derived field of a class declared in a component script; read it in that component (or declare the class in a .svelte.ts module)`,
            );
          if (isDerived(f)) {
            const deferred = this.deferred.get(f);
            if (deferred) throw deferred;
            this.readDerived.add(f);
          }
          const get: Expr = { op: 'get', object: recv, field: c.fields.indexOf(f) };
          if (f.late) return lateRead(f, get);
          // A nullable field TypeScript narrowed to its value here (as for variables).
          if (maybeInner(f.type)) {
            const here = lower.types.typeOrUndefined(typed);
            if (here !== undefined && here !== 'void' && !maybeInner(here))
              return { op: 'unwrap', value: get };
          }
          return get;
        }
        case 'accessor':
          if (target.get)
            return {
              op: 'call',
              function: target.get.fn!,
              args: [this.receiver(recv, b, target.owner, e)],
            };
          return this.fail(
            e,
            `${target.owner.name}.${name} has a setter but no getter: reading it gives undefined`,
          );
        case 'method':
          return this.fail(
            e,
            `${target.owner.name}.${name} is a method used as a value; its this would be undefined when called. Bind it (this.${name} = this.${name}.bind(this) in the constructor), use an arrow function field, or call it`,
          );
        case 'abstract':
          return this.fail(e, `${target.owner.name}.${name} is abstract`);
      }
    };
    let out: Expr;
    if (shared) out = one(object, classes[0], shared);
    else {
      const want = lower.types.of(typed);
      out = this.matchClasses(object, classes, targets, b, (local, c, target) => {
        const v = one(local, c, target);
        return this.fit(v, lower.irType(v, b), want);
      });
    }
    // Narrowed by TypeScript where it is read (`this.state instanceof C`).
    const have = lower.irType(out, b);
    if (!this.isClass(maybeInner(have) ?? have)) return out;
    return this.narrow(out, have, lower.types.typeOrUndefined(typed));
  }

  /** `obj.name(…)` on an instance (of class type `t`). */
  callMethod(
    t: Type,
    receiver: Expr,
    callee: ts.PropertyAccessExpression,
    e: ts.CallExpression,
    b: FnBuilder,
  ): Expr {
    const lower = this.lower;
    const name = callee.name.text;
    const { classes, targets, shared } = this.targets(t, name, callee.name, e);
    if (shared) {
      const c = classes[0];
      switch (shared.kind) {
        case 'field':
          // (A nullable function field where TypeScript narrowed it present:
          // bits-ui's SharedState `if (this.#scope && …) this.#scope()`.)
          return {
            op: 'call-value',
            callee: lower.calleeOf(
              lateRead(shared.field, {
                op: 'get',
                object: receiver,
                field: c.fields.indexOf(shared.field),
              }),
              b,
            ),
            args: lower.callArgs(e, b),
          };
        case 'method': {
          const method = shared.method;
          const recv = this.receiver(receiver, b, shared.owner, e);
          if (method.fn !== undefined)
            return { op: 'call', function: method.fn, args: [recv, ...lower.callArgs(e, b)] };
          // Untyped parameters: the receiver is bound first (evaluated before the arguments).
          const tmp = b.local('$receiver', this.selfType(shared.owner));
          const { fn, args } = this.untypedCall(method, shared.owner, e, b);
          return {
            op: 'with',
            local: tmp,
            value: recv,
            body: { op: 'call', function: fn, args: [{ op: 'local', local: tmp }, ...args] },
          };
        }
        case 'accessor':
          if (shared.get)
            return {
              op: 'call-value',
              callee: {
                op: 'call',
                function: shared.get.fn!,
                args: [this.receiver(receiver, b, shared.owner, e)],
              },
              args: lower.callArgs(e, b),
            };
          break;
        case 'abstract':
          return this.fail(e, `${shared.owner.name}.${name} is abstract`);
      }
      return lower.fail(e, 'E_MEMBER', `${c.name} has no method ${name}`);
    }
    // Dispatch by class: the receiver, then the arguments, are evaluated once.
    const recvLocal = b.local('$receiver', lower.irType(receiver, b));
    const args = lower.callArgs(e, b);
    const argLocals = args.map(a => b.local('$arg', lower.irType(a, b)));
    const want = lower.types.of(e);
    let body: Expr = this.matchClasses(
      { op: 'local', local: recvLocal },
      classes,
      targets,
      b,
      (local, c, target) => {
        const argValues = argLocals.map((l): Expr => ({ op: 'local', local: l }));
        let call: Expr;
        if (target.kind === 'method') {
          const fn = target.method.fn;
          if (fn === undefined)
            return this.fail(
              e,
              `${target.method.name} has untyped parameters and is overridden; add parameter types`,
            );
          const params = lower.functions[fn].params;
          call = {
            op: 'call',
            function: fn,
            args: [
              this.receiver(local, b, target.owner, e),
              ...argValues.map((v, i) =>
                this.fit(v, lower.irType(v, b), params[i + 1]?.type ?? lower.irType(v, b)),
              ),
            ],
          };
        } else if (target.kind === 'field')
          call = {
            op: 'call-value',
            callee: lower.calleeOf(
              lateRead(target.field, {
                op: 'get',
                object: local,
                field: c.fields.indexOf(target.field),
              }),
              b,
            ),
            args: argValues,
          };
        else if (target.kind === 'accessor' && target.get)
          call = {
            op: 'call-value',
            callee: {
              op: 'call',
              function: target.get.fn!,
              args: [this.receiver(local, b, target.owner, e)],
            },
            args: argValues,
          };
        else return lower.fail(e, 'E_MEMBER', `${c.name} has no method ${name}`);
        return this.fit(call, lower.irType(call, b), want);
      },
    );
    for (let i = args.length - 1; i >= 0; i--)
      body = { op: 'with', local: argLocals[i], value: args[i], body };
    return { op: 'with', local: recvLocal, value: receiver, body };
  }

  /**
   * `obj.name = value` on an instance or `C.name = value`, as statements;
   * undefined for objects that are not class instances.
   */
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
    const source = lower.sourceOf(target);
    const src = source ? { source } : {};
    if (target.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const { base, isStatic: inStatic } = this.superContext(target.expression);
      if (inStatic)
        return this.fail(
          target,
          'Static fields are module constants; assigning them is unsupported',
        );
      const t = this.resolve(base, name, this.privateOwner(target.name));
      if (t?.kind !== 'accessor' || !t.set)
        return this.fail(
          target,
          `super.${name} = … calls a setter of ${base.name}; it has none (assign this.${name})`,
        );
      const recv = this.thisValue(target.expression, b);
      const want = lower.functions[t.set.fn!].params[1]?.type;
      return [
        {
          op: 'expr',
          value: {
            op: 'call',
            function: t.set.fn!,
            args: [
              this.receiver(recv, b, t.owner, target),
              want ? this.fit(value, lower.irType(value, b), want) : value,
            ],
          },
          ...src,
        },
      ];
    }
    // (Also untyped JavaScript, and an instance TypeScript types by a
    // package's declaration of its class: the lowered value decides.)
    if (!this.tsClass(target.expression) && !this.untypedInstance(target.expression))
      return undefined;
    let object = lower.expr(target.expression, b);
    let t = lower.irType(object, b);
    // A nullable instance TypeScript has as present (`lower.tsPresent`):
    // writing through nullish throws a TypeError.
    const inner = maybeInner(t);
    if (inner !== undefined && this.isClass(inner) && lower.tsPresent(target.expression)) {
      object = { op: 'unwrap', value: object };
      t = inner;
    }
    if (!this.isClass(t)) return undefined;
    const { classes, targets, shared } = this.targets(t, name, target.name, target);
    const one = (recv: Expr, c: ClassInfo, x: Target, v: Expr): Stmt[] => {
      switch (x.kind) {
        case 'field': {
          if (isDerived(x.field))
            return this.fail(
              target,
              `${x.field.owner.name}.${name} is a $derived field; assigning it (overriding a derived value, Svelte 5.25+) is unsupported`,
            );
          return [
            {
              op: 'assign',
              target: { place: 'field', object: recv, field: c.fields.indexOf(x.field) },
              value: this.fit(v, lower.irType(v, b), x.field.type),
              ...src,
            },
          ];
        }
        case 'accessor': {
          if (!x.set)
            return this.fail(
              target,
              `${x.owner.name}.${name} has a getter but no setter: assigning it throws a TypeError`,
            );
          const want = lower.functions[x.set.fn!].params[1]?.type;
          return [
            {
              op: 'expr',
              value: {
                op: 'call',
                function: x.set.fn!,
                args: [
                  this.receiver(recv, b, x.owner, target),
                  want ? this.fit(v, lower.irType(v, b), want) : v,
                ],
              },
              ...src,
            },
          ];
        }
        case 'method':
          return this.fail(
            target,
            `Assigning method ${x.owner.name}.${name} is supported only at the start of the constructor (this.${name} = this.${name}.bind(this))`,
          );
        case 'abstract':
          return this.fail(
            target,
            `${x.owner.name}.${name} is abstract; assign it through a subclass type`,
          );
      }
    };
    if (shared) return one(object, classes[0], shared, value);
    // Setters dispatched by class (fields declared by each class separately cannot be).
    if (targets.some(x => x.kind !== 'accessor'))
      return this.fail(
        target,
        `${name} is declared separately by the classes this value can have; assigning it through their common type is unsupported (narrow it first)`,
      );
    const recvLocal = b.local('$receiver', t);
    const valueLocal = b.local('$value', lower.irType(value, b));
    const dispatch = this.matchClasses(
      { op: 'local', local: recvLocal },
      classes,
      targets,
      b,
      (local, c, x) => {
        const [s] = one(local, c, x, { op: 'local', local: valueLocal });
        return (s as { value: Expr }).value;
      },
    );
    return [
      {
        op: 'expr',
        value: {
          op: 'with',
          local: recvLocal,
          value: object,
          body: { op: 'with', local: valueLocal, value, body: dispatch },
        },
        ...src,
      },
    ];
  }

  /** The static member `name` of `info` or its base classes. */
  private findStatic(info: ClassInfo, name: string): { s: Static; owner: ClassInfo } | undefined {
    for (let x: ClassInfo | undefined = info; x; x = x.base) {
      const s = x.statics.get(name);
      if (s) return { s, owner: x };
    }
    return undefined;
  }

  /** The class declaration whose static member `this` (node) is in, if it is. */
  private staticContainer(node: ts.Node): ts.ClassDeclaration | undefined {
    const { container } = this.thisContainer(node);
    return container &&
      ts.isClassElement(container) &&
      isStatic(container) &&
      ts.isClassDeclaration(container.parent)
      ? container.parent
      : undefined;
  }

  /**
   * The class `this` (node) is in a static member of, where it names that
   * class: one without subclasses (on which a static member could be
   * called with another `this`).
   */
  staticThis(node: ts.Node): ClassInfo | undefined {
    const decl = this.staticContainer(node);
    if (!decl?.name) return undefined;
    const sym = this.lower.checker.getSymbolAtLocation(decl.name);
    const info = sym && this.bySymbol.get(sym);
    if (!info) return undefined;
    if (info.subclasses.length)
      return this.fail(
        node,
        `this in a static member of ${info.name}, which has subclasses, is the class it is called on; use the class name`,
      );
    return info;
  }

  /** `C.name = value` (or `this.name` in a static member) of an assigned static field. */
  staticWrite(info: ClassInfo, e: ts.PropertyAccessExpression, value: Expr, b: FnBuilder): Stmt[] {
    this.ensureDeclared(info, e);
    const found = this.findStatic(info, e.name.text);
    const s = found?.s;
    if (s?.kind !== 'cell') return this.fail(e, `${info.name}.${e.name.text} cannot be assigned`);
    // (Assigned through a subclass, JavaScript gives the subclass a field of
    // its own.)
    if (found!.owner !== info)
      return this.fail(
        e,
        `${info.name}.${e.name.text} is declared by ${found!.owner.name}: assigning it through ${info.name} would give ${info.name} a static field of its own; assign ${found!.owner.name}.${e.name.text}`,
      );
    const have = this.lower.irType(value, b);
    const fitted: Expr =
      maybeInner(s.type) && JSON.stringify(have) === JSON.stringify(maybeInner(s.type))
        ? { op: 'some', value }
        : value;
    return [
      {
        op: 'assign',
        target: { place: 'field', object: { op: 'global', global: s.global }, field: 0 },
        value: fitted,
      },
    ];
  }

  /** `C.name` */
  staticRead(info: ClassInfo, e: ts.PropertyAccessExpression, _b: FnBuilder): Expr {
    this.ensureDeclared(info, e);
    const found = this.findStatic(info, e.name.text);
    const s = found?.s;
    if (s?.kind === 'field') return { op: 'global', global: s.global };
    if (s?.kind === 'cell') {
      const read: Expr = { op: 'get', object: { op: 'global', global: s.global }, field: 0 };
      // Narrowed by TypeScript where it is read (after it was assigned).
      const here = this.lower.types.typeOrUndefined(e);
      return maybeInner(s.type) && here !== undefined && here !== 'void' && !maybeInner(here)
        ? { op: 'unwrap', value: read }
        : read;
    }
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
    const found = this.findStatic(info, callee.name.text);
    const s = found?.s;
    if (s?.kind === 'method') {
      if (s.method.fn !== undefined)
        return { op: 'call', function: s.method.fn, args: lower.callArgs(e, b) };
      const { fn, args } = this.untypedCall(s.method, found!.owner, e, b);
      return { op: 'call', function: fn, args };
    }
    if (s?.kind === 'field')
      return {
        op: 'call-value',
        callee: { op: 'global', global: s.global },
        args: lower.callArgs(e, b),
      };
    // A function held in a static field the class assigns (bits-ui's
    // `IsUsingKeyboard._cleanup?.()`): its value (through `?.`, the present one).
    if (s?.kind === 'cell')
      return { op: 'call-value', callee: lower.expr(callee, b), args: lower.callArgs(e, b) };
    return lower.fail(e, 'E_MEMBER', `${info.name} has no static method ${callee.name.text}`);
  }

  /** `new C(…)` */
  construct(info: ClassInfo, e: ts.NewExpression, b: FnBuilder): Expr {
    const lower = this.lower;
    this.ensureDeclared(info, e);
    if (info.abstract) return this.fail(e, `${info.name} is abstract; it cannot be constructed`);
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

  /**
   * `x instanceof C`: decided by the static type of `x` where it can be (a
   * class record, or a class reference whose classes all are or all are
   * not `C` or a subclass), else by a match over its classes.
   */
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
    const classes = this.classesOf(inner) ?? [];
    const yes = classes.filter(c => this.extendsClass(c, info));
    const maybe = maybeInner(t) !== undefined;
    if (classes.length && yes.length === classes.length && maybe)
      return {
        op: 'not',
        arg: { op: 'builtin', name: 'maybe.is-nullish', args: [v], type: 'boolean' },
      };
    if (!yes.length || yes.length === classes.length) {
      // Evaluated for its effects; the answer is static.
      const tmp = b.local('$instanceof', t);
      return { op: 'with', local: tmp, value: v, body: { op: 'lit', value: yes.length > 0 } };
    }
    const test = (value: Expr): Expr => ({
      op: 'match-class',
      value,
      cases: yes.map(c => ({
        record: c.record,
        local: b.local(`$${c.name}`, { record: c.record }),
        body: { op: 'lit', value: true },
      })),
      else: { op: 'lit', value: false },
    });
    if (!maybe) return test(v);
    const tmp = b.local('$instanceof', t);
    const read: Expr = { op: 'local', local: tmp };
    return {
      op: 'with',
      local: tmp,
      value: v,
      body: {
        op: 'cond',
        test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: 'boolean' },
        then: { op: 'lit', value: false },
        else: test({ op: 'unwrap', value: read }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // bind

  /** The exact class being constructed where `this` (node) is read, if any. */
  private constructedClass(node: ts.Node): ClassInfo | undefined {
    const { container } = this.thisContainer(node);
    return container ? this.lower.thisBindings.get(container)?.cls : undefined;
  }

  /**
   * `X.m.bind(…)` where `m` is a method of `X`'s classes (not a field holding
   * a function): the method, its declaring class and the receiver's
   * classes. With `info` (a constructor's early part), only when `X` is
   * its `this`.
   */
  private methodToBind(
    e: ts.Expression,
    info?: ClassInfo,
    temps?: Map<Field, number>,
  ): { method: Callable; owner: ClassInfo; classes: ClassInfo[] } | undefined {
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return undefined;
    if (e.expression.name.text !== 'bind') return undefined;
    const target = skipParens(e.expression.expression);
    if (!ts.isPropertyAccessExpression(target)) return undefined;
    const recv = skipParens(target.expression);
    const exact = recv.kind === ts.SyntaxKind.ThisKeyword ? this.constructedClass(recv) : undefined;
    let classes: ClassInfo[] | undefined;
    if (info && recv.kind === ts.SyntaxKind.ThisKeyword) classes = [info];
    else if (exact) classes = [exact];
    else if (this.tsClass(recv)) classes = this.classesOf(this.lower.types.of(recv));
    if (!classes?.length) return undefined;
    if (info && classes.some(c => c !== info)) return undefined;
    const name = target.name.text;
    const owner = this.privateOwner(target.name);
    // A method also bound into a field of its name (`this.m = this.m.bind(this)`)
    // is read from the prototype only until that field is set.
    let found: { method: Callable; owner: ClassInfo } | undefined;
    for (const c of classes) {
      const field = this.fieldNamed(c, target.name);
      if (field && (temps === undefined || temps.has(field))) return undefined;
      let m: { method: Callable; owner: ClassInfo } | undefined;
      if (name.startsWith('#')) {
        const method = owner?.members.get(name)?.method;
        m = method && owner ? { method, owner } : undefined;
      } else
        for (let x: ClassInfo | undefined = c; x && !m; x = x.base) {
          const member = x.members.get(name);
          if (member?.method) m = { method: member.method, owner: x };
          else if (member) break;
        }
      if (!m) return undefined;
      if (found && found.method !== m.method)
        return this.fail(
          e,
          `${name} is overridden by the classes this value can have; binding it through their common type is unsupported (bind it in the constructor, or use an arrow function field)`,
        );
      found = m;
    }
    return found && { ...found, classes };
  }

  /**
   * `obj.m.bind(x)` for a method `m` (a closure calling it with `x`), and
   * `f.bind(x)` for a function value (a new closure calling `f`; an arrow
   * function ignores `x`). Undefined for other `bind` calls.
   */
  bind(e: ts.CallExpression, b: FnBuilder, temps?: Map<Field, number>): Expr | undefined {
    const lower = this.lower;
    if (!ts.isPropertyAccessExpression(e.expression) || e.expression.name.text !== 'bind')
      return undefined;
    const target = skipParens(e.expression.expression);
    if (e.arguments.length !== 1) {
      const t = lower.types.typeOrUndefined(target);
      if (this.methodToBind(e, undefined, temps) || (typeof t === 'object' && 'fn' in t))
        return this.fail(
          e,
          'bind takes exactly the this value (partial application is unsupported)',
        );
      return undefined;
    }
    const thisArg = skipParens(e.arguments[0]);
    const bound = this.methodToBind(e, undefined, temps);
    if (bound) {
      const access = target as ts.PropertyAccessExpression;
      const { method, owner } = bound;
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
      // `this` while the instance is being built: the boxed early local.
      if (thisArg.kind === ts.SyntaxKind.ThisKeyword) {
        const early = this.earlyThis(thisArg);
        if (early) {
          const exact = early.cls ?? bound.classes[0];
          return {
            op: 'closure',
            function: this.boundMethod({ record: exact.record }, method, owner, true, thisArg),
            captures: [b.resolve(early.owner, early.local)],
          };
        }
      }
      const value = lower.expr(thisArg, b);
      const thisType = lower.irType(value, b);
      const ok =
        this.isClass(thisType) &&
        (this.classesOf(thisType) ?? []).every(c => this.extendsClass(c, owner));
      if (!ok)
        return this.fail(
          thisArg,
          `${owner.name}.${access.name.text} must be bound to a ${owner.name} instance`,
        );
      const tmp = b.local('$bound', thisType);
      return {
        op: 'with',
        local: tmp,
        value,
        body: {
          op: 'closure',
          function: this.boundMethod(thisType, method, owner, false, thisArg),
          captures: [tmp],
        },
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

  /** A function calling method `m` (declared by `owner`) with its captured receiver of type `recv` (a `maybe` one for `early`). */
  private boundMethod(
    recv: Type,
    m: Callable,
    owner: ClassInfo,
    early: boolean,
    at: ts.Node,
  ): number {
    const lower = this.lower;
    const plain = this.of(recv) === owner && !owner.subclasses.length;
    const key = `${m.name}${early ? '?' : ''}${plain ? '' : ` ${JSON.stringify(recv)}`}`;
    const known = this.bound.get(key);
    if (known !== undefined) return known;
    const target = lower.functions[m.fn!];
    const params = target.params.slice(1);
    const read: Expr = early
      ? { op: 'unwrap', value: { op: 'local', local: 0 } }
      : { op: 'local', local: 0 };
    const receiver = this.convert(read, recv, this.selfType(owner), at);
    const call: Expr = {
      op: 'call',
      function: m.fn!,
      args: [receiver, ...params.map((_, i) => ({ op: 'local', local: i + 1 }) as Expr)],
    };
    const index = lower.reserve();
    lower.functions[index] = {
      name: `${m.name} (bound)`,
      ...(owner.component !== undefined ? { component: owner.component } : {}),
      captures: [
        { name: 'this', type: early ? { maybe: recv } : recv, ...(early ? { boxed: true } : {}) },
      ],
      params: params.map(p => ({ name: p.name, type: p.type })),
      locals: [],
      result: target.result,
      body:
        target.result === 'void' ? [{ op: 'expr', value: call }] : [{ op: 'return', value: call }],
    };
    this.bound.set(key, index);
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
    if ('class' in t || 'classes' in t) {
      const [r] = this.members(t) ?? [];
      return r !== undefined ? this.records[r].name : undefined;
    }
    if ('record' in t) {
      if (seen.has(t.record)) return undefined;
      seen.add(t.record);
      const r = this.records[t.record];
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
    if ('class' in t || 'classes' in t) {
      for (const r of this.members(t) ?? []) {
        const found = this.rawThis({ record: r }, seen);
        if (found) return found;
      }
      return undefined;
    }
    if ('record' in t && !seen.has(t.record)) {
      seen.add(t.record);
      const info = this.byRecord.get(t.record);
      if (info?.rawThis) return info.name;
      for (const f of this.records[t.record].fields) {
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

/** `body` with every returned value wrapped into a Maybe. */
function wrapReturns(body: Stmt[]): Stmt[] {
  return body.map((s): Stmt => {
    switch (s.op) {
      case 'return':
        return s.value ? { ...s, value: { op: 'some', value: s.value } } : s;
      case 'if':
        return {
          ...s,
          then: wrapReturns(s.then),
          ...(s.else ? { else: wrapReturns(s.else) } : {}),
        };
      case 'while':
        return {
          ...s,
          body: wrapReturns(s.body),
          ...(s.update ? { update: wrapReturns(s.update) } : {}),
        };
      case 'for-of':
        return { ...s, body: wrapReturns(s.body) };
      case 'try':
        return {
          ...s,
          body: wrapReturns(s.body),
          ...(s.catch ? { catch: { ...s.catch, body: wrapReturns(s.catch.body) } } : {}),
          ...(s.finally ? { finally: wrapReturns(s.finally) } : {}),
        };
      default:
        return s;
    }
  });
}

function isDerived(f: Field): boolean {
  return f.rune?.kind === '$derived' || f.rune?.kind === '$derived.by';
}

function reactiveKind(r: Rune): 'state' | 'raw' | 'derived' {
  return r === '$state' ? 'state' : r === '$state.raw' ? 'raw' : 'derived';
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

/** The argument index at which a `super(…)` statement `s` passes the identifier `name`. */
function superArgIndex(s: ts.Statement, name: string): number | undefined {
  if (!superCallStatement(s)) return undefined;
  const args = ((s as ts.ExpressionStatement).expression as ts.CallExpression).arguments;
  const i = args.findIndex(
    a => ts.isIdentifier(skipParens(a)) && (skipParens(a) as ts.Identifier).text === name,
  );
  return i < 0 ? undefined : i;
}

/** Whether `s` is a `super(…)` call statement. */
function superCallStatement(s: ts.Statement): boolean {
  return (
    ts.isExpressionStatement(s) &&
    ts.isCallExpression(s.expression) &&
    s.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  );
}

/** A read `get` of field `f`: a late field (`lateFields`) holds its value once it is read. */
function lateRead(f: Field, get: Expr): Expr {
  return f.late ? { op: 'unwrap', value: get } : get;
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
