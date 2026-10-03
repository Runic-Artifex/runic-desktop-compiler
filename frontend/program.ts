// A TypeScript program over collected sources and virtual files.
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNES = path.join(here, 'svelte-runes.d.ts');
export const REACT = path.join(here, 'react.d.ts');
export const VUE = path.join(here, 'vue.d.ts');

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
};

/** Create a program whose root files are `files` (path → source text). */
export function createProgram(files: Map<string, string>, extraRoots: string[] = []): ts.Program {
  const host = ts.createCompilerHost(OPTIONS, true);
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
  return ts.createProgram({ rootNames: [...files.keys(), ...extraRoots], options: OPTIONS, host });
}

function scriptKind(name: string): ts.ScriptKind {
  if (name.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (name.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (name.endsWith('.js') || name.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
