// Ordinary local JavaScript/TypeScript modules, shared by every adapter.
// Modules initialise once, dependencies first. Functions become IR functions
// (typed, or specialised per call site when untyped) that belong to no
// component; primitive constants are inlined; reference-typed constants are
// program globals evaluated once, so their identity is shared as in JavaScript.
import ts from 'typescript';
import path from 'node:path';
import { skipParens, type Lowerer } from './language.ts';
import { bindPackImport, bindPackReexport, bindPackWrapper, type Edge } from './packs.ts';

export interface ModuleGraph {
  root: string;
  entry: string;
  /** `package`: the package compiled from source a module belongs to (frontend/sources.ts). */
  modules: Map<
    string,
    { code: string; imports: Edge[]; package?: { name: string; version: string; dir: string } }
  >;
}

export interface ModuleOptions {
  /** Statements an adapter handles itself (bootstrap, components); return true if handled. */
  statement?(stmt: ts.Statement, file: string): boolean;
  /** Imports of these specifiers are framework/adapter imports. */
  frameworkImport?(spec: string, stmt: ts.ImportDeclaration): boolean;
  /** Files that are not ordinary modules (component files, the entry). */
  skip?(file: string): boolean;
  /**
   * The module-level statements of a component file (Svelte's `<script
   * module>`), lowered as a module and initialised in module order;
   * undefined for files that have none.
   */
  componentModule?(file: string): readonly ts.Statement[] | undefined;
}

/** What a name imported from, or exported by, a module refers to. */
export type ModuleRef =
  /** The default export of a component file (`.svelte`, `.vue`). */
  | { kind: 'component'; file: string }
  /** A module namespace (`import * as X`, `export * as X`). */
  | { kind: 'namespace'; file: string }
  /** A declaration of a local module (or of a component file's module script). */
  | { kind: 'binding'; file: string; name: string }
  /** An export of a package (lowered by its mapping pack). */
  | { kind: 'package'; edge: Edge; name: string };

/**
 * Follows imports and re-exports through the collected module graph, as the
 * bundler links them: named and default re-exports (`export { default as
 * Root } from './card.svelte'`, `export { Root as Card }`), `export *` and
 * `export * as N`, and namespace imports. Syntactic and framework-neutral:
 * adapters use it to find the component a template tag names
 * (`<Card.Root>` through a barrel), before any TypeScript program exists.
 */
export class ModuleResolver {
  private readonly graph: ModuleGraph;
  /** The script blocks of a component file (its module and instance scripts). */
  private readonly componentScripts: (file: string) => ts.SourceFile[] | undefined;
  private readonly parsed = new Map<string, ts.SourceFile[]>();

  constructor(graph: ModuleGraph, componentScripts: (file: string) => ts.SourceFile[] | undefined) {
    this.graph = graph;
    this.componentScripts = componentScripts;
  }

  /** The parsed scripts of a module (one for script modules, the blocks of a component file). */
  scripts(file: string): ts.SourceFile[] {
    const known = this.parsed.get(file);
    if (known) return known;
    let out = this.componentScripts(file);
    if (!out) {
      const code = this.graph.modules.get(file)?.code;
      out =
        code === undefined || !/\.(tsx?|jsx?|mjs)$/.test(file)
          ? []
          : [ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKindOf(file))];
    }
    this.parsed.set(file, out);
    return out;
  }

  isComponent(file: string): boolean {
    return this.componentScripts(file) !== undefined;
  }

  edge(file: string, specifier: string): Edge | undefined {
    return this.graph.modules.get(file)?.imports.find(i => i.specifier === specifier);
  }

  /**
   * Whether `edge` leads into a package compiled from source
   * (frontend/sources.ts): the collector collected the module it resolved to.
   */
  intoSource(edge: Edge): boolean {
    return !!edge.package && !!this.graph.modules.get(edge.resolved)?.package;
  }

  /** What `imported` names when imported through `edge`. */
  imported(edge: Edge, imported: string, seen = new Set<string>()): ModuleRef | undefined {
    if (edge.package && !this.intoSource(edge)) return { kind: 'package', edge, name: imported };
    return imported === '*'
      ? { kind: 'namespace', file: edge.resolved }
      : this.export(edge.resolved, imported, seen);
  }

  /** The export `name` of the local module `file`, or undefined if it has none. */
  export(file: string, name: string, seen = new Set<string>()): ModuleRef | undefined {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (name === 'default' && this.isComponent(file)) return { kind: 'component', file };
    const stars: Edge[] = [];
    for (const sf of this.scripts(file))
      for (const stmt of sf.statements) {
        if (ts.isExportDeclaration(stmt)) {
          const spec = stmt.moduleSpecifier && (stmt.moduleSpecifier as ts.StringLiteral).text;
          const edge = spec === undefined ? undefined : this.edge(file, spec);
          const clause = stmt.exportClause;
          if (!clause) {
            if (edge && name !== 'default') stars.push(edge);
            continue;
          }
          if (ts.isNamespaceExport(clause)) {
            if (clause.name.text === name && edge) return this.imported(edge, '*', seen);
            continue;
          }
          for (const el of clause.elements) {
            if (el.name.text !== name) continue;
            const local = (el.propertyName ?? el.name).text;
            if (spec === undefined) return this.local(file, local, seen);
            return edge && this.imported(edge, local, seen);
          }
          continue;
        }
        if (ts.isExportAssignment(stmt)) {
          if (name === 'default' && !stmt.isExportEquals)
            return ts.isIdentifier(stmt.expression)
              ? this.local(file, stmt.expression.text, seen)
              : { kind: 'binding', file, name: 'default' };
          continue;
        }
        const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
        if (!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const isDefault = mods.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
        for (const declared of declaredNames(stmt))
          if (isDefault ? name === 'default' : declared === name)
            return { kind: 'binding', file, name: declared };
      }
    for (const edge of stars) {
      const found = this.imported(edge, name, seen);
      if (found) return found;
    }
    return undefined;
  }

  /** What the local name `name` of module `file` refers to (an import or a declaration). */
  local(file: string, name: string, seen = new Set<string>()): ModuleRef | undefined {
    for (const sf of this.scripts(file))
      for (const stmt of sf.statements) {
        if (ts.isImportDeclaration(stmt)) {
          const clause = stmt.importClause;
          if (!clause) continue;
          const edge = this.edge(file, (stmt.moduleSpecifier as ts.StringLiteral).text);
          if (clause.name?.text === name) return edge && this.imported(edge, 'default', seen);
          const named = clause.namedBindings;
          if (named && ts.isNamespaceImport(named) && named.name.text === name)
            return edge && this.imported(edge, '*', seen);
          if (named && ts.isNamedImports(named))
            for (const el of named.elements)
              if (el.name.text === name)
                return edge && this.imported(edge, (el.propertyName ?? el.name).text, seen);
          continue;
        }
        if (declaredNames(stmt).includes(name)) return { kind: 'binding', file, name };
      }
    return undefined;
  }

  /** `A.B.C` written in `file`: the reference of the dotted name. */
  dotted(file: string, path: string): ModuleRef | undefined {
    const [head, ...members] = path.split('.');
    let ref = this.local(file, head);
    for (const m of members) {
      if (ref?.kind !== 'namespace') return undefined;
      ref = this.export(ref.file, m);
    }
    return ref;
  }
}

/**
 * A module constant destructuring a record (`const { a, b: c } = value`):
 * the value is a program global evaluated once, and each name a global
 * reading its property, in order. Nested patterns, defaults and rest
 * elements are rejected.
 */
function destructureConstant(
  d: ts.VariableDeclaration & { name: ts.ObjectBindingPattern },
  lower: Lowerer,
  pending: (() => void)[],
): void {
  const init = skipParens(d.initializer!);
  const type = lower.exprType(init);
  const record = typeof type === 'object' && 'record' in type ? type.record : undefined;
  if (
    record === undefined ||
    lower.types.records[record].class ||
    lower.types.accessors.has(record)
  )
    lower.fail(d, 'E_MODULE', 'Destructured module constants need a plain object value');
  const source = lower.globals.length;
  lower.globals.push({
    name: '$destructured',
    type,
    init: { op: 'undefined', type: { maybe: 'number' } },
  });
  pending.push(
    () => (lower.globals[source].init = lower.value(init, undefined, 'destructured$module')),
  );
  for (const el of d.name.elements) {
    if (el.dotDotDotToken || el.initializer || !ts.isIdentifier(el.name))
      lower.fail(
        el,
        'E_MODULE',
        'Destructured module constants take plain names (no defaults, rest or nesting)',
      );
    const key = el.propertyName ?? el.name;
    if (!ts.isIdentifier(key))
      lower.fail(el, 'E_MODULE', 'Destructured module constants take plain names');
    const fields = lower.types.records[record!].fields;
    const field = fields.findIndex(f => f.name === (key as ts.Identifier).text);
    if (field < 0) lower.fail(el, 'E_MODULE', `The value has no ${(key as ts.Identifier).text}`);
    const sym = lower.checker.getSymbolAtLocation(el.name)!;
    const global = lower.globals.length;
    lower.globals.push({
      name: (el.name as ts.Identifier).text,
      type: fields[field].type,
      init: { op: 'get', object: { op: 'global', global: source }, field },
    });
    lower.bindings.set(sym, { kind: 'value', expr: { op: 'global', global } });
  }
}

/** The first reference to `sym` in `statements` other than in an export list. */
function valueUse(
  statements: readonly ts.Statement[],
  sym: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (found || ts.isImportDeclaration(n) || ts.isExportSpecifier(n)) return;
    if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === sym) found = n;
    else ts.forEachChild(n, visit);
  };
  statements.forEach(visit);
  return found;
}

function declaredNames(stmt: ts.Statement): string[] {
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt)) &&
    stmt.name
  )
    return [stmt.name.text];
  if (ts.isVariableStatement(stmt))
    return stmt.declarationList.declarations.flatMap(d =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  return [];
}

function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.m?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Local script modules in initialisation order (dependencies first). */
export function moduleOrder(
  graph: ModuleGraph,
  include: (file: string) => boolean = isScript,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const edge of graph.modules.get(id)?.imports ?? [])
      if (graph.modules.has(edge.resolved) && !edge.typeOnly) visit(edge.resolved);
    order.push(id);
  };
  visit(graph.entry);
  for (const id of graph.modules.keys()) visit(id);
  return order.filter(id => include(id) && id.startsWith(graph.root + path.sep));
}

const isScript = (file: string) => /\.(tsx?|jsx?|mjs)$/.test(file);

export function lowerModules(
  graph: ModuleGraph,
  program: ts.Program,
  lower: Lowerer,
  options: ModuleOptions = {},
): (() => void)[] {
  const checker = program.getTypeChecker();
  const pending: (() => void)[] = [];
  const fail = (n: ts.Node, code: string, message: string): never => lower.fail(n, code, message);
  const files = moduleOrder(graph, f => isScript(f) || !!options.componentModule?.(f));
  for (const file of files) {
    let statements: readonly ts.Statement[];
    if (isScript(file)) {
      if (options.skip?.(file)) continue;
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      statements = sf.statements;
    } else statements = options.componentModule!(file)!;
    for (const stmt of statements) {
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
        // Local imports need no lowering: uses resolve to the exporting
        // module's bindings. A namespace import may be re-exported (and
        // name components in templates); its members are not values yet.
        if (bindPackImport(stmt, edge, lower)) continue;
        const named = stmt.importClause.namedBindings;
        if (named && ts.isNamespaceImport(named)) {
          const sym = checker.getSymbolAtLocation(named.name);
          const use = sym && valueUse(statements, sym, checker);
          if (use)
            fail(
              use,
              'E_IMPORT',
              'Namespace imports are supported as re-exports and component tags (<Ns.Name>); import the names the module uses',
            );
        }
        continue;
      }
      if (ts.isExportDeclaration(stmt)) {
        // Re-exports (`export { a as b } from`, `export *`, `export * as N`)
        // of local modules need no lowering; names re-exported from a
        // package are bound to its pack.
        if (stmt.isTypeOnly || !stmt.moduleSpecifier) continue;
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        bindPackReexport(
          stmt,
          graph.modules.get(file)?.imports.find(i => i.specifier === spec),
          lower,
        );
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
          // `const { a, b: c } = record` (mdsx's markdown modules destructure
          // their metadata): the record once, then each property in order.
          if (ts.isObjectBindingPattern(d.name) && d.initializer) {
            destructureConstant(
              d as ts.VariableDeclaration & { name: ts.ObjectBindingPattern },
              lower,
              pending,
            );
            continue;
          }
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
