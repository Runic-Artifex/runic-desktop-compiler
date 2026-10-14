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

test("the pack's pinned declaration override types mergeOptions' result; activate takes the widest options its calls pass", () => {
  const handler = path.join(components, 'OptionsHandler.d.ts');
  assert.match(
    exportAllDeclarations(handler),
    /mergeOptions: <TypeA extends OptionsType, TypeB extends OptionsType = \{\}>\(optionsA: TypeA, optionsB\?: TypeB\) => TypeA & NonNullable<TypeB>;/,
  );
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
  const text = annotate(bundle, readFileSync(bundle, 'utf8'), m.inferred).text;
  // The generic member, from the override.
  assert.match(
    text,
    /function mergeOptions<TypeA extends __dts\d+\.OptionsType, TypeB extends __dts\d+\.OptionsType = \{\}>\(optionsA: TypeA, optionsB\?: TypeB\): TypeA & NonNullable<TypeB>/,
  );
  // `const reInit = reActivate`, returned as `reInit`: typed as the member.
  assert.match(
    text,
    /function reActivate\(withOptions: Parameters<ReturnType<typeof __dts\d+\.EmblaCarousel>\["reInit"\]>\[0\]/,
  );
  // Called with `userOptions` and `mergeOptions({ startIndex }, withOptions)`:
  // the widest, which holds every key of the other.
  assert.match(
    text,
    /function activate\(withOptions: Partial<__dts\d+\.OptionsType> \| undefined, /,
  );
  // `let`s assigned later: the values' type, nullable as the initial value
  // (`let engine;`), an empty array's from the arrays assigned (also from
  // `activePlugins = activePlugins.filter(…)` once typed).
  assert.match(text, /let engine: __dts\d+\.EngineType \| undefined;/);
  assert.match(text, /let activePlugins: __dts\d+\.CreatePluginType<[^>]+>\[\] = \[\];/);
  // EventStore: a `let` assigned in both branches of the folded
  // `'addEventListener' in node`, the legacy one on a `never` receiver left
  // out; an empty array of the items pushed onto it.
  assert.match(text, /let removeListener: \(\(\) => void\) \| undefined;/);
  assert.match(text, /let listeners: \(\(\) => void\)\[\] = \[\];/);
});

test("EventHandler's listeners, the generic and nested helpers, reduce seeds and the engine's callbacks are typed", () => {
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
  const text = annotate(bundle, readFileSync(bundle, 'utf8'), modules.get(bundle).inferred).text;
  // A dictionary written only from itself and the callbacks concatenated
  // (`listeners[evt] = getListeners(evt).concat([cb])`).
  assert.match(text, /let listeners: \{ \[key: string\]: __dts\d+\.CallbackType\[\] \} = \{\};/);
  // A nested function declaration, from its calls.
  assert.match(text, /function getListeners\(evt: string\)/);
  // Functions only called through a record by a key of its names.
  assert.match(text, /function center\(n: number\)/);
  assert.match(text, /function end\(n: number\)/);
  // Nested functions called by a generic member with its type parameter.
  assert.match(text, /function byNumber<Type>\(array: Type\[\], groupSize: number\)/);
  assert.match(text, /function bySize<Type>\(array: Type\[\]\)/);
  // An empty array a reduce starts from, of the items pushed onto it.
  assert.match(text, /\}, \[\] as number\[\]\)\.map\(\(currentSize, index, groups\)/);
  // A function passed to requestAnimationFrame, and the time it stores.
  assert.match(text, /function animate\(timeStamp: number\)/);
  assert.match(text, /let lastTimeStamp: number \| null = null;/);
  // The engine's update and render arrows: their destructured parameter.
  assert.match(text, /\}: __dts\d+\.EngineType\) => \{\n\s+if \(!loop\)/);
  assert.match(text, /\}: __dts\d+\.EngineType, alpha: number\) => \{/);
  // A copy of the slides (`[].slice.call(customSlides || container.children)`).
  assert.match(text, /let slides: HTMLElement\[\] \| undefined;/);
});
