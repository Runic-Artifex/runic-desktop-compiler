// svelte/elements' attribute interfaces (`HTMLAttributes<T>`,
// `HTMLAnchorAttributes`, `SVGAttributes<T>`, …) as value types: attribute
// bags (docs/IR.md `attrs`). Their members are typed wider than the value
// model (`[key: \`data-${string}\`]: any`, `value?: any`), so as records
// they have no IR type; a value typed by one holds what Svelte spreads onto
// an element, which is what a bag is. shadcn-svelte's wrappers pass merged
// props of this type through snippet parameters
// (`child?: Snippet<[{ props: HTMLAnchorAttributes }]>`), where the snippet
// spreads them again.
import ts from 'typescript';
import type { Type } from './ir.ts';

/** Whether `t` is one of svelte/elements' attribute interfaces. */
export function isElementAttributes(t: ts.Type): boolean {
  if (!(t.flags & ts.TypeFlags.Object)) return false;
  const sym = t.getSymbol();
  if (!sym || !/Attributes$/.test(sym.name)) return false;
  const file = sym.declarations?.[0]?.getSourceFile().fileName ?? '';
  return /[\\/]svelte[\\/]elements\.d\.ts$/.test(file);
}

/** The IR type of a svelte/elements attribute interface (TypeMapper hook): a bag. */
export function elementAttributesType(t: ts.Type): Type | undefined {
  return isElementAttributes(t) ? 'attrs' : undefined;
}
