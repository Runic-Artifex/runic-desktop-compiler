// Bindings of package modules compiled from source, created on first use
// (frontend/sources.ts, frontend/package-modules.ts). A source package
// declares itself free of module side effects, so lowering only the
// declarations a program reaches is equivalent to running its modules:
// functions, classes and constants are lowered when code first names them,
// imports of packs bound when first used. A module constant whose
// dependencies come first is a program global created after them, so
// globals keep their initialisation order.
//
// Build-time constants: a module constant initialised by calling a function
// of a module of the same package that imports nothing, with literal
// arguments, is evaluated by running that module (the collected bytes, in
// Node) — bits-ui's `createBitsAttrs({ component, parts })` tables of
// attribute names. Its string, number and boolean members are literals; other
// uses are rejected.
import ts from 'typescript';
import { createRequire } from 'node:module';
import { skipParens, type Binding, type Lowerer } from './language.ts';
import { bindPackImport, bindPackWrapper, type Edge } from './packs.ts';
import type { PackageModule } from './package-modules.ts';

const require = createRequire(import.meta.url);

export function packageBindings(
  lower: Lowerer,
  modules: Map<string, { code: string; imports: Edge[]; package?: unknown }>,
  packageModules: Map<string, PackageModule>,
): (symbol: ts.Symbol) => Binding | undefined {
  const byVirtual = new Map<string, PackageModule>();
  for (const m of packageModules.values()) byVirtual.set(m.virtual, m);
  const inProgress = new Set<ts.Symbol>();
  return symbol => {
    const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!decl) return undefined;
    const sf = decl.getSourceFile();
    const m = byVirtual.get(sf.fileName);
    if (!m) return undefined;
    if (inProgress.has(symbol))
      return lower.fail(
        decl,
        'E_MODULE',
        `${symbol.name} refers to itself while it is initialised`,
      );
    inProgress.add(symbol);
    try {
      return bind(symbol, decl, sf, m);
    } finally {
      inProgress.delete(symbol);
    }
  };

  function bind(
    symbol: ts.Symbol,
    decl: ts.Declaration,
    sf: ts.SourceFile,
    m: PackageModule,
  ): Binding | undefined {
    // A name imported from a package with a mapping pack.
    if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
      let stmt: ts.Node = decl;
      while (!ts.isImportDeclaration(stmt)) stmt = stmt.parent;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (spec === 'svelte' || spec.startsWith('svelte/')) return undefined;
      const edge = modules.get(m.file)?.imports.find(i => i.specifier === spec);
      if (!edge?.package || modules.get(edge.resolved)?.package) return undefined;
      const name = ts.isImportSpecifier(decl) || ts.isImportClause(decl) ? decl.name : undefined;
      bindPackImport(stmt, edge, lower, name);
      return lower.bindings.get(symbol);
    }
    if (decl.parent !== sf && !(ts.isVariableDeclaration(decl) && decl.parent.parent.parent === sf))
      return undefined;
    if (ts.isFunctionDeclaration(decl) && decl.name && decl.body) {
      if (bindPackWrapper(symbol, decl, decl.name.text, lower)) return lower.bindings.get(symbol);
      lower.declare(symbol, decl, decl.name.text, undefined)?.();
      return lower.bindings.get(symbol);
    }
    if (ts.isClassDeclaration(decl)) {
      for (const p of lower.classes.declare(decl, undefined)) p();
      return lower.bindings.get(symbol);
    }
    if (!ts.isVariableDeclaration(decl)) return undefined;
    if (!(decl.parent.flags & ts.NodeFlags.Const))
      return lower.fail(decl, 'E_MODULE', 'Mutable module state is unsupported');
    if (!ts.isIdentifier(decl.name) || !decl.initializer)
      return lower.fail(decl, 'E_MODULE', 'Module constants need a name and an initialiser');
    const name = decl.name.text;
    if (lower.isIntlConstant(decl) || lower.isPackConstant(decl)) return lower.bindings.get(symbol);
    const folded = buildTime(decl, m);
    if (folded) {
      const binding: Binding = { kind: 'constant', label: name, value: folded.value };
      lower.bindings.set(symbol, binding);
      return binding;
    }
    const init = skipParens(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      if (bindPackWrapper(symbol, init, name, lower)) return lower.bindings.get(symbol);
      lower.declare(symbol, init, name, undefined)?.();
      return lower.bindings.get(symbol);
    }
    const type = lower.exprType(init);
    // The initialiser first: the globals it reaches are created before this one.
    const value = lower.value(init, undefined, `${name}$module`);
    if (type === 'number' || type === 'string' || type === 'boolean') {
      const binding: Binding = { kind: 'value', expr: value };
      lower.bindings.set(symbol, binding);
      return binding;
    }
    const global = lower.globals.length;
    lower.globals.push({ name, type, init: value });
    const binding: Binding = { kind: 'value', expr: { op: 'global', global } };
    lower.bindings.set(symbol, binding);
    return binding;
  }

  /**
   * A constant initialised by a call of a function of a package module that
   * imports nothing, with literal arguments: its value, computed by running
   * the module.
   */
  function buildTime(
    decl: ts.VariableDeclaration,
    m: PackageModule,
  ): { value: unknown } | undefined {
    const init = skipParens(decl.initializer!);
    if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return undefined;
    const target = lower.symbol(init.expression);
    const fn = target?.valueDeclaration;
    if (!fn || !ts.isFunctionDeclaration(fn) || !fn.name) return undefined;
    const home = byVirtual.get(fn.getSourceFile().fileName);
    if (!home || (modules.get(home.file)?.imports.length ?? 1) > 0) return undefined;
    const args: unknown[] = [];
    for (const a of init.arguments) {
      const v = literal(a);
      if (!v) return undefined;
      args.push(v.value);
    }
    let exports: Record<string, unknown>;
    try {
      exports = require(home.file) as Record<string, unknown>;
    } catch (e) {
      return lower.fail(
        init,
        'E_CONST',
        `Evaluating ${m.file} at build time failed: ${(e as Error).message}`,
      );
    }
    const f = exports[fn.name.text];
    if (typeof f !== 'function') return undefined;
    return { value: (f as (...a: unknown[]) => unknown)(...args) };
  }
}

/** The value of a literal expression (strings, numbers, booleans, arrays and objects of them). */
function literal(e: ts.Expression): { value: unknown } | undefined {
  e = skipParens(e);
  if (ts.isStringLiteralLike(e)) return { value: e.text };
  if (ts.isNumericLiteral(e)) return { value: Number(e.text) };
  if (e.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (e.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (ts.isArrayLiteralExpression(e)) {
    const out: unknown[] = [];
    for (const x of e.elements) {
      const v = ts.isSpreadElement(x) ? undefined : literal(x);
      if (!v) return undefined;
      out.push(v.value);
    }
    return { value: out };
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
        return undefined;
      const v = literal(p.initializer);
      if (!v) return undefined;
      out[p.name.text] = v.value;
    }
    return { value: out };
  }
  return undefined;
}
