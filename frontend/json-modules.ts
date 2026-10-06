// JSON modules behind a script module with declarations (M6, SvelteKit
// phase 2): velite's content collections (`.velite/index.js` re-exports the
// default export of each collection's `.json`, typed by its sibling
// `index.d.ts`). TypeScript types a script module with a sibling declaration
// file by the declarations; each declared constant that the module
// re-exports from a JSON file is a module constant built from the JSON value
// at build time, with the declared type. As for types of packages'
// declaration files, the key order of their records is not tracked
// (key-observing built-ins reject them).
import ts from 'typescript';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Binding, Lowerer } from './language.ts';
import type { Expr, Type } from './ir.ts';

interface ModuleLike {
  code: string;
  imports: { specifier: string; resolved: string }[];
}

const globals = new WeakMap<Lowerer, Map<string, number>>();

/** Marks the records of `type` as records whose key order is not tracked. */
function untrackedOrder(type: Type, lower: Lowerer, seen = new Set<number>()): void {
  if (typeof type !== 'object') return;
  if ('maybe' in type) return untrackedOrder(type.maybe, lower, seen);
  if ('array' in type) return untrackedOrder(type.array, lower, seen);
  if ('record' in type && !seen.has(type.record)) {
    seen.add(type.record);
    lower.types.packageRecords.add(type.record);
    for (const f of lower.types.records[type.record].fields) untrackedOrder(f.type, lower, seen);
  }
}

/** The IR value of a JSON value of type `type` (fails with `fail`). */
export function jsonExpr(
  value: unknown,
  type: Type,
  lower: Lowerer,
  fail: (message: string) => never,
  at = 'the value',
): Expr {
  if (typeof type === 'object' && 'maybe' in type) {
    if (value === undefined) return { op: 'undefined', type };
    if (value === null) return { op: 'null', type };
    return { op: 'some', value: jsonExpr(value, type.maybe, lower, fail, at) };
  }
  if (type === 'string' && typeof value === 'string') return { op: 'lit', value };
  if (type === 'boolean' && typeof value === 'boolean') return { op: 'lit', value };
  if (
    type === 'number' &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  )
    return { op: 'lit', value };
  if (typeof type === 'object' && 'array' in type && Array.isArray(value))
    return {
      op: 'array',
      type,
      items: value.map((v, i) => jsonExpr(v, type.array, lower, fail, `${at}[${i}]`)),
    };
  if (
    typeof type === 'object' &&
    'record' in type &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const record = lower.types.records[type.record];
    if (record.class) fail(`${at} has a class type`);
    const keys = Object.keys(value);
    for (const k of keys)
      if (!record.fields.some(f => f.name === k))
        fail(`${at} has ${k}, which its type does not declare`);
    return {
      op: 'record',
      record: type.record,
      fields: record.fields.map(f =>
        jsonExpr(
          (value as Record<string, unknown>)[f.name],
          f.type,
          lower,
          fail,
          `${at}.${f.name}`,
        ),
      ),
    };
  }
  return fail(
    `${at} (${JSON.stringify(value)?.slice(0, 40)}) does not have its declared type ${JSON.stringify(type)}`,
  );
}

/**
 * The binding of a constant declared in `<module>.d.ts` that `<module>.js`
 * re-exports as the default export of a JSON file, or undefined.
 */
export function jsonBinding(
  lower: Lowerer,
  symbol: ts.Symbol,
  modules: Map<string, ModuleLike>,
): Binding | undefined {
  const decl = symbol.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return undefined;
  const dts = decl.getSourceFile().fileName;
  if (!dts.endsWith('.d.ts')) return undefined;
  const js = dts.slice(0, -'.d.ts'.length) + '.js';
  const m = modules.get(js);
  if (!m) return undefined;
  const name = decl.name.text;
  const sf = ts.createSourceFile(js, m.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let specifier: string | undefined;
  for (const stmt of sf.statements)
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    )
      for (const el of stmt.exportClause.elements)
        if (el.name.text === name && (el.propertyName ?? el.name).text === 'default')
          specifier = stmt.moduleSpecifier.text;
  if (!specifier?.endsWith('.json')) return undefined;
  const file =
    m.imports.find(i => i.specifier === specifier)?.resolved ??
    path.resolve(path.dirname(js), specifier);
  const key = `${file}\0${name}`;
  let known = globals.get(lower);
  if (!known) globals.set(lower, (known = new Map()));
  let index = known.get(key);
  if (index === undefined) {
    const type = lower.types.map(lower.checker.getTypeOfSymbolAtLocation(symbol, decl), decl);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const fail = (message: string): never =>
      lower.fail(decl, 'E_JSON', `${path.basename(file)}: ${message}`);
    untrackedOrder(type, lower);
    const init = jsonExpr(value, type, lower, fail, name);
    index = lower.globals.length;
    lower.globals.push({ name: `${name}$json`, type, init });
    known.set(key, index);
  }
  return { kind: 'value', expr: { op: 'global', global: index } };
}

/**
 * Whether a script module only re-exports JSON files (velite's content
 * index): the modules typed by their sibling declaration files. Other script
 * modules are lowered from their source, typed by it.
 */
export function reexportsJson(code: string, file: string): boolean {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return (
    sf.statements.length > 0 &&
    sf.statements.every(
      s =>
        ts.isExportDeclaration(s) &&
        !!s.moduleSpecifier &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text.endsWith('.json'),
    )
  );
}
