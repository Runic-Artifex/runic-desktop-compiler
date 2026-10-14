// Modules of packages compiled from source (frontend/sources.ts): which of
// them a program reaches, and how their untyped `dist` JavaScript is typed
// (docs/design/M6-LIBRARIES.md, "Library code").
//
// A package's published JavaScript carries no types; its declaration files
// (`x.d.ts` next to `x.js`) give the public signatures, but omit what the
// lowering needs most (computed keys, attachments, private fields). Each
// reached module therefore becomes a virtual TypeScript module: the
// JavaScript with type annotations inserted, taken from the declaration
// file where it declares the member (`opts: __dts.C["opts"]`,
// `Parameters<typeof __dts.f>[0]`), and inferred from the module itself
// for the rest: a class field the declarations do not describe takes the
// union of the types of its initialiser and of the values the class assigns
// to it (a second pass over the typed program). Object literals with
// computed keys are attribute bags (`RunicAttrs`, frontend/dom.d.ts). The
// lowering then sees one typed program; where the two sources disagree the
// type checker's types decide, and values outside the value model are
// rejected as anywhere else.
import ts from 'typescript';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModuleResolver } from './modules.ts';
import { overrideEdits } from './packs/declarations.ts';

/**
 * The event interface of each event kind, from the host event maps of
 * frontend/dom.d.ts (`pointerenter: PointerEvent`).
 */
const EVENT_INTERFACE: Map<string, string> = (() => {
  const text = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'dom.d.ts'),
    'utf8',
  );
  const map = new Map<string, string>();
  for (const block of text.matchAll(/interface (?:Host|Runic)EventMap[^{]*\{([^}]*)\}/g))
    for (const m of block[1].matchAll(/^\s+([a-z]+): (\w+);/gm)) map.set(m[1], m[2]);
  return map;
})();

/** The compiler's host declarations. */
const DOM_DECLARATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dom.d.ts');

/** The module specifier prefix that names a declaration file directly. */
export const DTS_PREFIX = 'runic-dts:';

/** A reached package module and its typed virtual module. */
export interface PackageModule {
  /** The JavaScript file. */
  file: string;
  /** The virtual TypeScript module standing for it. */
  virtual: string;
  /** Its declaration file, if the package ships one. */
  dts?: string;
  /**
   * A bundle's declaration files (`bundleDeclarations`), which declare its
   * top-level names; no `dts` then.
   */
  bundleDts?: string[];
  /** The virtual module's text. */
  text: string;
  /** Ranges of the virtual text copied from the original (for diagnostics). */
  segments: { synth: number; orig: number; length: number }[];
  /** Field annotations inferred by the second pass, by `Class.field`. */
  inferred: Map<string, string>;
  /** A pack's typed port of the module (frontend/packs.ts `PackPort`): its text as written. */
  port?: true;
  /** The packed package a port belongs to (its imports of the package go to the pack). */
  portOf?: { name: string; version: string; dir: string };
}

/** The typed module of a pack's port `file` standing for package module `js`. */
export function portModule(
  js: string,
  file: string,
  portOf: { name: string; version: string; dir: string },
): PackageModule {
  const text = readFileSync(file, 'utf8');
  const dts = declarationFile(js);
  return {
    file: js,
    virtual: file,
    ...(dts ? { dts } : {}),
    text,
    segments: [{ synth: 0, orig: 0, length: text.length }],
    inferred: new Map(),
    port: true,
    portOf,
  };
}

/** What a declaration file declares, by name. */
interface Declared {
  functions: Map<
    string,
    {
      signatures: number;
      generic: boolean;
      /** Per overload: parameter type texts (`?` for optional) and the result type text. */
      overloads: { params: { type: string; optional: boolean }[]; result: string }[];
    }
  >;
  classes: Map<
    string,
    {
      /** The declaration (generic classes are annotated from its text). */
      decl: ts.ClassDeclaration;
      generic: boolean;
      properties: Set<string>;
      methods: Map<string, { signatures: number; generic: boolean }>;
      statics: Map<string, { signatures: number; generic: boolean }>;
      accessors: Set<string>;
    }
  >;
  /** Constants (`export declare const X: T`). */
  variables: Set<string>;
  /**
   * Static properties of functions (`declare namespace F { let p: T }`,
   * merged with `declare function F`), by function.
   */
  statics?: Map<string, Set<string>>;
  /** The declaration file, and the names it declares or imports at its top level. */
  sf?: ts.SourceFile;
  top: Set<string>;
}

/**
 * The text of type node `n` of declaration file `sf` as the virtual
 * module writes it: names the file declares or imports at its top level
 * (`top`, all exported by `exportAllDeclarations`) qualified by
 * `__dts.`, except the type parameters in scope (`local`) and those
 * declared inside `n`.
 */
function qualified(
  n: ts.Node,
  sf: ts.SourceFile,
  top: Set<string>,
  local: Set<string>,
  ns = '__dts',
): string {
  const inner = new Set(local);
  const collect = (x: ts.Node) => {
    if (ts.isTypeParameterDeclaration(x)) inner.add(x.name.text);
    ts.forEachChild(x, collect);
  };
  collect(n);
  const at: number[] = [];
  const leftmost = (e: ts.EntityName | ts.Expression): ts.Identifier | undefined =>
    ts.isIdentifier(e)
      ? e
      : ts.isQualifiedName(e)
        ? leftmost(e.left)
        : ts.isPropertyAccessExpression(e)
          ? leftmost(e.expression)
          : undefined;
  const visit = (x: ts.Node) => {
    const id = ts.isTypeReferenceNode(x)
      ? leftmost(x.typeName)
      : ts.isTypeQueryNode(x)
        ? leftmost(x.exprName)
        : undefined;
    if (id && top.has(id.text) && !inner.has(id.text)) at.push(id.getStart(sf));
    ts.forEachChild(x, visit);
  };
  visit(n);
  const start = n.getStart(sf);
  let text = n.getText(sf);
  for (const pos of at.sort((a, b) => b - a))
    text = text.slice(0, pos - start) + ns + '.' + text.slice(pos - start);
  return text;
}

function declarations(dts: string): Declared {
  const sf = ts.createSourceFile(dts, packedDeclarations(dts), ts.ScriptTarget.Latest, true);
  const out: Declared = {
    functions: new Map(),
    classes: new Map(),
    variables: new Set(),
    sf,
    top: new Set(),
  };
  for (const stmt of sf.statements) {
    const named = (stmt as { name?: ts.Node }).name;
    if (named && ts.isIdentifier(named)) out.top.add(named.text);
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name)) out.top.add(d.name.text);
    const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : undefined;
    if (clause?.name) out.top.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) out.top.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const el of bindings.elements) out.top.add(el.name.text);
  }
  const isStatic = (m: ts.Node) =>
    ts.canHaveModifiers(m) &&
    !!ts.getModifiers(m)?.some(x => x.kind === ts.SyntaxKind.StaticKeyword);
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const known = out.functions.get(stmt.name.text);
      out.functions.set(stmt.name.text, {
        signatures: (known?.signatures ?? 0) + 1,
        generic: !!known?.generic || !!stmt.typeParameters?.length,
        overloads: [
          ...(known?.overloads ?? []),
          {
            params: stmt.parameters.map(p => ({
              type: p.type?.getText(sf) ?? 'any',
              optional: !!p.questionToken || !!p.initializer,
            })),
            result: stmt.type?.getText(sf) ?? 'any',
          },
        ],
      });
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.type) out.variables.add(d.name.text);
    } else if (
      ts.isModuleDeclaration(stmt) &&
      ts.isIdentifier(stmt.name) &&
      stmt.body &&
      ts.isModuleBlock(stmt.body)
    ) {
      const props = new Set<string>();
      for (const x of stmt.body.statements)
        if (ts.isVariableStatement(x))
          for (const d of x.declarationList.declarations)
            if (ts.isIdentifier(d.name) && d.type) props.add(d.name.text);
      if (props.size) (out.statics ??= new Map()).set(stmt.name.text, props);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const c = {
        decl: stmt,
        generic: !!stmt.typeParameters?.length,
        properties: new Set<string>(),
        methods: new Map<string, { signatures: number; generic: boolean }>(),
        statics: new Map<string, { signatures: number; generic: boolean }>(),
        accessors: new Set<string>(),
      };
      for (const m of stmt.members) {
        const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined;
        if (!name) continue;
        if (ts.isPropertyDeclaration(m) && !isStatic(m)) c.properties.add(name);
        else if (ts.isGetAccessor(m) || ts.isSetAccessor(m)) c.accessors.add(name);
        else if (ts.isMethodDeclaration(m)) {
          const table = isStatic(m) ? c.statics : c.methods;
          const known = table.get(name);
          table.set(name, {
            signatures: (known?.signatures ?? 0) + 1,
            generic: !!known?.generic || !!m.typeParameters?.length,
          });
        }
      }
      out.classes.set(stmt.name.text, c);
    }
  }
  return out;
}

/**
 * A package declaration file with its module-private declarations exported:
 * the typed virtual modules annotate a module's classes from their
 * declarations (`__dts.C["opts"]`), also of classes and interfaces the
 * declaration file does not export (bits-ui's `ToggleGroupBaseState`).
 * Exporting more names changes no other module's types.
 *
 * `overrides` (the second pass's `dts:<position>:<path>` entries, `inferFields`)
 * replace `any` keywords at those positions of the file with the types the
 * program gives the properties they declare. A pack's pinned declaration
 * overrides (frontend/packs/declarations.ts) replace the declarations they
 * name, where the file is the published one.
 */
export function exportAllDeclarations(dts: string, overrides?: Map<string, string>): string {
  return virtualDeclarations(dts, overrides).text;
}

/** The `dts:<position>:<path>` overrides among a module's inferred types. */
export function declarationOverrides(inferred: Map<string, string>): Map<string, string> {
  return new Map([...inferred].filter(([key]) => key.startsWith('dts:')));
}

/** The edits a pack's pinned declaration overrides make to declaration file `dts`. */
function packEdits(
  dts: string,
  sf: ts.SourceFile,
): { at: number; remove: number; insert: string }[] {
  const root = packageRoot(dts);
  const { name, version } = (root?.json ?? {}) as { name?: unknown; version?: unknown };
  return root && typeof name === 'string' && typeof version === 'string'
    ? overrideEdits({ name, version }, root.dir, dts, sf)
    : [];
}

/** Declaration file `dts` as a pack's overrides state it (its text where none applies). */
function packedDeclarations(dts: string): string {
  const text = readFileSync(dts, 'utf8');
  const edits = packEdits(dts, ts.createSourceFile(dts, text, ts.ScriptTarget.Latest, true));
  let out = '';
  let from = 0;
  for (const e of edits.sort((a, b) => a.at - b.at)) {
    out += text.slice(from, e.at) + e.insert;
    from = e.at + e.remove;
  }
  return out + text.slice(from);
}

/**
 * The text of `exportAllDeclarations`, and where a position of the
 * declaration file is in it.
 */
function virtualDeclarations(
  dts: string,
  overrides: Map<string, string> = new Map(),
): { text: string; position: (pos: number) => number } {
  const text = readFileSync(dts, 'utf8');
  const sf = ts.createSourceFile(dts, text, ts.ScriptTarget.Latest, true);
  const edits: { at: number; remove: number; insert: string }[] = [];
  for (const [key, type] of overrides) {
    const at = Number(key.split(':')[1]);
    if (text.startsWith('any', at)) edits.push({ at, remove: 3, insert: type });
  }
  // Declarations a pack states more exactly, where the file is the pinned one.
  edits.push(...packEdits(dts, sf));
  for (const stmt of sf.statements) {
    const declaration =
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isVariableStatement(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      // (A namespace merged with a function: embla's `declare namespace
      // EmblaCarousel { let globalOptions }`.)
      (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name));
    const exported = ts
      .getModifiers(stmt as ts.HasModifiers)
      ?.some(
        m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
      );
    if (declaration && !exported)
      edits.push({ at: stmt.getStart(sf), remove: 0, insert: 'export ' });
  }
  edits.sort((a, b) => a.at - b.at);
  let out = '';
  let from = 0;
  for (const e of edits) {
    out += text.slice(from, e.at) + e.insert;
    from = e.at + e.remove;
  }
  out += text.slice(from);
  const position = (pos: number) => {
    let shift = 0;
    for (const e of edits)
      if (e.at < pos || (e.at === pos && e.remove === 0)) shift += e.insert.length - e.remove;
    return pos + shift;
  };
  // Its imports too (generic classes' annotations name them: `__dts.AnyFn`).
  const imported: string[] = [];
  for (const stmt of sf.statements) {
    const clause = ts.isImportDeclaration(stmt) ? stmt.importClause : undefined;
    if (clause?.name) imported.push(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) imported.push(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const el of bindings.elements) imported.push(el.name.text);
  }
  if (imported.length) out += `\nexport { ${imported.join(', ')} };\n`;
  return { text: out, position };
}

/** The declaration file next to a JavaScript module (`x.js` → `x.d.ts`). */
export function declarationFile(file: string): string | undefined {
  const dts = file.replace(/\.(m?)js$/, '.d.$1ts');
  return dts !== file && existsSync(dts) ? dts : undefined;
}

/**
 * The package directory holding `file`: the nearest directory above it with
 * a package.json that names a package.
 */
export function packageRoot(
  file: string,
): { dir: string; json: Record<string, unknown> } | undefined {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const p = path.join(dir, 'package.json');
    if (!existsSync(p)) continue;
    try {
      const json = JSON.parse(readFileSync(p, 'utf8'));
      if (json && typeof json.name === 'string') return { dir, json };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The types entry of the package condition whose JavaScript is `file`:
 * `exports["."]`'s `import` (or the root condition) with `types` and
 * `default`, or the top-level `module` with `types`.
 */
function bundleTypesEntry(file: string): string | undefined {
  const root = packageRoot(file);
  if (!root) return undefined;
  const at = (rel: unknown) => (typeof rel === 'string' ? path.resolve(root.dir, rel) : undefined);
  const exp = root.json.exports as Record<string, unknown> | undefined;
  const dot = exp && typeof exp === 'object' ? (exp['.'] as Record<string, unknown>) : undefined;
  for (const cond of dot && typeof dot === 'object' ? [dot.import, dot] : []) {
    if (!cond || typeof cond !== 'object') continue;
    const c = cond as Record<string, unknown>;
    if (at(c.default) === file && at(c.types)) return at(c.types);
  }
  if (at(root.json.module) === file && at(root.json.types)) return at(root.json.types);
  return undefined;
}

/**
 * A bundle's declarations (M6 script DOM, slice 4: embla-carousel and its
 * packages, user decision 2026-10-14): a package that publishes its modules
 * as one untyped bundle (`esm/embla-carousel.esm.js`) ships a declaration
 * file per source module instead of one beside the bundle
 * (`esm/components/*.d.ts`). Where no `x.d.ts` lies beside the module and
 * the package's export condition resolving to it names a types entry
 * (`esm/index.d.ts`), the declaration files are those in the entry's
 * directory and below it (the package's declarations of that build, also
 * of modules the entry does not re-export), and each top-level
 * function, class or constant of the bundle is bound to the one file
 * declaring it at its top level under the same name (a name declared by
 * none or by several stays untyped, as without declarations).
 */
export function bundleDeclarations(
  file: string,
  sf: ts.SourceFile,
):
  | { entry: string; files: { dts: string; declared: Declared }[]; names: Map<string, number> }
  | undefined {
  const entry = bundleTypesEntry(file);
  if (!entry || !existsSync(entry)) return undefined;
  const reached: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) =>
      x.name < y.name ? -1 : x.name > y.name ? 1 : 0,
    )) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') walk(p);
      else if (e.isFile() && /\.d\.m?ts$/.test(e.name)) reached.push(p);
    }
  };
  walk(path.dirname(entry));
  const files = reached.map(dts => ({ dts, declared: declarations(dts) }));
  const names = new Map<string, number>();
  const declares = (d: Declared, name: string) =>
    d.functions.has(name) || d.classes.has(name) || d.variables.has(name);
  for (const stmt of sf.statements) {
    const found: string[] = [];
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      if (stmt.name) found.push(stmt.name.text);
    } else if (ts.isVariableStatement(stmt))
      for (const v of stmt.declarationList.declarations)
        if (ts.isIdentifier(v.name)) found.push(v.name.text);
    for (const name of found) {
      const by = files.flatMap((f, i) => (declares(f.declared, name) ? [i] : []));
      if (by.length === 1) names.set(name, by[0]);
    }
  }
  return { entry, files, names };
}

/**
 * The declaration file declaring top-level `name` of package module
 * `file`: the one beside it, or a bundle's (`bundleDeclarations`).
 */
export function declarationFileOf(file: string, name: string): string | undefined {
  const dts = declarationFile(file);
  if (dts) return dts;
  if (!bundleCache.has(file)) {
    const code = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    bundleCache.set(file, bundleDeclarations(file, sf));
  }
  const bundle = bundleCache.get(file);
  const at = bundle?.names.get(name);
  return at === undefined ? undefined : bundle!.files[at].dts;
}
const bundleCache = new Map<string, ReturnType<typeof bundleDeclarations>>();

/**
 * The names of the class fields of a module that hold an attachment
 * (initialised by svelte-toolbelt's `attachRef(…)`): an object literal
 * spreading one (`...this.wrapperAttachment`) builds an attribute bag.
 */
function attachmentFields(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const attach = (e: ts.Expression | undefined) =>
    !!e &&
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'attachRef';
  const visit = (n: ts.Node) => {
    if (ts.isPropertyDeclaration(n) && attach(n.initializer)) out.add(n.name.getText(sf));
    // (Also assigned in a constructor: bits-ui's Select states'
    // `this.attachment = attachRef(…)`.)
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      attach(n.right)
    )
      out.add(n.left.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Whether `init` builds an attribute bag: an object literal with a
 * computed key or a spread of an attachment field (`attachments`),
 * directly or as a derived value.
 */
function bagInitializer(
  init: ts.Expression | undefined,
  attachments: Set<string> = new Set(),
): boolean {
  if (!init) return false;
  // (Also svelte-toolbelt's `mergeProps(…)`, which returns a bag: bits-ui's
  // `props = $derived.by(() => mergeProps(this.item.props, { … }))`.)
  const merged = (e: ts.Node): boolean =>
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'mergeProps' &&
    e
      .getSourceFile()
      .statements.some(
        st =>
          ts.isImportDeclaration(st) &&
          ts.isStringLiteral(st.moduleSpecifier) &&
          st.moduleSpecifier.text === 'svelte-toolbelt' &&
          !!st.importClause?.namedBindings &&
          ts.isNamedImports(st.importClause.namedBindings) &&
          st.importClause.namedBindings.elements.some(
            el => el.name.text === 'mergeProps' && !el.propertyName,
          ),
      );
  const object = (e: ts.Node | undefined): boolean => {
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
    if (e && merged(e)) return true;
    return (
      !!e &&
      ts.isObjectLiteralExpression(e) &&
      e.properties.some(
        p =>
          (p.name && ts.isComputedPropertyName(p.name)) ||
          (ts.isSpreadAssignment(p) &&
            ts.isPropertyAccessExpression(p.expression) &&
            attachments.has(p.expression.name.text)),
      )
    );
  };
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (object(e)) return true;
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression.getText();
  if (callee === '$derived') return object(e.arguments[0]);
  if (callee !== '$derived.by') return false;
  const fn = e.arguments[0];
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  if (!ts.isBlock(fn.body)) return object(fn.body);
  const last = fn.body.statements.at(-1);
  return !!last && ts.isReturnStatement(last) && object(last.expression);
}

/**
 * The untyped constant a function builds from an object literal and returns
 * (`const style = { … }; …; return style;`): its declaration, where the
 * body's last statement returns it and no other statement of the function
 * (outside nested functions) returns.
 */
function returnedLiteral(fn: ts.FunctionDeclaration): ts.VariableDeclaration | undefined {
  const body = fn.body!.statements;
  const last = body.at(-1);
  if (!last || !ts.isReturnStatement(last) || !last.expression || !ts.isIdentifier(last.expression))
    return undefined;
  const name = last.expression.text;
  let returns = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) returns++;
    ts.forEachChild(n, visit);
  };
  body.forEach(visit);
  if (returns !== 1) return undefined;
  for (const st of body)
    if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const)
      for (const d of st.declarationList.declarations)
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          !d.type &&
          d.initializer &&
          ts.isObjectLiteralExpression(d.initializer)
        )
          return d;
  return undefined;
}

/**
 * The number of parameters member `member` of what function `fn` returns
 * is declared with, where `fn`'s declared result names a type literal (an
 * alias or an interface of the same declaration file) declaring the member
 * as a function type or a method; undefined where it is declared otherwise.
 */
function declaredMemberArity(declared: Declared, fn: string, member: string): number | undefined {
  return declaredMember(declared, fn, member)?.parameters.length;
}

/**
 * The function type (or method signature) member `member` of what function
 * `fn` returns is declared with (`declaredMemberArity`), if any.
 */
function declaredMember(
  declared: Declared,
  fn: string,
  member: string,
): ts.FunctionTypeNode | ts.MethodSignature | undefined {
  const sf = declared.sf;
  const decl = sf?.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === fn,
  );
  const result = decl?.type;
  if (!sf || !result || !ts.isTypeReferenceNode(result) || !ts.isIdentifier(result.typeName))
    return undefined;
  const name = result.typeName.text;
  const target = sf.statements.find(
    s => (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name.text === name,
  ) as ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined;
  const members = !target
    ? undefined
    : ts.isInterfaceDeclaration(target)
      ? target.members
      : ts.isTypeLiteralNode(target.type)
        ? target.type.members
        : undefined;
  const m = members?.find(x => x.name && ts.isIdentifier(x.name) && x.name.text === member);
  if (!m) return undefined;
  if (ts.isMethodSignature(m)) return m;
  if (ts.isPropertySignature(m) && m.type && ts.isFunctionTypeNode(m.type)) return m.type;
  return undefined;
}

/**
 * The functions a function declares in its body and returns as members of
 * the object literal its last statement returns (`return { announce }`, or
 * `announce: announce`), with their member names; none where another
 * statement of the function (outside nested functions) returns.
 */
function returnedFunctions(fn: ts.FunctionDeclaration): [string, ts.FunctionDeclaration][] {
  const body = fn.body!.statements;
  const last = body.at(-1);
  if (!last || !ts.isReturnStatement(last) || !last.expression) return [];
  // (Also of the constant it builds and returns, `returnedLiteral`:
  // embla-carousel's factories, `const self = { add, clear }; return self`.)
  const literal = ts.isIdentifier(last.expression)
    ? returnedLiteral(fn)?.initializer
    : last.expression;
  if (!literal || !ts.isObjectLiteralExpression(literal)) return [];
  let returns = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) returns++;
    ts.forEachChild(n, visit);
  };
  body.forEach(visit);
  if (returns !== 1) return [];
  const declared = new Map(
    body
      .filter(
        (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.name && !!s.body,
      )
      .map(s => [s.name!.text, s]),
  );
  // (A constant naming one of them: embla's `const reInit = reActivate`.)
  for (const s of body)
    if (ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const)
      for (const d of s.declarationList.declarations) {
        const init = d.initializer && ts.isIdentifier(d.initializer) ? d.initializer : undefined;
        const target = init && declared.get(init.text);
        if (ts.isIdentifier(d.name) && target && !declared.has(d.name.text))
          declared.set(d.name.text, target);
      }
  const out: [string, ts.FunctionDeclaration][] = [];
  for (const p of literal.properties) {
    const name = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
    const ref = ts.isShorthandPropertyAssignment(p)
      ? p.name.text
      : ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)
        ? p.initializer.text
        : undefined;
    const target = ref && declared.get(ref);
    if (name && target && !target.typeParameters) out.push([name, target]);
  }
  return out;
}

/**
 * The virtual module of package module `file`: its JavaScript with type
 * annotations from its declaration file and `inferred` field types.
 */
export function annotate(
  file: string,
  code: string,
  inferred: Map<string, string> = new Map(),
): PackageModule {
  const virtual = file + '.__runic.ts';
  const dts = declarationFile(file);
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // The declarations of each top-level name, and the namespace the
  // annotations name them through: the one file beside the module
  // (`__dts`), or for a bundle the file declaring that name
  // (`bundleDeclarations`, `__dts0`, `__dts1`, …).
  const none: Declared = {
    functions: new Map(),
    classes: new Map(),
    variables: new Set(),
    top: new Set<string>(),
  };
  const single: Declared | undefined = dts ? declarations(dts) : undefined;
  const bundle = dts ? undefined : bundleDeclarations(file, sf);
  const of = (name: string): { declared: Declared; ns: string } => {
    if (single) return { declared: single, ns: '__dts' };
    const bound = bundle?.names.get(name);
    return bound !== undefined
      ? { declared: bundle!.files[bound].declared, ns: `__dts${bound}` }
      : { declared: none, ns: '__dts' };
  };
  const attachments = attachmentFields(sf);
  const inserts: { at: number; text: string }[] = [];
  const add = (at: number, text: string) => inserts.push({ at, text });
  /** The position after the closing parenthesis of a parameter list. */
  const afterParams = (decl: ts.SignatureDeclaration) => {
    const close = code.indexOf(')', decl.parameters.end);
    return close < 0 ? undefined : close + 1;
  };
  const params = (decl: ts.SignatureDeclaration, type: (i: number) => string) =>
    decl.parameters.forEach((p, i) => {
      if (!p.type && ts.isIdentifier(p.name) && !p.dotDotDotToken) add(p.name.end, `: ${type(i)}`);
    });
  const result = (decl: ts.SignatureDeclaration, type: string) => {
    const at = afterParams(decl);
    if (at !== undefined && !decl.type) add(at, `: ${type}`);
  };
  for (const stmt of sf.statements) {
    // A static property of a function the declaration file declares in a
    // namespace merged with it (embla-carousel's `EmblaCarousel.globalOptions
    // = undefined`): the value assigned at the top level is of its declared
    // type, which TypeScript gives the property it adds to the function.
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(stmt.expression.left) &&
      ts.isIdentifier(stmt.expression.left.expression)
    ) {
      const fn = stmt.expression.left.expression.text;
      const prop = stmt.expression.left.name.text;
      const { declared, ns } = of(fn);
      if (declared.functions.has(fn) && declared.statics?.get(fn)?.has(prop))
        add(stmt.expression.right.end, ` as (typeof ${ns}.${fn})[${JSON.stringify(prop)}]`);
      continue;
    }
    // Exported constants take their declared types (runed `Context<T>` keys).
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.type) continue;
        const { declared, ns } = of(d.name.text);
        if (declared.variables.has(d.name.text)) add(d.name.end, `: typeof ${ns}.${d.name.text}`);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const { declared, ns } = of(stmt.name.text);
      const d = declared.functions.get(stmt.name.text);
      if (!d) continue;
      // A generic function of one signature with plain type parameters
      // (bits-ui's `boxAutoReset<T>(…): WritableBox<T>`): its type
      // parameters, parameter and result types written out from the
      // declaration file, so that calls are typed and its body sees its
      // options' types (`getWindow: () => Window`). It is still specialised
      // per call site (`Lowerer.declare`). (A constrained parameter, such as
      // createBitsAttrs' `const T extends readonly string[]`, is left out.)
      if (d.generic) {
        const dts = declared.sf?.statements.find(
          (x): x is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(x) && x.name?.text === stmt.name!.text,
        );
        const plainParams = dts?.typeParameters?.every(
          t =>
            !t.constraint &&
            !t.default &&
            !ts.getModifiers(t)?.some(m => m.kind === ts.SyntaxKind.ConstKeyword),
        );
        // (Each bound by a parameter declared of it, `T`, `T[]` or
        // `Array<T>`, which specialisation binds, `Lowerer.bindTypeParameters`:
        // not floating-svelte's `get<T>(v: MaybeGetter<T>)`.)
        const binds = (n: ts.TypeNode, name: string): boolean =>
          ts.isTypeOperatorNode(n)
            ? binds(n.type, name)
            : ts.isParenthesizedTypeNode(n)
              ? binds(n.type, name)
              : ts.isArrayTypeNode(n)
                ? binds(n.elementType, name)
                : ts.isTypeReferenceNode(n) &&
                  ts.isIdentifier(n.typeName) &&
                  ((n.typeName.text === name && !n.typeArguments) ||
                    (['Array', 'ReadonlyArray'].includes(n.typeName.text) &&
                      n.typeArguments?.length === 1 &&
                      binds(n.typeArguments[0], name)));
        const bindable = dts?.typeParameters?.every(tp =>
          dts.parameters.some(
            dp => !!dp.type && !dp.dotDotDotToken && binds(dp.type, tp.name.text),
          ),
        );
        if (d.signatures !== 1 || !dts?.type || !plainParams || !bindable || stmt.typeParameters)
          continue;
        const local = new Set(dts.typeParameters!.map(t => t.name.text));
        const q = (n: ts.Node) => qualified(n, declared.sf!, declared.top, local, ns);
        add(stmt.name.end, `<${dts.typeParameters!.map(q).join(', ')}>`);
        stmt.parameters.forEach((p, i) => {
          const dp = dts.parameters[i];
          if (!dp?.type || p.type || !ts.isIdentifier(p.name)) return;
          const optional = !!dp.questionToken && !p.initializer && !p.dotDotDotToken;
          add(p.name.end, `${optional ? '?' : ''}: ${q(dp.type)}`);
        });
        result(stmt, q(dts.type));
        continue;
      }
      if (d.signatures === 1) {
        const f = `typeof ${ns}.${stmt.name.text}`;
        params(stmt, i => `Parameters<${f}>[${i}]`);
        // A type predicate (`element is HTMLElement`) narrows at call sites.
        const predicate = /^(\w+) is /.exec(d.overloads[0].result);
        const named = predicate && stmt.parameters.some(p => p.name.getText(sf) === predicate[1]);
        result(stmt, named ? d.overloads[0].result : `ReturnType<${f}>`);
        // The object the function builds and returns (bits-ui's Slider
        // `getTickStyles`: `const style = { position: "absolute" }`, then
        // `style.left = …`, `return style`) is of its declared result type.
        const built = named ? undefined : returnedLiteral(stmt);
        if (built) add(built.name.end, `: ReturnType<${f}>`);
        // Functions it returns as members of an object literal (bits-ui's
        // `getAnnouncer(doc)`: `function announce(value, kind = "assertive",
        // …)`, then `return { announce }`) take the declared member's type.
        if (!named)
          for (const [member, fn] of returnedFunctions(stmt)) {
            const m = `ReturnType<${f}>[${JSON.stringify(member)}]`;
            // A generic member (embla's `groupSlides: <Type>(array: Type[])
            // => Type[][]`): the function is declared generic, its type
            // parameters, parameters and result written out from the
            // declaration file (a generic member of the record type,
            // TypeMapper `genericFields`).
            const dm = declaredMember(declared, stmt.name.text, member);
            if (dm?.typeParameters?.length && declared.sf && !fn.typeParameters) {
              const local = new Set(dm.typeParameters.map(t => t.name.text));
              const q = (n: ts.Node) => qualified(n, declared.sf!, declared.top, local, ns);
              add(fn.name!.end, `<${dm.typeParameters.map(q).join(', ')}>`);
              fn.parameters.forEach((p, i) => {
                const dp = dm.parameters[i];
                if (!dp?.type || p.type || !ts.isIdentifier(p.name) || p.dotDotDotToken) return;
                const optional = !!dp.questionToken && !p.initializer;
                add(p.name.end, `${optional ? '?' : ''}: ${q(dp.type)}`);
              });
              if (dm.type) result(fn, q(dm.type));
              continue;
            }
            // (Parameters the member does not declare, called only by the
            // module itself, are typed from their calls: embla's
            // `scrollTo(index, jump, direction)` of `scrollTo(index, jump?)`.)
            const arity = declaredMemberArity(declared, stmt.name.text, member);
            fn.parameters.forEach((p, i) => {
              if (p.type || !ts.isIdentifier(p.name) || p.dotDotDotToken) return;
              if (arity === undefined || i < arity) add(p.name.end, `: Parameters<${m}>[${i}]`);
            });
            result(fn, `ReturnType<${m}>`);
          }
        continue;
      }
      // Overloads (`createId(uid)`, `createId(prefix, uid)`): each parameter
      // takes the union of the overloads' types for it, optional where an
      // overload omits it; written out where the types are keywords.
      const simple = (t: string) => /^(string|number|boolean|void|undefined|null)$/.test(t);
      const all = d.overloads.flatMap(o => [o.result, ...o.params.map(p => p.type)]);
      if (!all.every(simple)) continue;
      stmt.parameters.forEach((p, i) => {
        if (p.type || !ts.isIdentifier(p.name) || p.dotDotDotToken) return;
        const types = [
          ...new Set(d.overloads.flatMap(o => (o.params[i] ? [o.params[i].type] : []))),
        ];
        const optional = d.overloads.some(o => !o.params[i] || o.params[i].optional);
        if (!types.length) return;
        add(p.name.end, `${optional && !p.initializer ? '?' : ''}: ${types.join(' | ')}`);
      });
      result(stmt, [...new Set(d.overloads.map(o => o.result))].join(' | '));
      continue;
    }
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    const cls = stmt.name.text;
    const { declared, ns } = of(cls);
    const d = declared.classes.get(cls);
    const C = `${ns}.${cls}`;
    // A generic class (bits-ui's `SharedState<T extends AnyFn>`): its type
    // parameters and member types written out from the declaration file.
    if (d?.generic && declared.sf) {
      const sf = declared.sf;
      const dc = d.decl;
      const local = new Set(dc.typeParameters!.map(t => t.name.text));
      const q = (n: ts.Node) => qualified(n, sf, declared.top, local, ns);
      if (!stmt.typeParameters) add(stmt.name.end, `<${dc.typeParameters!.map(q).join(', ')}>`);
      const typedParams = (js: ts.SignatureDeclaration, dts: ts.SignatureDeclaration | undefined) =>
        dts &&
        js.parameters.forEach((p, i) => {
          const dp = dts.parameters[i];
          if (!dp?.type || p.type || !ts.isIdentifier(p.name)) return;
          const optional = !!dp.questionToken && !p.initializer && !p.dotDotDotToken;
          add(p.name.end, `${optional ? '?' : ''}: ${q(dp.type)}`);
        });
      const member = (name: string, isStatic: boolean, kind: ts.SyntaxKind) =>
        dc.members.find(
          x =>
            x.kind === kind &&
            x.name !== undefined &&
            ts.isIdentifier(x.name) &&
            x.name.text === name &&
            (ts.canHaveModifiers(x) &&
              !!ts.getModifiers(x)?.some(y => y.kind === ts.SyntaxKind.StaticKeyword)) === isStatic,
        );
      for (const m of stmt.members) {
        const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined;
        const isStatic =
          ts.canHaveModifiers(m) &&
          !!ts.getModifiers(m)?.some(x => x.kind === ts.SyntaxKind.StaticKeyword);
        if (ts.isPropertyDeclaration(m) && !isStatic && !m.type) {
          const key = `${cls}.${m.name.getText()}`;
          const dp = name ? member(name, false, ts.SyntaxKind.PropertyDeclaration) : undefined;
          if (bagInitializer(m.initializer, attachments)) add(m.name.end, ': RunicAttrs');
          else if (inferred.has(key)) add(m.name.end, `: ${inferred.get(key)}`);
          else if (dp && (dp as ts.PropertyDeclaration).type)
            add(m.name.end, `: ${q((dp as ts.PropertyDeclaration).type!)}`);
          continue;
        }
        if (ts.isConstructorDeclaration(m) && m.body)
          typedParams(m, dc.members.find(ts.isConstructorDeclaration));
        else if (ts.isMethodDeclaration(m) && name && m.body) {
          const all = dc.members.filter(
            x => ts.isMethodDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === name,
          ) as ts.MethodDeclaration[];
          const dm = all.length === 1 ? all[0] : undefined;
          if (!dm || dm.typeParameters?.length) continue;
          typedParams(m, dm);
          const at = afterParams(m);
          if (dm.type && at !== undefined && !m.type) add(at, `: ${q(dm.type)}`);
        } else if (ts.isGetAccessor(m) && name) {
          const g = member(name, isStatic, ts.SyntaxKind.GetAccessor) as
            ts.GetAccessorDeclaration | undefined;
          const at = afterParams(m);
          if (g?.type && at !== undefined && !m.type) add(at, `: ${q(g.type)}`);
        } else if (ts.isSetAccessor(m) && name) {
          const s = member(name, isStatic, ts.SyntaxKind.SetAccessor) as
            ts.SetAccessorDeclaration | undefined;
          typedParams(m, s);
        }
      }
      continue;
    }
    for (const m of stmt.members) {
      const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined;
      const isStatic =
        ts.canHaveModifiers(m) &&
        !!ts.getModifiers(m)?.some(x => x.kind === ts.SyntaxKind.StaticKeyword);
      if (ts.isPropertyDeclaration(m) && !isStatic && !m.type) {
        const key = `${cls}.${m.name.getText()}`;
        if (bagInitializer(m.initializer, attachments)) add(m.name.end, ': RunicAttrs');
        else if (inferred.has(key)) add(m.name.end, `: ${inferred.get(key)}`);
        else if (name && d && !d.generic && d.properties.has(name))
          add(m.name.end, `: ${C}["${name}"]`);
        continue;
      }
      // A static field the declaration file declares (FocusScopeManager's
      // `static instance`).
      if (
        ts.isPropertyDeclaration(m) &&
        isStatic &&
        !m.type &&
        name &&
        d &&
        !d.generic &&
        d.decl.members.some(
          x =>
            ts.isPropertyDeclaration(x) &&
            ts.isIdentifier(x.name) &&
            x.name.text === name &&
            !!ts.getModifiers(x)?.some(y => y.kind === ts.SyntaxKind.StaticKeyword),
        )
      ) {
        add(m.name.end, `: (typeof ${C})["${name}"]`);
        continue;
      }
      if (!d || d.generic) continue;
      if (ts.isConstructorDeclaration(m) && m.body)
        params(m, i => `ConstructorParameters<typeof ${C}>[${i}]`);
      else if (ts.isMethodDeclaration(m) && name && m.body) {
        const table = isStatic ? d.statics : d.methods;
        const sig = table.get(name);
        if (!sig || sig.signatures !== 1 || sig.generic) continue;
        const f = isStatic ? `(typeof ${C})["${name}"]` : `${C}["${name}"]`;
        params(m, i => `Parameters<${f}>[${i}]`);
        result(m, `ReturnType<${f}>`);
      } else if (ts.isGetAccessor(m) && name && !isStatic && d.accessors.has(name))
        result(m, `${C}["${name}"]`);
      else if (ts.isSetAccessor(m) && name && !isStatic && d.accessors.has(name))
        params(m, () => `${C}["${name}"]`);
    }
  }
  // Type arguments of collections inferred by the second pass (`new:<end>`),
  // types of untyped parameters from their calls (`param:<end>`), and of
  // constants that start as empty arrays (`var:<end>`).
  for (const [key, text] of inferred) {
    if (key.startsWith('new:')) add(Number(key.slice(4)), `<${text}>`);
    if (key.startsWith('param:')) add(Number(key.slice(6)), `: ${text}`);
    if (key.startsWith('ret:')) add(Number(key.slice(4)), `: ${text}`);
    if (key.startsWith('var:')) add(Number(key.slice(4)), `: ${text}`);
  }
  inserts.sort((a, b) => a.at - b.at);
  let text = dts ? `import type * as __dts from ${JSON.stringify(DTS_PREFIX + dts)};\n` : '';
  bundle?.files.forEach(
    (f, i) => (text += `import type * as __dts${i} from ${JSON.stringify(DTS_PREFIX + f.dts)};\n`),
  );
  const segments: PackageModule['segments'] = [];
  let from = 0;
  for (const ins of [...inserts, { at: code.length, text: '' }]) {
    segments.push({ synth: text.length, orig: from, length: ins.at - from });
    text += code.slice(from, ins.at) + ins.text;
    from = ins.at;
  }
  // The declaration file's types (interfaces, aliases, re-exported types)
  // stay importable through the module, as when TypeScript reads the package.
  if (dts) text += `\nexport type * from ${JSON.stringify(DTS_PREFIX + dts)};\n`;
  // (A bundle's: those of its package's types entry.)
  if (bundle) text += `\nexport type * from ${JSON.stringify(DTS_PREFIX + bundle.entry)};\n`;
  return {
    file,
    virtual,
    ...(dts ? { dts } : {}),
    ...(bundle ? { bundleDts: bundle.files.map(f => f.dts) } : {}),
    text,
    segments,
    inferred,
  };
}

/**
 * The second pass: types for class fields that neither the declaration
 * file nor TypeScript's inference from the initialiser describe fully,
 * from the values the class assigns to them. Returns the modules whose
 * annotations changed.
 */
export function inferFields(
  modules: Map<string, PackageModule>,
  program: ts.Program,
): PackageModule[] {
  const checker = program.getTypeChecker();
  const changed: PackageModule[] = [];
  /**
   * The method `x.m(…)` calls where untyped JavaScript's `x` is a variable
   * assigned instances of one class (`let scope = null; … scope = new
   * FocusScope(opts); scope.mount(ref)`).
   */
  const untypedReceiverMethod = (n: ts.CallExpression): ts.Node | undefined => {
    const callee = n.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return;
    if (!(checker.getTypeAtLocation(callee.expression).flags & ts.TypeFlags.Any)) return;
    const sym = checker.getSymbolAtLocation(callee.expression);
    const decl = sym?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl)) return;
    let scope: ts.Node = decl.parent;
    while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    const classes = new Set<ts.ClassDeclaration>();
    let other = false;
    const visit = (x: ts.Node) => {
      const assigned =
        ts.isBinaryExpression(x) &&
        x.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(x.left) &&
        checker.getSymbolAtLocation(x.left) === sym
          ? x.right
          : x === decl
            ? decl.initializer
            : undefined;
      if (assigned) {
        let v = assigned;
        while (ts.isParenthesizedExpression(v)) v = v.expression;
        if (ts.isNewExpression(v)) {
          let c = checker.getSymbolAtLocation(v.expression);
          if (c && c.flags & ts.SymbolFlags.Alias) c = checker.getAliasedSymbol(c);
          const cd = c?.valueDeclaration;
          if (cd && ts.isClassDeclaration(cd)) classes.add(cd);
          else other = true;
        } else if (
          v.kind !== ts.SyntaxKind.NullKeyword &&
          !(ts.isIdentifier(v) && v.text === 'undefined')
        )
          other = true;
      }
      ts.forEachChild(x, visit);
    };
    visit(scope);
    if (other || classes.size !== 1) return;
    const [cls] = classes;
    return cls.members.find(
      m => ts.isMethodDeclaration(m) && m.name.getText() === callee.name.text,
    );
  };
  /** The calls (and `new`s) of each function-like declaration, program-wide. */
  let callsOf: Map<ts.Node, (ts.CallExpression | ts.NewExpression)[]> | undefined;
  const calls = (decl: ts.Node): (ts.CallExpression | ts.NewExpression)[] => {
    if (!callsOf) {
      callsOf = new Map();
      for (const f of program.getSourceFiles()) {
        if (f.isDeclarationFile) continue;
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
            const d =
              checker.getResolvedSignature(n)?.declaration ??
              (ts.isCallExpression(n) ? untypedReceiverMethod(n) : undefined);
            if (d) {
              const list = callsOf!.get(d) ?? [];
              list.push(n);
              callsOf!.set(d, list);
            }
          }
          ts.forEachChild(n, visit);
        };
        visit(f);
      }
    }
    return callsOf.get(decl) ?? [];
  };
  const print = (t: ts.Type, at: ts.Node): string | undefined => {
    // (`never`: a value narrowed away while other types are still unknown.)
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return undefined;
    const node = checker.typeToTypeNode(
      t,
      at,
      ts.NodeBuilderFlags.NoTruncation |
        ts.NodeBuilderFlags.UseFullyQualifiedType |
        ts.NodeBuilderFlags.AllowNodeModulesRelativePaths,
    );
    if (!node) return undefined;
    const printed = ts
      .createPrinter({ removeComments: true })
      .printNode(ts.EmitHint.Unspecified, node, at.getSourceFile());
    // Function types are parenthesised: the field's type may be a union.
    const text =
      ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node) ? `(${printed})` : printed;
    return /\bany\b/.test(text) ? undefined : text;
  };
  /**
   * An object literal argument whose function members have parameters not
   * typed yet (bits-ui's `new MenuSubmenuIntent({ onIntentExit:
   * (pointerPoint) => … })`, typed from the callee's calls of the option,
   * which need the callee's parameter typed first): its type with
   * `unknown` for those parameters, provisionally. Later passes infer the
   * type again; an `unknown` that remains is rejected where it is used.
   */
  const provisional = (a: ts.Expression): string | undefined => {
    const lit = skipParensOf(a);
    if (!ts.isObjectLiteralExpression(lit)) return undefined;
    const members: string[] = [];
    for (const prop of lit.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) return undefined;
      const v = skipParensOf(prop.initializer);
      let text: string | undefined;
      if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) {
        const sig = checker.getSignatureFromDeclaration(v);
        const result = sig && print(sig.getReturnType(), v);
        const params = v.parameters.map(fp => {
          if (fp.dotDotDotToken || !ts.isIdentifier(fp.name)) return undefined;
          const t = checker.getTypeAtLocation(fp);
          return `${fp.name.text}: ${t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ? 'unknown' : print(t, fp)}`;
        });
        if (result !== undefined && params.every(x => x !== undefined && !x.endsWith('undefined')))
          text = `(${params.join(', ')}) => ${result}`;
      } else {
        const t = checker.getTypeAtLocation(v);
        text = print(checker.getBaseTypeOfLiteralType(t), v);
      }
      if (text === undefined) return undefined;
      members.push(`${prop.name.text}: ${text}`);
    }
    return `{ ${members.join('; ')} }`;
  };
  /**
   * The result type of a call of an untyped package function whose
   * declaration file declares it generic with plain type parameters
   * (bits-ui's `boxAutoReset<T>(defaultValue: T, …): WritableBox<T>`,
   * called `boxAutoReset("", …)`), instantiated with each parameter's type
   * from the argument declared of exactly that type:
   * `ReturnType<typeof import("…").boxAutoReset<string>>`.
   */
  const genericResult = (e: ts.Expression): string | undefined => {
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    let sym = checker.getSymbolAtLocation(e.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const fn = sym?.valueDeclaration;
    if (!fn || !ts.isFunctionDeclaration(fn) || !fn.name) return undefined;
    const dts = declarationFileOf(
      fn.getSourceFile().fileName.replace(/\.__runic\.ts$/, ''),
      fn.name.text,
    );
    const declared = dts ? declarations(dts) : undefined;
    const df = declared?.sf?.statements.filter(
      (x): x is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(x) && x.name?.text === fn.name!.text,
    );
    if (!df || df.length !== 1 || !df[0].typeParameters?.length) return undefined;
    const d = df[0];
    const args: string[] = [];
    for (const tp of d.typeParameters!) {
      if (tp.constraint || tp.default) return undefined;
      const k = d.parameters.findIndex(
        dp =>
          !!dp.type &&
          ts.isTypeReferenceNode(dp.type) &&
          ts.isIdentifier(dp.type.typeName) &&
          dp.type.typeName.text === tp.name.text &&
          !dp.dotDotDotToken,
      );
      const arg = k >= 0 ? e.arguments[k] : undefined;
      const t = arg && checker.getTypeAtLocation(arg);
      const text = t && print(checker.getBaseTypeOfLiteralType(t), arg!);
      if (!text) return undefined;
      args.push(text);
    }
    return `ReturnType<typeof import(${JSON.stringify(DTS_PREFIX + dts)}).${fn.name.text}<${args.join(', ')}>>`;
  };
  /** Whether `n` is `this.<fieldName>`. */
  const thisField = (n: ts.Node, fieldName: string): n is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(n) &&
    n.expression.kind === ts.SyntaxKind.ThisKeyword &&
    n.name.getText() === fieldName;
  /**
   * The event type a function receives where `n` is the listener of
   * svelte/events' `on(target, "kind", n)`, also as one of the functions
   * svelte-toolbelt's `executeCallbacks(…)` or `composeHandlers(…)`
   * calls there (bits-ui's dismissible and text selection layers).
   */
  const listenerEvent = (n: ts.Node): string | undefined => {
    let at = n;
    const parent = at.parent;
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.includes(at as ts.Expression) &&
      ts.isIdentifier(parent.expression) &&
      (parent.expression.text === 'executeCallbacks' ||
        parent.expression.text === 'composeHandlers') &&
      /[\\/]svelte-toolbelt[\\/]/.test(declaredIn(checker, parent.expression))
    )
      at = parent;
    const on = at.parent;
    if (
      !ts.isCallExpression(on) ||
      on.arguments[2] !== at ||
      !ts.isIdentifier(on.expression) ||
      on.expression.text !== 'on' ||
      !/[\\/]svelte[\\/]/.test(declaredIn(checker, on.expression)) ||
      !on.arguments[1] ||
      !ts.isStringLiteralLike(on.arguments[1])
    )
      return undefined;
    const kind = on.arguments[1].text;
    return /^key/.test(kind)
      ? 'KeyboardEvent'
      : /^pointer/.test(kind)
        ? 'PointerEvent'
        : /^focus|^blur/.test(kind)
          ? 'FocusEvent'
          : /^(click|dblclick|contextmenu|mouse)/.test(kind)
            ? 'MouseEvent'
            : 'Event';
  };
  /**
   * The untyped arrow function of one parameter that call `c` passes
   * first, where the callee is declared to return a function of that
   * argument's parameters (`f<T>(fn: T, …): { (...args: Parameters<T>): … }`).
   */
  const forwardedArrow = (c: ts.CallExpression): ts.ArrowFunction | undefined => {
    const fn = c.arguments[0] && skipParensOf(c.arguments[0]);
    if (!fn || !ts.isArrowFunction(fn) || fn.parameters.length !== 1) return undefined;
    const p = fn.parameters[0];
    if (p.type || p.dotDotDotToken || !ts.isIdentifier(p.name)) return undefined;
    let decl = checker.getResolvedSignature(c)?.declaration;
    // (An untyped package function: as its declaration file declares it.)
    if (decl && ts.isFunctionDeclaration(decl) && decl.name && !decl.typeParameters) {
      const name = decl.name.text;
      const dts = declarationFileOf(
        decl.getSourceFile().fileName.replace(/\.__runic\.ts$/, ''),
        name,
      );
      const declared = dts ? declarations(dts).sf : undefined;
      decl =
        declared?.statements.find(
          (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
        ) ?? decl;
    }
    if (!decl || ts.isJSDocSignature(decl) || !decl.typeParameters || !decl.type) return undefined;
    const first = decl.parameters[0]?.type;
    if (!first || !ts.isTypeReferenceNode(first) || !ts.isIdentifier(first.typeName))
      return undefined;
    const t = first.typeName.text;
    if (!decl.typeParameters.some(tp => tp.name.text === t)) return undefined;
    let forwards = false;
    const visit = (x: ts.Node) => {
      if (
        ts.isTypeReferenceNode(x) &&
        ts.isIdentifier(x.typeName) &&
        x.typeName.text === 'Parameters' &&
        x.typeArguments?.length === 1 &&
        ts.isTypeReferenceNode(x.typeArguments[0]) &&
        ts.isIdentifier(x.typeArguments[0].typeName) &&
        x.typeArguments[0].typeName.text === t &&
        ts.isParameter(x.parent) &&
        x.parent.dotDotDotToken
      )
        forwards = true;
      ts.forEachChild(x, visit);
    };
    visit(decl.type);
    return forwards ? fn : undefined;
  };
  const declaredAny = declaredAnyTypes(modules, program, print);
  for (const [m, map] of listenerAnyTypes(modules, program)) {
    const all = declaredAny.get(m) ?? new Map<string, string>();
    for (const [k, v] of map) all.set(k, v);
    declaredAny.set(m, all);
  }
  for (const m of modules.values()) {
    // A pack's port is typed as written.
    if (m.port) continue;
    const sf = program.getSourceFile(m.virtual);
    if (!sf) continue;
    const attachments = attachmentFields(sf);
    const next = new Map(m.inferred);
    // (Map order is kept: a key set again keeps its place.)
    const anyTypes = declaredAny.get(m) ?? new Map<string, string>();
    for (const key of [...next.keys()])
      if (key.startsWith('dts:') && !anyTypes.has(key)) next.delete(key);
    for (const [key, text] of anyTypes) next.set(key, text);
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      const cls = stmt.name.text;
      const ctor = stmt.members.find(ts.isConstructorDeclaration);
      for (const member of stmt.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        if (
          ts.canHaveModifiers(member) &&
          ts.getModifiers(member)?.some(x => x.kind === ts.SyntaxKind.StaticKeyword)
        )
          continue;
        const fieldName = member.name.getText();
        const key = `${cls}.${fieldName}`;
        // (A type an earlier pass inferred is inferred again: the values
        // assigned may be typed better now, bits-ui's watch tuples.)
        if (member.type && !m.inferred.has(key)) continue;
        if (bagInitializer(member.initializer, attachments)) continue;
        const sym = checker.getSymbolAtLocation(member.name);
        const own = sym && checker.getTypeOfSymbolAtLocation(sym, member);
        const parts: string[] = [];
        const addType = (t: string | undefined) => {
          if (t !== undefined && !parts.includes(t)) parts.push(t);
        };
        /** A value's type, literals widened (`null` and `undefined` kept). */
        const valueType = (t: ts.Type, at: ts.Node) =>
          print(
            t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)
              ? t
              : checker.getBaseTypeOfLiteralType(t),
            at,
          );
        let open = false;
        const init = member.initializer;
        // An object literal the class writes by computed keys (bits-ui's
        // `#interceptedEvents = { pointerdown: false }` and
        // `this.#interceptedEvents[e.type] = true`): a dictionary of its
        // values' type.
        const literal = init && skipParensOf(init);
        if (literal && ts.isObjectLiteralExpression(literal)) {
          let computed = false;
          const visitWrite = (n: ts.Node) => {
            if (
              ts.isBinaryExpression(n) &&
              n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isElementAccessExpression(n.left) &&
              thisField(n.left.expression, fieldName) &&
              !ts.isStringLiteralLike(n.left.argumentExpression)
            )
              computed = true;
            ts.forEachChild(n, visitWrite);
          };
          stmt.members.forEach(visitWrite);
          if (computed) {
            const values = new Set(
              literal.properties.map(p =>
                ts.isPropertyAssignment(p)
                  ? valueType(checker.getTypeAtLocation(p.initializer), p.initializer)
                  : undefined,
              ),
            );
            const [value] = values;
            if (values.size === 1 && value !== undefined) {
              const text = `Record<string, ${value}>`;
              if (next.get(key) !== text) next.set(key, text);
            }
            continue;
          }
        }
        // An arrow function with untyped parameters that the class passes as
        // runed's `watch(sources, effect)` effect (bits-ui's
        // `watch([() => this.open, () => this.opts.ref.current],
        // this.#updateDimensions)`): the function of the sources' values, as
        // if written there (TypeScript infers the sources' types from the
        // untyped effect too, so they are read from the getters).
        if (init && ts.isArrowFunction(init) && init.parameters.some(p => !p.type)) {
          const expected: string[] = [];
          const direct: ts.CallExpression[] = [];
          const visitArg = (n: ts.Node) => {
            if (
              ts.isPropertyAccessExpression(n) &&
              n.expression.kind === ts.SyntaxKind.ThisKeyword &&
              n.name.getText() === fieldName &&
              ts.isCallExpression(n.parent) &&
              n.parent.arguments[1] === n
            ) {
              const call = n.parent;
              const callee = ts.isPropertyAccessExpression(call.expression)
                ? call.expression.expression
                : call.expression;
              const sources = call.arguments[0];
              const watch =
                ts.isIdentifier(callee) &&
                callee.text === 'watch' &&
                /[\\/]runed[\\/]/.test(declaredIn(checker, callee));
              const getters =
                watch && ts.isArrayLiteralExpression(sources)
                  ? sources.elements.map(g =>
                      ts.isArrowFunction(g)
                        ? checker.getSignaturesOfType(
                            checker.getTypeAtLocation(g),
                            ts.SignatureKind.Call,
                          )[0]
                        : undefined,
                    )
                  : undefined;
              const values = getters?.map(s => (s ? print(s.getReturnType(), n) : undefined));
              if (values && values.every(v => v !== undefined)) {
                const tuple = `[${values.join(', ')}]`;
                const text = `((values: ${tuple}) => void)`;
                if (!expected.includes(text)) expected.push(text);
              } else if (watch) expected.push('');
            }
            // svelte/events' `on(target, "keydown", this.#onkeydown)`
            // (bits-ui's escape layer): a listener of that event.
            const event = thisField(n, fieldName) ? listenerEvent(n) : undefined;
            if (
              thisField(n, fieldName) &&
              ts.isCallExpression(n.parent) &&
              n.parent.expression === n
            )
              direct.push(n.parent);
            if (event) {
              const text = `((event: ${event}) => void)`;
              if (!expected.includes(text)) expected.push(text);
            }
            ts.forEachChild(n, visitArg);
          };
          stmt.members.forEach(visitArg);
          if (expected.length === 1 && expected[0] && next.get(key) !== expected[0])
            next.set(key, expected[0]);
          if (expected.length) continue;
          // Called by the class only (bits-ui's `this.#isTargetWithinLayer(event.target)`):
          // each untyped parameter takes the one type the calls pass.
          if (direct.length) {
            init.parameters.forEach((p, i) => {
              if (p.type || p.dotDotDotToken || !ts.isIdentifier(p.name)) return;
              const texts = new Set<string>();
              let open = false;
              for (const c of direct) {
                const a = c.arguments[i];
                const t = a && !ts.isSpreadElement(a) ? checker.getTypeAtLocation(a) : undefined;
                const text =
                  t &&
                  print(
                    t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)
                      ? t
                      : checker.getBaseTypeOfLiteralType(t),
                    a!,
                  );
                if (text === undefined) open = true;
                else texts.add(text);
              }
              const end = p.name.end;
              const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
              if (open || texts.size !== 1 || !seg) return;
              const pkey = `param:${seg.orig + (end - seg.synth)}`;
              const text = [...texts][0];
              if (next.get(pkey) !== text) next.set(pkey, text);
            });
            continue;
          }
        }
        // A listener made by a function forwarding its arguments to an
        // untyped arrow function (bits-ui's `#handleInteractOutside =
        // debounce((e) => …, 10)`, declared `debounce<T>(fn: T): { (...args:
        // Parameters<T>): void; … }`): the arrow's parameter is the event.
        const wrapped = init && ts.isCallExpression(init) ? forwardedArrow(init) : undefined;
        if (wrapped) {
          const events = new Set<string>();
          let other = false;
          const visitUse = (n: ts.Node) => {
            if (thisField(n, fieldName) && !ts.isPropertyAccessExpression(n.parent)) {
              const event = listenerEvent(n);
              if (event) events.add(event);
              else if (!(ts.isCallExpression(n.parent) && n.parent.expression === n)) other = true;
            }
            ts.forEachChild(n, visitUse);
          };
          stmt.members.forEach(visitUse);
          const p = wrapped.parameters[0];
          const end = p.name.end;
          const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
          if (!other && events.size === 1 && seg) {
            const pkey = `param:${seg.orig + (end - seg.synth)}`;
            const event = [...events][0];
            if (next.get(pkey) !== event) next.set(pkey, event);
            // The field: a function of the event, with the properties of
            // the call's result (`destroy`).
            const result = own?.getCallSignatures()[0]?.getReturnType();
            const props = own ? checker.getPropertiesOfType(own) : [];
            const printed = props.map(p =>
              print(checker.getTypeOfSymbolAtLocation(p, init!), init!),
            );
            const ret = result && print(result, init!);
            if (ret !== undefined && printed.every(p => p !== undefined)) {
              const text = `{ (event: ${event}): ${ret}; ${props
                .map((p, i) => `${p.name}: ${printed[i]}`)
                .join('; ')} }`;
              if (next.get(key) !== text) next.set(key, text);
            }
          }
          continue;
        }
        // svelte-toolbelt's `box(initial)` (a writable box of any value):
        // the box of its initial value and of the values the class writes
        // to its `current` (RovingFocusGroup's `#currentTabStopId = box(null)`).
        const boxCall =
          init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          (init.expression.text === 'box' || init.expression.text === 'simpleBox') &&
          /[\\/]svelte-toolbelt[\\/]/.test(declaredIn(checker, init.expression));
        if (boxCall) {
          const values: string[] = [];
          let unknown = false;
          // An array that starts empty (FocusScopeManager's
          // `#scopeStack = simpleBox([])`): the types of the items the class
          // adds (`this.#f.current.push(x)`, `unshift(x)`).
          const first = init.arguments[0] && skipParensOf(init.arguments[0]);
          const emptyArray =
            !!first && ts.isArrayLiteralExpression(first) && !first.elements.length;
          const items: string[] = [];
          const add = (e: ts.Expression) => {
            const p = valueType(checker.getTypeAtLocation(e), e);
            // (An array of nothing yet, written back: `current.filter(…)`.)
            if (emptyArray && p === 'never[]') return;
            if (p === undefined) unknown = true;
            else if (!values.includes(p)) values.push(p);
          };
          if (init.arguments[0] && !emptyArray) add(init.arguments[0]);
          const current = (e: ts.Expression) =>
            ts.isPropertyAccessExpression(e) &&
            e.name.text === 'current' &&
            ts.isPropertyAccessExpression(e.expression) &&
            e.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
            e.expression.name.getText() === fieldName;
          const visitBox = (n: ts.Node) => {
            if (
              ts.isBinaryExpression(n) &&
              n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              current(n.left)
            )
              add(n.right);
            if (
              emptyArray &&
              ts.isCallExpression(n) &&
              ts.isPropertyAccessExpression(n.expression) &&
              ['push', 'unshift'].includes(n.expression.name.text) &&
              current(n.expression.expression)
            )
              for (const a of n.arguments) {
                const p = valueType(checker.getTypeAtLocation(a), a);
                if (p === undefined || p === '{}') unknown = true;
                else if (!items.includes(p)) items.push(p);
              }
            ts.forEachChild(n, visitBox);
          };
          stmt.members.forEach(visitBox);
          if (emptyArray) {
            if (!items.length) unknown = true;
            const array = items.length === 1 ? `${items[0]}[]` : `(${items.join(' | ')})[]`;
            if (!values.includes(array)) values.push(array);
          }
          if (unknown || !values.length) continue;
          const text = `import("svelte-toolbelt").WritableBox<${values.join(' | ')}>`;
          if (next.get(key) !== text) next.set(key, text);
          continue;
        }
        if (init) {
          let value: ts.Expression | undefined = init;
          if (ts.isCallExpression(init)) {
            const callee = init.expression.getText();
            if (callee.startsWith('$derived')) continue;
            if (callee === '$state' || callee === '$state.raw') value = init.arguments[0];
          }
          const t = value ? checker.getTypeAtLocation(value) : checker.getUndefinedType();
          const p = valueType(t, member);
          if (p === undefined) open = true;
          else addType(p);
        }
        // Assignments `this.f = value` in the class (also `??=` and `||=`,
        // which keep the field's value or assign `value`).
        let assigned = 0;
        let topLevel = false;
        const visit = (n: ts.Node) => {
          if (
            ts.isBinaryExpression(n) &&
            [
              ts.SyntaxKind.EqualsToken,
              ts.SyntaxKind.QuestionQuestionEqualsToken,
              ts.SyntaxKind.BarBarEqualsToken,
            ].includes(n.operatorToken.kind) &&
            ts.isPropertyAccessExpression(n.left) &&
            n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
            n.left.name.getText() === fieldName
          ) {
            assigned++;
            if (
              ctor &&
              n.parent &&
              ts.isExpressionStatement(n.parent) &&
              n.parent.parent === ctor.body
            )
              topLevel = true;
            let rhs = n.right;
            while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
            // `this.f = this.f || value` keeps the field's value or takes `value`.
            if (
              ts.isBinaryExpression(rhs) &&
              [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
                rhs.operatorToken.kind,
              ) &&
              ts.isPropertyAccessExpression(rhs.left) &&
              rhs.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
              rhs.left.name.getText() === fieldName
            )
              rhs = rhs.right;
            const p = valueType(checker.getTypeAtLocation(rhs), rhs);
            // A parameter keeps its declared type text.
            const param =
              ts.isIdentifier(rhs) &&
              checker.getSymbolAtLocation(rhs)?.valueDeclaration &&
              ts.isParameter(checker.getSymbolAtLocation(rhs)!.valueDeclaration!)
                ? (checker.getSymbolAtLocation(rhs)!.valueDeclaration as ts.ParameterDeclaration)
                    .type
                : undefined;
            const generic = p === undefined ? genericResult(rhs) : undefined;
            if (param) addType(param.getText());
            else if (generic) addType(generic);
            else if (p === undefined) open = true;
            else addType(p);
          }
          ts.forEachChild(n, visit);
        };
        stmt.members.forEach(visit);
        // An array that starts empty (FocusScope's `#cleanupFns = []`): the
        // types of the items the class adds (`this.#f.push(x)`, `unshift`).
        const emptyInit = init && skipParensOf(init);
        const empty =
          !!emptyInit && ts.isArrayLiteralExpression(emptyInit) && !emptyInit.elements.length;
        if (empty) {
          const items: string[] = [];
          let unknownItem = false;
          const visitItems = (n: ts.Node) => {
            if (
              ts.isCallExpression(n) &&
              ts.isPropertyAccessExpression(n.expression) &&
              ['push', 'unshift'].includes(n.expression.name.text) &&
              ts.isPropertyAccessExpression(n.expression.expression) &&
              n.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
              n.expression.expression.name.getText() === fieldName
            )
              for (const a of n.arguments) {
                const p = valueType(checker.getTypeAtLocation(a), a);
                if (p === undefined || p === '{}') unknownItem = true;
                else if (!items.includes(p)) items.push(p);
              }
            ts.forEachChild(n, visitItems);
          };
          stmt.members.forEach(visitItems);
          if (items.length && !unknownItem) {
            const array = items.length === 1 ? `${items[0]}[]` : `(${items.join(' | ')})[]`;
            const kept = parts.filter(p => p !== 'never[]');
            parts.length = 0;
            parts.push(...kept);
            if (!parts.includes(array)) parts.push(array);
            assigned ||= 1;
            topLevel = true;
          }
        }
        // A field assigned values TypeScript cannot type that a method of a
        // declared result returns (bits-ui's `SharedState.#state`, assigned
        // `this.#factory(...args)` of a type parameter's function and
        // returned by `get(...): ReturnType<T>`): that result, with the
        // nullish values assigned.
        if (open && assigned) {
          const returned = new Set<string>();
          for (const x of stmt.members) {
            if (!(ts.isMethodDeclaration(x) || ts.isGetAccessorDeclaration(x)) || !x.body) continue;
            const visitReturn = (n: ts.Node) => {
              if (n !== x && ts.isFunctionLike(n)) return;
              if (
                ts.isReturnStatement(n) &&
                n.expression &&
                thisField(skipParensOf(n.expression), fieldName)
              )
                returned.add(x.type ? x.type.getText() : '');
              ts.forEachChild(n, visitReturn);
            };
            visitReturn(x.body);
          }
          const [only] = returned;
          if (returned.size === 1 && only) {
            const nullish = parts.filter(p => p === 'undefined' || p === 'null');
            parts.length = 0;
            parts.push(only, ...nullish);
            open = false;
          }
        }
        if (!assigned || open) continue;
        // A field without an initialiser is undefined until a statement of
        // the constructor's top level (or a later method) assigns it.
        if (!init && !topLevel) addType('undefined');
        const text = parts.join(' | ');
        // What TypeScript infers already (the initialiser's type) stays.
        if (!next.has(key) && own && text === print(own, member)) continue;
        if (next.get(key) !== text) next.set(key, text);
      }
    }
    // `const m = new SvelteMap()` (or Map, SvelteSet, Set) without type
    // arguments (bits-ui's scroll lock): the types of the keys and values
    // its `set` (`add`) calls give, where they agree.
    const kinds = ['SvelteMap', 'Map', 'WeakMap', 'SvelteSet', 'Set', 'WeakSet'];
    const untypedNew = (e: ts.Expression | undefined): ts.NewExpression | undefined => {
      while (e && ts.isParenthesizedExpression(e)) e = e.expression;
      return e &&
        ts.isNewExpression(e) &&
        !e.typeArguments &&
        !e.arguments?.length &&
        ts.isIdentifier(e.expression) &&
        kinds.includes(e.expression.text)
        ? e
        : undefined;
    };
    /** `globalThis.NAME` (bits-ui's `globalThis.bitsEscapeLayers ??= new Map()`). */
    const globalName = (e: ts.Expression): string | undefined =>
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === 'globalThis'
        ? e.name.text
        : undefined;
    const collections = (n: ts.Node) => {
      const declared =
        (ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) &&
        (ts.isIdentifier(n.name) || ts.isPrivateIdentifier(n.name))
          ? untypedNew(n.initializer)
          : undefined;
      const global =
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
        globalName(n.left) !== undefined
          ? untypedNew(n.right)
          : undefined;
      const created = declared ?? global;
      if (created) {
        const name = global ? globalName((n as ts.BinaryExpression).left) : undefined;
        const nameNode = global
          ? undefined
          : (n as ts.VariableDeclaration | ts.PropertyDeclaration).name;
        const sym = nameNode && checker.getSymbolAtLocation(nameNode);
        const set = (created.expression as ts.Identifier).text.endsWith('Set');
        const own = checker.getTypeAtLocation(nameNode ?? created);
        let count = 0;
        const same = (x: ts.Node) => {
          if (ts.isNewExpression(x) && !x.typeArguments && checker.getTypeAtLocation(x) === own)
            count++;
          ts.forEachChild(x, same);
        };
        same(sf);
        const alone = count === 1;
        const found: string[][] = [];
        let open = false;
        const visit = (x: ts.Node) => {
          if (
            ts.isCallExpression(x) &&
            ts.isPropertyAccessExpression(x.expression) &&
            x.expression.name.text === (set ? 'add' : 'set') &&
            ((ts.isIdentifier(x.expression.expression) &&
              sym !== undefined &&
              checker.getSymbolAtLocation(x.expression.expression) === sym) ||
              // (A global: `globalThis.NAME.set(…)`.)
              (name !== undefined && globalName(x.expression.expression) === name) ||
              // (A class field: `this.#f.set(…)` in its class.)
              (ts.isPropertyDeclaration(n) &&
                ts.isPropertyAccessExpression(x.expression.expression) &&
                x.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
                x.expression.expression.name.getText() === n.name.getText()) ||
              // (Through a getter returning it: the one untyped collection
              // of its type in the module.)
              (alone && checker.getTypeAtLocation(x.expression.expression) === own))
          ) {
            const args = x.arguments.slice(0, set ? 1 : 2);
            const printed = args.map(a => {
              // (`this`: its class, by name.)
              if (a.kind === ts.SyntaxKind.ThisKeyword) {
                let c: ts.Node | undefined = a.parent;
                while (c && !ts.isClassDeclaration(c)) c = c.parent;
                const cls = c as ts.ClassDeclaration | undefined;
                if (cls?.name && !cls.typeParameters) return cls.name.text;
              }
              const t = checker.getTypeAtLocation(a);
              return print(
                t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)
                  ? t
                  : checker.getBaseTypeOfLiteralType(t),
                a,
              );
            });
            // (Untyped arguments say nothing; the lowered program checks them.)
            const untyped = args.some(
              a => checker.getTypeAtLocation(a).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown),
            );
            if (args.length !== (set ? 1 : 2)) open = true;
            else if (untyped) {
              // nothing
            } else if (printed.includes('{}')) {
              // (Nor does `{}`, the type of a value not typed yet.)
            } else if (printed.some(p => p === undefined)) open = true;
            else found.push(printed as string[]);
          }
          ts.forEachChild(x, visit);
        };
        visit(sf);
        // (At the position in the module's own text.)
        const end = created.expression.end;
        const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
        if (!seg) return;
        const key = `new:${seg.orig + (end - seg.synth)}`;
        if (!open && found.length && found.every(f => f.join() === found[0].join())) {
          const text = found[0].join(', ');
          if (next.get(key) !== text) next.set(key, text);
        }
      }
      ts.forEachChild(n, collections);
    };
    collections(sf);
    // A module's own runed context without a type argument (bits-ui's
    // Command: `const CommandGroupContainerContext = new Context("Command.Group")`):
    // the type of the values the module sets on it, where they agree. (Not
    // exported: no other module sets it.)
    for (const stmt of sf.statements) {
      if (
        !ts.isVariableStatement(stmt) ||
        !(stmt.declarationList.flags & ts.NodeFlags.Const) ||
        ts.getModifiers(stmt)?.some(x => x.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue;
      for (const d of stmt.declarationList.declarations) {
        const created = d.initializer && skipParensOf(d.initializer);
        if (
          !ts.isIdentifier(d.name) ||
          !created ||
          !ts.isNewExpression(created) ||
          created.typeArguments ||
          !ts.isIdentifier(created.expression) ||
          created.arguments?.length !== 1
        )
          continue;
        const ctor = checker.getSymbolAtLocation(created.expression);
        const imported = ctor?.declarations?.[0];
        if (
          !imported ||
          !ts.isImportSpecifier(imported) ||
          (imported.propertyName ?? imported.name).text !== 'Context' ||
          (imported.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text !== 'runed'
        )
          continue;
        const sym = checker.getSymbolAtLocation(d.name);
        const texts = new Set<string>();
        let open = false;
        const visit = (x: ts.Node) => {
          if (
            ts.isIdentifier(x) &&
            x !== d.name &&
            checker.getSymbolAtLocation(x) === sym &&
            ts.isPropertyAccessExpression(x.parent) &&
            x.parent.name.text === 'set' &&
            ts.isCallExpression(x.parent.parent) &&
            x.parent.parent.expression === x.parent
          ) {
            const [arg] = x.parent.parent.arguments;
            const t = arg && checker.getTypeAtLocation(arg);
            const text =
              t && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
                ? print(t, arg)
                : undefined;
            if (text === undefined || text === '{}') open = true;
            else texts.add(text);
          }
          ts.forEachChild(x, visit);
        };
        visit(sf);
        const end = created.expression.end;
        const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
        if (open || texts.size !== 1 || !seg) continue;
        const key = `new:${seg.orig + (end - seg.synth)}`;
        const text = [...texts][0];
        if (next.get(key) !== text) next.set(key, text);
      }
    }
    // runed's `watch(() => [a, b, c], ([x, y, z]) => …)` (bits-ui's text
    // selection layer): TypeScript types the getter's array literal as an
    // array of the union of its elements' types; the effect destructures it
    // by position, so the getter returns the tuple of their types.
    const getters = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'watch' &&
        /[\\/]runed[\\/]/.test(declaredIn(checker, n.expression)) &&
        n.arguments.length >= 2
      ) {
        const getter = skipParensOf(n.arguments[0]);
        const effect = skipParensOf(n.arguments[1]);
        const body =
          ts.isArrowFunction(getter) && !getter.type && !ts.isBlock(getter.body)
            ? skipParensOf(getter.body)
            : undefined;
        if (
          body &&
          ts.isArrayLiteralExpression(body) &&
          !body.elements.some(ts.isSpreadElement) &&
          (ts.isArrowFunction(effect) || ts.isFunctionExpression(effect)) &&
          effect.parameters[0] &&
          ts.isArrayBindingPattern(effect.parameters[0].name)
        ) {
          const items = body.elements.map(x => {
            const t = checker.getTypeAtLocation(x);
            return print(
              t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)
                ? t
                : checker.getBaseTypeOfLiteralType(t),
              x,
            );
          });
          const close = sf.text.indexOf(')', (getter as ts.ArrowFunction).parameters.end) + 1;
          const seg = m.segments.find(g => close >= g.synth && close <= g.synth + g.length);
          if (items.every(i => i !== undefined) && close > 0 && seg) {
            const key = `ret:${seg.orig + (close - seg.synth)}`;
            const text = `[${items.join(', ')}]`;
            if (next.get(key) !== text) next.set(key, text);
          }
        }
      }
      ts.forEachChild(n, getters);
    };
    getters(sf);
    // A local arrow function used only as a listener of svelte/events' `on`
    // (bits-ui's SafePolygon: `const handleTriggerLeave = (e) => …;
    // on(triggerNode, "pointerleave", handleTriggerLeave)`): its parameter
    // is that event.
    const localListeners = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isArrowFunction(skipParensOf(n.initializer)) &&
        n.parent.flags & ts.NodeFlags.Const
      ) {
        const fn = skipParensOf(n.initializer) as ts.ArrowFunction;
        const p = fn.parameters[0];
        const sym = checker.getSymbolAtLocation(n.name);
        if (fn.parameters.length === 1 && !p.type && ts.isIdentifier(p.name) && sym) {
          let scope: ts.Node = n.parent;
          while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope))
            scope = scope.parent;
          const events = new Set<string>();
          let other = false;
          const uses = (x: ts.Node) => {
            if (ts.isIdentifier(x) && x !== n.name && checker.getSymbolAtLocation(x) === sym) {
              const event = listenerEvent(x);
              if (event) events.add(event);
              else other = true;
            }
            ts.forEachChild(x, uses);
          };
          uses(scope);
          const end = p.name.end;
          const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
          if (!other && events.size === 1 && seg) {
            const key = `param:${seg.orig + (end - seg.synth)}`;
            const text = [...events][0];
            if (next.get(key) !== text) next.set(key, text);
          }
        }
      }
      ts.forEachChild(n, localListeners);
    };
    localListeners(sf);
    // A local arrow function returned only as a member of the object literal
    // a function returns, and called only through that member (bits-ui's
    // announcer: `const getLog = (kind) => …; return { getLog }`, then
    // `announcer.getLog(kind)`): each untyped parameter takes the one type
    // the calls pass.
    const memberCalls = (n: ts.Node) => {
      ts.forEachChild(n, memberCalls);
      if (
        !ts.isVariableDeclaration(n) ||
        !ts.isIdentifier(n.name) ||
        !n.initializer ||
        !ts.isArrowFunction(skipParensOf(n.initializer)) ||
        !(n.parent.flags & ts.NodeFlags.Const)
      )
        return;
      const fn = skipParensOf(n.initializer) as ts.ArrowFunction;
      const sym = checker.getSymbolAtLocation(n.name);
      if (!sym || !fn.parameters.some(p => !p.type && ts.isIdentifier(p.name))) return;
      let escapes = false;
      const members: ts.ShorthandPropertyAssignment[] = [];
      const uses = (x: ts.Node) => {
        // (A shorthand member names the property; its value is the constant.)
        if (
          ts.isShorthandPropertyAssignment(x) &&
          checker.getShorthandAssignmentValueSymbol(x) === sym
        ) {
          if (ts.isObjectLiteralExpression(x.parent) && ts.isReturnStatement(x.parent.parent))
            members.push(x);
          else escapes = true;
          return;
        }
        if (ts.isIdentifier(x) && x !== n.name && checker.getSymbolAtLocation(x) === sym) {
          const p = x.parent;
          if (!(ts.isCallExpression(p) && p.expression === x)) escapes = true;
        }
        ts.forEachChild(x, uses);
      };
      uses(sf);
      if (escapes || members.length !== 1) return;
      const calls: ts.CallExpression[] = [];
      const through = (x: ts.Node) => {
        if (ts.isPropertyAccessExpression(x) && x.name.text === members[0].name.text) {
          const s = checker.getSymbolAtLocation(x.name);
          if (s?.declarations?.includes(members[0])) {
            if (ts.isCallExpression(x.parent) && x.parent.expression === x) calls.push(x.parent);
            else escapes = true;
          }
        }
        ts.forEachChild(x, through);
      };
      through(sf);
      if (escapes || !calls.length) return;
      fn.parameters.forEach((p, i) => {
        if (p.type || p.dotDotDotToken || !ts.isIdentifier(p.name)) return;
        const texts = new Set<string>();
        let open = false;
        for (const c of calls) {
          const a = c.arguments[i];
          const t = a && !ts.isSpreadElement(a) ? checker.getTypeAtLocation(a) : undefined;
          const text = t && !(t.flags & ts.TypeFlags.Any) ? print(t, a!) : undefined;
          if (text === undefined) open = true;
          else texts.add(text);
        }
        const end = p.name.end;
        const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
        if (open || texts.size !== 1 || !seg) return;
        const key = `param:${seg.orig + (end - seg.synth)}`;
        const text = [...texts][0];
        if (next.get(key) !== text) next.set(key, text);
      });
    };
    memberCalls(sf);
    // A function returning `x || null` (or `?? null`, `|| undefined`) of an
    // `x` TypeScript types as never nullish (bits-ui's `tabbables[0] ||
    // null` of an array that may be empty): TypeScript drops the null; the
    // function returns `T | null`.
    const nullishReturns = (n: ts.Node) => {
      if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.body && !n.type) {
        let found: 'null' | 'undefined' | undefined;
        const visit = (x: ts.Node) => {
          if (x !== n && ts.isFunctionLike(x)) return;
          if (ts.isReturnStatement(x) && x.expression) {
            const r = skipParensOf(x.expression);
            if (
              ts.isBinaryExpression(r) &&
              (r.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                r.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
            ) {
              const right = skipParensOf(r.right);
              const nothing =
                right.kind === ts.SyntaxKind.NullKeyword ||
                (ts.isIdentifier(right) && right.text === 'undefined');
              const t = checker.getTypeAtLocation(r);
              if (nothing && !(t.flags & ts.TypeFlags.Any) && checker.getNonNullableType(t) === t)
                found = right.kind === ts.SyntaxKind.NullKeyword ? 'null' : 'undefined';
            }
          }
          ts.forEachChild(x, visit);
        };
        visit(n.body);
        const sig = found ? checker.getSignatureFromDeclaration(n) : undefined;
        const ret = sig && print(sig.getReturnType(), n);
        const close = sf.text.indexOf(')', n.parameters.end) + 1;
        const seg = m.segments.find(g => close >= g.synth && close <= g.synth + g.length);
        if (ret !== undefined && close > 0 && seg) {
          const key = `ret:${seg.orig + (close - seg.synth)}`;
          const text = `${ret} | ${found}`;
          if (!next.has(key)) next.set(key, text);
        }
      }
      ts.forEachChild(n, nullishReturns);
    };
    nullishReturns(sf);
    // Untyped parameters of class constructors and methods (FocusScope's
    // `constructor(opts)` and `static use(opts)`), and of the module's
    // function declarations at any depth (bits-ui's scroll lock returns its
    // `resetBodyStyle(documentObj)` in an object its callers call through):
    // the one type the program's calls pass, where they agree.
    const untypedParams = (member: ts.FunctionLikeDeclaration, outside = false) =>
      member.parameters.forEach((p, i) => {
        // (Also an object pattern, `#findNextNonDisabledItem({ start, grid })`
        // of bits-ui's Command: the pattern is annotated.)
        if (p.dotDotDotToken || !(ts.isIdentifier(p.name) || ts.isObjectBindingPattern(p.name)))
          return;
        const pEnd = p.name.end;
        const pSeg = m.segments.find(g => pEnd >= g.synth && pEnd <= g.synth + g.length);
        // (A type an earlier pass inferred is inferred again: provisional
        // types are refined, below.)
        const ours = !!pSeg && m.inferred.has(`param:${pSeg.orig + (pEnd - pSeg.synth)}`);
        if (!ours) {
          if (p.type) return;
          const pt = checker.getTypeAtLocation(p);
          // (A pattern: the object of its names, typed `any` each.)
          const untyped = ts.isObjectBindingPattern(p.name)
            ? checker
                .getPropertiesOfType(pt)
                .some(
                  q => checker.getTypeOfSymbol(q).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown),
                )
            : !!(pt.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
          if (!untyped) return;
        }
        const texts = new Set<string>();
        const typeOf = new Map<string, ts.Type>();
        let open = false;
        // (`outside`: only the calls outside its body, of a recursive
        // function; the lowerer checks the arguments of the others.)
        const sites = calls(member).filter(
          c => !outside || c.pos < member.pos || c.end > member.end,
        );
        if (!sites.length) return;
        for (const c of sites) {
          const a = c.arguments?.[i];
          if (!a || ts.isSpreadElement(a)) {
            open = true;
            continue;
          }
          const t = checker.getTypeAtLocation(a);
          const text =
            t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
              ? undefined
              : (print(
                  t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)
                    ? t
                    : checker.getBaseTypeOfLiteralType(t),
                  a,
                ) ?? provisional(a));
          // (The document or the window: a host parameter, Lowerer.hostParam;
          // nor a type only null or undefined has, or the empty object's,
          // which say nothing.)
          if (
            text === undefined ||
            ['HostDocument', 'HostWindow', 'null', 'undefined', '{}'].includes(text)
          )
            open = true;
          else {
            texts.add(text);
            if (!typeOf.has(text)) typeOf.set(text, t);
          }
        }
        if (open) return;
        const text = texts.size === 1 ? [...texts][0] : widestObject(typeOf);
        if (text === undefined) return;
        const end = p.name.end;
        const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
        if (!seg) return;
        const key = `param:${seg.orig + (end - seg.synth)}`;
        if (next.get(key) !== text) next.set(key, text);
      });
    /**
     * Of the object types the calls pass (by printed text), the one every
     * other is assignable to and holds no property it lacks (embla's
     * `activate(withOptions, …)`, called with `EmblaOptionsType | undefined`
     * and with `mergeOptions({ startIndex }, withOptions)`, whose
     * `{ startIndex: number } & …` has the same keys): the calls convert
     * their records to it (`Lowerer.recordView`, which keeps every field).
     * None where the types are not all plain objects (nullable ones
     * included; not arrays, functions or class instances), or where a value
     * would lose a key JavaScript keeps.
     */
    const widestObject = (types: Map<string, ts.Type>): string | undefined => {
      const objects = [...types].map(([text, t]) => ({
        text,
        t,
        o: checker.getNonNullableType(t),
      }));
      // (Plain objects: not arrays, tuples, functions or class instances.)
      const plain = (o: ts.Type) =>
        !!(o.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) &&
        !checker.isArrayType(o) &&
        !checker.isTupleType(o) &&
        !o.getCallSignatures().length &&
        !o.getConstructSignatures().length &&
        !(o.symbol && o.symbol.flags & ts.SymbolFlags.Class);
      if (objects.some(({ o }) => !plain(o))) return undefined;
      const keys = (o: ts.Type) => new Set(checker.getPropertiesOfType(o).map(q => q.name));
      const wide = objects.filter(w =>
        objects.every(({ t, o }) => {
          if (!checker.isTypeAssignableTo(t, w.t)) return false;
          const held = keys(w.o);
          return [...keys(o)].every(k => held.has(k));
        }),
      );
      return wide.length === 1 ? wide[0].text : undefined;
    };
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt)) continue;
      for (const member of stmt.members)
        if ((ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)) && member.body)
          untypedParams(member);
      // A handler field (`#onpointerenter = (e) => …`, private, so the
      // declaration file has no type for it) used as an `on<event>` entry of
      // an object (the attribute bag of `props`) or passed as a listener:
      // its event parameter is the event's interface, the same for every
      // such use.
      for (const member of stmt.members) {
        if (!ts.isPropertyDeclaration(member) || !member.initializer) continue;
        const fn = member.initializer;
        if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) continue;
        const p = fn.parameters[0];
        if (!p || p.type || !ts.isIdentifier(p.name)) continue;
        if (!(checker.getTypeAtLocation(p).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
          continue;
        const name = member.name.getText();
        const interfaces = new Set<string>();
        let other = false;
        const uses = (n: ts.Node) => {
          if (
            ts.isPropertyAccessExpression(n) &&
            n.expression.kind === ts.SyntaxKind.ThisKeyword &&
            n.name.getText() === name
          ) {
            const a = n.parent;
            const event =
              ts.isPropertyAssignment(a) && a.initializer === n
                ? /^on([a-z]+)$/.exec(a.name.getText().replace(/^["']|["']$/g, ''))?.[1]
                : undefined;
            const iface = event && EVENT_INTERFACE.get(event);
            // (Or passed as an argument where a function is expected:
            // `document.addEventListener("pointermove", this.#onDocMove)`,
            // the parameter type declared there.)
            const ctx =
              !iface &&
              (ts.isCallExpression(a) || ts.isNewExpression(a)) &&
              a.arguments?.includes(n)
                ? checker.getContextualType(n)
                : undefined;
            const sigs = ctx?.getCallSignatures() ?? [];
            const param = sigs.length === 1 ? sigs[0].parameters[0] : undefined;
            const declared = param && print(checker.getTypeOfSymbolAtLocation(param, n), n);
            if (iface) interfaces.add(iface);
            else if (declared) interfaces.add(declared);
            else other = true;
          }
          ts.forEachChild(n, uses);
        };
        uses(stmt);
        if (other || interfaces.size !== 1) continue;
        const end = p.name.end;
        const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
        if (!seg) continue;
        const key = `param:${seg.orig + (end - seg.synth)}`;
        const text = [...interfaces][0];
        if (next.get(key) !== text) next.set(key, text);
      }
    }
    // A function literal in an options object passed to a constructor or
    // function of the program (bits-ui's `new MenuSubmenuIntent({
    // onIntentExit: (pointerPoint) => …, setIsPointerInTransit: (value) =>
    // … })`): an untyped parameter takes the type of the arguments the
    // callee passes when it calls that option, through the parameter or a
    // field it is stored in (`this.#opts.setIsPointerInTransit(true)`), the
    // same at every such call.
    const optionParams = (lit: ts.ObjectLiteralExpression) => {
      let at: ts.Node = lit;
      while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
      const call = at.parent;
      if (!(ts.isCallExpression(call) || ts.isNewExpression(call))) return;
      const index = call.arguments?.indexOf(at as ts.Expression) ?? -1;
      const callee = checker.getResolvedSignature(call)?.declaration;
      if (
        index < 0 ||
        !callee ||
        ts.isJSDocSignature(callee) ||
        !('body' in callee) ||
        !callee.body
      )
        return;
      const param = callee.parameters[index];
      if (!param || param.dotDotDotToken || !ts.isIdentifier(param.name)) return;
      const paramSym = checker.getSymbolAtLocation(param.name);
      // Where the options are read: the function, or the whole class of a
      // constructor (with the fields holding them).
      const scope: ts.Node = ts.isConstructorDeclaration(callee) ? callee.parent : callee;
      const holders = new Set<ts.Symbol>(paramSym ? [paramSym] : []);
      const collect = (n: ts.Node) => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left) &&
          n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(n.right) &&
          paramSym &&
          checker.getSymbolAtLocation(n.right) === paramSym
        ) {
          const f = checker.getSymbolAtLocation(n.left.name);
          if (f) holders.add(f);
        }
        ts.forEachChild(n, collect);
      };
      collect(scope);
      const holds = (e: ts.Expression) => {
        const target = ts.isPropertyAccessExpression(e)
          ? e.expression.kind === ts.SyntaxKind.ThisKeyword
            ? e.name
            : undefined
          : e;
        const sym = target && checker.getSymbolAtLocation(target);
        return !!sym && holders.has(sym);
      };
      for (const prop of lit.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const fn = skipParensOf(prop.initializer);
        if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) continue;
        const name = prop.name.text;
        fn.parameters.forEach((fp, i) => {
          if (fp.type || fp.dotDotDotToken || !ts.isIdentifier(fp.name)) return;
          if (!(checker.getTypeAtLocation(fp).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
            return;
          const texts = new Set<string>();
          let open = false;
          const uses = (n: ts.Node) => {
            if (ts.isPropertyAccessExpression(n) && n.name.text === name && holds(n.expression)) {
              const c = n.parent;
              if (!ts.isCallExpression(c) || c.expression !== n) open = true;
              else {
                const arg = c.arguments[i];
                const t =
                  arg && !ts.isSpreadElement(arg) ? checker.getTypeAtLocation(arg) : undefined;
                const text = t && print(checker.getBaseTypeOfLiteralType(t), arg);
                // (A type only null or undefined has says nothing yet: a
                // field a later pass types.)
                if (text === undefined || text === 'null' || text === 'undefined') open = true;
                else texts.add(text);
              }
            }
            ts.forEachChild(n, uses);
          };
          uses(scope);
          if (open || texts.size !== 1) return;
          const end = fp.name.end;
          const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
          if (!seg) return;
          const key = `param:${seg.orig + (end - seg.synth)}`;
          const text = [...texts][0];
          if (next.get(key) !== text) next.set(key, text);
        });
      }
    };
    const literals = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) optionParams(n);
      ts.forEachChild(n, literals);
    };
    literals(sf);
    // A constant holding a function literal (bits-ui's `const onTriggerMove
    // = (e) => …`, then `triggerNode.addEventListener("pointermove",
    // onTriggerMove)`): an untyped parameter takes the type its uses give
    // it, the same for every use: passed as an argument, the parameter type
    // the callee declares there; called, the argument's type.
    const constParams = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isVariableDeclarationList(n.parent) &&
        n.parent.flags & ts.NodeFlags.Const
      ) {
        const fn = skipParensOf(n.initializer);
        const sym = checker.getSymbolAtLocation(n.name);
        if (sym && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))
          fn.parameters.forEach((fp, i) => {
            if (fp.type || fp.dotDotDotToken || !ts.isIdentifier(fp.name)) return;
            if (!(checker.getTypeAtLocation(fp).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
              return;
            const texts = new Set<string>();
            let open = false;
            const add = (t: ts.Type | undefined, at: ts.Node) => {
              const text = t && print(checker.getBaseTypeOfLiteralType(t), at);
              if (text === undefined || text === 'null' || text === 'undefined') open = true;
              else texts.add(text);
            };
            const uses = (x: ts.Node) => {
              if (ts.isIdentifier(x) && x !== n.name && checker.getSymbolAtLocation(x) === sym) {
                const c = x.parent;
                if (ts.isCallExpression(c) && c.expression === x) {
                  const arg = c.arguments[i];
                  const t = arg && checker.getTypeAtLocation(arg);
                  // A call of the function in its own body with an argument
                  // that is not typed yet (bits-ui's `autoScroll(tick + 1)`):
                  // typed by the other calls first, then checked by the
                  // lowering of the call.
                  const own =
                    !!t &&
                    !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
                    c.pos >= fn.pos &&
                    c.end <= fn.end;
                  if (!own) {
                    if (arg && !ts.isSpreadElement(arg)) add(t, arg);
                    else open = true;
                  }
                } else if (
                  (ts.isCallExpression(c) || ts.isNewExpression(c)) &&
                  c.arguments?.includes(x)
                ) {
                  const ctx = checker.getContextualType(x);
                  const sigs = ctx?.getCallSignatures() ?? [];
                  const param = sigs.length === 1 ? sigs[0].parameters[i] : undefined;
                  if (!param) open = true;
                  else add(checker.getTypeOfSymbolAtLocation(param, x), x);
                } else open = true;
              }
              ts.forEachChild(x, uses);
            };
            uses(n.parent.parent.parent ?? sf);
            if (open || texts.size !== 1) return;
            const end = fp.name.end;
            const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
            if (!seg) return;
            const key = `param:${seg.orig + (end - seg.synth)}`;
            const text = [...texts][0];
            if (next.get(key) !== text) next.set(key, text);
          });
      }
      ts.forEachChild(n, constParams);
    };
    constParams(sf);
    // (Only functions also used as values: calls of one that is only
    // called are specialised per call site, Lowerer.specialise.)
    const usedAsValue = (fn: ts.FunctionDeclaration): boolean => {
      const sym = fn.name && checker.getSymbolAtLocation(fn.name);
      let found = false;
      const visit = (x: ts.Node) => {
        if (found) return;
        if (
          ts.isIdentifier(x) &&
          x !== fn.name &&
          checker.getSymbolAtLocation(x) === sym &&
          !(ts.isCallExpression(x.parent) && x.parent.expression === x)
        )
          found = true;
        ts.forEachChild(x, visit);
      };
      if (sym) visit(sf);
      // (A shorthand property names the variable's symbol through its value symbol.)
      const shorthand = (x: ts.Node): boolean =>
        (ts.isShorthandPropertyAssignment(x) &&
          checker.getShorthandAssignmentValueSymbol(x) === sym) ||
        !!ts.forEachChild(x, shorthand);
      return found || (!!sym && shorthand(sf));
    };
    // (And functions passing an untyped parameter to a generic function:
    // the generic one's instantiations are read from TypeScript's types of
    // its calls, `any` there. embla's `activate(withOptions, …)` calls
    // `mergeOptions(optionsBase, withOptions)`; its calls pass different
    // types, the widest taken, `widestObject`.)
    const feedsGeneric = (fn: ts.FunctionDeclaration): boolean => {
      const params = new Set(
        fn.parameters
          .filter(p => !p.type && ts.isIdentifier(p.name))
          .map(p => checker.getSymbolAtLocation(p.name)),
      );
      let found = false;
      const visit = (x: ts.Node) => {
        if (found) return;
        if (ts.isCallExpression(x)) {
          const decl = checker.getResolvedSignature(x)?.declaration;
          if (
            decl &&
            !ts.isJSDocSignature(decl) &&
            decl.typeParameters?.length &&
            x.arguments.some(a => {
              const v = skipParensOf(a);
              return ts.isIdentifier(v) && params.has(checker.getSymbolAtLocation(v));
            })
          )
            found = true;
        }
        ts.forEachChild(x, visit);
      };
      if (params.size) visit(fn.body!);
      return found;
    };
    // (And recursive functions, which specialisation cannot type: bits-ui's
    // Command score `computeCommandScoreInner`, typed from its calls
    // outside itself, with a called function giving one of its arguments,
    // `formatInput(command)`, typed from its calls first.)
    const within = (c: ts.Node, fn: ts.Node) => c.pos >= fn.pos && c.end <= fn.end;
    const functions = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.body) {
        const own = calls(n);
        if (own.some(c => within(c, n))) {
          untypedParams(n, true);
          for (const c of own)
            if (!within(c, n))
              for (const a of c.arguments ?? []) {
                const inner = skipParensOf(a);
                const callee = ts.isCallExpression(inner)
                  ? checker.getResolvedSignature(inner)?.declaration
                  : undefined;
                if (
                  callee &&
                  ts.isFunctionDeclaration(callee) &&
                  callee.body &&
                  callee.getSourceFile() === sf
                )
                  untypedParams(callee);
              }
        } else if (usedAsValue(n) || feedsGeneric(n)) untypedParams(n);
      }
      ts.forEachChild(n, functions);
    };
    functions(sf);
    // A parameter used as a dictionary (bits-ui's Command score
    // `memoizedResults`: `memoizedResults[key] = highScore`, passed `{}`):
    // `Record<string, T>` of the one type its entries are assigned, where it
    // is otherwise only read by key or passed on in the same position of its
    // own function's calls.
    const dictionaryParams = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.body && n.name)
        n.parameters.forEach((p, i) => {
          if (p.type || p.dotDotDotToken || !ts.isIdentifier(p.name)) return;
          if (!(checker.getTypeAtLocation(p).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
            return;
          const sym = checker.getSymbolAtLocation(p.name);
          const fnSym = checker.getSymbolAtLocation(n.name!);
          const values = new Set<string>();
          let ok = true;
          const visit = (x: ts.Node) => {
            if (!ok) return;
            if (ts.isIdentifier(x) && x !== p.name && checker.getSymbolAtLocation(x) === sym) {
              const parent = x.parent;
              const keyed =
                ts.isElementAccessExpression(parent) &&
                parent.expression === x &&
                !!(
                  checker.getTypeAtLocation(parent.argumentExpression).flags &
                  ts.TypeFlags.StringLike
                );
              const passedOn =
                ts.isCallExpression(parent) &&
                parent.arguments[i] === x &&
                ts.isIdentifier(parent.expression) &&
                checker.getSymbolAtLocation(parent.expression) === fnSym;
              if (!keyed && !passedOn) ok = false;
              if (keyed) {
                const write = parent.parent;
                if (
                  ts.isBinaryExpression(write) &&
                  write.left === parent &&
                  write.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ) {
                  const t = checker.getTypeAtLocation(write.right);
                  const text =
                    t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
                      ? undefined
                      : print(checker.getBaseTypeOfLiteralType(t), write.right);
                  if (text === undefined) ok = false;
                  else values.add(text);
                }
              }
            }
            ts.forEachChild(x, visit);
          };
          visit(n.body!);
          if (!ok || values.size !== 1) return;
          const end = p.name.end;
          const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
          if (!seg) return;
          const key = `param:${seg.orig + (end - seg.synth)}`;
          const text = `Record<string, ${[...values][0]}>`;
          if (next.get(key) !== text) next.set(key, text);
        });
      ts.forEachChild(n, dictionaryParams);
    };
    dictionaryParams(sf);
    // A constant that starts as an empty array (bits-ui's IsUsingKeyboard:
    // `const callbacksToDispose = []`, then `push(on(…), …)`): an array of
    // the types of the items pushed onto it (`push` and `unshift` with
    // typed arguments; any other use passing the array on is fine, as its
    // items are what was pushed).
    const emptyArrays = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        !n.type &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isArrayLiteralExpression(skipParensOf(n.initializer)) &&
        !(skipParensOf(n.initializer) as ts.ArrayLiteralExpression).elements.length &&
        ts.isVariableDeclarationList(n.parent) &&
        n.parent.flags & ts.NodeFlags.Const
      ) {
        const sym = checker.getSymbolAtLocation(n.name);
        const items: string[] = [];
        let open = false;
        const scope = n.parent.parent.parent ?? sf;
        const uses = (x: ts.Node) => {
          if (
            ts.isCallExpression(x) &&
            ts.isPropertyAccessExpression(x.expression) &&
            ['push', 'unshift'].includes(x.expression.name.text) &&
            ts.isIdentifier(x.expression.expression) &&
            checker.getSymbolAtLocation(x.expression.expression) === sym
          )
            for (const a of x.arguments) {
              const t = ts.isSpreadElement(a) ? undefined : checker.getTypeAtLocation(a);
              // (An array literal pushed is a tuple of its items: bits-ui's
              // Command sorts `groups.push([value, max])` by `b[1]`.)
              const lit = skipParensOf(a);
              const parts =
                ts.isArrayLiteralExpression(lit) && !lit.elements.some(ts.isSpreadElement)
                  ? lit.elements.map(el => {
                      const et = checker.getTypeAtLocation(el);
                      return et.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
                        ? undefined
                        : print(checker.getBaseTypeOfLiteralType(et), el);
                    })
                  : undefined;
              const text = parts
                ? parts.every(i => i !== undefined)
                  ? `[${parts.join(', ')}]`
                  : undefined
                : t && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
                  ? print(checker.getBaseTypeOfLiteralType(t), a)
                  : undefined;
              if (text === undefined || text === '{}' || /\bany\b/.test(text)) open = true;
              else if (!items.includes(text)) items.push(text);
            }
          ts.forEachChild(x, uses);
        };
        if (sym) uses(scope);
        const end = n.name.end;
        const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
        if (!open && items.length && seg) {
          const key = `var:${seg.orig + (end - seg.synth)}`;
          const text = items.length === 1 ? `${items[0]}[]` : `(${items.join(' | ')})[]`;
          if (next.get(key) !== text) next.set(key, text);
        }
      }
      ts.forEachChild(n, emptyArrays);
    };
    emptyArrays(sf);
    // A constant of an object or array literal TypeScript types with `any` or
    // `never` in it (bits-ui's Command `defaultState` of `new Map()` and
    // `new Set()`, `const grid = [[]]`) that initialises class fields of one
    // declared type (`commandState = $state.raw(defaultState)`, declared
    // `CommandState`) or that a function or getter of a declared result type
    // returns (`return grid`): that type.
    const fieldConstants = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        !n.type &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isObjectLiteralExpression(skipParensOf(n.initializer)) ||
          ts.isArrayLiteralExpression(skipParensOf(n.initializer))) &&
        ts.isVariableDeclarationList(n.parent) &&
        n.parent.flags & ts.NodeFlags.Const &&
        /\b(any|never)\b/.test(
          checker.typeToString(
            checker.getTypeAtLocation(n.name),
            undefined,
            ts.TypeFormatFlags.NoTruncation,
          ),
        )
      ) {
        const sym = checker.getSymbolAtLocation(n.name);
        // (By type: annotations naming one type differently agree.)
        const types = new Map<ts.Type, string>();
        const uses = (x: ts.Node) => {
          if (ts.isIdentifier(x) && x !== n.name && checker.getSymbolAtLocation(x) === sym) {
            // The field the value initialises, directly or through a rune.
            let at: ts.Node = x;
            while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
            const call = at.parent;
            const holder =
              ts.isCallExpression(call) &&
              call.arguments[0] === at &&
              /^\$state(\.raw)?$/.test(call.expression.getText())
                ? call.parent
                : at.parent;
            if (ts.isPropertyDeclaration(holder) && holder.type && holder.initializer) {
              const t = checker.getTypeFromTypeNode(holder.type);
              if (!types.has(t)) types.set(t, holder.type.getText());
            }
            // Returned by its function (not a nested one).
            if (ts.isReturnStatement(at.parent)) {
              let fn: ts.Node = at.parent;
              while (!ts.isFunctionLike(fn)) fn = fn.parent;
              const declared = (fn as ts.SignatureDeclaration).type;
              if (declared && fn.pos <= n.pos && n.end <= fn.end) {
                const t = checker.getTypeFromTypeNode(declared);
                if (!types.has(t)) types.set(t, declared.getText());
              }
            }
          }
          ts.forEachChild(x, uses);
        };
        if (sym) uses(sf);
        const end = n.name.end;
        const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
        if (types.size === 1 && seg) {
          const key = `var:${seg.orig + (end - seg.synth)}`;
          const text = [...types.values()][0];
          if (next.get(key) !== text) next.set(key, text);
        }
      }
      ts.forEachChild(n, fieldConstants);
    };
    fieldConstants(sf);
    // A `let` declared without a value, with `null` or `undefined`, or with
    // an empty array, and assigned later (embla's `let engine`, `let
    // lastTimeStamp = null`, `let activePlugins = []`, then `activePlugins =
    // plugins.filter(…)`): the one type of the values assigned (literals
    // widened), nullable as its initial value is. In a bundle typed by its
    // declaration files only: other modules' such variables keep the
    // flow-sensitive rules the lowerer applies to them (bits-ui's `let scope
    // = null; … if (!scope) scope = new FocusScope(opts)`, `Lowerer.createdIn`).
    const assignedLets = (n: ts.Node) => {
      ts.forEachChild(n, assignedLets);
      if (
        !m.bundleDts ||
        !ts.isVariableDeclaration(n) ||
        n.type ||
        !ts.isIdentifier(n.name) ||
        !ts.isVariableDeclarationList(n.parent) ||
        !(n.parent.flags & ts.NodeFlags.Let) ||
        !ts.isVariableStatement(n.parent.parent)
      )
        return;
      const init = n.initializer && skipParensOf(n.initializer);
      const initial = !init
        ? 'undefined'
        : init.kind === ts.SyntaxKind.NullKeyword
          ? 'null'
          : ts.isIdentifier(init) && init.text === 'undefined'
            ? 'undefined'
            : ts.isArrayLiteralExpression(init) && !init.elements.length
              ? 'array'
              : undefined;
      if (initial === undefined) return;
      const end = n.name.end;
      const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
      if (!seg) return;
      const key = `var:${seg.orig + (end - seg.synth)}`;
      // (Ours from an earlier pass: inferred again from the values.)
      if (!m.inferred.has(key)) {
        const declared = checker.typeToString(
          checker.getTypeAtLocation(n.name),
          undefined,
          ts.TypeFormatFlags.NoTruncation,
        );
        if (!/\b(any|never|null|undefined)\b/.test(declared)) return;
      }
      const sym = checker.getSymbolAtLocation(n.name);
      const values = new Set<string>();
      let nullable = false;
      let open = false;
      // (Code TypeScript proves unreachable, a member of a value narrowed to
      // `never`: embla's legacy `addListener` branch after `'addEventListener'
      // in node`, which lowering folds away.)
      const unreachable = (v: ts.Node): boolean => {
        let found = false;
        const visit = (y: ts.Node) => {
          if (found) return;
          if (
            ts.isPropertyAccessExpression(y) &&
            checker.getTypeAtLocation(y.expression).flags & ts.TypeFlags.Never
          )
            found = true;
          else ts.forEachChild(y, visit);
        };
        visit(v);
        return found;
      };
      // (An array: the items pushed onto it count as arrays of their type.)
      const pushed = (x: ts.Node) => {
        if (
          initial !== 'array' ||
          !ts.isCallExpression(x) ||
          !ts.isPropertyAccessExpression(x.expression) ||
          !['push', 'unshift'].includes(x.expression.name.text) ||
          !ts.isIdentifier(x.expression.expression) ||
          checker.getSymbolAtLocation(x.expression.expression) !== sym
        )
          return;
        for (const a of x.arguments) {
          const t = ts.isSpreadElement(a) ? undefined : checker.getTypeAtLocation(a);
          const item =
            t && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
              ? print(checker.getBaseTypeOfLiteralType(t), a)
              : undefined;
          if (item === undefined || /\bnever\b/.test(item)) open = true;
          // (As TypeScript prints an array of it: a union or intersection
          // parenthesised, a function type already is.)
          else values.add(/^[\w.$]+(<.*>)?$|^\(.*\)$/.test(item) ? `${item}[]` : `(${item})[]`);
        }
      };
      const writes = (x: ts.Node) => {
        pushed(x);
        if (
          ts.isBinaryExpression(x) &&
          ts.isIdentifier(x.left) &&
          checker.getSymbolAtLocation(x.left) === sym &&
          x.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          x.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
          const v = skipParensOf(x.right);
          // (A value computed from the variable itself, `activePlugins =
          // activePlugins.filter(…)`: of its own type once annotated.)
          let own = false;
          const reads = (y: ts.Node) => {
            if (ts.isIdentifier(y) && checker.getSymbolAtLocation(y) === sym) own = true;
            else ts.forEachChild(y, reads);
          };
          reads(v);
          if (own && !m.inferred.has(key)) return;
          if (unreachable(v)) return;
          if (x.operatorToken.kind !== ts.SyntaxKind.EqualsToken) open = true;
          else if (v.kind === ts.SyntaxKind.NullKeyword) nullable = true;
          else if (ts.isIdentifier(v) && v.text === 'undefined') nullable = true;
          else {
            const t = checker.getTypeAtLocation(v);
            const text =
              t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
                ? undefined
                : print(checker.getBaseTypeOfLiteralType(t), v);
            if (text === undefined || /\bnever\b/.test(text)) open = true;
            else values.add(text);
          }
        }
        ts.forEachChild(x, writes);
      };
      if (sym) writes(sf);
      if (open || values.size !== 1) return;
      const [value] = values;
      if (initial === 'array' && !/\[\]$/.test(value)) return;
      const text =
        initial === 'array'
          ? value
          : `${value} | ${initial}${nullable && initial !== 'null' ? ' | null' : ''}`;
      if (next.get(key) !== text) next.set(key, text);
    };
    assignedLets(sf);
    if (JSON.stringify([...next]) !== JSON.stringify([...m.inferred])) {
      const code = readFileSync(m.file, 'utf8');
      const again = annotate(m.file, code, next);
      modules.set(m.file, again);
      changed.push(again);
    }
  }
  return changed;
}

/**
 * Function types a reached bundle's declaration files declare with a
 * parameter typed `any` (embla-carousel's EventStore: `type
 * EventHandlerType = (evt: any) => void`) where the functions of that type
 * are only ever called by the host as event listeners: every parameter the
 * bundle declares of the type (`add(node, type, handler, options)`) is only
 * passed on as the listener of `addEventListener`/`removeEventListener` of
 * the host declarations (or in code TypeScript proves unreachable, a call
 * on a `never` receiver: the legacy `addListener` branch after the folded
 * `'addEventListener' in node`), and nothing else in the program holds a
 * value of the type. The parameter then is the event the listener
 * receives: `Event` (M6 script DOM, slice 4).
 *
 * Returns, per module, `dts:<position>:=@<declaration file>` entries.
 */
function listenerAnyTypes(
  modules: Map<string, PackageModule>,
  program: ts.Program,
): Map<PackageModule, Map<string, string>> {
  const checker = program.getTypeChecker();
  const out = new Map<PackageModule, Map<string, string>>();
  const host = (d: ts.Declaration | undefined) =>
    !!d && path.resolve(d.getSourceFile().fileName) === DOM_DECLARATIONS;
  for (const m of modules.values()) {
    if (m.port || !m.bundleDts) continue;
    const vsf = program.getSourceFile(m.virtual);
    if (!vsf) continue;
    for (const dts of m.bundleDts) {
      const original = ts.createSourceFile(
        dts,
        readFileSync(dts, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const psf = program.getSourceFile(dts);
      if (!psf) continue;
      for (const stmt of original.statements) {
        if (!ts.isTypeAliasDeclaration(stmt) || !ts.isFunctionTypeNode(stmt.type)) continue;
        const anys = stmt.type.parameters.filter(
          p => p.type?.kind === ts.SyntaxKind.AnyKeyword && !p.dotDotDotToken,
        );
        if (anys.length !== 1 || stmt.type.parameters.length !== 1) continue;
        const alias = psf.statements.find(
          (s): s is ts.TypeAliasDeclaration =>
            ts.isTypeAliasDeclaration(s) && s.name.text === stmt.name.text,
        );
        const sym = alias && checker.getSymbolAtLocation(alias.name);
        if (!sym) continue;
        const ofAlias = (t: ts.Type) =>
          (t.isUnion() ? t.types : [t]).some(x => x.aliasSymbol === sym);
        // The bundle's parameters of the type, and every other holder.
        const params: ts.ParameterDeclaration[] = [];
        let other = false;
        const visit = (n: ts.Node) => {
          if (ts.isParameter(n) && ts.isIdentifier(n.name)) {
            if (ofAlias(checker.getTypeAtLocation(n.name))) params.push(n);
          } else if (
            ts.isIdentifier(n) &&
            !ts.isParameter(n.parent) &&
            ofAlias(checker.getTypeAtLocation(n))
          ) {
            const s = checker.getSymbolAtLocation(n);
            const d = s?.valueDeclaration;
            if (!d || !ts.isParameter(d)) other = true;
          }
          ts.forEachChild(n, visit);
        };
        for (const f of program.getSourceFiles()) if (!f.isDeclarationFile) visit(f);
        if (other || !params.length) continue;
        // Each used only as a host listener.
        const listenerOnly = (p: ts.ParameterDeclaration) => {
          const s = checker.getSymbolAtLocation(p.name);
          let ok = true;
          let fn: ts.Node = p.parent;
          const uses = (n: ts.Node) => {
            if (ts.isIdentifier(n) && n !== p.name && checker.getSymbolAtLocation(n) === s) {
              const call = n.parent;
              const callee =
                ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
                  ? call.expression
                  : undefined;
              const name = callee?.name.text;
              const at = callee ? (call as ts.CallExpression).arguments.indexOf(n) : -1;
              const unreachable =
                !!callee &&
                !!(checker.getTypeAtLocation(callee.expression).flags & ts.TypeFlags.Never);
              const decl =
                callee && checker.getResolvedSignature(call as ts.CallExpression)?.declaration;
              const listener =
                (name === 'addEventListener' || name === 'removeEventListener') &&
                at === 1 &&
                host(decl as ts.Declaration | undefined);
              if (!listener && !unreachable) ok = false;
            }
            ts.forEachChild(n, uses);
          };
          uses(fn);
          return ok;
        };
        if (!params.every(listenerOnly)) continue;
        const map = out.get(m) ?? new Map<string, string>();
        map.set(`dts:${anys[0].type!.getStart(original)}:=@${dts}`, 'Event');
        out.set(m, map);
      }
    }
  }
  return out;
}

/** The `dts:<position>:<path>@<file>` overrides of bundle declaration file `dts`. */
export function bundleOverrides(inferred: Map<string, string>, dts: string): Map<string, string> {
  const suffix = `@${dts}`;
  return new Map(
    [...inferred]
      .filter(([key]) => key.startsWith('dts:') && key.endsWith(suffix))
      .map(([key, text]) => [key.slice(0, -suffix.length), text]),
  );
}

/**
 * Properties that a reached module's declaration file types `any` (bits-ui's
 * PinInput state options `pattern: any`, which hold getter boxes of the
 * Root's `pattern` prop): each takes the one type of the values the program
 * gives it, literals widened, where every value is found. A value is given by an object literal whose contextual
 * type holds the property, also through a mapped type
 * (`ReadableBoxedValues<{ pattern: any }>` holds `ReadableBox<any>`: the
 * `any` is that alias's argument, which the value's box type gives), or by
 * a write of the property. The property stays `any`, and is rejected where
 * it is used, as before, where some value may come from elsewhere (it fails
 * closed): a spread or computed key into such a literal, a literal without
 * its own contextual type giving a property of its name, an object of
 * another type passed, returned or assigned where the property's type is
 * expected, a compound write, a write of its `current`; or where the values
 * have several types, or a type with `any` in it.
 *
 * Returns, per module, the `dts:<position>:<path>` entries for its
 * declaration file: the `any` keyword at that position of the file becomes
 * the type (`path` is `=` for the property's own type, or the index of the
 * alias argument the `any` is).
 */
function declaredAnyTypes(
  modules: Map<string, PackageModule>,
  program: ts.Program,
  print: (t: ts.Type, at: ts.Node) => string | undefined,
): Map<PackageModule, Map<string, string>> {
  const checker = program.getTypeChecker();
  const out = new Map<PackageModule, Map<string, string>>();
  interface Candidate {
    m: PackageModule;
    pos: number;
    name: string;
    /** The path an earlier pass found. */
    path?: string;
  }
  const candidates = new Map<ts.Declaration, Candidate>();
  const names = new Set<string>();
  for (const m of modules.values()) {
    if (m.port || !m.dts) continue;
    const sf = program.getSourceFile(m.dts);
    if (!sf) continue;
    const overrides = declarationOverrides(m.inferred);
    const paths = new Map<number, string>();
    for (const key of overrides.keys()) {
      const [, pos, path] = key.split(':');
      paths.set(Number(pos), path);
    }
    const original = ts.createSourceFile(
      m.dts,
      readFileSync(m.dts, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const { position } = virtualDeclarations(m.dts, overrides);
    const at = new Map<number, number>();
    const property = (n: ts.Node): n is ts.PropertySignature | ts.PropertyDeclaration =>
      (ts.isPropertySignature(n) ||
        (ts.isPropertyDeclaration(n) &&
          !ts.getModifiers(n)?.some(x => x.kind === ts.SyntaxKind.StaticKeyword))) &&
      !!n.type &&
      ts.isIdentifier(n.name);
    const visit = (n: ts.Node) => {
      if (property(n) && n.type!.kind === ts.SyntaxKind.AnyKeyword) {
        const pos = n.type!.getStart(original);
        at.set(position(pos), pos);
      }
      ts.forEachChild(n, visit);
    };
    visit(original);
    if (!at.size) continue;
    const find = (n: ts.Node) => {
      if (property(n)) {
        const pos = at.get(n.type!.getStart(sf));
        if (pos !== undefined) {
          const name = (n.name as ts.Identifier).text;
          candidates.set(n, { m, pos, name, path: paths.get(pos) });
          names.add(name);
        }
      }
      ts.forEachChild(n, find);
    };
    find(sf);
  }
  if (!candidates.size) return out;

  const F = ts.TypeFlags;
  const declOf = (s: ts.Symbol | undefined) => s && (s.valueDeclaration ?? s.declarations?.[0]);
  const partsOf = (t: ts.Type) => (t.isUnion() ? t.types : [t]);
  /** The candidates `ctx` holds by `name`, with the type it holds there. */
  const slots = (ctx: ts.Type, name: string) =>
    partsOf(ctx).flatMap(t => {
      const p = checker.getPropertyOfType(t, name);
      const d = declOf(p);
      return p && d && candidates.has(d) ? [{ decl: d, type: checker.getTypeOfSymbol(p) }] : [];
    });
  const given = new Map<ts.Declaration, { type: ts.Type; slot: ts.Type }[]>();
  const open = new Set<ts.Declaration>();
  const untyped = new Set<string>();
  const give = (d: ts.Declaration, type: ts.Type, slot: ts.Type) => {
    const list = given.get(d) ?? [];
    list.push({ type, slot });
    given.set(d, list);
  };
  const typedContext = (t: ts.Type | undefined): t is ts.Type =>
    !!t && !(t.flags & (F.Any | F.Unknown | F.TypeParameter));
  /**
   * The declared type of the class field (or variable) whose `$derived(e)`
   * or `$derived.by(() => e)` initialiser has `e` as a value (bits-ui's
   * `inputProps = $derived.by(() => ({ … }))`, annotated from the
   * declaration file): the value is the field's. (TypeScript's contextual
   * type for `e` is inferred from `e` itself, through the rune's type
   * parameter.)
   */
  const derivedTarget = (e: ts.Expression): ts.Type | undefined => {
    let at: ts.Node = e;
    while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
    let call: ts.Node | undefined;
    const parent = at.parent;
    if (ts.isCallExpression(parent) && parent.arguments[0] === at) call = parent;
    else {
      // (The arrow's result: its expression body, or a return in its body.)
      let fn: ts.Node | undefined;
      if (ts.isArrowFunction(parent) && parent.body === at) fn = parent;
      else if (ts.isReturnStatement(parent)) {
        fn = parent.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      }
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        let inner: ts.Node = fn;
        while (ts.isParenthesizedExpression(inner.parent)) inner = inner.parent;
        if (ts.isCallExpression(inner.parent) && inner.parent.arguments[0] === inner)
          call = inner.parent;
      }
    }
    if (!call || !ts.isCallExpression(call)) return undefined;
    const rune = call.expression.getText();
    if (rune !== (call.arguments[0] === at ? '$derived' : '$derived.by')) return undefined;
    const holder = call.parent;
    if (
      !(ts.isPropertyDeclaration(holder) || ts.isVariableDeclaration(holder)) ||
      holder.initializer !== call ||
      !holder.type
    )
      return undefined;
    return checker.getTypeAtLocation(holder.name);
  };
  /** A value of a non-literal expression where `ctx` is expected. */
  const flows = (e: ts.Expression) => {
    const x = skipParensOf(e);
    if (ts.isObjectLiteralExpression(x)) return;
    const ctx = derivedTarget(e) ?? checker.getContextualType(e);
    if (!typedContext(ctx)) return;
    for (const name of names)
      for (const s of slots(ctx, name)) {
        // (The same declared type passed on: the values it holds are counted
        // where they are given.)
        const own = checker.getNonNullableType(checker.getTypeAtLocation(x));
        const held = partsOf(own).map(t => declOf(checker.getPropertyOfType(t, name)));
        if (!held.length || held.some(d => d !== s.decl)) open.add(s.decl);
      }
  };
  for (const f of program.getSourceFiles()) {
    if (f.isDeclarationFile) continue;
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const ctx = derivedTarget(n) ?? checker.getContextualType(n);
        for (const p of n.properties) {
          if (ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))) {
            if (typedContext(ctx))
              for (const name of names) for (const s of slots(ctx, name)) open.add(s.decl);
            continue;
          }
          const name =
            p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
              ? p.name.text
              : undefined;
          if (!name || !names.has(name)) continue;
          // (A contextual type the literal gives itself, such as a generic
          // callee's inferred parameter: no declaration's.)
          const self = typedContext(ctx) && declOf(checker.getPropertyOfType(ctx, name)) === p;
          if (!typedContext(ctx) || self) {
            untyped.add(name);
            continue;
          }
          for (const s of slots(ctx, name)) {
            if (ts.isPropertyAssignment(p))
              give(s.decl, checker.getTypeAtLocation(p.initializer), s.type);
            else if (ts.isShorthandPropertyAssignment(p)) {
              const v = checker.getShorthandAssignmentValueSymbol(p);
              if (v) give(s.decl, checker.getTypeOfSymbolAtLocation(v, p), s.type);
              else open.add(s.decl);
            } else open.add(s.decl);
          }
        }
      } else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = skipParensOf(n.left);
        if (ts.isPropertyAccessExpression(left)) {
          const s = checker.getSymbolAtLocation(left.name);
          const d = declOf(s);
          if (s && d && candidates.has(d)) {
            if (n.operatorToken.kind === ts.SyntaxKind.EqualsToken)
              give(d, checker.getTypeAtLocation(n.right), checker.getTypeOfSymbol(s));
            else open.add(d);
          }
          // (A write into what the property holds: a box's `current`.)
          if (ts.isPropertyAccessExpression(left.expression)) {
            const inner = declOf(checker.getSymbolAtLocation(left.expression.name));
            if (inner && candidates.has(inner)) open.add(inner);
          }
        } else if (
          ts.isElementAccessExpression(left) &&
          (!ts.isStringLiteralLike(left.argumentExpression) ||
            names.has(left.argumentExpression.text))
        ) {
          for (const [d, c] of candidates)
            if (
              !ts.isStringLiteralLike(left.argumentExpression) ||
              c.name === left.argumentExpression.text
            )
              open.add(d);
        }
        if (n.operatorToken.kind === ts.SyntaxKind.EqualsToken) flows(n.right);
      } else if (ts.isCallExpression(n) || ts.isNewExpression(n)) n.arguments?.forEach(flows);
      else if (ts.isReturnStatement(n) && n.expression) flows(n.expression);
      else if ((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) && n.initializer)
        flows(n.initializer);
      else if (ts.isPropertyAssignment(n)) flows(n.initializer);
      else if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) flows(n.body);
      ts.forEachChild(n, visit);
    };
    visit(f);
  }

  const same = (a: ts.Type, b: ts.Type) =>
    checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
  for (const [d, c] of candidates) {
    const list = given.get(d);
    if (open.has(d) || untyped.has(c.name) || !list?.length) continue;
    let route = c.path;
    let type: ts.Type | undefined;
    let ok = true;
    for (const g of list) {
      const holders = partsOf(g.slot).filter(t => !(t.flags & (F.Undefined | F.Null)));
      // The path of the `any` in the slot's type (an earlier pass's, once
      // the property is typed).
      let here: string | undefined;
      if (route !== undefined) here = route;
      else if (holders.length === 1 && holders[0].flags & F.Any) here = '=';
      else if (holders.length === 1) {
        const args = holders[0].aliasTypeArguments ?? [];
        const at = args.flatMap((a, i) => (a.flags & F.Any ? [i] : []));
        if (at.length === 1) here = String(at[0]);
      }
      if (here === undefined || (route !== undefined && here !== route)) {
        ok = false;
        break;
      }
      route = here;
      let value: ts.Type | undefined = g.type;
      if (route !== '=') {
        const alias = holders.length === 1 ? holders[0].aliasSymbol : undefined;
        const box = partsOf(g.type).filter(t => !(t.flags & (F.Undefined | F.Null)));
        value =
          alias && box.length === 1 && box[0].aliasSymbol === alias
            ? box[0].aliasTypeArguments?.[Number(route)]
            : undefined;
      }
      if (!value || value.flags & (F.Any | F.Unknown | F.Never)) {
        ok = false;
        break;
      }
      value = checker.getBaseTypeOfLiteralType(value);
      if (type && !same(type, value)) {
        ok = false;
        break;
      }
      type ??= value;
    }
    const text = ok && type ? print(type, d) : undefined;
    if (text === undefined || route === undefined) continue;
    const map = out.get(c.m) ?? new Map<string, string>();
    map.set(`dts:${c.pos}:${route}`, text);
    out.set(c.m, map);
  }
  return out;
}

function skipParensOf(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** The files declaring what identifier `id` names, through import aliases. */
function declaredIn(checker: ts.TypeChecker, id: ts.Identifier): string {
  let sym = checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym?.declarations?.map(d => d.getSourceFile().fileName).join() ?? '';
}

/**
 * The package modules a program reaches from `roots` (component files and
 * local modules): the modules that declare what their imports name,
 * following barrels and re-exports, transitively. Barrels themselves are
 * not reached (TypeScript reads their declaration files).
 */
export function reachedPackageModules(
  resolver: ModuleResolver,
  roots: string[],
  isPackageModule: (file: string) => boolean,
): string[] {
  const reached: string[] = [];
  const seen = new Set<string>(roots);
  const queue = [...roots];
  const include = (file: string) => {
    if (seen.has(file) || !isPackageModule(file) || !/\.m?js$/.test(file)) return;
    seen.add(file);
    reached.push(file);
    queue.push(file);
  };
  while (queue.length) {
    const file = queue.shift()!;
    for (const sf of resolver.scripts(file))
      for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        const clause = stmt.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const edge = resolver.edge(file, (stmt.moduleSpecifier as ts.StringLiteral).text);
        if (!edge || edge.typeOnly) continue;
        const names: string[] = [];
        if (clause.name) names.push('default');
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named)) names.push('*');
        if (named && ts.isNamedImports(named))
          for (const el of named.elements)
            if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
        for (const name of names) {
          const ref = resolver.imported(edge, name);
          if (ref?.kind === 'binding' || ref?.kind === 'namespace') include(ref.file);
        }
      }
  }
  return reached.sort();
}

/**
 * The implementation of a class a package's declaration file declares: the
 * class of the same name in the typed module of the JavaScript file next to
 * it (`x.d.ts` → `x.js`), if the program reaches that module.
 */
export function implementationOf(
  program: ts.Program,
  modules: Map<string, PackageModule>,
): (sym: ts.Symbol) => ts.Symbol | undefined {
  return sym => {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    const sf = decl?.getSourceFile();
    if (!decl || !sf?.isDeclarationFile || !ts.isClassDeclaration(decl) || !decl.name)
      return undefined;
    const js = sf.fileName.replace(/\.d\.(m?)ts$/, '.$1js');
    const m = modules.get(js);
    const impl = m && program.getSourceFile(m.virtual);
    const cls = impl?.statements.find(
      (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === decl.name!.text,
    );
    return cls?.name && program.getTypeChecker().getSymbolAtLocation(cls.name);
  };
}

/**
 * Whether a class a package's declaration file declares has no instances in
 * the program: the package is compiled from source (`sourceDirs`, its
 * directories), the class is defined by the JavaScript file next to the
 * declaration file, and the program does not reach that module. Instances
 * are created only by code that runs, and the reached modules
 * (`reachedPackageModules`, from every component and local module, through
 * every value import) hold all package code that can run; code elsewhere
 * that could hold the class value would import its module, reaching it.
 * bits-ui's Calendar root context is typed `RangeCalendarRootState |
 * CalendarRootState` (calendar.svelte.d.ts) for both calendars; in a program
 * without a RangeCalendar, range-calendar.svelte.js is not reached and only
 * CalendarRootState values reach the context.
 */
export function unreachedClassOf(
  modules: Map<string, PackageModule>,
  sourceDirs: Iterable<string>,
): (sym: ts.Symbol) => boolean {
  const dirs = [...sourceDirs];
  return sym => {
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    const sf = decl?.getSourceFile();
    if (!decl || !sf?.isDeclarationFile || !ts.isClassDeclaration(decl) || !decl.name) return false;
    const js = sf.fileName.replace(/\.d\.(m?)ts$/, '.$1js');
    if (js === sf.fileName || modules.has(js) || !existsSync(js)) return false;
    // (A file of a package nested in the source package's node_modules is
    // another package's.)
    return dirs.some(d => {
      const rel = path.relative(d, js);
      return (
        !rel.startsWith('..') && !path.isAbsolute(rel) && !/(^|[\\/])node_modules[\\/]/.test(rel)
      );
    });
  };
}

/** A path relative to `root`, with packages named from their `node_modules` directory. */
export function displayPath(root: string, file: string): string {
  const i = file.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  return i >= 0 ? file.slice(i + 1) : path.relative(root, file);
}
