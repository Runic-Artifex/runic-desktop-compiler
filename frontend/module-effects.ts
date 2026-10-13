// Top-level code of packages compiled from source (frontend/sources.ts) that
// do not declare themselves free of module side effects.
//
// The frontend lowers a package module's declarations when the program first
// reaches them (frontend/package-bindings.ts), not the modules in order. That
// equals running the modules only where what a bundle runs, and the lowering
// does not run or runs later, is unobservable. A package declaring
// `"sideEffects": false` tells bundlers that a module whose exports nothing
// uses may be dropped. For any other package (no field, `true` or a list of
// files) a bundle evaluates every module the program's imports load, before
// the application starts: transitively, dependencies first, in import order,
// barrels and modules whose exports nothing uses included.
//
// So for those packages this check walks the modules a bundle evaluates, in
// that order, and accepts only top-level code that is inert: evaluating it
// has no effect, cannot throw, and gives values that do not depend on when it
// runs. Inert are declarations (functions, classes without effectful static
// parts), literals, functions, fresh objects and arrays of inert values,
// `typeof` tests, `===`/`!==`/`!`/`&&`/`||`/`??`/`?:` over inert values,
// bindings already initialised (functions always; constants, classes and
// imports once their module or statement ran), members of module namespaces,
// empty `Map`/`Set`/`WeakMap`/`WeakSet` (or Map/Set of literal entries),
// `Symbol(…)`, `Object.freeze` of a literal, signals created by `$state`,
// `$state.raw` and `$derived` in runes modules, and calls of the package's
// own functions and constructors whose bodies are inert in the same sense
// (field initialisers, assignments to the new object's own fields,
// `this.m = this.m.bind(this)`). Every package such a module imports must be
// covered (compiled from source or by a mapping pack) since its modules are
// evaluated too; svelte's own modules are the framework's. The first code a
// bundle would run that is not inert is rejected where it stands (E_MODULE),
// an uncovered import with its pack error. Reading host state (`window.x`,
// `localStorage`) is not inert: its value depends on when it is read.
import ts from 'typescript';
import { packFor, PackError, type Edge } from './packs.ts';
import type { ModuleRef, ModuleResolver } from './modules.ts';

type Source = { file: string; line: number; column: number };

/** The package record the collector gives a module of a package compiled from source. */
export interface SourcePackageInfo {
  name: string;
  version: string;
  /** Present where package.json declares `"sideEffects": false`. */
  sideEffects?: false;
}

export interface EffectsHost {
  entry: string;
  modules: Map<string, { imports: Edge[]; package?: SourcePackageInfo }>;
  resolver: ModuleResolver;
  /**
   * The scripts of a module, each with the source location of an offset in
   * it: a script module's code, a component file's `<script module>`
   * (`module`: it runs when the module is evaluated) and instance script.
   */
  scripts(file: string): Script[];
  /** Report a diagnostic (throws, normally). */
  fail(code: string, message: string, source: Source): void;
}

export interface Script {
  sf: ts.SourceFile;
  at(pos: number): Source;
  module: boolean;
}

/** Whether the package of a collected module declares `"sideEffects": false`. */
export function declaresNoSideEffects(pkg: SourcePackageInfo | undefined): boolean {
  return pkg?.sideEffects === false;
}

type FunctionLike =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

/** What a name refers to while inert code runs. */
type Local =
  | { kind: 'value' }
  | { kind: 'function'; node: FunctionLike; file: string; scope?: Map<string, Local> }
  | { kind: 'class'; node: ts.ClassLikeDeclaration; file: string; scope?: Map<string, Local> };

interface Env {
  /** The module whose code runs (names resolve in it). */
  file: string;
  /** Parameters and locals of the functions being run (innermost last). */
  locals: Map<string, Local>;
  /**
   * In a constructor (its field initialisers, its body and the methods it
   * calls): the class of the new object and the fields set so far
   * (`#name` for private ones).
   */
  self?: { cls: ts.ClassLikeDeclaration; file: string; fields: Set<string> };
  depth: number;
}

/** Why code is not inert: what it does, where. */
interface Finding {
  file: string;
  node: ts.Node;
  why: string;
  /** A pack error (an uncovered package the code uses). */
  code?: string;
}

const SVELTE = (e: Edge) => e.package?.name === 'svelte';
const RUNES = /\.svelte(\.(js|ts))?$/;

export function checkModuleEffects(host: EffectsHost): void {
  const { modules, resolver } = host;
  /** Modules whose evaluation started ('active') or finished ('done'). */
  const state = new Map<string, 'active' | 'done'>();
  /** The top-level statement an active module is running. */
  const progress = new Map<string, number>();
  const checked = (file: string) => {
    const pkg = modules.get(file)?.package;
    return !!pkg && !declaresNoSideEffects(pkg);
  };
  const parsed = new Map<string, Script[]>();
  const scripts = (file: string) => {
    if (!parsed.has(file)) parsed.set(file, host.scripts(file));
    return parsed.get(file)!;
  };
  /** The code a module runs when it is evaluated. */
  const body = (file: string) => scripts(file).find(s => s.module)?.sf;
  const where = (file: string, node: ts.Node): Source => {
    const sf = node.getSourceFile();
    const s = scripts(file).find(x => x.sf === sf)!;
    return s.at(node.getStart(sf));
  };
  const label = (file: string) => {
    const p = modules.get(file)!.package!;
    return `${p.name}@${p.version}`;
  };
  const report = (from: string, statement: ts.Node, f: Finding) => {
    const at = where(f.file, f.node);
    const top = where(from, statement);
    const via =
      at.file === top.file && at.line === top.line
        ? ''
        : ` (run at module evaluation by ${top.file}:${top.line}:${top.column})`;
    if (f.code)
      host.fail(
        f.code,
        `${f.why}${via}; ${label(from)} does not declare "sideEffects": false, so a bundle runs this when the program imports the package`,
        at,
      );
    else
      host.fail(
        'E_MODULE',
        `Top-level code of ${label(from)} that is not inert: this ${f.why}${via}. The package does not declare "sideEffects": false, so a bundle runs its modules' top-level code when the program imports it, while the compiler lowers only the declarations the program reaches`,
        at,
      );
  };

  const visit = (file: string) => {
    if (state.has(file)) return;
    const m = modules.get(file);
    if (!m) return;
    state.set(file, 'active');
    const mine = checked(file);
    for (const edge of m.imports) {
      if (edge.typeOnly || SVELTE(edge)) continue;
      const target = modules.get(edge.resolved);
      if (target) {
        // A package declaring "sideEffects": false: what its modules export
        // is lowered when reached (its own declaration covers the rest).
        if (target.package && declaresNoSideEffects(target.package)) continue;
        visit(edge.resolved);
      } else if (mine && edge.package) {
        // Another package, not compiled from source: its pack covers it.
        try {
          packFor(edge.package);
        } catch (e) {
          if (!(e instanceof PackError)) throw e;
          const stmt = scripts(file)
            .map(s => importOf(s.sf.statements, edge.specifier))
            .find(Boolean);
          host.fail(
            e.code,
            `${e.message}; ${label(file)} does not declare "sideEffects": false, so a bundle evaluates this import when the program imports the package`,
            stmt ? where(file, stmt) : scripts(file)[0].at(0),
          );
        }
      }
    }
    if (mine) {
      body(file)?.statements.forEach((stmt, i) => {
        progress.set(file, i);
        const f = statement(stmt, file);
        if (f) report(file, stmt, f);
      });
    }
    progress.delete(file);
    state.set(file, 'done');
  };

  /** The import or re-export declaration of `specifier` in `statements`. */
  function importOf(
    statements: readonly ts.Statement[] | undefined,
    specifier: string,
  ): ts.Statement | undefined {
    return statements?.find(
      s =>
        (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
        !!s.moduleSpecifier &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === specifier,
    );
  }

  // --- Top-level statements ---

  function statement(stmt: ts.Statement, file: string): Finding | undefined {
    const env: Env = { file, locals: new Map(), depth: 0 };
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEmptyStatement(stmt) ||
      (ts.isModuleDeclaration(stmt) && ts.getCombinedModifierFlags(stmt) & ts.ModifierFlags.Ambient)
    )
      return undefined;
    if (ts.isClassDeclaration(stmt)) return classDefinition(stmt, env);
    if (ts.isVariableStatement(stmt)) return declarations(stmt.declarationList, env);
    if (ts.isExportAssignment(stmt)) return expr(stmt.expression, env);
    if (ts.isExpressionStatement(stmt)) {
      // A directive (`"use strict"`).
      if (ts.isStringLiteral(stmt.expression)) return undefined;
      // `globalThis.NAME ??= init`: the lowering's program global for the
      // name, created with `init` where the program first uses it
      // (Lowerer.globalThisVar, which rejects any other write of the name).
      const e = skip(stmt.expression);
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
        ts.isPropertyAccessExpression(skip(e.left))
      ) {
        const target = skip((skip(e.left) as ts.PropertyAccessExpression).expression);
        if (
          ts.isIdentifier(target) &&
          target.text === 'globalThis' &&
          resolve(target, env).kind === 'global'
        )
          return expr(e.right, env);
      }
      return expr(stmt.expression, env);
    }
    return { file, node: stmt, why: `${describe(stmt)} runs at module evaluation` };
  }

  function declarations(list: ts.VariableDeclarationList, env: Env): Finding | undefined {
    for (const d of list.declarations) {
      if (!ts.isIdentifier(d.name))
        return {
          file: env.file,
          node: d.name,
          why: 'destructuring reads properties (and may run getters or iterators)',
        };
      if (d.initializer) {
        const f = expr(d.initializer, env);
        if (f) return f;
      }
      env.locals.set(d.name.text, local(d.initializer, env.file, env.locals));
    }
    return undefined;
  }

  /**
   * The local a declaration's initialiser gives: functions and classes are
   * followed when called, in the scope they were created in.
   */
  function local(init: ts.Expression | undefined, file: string, scope?: Map<string, Local>): Local {
    const e = init && skip(init);
    if (e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)))
      return { kind: 'function', node: e, file, scope };
    if (e && ts.isClassExpression(e)) return { kind: 'class', node: e, file, scope };
    return { kind: 'value' };
  }

  // --- Classes ---

  /** Defining a class: its heritage, computed keys and static parts run. */
  function classDefinition(cls: ts.ClassLikeDeclaration, env: Env): Finding | undefined {
    const at = (node: ts.Node, why: string): Finding => ({ file: env.file, node, why });
    const decorators = ts.canHaveDecorators(cls) ? ts.getDecorators(cls) : undefined;
    if (decorators?.length) return at(decorators[0], 'decorator runs at module evaluation');
    const base = heritage(cls);
    if (base) {
      const f = expr(base, env);
      if (f) return f;
    }
    for (const m of cls.members) {
      if (ts.canHaveDecorators(m) && ts.getDecorators(m)?.length)
        return at(m, 'decorator runs at module evaluation');
      if (m.name && ts.isComputedPropertyName(m.name) && !literalKey(m.name.expression))
        return at(m.name, 'computed member name is evaluated at module evaluation');
      if (ts.isClassStaticBlockDeclaration(m))
        if (m.body.statements.length) return at(m, 'static block runs at module evaluation');
      if (
        ts.isPropertyDeclaration(m) &&
        ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static &&
        m.initializer
      ) {
        const f = expr(m.initializer, env);
        if (f) return f;
      }
    }
    return undefined;
  }

  function heritage(cls: ts.ClassLikeDeclaration): ts.Expression | undefined {
    return cls.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
      ?.expression;
  }

  /** `new C(args)` of a class the package declares: its fields and constructor run. */
  function construct(
    target: { node: ts.ClassLikeDeclaration; file: string; scope?: Map<string, Local> },
    args: readonly ts.Expression[] | undefined,
    env: Env,
    site: ts.Node,
    /** The fields of the new object set so far (a subclass's construction shares them). */
    fields = new Set<string>(),
  ): Finding | undefined {
    const { node: cls, file } = target;
    if (env.depth > 24)
      return { file: env.file, node: site, why: 'construction nests too deeply to follow' };
    const inner: Env = {
      file,
      locals: new Map(target.scope),
      self: { cls, file, fields },
      depth: env.depth + 1,
    };
    const ctor = cls.members.find(
      (m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body,
    );
    const statements = [...(ctor?.body?.statements ?? [])];
    const f = ctor ? parameters(ctor, args, inner, env) : argumentsOf(args, env);
    if (f) return f;
    const base = heritage(cls);
    if (base) {
      const parent = classOf(base, inner);
      if (!parent)
        return { file, node: base, why: 'extends a class whose construction cannot be followed' };
      let superArgs: readonly ts.Expression[] | undefined = args;
      let superEnv = env;
      if (ctor) {
        const first = statements.shift();
        if (
          !first ||
          !ts.isExpressionStatement(first) ||
          !ts.isCallExpression(first.expression) ||
          first.expression.expression.kind !== ts.SyntaxKind.SuperKeyword
        )
          return { file, node: ctor, why: 'constructor does more than call super() first' };
        superArgs = first.expression.arguments;
        // (The arguments run before the object exists: `this` is unset.)
        superEnv = { ...inner, self: undefined };
      }
      const f = construct(parent, superArgs, superEnv, base, fields);
      if (f) return f;
    }
    // Instance fields, in order.
    for (const m of cls.members)
      if (
        ts.isPropertyDeclaration(m) &&
        !(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static)
      ) {
        if (m.initializer) {
          const f = expr(m.initializer, inner);
          if (f) return f;
        }
        fields.add(m.name.getText());
      }
    for (const s of statements) {
      const f = constructorStatement(s, cls, inner);
      if (f) return f;
    }
    return undefined;
  }

  function constructorStatement(
    s: ts.Statement,
    cls: ts.ClassLikeDeclaration,
    env: Env,
  ): Finding | undefined {
    if (ts.isVariableStatement(s)) return declarations(s.declarationList, env);
    if (ts.isFunctionDeclaration(s) && s.name) {
      env.locals.set(s.name.text, { kind: 'function', node: s, file: env.file, scope: env.locals });
      return undefined;
    }
    if (ts.isEmptyStatement(s)) return undefined;
    if (
      ts.isExpressionStatement(s) &&
      ts.isBinaryExpression(s.expression) &&
      s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(s.expression.left) &&
      s.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      // An own field of the new object (not an accessor, which would run
      // code; a private name the class does not declare as a field throws).
      const name = s.expression.left.name.text;
      if (accessor(cls, name, env.file))
        return { file: env.file, node: s.expression.left, why: `assigns ${name} through a setter` };
      if (name.startsWith('#') && !env.self?.fields.has(name))
        return { file: env.file, node: s.expression.left, why: `assigns ${name}, not a field` };
      const right = skip(s.expression.right);
      // `this.m = this.m.bind(this)`: the method bound to the new object.
      const bound =
        ts.isCallExpression(right) &&
        ts.isPropertyAccessExpression(right.expression) &&
        right.expression.name.text === 'bind' &&
        right.arguments.length === 1 &&
        right.arguments[0].kind === ts.SyntaxKind.ThisKeyword &&
        ts.isPropertyAccessExpression(right.expression.expression) &&
        right.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        methodOf(cls, right.expression.expression.name.text, env.file);
      const f = bound ? undefined : expr(s.expression.right, env);
      if (!f) env.self?.fields.add(name);
      return f;
    }
    return { file: env.file, node: s, why: `${describe(s)} runs in a constructor` };
  }

  /** Whether `name` is an accessor (get/set) of the class or its bases. */
  function accessor(cls: ts.ClassLikeDeclaration, name: string, file: string): boolean {
    for (
      let c: { node: ts.ClassLikeDeclaration; file: string } | undefined = { node: cls, file };
      c;
    ) {
      if (
        c.node.members.some(
          m =>
            (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) &&
            m.name.getText() === name,
        )
      )
        return true;
      const base = heritage(c.node);
      c = base && classOf(base, { file: c.file, locals: new Map(), depth: 0 });
    }
    return false;
  }

  /** The method `name` of the class or its bases (`#name` for private ones). */
  function methodOf(
    cls: ts.ClassLikeDeclaration,
    name: string,
    file: string,
  ): { node: ts.MethodDeclaration; file: string } | undefined {
    for (
      let c: { node: ts.ClassLikeDeclaration; file: string } | undefined = { node: cls, file };
      c;
    ) {
      const m = c.node.members.find(
        (x): x is ts.MethodDeclaration =>
          ts.isMethodDeclaration(x) &&
          !(ts.getCombinedModifierFlags(x) & ts.ModifierFlags.Static) &&
          x.name.getText() === name,
      );
      if (m) return { node: m, file: c.file };
      const base = heritage(c.node);
      c = base && classOf(base, { file: c.file, locals: new Map(), depth: 0 });
    }
    return undefined;
  }

  // --- Functions ---

  /** A call's arguments, evaluated in order. */
  function argumentsOf(args: readonly ts.Expression[] | undefined, env: Env): Finding | undefined {
    for (const a of args ?? []) {
      if (ts.isSpreadElement(a))
        return { file: env.file, node: a, why: 'spreads a value (which runs its iterator)' };
      const f = expr(a, env);
      if (f) return f;
    }
    return undefined;
  }

  /** Binding a call's arguments to a function's parameters. */
  function parameters(
    fn: FunctionLike | ts.ConstructorDeclaration,
    args: readonly ts.Expression[] | undefined,
    inner: Env,
    outer: Env,
  ): Finding | undefined {
    const f = argumentsOf(args, outer);
    if (f) return f;
    for (const p of fn.parameters)
      if (ts.isIdentifier(p.name)) inner.locals.set(p.name.text, { kind: 'value' });
    for (const [i, p] of fn.parameters.entries()) {
      if (!ts.isIdentifier(p.name))
        return { file: inner.file, node: p, why: 'destructuring parameter reads properties' };
      if (p.dotDotDotToken) continue;
      if (p.initializer && (args?.[i] === undefined || isUndefined(args[i]))) {
        const f = expr(p.initializer, inner);
        if (f) return f;
      }
    }
    return undefined;
  }

  const running = new Set<ts.Node>();

  /** Calling a function the package declares, with inert arguments. */
  function call(
    target: { node: FunctionLike; file: string; scope?: Map<string, Local> },
    args: readonly ts.Expression[],
    env: Env,
    site: ts.Node,
    /** A method called on the object under construction: that object. */
    self?: Env['self'],
  ): Finding | undefined {
    const { node: fn, file } = target;
    if (running.has(fn) || env.depth > 24)
      return { file: env.file, node: site, why: 'call recurses at module evaluation' };
    // A closure sees the locals of the scope it was created in.
    const inner: Env = { file, locals: new Map(target.scope), self, depth: env.depth + 1 };
    const f = parameters(fn, args, inner, env);
    if (f) return f;
    if (!fn.body) return undefined;
    if (fn.asteriskToken || ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async)
      return { file, node: fn, why: 'async or generator function runs at module evaluation' };
    running.add(fn);
    try {
      if (!ts.isBlock(fn.body)) return expr(fn.body, inner);
      for (const s of fn.body.statements)
        if (ts.isFunctionDeclaration(s) && s.name)
          inner.locals.set(s.name.text, { kind: 'function', node: s, file, scope: inner.locals });
      for (const s of fn.body.statements) {
        if (ts.isFunctionDeclaration(s) || ts.isEmptyStatement(s)) continue;
        if (ts.isVariableStatement(s)) {
          const f = declarations(s.declarationList, inner);
          if (f) return f;
          continue;
        }
        if (ts.isReturnStatement(s)) return s.expression ? expr(s.expression, inner) : undefined;
        return {
          file,
          node: s,
          why: `${describe(s)} runs in a function called at module evaluation`,
        };
      }
      return undefined;
    } finally {
      running.delete(fn);
    }
  }

  // --- Names ---

  /** What `name` refers to in `env`, and whether it is initialised yet. */
  function resolve(
    id: ts.Identifier,
    env: Env,
  ):
    | { kind: 'local'; local: Local }
    | { kind: 'ref'; ref: ModuleRef; ready: boolean; decl?: ts.Node }
    | { kind: 'global' } {
    const local = env.locals.get(id.text);
    if (local) return { kind: 'local', local };
    const b = body(env.file);
    const statements = b?.statements ?? [];
    for (const [i, s] of statements.entries()) {
      if (ts.isImportDeclaration(s)) {
        const clause = s.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const spec = (s.moduleSpecifier as ts.StringLiteral).text;
        let imported: string | undefined;
        if (clause.name?.text === id.text) imported = 'default';
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named) && named.name.text === id.text) imported = '*';
        if (named && ts.isNamedImports(named))
          for (const el of named.elements)
            if (el.name.text === id.text && !el.isTypeOnly)
              imported = (el.propertyName ?? el.name).text;
        if (imported === undefined) continue;
        const edge = resolver.edge(env.file, spec);
        const ref = edge && resolver.imported(edge, imported);
        if (!ref) return { kind: 'global' };
        return { kind: 'ref', ref, ready: ready(ref) };
      }
      if (ts.isFunctionDeclaration(s) && s.name?.text === id.text)
        return {
          kind: 'ref',
          ref: { kind: 'binding', file: env.file, name: id.text },
          ready: true,
          decl: s,
        };
      if (ts.isClassDeclaration(s) && s.name?.text === id.text)
        return {
          kind: 'ref',
          ref: { kind: 'binding', file: env.file, name: id.text },
          ready: initialised(env.file, i),
          decl: s,
        };
      if (ts.isVariableStatement(s))
        for (const d of s.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === id.text)
            return {
              kind: 'ref',
              ref: { kind: 'binding', file: env.file, name: id.text },
              ready: initialised(env.file, i),
              decl: d,
            };
    }
    return { kind: 'global' };
  }

  /**
   * Whether top-level statement `i` of `file` has run (modules this walk
   * does not check run before what imports them).
   */
  function initialised(file: string, i: number): boolean {
    const s = state.get(file);
    if (s === 'active') return i < (progress.get(file) ?? -1);
    return s === 'done' || !checked(file);
  }

  /** Whether an imported binding is initialised (its module ran; functions always are). */
  function ready(ref: ModuleRef): boolean {
    if (ref.kind === 'package' || ref.kind === 'component') return true;
    if (ref.kind === 'namespace') return state.get(ref.file) !== 'active';
    const d = declaration(ref.file, ref.name);
    if (d && ts.isFunctionDeclaration(d.node)) return true;
    // Modules this walk does not run (local ones, packages declaring
    // "sideEffects": false) run before what imports them.
    if (!checked(ref.file)) return state.get(ref.file) !== 'active';
    return d ? initialised(ref.file, d.index) : state.get(ref.file) === 'done';
  }

  /** The top-level declaration of `name` in `file`, with its statement's index. */
  function declaration(file: string, name: string): { node: ts.Node; index: number } | undefined {
    const statements = body(file)?.statements ?? [];
    for (const [index, s] of statements.entries()) {
      if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name)
        return { node: s, index };
      if (ts.isVariableStatement(s))
        for (const d of s.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === name) return { node: d, index };
    }
    return undefined;
  }

  /** The function a callee names (a declaration of the package, or a local closure). */
  function functionOf(
    e: ts.Expression,
    env: Env,
  ): { node: FunctionLike; file: string; scope?: Map<string, Local> } | undefined {
    e = skip(e);
    if (!ts.isIdentifier(e)) return undefined;
    const r = resolve(e, env);
    if (r.kind === 'local') return r.local.kind === 'function' ? r.local : undefined;
    if (r.kind !== 'ref' || r.ref.kind !== 'binding') return undefined;
    const d = declaration(r.ref.file, r.ref.name);
    if (!d) return undefined;
    if (ts.isFunctionDeclaration(d.node)) return { node: d.node, file: r.ref.file };
    if (ts.isVariableDeclaration(d.node) && d.node.initializer) {
      const l = local(d.node.initializer, r.ref.file);
      if (l.kind === 'function') return l;
    }
    return undefined;
  }

  /** The class a constructor expression names. */
  function classOf(
    e: ts.Expression,
    env: Env,
  ): { node: ts.ClassLikeDeclaration; file: string; scope?: Map<string, Local> } | undefined {
    e = skip(e);
    if (!ts.isIdentifier(e)) return undefined;
    const r = resolve(e, env);
    if (r.kind === 'local') return r.local.kind === 'class' ? r.local : undefined;
    if (r.kind !== 'ref' || r.ref.kind !== 'binding') return undefined;
    const d = declaration(r.ref.file, r.ref.name);
    if (!d) return undefined;
    if (ts.isClassDeclaration(d.node)) return { node: d.node, file: r.ref.file };
    if (ts.isVariableDeclaration(d.node) && d.node.initializer) {
      const l = local(d.node.initializer, r.ref.file);
      if (l.kind === 'class') return l;
    }
    return undefined;
  }

  /** A pack's error for a package export used at module evaluation, or what it calls. */
  function packageUse(ref: ModuleRef, node: ts.Node, env: Env, what: string): Finding {
    // (svelte's own exports are the framework's: what they do is not inert.)
    if (ref.kind === 'package' && ref.edge.package && !SVELTE(ref.edge))
      try {
        packFor(ref.edge.package);
      } catch (e) {
        if (e instanceof PackError) return { file: env.file, node, why: e.message, code: e.code };
        throw e;
      }
    const name = ref.kind === 'package' ? `${ref.name} of ${ref.edge.specifier}` : node.getText();
    return { file: env.file, node, why: `${what} ${name} at module evaluation` };
  }

  // --- Expressions ---

  function expr(e: ts.Expression, env: Env): Finding | undefined {
    const at = (node: ts.Node, why: string): Finding => ({ file: env.file, node, why });
    e = skip(e);
    const K = ts.SyntaxKind;
    switch (e.kind) {
      case K.StringLiteral:
      case K.NumericLiteral:
      case K.BigIntLiteral:
      case K.NoSubstitutionTemplateLiteral:
      case K.TrueKeyword:
      case K.FalseKeyword:
      case K.NullKeyword:
      case K.RegularExpressionLiteral:
      case K.ArrowFunction:
      case K.FunctionExpression:
        return undefined;
      case K.ThisKeyword:
        return at(e, 'reads this at module evaluation');
    }
    if (ts.isClassExpression(e)) return classDefinition(e, env);
    if (ts.isIdentifier(e)) {
      const r = resolve(e, env);
      if (r.kind === 'local') return undefined;
      if (r.kind === 'global')
        return ['undefined', 'NaN', 'Infinity'].includes(e.text)
          ? undefined
          : at(e, `reads the host global ${e.text}`);
      return r.ready ? undefined : at(e, `reads ${e.text} before it is initialised`);
    }
    if (ts.isTypeOfExpression(e)) {
      // `typeof name` of a global never throws (an unset binding would).
      if (ts.isIdentifier(skip(e.expression))) {
        const r = resolve(skip(e.expression) as ts.Identifier, env);
        if (r.kind !== 'ref' || r.ready) return undefined;
        return at(e.expression, `reads ${e.expression.getText()} before it is initialised`);
      }
      return expr(e.expression, env);
    }
    if (ts.isVoidExpression(e)) return expr(e.expression, env);
    if (ts.isPrefixUnaryExpression(e)) {
      if (e.operator === K.ExclamationToken) return expr(e.operand, env);
      if (
        [K.MinusToken, K.PlusToken, K.TildeToken].includes(e.operator) &&
        (ts.isNumericLiteral(skip(e.operand)) || ts.isBigIntLiteral(skip(e.operand)))
      )
        return undefined;
      return at(e, 'converts a value to a number (which may run code)');
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        [
          K.EqualsEqualsEqualsToken,
          K.ExclamationEqualsEqualsToken,
          K.AmpersandAmpersandToken,
          K.BarBarToken,
          K.QuestionQuestionToken,
          K.CommaToken,
        ].includes(op)
      )
        return expr(e.left, env) ?? expr(e.right, env);
      if (op >= K.FirstAssignment && op <= K.LastAssignment)
        return at(e, `assigns ${e.left.getText()}`);
      return at(
        e.operatorToken,
        `applies ${e.operatorToken.getText()} (which may convert values and run code)`,
      );
    }
    if (ts.isConditionalExpression(e))
      return expr(e.condition, env) ?? expr(e.whenTrue, env) ?? expr(e.whenFalse, env);
    if (ts.isTemplateExpression(e)) {
      for (const span of e.templateSpans) {
        const x = skip(span.expression);
        if (!ts.isStringLiteral(x) && !ts.isNumericLiteral(x))
          return at(span.expression, 'converts a value to a string (which may run code)');
      }
      return undefined;
    }
    if (ts.isArrayLiteralExpression(e)) {
      for (const x of e.elements) {
        if (ts.isSpreadElement(x)) return at(x, 'spreads a value (which runs its iterator)');
        if (ts.isOmittedExpression(x)) continue;
        const f = expr(x, env);
        if (f) return f;
      }
      return undefined;
    }
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) return at(p, 'spreads an object (which may run getters)');
        if (p.name && ts.isComputedPropertyName(p.name) && !literalKey(p.name.expression))
          return at(p.name, 'computes a property key (which may run code)');
        if (ts.isPropertyAssignment(p)) {
          const f = expr(p.initializer, env);
          if (f) return f;
        } else if (ts.isShorthandPropertyAssignment(p)) {
          const f = expr(p.name, env);
          if (f) return f;
        }
        // Methods and accessors are defined, not run.
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const object = skip(e.expression);
      // A field of the object under construction set already, or one of its
      // methods (not an accessor, which would run code).
      if (object.kind === K.ThisKeyword && env.self) {
        const { cls, file, fields } = env.self;
        const name = e.name.text;
        if (accessor(cls, name, file)) return at(e, `reads ${e.getText()} through a getter`);
        if (fields.has(name) || methodOf(cls, name, file)) return undefined;
        return at(e, `reads ${e.getText()} before it is set`);
      }
      // A member of a module namespace (`Dialog.Trigger`): a binding.
      if (ts.isIdentifier(object)) {
        const r = resolve(object, env);
        if (r.kind === 'ref' && r.ref.kind === 'namespace') {
          if (!r.ready) return at(object, `reads ${object.text} before it is initialised`);
          const member = resolver.export(r.ref.file, e.name.text);
          return !member || ready(member)
            ? undefined
            : at(e, `reads ${e.getText()} before it is initialised`);
        }
        if (r.kind === 'global')
          return at(e, `reads ${e.getText()} (host state, read when the module is evaluated)`);
      }
      return at(e, `reads ${e.getText()} (a property read may run a getter)`);
    }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) return invocation(e, env);
    return at(e, `${describe(e)} runs at module evaluation`);
  }

  function invocation(e: ts.CallExpression | ts.NewExpression, env: Env): Finding | undefined {
    const at = (node: ts.Node, why: string): Finding => ({ file: env.file, node, why });
    const args = e.arguments ?? [];
    const callee = skip(e.expression);
    const isNew = ts.isNewExpression(e);
    const all = () => {
      for (const a of args) {
        if (ts.isSpreadElement(a)) return at(a, 'spreads a value (which runs its iterator)');
        const f = expr(a, env);
        if (f) return f;
      }
      return undefined;
    };
    // Svelte's signals in runes modules: created, not computed.
    const rune = runeName(callee);
    if (rune && RUNES.test(env.file.replace(/\.__runic\.ts$/, ''))) {
      if (rune === '$derived' || rune === '$derived.by') return undefined;
      if (rune === '$state' || rune === '$state.raw') return all();
      return at(e, `${rune}(…) runs at module evaluation`);
    }
    // A method of the object under construction (`this.#make()`).
    if (
      !isNew &&
      env.self &&
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const { cls, file, fields } = env.self;
      const m = !fields.has(callee.name.text) && methodOf(cls, callee.name.text, file);
      if (m) return call(m, args, env, e, env.self);
    }
    if (ts.isIdentifier(callee)) {
      const r = resolve(callee, env);
      if (r.kind === 'global') {
        // Built-ins whose construction runs no other code.
        if (isNew && ['Map', 'Set'].includes(callee.text)) {
          if (!args.length) return undefined;
          const list = skip(args[0]);
          if (args.length === 1 && ts.isArrayLiteralExpression(list)) {
            if (callee.text === 'Map')
              for (const x of list.elements) {
                const entry = ts.isSpreadElement(x) ? x : skip(x);
                if (!ts.isArrayLiteralExpression(entry) || entry.elements.length !== 2)
                  return at(x, 'gives Map an entry that is not a [key, value] literal');
              }
            return all();
          }
          return at(e, `new ${callee.text}(…) of a value that is not an array literal iterates it`);
        }
        if (isNew && ['WeakMap', 'WeakSet'].includes(callee.text) && !args.length) return undefined;
        if (!isNew && callee.text === 'Symbol' && args.length <= 1) return all();
        return at(e, `${isNew ? 'constructs' : 'calls'} ${callee.text} at module evaluation`);
      }
      if (r.kind === 'ref' && !r.ready)
        return at(callee, `reads ${callee.text} before it is initialised`);
      if (r.kind === 'ref' && r.ref.kind === 'package')
        return packageUse(r.ref, callee, env, isNew ? 'constructs' : 'calls');
      if (isNew) {
        const cls = classOf(callee, env);
        if (cls) return construct(cls, args, env, e);
      } else {
        const fn = functionOf(callee, env);
        if (fn) return call(fn, args, env, e);
      }
      return at(e, `${isNew ? 'constructs' : 'calls'} ${callee.text}, which cannot be followed`);
    }
    // `Object.freeze` of a literal object or array (a fresh one).
    if (
      !isNew &&
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object' &&
      callee.name.text === 'freeze' &&
      resolve(callee.expression, env).kind === 'global' &&
      args.length === 1 &&
      (ts.isObjectLiteralExpression(skip(args[0])) || ts.isArrayLiteralExpression(skip(args[0])))
    )
      return all();
    if (ts.isClassExpression(callee) && isNew) {
      const f = classDefinition(callee, env);
      return f ?? construct({ node: callee, file: env.file, scope: env.locals }, args, env, e);
    }
    return at(e, `${isNew ? 'constructs' : 'calls'} ${callee.getText()} at module evaluation`);
  }

  // Bundle order: from the entry, dependencies first; then any module left.
  visit(host.entry);
  for (const file of modules.keys()) visit(file);
}

function skip(e: ts.Expression): ts.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e)
    )
      e = e.expression;
    else return e;
  }
}

function isUndefined(e: ts.Expression): boolean {
  const x = skip(e);
  return (ts.isIdentifier(x) && x.text === 'undefined') || ts.isVoidExpression(x);
}

function literalKey(e: ts.Expression): boolean {
  const x = skip(e);
  return ts.isStringLiteral(x) || ts.isNumericLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x);
}

function runeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee) && callee.text.startsWith('$')) return callee.text;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text.startsWith('$')
  )
    return `${callee.expression.text}.${callee.name.text}`;
  return undefined;
}

/** `an if statement`, `a for of statement`, … */
function describe(n: ts.Node): string {
  const k = ts.SyntaxKind[n.kind].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return `${/^[aeiou]/.test(k) ? 'an' : 'a'} ${k}`;
}
