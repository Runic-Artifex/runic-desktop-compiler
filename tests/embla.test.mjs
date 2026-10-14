// embla-carousel (M6 script DOM, slice 4; docs/design/M6-SCRIPT-DOM.md): its
// untyped ESM bundle is typed through the declaration files the package
// ships (frontend/package-modules.ts `bundleDeclarations`, user decision
// 2026-10-14), and the listener type its EventStore declares with `any`
// becomes the event its listeners receive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  annotate,
  bundleDeclarations,
  bundleOverrides,
  declarationFileOf,
  DTS_PREFIX,
  exportAllDeclarations,
  inferFields,
} from '../frontend/package-modules.ts';
import { createProgram } from '../frontend/program.ts';

const bundle = path.resolve('node_modules/embla-carousel/esm/embla-carousel.esm.js');
const components = path.resolve('node_modules/embla-carousel/esm/components');

test("a bundle's top-level names bind to the declaration file declaring each", () => {
  const code = readFileSync(bundle, 'utf8');
  const sf = ts.createSourceFile(bundle, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const b = bundleDeclarations(bundle, sf);
  assert.ok(b);
  assert.equal(b.entry, path.resolve('node_modules/embla-carousel/esm/index.d.ts'));
  const top = sf.statements.filter(ts.isFunctionDeclaration).map(s => s.name.text);
  assert.equal(top.length, 51);
  assert.deepEqual(
    top.filter(n => !b.names.has(n)),
    [],
  );
  assert.equal(b.files[b.names.get('Alignment')].dts, path.join(components, 'Alignment.d.ts'));
  assert.equal(b.files[b.names.get('defaultOptions')].dts, path.join(components, 'Options.d.ts'));
  assert.equal(declarationFileOf(bundle, 'isObject'), path.join(components, 'utils.d.ts'));
  const m = annotate(bundle, code);
  // (Alignment.d.ts sorts first: the binding of index 0.)
  assert.match(m.text, /function Alignment\(align: Parameters<typeof __dts\d+\.Alignment>\[0\]/);
  // Factories returning `const self = { … }` type the functions it holds,
  // up to the parameters the member declares.
  assert.match(
    m.text,
    /function add\(node: Parameters<ReturnType<typeof __dts\d+\.EventStore>\["add"\]>\[0\]/,
  );
  assert.match(
    m.text,
    /function scrollTo\(index: Parameters<[^>]+>\["scrollTo"\]>\[0\], jump: Parameters<[^>]+>\["scrollTo"\]>\[1\], direction\)/,
  );
});

test("EventStore's `(evt: any) => void` handlers are listeners: they receive an Event", () => {
  const modules = new Map([[bundle, annotate(bundle, readFileSync(bundle, 'utf8'))]]);
  const build = () => {
    const files = new Map();
    for (const m of modules.values()) {
      files.set(m.virtual, m.text);
      for (const d of m.bundleDts ?? [])
        files.set(d, exportAllDeclarations(d, bundleOverrides(m.inferred, d)));
    }
    return createProgram(files, [], spec =>
      spec.startsWith(DTS_PREFIX) ? spec.slice(DTS_PREFIX.length) : undefined,
    );
  };
  let program = build();
  for (let pass = 0; pass < 8 && inferFields(modules, program).length; pass++) program = build();
  const m = modules.get(bundle);
  const store = path.join(components, 'EventStore.d.ts');
  const overrides = bundleOverrides(m.inferred, store);
  assert.deepEqual([...overrides.values()], ['Event']);
  assert.match(
    exportAllDeclarations(store, overrides),
    /type EventHandlerType = \(evt: Event\) => void/,
  );
});
