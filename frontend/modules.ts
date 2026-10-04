// Ordinary local JavaScript/TypeScript modules, shared by every adapter.
// Modules initialise once, dependencies first. Functions become IR functions
// (typed, or specialised per call site when untyped) that belong to no
// component; primitive constants are inlined; reference-typed constants are
// program globals evaluated once, so their identity is shared as in JavaScript.
import ts from 'typescript';
import path from 'node:path';
import { skipParens, type Lowerer } from './language.ts';
import { bindPackImport, bindPackWrapper, type Edge } from './packs.ts';

export interface ModuleGraph {
  root: string;
  entry: string;
  modules: Map<string, { code: string; imports: Edge[] }>;
}

export interface ModuleOptions {
  /** Statements an adapter handles itself (bootstrap, components); return true if handled. */
  statement?(stmt: ts.Statement, file: string): boolean;
  /** Imports of these specifiers are framework/adapter imports. */
  frameworkImport?(spec: string, stmt: ts.ImportDeclaration): boolean;
  /** Files that are not ordinary modules (component files, the entry). */
  skip?(file: string): boolean;
}

/** Local script modules in initialisation order (dependencies first). */
export function moduleOrder(graph: ModuleGraph): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const edge of graph.modules.get(id)?.imports ?? [])
      if (graph.modules.has(edge.resolved)) visit(edge.resolved);
    order.push(id);
  };
  visit(graph.entry);
  for (const id of graph.modules.keys()) visit(id);
  return order.filter(id => /\.(tsx?|jsx?|mjs)$/.test(id) && id.startsWith(graph.root + path.sep));
}

export function lowerModules(
  graph: ModuleGraph,
  program: ts.Program,
  lower: Lowerer,
  options: ModuleOptions = {},
): (() => void)[] {
  const checker = program.getTypeChecker();
  const pending: (() => void)[] = [];
  const fail = (n: ts.Node, code: string, message: string): never => lower.fail(n, code, message);
  for (const file of moduleOrder(graph)) {
    if (options.skip?.(file)) continue;
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    for (const stmt of sf.statements) {
      if (options.statement?.(stmt, file)) continue;
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (stmt.importClause?.isTypeOnly) continue;
        if (options.frameworkImport?.(spec, stmt)) continue;
        if (!stmt.importClause) {
          if (!spec.endsWith('.css'))
            fail(stmt, 'E_IMPORT', 'Only local CSS side-effect imports are supported');
          continue;
        }
        // Packages lower through their mapping packs (frontend/packs.ts).
        const edge = graph.modules.get(file)?.imports.find(i => i.specifier === spec);
        if (bindPackImport(stmt, edge, lower)) continue;
        const named = stmt.importClause.namedBindings;
        if (named && ts.isNamespaceImport(named))
          fail(named, 'E_IMPORT', 'Namespace imports are planned for M3');
        continue;
      }
      if (ts.isExportDeclaration(stmt)) {
        if (stmt.exportClause && !ts.isNamedExports(stmt.exportClause))
          fail(stmt, 'E_IMPORT', 'Namespace re-exports are planned for M3');
        if (!stmt.exportClause && stmt.moduleSpecifier)
          fail(stmt, 'E_IMPORT', 'export * is planned for M3');
        continue;
      }
      if (
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isEmptyStatement(stmt)
      )
        continue;
      if (ts.isExportAssignment(stmt))
        fail(stmt, 'E_IMPORT', 'Default exports from modules are planned for M3');
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const sym = checker.getSymbolAtLocation(stmt.name)!;
        // Wrappers of calls evaluated at build time are inlined (packs.ts).
        if (bindPackWrapper(sym, stmt, stmt.name.text, lower)) continue;
        const p = lower.declare(sym, stmt, stmt.name.text, undefined);
        if (p) pending.push(p);
        continue;
      }
      if (ts.isVariableStatement(stmt)) {
        if (!(stmt.declarationList.flags & ts.NodeFlags.Const))
          fail(stmt, 'E_MODULE', 'Mutable module state is unsupported');
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer)
            fail(d, 'E_MODULE', 'Module constants need a name and an initialiser');
          // Intl and pack constants have no runtime value (their uses are lowered).
          if (lower.isIntlConstant(d) || lower.isPackConstant(d)) continue;
          const sym = checker.getSymbolAtLocation(d.name)!;
          const name = (d.name as ts.Identifier).text;
          const init = skipParens(d.initializer!);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            if (bindPackWrapper(sym, init, name, lower)) continue;
            const p = lower.declare(sym, init, name, undefined);
            if (p) pending.push(p);
            continue;
          }
          // Evaluated in order (a later constant may use an earlier one).
          const type = lower.exprType(init);
          const primitive = type === 'number' || type === 'string' || type === 'boolean';
          if (primitive)
            pending.push(() =>
              lower.bindings.set(sym, {
                kind: 'value',
                expr: lower.value(init, undefined, `${name}$module`),
              }),
            );
          else {
            // A shared instance: a program global initialised once.
            const global = lower.globals.length;
            lower.globals.push({
              name,
              type,
              init: { op: 'undefined', type: { maybe: 'number' } },
            });
            lower.bindings.set(sym, { kind: 'value', expr: { op: 'global', global } });
            pending.push(
              () => (lower.globals[global].init = lower.value(init, undefined, `${name}$module`)),
            );
          }
        }
        continue;
      }
      if (ts.isClassDeclaration(stmt)) {
        pending.push(...lower.classes.declare(stmt, undefined));
        continue;
      }
      fail(stmt, 'E_MODULE', 'Top-level effects in modules are planned for M4');
    }
  }
  return pending;
}
