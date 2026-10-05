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

  constructor(
    checker: ts.TypeChecker,
    files: () => readonly ts.SourceFile[],
    sourceOf: SourceOf,
    propValues: PropValues,
  ) {
    this.checker = checker;
    this.files = files;
    this.sourceOf = sourceOf;
    this.propValues = propValues;
  }

  /**
   * The member that union `parts` (its non-nullish members, at least two of
   * types the value model cannot unite) is narrowed to. Rejects the union
   * when the values reaching it belong to different members or none is
   * found.
   */
  member(parts: readonly ts.Type[], at: ts.Node, fail: Fail): ts.Type {
    const key = unionKey(parts);
    const known = this.resolved.get(key);
    if (known) return known;
    const members = parts.filter(p => !nullish(p));
    const found = this.count(key, members).members;
    const text = (t: ts.Type) => this.checker.typeToString(t);
    const union = members.map(text).join(' | ');
    if (found.size === 1) {
      const [m] = found.keys();
      this.resolved.set(key, m);
      return m;
    }
    // Nothing but null and undefined reaches it: any member types it.
    if (!found.size) {
      this.resolved.set(key, members[0]);
      return members[0];
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

  /** The member a narrowed union stands for, if `t` (or its non-nullish part) is one. */
  narrowed(t: ts.Type): ts.Type | undefined {
    const parts = t.isUnion() ? t.types : [t];
    return this.resolved.get(unionKey(parts));
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
    const memberOf = (t: ts.Type) =>
      members.find(m => m === t || this.checker.isTypeAssignableTo(t, m));
    const classify = (actual: ts.Type, n: ts.Node, e: ts.Expression, path: string[]) => {
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
      const parts = (actual.isUnion() ? actual.types : [actual]).filter(p => !nullish(p));
      if (unionKey(parts) === key) return;
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
        if (ts.isExpression(n) && !ts.isPartOfTypeNode(n)) {
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
    if (depth > 12) return undefined;
    e = skipAll(e);
    const K = ts.SyntaxKind;
    const all = (parts: (ts.Type[] | undefined)[]) =>
      parts.some(p => p === undefined) ? undefined : (parts as ts.Type[][]).flat();
    // An operand: what it is built from, or else TypeScript's type of it.
    const orType = (x: ts.Expression) =>
      this.trace(x, [], depth + 1, strict) ?? [this.checker.getTypeAtLocation(x)];
    if (!path.length) {
      if (e.kind === K.NullKeyword || ts.isVoidExpression(e)) return [];
      if (ts.isIdentifier(e) && e.text === 'undefined' && !this.declared(e)) return [];
      if (ts.isConditionalExpression(e)) return all([orType(e.whenTrue), orType(e.whenFalse)]);
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
      }
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'current') {
        const inner = this.trace(e.expression, ['current'], depth + 1, strict);
        if (inner) return inner;
      }
      // A value typed by a union nothing but null and undefined reaches.
      if (!strict && this.empty(this.declaredType(e))) return [];
      return undefined;
    }
    if (path[0] !== 'current') return undefined;
    const rest = path.slice(1);
    if (ts.isCallExpression(e) && this.isBox(this.checker.getTypeAtLocation(e))) {
      // A box made from a getter (one argument: no setter) or an initial
      // value (and what is written to it).
      if (e.arguments.length > 1) return undefined;
      if (!e.arguments.length) return strict ? undefined : [];
      const arg = skipAll(e.arguments[0]);
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
        return all(returned(arg).map(r => this.trace(r, rest, depth + 1, strict)));
      return strict ? undefined : this.trace(arg, rest, depth + 1);
    }
    if (ts.isIdentifier(e)) {
      const sym = this.symbol(e);
      const init = sym && this.constant(sym);
      return init ? this.trace(init, path, depth + 1, strict) : undefined;
    }
    if (ts.isPropertyAccessExpression(e)) {
      // An option or field holding a box: the boxes given to it, and the
      // values written to their `current`.
      const sym = this.symbol(e.name);
      const decl = sym && declarationOf(sym);
      if (!decl) return undefined;
      const index = this.properties();
      const given = index.given.get(decl) ?? [];
      if (!given.length) return undefined;
      const written = index.writes.get(decl) ?? [];
      if (strict && written.length) return undefined;
      const writes = written.map(w => this.trace(w, rest, depth + 1));
      return all([...given.map(g => this.trace(g, path, depth + 1, strict)), ...writes]);
    }
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
          const ctx = this.checker.getContextualType(n);
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
    this.index = { given, writes };
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

/** The expressions a function literal returns. */
function returned(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
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
