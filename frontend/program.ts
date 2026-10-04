// A TypeScript program over collected sources and virtual files.
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNES = path.join(here, 'svelte-runes.d.ts');
export const REACT = path.join(here, 'react.d.ts');
export const VUE = path.join(here, 'vue.d.ts');
/** DOM element interfaces for refs (always part of the program). */
export const DOM = path.join(here, 'dom.d.ts');

export const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts'],
  strict: true,
  noEmit: true,
  allowJs: true,
  checkJs: true,
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.Preserve,
  types: [],
  // ES module lexical scope even without import/export (a local `Math` shadows the global).
  moduleDetection: ts.ModuleDetectionKind.Force,
};

/**
 * Create a program whose root files are `files` (path → source text).
 * `resolve(specifier, containingFile)` resolves imports as the collector
 * did (aliases, component files to their virtual modules); undefined leaves
 * the specifier to TypeScript (packages and their declaration files).
 */
export function createProgram(
  files: Map<string, string>,
  extraRoots: string[] = [],
  resolve?: (specifier: string, containingFile: string) => string | undefined,
): ts.Program {
  const host = ts.createCompilerHost(OPTIONS, true);
  if (resolve)
    host.resolveModuleNameLiterals = (literals, containingFile, _redirect, options) =>
      literals.map(literal => {
        const file = resolve(literal.text, containingFile);
        if (file)
          return {
            resolvedModule: {
              resolvedFileName: file,
              extension: extensionOf(file),
              isExternalLibraryImport: false,
            },
          };
        return ts.resolveModuleName(literal.text, containingFile, options, host);
      });
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, create) => {
    const text = files.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, version, true, scriptKind(name));
    return read(name, version, onError, create);
  };
  const exists = host.fileExists.bind(host);
  host.fileExists = name => files.has(name) || exists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = name => files.get(name) ?? readFile(name);
  return ts.createProgram({
    rootNames: [...files.keys(), ...extraRoots, DOM],
    options: OPTIONS,
    host,
  });
}

function extensionOf(name: string): ts.Extension {
  if (name.endsWith('.d.ts')) return ts.Extension.Dts;
  if (name.endsWith('.tsx')) return ts.Extension.Tsx;
  if (name.endsWith('.jsx')) return ts.Extension.Jsx;
  if (name.endsWith('.js')) return ts.Extension.Js;
  if (name.endsWith('.mjs')) return ts.Extension.Mjs;
  return ts.Extension.Ts;
}

function scriptKind(name: string): ts.ScriptKind {
  if (name.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (name.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (name.endsWith('.js') || name.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
