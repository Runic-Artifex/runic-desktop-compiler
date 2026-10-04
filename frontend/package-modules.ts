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
      generic: boolean;
      properties: Set<string>;
      methods: Map<string, { signatures: number; generic: boolean }>;
      statics: Map<string, { signatures: number; generic: boolean }>;
      accessors: Set<string>;
    }
  >;
}

function declarations(dts: string): Declared {
  const sf = ts.createSourceFile(dts, readFileSync(dts, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: Declared = { functions: new Map(), classes: new Map() };
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
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const c = {
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

/** The declaration file next to a JavaScript module (`x.js` → `x.d.ts`). */
export function declarationFile(file: string): string | undefined {
  const dts = file.replace(/\.(m?)js$/, '.d.$1ts');
  return dts !== file && existsSync(dts) ? dts : undefined;
}

/** Whether `init` builds an attribute bag: an object literal with a computed key, directly or as a derived value. */
function bagInitializer(init: ts.Expression | undefined): boolean {
  if (!init) return false;
  const object = (e: ts.Node | undefined): boolean => {
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
    return (
      !!e &&
      ts.isObjectLiteralExpression(e) &&
      e.properties.some(p => p.name && ts.isComputedPropertyName(p.name))
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
  const declared: Declared = dts ? declarations(dts) : { functions: new Map(), classes: new Map() };
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
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
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const d = declared.functions.get(stmt.name.text);
      if (!d || d.generic) continue;
      if (d.signatures === 1) {
        const f = `typeof __dts.${stmt.name.text}`;
        params(stmt, i => `Parameters<${f}>[${i}]`);
        result(stmt, `ReturnType<${f}>`);
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
    for (const m of stmt.members) {
      const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined;
      const isStatic =
        ts.canHaveModifiers(m) &&
        !!ts.getModifiers(m)?.some(x => x.kind === ts.SyntaxKind.StaticKeyword);
      if (ts.isPropertyDeclaration(m) && !isStatic && !m.type) {
        const key = `${cls}.${m.name.getText()}`;
        if (bagInitializer(m.initializer)) add(m.name.end, ': RunicAttrs');
        else if (inferred.has(key)) add(m.name.end, `: ${inferred.get(key)}`);
        else if (name && d && !d.generic && d.properties.has(name))
          add(m.name.end, `: ${C}["${name}"]`);
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
  const print = (t: ts.Type, at: ts.Node): string | undefined => {
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
    const node = checker.typeToTypeNode(
      t,
      at,
      ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseFullyQualifiedType,
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
  for (const m of modules.values()) {
    const sf = program.getSourceFile(m.virtual);
    if (!sf) continue;
    const next = new Map(m.inferred);
    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      const cls = stmt.name.text;
      const ctor = stmt.members.find(ts.isConstructorDeclaration);
      for (const member of stmt.members) {
        if (!ts.isPropertyDeclaration(member) || member.type) continue;
        if (
          ts.canHaveModifiers(member) &&
          ts.getModifiers(member)?.some(x => x.kind === ts.SyntaxKind.StaticKeyword)
        )
          continue;
        const fieldName = member.name.getText();
        const key = `${cls}.${fieldName}`;
        if (bagInitializer(member.initializer)) continue;
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
        // Assignments `this.f = value` in the class.
        let assigned = 0;
        let topLevel = false;
        const visit = (n: ts.Node) => {
          if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
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
