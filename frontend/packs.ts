// Mapping packs (D9, docs/design/M6-LIBRARIES.md#mapping-packs-d9): how the
// compiler handles a package it does not compile from source. A bare import
// resolves, through the collector, to a package directory; its package.json
// name and exact version select one pack from frontend/packs/. Each pack
// declares the exports it covers and how their uses lower; any other use is
// rejected with a located diagnostic.
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Expr, Node } from './ir.ts';
import type { FnBuilder, Lowerer } from './language.ts';
import { clsxPack } from './packs/clsx-2.1.1.ts';
import { lucideSveltePack } from './packs/lucide-svelte-1.52.0.ts';

type Source = { file: string; line: number; column: number };

/** The package a bare import resolved into (compiler/collect.mjs). */
export interface PackageRef {
  name: string;
  version: string;
  /** The package directory (holding its package.json). */
  dir: string;
  /** The specifier's subpath: `.` or `./icons/x`. */
  subpath: string;
}

/** An import edge of the collected module graph. */
export interface Edge {
  specifier: string;
  resolved: string;
  package?: PackageRef;
}

/** A function export: calls lower to IR expressions. */
export interface PackFunction {
  kind: 'function';
  call(node: ts.CallExpression, b: FnBuilder, lower: Lowerer): Expr;
}

/** An attribute of a component instance, as written. */
export interface PackAttr {
  name: string;
  at: Source;
  value: { text: string } | { expr: ts.Expression } | { present: true };
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
    },
  ): Node;
}

export type PackExport = PackFunction | PackComponent;

export interface Pack {
  name: string;
  version: string;
  /** The pack module (its source is hashed into the program's `meta.mappings`). */
  module: string;
  /** Packs whose lowering this one reuses (also listed when it is used). */
  requires?: Pack[];
  /**
   * The export `imported` (`default` or a name) of the package module at
   * `pkg.subpath`, or a message saying why it is not covered.
   */
  export(pkg: PackageRef, imported: string): PackExport | string;
}

/** One module per pack, keyed by package name. */
const PACKS: Pack[] = [clsxPack, lucideSveltePack];

export class PackError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The pack for a resolved package: E_DEPENDENCY without one, E_PACK_VERSION for another version. */
export function packFor(pkg: PackageRef): Pack {
  const candidates = PACKS.filter(p => p.name === pkg.name);
  if (!candidates.length)
    throw new PackError(
      'E_DEPENDENCY',
      `No mapping pack for dependency ${pkg.name} (npm libraries compiled from source are planned for M6)`,
    );
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
): boolean {
  const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  const pkg = edge?.package;
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
    let found: { pack: Pack; value: PackExport };
    try {
      found = packExport(pkg, imported);
    } catch (e) {
      return fail(id, e);
    }
    const sym = lower.checker.getSymbolAtLocation(id);
    if (!sym) return lower.fail(id, 'E_PACK', `Cannot bind ${id.text}`);
    const { pack, value } = found;
    const label = `${imported === 'default' ? spec : `${imported} of ${spec}`} (${pack.name}@${pack.version})`;
    lower.bindings.set(sym, {
      kind: 'pack',
      label,
      call:
        value.kind === 'function'
          ? (node, b, l) => {
              usePack(l, pack);
              return value.call(node, b, l);
            }
          : undefined,
    });
  }
  return true;
}
