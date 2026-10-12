// npm packages compiled from their published source (docs/design/M6-LIBRARIES.md,
// "Library code"). A bare import resolves, through the collector, to a
// package directory; its package.json name and exact version decide how
// the compiler handles it:
//
// - a package listed here is compiled from its published files, as local
//   modules are (frontend/package-modules.ts types its untyped `dist`
//   JavaScript through the package's declaration files);
// - a package with a mapping pack (frontend/packs.ts) lowers through the pack;
// - any other package, or another version of one of these, is rejected
//   (E_DEPENDENCY, E_SOURCE_VERSION, E_PACK_VERSION) at the import.
//
// Only reached code is lowered: a source package must declare itself free of
// module side effects (`"sideEffects": false`), which is what makes lowering
// the declarations a program uses, and only those, equivalent to running the
// package's modules.

export interface SourcePackage {
  name: string;
  version: string;
}

/** Packages compiled from source, at the exact versions verified by conformance. */
export const SOURCE_PACKAGES: readonly SourcePackage[] = [
  // The north star's component library (the shadcn-svelte site's lockfile pin).
  { name: 'bits-ui', version: '2.19.2' },
  // Toasts (shadcn-svelte's Sonner; the site's lockfile pin).
  { name: 'svelte-sonner', version: '1.2.1' },
];

/** Whether `name@version` is compiled from source. */
export function isSourcePackage(name: string, version: string): boolean {
  return SOURCE_PACKAGES.some(p => p.name === name && p.version === version);
}

/** The versions of `name` compiled from source (empty if none). */
export function sourceVersions(name: string): string[] {
  return SOURCE_PACKAGES.filter(p => p.name === name).map(p => p.version);
}
