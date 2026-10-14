// Declaration overrides stated by mapping packs (M6 script DOM, slice 4):
// where a pack implements a package's function natively and gives it a more
// exact type than the package's declaration file states (embla's options
// merge returns the merge of both arguments, declared as the first's type),
// the pack rewrites that declaration in the virtual declaration file the
// typed modules read. An override is pinned like a helper entry: to the
// package's exact version and to the SHA-256 of the declaration file as
// published. A file that differs is left as it is, and every call of the
// pack's helpers in that package is rejected, located (`helperBinding`).
//
// This module holds data and plain functions only: the declaration files
// are rewritten before the language layer runs (package-modules.ts).
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface DeclarationOverride {
  package: string;
  version: string;
  /**
   * The declaration file, relative to the directory of the nearest
   * package.json naming the package (embla's `esm/package.json`), `/`-separated.
   */
  file: string;
  /** SHA-256 of the file as published. */
  sha256: string;
  /**
   * The declaration replaced: a top-level declaration's name, then property
   * names into its type literal (`['OptionsHandlerType', 'mergeOptions']`).
   */
  declaration: string[];
  /** The text that replaces the whole declaration (the statement or property signature). */
  text: string;
}

/**
 * embla-carousel 8.6.0 (frontend/packs/embla-carousel-8.6.0.ts): the
 * options merge returns a new object holding both arguments' keys, so its
 * result type is the intersection of the arguments' types; `optionsB` left
 * out gives `{}` (`optionsB || {}`). `objectsMergeDeep` itself keeps its
 * declaration: the bundle calls it only as `mergeOptions`' result, which
 * the pack lowers at `mergeOptions`' result type.
 */
export const OVERRIDES: DeclarationOverride[] = [
  {
    package: 'embla-carousel',
    version: '8.6.0',
    file: 'components/OptionsHandler.d.ts',
    sha256: '270724545d446036f42ddea422ee4d06963db1563ccc5e18b01c76f6e67968ae',
    declaration: ['OptionsHandlerType', 'mergeOptions'],
    text: 'mergeOptions: <TypeA extends OptionsType, TypeB extends OptionsType = {}>(optionsA: TypeA, optionsB?: TypeB) => TypeA & NonNullable<TypeB>;',
  },
];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The node a declaration path names in `sf`. */
function declarationNode(sf: ts.SourceFile, names: string[]): ts.Node | undefined {
  const [top, ...rest] = names;
  let node: ts.Node | undefined = sf.statements.find(s => {
    if (
      ts.isFunctionDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) ||
      ts.isInterfaceDeclaration(s) ||
      ts.isClassDeclaration(s)
    )
      return s.name?.text === top;
    return false;
  });
  for (const name of rest) {
    const members: ts.NodeArray<ts.TypeElement> | undefined =
      node && ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)
        ? node.type.members
        : node && ts.isPropertySignature(node) && node.type && ts.isTypeLiteralNode(node.type)
          ? node.type.members
          : node && ts.isInterfaceDeclaration(node)
            ? node.members
            : undefined;
    node = members?.find(
      m => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === name,
    );
  }
  return node;
}

/**
 * The overrides of package `pkg` at `version` whose files are not the ones
 * the pack was validated against: why, or undefined when every file is.
 */
export function overrideMismatch(
  pkg: { name: string; version: string },
  dir: string,
): string | undefined {
  for (const o of OVERRIDES) {
    if (o.package !== pkg.name || o.version !== pkg.version) continue;
    let text: string;
    try {
      text = readFileSync(path.join(dir, o.file), 'utf8');
    } catch {
      return `${pkg.name}@${pkg.version} has no ${o.file}, whose declaration the pack overrides`;
    }
    const actual = sha256(text);
    if (actual !== o.sha256)
      return `${o.file} differs from the declaration file the pack's override was validated against (SHA-256 ${actual}, the pack's ${o.sha256})`;
    const sf = ts.createSourceFile(o.file, text, ts.ScriptTarget.Latest, true);
    if (!declarationNode(sf, o.declaration))
      return `${o.file} does not declare ${o.declaration.join('.')}`;
  }
  return undefined;
}

/**
 * The edits the pack overrides make to declaration file `file` of package
 * `pkg` (in directory `dir`) whose parsed text is `sf`: none unless the file
 * is the pinned one.
 */
export function overrideEdits(
  pkg: { name: string; version: string },
  dir: string,
  file: string,
  sf: ts.SourceFile,
): { at: number; remove: number; insert: string }[] {
  const rel = path.relative(dir, file).split(path.sep).join('/');
  const edits: { at: number; remove: number; insert: string }[] = [];
  for (const o of OVERRIDES) {
    if (o.package !== pkg.name || o.version !== pkg.version || o.file !== rel) continue;
    if (sha256(sf.text) !== o.sha256) continue;
    const node = declarationNode(sf, o.declaration);
    if (!node) continue;
    const at = node.getStart(sf);
    edits.push({ at, remove: node.getEnd() - at, insert: o.text });
  }
  return edits;
}
