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
import { existsSync, readFileSync } from 'node:fs';
import type { ModuleResolver } from './modules.ts';

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
function qualified(n: ts.Node, sf: ts.SourceFile, top: Set<string>, local: Set<string>): string {
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
    text = text.slice(0, pos - start) + '__dts.' + text.slice(pos - start);
  return text;
}

function declarations(dts: string): Declared {
  const sf = ts.createSourceFile(dts, readFileSync(dts, 'utf8'), ts.ScriptTarget.Latest, true);
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
 */
export function exportAllDeclarations(dts: string): string {
  const text = readFileSync(dts, 'utf8');
  const sf = ts.createSourceFile(dts, text, ts.ScriptTarget.Latest, true);
  const at: number[] = [];
  for (const stmt of sf.statements) {
    const declaration =
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isVariableStatement(stmt) ||
      ts.isEnumDeclaration(stmt);
    const exported = ts
      .getModifiers(stmt as ts.HasModifiers)
      ?.some(
        m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
      );
    if (declaration && !exported) at.push(stmt.getStart(sf));
  }
  let out = text;
  for (const pos of at.reverse()) out = out.slice(0, pos) + 'export ' + out.slice(pos);
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
  return out;
}

/** The declaration file next to a JavaScript module (`x.js` → `x.d.ts`). */
export function declarationFile(file: string): string | undefined {
  const dts = file.replace(/\.(m?)js$/, '.d.$1ts');
  return dts !== file && existsSync(dts) ? dts : undefined;
}

/**
 * The names of the class fields of a module that hold an attachment
 * (initialised by svelte-toolbelt's `attachRef(…)`): an object literal
 * spreading one (`...this.wrapperAttachment`) builds an attribute bag.
 */
function attachmentFields(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyDeclaration(n) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      ts.isIdentifier(n.initializer.expression) &&
      n.initializer.expression.text === 'attachRef'
    )
      out.add(n.name.getText(sf));
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
  const object = (e: ts.Node | undefined): boolean => {
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
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
  const declared: Declared = dts
    ? declarations(dts)
    : { functions: new Map(), classes: new Map(), variables: new Set(), top: new Set<string>() };
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
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
    // Exported constants take their declared types (runed `Context<T>` keys).
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name) && !d.type && declared.variables.has(d.name.text))
          add(d.name.end, `: typeof __dts.${d.name.text}`);
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const d = declared.functions.get(stmt.name.text);
      if (!d || d.generic) continue;
      if (d.signatures === 1) {
        const f = `typeof __dts.${stmt.name.text}`;
        params(stmt, i => `Parameters<${f}>[${i}]`);
        // A type predicate (`element is HTMLElement`) narrows at call sites.
        const predicate = /^(\w+) is /.exec(d.overloads[0].result);
        const named = predicate && stmt.parameters.some(p => p.name.getText(sf) === predicate[1]);
        result(stmt, named ? d.overloads[0].result : `ReturnType<${f}>`);
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
    const d = declared.classes.get(cls);
    const C = `__dts.${cls}`;
    // A generic class (bits-ui's `SharedState<T extends AnyFn>`): its type
    // parameters and member types written out from the declaration file.
    if (d?.generic && declared.sf) {
      const sf = declared.sf;
      const dc = d.decl;
      const local = new Set(dc.typeParameters!.map(t => t.name.text));
      const q = (n: ts.Node) => qualified(n, sf, declared.top, local);
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
  // and types of untyped parameters from their calls (`param:<end>`).
  for (const [key, text] of inferred) {
    if (key.startsWith('new:')) add(Number(key.slice(4)), `<${text}>`);
    if (key.startsWith('param:')) add(Number(key.slice(6)), `: ${text}`);
    if (key.startsWith('ret:')) add(Number(key.slice(4)), `: ${text}`);
  }
  inserts.sort((a, b) => a.at - b.at);
  let text = dts ? `import type * as __dts from ${JSON.stringify(DTS_PREFIX + dts)};\n` : '';
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
  return { file, virtual, ...(dts ? { dts } : {}), text, segments, inferred };
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
      const dts = declarationFile(decl.getSourceFile().fileName.replace(/\.__runic\.ts$/, ''));
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
  for (const m of modules.values()) {
    // A pack's port is typed as written.
    if (m.port) continue;
    const sf = program.getSourceFile(m.virtual);
    if (!sf) continue;
    const attachments = attachmentFields(sf);
    const next = new Map(m.inferred);
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
            if (param) addType(param.getText());
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
    // `constructor(opts)` and `static use(opts)`): the one type the
    // program's calls pass, where they agree.
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt)) continue;
      for (const member of stmt.members) {
        if (
          !(ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)) ||
          !member.body
        )
          continue;
        member.parameters.forEach((p, i) => {
          if (p.type || p.dotDotDotToken || !ts.isIdentifier(p.name)) return;
          if (!(checker.getTypeAtLocation(p).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
            return;
          const texts = new Set<string>();
          let open = false;
          const sites = calls(member);
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
                : print(
                    t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)
                      ? t
                      : checker.getBaseTypeOfLiteralType(t),
                    a,
                  );
            if (text === undefined) open = true;
            else texts.add(text);
          }
          if (open || texts.size !== 1) return;
          const end = p.name.end;
          const seg = m.segments.find(g => end >= g.synth && end <= g.synth + g.length);
          if (!seg) return;
          const key = `param:${seg.orig + (end - seg.synth)}`;
          const text = [...texts][0];
          if (next.get(key) !== text) next.set(key, text);
        });
      }
    }
    if (JSON.stringify([...next]) !== JSON.stringify([...m.inferred])) {
      const code = readFileSync(m.file, 'utf8');
      const again = annotate(m.file, code, next);
      modules.set(m.file, again);
      changed.push(again);
    }
  }
  return changed;
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

/** A path relative to `root`, with packages named from their `node_modules` directory. */
export function displayPath(root: string, file: string): string {
  const i = file.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  return i >= 0 ? file.slice(i + 1) : path.relative(root, file);
}
