// Components as values (M6, docs/design/M6-SVELTEKIT.md, phase 2): a
// component imported and used as a value (`component={ButtonDemo}`, the
// default export of a module an `import.meta.glob` loads) and rendered by a
// dynamic tag (`<Markdown />`, `<Example />`).
//
// The program is a closed world, so the components used as values are
// known at build time. A component value is an instance of one class record
// (`Component`, a single `id` field), one module constant per component, so
// `===` is identity as for Svelte's component functions; class records are
// not plain data, so `JSON.stringify`, `String()` and key-observing built-ins
// reject them as they would misbehave. A dynamic tag lowers to an `if` chain
// over the component values that can reach it (frontend/adapters/svelte.ts).
import ts from 'typescript';
import type { Binding, Lowerer } from './language.ts';
import type { Type } from './ir.ts';

const states = new WeakMap<Lowerer, { record?: number; globals: Map<string, number> }>();

function state(lower: Lowerer) {
  let s = states.get(lower);
  if (!s) states.set(lower, (s = { globals: new Map() }));
  return s;
}

/** Whether `t` is svelte's `Component` type (any props). */
export function isComponentType(t: ts.Type): boolean {
  const s = t.aliasSymbol ?? t.getSymbol();
  if (!s || s.getName() !== 'Component') return false;
  return (s.declarations ?? []).some(d =>
    /[\\/]svelte[\\/]types[\\/]index\.d\.ts$/.test(d.getSourceFile().fileName),
  );
}

/** The record of component values. */
export function componentRecord(lower: Lowerer): number {
  const s = state(lower);
  if (s.record === undefined) {
    s.record = lower.types.records.length;
    lower.types.records.push({
      name: 'Component',
      class: true,
      fields: [{ name: 'id', type: 'string' }],
    });
  }
  return s.record;
}

/** The record of component values, if the program has one. */
export function knownComponentRecord(lower: Lowerer): number | undefined {
  return states.get(lower)?.record;
}

/** The IR type of svelte's `Component` (packType chain of the language layer). */
export function componentValueType(t: ts.Type, _at: ts.Node, lower: Lowerer): Type | undefined {
  return isComponentType(t) ? { record: componentRecord(lower) } : undefined;
}

/** The module constant holding the value of component `id` (its file, relative to the app). */
export function componentGlobal(lower: Lowerer, id: string): number {
  const s = state(lower);
  const known = s.globals.get(id);
  if (known !== undefined) return known;
  const record = componentRecord(lower);
  const index = lower.globals.length;
  lower.globals.push({
    name: `component$${s.globals.size}`,
    type: { record },
    init: { op: 'record', record, fields: [{ op: 'lit', value: id }] },
  });
  s.globals.set(id, index);
  return index;
}

/**
 * The binding of a component's default export used as a value: the symbol
 * TypeScript resolves an import of a component to (`__RunicComponent` of its
 * virtual module), or undefined. `unitOfVirtual` gives the component of a
 * virtual module (its id relative to the app).
 */
export function componentBinding(
  lower: Lowerer,
  symbol: ts.Symbol,
  unitOfVirtual: (fileName: string) => string | undefined,
): Binding | undefined {
  const decl = symbol.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return undefined;
  if (decl.name.text !== '__RunicComponent') return undefined;
  const id = unitOfVirtual(decl.getSourceFile().fileName);
  if (id === undefined) return undefined;
  return { kind: 'value', expr: { op: 'global', global: componentGlobal(lower, id) } };
}
