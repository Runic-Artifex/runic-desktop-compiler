// Unions outside the value model, narrowed by the values that reach them
// (docs/design/M6-OVERLAYS.md, "Decisions after step 1", layer 1).
//
// A union such as bits-ui's `PortalTarget = Element | string` has no IR
// type. Where every value that reaches a slot of the union belongs to one
// member, the union is that member program-wide: the census below finds the
// values flowing into slots whose type contains the union (assignments,
// initialisers, arguments, returns, properties of object literals, props at
// component sites, also nested in the types of boxes and getters) and
// classifies the type of each by the member it belongs to. Tests on the
// member (`typeof x === "string"`, `Array.isArray(x)`, `x instanceof
// HTMLElement`) are then known at build time (`Lowerer.staticTruth`).
//
// The census decides the member; it does not make the program typed. The
// lowered program is checked as any other: a value of another member that
// reaches a narrowed slot through code TypeScript cannot type is an IR type
// error, never a silent conversion. Where values of two members reach the
// union (a program with both an element and a selector target), it is
// rejected (`E_TYPE_UNION`), naming one site of each: compiling a component
// once per member is layer 2.
//
// A value's member is what it is built from, followed through the
// constructs that pass values on (`trace`): a prop takes the values its
// sites pass (a prop no site passes holds nothing), a box (svelte-toolbelt's
// `boxWith(getter)`, `simpleBox(v)`, `boxFrom(v)`: a call whose result has
// `current`) the values its getter returns or it is given and the values
// written to its `current`, an option property the values object literals
// give it, a constant its initialiser, `a ?? b` and `c ? a : b` their
// operands. bits-ui's anchor (`HTMLElement | Measurable`) is given a
// `Measurable` only from a `virtualEl` option no site passes, so only
// elements reach it. A union no member's value reaches (only null and
// undefined do: a `customAnchor` nobody passes) holds nothing else, so
// any member types it; it takes its first, and values typed by it reach no
// other union.
//
// Values pass through attribute bags too (2026-10-05): a spread of
// svelte-toolbelt's `mergeProps(…)` gives `style` a string where a later
// bag holds a style (mergeProps prints merged styles), and a component
// prop's default reaches the prop only where some site can omit it or pass
// undefined: a site passing the prop with a value that is never undefined,
// also through a bag known to hold it (rest props passed on, a mergeProps
// result), does not contribute the default (`mayBeAbsent`).
//
// Props are followed back to their sites (2026-10-06, `propFromSites`): a
// prop its component never writes, or an entry of its rest props, holds
// what the sites pass, through their bags, whatever the size of the props
// type (bits-ui's tooltip content passes `customAnchor ?? triggerNode` to
// the floating layer through two `mergeProps` bags and components whose
// props types the walk below does not search).
//
// A property TypeScript types `unknown` (bits-ui's tooltip trigger record's
// `payload`) is decided by its origins instead (`nothingSlot`): a value can
// only get into it where an object is built with the property (an object
// literal, unless its contextual type is another type) or where the property
// is written. Where every such value holds nothing (no trigger passes a
// payload), the property holds nothing but null and undefined. Passing
// whole objects on (maps of records, copies, getters) adds no values.
//
// Values TypeScript types `any` (untyped package JavaScript) that flow into
// such a slot are classified by what they are built from: the members of
// the literal arguments of the call producing them (bits-ui's
// `createPropResolver(…, "body")`), the default the untyped helper falls
// back to.
import ts from 'typescript';

type Fail = (node: ts.Node, code: string, message: string) => never;
type SourceOf = (node: ts.Node) => { file: string; line: number } | undefined;
/** The values a component prop receives from its sites (frontend/domains.ts), if finite. */
type PropValues = (sym: ts.Symbol) => unknown[] | undefined;

/** What the census found for one union. */
interface Census {
  /** The member each value belongs to, with a site of each. */
  members: Map<ts.Type, ts.Node>;
}

const F = ts.TypeFlags;
const nullish = (t: ts.Type) => !!(t.flags & (F.Null | F.Undefined | F.Void));
const id = (t: ts.Type) => (t as unknown as { id: number }).id;

/** The key of a union's non-nullish members. */
export function unionKey(parts: readonly ts.Type[]): string {
  return parts
    .filter(p => !nullish(p))
    .map(id)
    .sort((a, b) => a - b)
    .join('|');
}

export class Unions {
  private readonly checker: ts.TypeChecker;
  private readonly files: () => readonly ts.SourceFile[];
  private readonly sourceOf: SourceOf;
  private readonly propValues: PropValues;
  private readonly census = new Map<string, Census>();
  /** Unions resolved to a member, by key. */
  private readonly resolved = new Map<string, ts.Type>();
  /** Unions resolved to several members (an IR union type), by key. */
  private readonly united = new Map<string, ts.Type[]>();

  /**
   * A test's value where it is known at build time (`Lowerer.buildTimeTruth`):
   * the branch it rules out gives nothing.
   */
  private readonly decided: (test: ts.Expression) => boolean | undefined;

  /** Whether `t` is a class whose union the value model holds (`TypeMapper.sourceClass`). */
  private readonly isClass: (t: ts.Type) => boolean;

  /** Whether a prop is written by its component (undefined: not a declared prop). */
  private readonly propWritten: (sym: ts.Symbol) => boolean | undefined;

  /** Every file of the program, declaration files included. */
  private readonly allFiles: () => readonly ts.SourceFile[];

  constructor(
    checker: ts.TypeChecker,
    files: () => readonly ts.SourceFile[],
    sourceOf: SourceOf,
    propValues: PropValues,
    allFiles: () => readonly ts.SourceFile[] = files,
    propWritten: (sym: ts.Symbol) => boolean | undefined = () => undefined,
    decided: (test: ts.Expression) => boolean | undefined = () => undefined,
    isClass: (t: ts.Type) => boolean = () => false,
  ) {
    this.isClass = isClass;
    this.decided = decided;
    this.propWritten = propWritten;
    this.allFiles = allFiles;
    this.checker = checker;
    this.files = files;
    this.sourceOf = sourceOf;
    this.propValues = propValues;
  }

  /**
   * The member that union `parts` (its non-nullish members, at least two of
   * types the value model cannot unite) is narrowed to. Rejects the union
   * when the values reaching it belong to different members, or, with
   * dynamic values (`dynamic`), where none is found for a union untyped
   * JavaScript produces: the census sees values through the types code
   * gives them, which no declaration gives there (`return flag ? 1 :
   * 'one'`), so it is dynamic.
   */
  member(
    parts: readonly ts.Type[],
    at: ts.Node,
    fail: Fail,
    dynamic = false,
    unite: (found: ts.Type[]) => boolean = () => false,
  ): ts.Type | ts.Type[] {
    const key = unionKey(parts);
    const known = this.resolved.get(key);
    if (known) return known;
    const united = this.united.get(key);
    if (united) return united;
    const members = parts.filter(p => !nullish(p));
    const found = this.count(key, members).members;
    const text = (t: ts.Type) => this.checker.typeToString(t);
    const union = members.map(text).join(' | ');
    if (found.size === 1) {
      const [m] = found.keys();
      this.resolved.set(key, m);
      return m;
    }
    // TypeScript's `boolean` is the union `false | true`: values of those
    // two members only are booleans (bits-ui's `getCheckedState(checked:
    // boolean | "indeterminate")` given only booleans).
    if (found.size === 2 && [...found.keys()].every(m => m.flags & F.BooleanLiteral)) {
      const m = this.checker.getBooleanType();
      this.resolved.set(key, m);
      return m;
    }
    // Classes are one member: the value model holds a union of classes
    // compiled from source or given by a pack (a class reference,
    // `TypeMapper.classUnion`), so values of several of them type the union
    // as theirs (bits-ui's `DateValue | DateValue[]` reached by the three
    // `@internationalized/date` classes only).
    if (found.size > 1 && [...found.keys()].every(m => this.isClass(m))) {
      const m = (
        this.checker as unknown as { getUnionType(types: ts.Type[]): ts.Type }
      ).getUnionType([...found.keys()]);
      this.resolved.set(key, m);
      return m;
    }
    // Nothing but null and undefined reaches it: any member types it.
    if (!found.size && dynamic && this.untypedOrigin(at))
      return fail(at, 'E_TYPE_UNION', `Union ${union} is dynamic: no value reaching it was found`);
    if (!found.size) {
      this.resolved.set(key, members[0]);
      return members[0];
    }
    // Values of several members the value model unites (numbers, strings,
    // booleans, elements and one plain record, M6 unions): the union of
    // those members, whose values know their member at run time (bits-ui's
    // announcer given strings and numbers, its floating anchor given
    // elements and `Measurable` objects).
    if (unite([...found.keys()])) {
      const ms = [...found.keys()];
      this.united.set(key, ms);
      return ms;
    }
    const sites = [...found].map(([m, n]) => {
      const at = this.sourceOf(n);
      return `${text(m)} at ${at ? `${at.file}:${at.line}` : 'an unknown site'}`;
    });
    return fail(
      at,
      'E_TYPE_UNION',
      `Union ${union} is outside the value model: values of several members reach it (${sites.join(', ')}); compiling per member is not supported yet`,
    );
  }

  /**
   * Whether instances of class `t` are instances of class `m`: `t` is `m`
   * (another instantiation of it where TypeScript assigns it) or extends it.
   */
  private extendsClass(t: ts.Type, m: ts.Type, depth = 0): boolean {
    if (t.symbol && t.symbol === m.symbol) return this.checker.isTypeAssignableTo(t, m);
    if (depth > 16 || !(t.flags & F.Object)) return false;
    const declared = ((t as ts.TypeReference).target ?? t) as ts.InterfaceType;
    if (!(declared.objectFlags & ts.ObjectFlags.ClassOrInterface)) return false;
    return this.checker.getBaseTypes(declared).some(b => this.extendsClass(b, m, depth + 1));
  }

  private readonly slotCache = new Map<ts.Declaration, ts.Node | null>();

  /**
   * Whether only null and undefined reach the property declared by `decl`
   * (TypeScript types it `unknown`): every object literal giving a property
   * of its name, except literals whose contextual type is a type without it,
   * and every write of it, give values that hold nothing.
   */
  nothingSlot(decl: ts.Declaration): boolean {
    return this.slotValue(decl) === null;
  }

  /**
   * Whether only null and undefined reach the `current` of the boxes held by
   * the property declared by `decl` (bits-ui's trigger options' `payload:
   * ReadableBox<unknown>`): every box given to it holds nothing (a getter of
   * a prop no site passes), and nothing writes its `current`.
   */
  nothingInBoxes(decl: ts.Declaration): boolean {
    const index = this.properties();
    const given = index.given.get(decl) ?? [];
    const written = index.writes.get(decl) ?? [];
    const name = (decl as ts.NamedDeclaration).name;
    if (!given.length) {
      const text = name && ts.isIdentifier(name) ? name.text : '';
      const plain = plainProperty(decl);
      return (
        plain &&
        !(written.length || index.spread.has(decl) || index.named.has(text) || index.named.has('*'))
      );
    }
    return (
      given.every(g => {
        const t = this.trace(g, ['current'], 0, true);
        return !!t && t.length === 0;
      }) && written.every(w => this.nothing(w))
    );
  }

  /**
   * The type of the functions given to the property declared by `decl`
   * (typed as any function; `box`: boxes of functions, by the function
   * their `current` holds), where every value the program gives it is a
   * function of one type without `any` and nothing else may fill it (a
   * write, a spread, an untyped literal of its name); undefined otherwise.
   * A given value TypeScript types with `any` (a getter box of a prop
   * typed `(...args: any[]) => void`, bits-ui's PinInput `onComplete:
   * boxWith(() => onComplete)`) is followed to the values it is built from
   * (`trace`: the prop's sites and its default, `noop` where no site
   * passes one).
   */
  anyFnSlot(decl: ts.Declaration, box = false): ts.Type | undefined {
    const index = this.properties();
    const given = index.given.get(decl) ?? [];
    const name = (decl as ts.NamedDeclaration).name;
    const text = name && ts.isIdentifier(name) ? name.text : '';
    if (
      !given.length ||
      index.writes.get(decl)?.length ||
      index.spread.has(decl) ||
      index.untyped.has(text)
    )
      return undefined;
    const types: ts.Type[] = [];
    const anyIn = (x: ts.Type) => !!(x.flags & (F.Any | F.Unknown));
    /** Whether `t` is a function of one signature without `any`. */
    const typed = (t: ts.Type) => {
      const [sig, ...more] = t.getCallSignatures();
      return (
        !!sig &&
        !more.length &&
        !this.checker.getPropertiesOfType(t).length &&
        !anyIn(sig.getReturnType()) &&
        !sig.parameters.some(p => {
          const pt = this.checker.getTypeOfSymbol(p);
          // (`...args: any[]`.)
          return (
            anyIn(pt) ||
            (this.checker.isArrayType(pt) &&
              anyIn(this.checker.getTypeArguments(pt as ts.TypeReference)[0]))
          );
        })
      );
    };
    // (A function value TypeScript types without `any`: a literal, or a
    // call's typed result such as `$effect.root(…)`'s cleanup.)
    // (`box`: boxes, by the function their `current` holds, bits-ui's
    // `onSelect: boxWith(() => onSelect)`.)
    for (const g of given) {
      const whole = this.checker.getTypeAtLocation(skipAll(g));
      const current = box ? whole.getProperty('current') : undefined;
      if (box && !current) return undefined;
      const t = current ? this.checker.getTypeOfSymbol(current) : whole;
      if (typed(t)) {
        types.push(t);
        continue;
      }
      // (Typed with `any`: the functions it is built from, also through
      // the box's getter. A value that holds nothing, null or undefined
      // only, gives no type.)
      const traced = this.trace(g, box ? ['current'] : [], 0);
      if (!traced?.length || !traced.every(typed)) return undefined;
      types.push(...traced);
    }
    const [first] = types;
    const same = (a: ts.Type, b: ts.Type) =>
      this.checker.isTypeAssignableTo(a, b) && this.checker.isTypeAssignableTo(b, a);
    return types.every(t => same(t, first)) ? first : undefined;
  }

  /** A site giving the property declared by `decl` a value, or null. */
  private slotValue(decl: ts.Declaration): ts.Node | null {
    const cached = this.slotCache.get(decl);
    if (cached !== undefined) return cached;
    this.slotCache.set(decl, null);
    const name = (decl as ts.NamedDeclaration).name;
    if (!name || !ts.isIdentifier(name)) return decl;
    const isSlot = (p: ts.Symbol) => {
      const target = (p as unknown as { target?: ts.Symbol }).target ?? p;
      return (target.valueDeclaration ?? target.declarations?.[0]) === decl;
    };
    const holder = (ctx: ts.Type) =>
      (ctx.isUnion() ? ctx.types : [ctx]).some(t =>
        this.checker.getPropertiesOfType(t).some(isSlot),
      );
    const unrelated = (ctx: ts.Type | undefined) =>
      !!ctx && !(ctx.flags & (F.Any | F.Unknown)) && !holder(ctx);
    let found: ts.Node | null = null;
    const gives = (value: ts.Expression) => {
      if (!found && !this.nothing(value)) found = value;
    };
    for (const sf of this.files()) {
      const visit = (n: ts.Node) => {
        if (found) return;
        const ctx = ts.isObjectLiteralExpression(n) ? this.checker.getContextualType(n) : undefined;
        if (ts.isObjectLiteralExpression(n) && !unrelated(ctx))
          for (const p of n.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText() === name.text) gives(p.initializer);
            else if (ts.isShorthandPropertyAssignment(p) && p.name.text === name.text) {
              // (The variable it names: a constant's initialiser.)
              const v = this.checker.getShorthandAssignmentValueSymbol(p)?.valueDeclaration;
              if (
                v &&
                ts.isVariableDeclaration(v) &&
                v.initializer &&
                ts.getCombinedNodeFlags(v) & ts.NodeFlags.Const
              )
                gives(v.initializer);
              else found ??= p;
            }
            // A spread of an object with the property, or of an untyped one
            // into an object of the property's type.
            else if (ts.isSpreadAssignment(p)) {
              const t = this.checker.getTypeAtLocation(p.expression);
              const untyped = !!(t.flags & (F.Any | F.Unknown));
              if (t.getProperty(name.text) || (untyped && ctx && holder(ctx))) found = p;
            }
          }
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(skip(n.left)) &&
          (skip(n.left) as ts.PropertyAccessExpression).name.text === name.text
        )
          gives(n.right);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    this.slotCache.set(decl, found);
    return found;
  }

  /** The member a narrowed union stands for, if `t` (or its non-nullish part) is one. */
  narrowed(t: ts.Type): ts.Type | undefined {
    const parts = t.isUnion() ? t.types : [t];
    return this.resolved.get(unionKey(parts));
  }

  /**
   * Whether TypeScript infers the type at `at` from untyped JavaScript: a
   * function of a JavaScript file (its result), an expression there that
   * computes a value (not a name or a member, whose types declarations may
   * give), or a call of a function declared there.
   */
  private untypedOrigin(at: ts.Node): boolean {
    const js = (n: ts.Node) => /\.[cm]?js$/.test(n.getSourceFile().fileName);
    const call = ts.isExpression(at) ? skip(at) : at;
    if (js(at)) {
      if (ts.isFunctionLike(at)) return true;
      if (
        !ts.isExpression(call) ||
        ts.isIdentifier(call) ||
        ts.isPropertyAccessExpression(call) ||
        ts.isElementAccessExpression(call)
      )
        return false;
      if (!ts.isCallExpression(call)) return true;
    }
    if (!ts.isCallExpression(call)) return false;
    let sym = this.checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression,
    );
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
    const decl = sym?.valueDeclaration;
    return !!decl && js(decl);
  }

  private count(key: string, members: ts.Type[]): Census {
    const done = this.census.get(key);
    if (done) return done;
    const census: Census = { members: new Map() };
    this.census.set(key, census);
    this.counting.add(key);
    const record = (m: ts.Type, n: ts.Node) => {
      if (!census.members.has(m)) census.members.set(m, n);
    };
    /** The member `t` (one non-nullish type) belongs to. */
    // (TypeScript may type a value wider than the member it is, `() => string`
    // for `() => Placement`: then the one member of its kind.)
    const kind = (t: ts.Type): string =>
      t.getCallSignatures().length
        ? 'function'
        : t.flags & F.StringLike
          ? 'string'
          : t.flags & F.NumberLike
            ? 'number'
            : t.flags & F.BooleanLike
              ? 'boolean'
              : this.checker.isArrayType(t) || this.checker.isTupleType(t)
                ? 'array'
                : 'object';
    const isElement = (t: ts.Type) => !!t.getProperty('__runicElement');
    const memberOf = (t: ts.Type) => {
      // An element is an opaque handle, never a member of another kind it
      // is structurally assignable to (an HTMLElement is a floating-ui
      // `Measurable`): where TypeScript reduced the union's element member
      // away (`customAnchor ?? triggerNode` is `string | Measurable`), the
      // element stands for itself.
      if (isElement(t) && !members.some(isElement)) return t;
      // An instance of a class is one of its own class or of a class it
      // extends, not of another class it is structurally assignable to (a
      // Moment with Day's fields is no Day): the value model tells classes
      // apart (`TypeMapper.classUnion`).
      const exact = members.find(
        m =>
          m === t ||
          (this.isClass(t) && this.isClass(m)
            ? this.extendsClass(t, m)
            : this.checker.isTypeAssignableTo(t, m)),
      );
      if (exact) return exact;
      // (Where TypeScript lets it stand for another class only by its
      // shape, it stands for itself, as an element does: counted, never
      // dropped.)
      if (
        this.isClass(t) &&
        members.some(m => this.isClass(m) && this.checker.isTypeAssignableTo(t, m))
      )
        return t;
      // (Objects and arrays are told apart by their shapes only.)
      if (kind(t) === 'object' || kind(t) === 'array') return undefined;
      const same = members.filter(m => kind(m) === kind(t));
      return same.length === 1 ? same[0] : undefined;
    };
    // Empty array literals (`emptyArrays`, 2026-10-13). TypeScript types
    // `[]` as `never[]`, which the value model cannot type, so a union such
    // as `never[] | HTMLElement[]` (bits-ui's SafePolygon `#transitTargets
    // = []`, later assigned `cond ? targets.filter(…) : []`) would count two
    // members. A value of `never[]` is an array without items (no value has
    // type never), and an array without items is a value of every array
    // type, so where the `never[]` values are fresh literals the union can
    // take its other array member exactly. Freshness is what makes it
    // exact: arrays are shared references with identity (docs/IR.md,
    // `JsRef<Vec<T>>`), so one array object that reached both a `string[]`
    // and an `HTMLElement[]` slot could not be represented, and a push
    // through one would be visible through the other. A literal `[]`
    // evaluated where it is the value passed on (the whole value, or an
    // operand of `c ? a : b`, `a ?? b`, `a || b`) creates a new array that
    // no other reference holds, so the slot is its only holder: every read
    // and write of it goes through the slot's type (the member taken),
    // which the lowered program is checked against as any other. `never[]`
    // values of another origin (a variable, a call's result) may be shared
    // and still count as the `never[]` member. Without an array member of
    // another element type nothing changes.
    const arrays = members.filter(
      m =>
        this.checker.isArrayType(m) &&
        !(this.checker.getTypeArguments(m as ts.TypeReference)[0]?.flags & F.Never),
    );
    /** The site of a fresh empty array literal reaching the union. */
    let empty: ts.Node | undefined;
    const emptyLiteral = (x: ts.Expression) => ts.isArrayLiteralExpression(x) && !x.elements.length;
    /** The operands `e` passes on as its value (`c ? a : b`, `a ?? b`, `a || b`). */
    const operands = (e: ts.Expression): ts.Expression[] => {
      const x = skipAll(e);
      if (ts.isConditionalExpression(x)) {
        const d = this.decided(x.condition);
        return d === undefined
          ? [...operands(x.whenTrue), ...operands(x.whenFalse)]
          : operands(d ? x.whenTrue : x.whenFalse);
      }
      if (
        ts.isBinaryExpression(x) &&
        (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          x.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      )
        return [...operands(x.left), ...operands(x.right)];
      return [x];
    };
    const classify = (actual: ts.Type, n: ts.Node, e: ts.Expression, path: string[]) => {
      // A fresh empty array literal is a value of every array member
      // (`emptyArrays`): its site is kept aside, the other operands of
      // the operators that pass one of them on are classified each.
      if (arrays.length && !path.length) {
        const parts = operands(e);
        if (parts.some(emptyLiteral)) {
          for (const p of parts)
            if (emptyLiteral(p)) empty ??= p;
            else classify(this.checker.getTypeAtLocation(p), n, p, path);
          return;
        }
      }
      // What the value is built from.
      const traced = this.trace(e, path, 0);
      if (traced) {
        for (const t of traced)
          for (const p of (t.isUnion() ? t.types : [t]).filter(p => !nullish(p))) {
            const m = memberOf(p);
            if (m) record(m, n);
          }
        return;
      }
      if (actual.flags & (F.Any | F.Unknown)) {
        // Untyped code: the members of the literal arguments of the call.
        const call = skip(e);
        if (ts.isCallExpression(call) || ts.isNewExpression(call))
          for (const a of call.arguments ?? []) {
            const at = this.checker.getTypeAtLocation(a);
            if (!(at.flags & (F.Any | F.Unknown)) && isLiteralLike(a)) {
              const m = memberOf(this.checker.getBaseTypeOfLiteralType(at));
              if (m) record(m, a);
            }
          }
        return;
      }
      let parts = (actual.isUnion() ? actual.types : [actual]).filter(p => !nullish(p));
      if (unionKey(parts) === key) return;
      // A union already narrowed stands for its member; another union
      // (another instantiation of the same one: bits-ui's snippet props
      // through `Expand<…>`) for the members its own census finds.
      let narrowed = this.resolved.get(unionKey(parts));
      const other = unionKey(parts);
      if (
        !narrowed &&
        parts.length > 1 &&
        parts.every(p => memberOf(p)) &&
        !this.counting.has(other)
      ) {
        const found = [...this.count(other, parts).members.keys()];
        if (!found.length) return;
        if (found.length === 1) narrowed = found[0];
      }
      if (narrowed) parts = [narrowed];
      for (const p of parts) {
        const m = memberOf(p);
        if (m) record(m, n);
      }
    };
    const seen = new Set<string>();
    const walk = (
      ctx: ts.Type,
      actual: ts.Type,
      n: ts.Node,
      e: ts.Expression,
      depth: number,
      path: string[],
    ) => {
      if (depth > 4) return;
      const pair = `${id(ctx)}:${id(actual)}`;
      if (seen.has(pair)) return;
      seen.add(pair);
      const ctxParts = (ctx.isUnion() ? ctx.types : [ctx]).filter(p => !nullish(p));
      if (ctx.isUnion() && unionKey(ctxParts) === key) return classify(actual, n, e, path);
      for (const c of ctxParts) {
        if (!this.contains(c, key, 0)) continue;
        if (actual.flags & (F.Any | F.Unknown)) {
          classify(actual, n, e, path);
          continue;
        }
        const actualParts = (actual.isUnion() ? actual.types : [actual]).filter(p => !nullish(p));
        for (const a of actualParts) {
          for (const p of this.checker.getPropertiesOfType(c)) {
            const pt = this.checker.getTypeOfSymbol(p);
            if (!this.contains(pt, key, 0)) continue;
            const q = this.checker.getPropertyOfType(a, p.name);
            if (q) walk(pt, this.checker.getTypeOfSymbol(q), n, e, depth + 1, [...path, p.name]);
            // (An object literal whose TypeScript type lacks the property, as
            // a spread of svelte-toolbelt's merged props does: what it holds
            // there, followed through its spreads.)
            else if (ts.isObjectLiteralExpression(skip(e))) classify(pt, n, e, [...path, p.name]);
          }
          const cs = c.getCallSignatures();
          const as = a.getCallSignatures();
          if (cs.length === 1 && as.length === 1)
            walk(cs[0].getReturnType(), as[0].getReturnType(), n, e, depth + 1, [...path, '()']);
        }
      }
    };
    for (const sf of this.files()) {
      const visit = (n: ts.Node) => {
        // A class no code outside it names is never instantiated: its code
        // gives nothing (bits-ui's `FloatingAnchorState`, created only by
        // an anchor component the tooltip does not render).
        if (ts.isClassDeclaration(n) && this.unreferencedClass(n)) return;
        // A prop's default, where no site can leave the prop undefined:
        // it never takes effect.
        if (ts.isBindingElement(n) && n.initializer && this.unusedDefault(n)) {
          ts.forEachChild(n.initializer, visit);
          return;
        }
        // A branch a test decided at build time rules out gives nothing.
        if (ts.isConditionalExpression(n) || ts.isIfStatement(n)) {
          const test = ts.isIfStatement(n) ? n.expression : n.condition;
          const d = this.decided(test);
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
        // (Not a property's name: `"key": value` gives the value.)
        const named =
          !!n.parent &&
          (ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent)) &&
          n.parent.name === n;
        if (ts.isExpression(n) && !ts.isPartOfTypeNode(n) && !named) {
          const ctx = this.checker.getContextualType(n);
          if (ctx && this.contains(ctx, key, 0)) {
            seen.clear();
            walk(ctx, this.checker.getTypeAtLocation(n), n, n, 0, []);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    // Fresh empty arrays join the array member other values reach, or,
    // where none does, the first array member.
    if (empty && ![...census.members.keys()].some(m => arrays.includes(m)))
      record(arrays[0], empty);
    this.counting.delete(key);
    return census;
  }

  /**
   * Whether `e` only ever holds null or undefined: what it is built from
   * gives nothing else (a prop no site passes, a box whose getter returns
   * one). Code that tests it is decided at build time.
   */
  nothing(e: ts.Expression): boolean {
    const t = this.trace(e, [], 0, true);
    return !!t && t.length === 0;
  }

  /**
   * Whether `e` is never null or undefined: every value it is built from is
   * of a type without them (shadcn-svelte's Command group `value ?? heading
   * ?? \`----${useId()}\`` where every site passes a heading).
   */
  present(e: ts.Expression): boolean {
    e = skipAll(e);
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || ts.isTemplateExpression(e))
      return true;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      return this.present(e.left) || this.present(e.right);
    // A prop: every site passes it (or it has a default), and the values it
    // takes are never null or undefined. (The trace leaves a site out where
    // the prop is absent: `mayBeAbsent`.)
    if (!ts.isIdentifier(e)) return false;
    const decl = this.symbol(e)?.valueDeclaration;
    if (!decl || !ts.isBindingElement(decl) || decl.dotDotDotToken) return false;
    const key =
      decl.propertyName && ts.isIdentifier(decl.propertyName)
        ? decl.propertyName.text
        : ts.isIdentifier(decl.name)
          ? decl.name.text
          : undefined;
    const sf = decl.getSourceFile();
    if (!key || this.propsPattern(sf)?.byKey.get(key) !== decl) return false;
    if (!decl.initializer && this.mayBeAbsent(sf, key, 0)) return false;
    // (A value the trace does not follow, such as an `{#each}` item's
    // field: its TypeScript type, which the IR types it by.)
    this.typedLeaves = true;
    let t: ts.Type[] | undefined;
    try {
      t = this.trace(e, [], 0, true);
    } finally {
      this.typedLeaves = false;
    }
    return (
      !!t &&
      t.length > 0 &&
      t.every(
        x =>
          !(x.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void)) &&
          this.checker.getNonNullableType(x) === x,
      )
    );
  }

  /**
   * The expressions whose values `option.current` holds (M6 images: bits-ui's
   * `this.opts.src.current`), where `option` is a property every object
   * literal of the program gives a getter box (svelte-toolbelt's
   * `boxWith(() => v)`, a getter that only returns) and nothing writes
   * through or fills by a spread: what the getters return. Undefined
   * otherwise.
   */
  boxedSources(e: ts.PropertyAccessExpression): ts.Expression[] | undefined {
    if (e.name.text !== 'current') return undefined;
    const option = skipAll(e.expression);
    if (!ts.isPropertyAccessExpression(option)) return undefined;
    const sym = this.symbol(option.name);
    const decl = sym && declarationOf(sym);
    if (!decl) return undefined;
    const index = this.properties();
    const given = index.given.get(decl) ?? [];
    if (!given.length || index.writes.get(decl)?.length || index.spread.has(decl)) return undefined;
    const out: ts.Expression[] = [];
    for (const g of given) {
      const box = skipAll(g);
      if (
        !ts.isCallExpression(box) ||
        box.arguments.length !== 1 ||
        !this.isBox(this.checker.getTypeAtLocation(box))
      )
        return undefined;
      const getter = skipAll(box.arguments[0]);
      if (!ts.isArrowFunction(getter) && !ts.isFunctionExpression(getter)) return undefined;
      if (
        ts.isBlock(getter.body) &&
        !(getter.body.statements.length === 1 && ts.isReturnStatement(getter.body.statements[0]))
      )
        return undefined;
      out.push(...returned(getter));
    }
    return out;
  }

  /** `present`: values the trace does not follow count by their TypeScript type. */
  private typedLeaves = false;

  /** Unions whose census is being taken. */
  private readonly counting = new Set<string>();

  /**
   * The types of the values `e` is built from, at `path` inside it (a
   * box's `current`), following the constructs that pass values on (see
   * the header); undefined where it cannot tell (the caller takes
   * TypeScript's type of the value). `strict`: only what no code it
   * cannot see changes (getter boxes, props; not writable boxes, which
   * escape to code that writes them, nor unions without a member), for
   * deciding code at build time (`nothing`).
   */
  private trace(
    e: ts.Expression,
    path: string[],
    depth: number,
    strict = false,
  ): ts.Type[] | undefined {
    if (depth > 40) return undefined;
    e = skipAll(e);
    const K = ts.SyntaxKind;
    const all = (parts: (ts.Type[] | undefined)[]) =>
      parts.some(p => p === undefined) ? undefined : (parts as ts.Type[][]).flat();
    // An operand: what it is built from, or else TypeScript's type of it.
    const orType = (x: ts.Expression) =>
      this.trace(x, [], depth + 1, strict) ?? [this.checker.getTypeAtLocation(x)];
    // A derived value (`$derived(v)`, `$derived.by(f)`): what it computes,
    // at the same path.
    if (ts.isCallExpression(e) && e.arguments.length === 1) {
      const callee = e.expression.getText();
      const arg = skipAll(e.arguments[0]);
      if (callee === '$derived') return this.trace(arg, path, depth + 1, strict);
      if (callee === '$derived.by' && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)))
        return all(
          returned(arg, this.decided).map(
            r =>
              this.trace(r, path, depth + 1, strict) ??
              (path.length ? undefined : [this.checker.getTypeAtLocation(r)]),
          ),
        );
    }
    if (!path.length) {
      if (e.kind === K.NullKeyword || ts.isVoidExpression(e)) return [];
      if (ts.isIdentifier(e) && e.text === 'undefined' && !this.declared(e)) return [];
      // A value built here: its own type.
      if (isLiteralLike(e))
        return [this.checker.getBaseTypeOfLiteralType(this.checker.getTypeAtLocation(e))];
      if (
        ts.isObjectLiteralExpression(e) ||
        ts.isArrayLiteralExpression(e) ||
        ts.isArrowFunction(e) ||
        ts.isFunctionExpression(e) ||
        ts.isTemplateExpression(e)
      )
        return [this.checker.getTypeAtLocation(e)];
      if (ts.isConditionalExpression(e)) {
        const d = this.decided(e.condition);
        if (d !== undefined) return orType(d ? e.whenTrue : e.whenFalse);
        return all([orType(e.whenTrue), orType(e.whenFalse)]);
      }
      if (
        ts.isBinaryExpression(e) &&
        [K.QuestionQuestionToken, K.BarBarToken].includes(e.operatorToken.kind)
      )
        return all([orType(e.left), orType(e.right)]);
      if (ts.isIdentifier(e)) {
        const sym = this.symbol(e);
        if (!sym) return undefined;
        // A prop: the values its sites pass (only nullish ones: nothing).
        const values = this.propValues(sym);
        if (values && values.every(v => v === null || v === undefined)) return [];
        const init = this.constant(sym);
        if (init) return this.trace(init, [], depth + 1, strict);
        // A function declaration (bits-ui's `noop`): its own type. (The
        // language layer lowers its name as the function, and rejects
        // assignments to it.)
        if (sym.valueDeclaration && ts.isFunctionDeclaration(sym.valueDeclaration))
          return [this.checker.getTypeOfSymbol(sym)];
        // A prop: what its sites pass.
        const passed = this.propFromSites(sym, [], depth, strict);
        if (passed) return passed;
      }
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'current') {
        const inner = this.trace(e.expression, ['current'], depth + 1, strict);
        if (inner) return inner;
      }
      // A value typed by a union nothing but null and undefined reaches.
      if (!strict && this.empty(this.declaredType(e))) return [];
      if (this.typedLeaves) return [this.checker.getTypeAtLocation(e)];
      return undefined;
    }
    if (path[0] !== 'current') return this.traceEntry(e, path, depth, strict);
    const rest = path.slice(1);
    if (ts.isCallExpression(e) && this.isBox(this.checker.getTypeAtLocation(e))) {
      // A box made from a getter (one argument: no setter) or an initial
      // value (and what is written to it).
      if (e.arguments.length > 1) return undefined;
      if (!e.arguments.length) return strict ? undefined : [];
      const arg = skipAll(e.arguments[0]);
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
        // (Strict: a getter that only returns, so reading it does nothing else.)
        const only =
          !ts.isBlock(arg.body) ||
          (arg.body.statements.length === 1 && ts.isReturnStatement(arg.body.statements[0]));
        if (strict && !only) return undefined;
        return all(returned(arg, this.decided).map(r => this.trace(r, rest, depth + 1, strict)));
      }
      return strict ? undefined : this.trace(arg, rest, depth + 1);
    }
    if (ts.isIdentifier(e)) {
      const sym = this.symbol(e);
      const init = sym && this.constant(sym);
      if (init) return this.trace(init, path, depth + 1, strict);
      return sym && this.propFromSites(sym, path, depth, strict);
    }
    if (ts.isPropertyAccessExpression(e)) {
      // An option or field holding a box: the boxes given to it, and the
      // values written to their `current`.
      const sym = this.symbol(e.name);
      const decl = sym && declarationOf(sym);
      if (!decl) return undefined;
      const index = this.properties();
      const given = index.given.get(decl) ?? [];
      const written = index.writes.get(decl) ?? [];
      // Given by no object literal of the program and never written (nor
      // filled by a spread or an untyped literal of the name): nothing
      // reaches it (bits-ui's `FloatingAnchorState` options where no
      // anchor renders: its `virtualEl`).
      // (A plain property: a getter or a method gives what it computes.)
      if (!given.length) {
        const name = ts.isIdentifier(e.name) ? e.name.text : '';
        const plain = plainProperty(decl);
        if (
          !plain ||
          written.length ||
          index.spread.has(decl) ||
          index.named.has(name) ||
          index.named.has('*')
        )
          return undefined;
        return [];
      }
      if (strict && written.length) return undefined;
      const writes = written.map(w => this.trace(w, rest, depth + 1));
      return all([...given.map(g => this.trace(g, path, depth + 1, strict)), ...writes]);
    }
    return undefined;
  }

  /**
   * The values at `path` inside prop `sym` (a `$props()` binding of a
   * component its component never writes) or inside its rest props (at an
   * entry of a name the component does not declare): what the component's
   * sites pass, followed through their bags (a spread of mergeProps, rest
   * props passed on), and the prop's default where a site may leave it out.
   * Undefined for other names, a component without sites (the root) or a
   * site that cannot be followed.
   */
  private propFromSites(
    sym: ts.Symbol,
    path: string[],
    depth: number,
    strict: boolean,
  ): ts.Type[] | undefined {
    const decl = sym.valueDeclaration;
    if (!decl || !ts.isBindingElement(decl)) return undefined;
    const sf = decl.getSourceFile();
    const pattern = this.propsPattern(sf);
    if (!pattern) return undefined;
    let key: string | undefined;
    let inner = path;
    if (decl.dotDotDotToken) {
      if (pattern.rest !== sym || !path.length || path[0] === 'current') return undefined;
      [key, ...inner] = path;
      if (pattern.byKey.has(key)) return [];
    } else {
      key =
        decl.propertyName && ts.isIdentifier(decl.propertyName)
          ? decl.propertyName.text
          : ts.isIdentifier(decl.name)
            ? decl.name.text
            : undefined;
      if (!key || pattern.byKey.get(key) !== decl || this.propWritten(sym) !== false)
        return undefined;
    }
    const sites = this.sites().get(sf.fileName) ?? [];
    if (!sites.length) return undefined;
    const parts: (ts.Type[] | undefined)[] = sites.map(s =>
      this.bagHas(s, key, depth + 1) === 'absent'
        ? []
        : this.traceEntry(s, [key, ...inner], depth + 1, strict),
    );
    if (!decl.dotDotDotToken && decl.initializer && this.mayBeAbsent(sf, key, depth + 1))
      parts.push(this.trace(defaultOf(decl.initializer), inner, depth + 1, strict));
    return parts.some(p => p === undefined) ? undefined : (parts as ts.Type[][]).flat();
  }

  /**
   * The values at `path` (an entry, then what is inside it) of the bag or
   * object `e`: constants and `$derived(…)` followed, svelte-toolbelt's
   * `mergeProps(…)` (`style` is a string where a bag after the first holds
   * a style; other entries are the last bag's that holds them).
   */
  private traceEntry(
    e: ts.Expression,
    path: string[],
    depth: number,
    strict: boolean,
  ): ts.Type[] | undefined {
    e = skipAll(e);
    if (ts.isIdentifier(e)) {
      const sym = this.symbol(e);
      const init = sym && this.constant(sym);
      if (init) return this.trace(init, path, depth + 1, strict);
      return sym && this.propFromSites(sym, path, depth, strict);
    }
    // An object literal: the last property of the name (bits-ui's tooltip
    // content's `floatingProps`, whose `customAnchor ?? triggerNode`
    // TypeScript types as the reduced `string | Measurable`); a spread
    // that may hold it after that property makes it open.
    if (ts.isObjectLiteralExpression(e)) {
      const [name, ...rest] = path;
      // (The last entry holding the name; an earlier one where a spread
      // after it may not hold it, as for mergeProps.)
      const found: ts.Type[] = [];
      for (const p of [...e.properties].reverse()) {
        if (ts.isSpreadAssignment(p)) {
          const h = this.bagHas(p.expression, name, depth + 1);
          if (h === 'absent') continue;
          const t = this.trace(p.expression, path, depth + 1, strict);
          if (!t) return undefined;
          found.push(...t);
          if (h === 'present') return found;
          continue;
        }
        if (!p.name || p.name.getText().replace(/^["']|["']$/g, '') !== name) continue;
        let v: ts.Type[] | undefined;
        if (ts.isPropertyAssignment(p)) v = this.trace(p.initializer, rest, depth + 1, strict);
        // (A name: a constant's initialiser, a prop's sites.)
        else if (ts.isShorthandPropertyAssignment(p)) {
          const sym = this.checker.getShorthandAssignmentValueSymbol(p);
          const init = sym && this.constant(sym);
          v = init
            ? this.trace(init, rest, depth + 1, strict)
            : sym && this.propFromSites(sym, rest, depth + 1, strict);
        }
        return v && [...found, ...v];
      }
      return found;
    }
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    if (e.expression.text === '$derived' && e.arguments.length === 1)
      return this.trace(e.arguments[0], path, depth + 1, strict);
    if (!this.isMergeProps(e)) return undefined;
    const [key, ...inner] = path;
    if (key === 'style' && !inner.length) {
      const later = e.arguments.slice(1).map(a => this.bagHas(a, 'style', depth + 1));
      if (later.some(h => h === 'present')) return [this.checker.getStringType()];
      if (later.some(h => h === 'maybe')) return undefined;
    }
    // The last bag holding the entry (an earlier one where it may be undefined).
    const found: ts.Type[] = [];
    for (const a of [...e.arguments].reverse()) {
      const h = this.bagHas(a, key, depth + 1);
      if (h === 'absent') continue;
      const t =
        this.trace(a, path, depth + 1, strict) ??
        (() => {
          const prop = this.checker.getPropertyOfType(this.checker.getTypeAtLocation(a), key);
          return prop ? [this.checker.getTypeOfSymbol(prop)] : undefined;
        })();
      if (!t) return undefined;
      found.push(...t);
      if (h === 'present') return found;
    }
    return found;
  }

  private readonly referencedClasses = new Map<ts.ClassDeclaration, boolean>();

  /**
   * Whether no code of the program outside class `c` names it (by name, so
   * any mention counts: an import, a re-export, a type position).
   */
  private unreferencedClass(c: ts.ClassDeclaration): boolean {
    const name = c.name?.text;
    if (!name) return false;
    const known = this.referencedClasses.get(c);
    if (known !== undefined) return !known;
    let found = false;
    for (const sf of this.allFiles()) {
      if (sf.isDeclarationFile || found) continue;
      if (!sf.text.includes(name)) continue;
      const visit = (n: ts.Node) => {
        if (found || n === c) return;
        if (ts.isIdentifier(n) && n.text === name) found = true;
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    this.referencedClasses.set(c, found);
    return !found;
  }

  /** Whether `e` calls svelte-toolbelt's `mergeProps`. */
  private isMergeProps(e: ts.CallExpression): boolean {
    if (!ts.isIdentifier(e.expression) || e.expression.text !== 'mergeProps') return false;
    const decl = this.symbol(e.expression)?.declarations?.[0];
    return !!decl && /[\\/]svelte-toolbelt[\\/]/.test(decl.getSourceFile().fileName);
  }

  /**
   * Whether bag (or object) `e` holds entry `key`: with a value that is
   * never undefined (`present`), possibly (`maybe`), or not at all.
   */
  private bagHas(e: ts.Expression, key: string, depth: number): 'present' | 'maybe' | 'absent' {
    if (depth > 60) return 'maybe';
    e = skipAll(e);
    if (ts.isIdentifier(e)) {
      const sym = this.symbol(e);
      const decl = sym?.valueDeclaration;
      // Rest props: what the component's sites pass under names it does
      // not declare.
      if (decl && ts.isBindingElement(decl) && decl.dotDotDotToken) {
        const pattern = this.propsPattern(decl.getSourceFile());
        if (pattern && pattern.rest === sym) {
          if (pattern.byKey.has(key)) return 'absent';
          // (No site passing it at all: absent, bits-ui's `child` where every
          // site gives content.)
          const sites = this.sites().get(decl.getSourceFile().fileName) ?? [];
          if (sites.length && sites.every(x => this.bagHas(x, key, depth + 1) === 'absent'))
            return 'absent';
          return this.mayBeAbsent(decl.getSourceFile(), key, depth + 1) ? 'maybe' : 'present';
        }
      }
      const init = sym && this.constant(sym);
      if (init) return this.bagHas(init, key, depth + 1);
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      if (e.expression.text === '$derived' && e.arguments.length === 1)
        return this.bagHas(e.arguments[0], key, depth + 1);
      if (this.isMergeProps(e)) {
        const all = e.arguments.map(a => this.bagHas(a, key, depth + 1));
        return all.includes('present') ? 'present' : all.includes('maybe') ? 'maybe' : 'absent';
      }
    }
    // A field holding a derived bag (bits-ui's `props = $derived.by(() =>
    // ({ … }))`): what its function returns.
    if (ts.isPropertyAccessExpression(e)) {
      const decl = this.symbol(e.name)?.valueDeclaration;
      const init = decl && ts.isPropertyDeclaration(decl) ? decl.initializer : undefined;
      const call = init && skipAll(init);
      if (call && ts.isCallExpression(call) && call.arguments.length === 1) {
        const rune = call.expression.getText();
        if (rune === '$derived') return this.bagHas(call.arguments[0], key, depth + 1);
        const fn = skipAll(call.arguments[0]);
        if (rune === '$derived.by' && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          const all = returned(fn).map(r => this.bagHas(r, key, depth + 1));
          if (all.length && all.every(h => h === 'present')) return 'present';
          if (all.length && all.every(h => h === 'absent')) return 'absent';
          return 'maybe';
        }
      }
    }
    if (ts.isObjectLiteralExpression(e)) {
      let state = 'absent' as 'present' | 'maybe' | 'absent';
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) {
          const h = this.bagHas(p.expression, key, depth + 1);
          if (h !== 'absent') state = h === 'present' || state === 'present' ? 'present' : 'maybe';
        } else if (
          p.name &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          p.name.text === key
        ) {
          const v = ts.isPropertyAssignment(p)
            ? p.initializer
            : ts.isShorthandPropertyAssignment(p)
              ? p.name
              : undefined;
          state = v && this.presentValue(v, depth + 1) ? 'present' : 'maybe';
        }
      }
      return state;
    }
    // Otherwise TypeScript's type of it.
    const t = this.checker.getTypeAtLocation(e);
    if (t.flags & (F.Any | F.Unknown)) return 'maybe';
    const prop = this.checker.getPropertyOfType(t, key);
    if (!prop) return this.checker.getIndexInfosOfType(t).length ? 'maybe' : 'absent';
    if (prop.flags & ts.SymbolFlags.Optional) return 'maybe';
    const pt = this.checker.getTypeOfSymbol(prop);
    return (pt.isUnion() ? pt.types : [pt]).some(
      p => p.flags & (F.Undefined | F.Void | F.Any | F.Unknown),
    )
      ? 'maybe'
      : 'present';
  }

  /** Whether value `e` (passed for a prop) is never undefined. */
  private presentValue(e: ts.Expression, depth: number): boolean {
    e = skipAll(e);
    if (ts.isIdentifier(e)) {
      const sym = this.symbol(e);
      const decl = sym?.valueDeclaration;
      // A prop of the passing component: never undefined where it has a
      // default other than undefined, or where its own sites never leave
      // it undefined.
      if (decl && ts.isBindingElement(decl) && !decl.dotDotDotToken) {
        const pattern = this.propsPattern(decl.getSourceFile());
        const key =
          decl.propertyName && ts.isIdentifier(decl.propertyName)
            ? decl.propertyName.text
            : sym!.name;
        if (pattern && pattern.byKey.get(key) === decl) {
          if (decl.initializer && this.presentValue(defaultOf(decl.initializer), depth + 1))
            return true;
          return !this.mayBeAbsent(decl.getSourceFile(), key, depth + 1);
        }
      }
    }
    const t = this.checker.getTypeAtLocation(e);
    if (t.flags & (F.Any | F.Unknown)) return false;
    return !(t.isUnion() ? t.types : [t]).some(p => p.flags & (F.Undefined | F.Void));
  }

  /** The `$props()` destructuring of a component's virtual module, by key, and its rest binding. */
  private propsPattern(
    sf: ts.SourceFile,
  ): { byKey: Map<string, ts.BindingElement>; rest?: ts.Symbol } | undefined {
    if (this.patterns.has(sf)) return this.patterns.get(sf);
    let found: { byKey: Map<string, ts.BindingElement>; rest?: ts.Symbol } | undefined;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (
        ts.isVariableDeclaration(n) &&
        ts.isObjectBindingPattern(n.name) &&
        n.initializer &&
        ts.isCallExpression(skipAll(n.initializer)) &&
        (skipAll(n.initializer) as ts.CallExpression).expression.getText() === '$props'
      ) {
        const byKey = new Map<string, ts.BindingElement>();
        let rest: ts.Symbol | undefined;
        for (const el of n.name.elements) {
          if (el.dotDotDotToken) rest = this.symbol(el.name);
          else {
            const key = el.propertyName
              ? (el.propertyName as ts.Identifier).text
              : (el.name as ts.Identifier).text;
            byKey.set(key, el);
          }
        }
        found = { byKey, rest };
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    this.patterns.set(sf, found);
    return found;
  }
  private readonly patterns = new Map<ts.SourceFile, ReturnType<Unions['propsPattern']>>();

  /** The object literals passing the props of the component of virtual module `file`, by file. */
  private sites(): Map<string, ts.ObjectLiteralExpression[]> {
    if (this.siteIndex) return this.siteIndex;
    const index = new Map<string, ts.ObjectLiteralExpression[]>();
    for (const sf of this.files()) {
      const visit = (n: ts.Node) => {
        // `((__p: __RunicProps_X) => 0)({ … })` (frontend/adapters/svelte.ts).
        if (
          ts.isCallExpression(n) &&
          n.arguments.length === 1 &&
          ts.isObjectLiteralExpression(n.arguments[0])
        ) {
          const fn = skipAll(n.expression);
          const param =
            ts.isArrowFunction(fn) && fn.parameters.length === 1 ? fn.parameters[0] : undefined;
          const typeRef =
            param?.type && ts.isTypeReferenceNode(param.type) ? param.type : undefined;
          if (param && ts.isIdentifier(param.name) && param.name.text === '__p' && typeRef) {
            const target = this.symbol(typeRef.typeName);
            const decl = target?.declarations?.[0];
            if (decl) {
              const file = decl.getSourceFile().fileName;
              const list = index.get(file) ?? [];
              list.push(n.arguments[0]);
              index.set(file, list);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    this.siteIndex = index;
    return index;
  }
  private siteIndex?: Map<string, ts.ObjectLiteralExpression[]>;

  /**
   * Whether some site of the component of virtual module `sf` can leave
   * prop `key` undefined: it passes nothing for it, or a value that may be
   * undefined (a component no site renders: the root).
   */
  private mayBeAbsent(sf: ts.SourceFile, key: string, depth: number): boolean {
    if (depth > 60) return true;
    const memo = `${sf.fileName}#${key}`;
    const known = this.absent.get(memo);
    if (known !== undefined) return known;
    this.absent.set(memo, true);
    const sites = this.sites().get(sf.fileName) ?? [];
    const result = !sites.length || sites.some(s => this.bagHas(s, key, depth + 1) !== 'present');
    this.absent.set(memo, result);
    return result;
  }
  private readonly absent = new Map<string, boolean>();

  /** Whether bag `e` (a spread at a component site) surely holds `key`, never undefined. */
  bagHolds(e: ts.Expression, key: string): boolean {
    return this.bagHas(e, key, 0) === 'present';
  }

  /** Whether `el` (a `$props()` binding with a default) is a prop whose default never takes effect. */
  unusedDefault(el: ts.BindingElement): boolean {
    if (el.dotDotDotToken) return false;
    const pattern = this.propsPattern(el.getSourceFile());
    const key =
      el.propertyName && ts.isIdentifier(el.propertyName)
        ? el.propertyName.text
        : ts.isIdentifier(el.name)
          ? el.name.text
          : undefined;
    if (!pattern || !key || pattern.byKey.get(key) !== el) return false;
    return !this.mayBeAbsent(el.getSourceFile(), key, 0);
  }

  /**
   * Whether the function prop (a snippet) declared by `decl`, a `$props()`
   * binding without a default, holds a function at every site (true: each
   * passes it, also through bags known to hold it, as bits-ui passes its
   * `child` snippet down through rest props and mergeProps) or at none
   * (false: no site's bag holds it); undefined otherwise.
   */
  functionPropPassed(decl: ts.Declaration): boolean | undefined {
    if (!ts.isBindingElement(decl) || decl.dotDotDotToken || decl.initializer) return undefined;
    const pattern = this.propsPattern(decl.getSourceFile());
    const key =
      decl.propertyName && ts.isIdentifier(decl.propertyName)
        ? decl.propertyName.text
        : ts.isIdentifier(decl.name)
          ? decl.name.text
          : undefined;
    if (!pattern || !key || pattern.byKey.get(key) !== decl) return undefined;
    const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(decl.name));
    if (t.isUnion() || !t.getCallSignatures().length) return undefined;
    const sites = this.sites().get(decl.getSourceFile().fileName) ?? [];
    if (!sites.length) return undefined;
    const held = sites.map(s => this.bagHas(s, key, 0));
    if (held.every(h => h === 'present')) return true;
    if (held.every(h => h === 'absent')) return false;
    return undefined;
  }

  /** Whether `t` is a svelte-toolbelt box (the `BoxSymbol` brand). */
  private isBox(t: ts.Type): boolean {
    return this.checker
      .getPropertiesOfType(t)
      .some(p => String(p.escapedName).startsWith('__@BoxSymbol@'));
  }

  private symbol(n: ts.Node): ts.Symbol | undefined {
    const s = this.checker.getSymbolAtLocation(n);
    return s && s.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(s) : s;
  }

  /** Whether an identifier names a declaration (`undefined` shadowed). */
  private declared(id: ts.Identifier): boolean {
    return !!this.symbol(id)?.valueDeclaration;
  }

  /** The initialiser of a `const` (never assigned), if `sym` is one. */
  private constant(sym: ts.Symbol): ts.Expression | undefined {
    const d = sym.valueDeclaration;
    return d &&
      ts.isVariableDeclaration(d) &&
      d.initializer &&
      ts.isVariableDeclarationList(d.parent) &&
      d.parent.flags & ts.NodeFlags.Const
      ? d.initializer
      : undefined;
  }

  /** TypeScript's declared (not narrowed) type of a name or member read. */
  private declaredType(e: ts.Expression): ts.Type | undefined {
    const name = ts.isPropertyAccessExpression(e) ? e.name : ts.isIdentifier(e) ? e : undefined;
    const sym = name && this.symbol(name);
    return sym && this.checker.getTypeOfSymbol(sym);
  }

  /** Whether `t` is (or holds as its value) a union only null and undefined reach. */
  private empty(t: ts.Type | undefined): boolean {
    if (!t || !t.isUnion()) return false;
    const members = t.types.filter(p => !nullish(p));
    if (members.length < 2) return false;
    const key = unionKey(members);
    if (this.counting.has(key)) return false;
    const census = this.census.get(key) ?? this.count(key, members);
    return census.members.size === 0;
  }

  private index?: {
    given: Map<ts.Declaration, ts.Expression[]>;
    writes: Map<ts.Declaration, ts.Expression[]>;
    /** Properties an object literal's spread may fill (by declaration). */
    spread: Set<ts.Declaration>;
    /** Property names object literals without a (typed) context give. */
    untyped: Set<string>;
    /**
     * Every property name the program gives anywhere: object literal entries
     * (any context), the properties of spread values, assignments.
     */
    named: Set<string>;
  };

  /**
   * By property declaration: the values given to it (object literal
   * properties whose contextual type declares it, class field initialisers,
   * assignments) and the values written to its `current` (`x.p.current = v`).
   */
  private properties() {
    if (this.index) return this.index;
    const given = new Map<ts.Declaration, ts.Expression[]>();
    const writes = new Map<ts.Declaration, ts.Expression[]>();
    const spread = new Set<ts.Declaration>();
    const untyped = new Set<string>();
    const named = new Set<string>();
    const add = (m: Map<ts.Declaration, ts.Expression[]>, d: ts.Declaration, v: ts.Expression) => {
      const list = m.get(d);
      if (list) list.push(v);
      else m.set(d, [v]);
    };
    const propertyDecl = (n: ts.PropertyAccessExpression) => {
      const s = this.symbol(n.name);
      return s && declarationOf(s);
    };
    for (const sf of this.files()) {
      const visit = (n: ts.Node) => {
        if (ts.isObjectLiteralExpression(n)) {
          for (const p of n.properties) {
            if (ts.isSpreadAssignment(p)) {
              const t = this.checker.getTypeAtLocation(p.expression);
              // (An untyped spread may give any name.)
              if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) named.add('*');
              for (const q of this.checker.getPropertiesOfType(t)) named.add(q.name);
            } else if (p.name) named.add(p.name.getText().replace(/^["']|["']$/g, ''));
          }
          const ctx = this.checker.getContextualType(n);
          if (!ctx || ctx.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
            for (const p of n.properties) {
              if (p.name && ts.isIdentifier(p.name)) untyped.add(p.name.text);
            }
          else if (n.properties.some(ts.isSpreadAssignment))
            for (const t of this.checker.getPropertiesOfType(ctx)) {
              const d = declarationOf(t);
              if (d) spread.add(d);
            }
          if (ctx)
            for (const p of n.properties) {
              const name = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
              const target = name && this.checker.getPropertyOfType(ctx, name);
              const d = target && declarationOf(target);
              if (!d) continue;
              if (ts.isPropertyAssignment(p)) add(given, d, p.initializer);
              else if (ts.isShorthandPropertyAssignment(p)) add(given, d, p.name);
            }
        } else if (ts.isPropertyDeclaration(n) && n.initializer) {
          const s = this.symbol(n.name);
          const d = s && declarationOf(s);
          if (d) add(given, d, n.initializer);
        } else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left)
        ) {
          const left = n.left;
          if (left.name.text === 'current' && ts.isPropertyAccessExpression(left.expression)) {
            const d = propertyDecl(left.expression);
            if (d) add(writes, d, n.right);
          } else {
            const d = propertyDecl(left);
            if (d) add(given, d, n.right);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    for (const sf of this.files()) {
      const assigned = (n: ts.Node) => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left)
        )
          named.add(n.left.name.text);
        ts.forEachChild(n, assigned);
      };
      assigned(sf);
    }
    this.index = { given, writes, spread, untyped, named };
    return this.index;
  }

  private readonly containsCache = new Map<string, boolean>();

  /** Whether type `t` holds the union `key` (as itself or in properties and results). */
  private contains(t: ts.Type, key: string, depth: number): boolean {
    if (depth > 3) return false;
    const cacheKey = `${key}@${id(t)}`;
    const known = this.containsCache.get(cacheKey);
    if (known !== undefined) return known;
    this.containsCache.set(cacheKey, false);
    let found = false;
    const parts = t.isUnion() ? t.types : [t];
    if (t.isUnion() && unionKey(parts) === key) found = true;
    else
      for (const p of parts) {
        if (found) break;
        if (!(p.flags & F.Object) || p.getProperty('__runicElement')) continue;
        const props = this.checker.getPropertiesOfType(p);
        if (props.length > 40) continue;
        found =
          props.some(s => this.contains(this.checker.getTypeOfSymbol(s), key, depth + 1)) ||
          p.getCallSignatures().some(s => this.contains(s.getReturnType(), key, depth + 1));
      }
    this.containsCache.set(cacheKey, found);
    return found;
  }
}

/**
 * A property that holds what is given to it: a property signature (an
 * options type), or a class field of program source. (A declaration file's
 * class property may be a getter in the implementation: bits-ui declares
 * `readonly triggerNode`, which its JavaScript computes.)
 */
const plainProperty = (decl: ts.Declaration): boolean =>
  ts.isPropertySignature(decl) ||
  (ts.isPropertyDeclaration(decl) && !decl.getSourceFile().isDeclarationFile);

/** Parentheses, assertions and `!` removed. */
const skipAll = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ||
  ts.isAsExpression(e) ||
  ts.isSatisfiesExpression(e) ||
  ts.isNonNullExpression(e) ||
  ts.isTypeAssertionExpression(e)
    ? skipAll(e.expression)
    : e;

/** The declaration standing for a (possibly instantiated) property symbol. */
function declarationOf(sym: ts.Symbol): ts.Declaration | undefined {
  return sym.valueDeclaration ?? sym.declarations?.[0];
}

/** The default value of a `$bindable(v)` default (`v`), or the default itself. */
function defaultOf(e: ts.Expression): ts.Expression {
  const x = skipAll(e);
  return ts.isCallExpression(x) &&
    x.expression.getText() === '$bindable' &&
    x.arguments.length === 1
    ? x.arguments[0]
    : e;
}

/** The expressions a function literal returns. */
/**
 * The expressions a function literal returns, except in branches a test
 * `decided` at build time rules out.
 */
function returned(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  decided: (test: ts.Expression) => boolean | undefined = () => undefined,
): ts.Expression[] {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isIfStatement(n)) {
      const d = decided(n.expression);
      if (d !== undefined) {
        const live = d ? n.thenStatement : n.elseStatement;
        if (live) visit(live);
        return;
      }
    }
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  fn.body.statements.forEach(visit);
  return out;
}

const skip = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
    ? skip(e.expression)
    : e;

/** A literal argument (strings, numbers, booleans, possibly parenthesised). */
function isLiteralLike(e: ts.Expression): boolean {
  e = skip(e);
  return (
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword
  );
}
