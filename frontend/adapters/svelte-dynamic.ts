// Dynamic component tags and `import.meta.glob` in the Svelte adapter (M6,
// docs/design/M6-SVELTEKIT.md, phase 2; values: frontend/component-values.ts).
//
// - The components a program uses as values are found syntactically: an
//   imported component named in an expression (script or template), and
//   the component modules an `import.meta.glob` loads.
// - A tag naming a variable (`<Markdown />`) renders whichever of those
//   components it holds. Its candidates are the component values whose
//   required props the tag passes (the others cannot be rendered there
//   without a missing prop); the tag becomes one copy per candidate (an
//   ordinary component tag) behind an `if` chain on the value.
// - `import.meta.glob<T>(…)` in a script module becomes a call of a function
//   appended to the module, which builds Vite's table: a lazy loader per
//   matched module resolving, as Vite's preload helper and Rollup's inlined
//   dynamic import do, to the module's namespace object (the fields T
//   declares), or the namespace itself with `eager`, or one export with
//   `import`.
import ts from 'typescript';
import path from 'node:path';
import { Diagnostic } from '../../compiler/collect.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SNode = any;
type Source = { file: string; line: number; column: number };

export interface GlobEntry {
  key: string;
  file: string;
  id?: string;
}

export interface GlobCall {
  start: number;
  end: number;
  options: { eager?: boolean; import?: string; query?: string };
  entries: GlobEntry[];
}

interface UnitLike {
  file: string;
  rel: string;
  original: string;
  ast: SNode;
  children: Map<string, string>;
}

/** The local names of the imports of a unit's scripts, by statement. */
function scriptsOf(u: UnitLike): ts.SourceFile[] {
  return [u.ast.module, u.ast.instance]
    .filter(Boolean)
    .map((s: SNode) =>
      ts.createSourceFile(
        u.file + '.ts',
        u.original.slice(s.content.start, s.content.end),
        ts.ScriptTarget.Latest,
        true,
      ),
    );
}

/** Identifiers read in a TS source, outside import declarations and type positions. */
function valueNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      // `mount(Component, …)` (svelte's imperative mount) is not a component value.
      const mounted =
        p &&
        ts.isCallExpression(p) &&
        p.arguments[0] === n &&
        ts.isIdentifier(p.expression) &&
        p.expression.text === 'mount';
      const declared =
        mounted ||
        (p &&
          (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p)) &&
          p.name === n) ||
        (p && ts.isPropertyAccessExpression(p) && p.name === n) ||
        (p && ts.isPropertyAssignment(p) && p.name === n);
      if (!declared) out.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Identifiers in the template's expressions. */
function templateNames(ast: SNode): Set<string> {
  const out = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (x: unknown) => {
    if (!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) return x.forEach(walk);
    const n = x as SNode;
    if (n.type === 'Identifier' && typeof n.name === 'string') out.add(n.name);
    for (const [k, v] of Object.entries(n))
      if (k !== 'parent' && k !== 'instance' && k !== 'module' && k !== 'metadata') walk(v);
  };
  walk(ast.fragment);
  return out;
}

/**
 * The component files a program uses as values: imports of components named
 * in an expression of a component or a script module, and component modules
 * of `import.meta.glob` calls.
 */
export function componentValues(
  units: Iterable<UnitLike>,
  modules: Map<
    string,
    {
      code: string;
      imports: { specifier: string; resolved: string; typeOnly?: boolean }[];
      globs?: GlobCall[];
    }
  >,
  isComponent: (id: string) => boolean,
  componentOfImport: (file: string, name: string) => string | undefined,
  root: string,
): Set<string> {
  const out = new Set<string>();
  for (const u of units) {
    const used = templateNames(u.ast);
    for (const sf of scriptsOf(u)) for (const n of valueNames(sf)) used.add(n);
    for (const sf of scriptsOf(u))
      for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) continue;
        const names: string[] = [];
        if (stmt.importClause?.name) names.push(stmt.importClause.name.text);
        const nb = stmt.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb))
          for (const e of nb.elements) if (!e.isTypeOnly) names.push(e.name.text);
        for (const name of names) {
          if (!used.has(name)) continue;
          const file = componentOfImport(u.file, name);
          if (file) out.add(file);
        }
      }
  }
  for (const [id, m] of modules) {
    if (!id.startsWith(root + path.sep) || !/\.(ts|js|mjs)$/.test(id)) continue;
    for (const g of m.globs ?? [])
      for (const e of g.entries) if (e.id && isComponent(e.id)) out.add(e.id);
    const sf = ts.createSourceFile(id, m.code, ts.ScriptTarget.Latest, true);
    const used = valueNames(sf);
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.importClause?.name || stmt.importClause.isTypeOnly)
        continue;
      const edge = m.imports.find(
        i => i.specifier === (stmt.moduleSpecifier as ts.StringLiteral).text,
      );
      if (
        edge &&
        !edge.typeOnly &&
        isComponent(edge.resolved) &&
        used.has(stmt.importClause.name.text)
      )
        out.add(edge.resolved);
    }
  }
  return out;
}

/** The props a component requires: declared by `$props()` without a default, not optional in its type. */
export function requiredProps(u: UnitLike): Set<string> {
  const out = new Set<string>();
  if (!u.ast.instance) return out;
  const sf = ts.createSourceFile(
    u.file + '.ts',
    u.original.slice(u.ast.instance.content.start, u.ast.instance.content.end),
    ts.ScriptTarget.Latest,
    true,
  );
  const optionalIn = (type: ts.TypeNode | undefined, name: string): boolean => {
    if (!type) return false;
    if (ts.isTypeLiteralNode(type)) {
      const m = type.members.find(x => x.name && ts.isIdentifier(x.name) && x.name.text === name);
      return !m || !!m.questionToken;
    }
    if (ts.isIntersectionTypeNode(type)) {
      const lits = type.types.filter(ts.isTypeLiteralNode);
      const m = lits
        .flatMap(l => [...l.members])
        .find(x => x.name && ts.isIdentifier(x.name) && x.name.text === name);
      // Declared in another member of the intersection (a library type): optional unless a literal requires it.
      return !m || !!m.questionToken;
    }
    return true;
  };
  for (const stmt of sf.statements)
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer;
        if (
          !init ||
          !ts.isCallExpression(init) ||
          !ts.isIdentifier(init.expression) ||
          init.expression.text !== '$props' ||
          !ts.isObjectBindingPattern(d.name)
        )
          continue;
        for (const el of d.name.elements) {
          if (el.dotDotDotToken || el.initializer) continue;
          const key = (el.propertyName ?? el.name) as ts.Identifier;
          if (!ts.isIdentifier(key)) continue;
          if (!optionalIn(d.type, key.text)) out.add(key.text);
        }
      }
  return out;
}

/** The props a component tag passes (attributes, bindings, snippets, children), or undefined with a spread. */
function passedProps(n: SNode): Set<string> | undefined {
  const out = new Set<string>();
  for (const a of n.attributes) {
    if (a.type === 'SpreadAttribute') return undefined;
    if (a.type === 'Attribute' || a.type === 'BindDirective') out.add(a.name);
  }
  for (const c of n.fragment?.nodes ?? []) {
    if (c.type === 'SnippetBlock') out.add(c.expression.name);
    else if (!(c.type === 'Text' && !c.data.trim()) && c.type !== 'Comment') out.add('children');
  }
  return out;
}

/** A copy of a template node (parent links dropped; the source positions kept). */
function clone(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(clone);
  if (!x || typeof x !== 'object') return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x))
    out[k] = k === 'parent' ? undefined : k === 'metadata' ? v : clone(v);
  return out;
}

/**
 * Turns each dynamic tag of a unit (a component tag naming no import) into a
 * `RunicDynamic` node: the tag's name as an expression (`nameNode`, its
 * source span) and one copy of the tag per candidate, registered as the
 * unit's children (`<Name$k>`). Returns whether the unit has one.
 */
export function dynamicSites(
  u: UnitLike,
  isTag: (name: string) => boolean,
  values: Set<string>,
  required: (file: string) => Set<string>,
  locate: (offset: number) => Source,
): boolean {
  let found = false;
  const rewrite = (fragment: SNode) => {
    if (!fragment || !Array.isArray(fragment.nodes)) return;
    fragment.nodes = fragment.nodes.map((n: SNode) => {
      for (const [k, v] of Object.entries(n))
        if (k !== 'parent' && v && typeof v === 'object' && Array.isArray((v as SNode).nodes))
          rewrite(v);
      if (n.type !== 'Component' || n.name.includes('.') || isTag(n.name)) return n;
      found = true;
      const passed = passedProps(n);
      const candidates = [...values]
        .filter(file => !passed || [...required(file)].every(p => passed.has(p)))
        .sort();
      if (!candidates.length)
        throw new Diagnostic(
          'E_TEMPLATE',
          `${n.name} is neither an imported component nor a component value of the program that the tag's props fit`,
          locate(n.start),
        );
      const cases = candidates.map((file, k) => {
        const c = clone(n) as SNode;
        c.name = `${n.name}$${k}`;
        u.children.set(c.name, file);
        return c;
      });
      const nameStart = n.start + 1;
      return {
        type: 'RunicDynamic',
        start: n.start,
        end: n.end,
        name: n.name,
        nameNode: {
          type: 'Identifier',
          name: n.name,
          start: nameStart,
          end: nameStart + n.name.length,
        },
        cases,
        files: candidates,
      };
    });
  };
  rewrite(u.ast.fragment);
  return found;
}

/**
 * A script module's text with its `import.meta.glob` calls replaced by
 * calls of functions appended to it (positions before each call unchanged).
 * `idOf(file)` is the module specifier of a matched module (its virtual
 * component module, or the file), `exportsOf(id)` its export names.
 */
export function rewriteGlobs(
  file: string,
  code: string,
  globs: GlobCall[],
  readFile: (file: string) => string,
  fail: (offset: number, message: string) => never,
): string {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** The property names of the type argument (an object literal type, or a local alias of one). */
  const fieldsOf = (call: ts.CallExpression): string[] | undefined => {
    const arg = call.typeArguments?.[0];
    if (!arg) return undefined;
    let type: ts.TypeNode | undefined = arg;
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const name = type.typeName.text;
      const alias = sf.statements.find(
        (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name,
      );
      const iface = sf.statements.find(
        (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
      );
      if (iface)
        return iface.members
          .map(m => (m.name && ts.isIdentifier(m.name) ? m.name.text : ''))
          .filter(Boolean);
      type = alias?.type;
    }
    if (type && ts.isTypeLiteralNode(type))
      return type.members
        .map(m => (m.name && ts.isIdentifier(m.name) ? m.name.text : ''))
        .filter(Boolean);
    return undefined;
  };
  let out = '';
  let last = 0;
  let appended = '\n';
  const imports: string[] = [];
  globs.forEach((g, i) => {
    let call: ts.CallExpression | undefined;
    const find = (n: ts.Node) => {
      if (!call && ts.isCallExpression(n) && n.getStart(sf) === g.start && n.end === g.end)
        call = n;
      ts.forEachChild(n, find);
    };
    find(sf);
    if (!call) return fail(g.start, 'import.meta.glob call not found');
    const typeText = call.typeArguments?.[0]?.getText(sf);
    const { eager, import: name, query } = g.options;
    if (query !== undefined && query !== '?raw')
      fail(g.start, `The import.meta.glob query ${query} is unsupported (?raw is)`);
    if (query === '?raw' && !(eager && name === 'default'))
      fail(
        g.start,
        "import.meta.glob with query '?raw' needs { eager: true, import: 'default' } natively",
      );
    const fields = name ? undefined : fieldsOf(call);
    if (!query && !name && !fields)
      fail(
        g.start,
        "import.meta.glob needs the modules' type as a type argument, an object type (import.meta.glob<{ default: Component }>(…)), or an import option",
      );
    if (!typeText && !query)
      fail(
        g.start,
        "import.meta.glob needs the modules' type as a type argument (import.meta.glob<T>(…))",
      );
    const fn = `__runic_glob_${i}`;
    const valueType = query === '?raw' ? 'string' : name ? `${typeText}` : `${typeText}`;
    const entries = g.entries.map((e, k) => {
      if (query === '?raw')
        return `  ${JSON.stringify(e.key)}: ${JSON.stringify(readFile(e.file))},`;
      if (!e.id) return fail(g.start, `${e.key} cannot be loaded`);
      const local = `${fn}_${k}`;
      const names = name ? [name] : fields!;
      const binds = names.map(f => `${f === 'default' ? 'default' : f} as ${local}_${f}`);
      imports.push(`import { ${binds.join(', ')} } from ${JSON.stringify(e.id)};`);
      const ns = name
        ? `${local}_${name}`
        : `{ ${names.map(f => `${f}: ${local}_${f}`).join(', ')} }`;
      if (eager) return `  ${JSON.stringify(e.key)}: ${ns},`;
      // Vite's preload helper: Promise.resolve().then(() => baseModule().catch(…)),
      // the inlined dynamic import Promise.resolve().then(() => namespace).
      return `  ${JSON.stringify(e.key)}: (): Promise<${valueType}> => Promise.resolve().then(() => Promise.resolve().then((): ${valueType} => (${ns})).catch((error: Error): ${valueType} => { throw error; })),`;
    });
    const tableType =
      eager || query
        ? `Record<string, ${valueType}>`
        : `Record<string, () => Promise<${valueType}>>`;
    appended += `function ${fn}(): ${tableType} {\n  return {\n${entries.join('\n')}\n  };\n}\n`;
    out += code.slice(last, g.start) + `${fn}()`;
    last = g.end;
  });
  out += code.slice(last);
  return out + appended + imports.join('\n') + '\n';
}
