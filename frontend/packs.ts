// Mapping packs (D9, docs/design/M6-LIBRARIES.md#mapping-packs-d9): how the
// compiler handles a package it does not compile from source. A bare import
// resolves, through the collector, to a package directory; its package.json
// name and exact version select one pack from frontend/packs/. Each pack
// declares the exports it covers and how their uses lower; any other use is
// rejected with a located diagnostic.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Expr, Node, Type } from './ir.ts';
import type { Shape } from './bags.ts';
import type { Binding, FnBuilder, Lowerer } from './language.ts';
import { valueChoice, withRest, wrapperValues, type Choice } from './packs/choice.ts';
import { sourceVersions } from './sources.ts';
import { svelteReactivityImport } from './svelte-reactivity.ts';
import { svelteContextImport } from './svelte-context.ts';
import { cnPack } from './packs/cn-0.3.0.ts';
import { esmEnvPack } from './packs/esm-env-1.2.2.ts';
import { clsxPack } from './packs/clsx-2.1.1.ts';
import { lucideSveltePack } from './packs/lucide-svelte-1.52.0.ts';
import { tablerIconsSveltePack } from './packs/tabler-icons-svelte-3.40.0.ts';
import { tailwindMergePack } from './packs/tailwind-merge-3.7.0.ts';
import { tailwindVariantsPack } from './packs/tailwind-variants-3.3.1.ts';
import { runedPack } from './packs/runed-0.35.1.ts';
import { svelteToolbeltPack } from './packs/svelte-toolbelt-0.10.6.ts';
import { floatingUiDomPack } from './packs/floating-ui-dom-1.7.4.ts';
import { internationalizedDatePack } from './packs/internationalized-date-3.12.4.ts';
import { tabbablePack } from './packs/tabbable-6.5.0.ts';

type Source = { file: string; line: number; column: number };

/** The package a bare import resolved into (compiler/collect.mjs). */
export interface PackageRef {
  name: string;
  version: string;
  /** The package directory (holding its package.json). */
  dir: string;
  /** The specifier's subpath: `.` or `./icons/x`. */
  subpath: string;
  /** The package is compiled from source (frontend/sources.ts), not by a pack. */
  source?: boolean;
}

/** An import edge of the collected module graph. */
export interface Edge {
  specifier: string;
  resolved: string;
  package?: PackageRef;
  /** An import or re-export of types only (it loads nothing). */
  typeOnly?: boolean;
}

/** A function export: calls lower to IR expressions. */
export interface PackFunction {
  kind: 'function';
  call(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr;
  /**
   * The exact values a call can return, as a choice over its arguments'
   * values (frontend/packs/choice.ts), for packs that evaluate calls with
   * this one among their arguments at build time.
   */
  choice?(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Choice;
  /**
   * The values a call can return, without building IR (frontend/domains.ts
   * analyses what props receive); undefined when they are open.
   */
  values?(node: ts.CallExpression, lower: Lowerer): unknown[] | undefined;
  /**
   * A call that initialises a const and defines a new pack function, such as
   * tailwind-variants' `tv(config)`. The const has no runtime value: its
   * calls are lowered.
   */
  constant?(node: ts.CallExpression | ts.NewExpression, name: string, lower: Lowerer): PackFunction;
  /**
   * Calls are evaluated at build time from their arguments' syntax, so a
   * module function that only returns a call of this one over its rest
   * parameter is inlined at its call sites (`bindPackWrapper`).
   */
  inline?: boolean;
  /** Methods called on the export or constant (`watch.pre(…)`, `context.get()`). */
  methods?: Record<string, (node: ts.CallExpression, b: FnBuilder, lower: Lowerer) => Expr>;
  /** `new X(…)` of a class export (svelte-toolbelt's DOMContext). */
  construct?(node: ts.NewExpression, b: FnBuilder, lower: Lowerer): Expr;
  /** The keys of the attribute bag a call returns (frontend/bags.ts). */
  shape?(node: ts.CallExpression, of: (e: ts.Expression) => Shape): Shape;
  /**
   * The values the bag a call returns holds for `key` (`undefined` where it
   * may not hold it; frontend/bags.ts `BagShapes.values`), given those of
   * its arguments; undefined where they are open.
   */
  keyValues?(
    node: ts.CallExpression,
    key: string,
    of: (e: ts.Expression) => Shape,
    values: (e: ts.Expression) => unknown[] | undefined,
  ): unknown[] | undefined;
}

/** An attribute of a component instance, as written. */
export interface PackAttr {
  /** The attribute's name (`...` for a spread). */
  name: string;
  at: Source;
  value: { text: string } | { expr: ts.Expression } | { present: true } | { spread: ts.Expression };
}

/** A component export: an instance expands into template nodes. */
export interface PackComponent {
  kind: 'component';
  expand(
    attrs: PackAttr[],
    ctx: {
      lower: Lowerer;
      b: FnBuilder;
      at: Source;
      fail(code: string, message: string, at: Source): never;
      /** Spread attributes' bags (frontend/bags.ts): their names, values and value. */
      bags: {
        shape(e: ts.Expression): Shape;
        /** The values the bag holds for `key` (`ABSENT` where it may not), undefined where open. */
        values(e: ts.Expression, key: string): unknown[] | undefined;
        /** The bag, lowered. */
        value(e: ts.Expression): Expr;
      };
    },
  ): Node;
}

/**
 * A constant export: a plain value the package defines (svelte-toolbelt's
 * `srOnlyStyles`), folded where it is used as build-time constants are
 * (`Lowerer.constantMember`, spreads into style objects).
 */
export interface PackConstant {
  kind: 'constant';
  value: unknown;
}

/**
 * An export of a module the pack ports (`Pack.ports`): its uses resolve to
 * the port's declaration, lowered as package code compiled from source is.
 */
export interface PackPorted {
  kind: 'ported';
}

export type PackExport = PackFunction | PackComponent | PackConstant | PackPorted;

/**
 * A typed port of one module of the packed package (a file next to the
 * pack, in the language the compiler lowers): the program compiles it in
 * place of the package's module at `module` (relative to the package
 * directory), as a module of a package compiled from source. The package's
 * declaration files reach it as they reach that module.
 */
export interface PackPort {
  module: string;
  file: string;
}

export interface Pack {
  name: string;
  version: string;
  /** The pack module (its source is hashed into the program's `meta.mappings`). */
  module: string;
  /** Packs whose lowering this one reuses (also listed when it is used). */
  requires?: Pack[];
  /** Modules of the package the pack ports (`PackPort`). */
  ports?: PackPort[];
  /**
   * The export `imported` (`default` or a name) of the package module at
   * `pkg.subpath`, or a message saying why it is not covered.
   */
  export(pkg: PackageRef, imported: string): PackExport | string;
  /**
   * The IR type of a type the package declares that the pack represents
   * (svelte-toolbelt's boxes), or undefined for other types.
   */
  type?(t: ts.Type, at: ts.Node, lower: Lowerer): Type | undefined;
}

/** The IR type a pack gives `t` (TypeMapper hook), if any. */
export function packType(t: ts.Type, at: ts.Node, lower: Lowerer): Type | undefined {
  for (const pack of PACKS) {
    const found = pack.type?.(t, at, lower);
    if (found) {
      usePack(lower, pack);
      return found;
    }
  }
  return undefined;
}

/** One module per pack, keyed by package name. */
const PACKS: Pack[] = [
  clsxPack,
  cnPack,
  esmEnvPack,
  floatingUiDomPack,
  internationalizedDatePack,
  tabbablePack,
  lucideSveltePack,
  tablerIconsSveltePack,
  runedPack,
  svelteToolbeltPack,
  tailwindMergePack,
  tailwindVariantsPack,
];

export class PackError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The pack for a resolved package: E_DEPENDENCY without one (and when the
 * package is not compiled from source either), E_SOURCE_VERSION for another
 * version of a package compiled from source, E_PACK_VERSION for another
 * version of a packed one.
 */
export function packFor(pkg: PackageRef): Pack {
  const candidates = PACKS.filter(p => p.name === pkg.name);
  if (!candidates.length && sourceVersions(pkg.name).length)
    throw new PackError(
      'E_SOURCE_VERSION',
      `${pkg.name}@${pkg.version} is not compiled from source; the verified version is ${sourceVersions(pkg.name).join(', ')}`,
    );
  if (!candidates.length) {
    // A package that does not declare itself free of module side effects
    // cannot be listed in frontend/sources.ts: say so.
    let sideEffects: unknown;
    try {
      sideEffects = JSON.parse(
        readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'),
      ).sideEffects;
    } catch {
      sideEffects = undefined;
    }
    throw new PackError(
      'E_DEPENDENCY',
      sideEffects === false
        ? `No mapping pack for dependency ${pkg.name}, and it is not compiled from source (frontend/sources.ts lists those packages)`
        : `No mapping pack for dependency ${pkg.name}@${pkg.version}, and it cannot be compiled from source: its package.json does not declare "sideEffects": false, which compiling only the declarations a program reaches requires (frontend/sources.ts)`,
    );
  }
  const pack = candidates.find(p => p.version === pkg.version);
  if (!pack)
    throw new PackError(
      'E_PACK_VERSION',
      `${pkg.name}@${pkg.version} has no mapping pack; packs exist for version ${candidates.map(p => p.version).join(', ')}`,
    );
  return pack;
}

/** The export `imported` of an import edge's package (throws PackError when uncovered). */
export function packExport(pkg: PackageRef, imported: string): { pack: Pack; value: PackExport } {
  const pack = packFor(pkg);
  const value = pack.export(pkg, imported);
  if (typeof value === 'string') throw new PackError('E_PACK', value);
  return { pack, value };
}

const used = new WeakMap<Lowerer, Map<string, Pack>>();

/** Record that the program uses `pack` (reported in `meta.mappings`). */
export function usePack(lower: Lowerer, pack: Pack): void {
  let m = used.get(lower);
  if (!m) used.set(lower, (m = new Map()));
  m.set(`${pack.name}@${pack.version}`, pack);
  for (const p of pack.requires ?? []) usePack(lower, p);
}

/** The packs a program used, for `meta.mappings` (format version 1, the pack module's hash). */
export function packMappings(lower: Lowerer): { id: string; version: number; sha256: string }[] {
  return [...(used.get(lower) ?? new Map<string, Pack>())]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, pack]) => ({
      id,
      version: 1,
      sha256: createHash('sha256')
        .update(readFileSync(fileURLToPath(pack.module)))
        .digest('hex'),
    }));
}

/**
 * Bind the names a package import declares to its pack's exports. Returns
 * false for imports that are not of a package (local modules). Imports of
 * packages without a pack, of another version, or of exports the pack does
 * not cover are rejected at the import.
 */
export function bindPackImport(
  stmt: ts.ImportDeclaration,
  edge: Edge | undefined,
  lower: Lowerer,
  /** Bind only this imported name (package modules bind names on first use). */
  only?: ts.Identifier,
): boolean {
  const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
  if (isLocal(spec, edge)) return false;
  const pkg = edge?.package;
  // svelte/reactivity's SvelteMap: a type the language layer lowers
  // (frontend/svelte-reactivity.ts), in Svelte modules.
  if (pkg?.name === 'svelte' && spec === 'svelte/reactivity') {
    svelteReactivityImport(stmt, (n, code, message) => lower.fail(n, code, message));
    return true;
  }
  // svelte's setContext/getContext with string keys (frontend/svelte-context.ts).
  if (pkg?.name === 'svelte' && spec === 'svelte') {
    svelteContextImport(stmt, lower);
    return true;
  }
  const fail = (n: ts.Node, e: unknown): never => {
    if (e instanceof PackError) return lower.fail(n, e.code, e.message);
    throw e;
  };
  if (!pkg)
    return lower.fail(
      stmt,
      'E_DEPENDENCY',
      `No adapter for dependency ${spec} (it did not resolve into a package)`,
    );
  const clause = stmt.importClause;
  if (!clause || clause.isTypeOnly) {
    if (!clause) lower.fail(stmt, 'E_PACK', `Side-effect imports of ${spec} are unsupported`);
    return true;
  }
  const names: [ts.Identifier, string][] = [];
  if (clause.name) names.push([clause.name, 'default']);
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named))
    lower.fail(named, 'E_PACK', `Namespace imports of ${spec} are unsupported; import names`);
  if (named && ts.isNamedImports(named))
    for (const el of named.elements)
      if (!el.isTypeOnly) names.push([el.name, (el.propertyName ?? el.name).text]);
  for (const [id, imported] of names) {
    if (only && id !== only) continue;
    let found: { pack: Pack; value: PackExport };
    try {
      found = packExport(pkg, imported);
    } catch (e) {
      return fail(id, e);
    }
    const sym = lower.checker.getSymbolAtLocation(id);
    if (!sym) return lower.fail(id, 'E_PACK', `Cannot bind ${id.text}`);
    const { pack, value } = found;
    // A ported module's export: the name resolves to the port's declaration.
    if (value.kind === 'ported') {
      usePack(lower, pack);
      continue;
    }
    const label = `${imported === 'default' ? spec : `${imported} of ${spec}`} (${pack.name}@${pack.version})`;
    lower.bindings.set(sym, exportBinding(lower, pack, label, value));
  }
  return true;
}

/**
 * A relative import, or one an alias (runic.json `alias`) resolved to a
 * local file rather than into a package.
 */
const isLocal = (spec: string, edge: Edge | undefined): boolean =>
  spec.startsWith('.') ||
  spec.startsWith('/') ||
  // Packages compiled from source are modules like local ones.
  !!edge?.package?.source ||
  (!!edge && !edge.package && !/[\\/]node_modules[\\/]/.test(edge.resolved));

/**
 * Bind the names a module re-exports from a package (`export { cn } from
 * "cn"`, as shadcn-svelte's lib/utils.ts does) to its pack's exports: the
 * re-export's own symbol carries the binding, which importers reach through
 * their alias chain (`Lowerer.binding`). Returns false for re-exports of
 * local modules. `export *` and `export * as N` of a package are rejected:
 * a pack covers the names it lists.
 */
export function bindPackReexport(
  stmt: ts.ExportDeclaration,
  edge: Edge | undefined,
  lower: Lowerer,
): boolean {
  const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
  if (isLocal(spec, edge)) return false;
  const pkg = edge?.package;
  if (!pkg)
    return lower.fail(
      stmt,
      'E_DEPENDENCY',
      `No adapter for dependency ${spec} (it did not resolve into a package)`,
    );
  const clause = stmt.exportClause;
  if (!clause || !ts.isNamedExports(clause))
    return lower.fail(
      stmt,
      'E_PACK',
      `Re-export the names of ${spec} that the program uses (export { name } from "${spec}")`,
    );
  for (const el of clause.elements) {
    if (el.isTypeOnly) continue;
    const imported = (el.propertyName ?? el.name).text;
    let found: { pack: Pack; value: PackExport };
    try {
      found = packExport(pkg, imported);
    } catch (e) {
      if (e instanceof PackError) return lower.fail(el, e.code, e.message);
      throw e;
    }
    const sym = lower.checker.getSymbolAtLocation(el.name);
    if (!sym) return lower.fail(el, 'E_PACK', `Cannot bind ${el.name.text}`);
    const { pack, value } = found;
    if (value.kind === 'ported') {
      usePack(lower, pack);
      continue;
    }
    const label = `${imported} of ${spec} (${pack.name}@${pack.version})`;
    lower.bindings.set(sym, exportBinding(lower, pack, label, value));
  }
  return true;
}

/**
 * The ports of the packs of the packages `refs` name, by the path of the
 * package module each stands for.
 */
export function packPorts(
  refs: Iterable<PackageRef>,
): Map<string, { pack: Pack; file: string; ref: PackageRef }> {
  const out = new Map<string, { pack: Pack; file: string; ref: PackageRef }>();
  for (const ref of refs) {
    const pack = PACKS.find(p => p.name === ref.name && p.version === ref.version);
    if (!pack) continue;
    for (const port of pack.ports ?? [])
      out.set(path.join(ref.dir, port.module), { pack, file: port.file, ref });
  }
  return out;
}

/** The binding of a pack export. */
function exportBinding(lower: Lowerer, pack: Pack, label: string, value: PackExport): Binding {
  if (value.kind === 'function') return functionBinding(pack, label, value);
  if (value.kind === 'constant') {
    usePack(lower, pack);
    return { kind: 'constant', label, value: value.value };
  }
  return { kind: 'pack', label };
}

/** The binding of a pack function: its uses record the pack. */
function functionBinding(pack: Pack, label: string, fn: PackFunction): Binding {
  return {
    kind: 'pack',
    label,
    call: (node, b, l) => {
      usePack(l, pack);
      return fn.call(node, b, l);
    },
    choice: fn.choice
      ? (node, b, l) => {
          usePack(l, pack);
          return fn.choice!(node, b, l);
        }
      : undefined,
    values: fn.values,
    constant: fn.constant
      ? (node, name, l) => {
          usePack(l, pack);
          return functionBinding(
            pack,
            `${name} (${pack.name}@${pack.version})`,
            fn.constant!(node, name, l),
          );
        }
      : undefined,
    inline: fn.inline,
    construct: fn.construct
      ? (node, b, l) => {
          usePack(l, pack);
          return fn.construct!(node, b, l);
        }
      : undefined,
    methods: fn.methods
      ? Object.fromEntries(
          Object.entries(fn.methods).map(([k, m]) => [
            k,
            (node: ts.CallExpression, b: FnBuilder, l: Lowerer) => {
              usePack(l, pack);
              return m(node, b, l);
            },
          ]),
        )
      : undefined,
    shape: fn.shape,
    keyValues: fn.keyValues,
  };
}

/** The pack binding a call's (or `new`'s) callee names, if any. */
function calleeBinding(e: ts.Expression | undefined, lower: Lowerer) {
  const init = e && skip(e);
  if (
    !init ||
    !(ts.isCallExpression(init) || ts.isNewExpression(init)) ||
    !ts.isIdentifier(init.expression)
  )
    return undefined;
  const binding = lower.binding(init.expression);
  return binding?.kind === 'pack' ? { call: init, binding } : undefined;
}

const skip = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
    ? skip(e.expression)
    : e;

/**
 * Whether a call's callee is a function compiled from source (a function
 * declaration with a body outside declaration files, through imports). Its
 * result is a value, never a pack function, so `bindPackConstant` need not
 * resolve its binding, which lowers it: adapters ask before their prop
 * analyses exist, and lowering a package function then would decide the
 * unions it meets without them (bits-ui's `getDefaultDate` in the Calendar).
 */
function sourceFunction(e: ts.Expression | undefined, lower: Lowerer): boolean {
  const init = e && skip(e);
  if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return false;
  let sym = lower.checker.getSymbolAtLocation(init.expression);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = lower.checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration;
  return (
    !!decl &&
    ts.isFunctionDeclaration(decl) &&
    !!decl.body &&
    !decl.getSourceFile().isDeclarationFile &&
    lower.bindings.get(sym!)?.kind !== 'pack'
  );
}

/**
 * Bind a const initialised by a pack call that defines a new pack function
 * (`const button = tv({...})`). Returns false for other declarations.
 */
export function bindPackConstant(d: ts.VariableDeclaration, lower: Lowerer): boolean {
  // Bound already (adapters bind component constants before analysing props).
  const own = ts.isIdentifier(d.name) ? lower.checker.getSymbolAtLocation(d.name) : undefined;
  if (own && lower.bindings.get(own)?.kind === 'pack') return true;
  if (sourceFunction(d.initializer, lower)) return false;
  const found = calleeBinding(d.initializer, lower);
  if (!found?.binding.constant) return false;
  if (!ts.isIdentifier(d.name))
    return lower.fail(d.name, 'E_PACK', `${found.binding.label}: assign the result to a name`);
  if (!(ts.isVariableDeclarationList(d.parent) && d.parent.flags & ts.NodeFlags.Const))
    return lower.fail(
      d,
      'E_PACK',
      `${found.binding.label}: the result must be assigned to a const`,
    );
  const sym = lower.checker.getSymbolAtLocation(d.name);
  if (!sym) return lower.fail(d.name, 'E_PACK', `Cannot bind ${d.name.text}`);
  lower.bindings.set(sym, found.binding.constant(found.call, d.name.text, lower));
  return true;
}

/**
 * Bind a module function that only returns a call of an `inline` pack
 * function over its rest parameter, such as shadcn's
 * `function cn(...inputs) { return twMerge(clsx(inputs)); }`. Its calls are
 * lowered as that expression with the parameter standing for the array of
 * the call's arguments, so the pack sees the arguments' syntax. Returns
 * false for other functions (they lower as ordinary functions).
 */
export function bindPackWrapper(
  sym: ts.Symbol,
  decl: ts.FunctionLikeDeclaration,
  name: string,
  lower: Lowerer,
): boolean {
  if (decl.parameters.length !== 1 || decl.asteriskToken) return false;
  if (decl.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const param = decl.parameters[0];
  if (!param.dotDotDotToken || !ts.isIdentifier(param.name) || param.initializer) return false;
  const body = decl.body;
  let result: ts.Expression | undefined;
  if (body && ts.isBlock(body)) {
    const [only] = body.statements;
    if (body.statements.length === 1 && ts.isReturnStatement(only)) result = only.expression;
  } else if (body) result = body as ts.Expression;
  const found = calleeBinding(result, lower);
  if (!found?.binding.inline) return false;
  const rest = lower.checker.getSymbolAtLocation(param.name);
  if (!rest) return false;
  const expr = result!;
  const label = `${name} (inlined: it returns ${found.binding.label})`;
  lower.bindings.set(sym, {
    kind: 'pack',
    label,
    call: (node, b, l) => withRest(l, rest, node.arguments, () => l.expr(expr, b)),
    choice: (node, b, l) =>
      withRest(l, rest, node.arguments, () => valueChoice({ lower: l, b, label }, expr)),
    values: (node, l) => wrapperValues({ lower: l, label }, rest, node.arguments, expr),
    inline: true,
  });
  return true;
}
