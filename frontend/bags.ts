// Shapes of attribute bags (docs/design/M6-LIBRARIES.md, "Attribute bags"):
// the names a bag may hold, from the code that builds it. Bags are dynamic
// values (IR type `attrs`), but where a bag meets names the program states
// statically the frontend needs to know which ones it may hold: a spread
// onto a component may set the component's declared props (shadcn's Button
// receives bits-ui's trigger props through `{...props}`), a spread onto an
// element may override its own attributes, and a link's `href` must be
// known. The analysis follows the TypeScript program syntactically:
//
// - object literals (static keys, computed keys that are build-time
//   constants, spreads);
// - conditionals and logical operators (both branches);
// - variables and class fields through their initialisers and the values
//   assigned to them, `$derived` values through their expressions;
// - calls of local functions through their returned values, and of pack
//   functions through the pack (`mergeProps` holds what its arguments hold;
//   `attachRef` holds only an attachment, which has no name);
// - what the adapter knows: rest props hold what the component's sites pass
//   beyond its declared props, snippet parameters what the snippet's render
//   sites pass.
//
// A shape is a superset (a name the code may hold), or `open` where the
// analysis cannot see the names; code needing the names then fails with a
// diagnostic.
import ts from 'typescript';
import { skipParens, type Lowerer } from './language.ts';

export interface Shape {
  keys: Set<string>;
  open: boolean;
}

export const emptyShape = (): Shape => ({ keys: new Set(), open: false });
export const openShape = (): Shape => ({ keys: new Set(), open: true });

export function union(...shapes: Shape[]): Shape {
  const out = emptyShape();
  for (const s of shapes) {
    for (const k of s.keys) out.keys.add(k);
    out.open ||= s.open;
  }
  return out;
}

/** Whether a bag of shape `s` may hold `name`. */
export const mayHold = (s: Shape, name: string): boolean => s.open || s.keys.has(name);

export interface ShapeHooks {
  /** The shape of a binding the adapter knows (rest props, snippet parameters), if any. */
  binding(symbol: ts.Symbol, at: ts.Node): Shape | undefined;
}

export class BagShapes {
  private readonly lower: Lowerer;
  private readonly hooks: ShapeHooks;
  private readonly active = new Set<ts.Node>();

  constructor(lower: Lowerer, hooks: ShapeHooks) {
    this.lower = lower;
    this.hooks = hooks;
  }

  /** The names the bag `e` evaluates to may hold. */
  of(e: ts.Expression): Shape {
    if (this.active.has(e)) return emptyShape();
    this.active.add(e);
    try {
      return this.compute(e);
    } finally {
      this.active.delete(e);
    }
  }

  private compute(e: ts.Expression): Shape {
    const checker = this.lower.checker;
    e = skipParens(e);
    while (ts.isNonNullExpression(e)) e = skipParens(e.expression);
    if (ts.isObjectLiteralExpression(e)) return this.object(e);
    if (ts.isConditionalExpression(e)) return union(this.of(e.whenTrue), this.of(e.whenFalse));
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.of(e.right);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
        return union(this.of(e.left), this.of(e.right));
      return openShape();
    }
    if (e.kind === ts.SyntaxKind.NullKeyword) return emptyShape();
    if (ts.isIdentifier(e) && e.text === 'undefined') return emptyShape();
    if (ts.isCallExpression(e)) return this.call(e);
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const sym = checker.getSymbolAtLocation(ts.isIdentifier(e) ? e : e.name);
      const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      if (!target) return openShape();
      const known = this.hooks.binding(target, e);
      if (known) return known;
      return this.declared(target);
    }
    return openShape();
  }

  private object(e: ts.ObjectLiteralExpression): Shape {
    const out = emptyShape();
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) {
        const s = this.of(p.expression);
        for (const k of s.keys) out.keys.add(k);
        out.open ||= s.open;
        continue;
      }
      const name = p.name && this.propertyName(p.name);
      if (name === undefined) out.open = true;
      else out.keys.add(name);
    }
    return out;
  }

  /** A property name as a string: static, or a build-time constant computed key. */
  propertyName(n: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
    if (ts.isComputedPropertyName(n)) {
      const inner = skipParens(n.expression);
      if (ts.isStringLiteralLike(inner)) return inner.text;
      const c = this.lower.constantMember(inner);
      if (c && typeof c.value === 'string') return c.value;
    }
    return undefined;
  }

  private call(e: ts.CallExpression): Shape {
    const callee = skipParens(e.expression);
    const text = callee.getText();
    // Svelte's derived values hold what their expression holds.
    if (text === '$derived' && e.arguments[0]) return this.of(e.arguments[0]);
    if (text === '$derived.by' && e.arguments[0]) return this.returned(e.arguments[0]);
    if (ts.isIdentifier(callee)) {
      // A function of the program: what it returns (without lowering it).
      const decl = this.lower.symbol(callee)?.valueDeclaration;
      if (decl && ts.isFunctionDeclaration(decl) && decl.body) return this.returned(decl);
      // A pack function (declared by the package's declaration files).
      const b = this.lower.binding(callee);
      if (b?.kind === 'pack') return b.shape ? b.shape(e, x => this.of(x)) : openShape();
    }
    return openShape();
  }

  /** What a function's returned values hold. */
  private returned(fn: ts.Node): Shape {
    if (!(ts.isFunctionLike(fn) && 'body' in fn) || !fn.body) return openShape();
    const body = fn.body as ts.Node;
    if (!ts.isBlock(body)) return this.of(body as ts.Expression);
    const out = emptyShape();
    const visit = (n: ts.Node) => {
      if (ts.isReturnStatement(n)) {
        const s = n.expression ? this.of(n.expression) : emptyShape();
        for (const k of s.keys) out.keys.add(k);
        out.open ||= s.open;
      }
      if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
    };
    visit(body);
    return out;
  }

  /** What a declared variable or class field holds: its initialiser and the values assigned to it. */
  private declared(sym: ts.Symbol): Shape {
    const decl = sym.valueDeclaration;
    if (!decl) return openShape();
    const shapes: Shape[] = [];
    if (ts.isVariableDeclaration(decl)) {
      if (!decl.initializer) return openShape();
      shapes.push(this.of(decl.initializer));
      return union(...shapes, ...this.assignments(sym, decl.getSourceFile()));
    }
    if (ts.isPropertyDeclaration(decl)) {
      if (decl.initializer) shapes.push(this.of(decl.initializer));
      let cls: ts.Node = decl.parent;
      if (!ts.isClassLike(cls)) return openShape();
      return union(...shapes, ...this.assignments(sym, cls));
    }
    return openShape();
  }

  /** The shapes of the values assigned to `sym` in `scope`. */
  private assignments(sym: ts.Symbol, scope: ts.Node): Shape[] {
    const checker = this.lower.checker;
    const out: Shape[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isIdentifier(n.left) || ts.isPropertyAccessExpression(n.left))
      ) {
        const s = checker.getSymbolAtLocation(ts.isIdentifier(n.left) ? n.left : n.left.name);
        if (s === sym) out.push(this.of(n.right));
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return out;
  }
}
