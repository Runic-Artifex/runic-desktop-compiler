// Svelte 5 (runes) adapter on the shared language layer (docs/design/M2-VALUES.md,
// docs/design/M3-COMPONENTS.md). Framework semantics only: runes → cells and
// derived functions with immediate reads and writes, `$props` → prop cells,
// child components → instances, `{#each}` → lists, template → IR nodes,
// events → handlers. Ordinary code goes through frontend/language.ts.
import ts from 'typescript';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type {
  AttrItem,
  Cell,
  Component,
  MountSite,
  SlotDef,
  Expr,
  Handler,
  Listener,
  Node,
  Program,
  Stmt,
  Type,
  RecordType,
  Effect,
} from '../ir.ts';
import { EVENT_KINDS } from '../ir.ts';
import {
  FnBuilder,
  Lowerer,
  remapLocals,
  skipParens,
  type HandlerEvent,
  type Hooks,
} from '../language.ts';
import { createProgram, RUNES } from '../program.ts';
import { TypeMapper } from '../types.ts';
import { lowerModules, ModuleResolver } from '../modules.ts';
import {
  annotate,
  displayPath,
  DTS_PREFIX,
  exportAllDeclarations,
  implementationOf,
  inferFields,
  reachedPackageModules,
  type PackageModule,
} from '../package-modules.ts';
import { PropDomains, type PropDecl, type Site, type SiteValue } from '../domains.ts';
import { checkMapReads, svelteReactivityImport } from '../svelte-reactivity.ts';
import { svelteContextImport } from '../svelte-context.ts';
import { valueSet } from '../packs/choice.ts';
import { BagShapes, emptyShape, mayHold, openShape, union, type Shape } from '../bags.ts';
import { packageBindings } from '../package-bindings.ts';
import { arrayElement, maybeInner, upcastTo } from '../irtype.ts';
import {
  bindPackImport,
  packExport,
  packFor,
  packMappings,
  PackError,
  usePack,
  type Edge,
  type Pack,
  type PackAttr,
  type PackComponent,
} from '../packs.ts';

// The svelte/compiler AST is untyped here; nodes are plain objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SNode = any;

/** `svelte` exports modules may import. */
const MODULE_SVELTE = ['tick', 'untrack', 'settled', 'setContext', 'getContext'];

/** Inline SVG elements (runic-ir's SVG_TAGS). */
const SVG_TAGS = ['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect'];

const TAGS = new Set([
  'a',
  'select',
  'option',
  'textarea',
  'label',
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'button',
  'input',
  'main',
  'article',
  'section',
  'header',
  'footer',
  'nav',
  'aside',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'small',
  'b',
  'i',
  'code',
  'pre',
  'br',
  'hr',
  ...SVG_TAGS,
]);
/** The exports of Svelte's modules that component scripts may import. */
const SVELTE_EXPORTS = {
  svelte: ['onMount', 'onDestroy', 'tick', 'untrack', 'mount', 'unmount', 'getAllContexts'],
  'svelte/events': ['on'],
};

/** HTML boolean attributes that Svelte sets as properties (present iff truthy). */
const BOOLEAN_ATTRS = new Set([
  'disabled',
  'readonly',
  'hidden',
  'required',
  'checked',
  'autofocus',
  'multiple',
  'open',
]);

interface Graph {
  root: string;
  /** A SvelteKit app (compiler/adapters/kit-app.mjs). */
  kit?: KitGraph;
  entry: string;
  hash: string;
  css: string;
  assets: { path: string; sha256: string; bytes: number; mime: string }[];
  manifest: unknown;
  config: { title: string; renderer?: 'cpu' | 'gpu' };
  modules: Map<
    string,
    { code: string; imports: Edge[]; package?: { name: string; version: string; dir: string } }
  >;
  tooling: {
    packages: Record<string, string>;
    compiler: { parse: (src: string, opts: object) => SNode };
  };
}

type Source = { file: string; line: number; column: number };

/** What the Svelte adapter uses of a SvelteKit app (compiler/adapters/kit-app.mjs). */
interface KitGraph {
  hash: boolean;
  generated: string;
  routeModules: Set<string>;
  routeComponents: Set<string>;
  typeFiles: Map<string, string>;
  resolveType: (specifier: string, from: string) => string | undefined;
}

/** Source location in the original file for an offset. */
function locate(text: string, offset: number, file: string): Source {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { file, line: lines.length, column: lines.at(-1)!.length + 1 };
}

/**
 * The component as svelte types it, the default export of its virtual module
 * (`ComponentProps<typeof Label>` in shadcn's Field.Label).
 */
const COMPONENT_EXPORT =
  'declare const __RunicComponent: import("svelte").Component<__RunicProps>;\nexport default __RunicComponent;\n';

/** A `.svelte` file and its virtual TypeScript module. */
interface Unit {
  file: string;
  rel: string;
  original: string;
  ast: SNode;
  index: number;
  virtual: string;
  synthetic: string;
  /** Instance script length and its offset in the original file. */
  scriptLength: number;
  scriptStart: number;
  /** `<script module>` length and offset in the original file (0, 0 without one). */
  moduleLength: number;
  moduleStart: number;
  /** Where the instance script starts in the virtual module (after the module script). */
  instanceSynth: number;
  /** End of the script statements in the virtual module (the script and synthesized code). */
  statementsEnd: number;
  /** Synthetic ranges copied from the original (scripts, template expressions, patterns). */
  segments: { synth: number; orig: number; length: number }[];
  /** Synthetic start of each template expression, each pattern and each index. */
  starts: Map<SNode, number>;
  /** Child components by tag name (`Button`, `Card.Root`). */
  children: Map<string, string>;
  /** Components supplied by mapping packs (expanded in place), by tag name. */
  packs: Map<string, { pack: Pack; component: PackComponent }>;
  /** Components the instance script mounts imperatively (`mount(Name, …)`, M6), by name. */
  mounted: Map<string, string>;
  /** Instantiated from the root component (lowered); other components only provide modules. */
  reached: boolean;
}

export async function lowerSvelte(graph: Graph): Promise<{ ir: Program }> {
  const { root } = graph;
  const fail = (code: string, message: string, source?: Source): never => {
    throw new Diagnostic(code, message, source);
  };
  const rel = (f: string) => displayPath(root, f.replace(/\.__runic\.ts$/, ''));
  /** A module of a package compiled from source (frontend/sources.ts). */
  const isPackageModule = (f: string) => !!graph.modules.get(f)?.package;

  // --- Bootstrap: mount(App, { target: document.getElementById('root') }) ---
  const entryCode = graph.modules.get(graph.entry)!.code;
  const entry = ts.createSourceFile(graph.entry, entryCode, ts.ScriptTarget.Latest, true);
  const at = (sf: ts.SourceFile, n: ts.Node) => {
    const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { file: rel(sf.fileName), line: p.line + 1, column: p.character + 1 };
  };
  let rootFile: string | undefined;
  let mountName: string | undefined;
  let bootstrap: ts.Expression | undefined;
  const componentNames = new Map<string, string>();
  for (const stmt of entry.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const edge = graph.modules.get(graph.entry)!.imports.find(i => i.specifier === spec);
      const clause = stmt.importClause;
      if (!clause) {
        if (!edge?.resolved.endsWith('.css'))
          fail('E_IMPORT', 'Only local CSS side effects are supported', at(entry, stmt));
        continue;
      }
      if (spec === 'svelte' && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const b of clause.namedBindings.elements) {
          if ((b.propertyName ?? b.name).text !== 'mount')
            fail('E_CAPABILITY', 'Entry supports Svelte mount only', at(entry, b));
          mountName = b.name.text;
        }
      } else if (edge?.resolved.endsWith('.svelte') && clause.name)
        componentNames.set(clause.name.text, edge.resolved);
      else
        fail(
          'E_IMPORT',
          'Entry requires a local default Svelte component and mount',
          at(entry, stmt),
        );
    } else if (ts.isExpressionStatement(stmt) && !bootstrap) bootstrap = stmt.expression;
    else
      fail(
        'E_BOOTSTRAP',
        'Svelte entry may only import its component/CSS and mount once',
        at(entry, stmt),
      );
  }
  if (
    bootstrap &&
    ts.isCallExpression(bootstrap) &&
    ts.isIdentifier(bootstrap.expression) &&
    bootstrap.expression.text === mountName
  ) {
    const [component] = bootstrap.arguments;
    if (component && ts.isIdentifier(component)) rootFile = componentNames.get(component.text);
  }
  if (!rootFile)
    fail(
      'E_BOOTSTRAP',
      'Expected mount(App, {target: document.getElementById("root")})',
      bootstrap ? at(entry, bootstrap) : undefined,
    );

  // --- Components: every collected component file is parsed. Those the
  // root instantiates (children first) are lowered; the others only provide
  // their `<script module>` exports (a barrel may import components the
  // program never renders).
  const units = new Map<string, Unit>();
  const order: Unit[] = [];
  /** Optional props bound to variables of the present type (`bind:` on components). */
  const presentWrites: { component: number; cell: number; name: string; at: Source }[] = [];
  /** `bind:` setters (function index) by the child component and prop cell they follow. */
  const bindSetters = new Map<number, { component: number; cell: number }>();
  const walkTemplate = (node: unknown, f: (n: SNode) => void, seen = new Set<unknown>()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const x of node) walkTemplate(x, f, seen);
      return;
    }
    const n = node as SNode;
    if (typeof n.type === 'string') f(n);
    for (const [k, v] of Object.entries(n)) if (k !== 'parent') walkTemplate(v, f, seen);
  };
  const unitOfFile = (file: string, from?: Source): Unit => {
    const known = units.get(file);
    if (known) return known;
    const original = graph.modules.get(file)?.code;
    if (original === undefined)
      return fail('E_IMPORT', `Component ${rel(file)} was not collected`, from);
    const fileRel = rel(file);
    let ast: SNode;
    try {
      ast = graph.tooling.compiler.parse(original, { filename: file, modern: true });
    } catch (e) {
      const err = e as { message: string; start?: { line: number; column: number } };
      throw new Diagnostic('E_PARSE', err.message, {
        file: fileRel,
        line: err.start?.line ?? 1,
        column: (err.start?.column ?? 0) + 1,
      });
    }
    const u: Unit = {
      file,
      rel: fileRel,
      original,
      ast,
      index: -1,
      virtual: file + '.__runic.ts',
      synthetic: '',
      scriptLength: ast.instance ? ast.instance.content.end - ast.instance.content.start : 0,
      scriptStart: ast.instance ? ast.instance.content.start : 0,
      moduleLength: ast.module ? ast.module.content.end - ast.module.content.start : 0,
      moduleStart: ast.module ? ast.module.content.start : 0,
      instanceSynth: 0,
      statementsEnd: 0,
      segments: [],
      starts: new Map(),
      children: new Map(),
      packs: new Map(),
      mounted: new Map(),
      reached: false,
    };
    units.set(file, u);
    return u;
  };
  /**
   * The top-level `beforeNavigate(f)` / `afterNavigate(f)` calls of a
   * component's instance script (imported from `$app/navigation`), as
   * offsets in the component file.
   */
  const navigationCalls = (u: Unit): { start: number; end: number }[] => {
    const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
    const sf = ts.createSourceFile(u.file + '.ts', script, ts.ScriptTarget.Latest, true);
    const names = new Set<string>();
    for (const stmt of sf.statements)
      if (
        ts.isImportDeclaration(stmt) &&
        (stmt.moduleSpecifier as ts.StringLiteral).text === '$app/navigation'
      ) {
        const named = stmt.importClause?.namedBindings;
        if (named && ts.isNamedImports(named))
          for (const el of named.elements)
            if (['beforeNavigate', 'afterNavigate'].includes((el.propertyName ?? el.name).text))
              names.add(el.name.text);
      }
    const out: { start: number; end: number }[] = [];
    for (const stmt of sf.statements)
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        ts.isIdentifier(stmt.expression.expression) &&
        names.has(stmt.expression.expression.text)
      )
        out.push({
          start: u.scriptStart + stmt.expression.getStart(sf),
          end: u.scriptStart + stmt.expression.end,
        });
    return out;
  };
  // Imports and re-exports, followed syntactically (frontend/modules.ts).
  const resolver = new ModuleResolver(graph, file => {
    if (!file.endsWith('.svelte') || !graph.modules.has(file)) return undefined;
    const u = unitOfFile(file);
    return [u.ast.module, u.ast.instance]
      .filter(Boolean)
      .map((s: SNode) =>
        ts.createSourceFile(
          file + '.ts',
          u.original.slice(s.content.start, s.content.end),
          ts.ScriptTarget.Latest,
          true,
        ),
      );
  });
  /** A reached component: its checks, and the components its template instantiates. */
  const reach = (u: Unit) => {
    const loc = (n: SNode) => locate(u.original, n.start ?? 0, u.rel);
    const { ast } = u;
    if (ast.css)
      fail(
        'E_TEMPLATE',
        'Component styles (scoped CSS) are planned for M6; import local CSS instead',
        loc(ast.css),
      );
    if (ast.options) fail('E_TEMPLATE', '<svelte:options> is unsupported', loc(ast.options));
    // `<Name>` and `<Namespace.Name>` tags, through imports, barrels and
    // namespace imports; default imports of a package are pack components.
    walkTemplate(ast.fragment, n => {
      if (n.type !== 'Component' || u.children.has(n.name) || u.packs.has(n.name)) return;
      const ref = resolver.dotted(u.file, n.name);
      if (ref?.kind === 'component') u.children.set(n.name, ref.file);
      else if (ref?.kind === 'package' && ref.edge.package) {
        try {
          const { pack, value } = packExport(ref.edge.package, ref.name);
          if (value.kind !== 'component')
            fail('E_TEMPLATE', `${n.name} is not a component`, loc(n));
          u.packs.set(n.name, { pack, component: value as PackComponent });
        } catch (e) {
          if (e instanceof PackError) fail(e.code, e.message, loc(n));
          throw e;
        }
      } else {
        // `<Namespace.Name>` of a package that is neither packed nor compiled
        // from source (at this version): the package's own diagnostic.
        const head = n.name.includes('.')
          ? resolver.dotted(u.file, n.name.slice(0, n.name.indexOf('.')))
          : undefined;
        if (head?.kind === 'package' && head.edge.package)
          try {
            packFor(head.edge.package);
          } catch (e) {
            if (e instanceof PackError) fail(e.code, e.message, loc(n));
            throw e;
          }
        fail('E_TEMPLATE', `${n.name} is not an imported component`, loc(n));
      }
    });
    // Components the instance script mounts imperatively (svelte's
    // `mount(Name, …)`, M6 overlays): lowered before this one.
    const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
    if (/\bmount\b/.test(script)) {
      const sf = ts.createSourceFile(u.file + '.ts', script, ts.ScriptTarget.Latest, true);
      const names = new Set<string>();
      for (const stmt of sf.statements) {
        const named = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined;
        if (
          named &&
          ts.isNamedImports(named) &&
          ((stmt as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text === 'svelte'
        )
          for (const el of named.elements)
            if ((el.propertyName ?? el.name).text === 'mount') names.add(el.name.text);
      }
      const visitScript = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          names.has(n.expression.text)
        ) {
          const [component] = n.arguments;
          const at = locate(u.original, u.scriptStart + n.getStart(sf), u.rel);
          if (!component || !ts.isIdentifier(component))
            fail('E_MOUNT', 'mount takes an imported component (mount(Name, { target, … }))', at);
          const ref = resolver.dotted(u.file, (component as ts.Identifier).text);
          if (ref?.kind !== 'component')
            fail(
              'E_MOUNT',
              `${(component as ts.Identifier).text} is not an imported component`,
              at,
            );
          u.mounted.set((component as ts.Identifier).text, (ref as { file: string }).file);
        }
        ts.forEachChild(n, visitScript);
      };
      visitScript(sf);
    }
  };
  const visit = (file: string, stack: string[], from?: Source) => {
    if (stack.includes(file))
      fail('E_COMPONENT', 'Recursive components are planned for a later milestone', from);
    const u = unitOfFile(file, from);
    if (u.reached) return;
    u.reached = true;
    reach(u);
    for (const [tag, child] of u.children) {
      const n = u.ast.fragment && findComponent(u.ast.fragment, tag);
      visit(child, [...stack, file], n ? locate(u.original, n.start, u.rel) : undefined);
    }
    for (const child of u.mounted.values()) visit(child, [...stack, file]);
    u.index = order.length;
    order.push(u);
  };
  const findComponent = (fragment: SNode, tag: string): SNode | undefined => {
    let found: SNode | undefined;
    walkTemplate(fragment, n => {
      if (!found && n.type === 'Component' && n.name === tag) found = n;
    });
    return found;
  };
  visit(rootFile!, []);
  for (const id of graph.modules.keys())
    if (id.endsWith('.svelte') && id.startsWith(root + path.sep)) unitOfFile(id);

  // Rest props (docs/design/M5-PLATFORM.md): each component's declared prop
  // names and rest binding, and the names its rest bag may hold, gathered
  // from every call site and through forwarding (`<Child {...rest} />`).
  const decls = new Map<string, { declared: Set<string>; rest?: string }>();
  for (const u of order) {
    const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
    const sf = ts.createSourceFile(u.file + '.ts', script, ts.ScriptTarget.Latest, true);
    const d: { declared: Set<string>; rest?: string } = { declared: new Set() };
    for (const stmt of sf.statements)
      if (ts.isVariableStatement(stmt))
        for (const v of stmt.declarationList.declarations) {
          const init = v.initializer;
          if (
            !init ||
            !ts.isCallExpression(init) ||
            !ts.isIdentifier(init.expression) ||
            init.expression.text !== '$props' ||
            !ts.isObjectBindingPattern(v.name)
          )
            continue;
          for (const el of v.name.elements) {
            if (el.dotDotDotToken && ts.isIdentifier(el.name)) d.rest = el.name.text;
            else if (!el.dotDotDotToken)
              d.declared.add(
                ((el.propertyName ?? el.name) as ts.Identifier).text ?? el.name.getText(sf),
              );
          }
        }
    decls.set(u.file, d);
  }
  // Snippets a component receives through its rest props: content or
  // `{#snippet}` blocks a site passes to a component that does not declare
  // them (shadcn-svelte's wrappers pass bits-ui's `children` and `child` on
  // with `{...restProps}`), also through spreads of rest props onto
  // components that do not declare them either. They are slots of the
  // component, forwarded where its rest props are spread onto a component.
  const restSlots = new Map<string, Set<string>>();
  for (const [file, d] of decls) if (d.rest) restSlots.set(file, new Set());
  /** The snippets a site passes (`children` for content). */
  const snippetsPassed = (n: SNode): string[] => {
    const out: string[] = n.fragment.nodes
      .filter((c: SNode) => c.type === 'SnippetBlock')
      .map((c: SNode) => c.expression.name);
    if (
      n.fragment.nodes.some(
        (c: SNode) => c.type !== 'SnippetBlock' && !(c.type === 'Text' && !c.data.trim()),
      )
    )
      out.push('children');
    return out;
  };
  /** Whether attribute `a` spreads the rest props of the component `file`. */
  const spreadsRest = (file: string, a: SNode) =>
    a.type === 'SpreadAttribute' &&
    a.expression.type === 'Identifier' &&
    a.expression.name === decls.get(file)?.rest;
  const slotForwards: { from: string; to: string }[] = [];
  for (const u of order)
    walkTemplate(u.ast.fragment, n => {
      if (n.type !== 'Component') return;
      const to = u.children.get(n.name);
      if (!to) return;
      for (const s of snippetsPassed(n))
        if (!decls.get(to)!.declared.has(s)) restSlots.get(to)?.add(s);
      if (n.attributes.some((a: SNode) => spreadsRest(u.file, a)))
        slotForwards.push({ from: u.file, to });
    });
  for (let changed = true; changed;) {
    changed = false;
    for (const { from, to } of slotForwards)
      for (const s of restSlots.get(from) ?? [])
        if (!decls.get(to)!.declared.has(s) && restSlots.get(to) && !restSlots.get(to)!.has(s)) {
          restSlots.get(to)!.add(s);
          changed = true;
        }
  }

  // The props type each component exports to its parents' virtual modules.
  /** The local name of a child's props type in a virtual module (`Card.Root` → `__RunicProps_Card$Root`). */
  const propsAlias = (tag: string) => `__RunicProps_${tag.replace(/\./g, '$')}`;
  const propsType = (u: Unit): string => {
    const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
    const sf = ts.createSourceFile(u.file + '.ts', script, ts.ScriptTarget.Latest, true);
    for (const stmt of sf.statements)
      if (ts.isVariableStatement(stmt))
        for (const d of stmt.declarationList.declarations) {
          const init = d.initializer;
          if (
            init &&
            ts.isCallExpression(init) &&
            ts.isIdentifier(init.expression) &&
            init.expression.text === '$props'
          )
            return d.type
              ? script.slice(d.type.getStart(sf), d.type.end)
              : init.typeArguments?.[0]
                ? script.slice(init.typeArguments[0].getStart(sf), init.typeArguments[0].end)
                : 'Record<string, never>';
        }
    return 'Record<string, never>';
  };

  /** Parameters of snippets passed to components, by their start in a virtual module. */
  const snippetParams: {
    virtual: string;
    start: number;
    unit: Unit;
    node: SNode;
    name: string;
    index: number;
  }[] = [];
  // Virtual modules: the module script, the instance script, then the
  // template as typed statements. Components that are not reached only
  // provide their scripts' declarations and types.
  for (const u of units.values()) {
    let s = '';
    const copy = (start: number, end: number) => {
      u.segments.push({ synth: s.length, orig: start, length: end - start });
      s += u.original.slice(start, end);
    };
    copy(u.moduleStart, u.moduleStart + u.moduleLength);
    s += '\n';
    u.instanceSynth = s.length;
    {
      // SvelteKit's beforeNavigate/afterNavigate register their callback
      // when the component mounts (add_navigation_callback: onMount, which
      // is an untracked effect): a top-level `beforeNavigate(f)` becomes
      // `$effect(() => untrack(() => beforeNavigate(f)))`, whose result
      // removes the callback on destroy.
      const calls = graph.kit ? navigationCalls(u) : [];
      let at = u.scriptStart;
      for (const c of calls) {
        copy(at, c.start);
        s += '$effect(() => __runic_untrack(() => ';
        copy(c.start, c.end);
        s += '))';
        at = c.end;
      }
      copy(at, u.scriptStart + u.scriptLength);
      if (calls.length) s += "\nimport { untrack as __runic_untrack } from 'svelte';";
    }
    s += '\n';
    if (!u.reached) {
      u.statementsEnd = s.length;
      s += `export type __RunicProps = ${propsType(u)};\n`;
      s += COMPONENT_EXPORT;
      u.synthetic = s;
      continue;
    }
    // <svelte:window> and <svelte:document> listeners: added when the
    // component mounts and removed when it unmounts, as script code would.
    let hosts = 0;
    for (const n of u.ast.fragment.nodes) {
      if (n.type !== 'SvelteWindow' && n.type !== 'SvelteDocument') continue;
      const target = n.type === 'SvelteWindow' ? 'window' : 'document';
      for (const a of n.attributes) {
        if (
          a.type !== 'Attribute' ||
          !/^on[a-z]+$/.test(a.name) ||
          a.value === true ||
          Array.isArray(a.value)
        )
          fail(
            'E_TEMPLATE',
            `<svelte:${target}> supports event attributes with a handler expression`,
            locate(u.original, a.start, u.rel),
          );
        if (
          graph.kit &&
          ((target === 'document' && a.name === 'onclick') ||
            (target === 'window' && ['onpopstate', 'onhashchange'].includes(a.name)))
        )
          fail(
            'E_KIT_LISTENER',
            `<svelte:${target} ${a.name}> is unsupported in a SvelteKit app (the router owns these listeners)`,
            locate(u.original, a.start, u.rel),
          );
        const event = JSON.stringify(a.name.slice(2));
        const name = `__runic_${target}_${hosts++}`;
        s += `const ${name} = (`;
        copy(a.value.expression.start, a.value.expression.end);
        const map = target === 'window' ? 'WindowEventMap' : 'HostEventMap';
        s += `) satisfies (event: ${map}[${event}]) => void;\n$effect.pre(() => { ${target}.addEventListener(${event}, ${name}); return () => ${target}.removeEventListener(${event}, ${name}); });\n`;
      }
    }
    // <svelte:head>: a <title> sets document.title in an effect created
    // with the template (Svelte's deferred_template_effect), its parts as
    // Svelte renders text. Other head elements have no native meaning yet.
    for (const n of u.ast.fragment.nodes) {
      if (n.type !== 'SvelteHead') continue;
      for (const c of n.fragment.nodes) {
        if (c.type === 'Comment' || (c.type === 'Text' && !c.data.trim())) continue;
        if (c.type !== 'TitleElement' || c.attributes.length)
          fail(
            'E_TEMPLATE',
            '<svelte:head> supports <title> (other head elements have no native meaning yet)',
            locate(u.original, c.start, u.rel),
          );
        s += '$effect(() => {\n  document.title = `';
        for (const part of c.fragment.nodes) {
          if (part.type === 'Text') s += part.data.replace(/[`\\$]/g, (ch: string) => '\\' + ch);
          else if (part.type === 'ExpressionTag') {
            s += '$' + '{__runic.text(';
            copy(part.expression.start, part.expression.end);
            s += ')}';
          } else
            fail(
              'E_TEMPLATE',
              'A <title> holds text and expressions',
              locate(u.original, part.start, u.rel),
            );
        }
        s += '`;\n});\n';
      }
    }
    u.statementsEnd = s.length;
    s += 'function __runic_template() {\n';
    const inline = (e: SNode) => {
      s += '(';
      u.starts.set(e, s.length);
      copy(e.start, e.end);
      s += ')';
    };
    const expr = (e: SNode) => {
      inline(e);
      s += ';\n';
    };
    const attrs = (list: SNode[]) => {
      for (const a of list)
        if (a.type === 'Attribute' && a.value !== true) {
          for (const v of Array.isArray(a.value) ? a.value : [a.value])
            if (v.type === 'ExpressionTag') expr(v.expression);
        } else if (
          a.type === 'BindDirective' ||
          a.type === 'SpreadAttribute' ||
          a.type === 'ClassDirective'
        )
          expr(a.expression);
        else if (a.type === 'StyleDirective' && a.value !== true)
          for (const v of Array.isArray(a.value) ? a.value : [a.value])
            if (v.type === 'ExpressionTag') expr(v.expression);
    };
    const fragment = (f: SNode) => {
      for (const n of f?.nodes ?? []) {
        if (n.type === 'ExpressionTag') expr(n.expression);
        else if (n.type === 'IfBlock') {
          expr(n.test);
          fragment(n.consequent);
          fragment(n.alternate);
        } else if (n.type === 'EachBlock') {
          s += 'for (const ';
          u.starts.set(n.context, s.length);
          copy(n.context.start, n.context.end);
          s += ' of ';
          inline(n.expression);
          s += ') {\n';
          if (n.index) {
            s += 'const ';
            // Keyed by the body fragment, which survives the copies made by `clean`.
            u.starts.set(n.body, s.length);
            s += `${n.index}: number = 0;\n`;
          }
          if (n.key) expr(n.key);
          fragment(n.body);
          s += '}\n';
          fragment(n.fallback);
        } else if (n.type === 'Component' && u.packs.has(n.name)) {
          // A pack component: its attribute expressions, typed in place.
          attrs(n.attributes);
          fragment(n.fragment);
        } else if (n.type === 'Component') {
          if (!u.children.has(n.name))
            fail(
              'E_TEMPLATE',
              `${n.name} is not an imported component`,
              locate(u.original, n.start, u.rel),
            );
          // Props are checked against the child's props type (typing inline callbacks).
          s += `((__p: ${propsAlias(n.name)}) => 0)({\n`;
          const childDecl = decls.get(u.children.get(n.name)!)!;
          for (const a of n.attributes) {
            if (a.type === 'Attribute' && a.value !== true && !Array.isArray(a.value)) {
              s += `${JSON.stringify(a.name)}: `;
              inline(a.value.expression);
              // A listener in the rest props is typed by its event.
              const kind = /^on([a-z]+)$/.exec(a.name)?.[1];
              if (kind && childDecl.rest && !childDecl.declared.has(a.name))
                s += ` satisfies (event: RunicEventMap[${JSON.stringify(kind)}]) => unknown`;
              s += ',\n';
            } else if (a.type === 'SpreadAttribute') {
              s += '...';
              inline(a.expression);
              s += ',\n';
            } else if (a.type === 'BindDirective') {
              s += `${JSON.stringify(a.name)}: `;
              inline(a.expression);
              s += ',\n';
            }
          }
          // Snippets and children are functions of the props object, so
          // TypeScript types their parameters from the child's Snippet props.
          const snippets = n.fragment.nodes.filter((c: SNode) => c.type === 'SnippetBlock');
          const content = n.fragment.nodes.filter(
            (c: SNode) => c.type !== 'SnippetBlock' && !(c.type === 'Text' && !c.data.trim()),
          );
          for (const sn of snippets) {
            s += `${JSON.stringify(sn.expression.name)}: (`;
            if (sn.parameters.length) {
              const first = sn.parameters[0].start;
              const base = s.length;
              copy(first, sn.parameters.at(-1).end);
              sn.parameters.forEach((param: SNode, index: number) => {
                const start = base + (param.start - first);
                u.starts.set(param, start);
                snippetParams.push({
                  virtual: u.virtual,
                  start,
                  unit: u,
                  node: n,
                  name: sn.expression.name,
                  index,
                });
              });
            }
            s += ') => {\n';
            fragment(sn.body);
            s += '},\n';
          }
          if (content.length) {
            s += '"children": () => {\n';
            fragment({ nodes: content });
            s += '},\n';
          }
          s += '});\n';
          for (const a of n.attributes)
            if (a.type === 'Attribute' && Array.isArray(a.value))
              for (const v of a.value) if (v.type === 'ExpressionTag') expr(v.expression);
        } else if (n.type === 'RenderTag') expr(n.expression);
        else if (n.type === 'KeyBlock') {
          expr(n.expression);
          fragment(n.fragment);
        } else if (n.type === 'SnippetBlock')
          fail(
            'E_TEMPLATE',
            'Snippets are supported as children of a component tag',
            locate(u.original, n.start, u.rel),
          );
        else if (n.type === 'RegularElement') {
          attrs(n.attributes);
          fragment(n.fragment);
        } else if (n.type === 'SvelteElement') {
          expr(n.tag);
          attrs(n.attributes);
          fragment(n.fragment);
        }
      }
    };
    fragment(u.ast.fragment);
    s += '}\n';
    for (const [name, file] of u.children)
      s += `import type { __RunicProps as ${propsAlias(name)} } from ${JSON.stringify(units.get(file)!.virtual)};\n`;
    s += `export type __RunicProps = ${propsType(u)};\n`;
    s += COMPONENT_EXPORT;
    u.synthetic = s;
  }
  // Modules of packages compiled from source that the program reaches
  // (frontend/package-modules.ts): typed virtual modules of their JavaScript.
  const packageModules = new Map<string, PackageModule>();
  {
    const roots = [...units.keys()];
    for (const id of graph.modules.keys())
      if (/\.(ts|js|mjs)$/.test(id) && id.startsWith(root + path.sep) && !isPackageModule(id))
        roots.push(id);
    for (const f of reachedPackageModules(resolver, roots, isPackageModule))
      packageModules.set(f, annotate(f, graph.modules.get(f)!.code));
  }
  const buildProgram = () => {
    const files = new Map<string, string>();
    for (const u of units.values()) files.set(u.virtual, u.synthetic);
    for (const [id, m] of graph.modules)
      if (/\.(ts|js|mjs)$/.test(id) && id.startsWith(root + path.sep) && !isPackageModule(id))
        files.set(id, m.code);
    for (const m of packageModules.values()) {
      files.set(m.virtual, m.text);
      if (m.dts) files.set(m.dts, exportAllDeclarations(m.dts));
    }
    // A SvelteKit app's generated modules that are imported for types only.
    for (const [f, code] of graph.kit?.typeFiles ?? []) if (!files.has(f)) files.set(f, code);
    // Imports resolve as the collector resolved them (aliases included); a
    // component file stands for its virtual module, a reached package module
    // for its typed virtual module. Other package modules (barrels, packs)
    // are read by TypeScript from their declaration files.
    return createProgram(files, [RUNES], (specifier, containing) => {
      if (specifier.startsWith(DTS_PREFIX)) return specifier.slice(DTS_PREFIX.length);
      // A package's declaration files name the modules the program reaches
      // by their typed virtual modules (one class, one constant, everywhere).
      if (/\.d\.m?ts$/.test(containing) && specifier.startsWith('.')) {
        const js = path.resolve(path.dirname(containing), specifier);
        const reached = packageModules.get(js);
        if (reached) return reached.virtual;
        return undefined;
      }
      const from = containing.endsWith('.__runic.ts')
        ? containing.slice(0, -'.__runic.ts'.length)
        : containing;
      const edge = graph.modules.get(from)?.imports.find(i => i.specifier === specifier);
      if (!edge) return graph.kit?.resolveType(specifier, from);
      // Modules of packages, also uncollected ones (imported for types only).
      const source = isPackageModule(edge.resolved) || /[\\/]node_modules[\\/]/.test(edge.resolved);
      if (edge.package && !source) return undefined;
      const target =
        units.get(edge.resolved)?.virtual ??
        packageModules.get(edge.resolved)?.virtual ??
        (source ? undefined : edge.resolved);
      if (target === undefined) return undefined;
      // A module only imported for its types is not collected; TypeScript reads it.
      return files.has(target) || (/\.(ts|js|mjs)$/.test(target) && existsSync(target))
        ? target
        : undefined;
    });
  };
  let program = buildProgram();
  // Class fields of package modules typed from what the classes assign.
  if (inferFields(packageModules, program).length) program = buildProgram();
  const unitOf = new Map<ts.SourceFile, Unit>();
  for (const u of units.values()) unitOf.set(program.getSourceFile(u.virtual)!, u);
  const packageOf = new Map<ts.SourceFile, PackageModule>();
  for (const m of packageModules.values()) packageOf.set(program.getSourceFile(m.virtual)!, m);
  const sourceAt = (u: Unit, pos: number): Source => {
    const seg = u.segments.find(s => pos >= s.synth && pos <= s.synth + s.length);
    return seg
      ? locate(u.original, seg.orig + (pos - seg.synth), u.rel)
      : { file: u.rel, line: 1, column: 1 };
  };
  const sourceOf = (n: ts.Node): Source => {
    const f = n.getSourceFile();
    const u = unitOf.get(f);
    if (!u) {
      const m = packageOf.get(f);
      if (m) {
        const pos = n.getStart(f);
        const seg = m.segments.find(s => pos >= s.synth && pos <= s.synth + s.length);
        const code = graph.modules.get(m.file)!.code;
        return seg
          ? locate(code, seg.orig + (pos - seg.synth), rel(m.file))
          : { file: rel(m.file), line: 1, column: 1 };
      }
      const p = f.getLineAndCharacterOfPosition(n.getStart(f));
      return { file: rel(f.fileName), line: p.line + 1, column: p.character + 1 };
    }
    return sourceAt(u, n.getStart(f));
  };
  /** The TS node of a template expression (or each pattern) by its synthetic span. */
  const nodeIn = (u: Unit, n: SNode, length = n.end - n.start): ts.Node => {
    const sf = program.getSourceFile(u.virtual)!;
    const where = locate(u.original, n.start ?? 0, u.rel);
    const start = u.starts.get(n);
    if (start === undefined) return fail('E_INTERNAL', 'Template expression not mapped', where);
    let found: ts.Node | undefined;
    const walk = (x: ts.Node) => {
      if (found) return;
      if (x.getStart(sf) === start && x.end === start + length) {
        found = x;
        return;
      }
      if (x.getStart(sf) <= start && x.end >= start + length) ts.forEachChild(x, walk);
    };
    walk(sf);
    return found ?? fail('E_INTERNAL', 'Template expression not found', where);
  };
  for (const u of units.values()) {
    const sf = program.getSourceFile(u.virtual)!;
    const syntax = program.getSyntacticDiagnostics(sf);
    if (syntax.length) {
      const d = syntax[0];
      fail(
        'E_PARSE',
        ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        d.start !== undefined ? sourceAt(u, d.start) : undefined,
      );
    }
  }
  for (const m of packageModules.values()) {
    const d = program.getSyntacticDiagnostics(program.getSourceFile(m.virtual)!)[0];
    if (d)
      fail(
        'E_INTERNAL',
        `The typed module of ${rel(m.file)} does not parse: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
      );
  }
  const tsFail = (n: ts.Node, code: string, message: string): never =>
    fail(code, message, sourceOf(n));
  const checker = program.getTypeChecker();
  // SvelteKit: `error()` and `redirect()` throw values only the router reads
  // (frontend/adapters/kit/kit.ts), so code that may catch them (a `catch`
  // in a route module, or in a module or component that imports
  // @sveltejs/kit, directly or through other modules) is rejected.
  if (graph.kit) {
    const kitModule = path.join(graph.kit.generated, 'kit.ts');
    const reaching = new Set<string>([kitModule]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, m] of graph.modules)
        if (
          !reaching.has(id) &&
          !id.startsWith(graph.kit.generated + path.sep) &&
          m.imports.some(i => !i.typeOnly && reaching.has(i.resolved))
        ) {
          reaching.add(id);
          changed = true;
        }
    }
    for (const id of [...reaching, ...graph.kit.routeModules]) {
      if (id === kitModule) continue;
      const sf = program.getSourceFile(units.get(id)?.virtual ?? id);
      if (!sf) continue;
      const visit = (n: ts.Node) => {
        if (ts.isCatchClause(n))
          tsFail(
            n,
            'E_KIT_CATCH',
            "A catch clause where SvelteKit's error() or redirect() may be thrown is unsupported (their errors are the router's)",
          );
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  const types = new TypeMapper(checker, tsFail);

  // --- Lowering state (one component at a time) ---
  let cells: Cell[] = [];
  /** The name a binding imported from 'svelte' has there (`undefined` for other bindings). */
  const svelteImport = (id: ts.Identifier, module = 'svelte'): string | undefined => {
    const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
    if (!decl || !ts.isImportSpecifier(decl)) return undefined;
    const from = decl.parent.parent.parent.moduleSpecifier;
    return ts.isStringLiteral(from) && from.text === module
      ? (decl.propertyName ?? decl.name).text
      : undefined;
  };
  /** Whether runes are compiled in the file of `n` (components and `.svelte.js` modules). */
  /**
   * The component being lowered (M6 overlays): its mount sites, and its
   * snippet props, which `mount(…, { props: { children } })` forwards.
   */
  let mounting:
    | {
        u: Unit;
        index: number;
        sites: MountSite[];
        snippetOf: Map<ts.Symbol, string>;
        slots: { name: string; params?: Type[] }[];
      }
    | undefined;
  const runeFile = (n: ts.Node) =>
    /\.svelte(\.__runic\.ts|\.ts|\.js|\.js\.__runic\.ts)$/.test(n.getSourceFile().fileName);
  const hooks: Hooks = {
    readCell: cell => ({ op: 'cell', cell, read: 'current' }),
    cellType: cell => cells[cell].type,
    writeCell: (cell, value) => [{ op: 'set', cell, value }],
    call(node, ctx, lower) {
      // In a SvelteKit app the router owns these listeners: Kit's click
      // listener on <html> runs before the document's (the native runtime has
      // document listeners only), and its focus reset navigates to fragments,
      // firing popstate and hashchange that only the router ignores.
      if (
        graph.kit &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'addEventListener' &&
        ts.isIdentifier(node.expression.expression) &&
        ['window', 'document'].includes(node.expression.expression.text) &&
        !node.getSourceFile().fileName.startsWith(graph.kit.generated + path.sep)
      ) {
        const [kind] = node.arguments;
        const target = node.expression.expression.text;
        if (
          kind &&
          ts.isStringLiteralLike(kind) &&
          ((target === 'document' && kind.text === 'click') ||
            (target === 'window' && ['popstate', 'hashchange'].includes(kind.text)))
        )
          return tsFail(
            node,
            'E_KIT_LISTENER',
            `${target} ${kind.text} listeners are unsupported in a SvelteKit app (the router owns them)`,
          );
      }
      // SvelteKit's beforeNavigate/afterNavigate: only as a component
      // script's top-level statement (lowered to a mount-time registration).
      if (graph.kit && ts.isIdentifier(node.expression)) {
        const decl = checker.getSymbolAtLocation(node.expression)?.declarations?.[0];
        const target =
          decl && ts.isImportSpecifier(decl)
            ? checker.getAliasedSymbol(checker.getSymbolAtLocation(node.expression)!)
            : undefined;
        const file = target?.declarations?.[0]?.getSourceFile().fileName ?? '';
        if (
          file === path.join(graph.kit.generated, 'navigation.ts') &&
          ['beforeNavigate', 'afterNavigate'].includes(target!.name)
        ) {
          const arrow = node.parent;
          const wrapper = arrow?.parent;
          const lowered =
            ts.isArrowFunction(arrow) &&
            !!wrapper &&
            ts.isCallExpression(wrapper) &&
            ts.isIdentifier(wrapper.expression) &&
            wrapper.expression.text === '__runic_untrack';
          if (!lowered)
            return tsFail(
              node,
              'E_KIT_LIFECYCLE',
              `${target!.name} registers a callback for the component calling it: call it as a statement at the top level of a component script`,
            );
        }
      }
      // settled(): fulfilled when the pending flush ends (Svelte's batch commits).
      if (ts.isIdentifier(node.expression) && svelteImport(node.expression) === 'settled') {
        if (node.arguments.length) return tsFail(node, 'E_CALL', 'settled takes no arguments');
        return { op: 'builtin', name: 'flush.after', args: [], type: { promise: 'void' } };
      }
      // tick(): a microtask that runs any pending flush, then fulfils.
      if (ts.isIdentifier(node.expression) && svelteImport(node.expression) === 'tick') {
        if (node.arguments.length) return tsFail(node, 'E_CALL', 'tick takes no arguments');
        return { op: 'builtin', name: 'flush.tick', args: [], type: { promise: 'void' } };
      }
      // untrack(fn): fn's result, its reads not tracked by the running effect or derived value.
      if (ts.isIdentifier(node.expression) && svelteImport(node.expression) === 'untrack') {
        const [fn] = node.arguments;
        const f = fn && lower.expr(fn, ctx);
        const t = f && lower.irType(f, ctx);
        if (
          !f ||
          node.arguments.length !== 1 ||
          typeof t !== 'object' ||
          !('fn' in t) ||
          t.fn.params.length
        )
          return tsFail(node, 'E_CALL', 'untrack takes a function without parameters');
        return { op: 'builtin', name: 'reactive.untrack-call', args: [f], type: t.fn.result };
      }
      // Imperative mounts (M6 overlays): mount, unmount and getAllContexts.
      if (ts.isIdentifier(node.expression)) {
        const imported = svelteImport(node.expression);
        if (imported === 'mount') return mountCall(node, ctx, lower);
        if (imported === 'unmount') return unmountCall(node, ctx, lower);
        if (imported === 'getAllContexts') {
          if (node.arguments.length)
            return tsFail(node, 'E_CALL', 'getAllContexts takes no arguments');
          return { op: 'builtin', name: 'context.all', args: [], type: 'contexts' };
        }
      }
      // on(element, type, handler) from svelte/events: an element listener and its remover.
      if (
        ts.isIdentifier(node.expression) &&
        svelteImport(node.expression, 'svelte/events') === 'on'
      )
        return svelteOn(node, ctx, lower);
      // $effect and $effect.pre outside a component's top level (class
      // constructors, functions run while an instance is created): effects of
      // that instance (docs/IR.md, `effect.pre`/`effect.post`).
      const rune = runeName(node);
      if ((rune === '$effect' || rune === '$effect.pre') && runeFile(node)) {
        const [fn] = node.arguments;
        if (
          !fn ||
          node.arguments.length !== 1 ||
          !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
          fn.parameters.length
        )
          return tsFail(
            node,
            'E_EFFECT',
            `${rune} takes one synchronous function without parameters`,
          );
        const f = lower.expr(fn, ctx);
        const t = lower.irType(f, ctx) as { fn: { params: Type[]; result: Type } };
        const r = t.fn.result;
        const cleanup = (x: Type) =>
          typeof x === 'object' && 'fn' in x && !x.fn.params.length && x.fn.result === 'void';
        if (
          r !== 'void' &&
          !cleanup(r) &&
          !(typeof r === 'object' && 'maybe' in r && cleanup(r.maybe))
        )
          tsFail(fn, 'E_EFFECT', `${rune} functions return nothing or a cleanup function`);
        return {
          op: 'builtin',
          name: rune === '$effect' ? 'effect.post' : 'effect.pre',
          args: [f],
          type: 'void',
        };
      }
      // $props.id(): an id unique in the program (`c1`, `c2`, … in creation order).
      if (rune === '$props.id') {
        if (node.arguments.length) tsFail(node, 'E_RUNE', '$props.id takes no arguments');
        return {
          op: 'builtin',
          name: 'uid.next',
          args: [{ op: 'lit', value: 'c' }],
          type: 'string',
        };
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text.startsWith('$') &&
        !lower.binding(node.expression)
      )
        return tsFail(
          node,
          'E_RUNE',
          `${node.expression.text} is only supported in component declarations`,
        );
      return undefined;
    },
  };
  /**
   * `on(element, type, handler)` (svelte/events): adds the listener and
   * returns its remover. Covered for `beforematch` only, which the native
   * runtime never fires (Chromium fires it for find-in-page and for
   * fragment navigations into `hidden="until-found"` content, neither of
   * which the runtime has: element fragments are rejected, `until-found` is
   * reported when a spread sets it).
   */
  const svelteOn = (node: ts.CallExpression, b: FnBuilder, l: Lowerer): Expr => {
    const [el, type, handler, options] = node.arguments;
    if (!el || !type || !handler || options || !ts.isStringLiteralLike(type))
      return tsFail(node, 'E_EVENT', 'on(element, "event", handler) takes a literal event name');
    if (type.text !== 'beforematch')
      return tsFail(
        type,
        'E_EVENT',
        `Element listeners added with on() are supported for beforematch (never fired natively: there is no find-in-page), not ${type.text}`,
      );
    const e = l.expr(el, b);
    if (l.irType(e, b) !== 'element') return tsFail(el, 'E_EVENT', 'on() takes an element');
    const f = l.expr(handler, b);
    const ft = l.irType(f, b);
    if (
      typeof ft !== 'object' ||
      !('fn' in ft) ||
      !(ft.fn.params.length === 0 || (ft.fn.params.length === 1 && ft.fn.params[0] === 'event'))
    )
      return tsFail(handler, 'E_EVENT', 'on() takes a listener taking the event or nothing');
    const args = (): Expr[] => [
      { op: 'local', local: 0 },
      { op: 'lit', value: type.text },
      { op: 'local', local: 1 },
    ];
    const remove = l.reserve();
    l.functions[remove] = {
      name: 'on$remove',
      captures: [
        { name: 'element', type: 'element' },
        { name: 'handler', type: ft },
      ],
      params: [],
      locals: [],
      result: 'void',
      body: [
        {
          op: 'expr',
          value: { op: 'builtin', name: 'element.unlisten', args: args(), type: 'void' },
        },
      ],
    };
    const add = l.reserve();
    l.functions[add] = {
      name: 'on',
      params: [
        { name: 'element', type: 'element' },
        { name: 'handler', type: ft },
      ],
      locals: [],
      result: { fn: { params: [], result: 'void' } },
      body: [
        {
          op: 'expr',
          value: { op: 'builtin', name: 'element.listen', args: args(), type: 'void' },
        },
        { op: 'return', value: { op: 'closure', function: remove, captures: [0, 1] } },
      ],
    };
    return { op: 'call', function: add, args: [e, f] };
  };
  /**
   * `mount(Component, { target, props, context })` (svelte, M6 overlays): an
   * imperative instance of an imported component, mounted as the last child
   * of `target` from a function of the component being lowered. Props are
   * values for the component's props, or snippet props of this component
   * forwarded to its snippets (they keep this component's scope); `context`
   * is a context map (`getAllContexts()`).
   */
  const mountCall = (node: ts.CallExpression, b: FnBuilder, l: Lowerer): Expr => {
    const m = mounting;
    if (!m || b.component !== m.index)
      return tsFail(node, 'E_MOUNT', 'mount is supported in the functions of a component script');
    const [componentArg, options, ...rest] = node.arguments;
    if (!componentArg || !ts.isIdentifier(componentArg) || !options || rest.length)
      return tsFail(node, 'E_MOUNT', 'mount takes an imported component and an options object');
    const file = m.u.mounted.get(componentArg.text);
    if (!file)
      return tsFail(componentArg, 'E_MOUNT', `${componentArg.text} is not an imported component`);
    const childIndex = units.get(file)!.index;
    const child = components[childIndex];
    const o = skipParens(options);
    if (!ts.isObjectLiteralExpression(o))
      return tsFail(options, 'E_MOUNT', 'mount options are an object literal');
    let target: Expr | undefined;
    let context: Expr | undefined;
    const props: { name: string; value: Expr }[] = [];
    const slots: SlotDef[] = [];
    /** The value of an option or prop (a shorthand reads the variable it names). */
    const valueOf = (p: { value: ts.Expression; at: ts.Node }): Expr => {
      if (!ts.isShorthandPropertyAssignment(p.at)) return l.expr(p.value, b);
      const sym = checker.getShorthandAssignmentValueSymbol(p.at);
      const binding = sym && l.bindingOf(sym);
      if (!binding)
        return tsFail(p.at, 'E_UNRESOLVED', `${p.at.name.text} is not a supported binding`);
      return l.bindingExpr(
        binding,
        p.at.name,
        b,
        binding.kind === 'cell' ? l.hooks.cellType(binding.cell) : undefined,
      );
    };
    const entries = (obj: ts.ObjectLiteralExpression) =>
      obj.properties.map(p => {
        if (
          !(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ||
          !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
        )
          return tsFail(p, 'E_MOUNT', 'mount options and props are named properties');
        return {
          name: p.name.text,
          value: ts.isPropertyAssignment(p) ? p.initializer : (p.name as ts.Expression),
          at: p,
        };
      });
    for (const { name, value, at } of entries(o)) {
      if (name === 'target') {
        target = valueOf({ value, at });
        const t = l.irType(target, b);
        if (JSON.stringify(t) === JSON.stringify({ maybe: 'element' }))
          target = { op: 'unwrap', value: target };
        else if (t !== 'element')
          tsFail(value, 'E_MOUNT', 'The target of mount must be an element');
      } else if (name === 'context') {
        context = valueOf({ value, at });
        if (l.irType(context, b) !== 'contexts')
          tsFail(value, 'E_MOUNT', 'The context of mount must be a context map (getAllContexts())');
      } else if (name === 'props') {
        const po = skipParens(value);
        if (!ts.isObjectLiteralExpression(po))
          return tsFail(value, 'E_MOUNT', 'mount props are an object literal');
        for (const p of entries(po)) {
          const decl = child.slots?.find(d => d.name === p.name);
          if (decl) {
            // A snippet: one of this component's snippet props, forwarded.
            const sym = ts.isShorthandPropertyAssignment(p.at)
              ? checker.getShorthandAssignmentValueSymbol(p.at)
              : ts.isIdentifier(p.value)
                ? checker.getSymbolAtLocation(p.value)
                : undefined;
            const own = sym && m.snippetOf.get(sym);
            if (!own)
              tsFail(
                p.value,
                'E_MOUNT',
                `${p.name} is a snippet: pass a snippet prop of this component`,
              );
            if (decl.params?.length || m.slots.find(x => x.name === own)?.params?.length)
              tsFail(p.at, 'E_MOUNT', 'Snippets with parameters are not supported in mount props');
            slots.push({
              name: p.name,
              body: [{ kind: 'slot', name: own as string }],
              when: { op: 'slot-provided', name: own as string },
            });
            continue;
          }
          const cell = child.cells.find(c => c.prop === p.name);
          if (!cell) return tsFail(p.at, 'E_MOUNT', `${child.name} has no prop ${p.name}`);
          const v = valueOf(p);
          const vt = l.irType(v, b);
          const want: Type =
            cell.undefinedDefault && !maybeInner(cell.type) && maybeInner(vt)
              ? { maybe: cell.type }
              : cell.type;
          props.push({
            name: p.name,
            value: l.adaptFunction(v, vt, want) ?? coerceInit(v, vt, want, l.types.records),
          });
        }
      } else
        tsFail(
          at,
          'E_MOUNT',
          `The mount option ${name} is unsupported (target, props and context are)`,
        );
    }
    if (!target) return tsFail(options, 'E_MOUNT', 'mount needs a target');
    const site = m.sites.length;
    m.sites.push({
      component: childIndex,
      ...(slots.length ? { slots } : {}),
      source: sourceOf(node),
    });
    return {
      op: 'mount',
      site,
      target,
      ...(props.length ? { props } : {}),
      ...(context ? { context } : {}),
    };
  };
  /** `unmount(instance)` (svelte): a fulfilled promise; nothing for a nullish one. */
  const unmountCall = (node: ts.CallExpression, b: FnBuilder, l: Lowerer): Expr => {
    const [instance, ...rest] = node.arguments;
    if (!instance || rest.length)
      return tsFail(
        node,
        'E_MOUNT',
        'unmount takes the mounted instance (outro options are unsupported)',
      );
    const v = l.expr(instance, b);
    const t = l.irType(v, b);
    const call = (x: Expr): Expr => ({
      op: 'builtin',
      name: 'mounted.unmount',
      args: [x],
      type: { promise: 'void' },
    });
    if (t === 'mounted') return call(v);
    if (JSON.stringify(t) !== JSON.stringify({ maybe: 'mounted' }))
      return tsFail(instance, 'E_MOUNT', 'unmount takes an instance mount returned');
    const tmp = b.local('$mounted', t);
    const read: Expr = { op: 'local', local: tmp };
    return {
      op: 'with',
      local: tmp,
      value: v,
      body: {
        op: 'cond',
        test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: 'boolean' },
        then: {
          op: 'builtin',
          name: 'promise.resolve',
          args: [{ op: 'undefined', type: 'void' }],
          type: { promise: 'void' },
        },
        else: call({ op: 'unwrap', value: read }),
      },
    };
  };
  const lower = new Lowerer(program, checker, types, hooks, tsFail, sourceOf);
  // The script runs once per instance: its functions keep their identity.
  lower.stableFunctions = true;
  // Declarations of package modules are lowered when the program reaches them.
  lower.lazy = packageBindings(lower, graph.modules, packageModules);
  lower.implementation = implementationOf(program, packageModules);
  const runeName = (e: ts.Expression | undefined): string | undefined => {
    if (!e || !ts.isCallExpression(e)) return undefined;
    const callee = e.expression;
    if (ts.isIdentifier(callee) && callee.text.startsWith('$')) return callee.text;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text.startsWith('$')
    )
      return `${callee.expression.text}.${callee.name.text}`;
    return undefined;
  };
  /** A component's `<script module>` statements in its virtual module. */
  const moduleStatements = (u: Unit) => {
    const sf = program.getSourceFile(u.virtual)!;
    return sf.statements.filter(s => s.getStart(sf) < u.instanceSynth);
  };
  /** A component's instance script statements (and synthesized host listeners). */
  const instanceStatements = (u: Unit) => {
    const sf = program.getSourceFile(u.virtual)!;
    return sf.statements.filter(
      s => s.getStart(sf) >= u.instanceSynth && s.getStart(sf) < u.statementsEnd,
    );
  };
  // Ordinary local modules and components' `<script module>`s initialise
  // first (dependencies first): their constants are program globals, their
  // functions shared by every instance.
  for (const p of lowerModules(graph, program, lower, {
    skip: f => f === graph.entry,
    // 'svelte''s tick, untrack and settled in modules lower where they are
    // called; setContext and getContext are bound (frontend/svelte-context.ts).
    frameworkImport(spec, stmt) {
      if (spec !== 'svelte') return false;
      const named = stmt.importClause?.namedBindings;
      if (stmt.importClause?.name || !named || !ts.isNamedImports(named))
        tsFail(stmt, 'E_CAPABILITY', `Import ${MODULE_SVELTE.join(', ')} from svelte by name`);
      for (const el of (named as ts.NamedImports).elements)
        if (!MODULE_SVELTE.includes((el.propertyName ?? el.name).text))
          tsFail(
            el,
            'E_CAPABILITY',
            `svelte's ${(el.propertyName ?? el.name).text} is unsupported in modules (${MODULE_SVELTE.join(', ')} are)`,
          );
      svelteContextImport(stmt, lower, ['tick', 'untrack', 'settled']);
      return true;
    },
    componentModule: f => {
      const u = units.get(f);
      return u?.moduleLength ? moduleStatements(u) : undefined;
    },
  }))
    p();
  // Package imports and pack constants of instance scripts, bound before
  // any component is lowered: the analysis of what props receive evaluates
  // the parents' pack calls.
  for (const u of order)
    for (const stmt of instanceStatements(u)) {
      if (ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (spec === 'svelte' || spec.startsWith('svelte/') || spec.endsWith('.svelte')) continue;
        bindPackImport(
          stmt,
          graph.modules.get(u.file)!.imports.find(i => i.specifier === spec),
          lower,
        );
      } else if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & ts.NodeFlags.Const)
        for (const d of stmt.declarationList.declarations)
          if (!runeName(d.initializer)) lower.isPackConstant(d);
    }

  // Attribute bags (frontend/bags.ts): the names the rest props of each
  // component may hold (from its sites, through forwarding), and the names
  // snippet parameters receive from the snippet's render sites.
  const restShape = new Map<string, Shape>();
  for (const [file, d] of decls) if (d.rest) restShape.set(file, emptyShape());
  const restOf = new Map<ts.Symbol, string>();
  for (const u of order)
    for (const stmt of instanceStatements(u))
      if (ts.isVariableStatement(stmt))
        for (const d of stmt.declarationList.declarations)
          if (runeName(d.initializer) === '$props' && ts.isObjectBindingPattern(d.name))
            for (const el of d.name.elements)
              if (el.dotDotDotToken && ts.isIdentifier(el.name)) {
                const sym = checker.getSymbolAtLocation(el.name);
                if (sym) restOf.set(sym, u.file);
              }
  /** The local name of snippet prop `name` of component `file`. */
  const snippetLocal = (file: string, name: string): string | undefined => {
    const u = units.get(file)!;
    for (const stmt of instanceStatements(u))
      if (ts.isVariableStatement(stmt))
        for (const d of stmt.declarationList.declarations)
          if (runeName(d.initializer) === '$props' && ts.isObjectBindingPattern(d.name))
            for (const el of d.name.elements)
              if (
                !el.dotDotDotToken &&
                ((el.propertyName ?? el.name) as ts.Identifier).text === name &&
                ts.isIdentifier(el.name)
              )
                return el.name.text;
    return undefined;
  };
  /**
   * The arguments the snippet `name` passed to component `file` receives:
   * at the component's `{@render name(…)}` tags, or where it forwards its
   * rest props (holding the snippet) onto a component.
   */
  const renderArgs = (file: string, name: string, seen = new Set<string>()): ts.Expression[][] => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const u = units.get(file);
    if (!u?.reached) return [];
    const out: ts.Expression[][] = [];
    if (decls.get(file)?.declared.has(name)) {
      const local = snippetLocal(file, name);
      walkTemplate(u.ast.fragment, n => {
        if (n.type !== 'RenderTag') return;
        let call = nodeIn(u, n.expression) as ts.Expression;
        while (ts.isParenthesizedExpression(call)) call = call.expression;
        if (!ts.isCallExpression(call)) return;
        const callee = call.expression;
        if (ts.isIdentifier(callee) && callee.text === local) out.push([...call.arguments]);
      });
    } else if (restSlots.get(file)?.has(name))
      walkTemplate(u.ast.fragment, n => {
        if (n.type !== 'Component' || !n.attributes.some((a: SNode) => spreadsRest(file, a)))
          return;
        const to = u.children.get(n.name);
        if (to) out.push(...renderArgs(to, name, seen));
      });
    return out;
  };
  /** The bag a snippet argument's field `field` holds (`{ props }` destructured). */
  const argField = (arg: ts.Expression, field: string): Shape => {
    const e = skipParens(arg);
    if (!ts.isObjectLiteralExpression(e)) return openShape();
    for (const p of [...e.properties].reverse()) {
      if (ts.isPropertyAssignment(p) && shapes.propertyName(p.name) === field)
        return shapes.of(p.initializer);
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === field) return shapes.of(p.name);
      if (ts.isSpreadAssignment(p)) return openShape();
    }
    return openShape();
  };
  const shapes: BagShapes = new BagShapes(lower, {
    binding(sym) {
      const rest = restOf.get(sym);
      if (rest) return restShape.get(rest);
      // A field of a destructured snippet parameter.
      const decl = sym.valueDeclaration;
      if (!decl || !ts.isBindingElement(decl)) return undefined;
      let param: ts.Node = decl;
      while (param.parent && !ts.isParameter(param)) param = param.parent;
      if (!ts.isParameter(param) || decl.parent.parent !== param) return undefined;
      const site = snippetParams.find(
        p => p.virtual === param.getSourceFile().fileName && p.start === param.getStart(),
      );
      if (!site) return undefined;
      const to = site.unit.children.get(site.node.name);
      if (!to) return openShape();
      const field = ((decl.propertyName ?? decl.name) as ts.Identifier).text;
      return union(
        ...renderArgs(to, site.name).map(args =>
          args[site.index] ? argField(args[site.index], field) : emptyShape(),
        ),
      );
    },
  });
  /** What site `n` (a component node of `u`) passes into the rest props of `to`. */
  const siteRestShape = (u: Unit, n: SNode, to: string): Shape => {
    const declared = decls.get(to)!.declared;
    const out = emptyShape();
    for (const a of n.attributes) {
      if ((a.type === 'Attribute' || a.type === 'BindDirective') && !declared.has(a.name))
        out.keys.add(a.name);
      if (a.type === 'SpreadAttribute') {
        const s = shapes.of(nodeIn(u, a.expression) as ts.Expression);
        for (const k of s.keys) if (!declared.has(k)) out.keys.add(k);
        out.open ||= s.open;
      }
    }
    return out;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const u of order)
      walkTemplate(u.ast.fragment, n => {
        if (n.type !== 'Component') return;
        const to = u.children.get(n.name);
        const into = to && restShape.get(to);
        if (!into) return;
        const s = siteRestShape(u, n, to!);
        for (const k of s.keys)
          if (!into.keys.has(k)) {
            into.keys.add(k);
            changed = true;
          }
        if (s.open && !into.open) {
          into.open = true;
          changed = true;
        }
      });
  }

  // Prop domains (frontend/domains.ts): what every instantiation site
  // passes for each declared prop; a component with several sites gets a
  // `$site` prop when a call is enumerated per site.
  const propDecls: PropDecl[] = [];
  const sites: Site[] = [];
  const siteOfNode = new Map<string, Site>();
  /** Each component's rest props binding (spreads of it pass what its sites pass). */
  const restComponent = new Map<ts.Symbol, number>();
  for (const u of order) {
    const sf = program.getSourceFile(u.virtual)!;
    const bound = new Set<string>();
    walkTemplate(u.ast.fragment, n => {
      if (n.type === 'BindDirective' && n.expression?.type === 'Identifier')
        bound.add(n.expression.name);
    });
    for (const stmt of instanceStatements(u)) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (runeName(d.initializer) !== '$props' || !ts.isObjectBindingPattern(d.name)) continue;
        for (const el of d.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const symbol = checker.getSymbolAtLocation(el.name);
          if (!symbol) continue;
          if (el.dotDotDotToken) {
            restComponent.set(symbol, u.index);
            continue;
          }
          let fallback = el.initializer;
          if (fallback && runeName(fallback) === '$bindable')
            fallback = (fallback as ts.CallExpression).arguments[0];
          propDecls.push({
            component: u.index,
            key: el.propertyName ? (el.propertyName as ts.Identifier).text : el.name.text,
            symbol,
            fallback,
            written: bound.has(el.name.text) || assigned(checker, sf, symbol),
          });
        }
      }
    }
    walkTemplate(u.ast.fragment, n => {
      if (n.type !== 'Component') return;
      const child = u.children.get(n.name);
      if (!child) return;
      const values = new Map<string, SiteValue>();
      for (const a of n.attributes) {
        if (a.type === 'Attribute')
          values.set(
            a.name,
            a.value === true
              ? { value: true }
              : !Array.isArray(a.value)
                ? { expr: nodeIn(u, a.value.expression) as ts.Expression }
                : a.value.length === 1 && a.value[0].type === 'Text'
                  ? { value: a.value[0].data }
                  : { open: true },
          );
        else if (a.type === 'BindDirective')
          values.set(a.name, { expr: nodeIn(u, a.expression) as ts.Expression });
        else if (a.type === 'SpreadAttribute') {
          // A spread may set the declared props its bag may hold (later attributes win).
          const s = shapes.of(nodeIn(u, a.expression) as ts.Expression);
          const spread = nodeIn(u, a.expression) as ts.Expression;
          const own = ts.isIdentifier(spread) ? checker.getSymbolAtLocation(spread) : undefined;
          const rest = own && restComponent.get(own);
          for (const key of decls.get(child)!.declared)
            if (mayHold(s, key))
              values.set(key, {
                open: true,
                spread,
                ...(rest !== undefined ? { restOf: rest } : {}),
              });
        }
      }
      const site: Site = {
        component: units.get(child)!.index,
        values,
        at: locate(u.original, n.start, u.rel),
      };
      sites.push(site);
      siteOfNode.set(`${u.file}:${n.start}`, site);
    });
  }
  // mount(App, { target }) passes no props.
  sites.push({ component: units.get(rootFile!)!.index, values: new Map() });
  /**
   * Whether the bag `spread` holds `key` with a value that is not nullish at
   * every instance: it is a component's rest props and each of that
   * component's sites passes `key` (an attribute of a non-nullable type, or
   * its own rest props that surely hold it).
   */
  const spreadHolds = (spread: ts.Expression, key: string, seen: Set<number>): boolean => {
    const own = ts.isIdentifier(spread) ? checker.getSymbolAtLocation(spread) : undefined;
    const component = own && restComponent.get(own);
    if (component === undefined || seen.has(component)) return false;
    seen.add(component);
    const list = sites.filter(x => x.component === component);
    return (
      list.length > 0 &&
      list.every(x => {
        const passed = x.values.get(key);
        if (!passed) return false;
        if ('value' in passed) return passed.value !== undefined && passed.value !== null;
        if ('expr' in passed) {
          const t = checker.getTypeAtLocation(passed.expr);
          return checker.getNonNullableType(t) === t && !(t.flags & ts.TypeFlags.Any);
        }
        return !!passed.spread && spreadHolds(passed.spread, key, seen);
      })
    );
  };
  /** The `$site` prop cell of each component that has one. */
  const siteCells = new Map<number, number>();
  let lowering: number | undefined;
  const domains = new PropDomains(lower, propDecls, sites, (component, _b) => {
    if (component !== lowering) fail('E_INTERNAL', 'A site index was read outside its component');
    let cell = siteCells.get(component);
    if (cell === undefined) {
      cell = cells.length;
      cells.push({
        name: '$site',
        type: 'number',
        init: { op: 'lit', value: 0 },
        tracking: 'identity',
        prop: '$site',
      });
      siteCells.set(component, cell);
    }
    return { op: 'cell', cell, read: 'current' };
  });
  lower.domains = domains;

  /** The fragments links may navigate to (checked against the element ids below). */
  const linkFragments: { name: string; at: Source }[] = [];
  const components: Component[] = [];
  for (const u of order) {
    lowering = u.index;
    components[u.index] = lowerComponent(u);
  }
  lowering = undefined;
  // A link to a fragment that names an element would scroll to it and move
  // focus, which the runtime does not model: the ids the program can give
  // elements (literals and finite sets) must not be link targets. Ids of
  // open values are checked by the runtime when a link is followed.
  if (linkFragments.length)
    for (const u of order)
      walkTemplate(u.ast.fragment, n => {
        if (!['RegularElement', 'SvelteElement', 'Component'].includes(n.type)) return;
        for (const a of n.attributes ?? []) {
          if (a.type !== 'Attribute' || (a.name !== 'id' && a.name !== 'name')) continue;
          if (a.name === 'name' && !(n.type === 'RegularElement' && n.name === 'a')) continue;
          const ids =
            a.value === true
              ? ['']
              : Array.isArray(a.value)
                ? a.value.length === 1 && a.value[0].type === 'Text'
                  ? [a.value[0].data]
                  : []
                : (valueSet(
                    { lower, label: 'element ids' },
                    nodeIn(u, a.value.expression) as ts.Expression,
                  ) ?? []);
          for (const id of ids) {
            const link = linkFragments.find(f => f.name === id);
            if (link)
              fail(
                'E_TEMPLATE',
                `This link's fragment #${link.name} names an element (${locate(u.original, a.start, u.rel).file}:${locate(u.original, a.start, u.rel).line}); scrolling to and focusing fragment targets is not supported`,
                link.at,
              );
          }
        }
      });

  function lowerComponent(u: Unit): Component {
    cells = [];
    const COMPONENT = u.index;
    const sf = program.getSourceFile(u.virtual)!;
    const loc = (n: SNode) => locate(u.original, n.start ?? 0, u.rel);
    const statements = instanceStatements(u);
    const pending: (() => void)[] = [];
    /** Snippet props become slots: declaration and the prop's symbol. */
    const slots: { name: string; params?: Type[] }[] = [];
    const effects: Effect[] = [];
    /** Local names of the lifecycle functions imported from 'svelte'. */
    const lifecycle = new Map<string, string>();
    const snippetOf = new Map<ts.Symbol, string>();
    /** Slots received through the rest props (forwarded where they are spread). */
    const forwardedSlots = new Set<string>();
    const mountSites: MountSite[] = [];
    mounting = { u, index: COMPONENT, sites: mountSites, snippetOf, slots };
    // Variables holding what mount and getAllContexts return (M6): their
    // TypeScript types (an exports record, a Map of anything) are opaque
    // handles of the IR.
    for (const stmt of statements) {
      const visit = (n: ts.Node) => {
        const handle = (e: ts.Expression | undefined): Type | undefined => {
          const c = e && skipParens(e);
          if (!c || !ts.isCallExpression(c) || !ts.isIdentifier(c.expression)) return undefined;
          const name = svelteImport(c.expression);
          return name === 'mount' ? 'mounted' : name === 'getAllContexts' ? 'contexts' : undefined;
        };
        let id: ts.Identifier | undefined;
        let t: Type | undefined;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
          id = n.name;
          t = handle(n.initializer);
        } else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left)
        ) {
          id = n.left;
          t = handle(n.right);
        }
        if (id && t) {
          const sym = checker.getSymbolAtLocation(id);
          const declared = checker.getTypeAtLocation(id);
          const nullable =
            declared.isUnion() &&
            declared.types.some(p => p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
          if (sym) types.override(sym, nullable ? { maybe: t } : t);
        }
        ts.forEachChild(n, visit);
      };
      visit(stmt);
    }
    /** Parameter types of a `Snippet<[A, B]>` prop, or undefined for other props. */
    const snippetParams = (node: ts.Node, type?: ts.Type): Type[] | undefined => {
      const t = checker.getNonNullableType(type ?? checker.getTypeAtLocation(node));
      const sym = t.aliasSymbol ?? t.getSymbol();
      const file = sym?.declarations?.[0]?.getSourceFile().fileName ?? '';
      if (sym?.name !== 'Snippet' || !/[\\/]svelte[\\/]/.test(file)) return undefined;
      const [tuple] = checker.getTypeArguments(t as ts.TypeReference);
      if (!tuple) return [];
      if (!checker.isTupleType(tuple))
        return tsFail(node, 'E_PROPS', 'Snippet parameters must be a tuple type');
      return checker.getTypeArguments(tuple as ts.TypeReference).map(x => types.map(x, node));
    };

    /**
     * The IR type of a prop typed wider than the value model (svelte/elements'
     * `value?: any`) whose values are open: the one type, apart from
     * nullishness, of what its sites pass (through spreads, the bag's
     * property type), nullable when a site may pass nothing and the prop has
     * no default. Undefined when they differ or one is unknown.
     */
    const typeOfSites = (sym: ts.Symbol, el: ts.BindingElement): Type | undefined => {
      const passed = domains.siteTypes(sym);
      if (!passed?.length) return undefined;
      let base: Type | undefined;
      let nullable = false;
      for (const t of passed) {
        if (!t) {
          nullable = true;
          continue;
        }
        const mapped = types.tryMap(t, el);
        if (!mapped || mapped === 'void') return undefined;
        const inner = maybeInner(mapped) ?? mapped;
        nullable ||= inner !== mapped;
        if (base && JSON.stringify(base) !== JSON.stringify(inner)) return undefined;
        base = inner;
      }
      if (!base) return undefined;
      let fallback = el.initializer;
      if (fallback && runeName(fallback) === '$bindable')
        fallback = (fallback as ts.CallExpression).arguments[0];
      return nullable && !fallback ? { maybe: base } : base;
    };

    /**
     * The member of a discriminated union props type that every instance of
     * the component takes: bits-ui's ToggleGroup and Accordion take
     * `type: "single"` with `value?: string` or `type: "multiple"` with
     * `value?: string[]`. When all sites pass one literal for the
     * discriminant (also through wrappers' rest props), the props have that
     * member's types (a program mixing both is rejected where the union
     * meets the value model, `mixed` naming the discriminant's values).
     * Undefined otherwise.
     */
    let mixed: string | undefined;
    const discriminated = (d: ts.VariableDeclaration): ts.Type | undefined => {
      mixed = undefined;
      const declared = d.type ? checker.getTypeFromTypeNode(d.type) : undefined;
      if (!declared || !ts.isObjectBindingPattern(d.name)) return undefined;
      // The union may sit inside an intersection (`(A | B) & Without<…>`).
      const parts = declared.isIntersection() ? declared.types : [declared];
      const union = parts.find(
        p =>
          p.isUnion() &&
          p.types.every(m => m.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)),
      );
      if (!union || !union.isUnion()) return undefined;
      // The discriminant: a destructured prop, or one the rest props take
      // (shadcn-svelte's wrappers pass `type` on in `restProps`).
      const elements = new Map<string, ts.BindingElement>();
      let hasRest = false;
      for (const el of d.name.elements) {
        if (el.dotDotDotToken) hasRest = true;
        else if (ts.isIdentifier(el.name))
          elements.set(
            el.propertyName ? (el.propertyName as ts.Identifier).text : el.name.text,
            el,
          );
      }
      for (const prop of checker.getPropertiesOfType(union.types[0])) {
        const key = prop.name;
        const el = elements.get(key);
        if (!el && !hasRest) continue;
        const literals = union.types.map(m => {
          const p = checker.getPropertyOfType(m, key);
          const t = p && checker.getTypeOfSymbolAtLocation(p, d);
          return t && t.isStringLiteral() ? t.value : undefined;
        });
        if (literals.some(l => l === undefined) || new Set(literals).size !== literals.length)
          continue;
        const sym = el && checker.getSymbolAtLocation(el.name);
        const values = el ? sym && domains.values(sym) : domains.restValues(u.index, key);
        if (values && values.length > 1 && values.every(v => literals.includes(v as string)))
          mixed = `${key} is ${values.map(v => JSON.stringify(v)).join(' and ')} at different sites`;
        if (!values || values.length !== 1 || typeof values[0] !== 'string') continue;
        const i = literals.indexOf(values[0]);
        if (i < 0) continue;
        // (Props of the intersection's other parts keep TypeScript's types.)
        return union.types[i];
      }
      return undefined;
    };
    /** The IR type of prop `key` in props type `member` (optional: nullable unless defaulted). */
    const propTypeIn = (
      member: ts.Type,
      key: string,
      at: ts.Node,
      defaulted: boolean,
    ): Type | undefined => {
      const p = checker.getPropertyOfType(member, key);
      if (!p) return undefined;
      let t = checker.getTypeOfSymbolAtLocation(p, at);
      if (p.flags & ts.SymbolFlags.Optional && !defaulted)
        t = checker.getNullableType(t, ts.TypeFlags.Undefined);
      // A default replaces undefined (null stays).
      if (defaulted && t.isUnion()) {
        const kept = t.types.filter(m => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
        if (kept.length < t.types.length) {
          const out = types.tryMap(kept.length === 1 ? kept[0] : t, at);
          if (kept.length === 1 || !out) return out;
          return kept.some(m => m.flags & ts.TypeFlags.Null) ? out : (maybeInner(out) ?? out);
        }
      }
      return types.tryMap(t, at);
    };

    /** `let { a, b = 1, c = $bindable() }: Props = $props()` → prop cells. */
    const props = (d: ts.VariableDeclaration) => {
      if (!ts.isObjectBindingPattern(d.name))
        return tsFail(d, 'E_PROPS', 'Destructure $props(): let { a, b } = $props()');
      const member = discriminated(d);
      for (const el of d.name.elements) {
        if (el.dotDotDotToken) {
          // Rest props: an attribute bag of the props the parent passes beyond these.
          if (!ts.isIdentifier(el.name)) tsFail(el, 'E_PROPS', 'Rest props need a name');
          const cell = cells.length;
          cells.push({
            name: (el.name as ts.Identifier).text,
            type: 'attrs',
            init: { op: 'attrs', items: [] },
            prop: '...',
            source: sourceOf(el),
          });
          lower.bindings.set(checker.getSymbolAtLocation(el.name)!, { kind: 'cell', cell });
          continue;
        }
        if (!ts.isIdentifier(el.name))
          tsFail(el, 'E_PROPS', 'Nested prop destructuring is planned for a later milestone');
        const name = (el.name as ts.Identifier).text;
        const key = el.propertyName ? (el.propertyName as ts.Identifier).text : name;
        const sym = checker.getSymbolAtLocation(el.name)!;
        const params = snippetParams(el.name);
        if (params) {
          if (el.initializer) tsFail(el, 'E_PROPS', 'Snippet props cannot have defaults');
          slots.push({ name: key, ...(params.length ? { params } : {}) });
          snippetOf.set(sym, key);
          continue;
        }
        // A default (not `$bindable()` without one) replaces undefined.
        const defaulted =
          !!el.initializer &&
          !(
            runeName(el.initializer) === '$bindable' &&
            !(el.initializer as ts.CallExpression).arguments.length
          );
        const inMember = member && propTypeIn(member, key, el, defaulted);
        let type =
          types.overridden(el.name) ??
          inMember ??
          types.tryMap(checker.getTypeAtLocation(el.name), el.name);
        if (member && type && !types.overridden(el.name)) types.override(sym, type);
        const fromSites = !type;
        if (!type) {
          // A prop typed wider than the value model (svelte/elements'
          // `class?: ClassValue`) takes the type of the values its sites pass.
          const values = domains.values(sym);
          const t = (values && typeOfValues(values)) ?? typeOfSites(sym, el);
          if (!t) {
            if (mixed)
              tsFail(
                el,
                'E_TYPE_UNION',
                `The type of ${name} (${checker.typeToString(checker.getTypeAtLocation(el.name))}) depends on the discriminant, and ${mixed}: one program can use one of them (a value of either type is planned with a later value model)`,
              );
            const why = domains.explain(sym);
            if (why)
              tsFail(
                el,
                'E_TYPE_UNION',
                `The type of ${name} (${checker.typeToString(checker.getTypeAtLocation(el.name))}) is outside the value model, so it takes the values its sites pass, but ${why}`,
              );
            types.of(el.name); // the type's own diagnostic
          }
          types.override(sym, t!);
          type = t!;
        }
        const cell = cells.length;
        cells.push({
          name,
          type,
          init: required(type),
          // Props carry the parent's proxies; mutations through them are reactive.
          tracking: isReference(type) ? 'proxied' : 'identity',
          prop: key,
          source: sourceOf(el),
        });
        lower.bindings.set(sym, { kind: 'cell', cell });
        let fallback = el.initializer;
        if (fallback && runeName(fallback) === '$bindable')
          fallback = (fallback as ts.CallExpression).arguments[0];
        if (fallback) {
          const f = fallback;
          // A parent passing undefined gets the default too, as with $props().
          cells[cell].undefinedDefault = true;
          pending.push(() => {
            // `name = undefined` (a prop typed wider than the value model takes its type from its sites).
            if (ts.isIdentifier(f) && f.text === 'undefined' && maybeInner(type)) {
              cells[cell].init = { op: 'undefined', type };
              return;
            }
            const v = lower.value(f, COMPONENT, `${name}$default`);
            const t = lower.valueType(v);
            // A prop typed by its sites whose default is of another type (a
            // union of an element and a string: `to = 'body'` and `to={el}`).
            const inner = (x: Type) => maybeInner(x) ?? x;
            if (
              fromSites &&
              v.op !== 'null' &&
              v.op !== 'undefined' &&
              JSON.stringify(inner(t)) !== JSON.stringify(inner(type))
            )
              tsFail(
                f,
                'E_TYPE_UNION',
                `The type of ${name} (${checker.typeToString(checker.getTypeAtLocation(el.name))}) is outside the value model, so it takes the values its sites pass (${JSON.stringify(inner(type))}), but its default is of another type (${JSON.stringify(inner(t))})`,
              );
            // A function taking fewer parameters (`onOpenChange = noop`).
            cells[cell].init =
              lower.adaptFunction(v, t, type) ?? coerceInit(v, t, type, lower.types.records);
          });
        }
      }
      // Snippets received through the rest props (frontend: `restSlots`):
      // slots of this component, typed by its props type.
      const propsType = d.type
        ? checker.getTypeFromTypeNode(d.type)
        : checker.getTypeAtLocation(d.initializer!);
      for (const name of restSlots.get(u.file) ?? []) {
        if (slots.some(s => s.name === name)) continue;
        const p = checker.getPropertyOfType(propsType, name);
        const params =
          p && snippetParams(p.valueDeclaration ?? d, checker.getTypeOfSymbolAtLocation(p, d));
        if (!params)
          tsFail(
            d,
            'E_PROPS',
            `${name} reaches the rest props, but the props type has no snippet ${name}`,
          );
        slots.push({ name, ...(params!.length ? { params: params! } : {}) });
        forwardedSlots.add(name);
      }
    };

    /**
     * `$effect`, `$effect.pre`, `onMount` and `onDestroy` (docs/design/M4-EFFECTS.md):
     * effects tracking what they read, or running once; Svelte tears effects
     * down after removing the DOM, pre effects before the component's children.
     */
    /** Whether a top-level expression statement calls a rune or a function imported from svelte. */
    const isEffect = (stmt: ts.ExpressionStatement) => {
      const call = stmt.expression;
      if (!ts.isCallExpression(call)) return false;
      return (
        runeName(call) !== undefined ||
        (ts.isIdentifier(call.expression) && lifecycle.has(call.expression.text))
      );
    };
    /**
     * Another top-level statement (bits-ui's `State.create(…)` called for its
     * effect, `watch.pre(…)`, an `if`): it runs while the instance is
     * created, in order with the declarations around it, as the initialiser
     * of a hidden cell.
     */
    const topLevel = (stmt: ts.Statement) => {
      const cell = cells.length;
      cells.push({
        name: '$toplevel',
        type: 'boolean',
        init: { op: 'lit', value: true },
        tracking: 'none',
        source: sourceOf(stmt),
      });
      pending.push(() => {
        cells[cell].init = lower.statementValue(stmt, COMPONENT, '$toplevel');
      });
    };
    const effect = (stmt: ts.ExpressionStatement) => {
      const call = stmt.expression;
      const kind = ts.isCallExpression(call)
        ? (runeName(call) ??
          (ts.isIdentifier(call.expression) ? lifecycle.get(call.expression.text) : undefined))
        : undefined;
      if (!kind || !['$effect', '$effect.pre', 'onMount', 'onDestroy'].includes(kind))
        return tsFail(
          stmt,
          'E_STATEMENT',
          kind?.startsWith('$effect')
            ? `${kind} is planned for a later milestone`
            : 'Top-level statements other than $effect, onMount and onDestroy are unsupported',
        );
      const c = call as ts.CallExpression;
      const fn = c.arguments[0];
      if (
        c.arguments.length !== 1 ||
        !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
        fn.parameters.length ||
        fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)
      )
        return tsFail(c, 'E_EFFECT', `${kind} takes one synchronous function without parameters`);
      const run = lower.reserve();
      const source = sourceOf(stmt);
      const post = { removal: 'after', order: 'post' } as const;
      if (kind === 'onDestroy') {
        // onDestroy(f) is an effect that runs once and returns f as its cleanup.
        const f = lower.reserve();
        pending.push(() => {
          lower.function(fn as ts.ArrowFunction, 'onDestroy', undefined, COMPONENT, f);
          lower.functions[run] = {
            name: 'onDestroy$effect',
            component: COMPONENT,
            params: [],
            locals: [],
            result: { fn: { params: [], result: 'void' } },
            body: [{ op: 'return', value: { op: 'closure', function: f, captures: [] } }],
          };
        });
        effects.push({ run, phase: 'post', deps: { kind: 'once' }, unmount: post, source });
        return;
      }
      pending.push(() => {
        lower.function(fn as ts.ArrowFunction, kind, undefined, COMPONENT, run);
        const result = lower.functions[run].result;
        const cleanup = (t: Type) =>
          typeof t === 'object' && 'fn' in t && !t.fn.params.length && t.fn.result === 'void';
        if (
          result !== 'void' &&
          !cleanup(result) &&
          !(typeof result === 'object' && 'maybe' in result && cleanup(result.maybe))
        )
          tsFail(fn, 'E_EFFECT', `${kind} functions return nothing or a cleanup function`);
      });
      effects.push(
        kind === '$effect.pre'
          ? {
              run,
              phase: 'pre',
              deps: { kind: 'tracked' },
              unmount: { removal: 'after', order: 'pre' },
              source,
            }
          : {
              run,
              phase: 'post',
              deps: { kind: kind === 'onMount' ? 'once' : 'tracked' },
              unmount: post,
              source,
            },
      );
    };

    // Pass 1: register bindings (functions are hoisted; cells get indices).
    for (const stmt of statements) {
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (stmt.importClause?.isTypeOnly) continue;
        if (spec === 'svelte') {
          const named = stmt.importClause?.namedBindings;
          if (stmt.importClause?.name || !named || !ts.isNamedImports(named))
            tsFail(stmt, 'E_CAPABILITY', 'Import onMount and onDestroy from svelte by name');
          for (const el of (named as ts.NamedImports).elements) {
            if (el.isTypeOnly) continue;
            const imported = (el.propertyName ?? el.name).text;
            if (!SVELTE_EXPORTS.svelte.includes(imported))
              tsFail(
                el,
                'E_CAPABILITY',
                `svelte's ${imported} is planned for a later milestone (${SVELTE_EXPORTS.svelte.join(', ')} are supported)`,
              );
            lifecycle.set(el.name.text, imported);
          }
          continue;
        }
        if (spec === 'svelte/events') {
          const named = stmt.importClause?.namedBindings;
          for (const el of named && ts.isNamedImports(named) ? named.elements : [])
            if (!SVELTE_EXPORTS['svelte/events'].includes((el.propertyName ?? el.name).text))
              tsFail(el, 'E_CAPABILITY', `svelte/events supports on`);
          if (stmt.importClause?.name || !named || !ts.isNamedImports(named))
            tsFail(stmt, 'E_CAPABILITY', 'Import on from svelte/events by name');
          continue;
        }
        // svelte/reactivity's SvelteMap (frontend/svelte-reactivity.ts).
        if (spec === 'svelte/reactivity') {
          svelteReactivityImport(stmt, tsFail);
          continue;
        }
        if (spec.startsWith('svelte/'))
          tsFail(stmt, 'E_CAPABILITY', `${spec} imports (stores, reactivity) are planned for M6`);
        if (spec.endsWith('.svelte')) continue;
        bindPackImport(
          stmt,
          graph.modules.get(u.file)!.imports.find(i => i.specifier === spec),
          lower,
        );
        continue;
      }
      if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue;
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const p = lower.declare(
          checker.getSymbolAtLocation(stmt.name)!,
          stmt,
          stmt.name.text,
          COMPONENT,
        );
        if (p) pending.push(p);
        continue;
      }
      if (ts.isVariableStatement(stmt)) {
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const d of stmt.declarationList.declarations) {
          const init = d.initializer;
          // Intl and pack constants have no runtime value (their uses are lowered).
          if (lower.isIntlConstant(d) || lower.isPackConstant(d)) continue;
          const rune = runeName(init);
          if (rune === '$props') {
            props(d);
            continue;
          }
          if (!ts.isIdentifier(d.name))
            tsFail(d, 'E_DECLARATION', 'Destructuring is supported for $props() only');
          const name = (d.name as ts.Identifier).text;
          const sym = checker.getSymbolAtLocation(d.name)!;
          if (rune === '$derived' || rune === '$derived.by') {
            const index = lower.reserve();
            lower.bindings.set(sym, { kind: 'derived', fn: index });
            const call = init as ts.CallExpression;
            pending.push(() => {
              if (rune === '$derived.by') {
                const getter = call.arguments[0];
                if (
                  !getter ||
                  !(ts.isArrowFunction(getter) || ts.isFunctionExpression(getter)) ||
                  getter.parameters.length
                )
                  tsFail(call, 'E_RUNE', '$derived.by takes a zero-parameter function');
                lower.function(getter as ts.ArrowFunction, name, undefined, COMPONENT, index);
                lower.functions[index].derived = true;
                // Svelte compares a derived value's results with `===`.
                lower.functions[index].derivedStrict = true;
              } else {
                const v = lower.value(call.arguments[0], COMPONENT, `${name}$derived`);
                // An attribute bag (`mergeProps(…)`) whatever its TypeScript type.
                const bag = lower.valueType(v) === 'attrs';
                lower.functions[index] = {
                  name,
                  component: COMPONENT,
                  params: [],
                  locals: [],
                  result: bag ? 'attrs' : types.of(d.name),
                  body: [{ op: 'return', value: v }],
                  derived: true,
                  derivedStrict: true,
                };
              }
            });
            continue;
          }
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && isConst) {
            const p = lower.declare(sym, init, name, COMPONENT);
            if (p) pending.push(p);
            continue;
          }
          if (rune && !['$state', '$state.raw', '$props.id'].includes(rune))
            tsFail(
              init!,
              'E_RUNE',
              `${rune} is planned for a later milestone (see docs/ROADMAP.md)`,
            );
          if (rune === '$props.id' && !isConst)
            tsFail(init!, 'E_RUNE', '$props.id() initialises a const');
          const cell = cells.length;
          let type = types.of(d.name) as Type;
          // An element (bind:this) is undefined until mounted and null after removal.
          if (type === 'element') type = { maybe: 'element' };
          const tracking =
            rune === '$state'
              ? // $state proxies plain objects and arrays (docs/design/M3-COMPONENTS.md).
                'proxied'
              : rune === '$state.raw'
                ? 'identity'
                : isConst
                  ? 'identity'
                  : 'none';
          cells.push({ name, type, init: { op: 'lit', value: 0 }, tracking, source: sourceOf(d) });
          lower.bindings.set(sym, { kind: 'cell', cell });
          pending.push(() => {
            let value: ts.Expression | undefined = init;
            if (rune && rune !== '$props.id') value = (init as ts.CallExpression).arguments[0];
            if (!value) {
              cells[cell].init = { op: 'undefined', type };
              return;
            }
            // The IR type of the lowered value (a bare `null` takes its contextual type).
            const v = lower.value(value, COMPONENT, `${name}$init`);
            cells[cell].init = coerceInit(v, lower.valueType(v), type, lower.types.records);
          });
        }
        continue;
      }
      if (ts.isExpressionStatement(stmt) && !isEffect(stmt)) {
        topLevel(stmt);
        continue;
      }
      if (ts.isExpressionStatement(stmt)) {
        effect(stmt);
        continue;
      }
      if (ts.isIfStatement(stmt)) {
        topLevel(stmt);
        continue;
      }
      if (ts.isClassDeclaration(stmt)) {
        pending.push(...lower.classes.declare(stmt, COMPONENT));
        continue;
      }
      if (!ts.isEmptyStatement(stmt))
        tsFail(stmt, 'E_STATEMENT', 'Unsupported component statement');
    }
    for (const p of pending) p();

    // --- Template ---
    const tb: FnBuilder = lower.template(COMPONENT);
    const handlers: Handler[] = [];
    const nodeAt = (n: SNode, length?: number): ts.Node => nodeIn(u, n, length);
    const exprNode = (e: SNode) => nodeAt(e) as ts.Expression;
    const value = (e: ts.Expression): Expr => lower.expr(e, tb);
    const typeOf = (e: ts.Expression, v: Expr): Type =>
      types.typeOrUndefined(e) ?? lower.irType(v, tb);
    const display = (e: ts.Expression): Expr => {
      // Svelte renders `value ?? ''` stringified (by the value's type: a
      // getter of an optional property may be undefined where TypeScript's
      // `Required<…>` says otherwise).
      const v = value(e);
      const t = lower.irType(v, tb);
      if (t === 'string') return v;
      if (typeof t === 'object' && 'maybe' in t) return maybeText(lower, v, t);
      return { op: 'to-string', arg: v };
    };
    /** Nesting depth of <svg> elements around the content being lowered. */
    let inSvg = 0;
    const clean = (fragment: SNode, parent?: string): SNode[] => {
      // Comments, <svelte:window> and <svelte:document> leave no node;
      // the text around them joins.
      const list: SNode[] = [];
      for (const n of fragment.nodes) {
        if (['Comment', 'SvelteWindow', 'SvelteDocument', 'SvelteHead'].includes(n.type)) continue;
        const last = list.at(-1);
        if (n.type === 'Text' && last?.type === 'Text') last.data += n.data;
        else list.push({ ...n });
      }
      while (list[0]?.type === 'Text' && !list[0].data.trim()) list.shift();
      while (list.at(-1)?.type === 'Text' && !list.at(-1).data.trim()) list.pop();
      if (list[0]?.type === 'Text') list[0].data = list[0].data.trimStart();
      if (list.at(-1)?.type === 'Text') list.at(-1).data = list.at(-1).data.trimEnd();
      for (let i = 0; i < list.length; i++)
        if (list[i].type === 'Text') {
          if (list[i - 1]?.type !== 'ExpressionTag')
            list[i].data = list[i].data.replace(/^\s+/, ' ');
          if (list[i + 1]?.type !== 'ExpressionTag')
            list[i].data = list[i].data.replace(/\s+$/, ' ');
        }
      // Elements whose whitespace-only text Svelte drops (it would not render).
      // So does the SVG namespace (clean_nodes' can_remove_entirely; <text>
      // is unsupported).
      const drops = ['select', 'tr', 'table', 'tbody', 'thead', 'tfoot', 'colgroup', 'datalist'];
      if ((parent && drops.includes(parent)) || inSvg > 0)
        return list.filter(n => !(n.type === 'Text' && n.data === ' '));
      return list;
    };
    const handlerFor = (v: SNode, event: HandlerEvent, where: SNode): Listener => {
      const e = exprNode(v);
      let h: {
        params?: Handler['params'];
        locals?: Handler['locals'];
        body: Stmt[];
        args?: Expr[];
      };
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
        h = lower.handler(e, COMPONENT, event, tb);
      else if (ts.isIdentifier(e)) {
        const b = lower.binding(e);
        // A named function or a function-valued prop or state (a callback),
        // called with the event object if it takes one.
        const eventArgs = (params: Type[]): Expr[] | undefined =>
          params.length === 0
            ? []
            : params.length === 1 && params[0] === 'event'
              ? [{ op: 'event' }]
              : undefined;
        const misfit = 'Event handlers take no parameter or the event object';
        if (b?.kind === 'function') {
          const target = lower.functions[b.fn];
          const args = eventArgs(target?.params.map(p => p.type) ?? []);
          if (!args) return fail('E_EVENT', misfit, loc(where));
          h = { body: [{ op: 'expr', value: { op: 'call', function: b.fn, args } }] };
        } else if (b?.kind === 'cell') {
          const t = cells[b.cell].type;
          if (typeof t !== 'object' || !('fn' in t))
            return fail('E_EVENT', 'Event handlers must be functions', loc(where));
          const args = eventArgs(t.fn.params);
          if (!args) return fail('E_EVENT', misfit, loc(where));
          h = {
            body: [
              {
                op: 'expr',
                value: { op: 'call-value', callee: { op: 'cell', cell: b.cell }, args },
              },
            ],
          };
        } else return fail('E_EVENT', 'Event handlers must be functions', loc(where));
      } else return fail('E_EVENT', 'Unsupported event handler expression', loc(where));
      const { args, ...rest } = h;
      handlers.push({ event, ...rest, source: loc(where) });
      return { event, handler: handlers.length - 1, ...(args?.length ? { args } : {}) };
    };
    const children = (fragment: SNode, parent?: string): Node[] => {
      // An <svg>'s content is in the SVG namespace.
      if (parent === 'svg') inSvg++;
      try {
        return childNodes(fragment, parent);
      } finally {
        if (parent === 'svg') inSvg--;
      }
    };
    const childNodes = (fragment: SNode, parent?: string): Node[] => {
      const out: Node[] = [];
      let parts: Expr[] = [];
      const flush = () => {
        if (parts.length) out.push({ kind: 'text', parts });
        parts = [];
      };
      for (const n of clean(fragment, parent)) {
        if (n.type === 'Text') {
          if (n.data) parts.push({ op: 'lit', value: n.data });
        } else if (n.type === 'ExpressionTag') parts.push(display(exprNode(n.expression)));
        else if (n.type === 'RegularElement') {
          flush();
          out.push(element(n));
        } else if (n.type === 'SvelteElement') {
          flush();
          out.push(...dynamicElement(n));
        } else if (n.type === 'IfBlock') {
          flush();
          const testNode = exprNode(n.test);
          // `{#if child}` on a snippet prop: whether the parent provides it.
          const snippet =
            ts.isIdentifier(testNode) && snippetOf.get(checker.getSymbolAtLocation(testNode)!);
          const tv: Expr = snippet ? { op: 'slot-provided', name: snippet } : value(testNode);
          out.push({
            kind: 'if',
            test:
              snippet || typeOf(testNode, tv) === 'boolean' ? tv : { op: 'to-boolean', arg: tv },
            then: children(n.consequent),
            ...(n.alternate ? { else: children(n.alternate) } : {}),
            source: loc(n),
          });
        } else if (n.type === 'EachBlock') {
          flush();
          out.push(each(n));
        } else if (n.type === 'Component') {
          flush();
          out.push(component(n));
        } else if (n.type === 'RenderTag') {
          flush();
          out.push(render(n));
        } else if (
          n.type === 'KeyBlock' &&
          n.expression.type === 'Identifier' &&
          ts.isIdentifier(exprNode(n.expression)) &&
          snippetOf.has(checker.getSymbolAtLocation(exprNode(n.expression))!)
        ) {
          // {#key snippet}: an instance's snippet props are fixed when it is
          // created (slot content), so the content never remounts (bits-ui's
          // PortalConsumer).
          flush();
          out.push(...children(n.fragment));
        } else if (n.type === 'KeyBlock') {
          // {#key v}…{/key} remounts its content when v changes: a keyed list of [v].
          flush();
          const e = exprNode(n.expression);
          const v = value(e);
          const t = typeOf(e, v);
          if (typeof t === 'object' && 'fn' in t)
            fail('E_TEMPLATE', '{#key} needs a value', loc(n));
          const local = tb.local('$key', t);
          out.push({
            kind: 'each',
            reorder: 'stash',
            items: { op: 'array', type: { array: t }, items: [v] },
            item: local,
            key: { op: 'local', local },
            body: children(n.fragment),
            source: loc(n),
          });
        } else if (n.type === 'AwaitBlock')
          fail('E_TEMPLATE', 'Await blocks are planned for M4', loc(n));
        else if (n.type === 'SvelteWindow' || n.type === 'SvelteDocument') {
          // Lowered as script code (see the virtual modules).
        } else fail('E_TEMPLATE', `Unsupported template node ${n.type}`, loc(n));
      }
      flush();
      return out;
    };
    /**
     * `<svelte:element this={tag}>` whose tag takes a finite set of values
     * (literals, conditionals, literal-union values, props whose sites pass
     * them; frontend/domains.ts): one branch per tag, as an `if` chain on
     * the tag's value. Svelte recreates the element (and its content) when
     * the tag changes, as switching branches does; a nullish tag renders
     * nothing.
     */
    const dynamicElement = (n: SNode): Node[] => {
      const tagNode = exprNode(n.tag);
      const tags = valueSet({ lower, label: '<svelte:element>' }, tagNode);
      if (!tags)
        return fail(
          'E_TEMPLATE',
          '<svelte:element this={…}> needs a tag from a finite set of values (string literals, conditionals between them, literal-union values)',
          loc(n),
        );
      const names: string[] = [];
      for (const t of tags) {
        if (t === null || t === undefined) continue;
        if (typeof t !== 'string' || !TAGS.has(t) || SVG_TAGS.includes(t))
          fail(
            'E_TEMPLATE',
            `<svelte:element> may be <${String(t)}>, which is outside the supported HTML elements`,
            loc(n),
          );
        names.push(t as string);
      }
      let out: Node[] = [];
      for (const name of names.reverse()) {
        const tagValue = value(tagNode);
        const tagType = typeOf(tagNode, tagValue);
        let test: Expr;
        if (tagType === 'string')
          test = { op: 'eq', left: tagValue, right: { op: 'lit', value: name } };
        else {
          const local = tb.local('$tag', tagType);
          const read: Expr = { op: 'local', local };
          test = {
            op: 'with',
            local,
            value: tagValue,
            body: {
              op: 'cond',
              test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: 'boolean' },
              then: { op: 'lit', value: false },
              else: {
                op: 'eq',
                left: { op: 'unwrap', value: read },
                right: { op: 'lit', value: name },
              },
            },
          };
        }
        const el = element({ ...n, type: 'RegularElement', name });
        out = [
          { kind: 'if', test, then: [el], ...(out.length ? { else: out } : {}), source: loc(n) },
        ];
      }
      return out;
    };
    const each = (n: SNode): Node => {
      const itemsNode = exprNode(n.expression);
      const items = value(itemsNode);
      const itemType = arrayElement(lower.irType(items, tb));
      if (!itemType) return fail('E_TEMPLATE', '{#each} requires an array', loc(n));
      let pattern = nodeAt(n.context);
      if (ts.isVariableDeclaration(pattern)) pattern = pattern.name;
      const item = tb.local(ts.isIdentifier(pattern) ? pattern.text : '$item', itemType);
      if (ts.isIdentifier(pattern))
        lower.bindings.set(checker.getSymbolAtLocation(pattern)!, {
          kind: 'local',
          owner: tb,
          local: item,
        });
      else {
        // `{#each items as { id, name: label, inner: { x } }}`: fields of the item.
        const destructure = (p: ts.BindingName, type: Type, path: number[]) => {
          if (!ts.isObjectBindingPattern(p) || typeof type !== 'object' || !('record' in type))
            return fail('E_TEMPLATE', '{#each} items destructure into object fields', loc(n));
          for (const el of p.elements) {
            if (el.dotDotDotToken || el.initializer)
              fail(
                'E_TEMPLATE',
                'Rest and default values in {#each} patterns are planned for later',
                loc(n),
              );
            const key = ((el.propertyName ?? el.name) as ts.Identifier).text;
            const field = types.fieldIndex(type.record, key, el);
            const fieldType = types.records[type.record].fields[field].type;
            if (ts.isIdentifier(el.name))
              lower.bindings.set(checker.getSymbolAtLocation(el.name)!, {
                kind: 'member',
                owner: tb,
                local: item,
                path: [...path, field],
              });
            else destructure(el.name, fieldType, [...path, field]);
          }
        };
        destructure(pattern as ts.BindingName, itemType, []);
      }
      let index: number | undefined;
      if (n.index) {
        index = tb.local(n.index, 'number');
        const decl = nodeAt(n.body, n.index.length);
        lower.bindings.set(checker.getSymbolAtLocation(decl)!, {
          kind: 'local',
          owner: tb,
          local: index,
        });
      }
      const key = n.key ? value(exprNode(n.key)) : undefined;
      return {
        kind: 'each',
        // Svelte 5's keyed reconcile (which blocks move is observable through focus).
        reorder: 'stash',
        items,
        item,
        ...(index !== undefined ? { index } : {}),
        ...(key ? { key } : {}),
        body: children(n.body),
        ...(n.fallback ? { else: children(n.fallback) } : {}),
        source: loc(n),
      };
    };
    /** `{@render name(args)}` / `{@render name?.(args)}` of a snippet prop → a slot. */
    const render = (n: SNode): Node => {
      let call = exprNode(n.expression);
      while (ts.isParenthesizedExpression(call)) call = call.expression;
      const callee = ts.isCallExpression(call) ? call.expression : undefined;
      const name =
        callee && ts.isIdentifier(callee)
          ? snippetOf.get(checker.getSymbolAtLocation(callee)!)
          : undefined;
      if (!name)
        return fail('E_TEMPLATE', '{@render} supports snippet props of this component', loc(n));
      const decl = slots.find(d => d.name === name)!;
      const args = (call as ts.CallExpression).arguments.map((a, i) => {
        const v = value(a);
        // Object literal arguments take the snippet parameter's type (their context).
        const own = ts.isObjectLiteralExpression(skipParens(a))
          ? lower.irType(v, tb)
          : typeOf(a, v);
        return coerceInit(v, own, decl.params![i], lower.types.records);
      });
      return { kind: 'slot', name, ...(args.length ? { args } : {}), source: loc(n) };
    };
    /**
     * An attribute passed into rest props, as Svelte would set it on an
     * element: listeners (`on<event>`) stay functions; other values become
     * attribute values (boolean attributes present iff true, others strings,
     * nullish values absent).
     */
    const restEntry = (a: SNode): AttrItem => {
      const name: string = a.name;
      if (a.value === true)
        // A bare attribute passes `true` (written "true" where it reaches an element).
        return { name, value: { op: 'lit', value: true } };
      if (Array.isArray(a.value)) {
        let joined: Expr | undefined;
        for (const part of a.value) {
          const p: Expr =
            part.type === 'Text'
              ? { op: 'lit', value: part.data }
              : display(exprNode(part.expression));
          joined = joined ? { op: 'concat', left: joined, right: p } : p;
        }
        return { name, value: joined ?? { op: 'lit', value: '' } };
      }
      const e = exprNode(a.value.expression);
      const v = value(e);
      const t = typeOf(e, v);
      const kind = /^on([a-z]+)$/.exec(name)?.[1];
      // A callback the receiving component (or one it forwards to) declares
      // (`onOpenChange`): a function entry, never an attribute.
      if (!kind && typeof t === 'object' && 'fn' in t) return { name, value: v };
      if (kind) {
        const listener =
          EVENT_KINDS.includes(kind as HandlerEvent) &&
          kind !== 'resize' &&
          typeof t === 'object' &&
          'fn' in t &&
          (t.fn.params.length === 0 || (t.fn.params.length === 1 && t.fn.params[0] === 'event'));
        if (!listener)
          fail('E_EVENT', `${name} in rest props must be a listener of a supported event`, loc(a));
        return { name, value: v };
      }
      if (BOOLEAN_ATTRS.has(name))
        return { name, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } };
      // Booleans stay booleans: a component that declares the prop receives
      // the value (Separator's `decorative`); spread onto an element they
      // become what Svelte's set_attributes writes (`spreadBooleanText`).
      if (t === 'string' || t === 'boolean') return { name, value: v };
      if (typeof t === 'object' && 'maybe' in t && t.maybe === 'boolean') return { name, value: v };
      if (typeof t === 'object' && 'maybe' in t) return { name, value: maybeAttribute(v, t, a) };
      return { name, value: { op: 'to-string', arg: v } };
    };
    /**
     * A nullable attribute value as Svelte's set_attribute applies it:
     * absent when null or undefined, otherwise the value as a string
     * (`aria-disabled={false}` is "false", `tabindex={-1}` is "-1").
     */
    const maybeAttribute = (v: Expr, t: { maybe: Type }, a: SNode): Expr => {
      if (t.maybe === 'string') return v;
      if (t.maybe !== 'number' && t.maybe !== 'boolean')
        fail(
          'E_TEMPLATE',
          `Attribute ${a.name} of type ${JSON.stringify(t)} is unsupported`,
          loc(a),
        );
      const local = tb.local('$attr', t);
      const read: Expr = { op: 'local', local };
      return {
        op: 'with',
        local,
        value: v,
        body: {
          op: 'cond',
          test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: 'boolean' },
          then: { op: 'undefined', type: { maybe: 'string' } },
          else: { op: 'some', value: { op: 'to-string', arg: { op: 'unwrap', value: read } } },
        },
      };
    };
    /** An instance of a pack component, expanded by its pack. */
    const packComponent = (
      n: SNode,
      { pack, component }: { pack: Pack; component: PackComponent },
    ) => {
      const attrs: PackAttr[] = [];
      const reject = (at: SNode, what: string): never =>
        fail('E_PACK', `${pack.name}@${pack.version} pack: ${what}`, loc(at));
      for (const a of n.attributes) {
        if (a.type !== 'Attribute')
          reject(
            a,
            `${a.type === 'SpreadAttribute' ? 'spread attributes' : a.type} on ${n.name} are not covered`,
          );
        let value: PackAttr['value'];
        if (a.value === true) value = { present: true };
        else {
          const parts = Array.isArray(a.value) ? a.value : [a.value];
          if (parts.length === 1 && parts[0].type === 'Text') value = { text: parts[0].data };
          else if (parts.length === 1 && parts[0].type === 'ExpressionTag')
            value = { expr: exprNode(parts[0].expression) };
          else return reject(a, `the attribute ${a.name} mixes text and expressions`);
        }
        attrs.push({ name: a.name, at: loc(a), value });
      }
      if (n.fragment.nodes.some((c: SNode) => c.type !== 'Text' || c.data.trim()))
        reject(n, `content inside ${n.name} is not covered`);
      usePack(lower, pack);
      return component.expand(attrs, { lower, b: tb, at: loc(n), fail });
    };
    const component = (n: SNode): Node => {
      const packed = u.packs.get(n.name);
      if (packed) return packComponent(n, packed);
      const child = units.get(u.children.get(n.name)!)!;
      const target = components[child.index];
      const passed: { name: string; value: Expr; bind?: Expr }[] = [];
      // Props the child does not declare go into its rest props.
      const restCell = target.cells.findIndex(c => c.prop === '...');
      const bag: AttrItem[] = [];
      const declared = (name: string) => target.cells.some(c => c.prop === name);
      const propCell = (a: SNode) => {
        const cell = target.cells.findIndex(c => c.prop === a.name);
        if (cell < 0) fail('E_PROPS', `${n.name} has no prop ${a.name}`, loc(a));
        return cell;
      };
      // Spreads of attribute bags (frontend/bags.ts): a bag sets the declared
      // props it holds (a later attribute or spread wins, as Svelte merges
      // props) and the rest go into the child's rest props. Each declared
      // prop a bag may hold is read from it at the site.
      const spreads: { expr: ts.Expression; shape: Shape; rest: boolean; at: SNode }[] = [];
      /** The writers of declared props a spread may hold, in source order. */
      const writers = new Map<string, ({ explicit: Expr } | { spread: number })[]>();
      for (const a of n.attributes) {
        if (a.type === 'SpreadAttribute') {
          const e = exprNode(a.expression);
          // A bag, or a plain record spread as its fields (bits-ui's
          // `inputState.props`, typed by its declaration file).
          const v = lower.bagValue(e, tb);
          if (lower.irType(v, tb) !== 'attrs')
            fail(
              'E_TEMPLATE',
              'Spread attributes take attribute bags (rest props, props objects)',
              loc(a),
            );
          const shape = shapes.of(e);
          const index = spreads.length;
          spreads.push({ expr: e, shape, rest: spreadsRest(u.file, a), at: a });
          const held: string[] = [];
          for (const c of target.cells)
            if (c.prop && c.prop !== '...' && c.prop !== '$site' && mayHold(shape, c.prop)) {
              held.push(c.prop);
              const w = writers.get(c.prop) ?? [];
              // An earlier explicit value is the fallback of the spread's.
              const earlier = passed.findIndex(p => p.name === c.prop);
              if (earlier >= 0) {
                if (passed[earlier].bind)
                  fail('E_TEMPLATE', `A spread after bind:${c.prop} may hold ${c.prop}`, loc(a));
                w.push({ explicit: passed[earlier].value });
                passed.splice(earlier, 1);
              }
              w.push({ spread: index });
              writers.set(c.prop, w);
            }
          if (restCell >= 0)
            bag.push({
              spread: held.length
                ? {
                    op: 'builtin',
                    name: 'attrs.without',
                    args: [v, ...held.map(k => ({ op: 'lit', value: k }) as Expr)],
                    type: 'attrs',
                  }
                : v,
            });
          else if (shape.open || [...shape.keys].some(k => !declared(k)))
            fail(
              'E_PROPS',
              `${n.name} takes no rest props, and the spread may hold other names`,
              loc(a),
            );
          continue;
        }
        if (a.type === 'Attribute' && restCell >= 0 && !declared(a.name)) {
          bag.push(restEntry(a));
          continue;
        }
        if (a.type === 'BindDirective' && writers.has(a.name))
          fail('E_TEMPLATE', `bind:${a.name} after a spread that may hold ${a.name}`, loc(a));
        if (a.type === 'Attribute') {
          const want = target.cells[propCell(a)].type;
          let v: Expr;
          if (a.value === true)
            v = coerceInit({ op: 'lit', value: true }, 'boolean', want, lower.types.records);
          else if (Array.isArray(a.value)) {
            let joined: Expr | undefined;
            for (const part of a.value) {
              const p: Expr =
                part.type === 'Text'
                  ? { op: 'lit', value: part.data }
                  : display(exprNode(part.expression));
              joined = joined ? { op: 'concat', left: joined, right: p } : p;
            }
            v = coerceInit(joined ?? { op: 'lit', value: '' }, 'string', want, lower.types.records);
          } else {
            const e = exprNode(a.value.expression);
            v = value(e);
            // A function of a compatible type (fewer parameters, a result
            // where none is expected) is adapted to the prop's.
            const from = typeOf(e, v);
            const fn = maybeInner(want) ?? want;
            const adapted = lower.adaptFunction(v, from, fn);
            v = adapted
              ? coerceInit(adapted, fn, want, lower.types.records)
              : coerceInit(v, from, want, lower.types.records);
          }
          const w = writers.get(a.name);
          if (w) w.push({ explicit: v });
          else passed.push({ name: a.name, value: v });
        } else if (a.type === 'BindDirective') {
          const want = target.cells[propCell(a)].type;
          // A type assertion binds the variable (shadcn-svelte's
          // `bind:value={value as never}` quiets TypeScript's union).
          let e = exprNode(a.expression);
          while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
          const b = ts.isIdentifier(e) ? lower.binding(e) : undefined;
          const have = b?.kind === 'cell' ? JSON.stringify(cells[b.cell].type) : undefined;
          // A variable of the present type bound to an optional prop (bits-ui's
          // `value = $bindable()`): the child must never write undefined to it
          // (checked once every function is lowered, `presentWrites`).
          const present = !!maybeInner(want) && have === JSON.stringify(maybeInner(want));
          if (have !== JSON.stringify(want) && !present)
            fail('E_TEMPLATE', `bind:${a.name} needs a $state variable of the prop's type`, loc(a));
          const own = (b as { cell: number }).cell;
          if (present)
            presentWrites.push({
              component: child.index,
              cell: propCell(a),
              name: a.name,
              at: loc(a),
            });
          const setter = lower.reserve();
          bindSetters.set(setter, { component: child.index, cell: propCell(a) });
          const arg: Expr = { op: 'local', local: 0 };
          lower.functions[setter] = {
            name: `bind:${a.name}`,
            component: COMPONENT,
            params: [{ name: 'v', type: want }],
            locals: [],
            result: 'void',
            body: [{ op: 'set', cell: own, value: present ? { op: 'unwrap', value: arg } : arg }],
          };
          passed.push({
            name: a.name,
            value: present
              ? { op: 'some', value: { op: 'cell', cell: own, read: 'current' } }
              : { op: 'cell', cell: own, read: 'current' },
            bind: { op: 'closure', function: setter, captures: [] },
          });
        } else fail('E_TEMPLATE', `${a.type} on components is planned for a later M3 step`, loc(a));
      }
      // Declared props a spread may set: the last writer that holds the
      // prop gives it; undefined (absent everywhere) takes the child's default.
      for (const [key, ws] of writers) {
        const last = ws.at(-1)!;
        if ('explicit' in last) {
          passed.push({ name: key, value: last.explicit });
          continue;
        }
        const cell = target.cells.find(c => c.prop === key)!;
        const inner =
          typeof cell.type === 'object' && 'maybe' in cell.type ? cell.type.maybe : cell.type;
        // A required prop that every spread writing it surely holds (the
        // rest props of a wrapper whose sites all pass it: shadcn's
        // Tabs.Trigger passes `value` on to bits-ui's).
        const required =
          !(typeof cell.type === 'object' && 'maybe' in cell.type) && !cell.undefinedDefault;
        const sure =
          required &&
          ws.every(w => 'explicit' in w || spreadHolds(spreads[w.spread].expr, key, new Set()));
        if (required && !sure)
          fail(
            'E_PROPS',
            `${n.name}'s prop ${key} has no default, but a spread may leave it unset`,
            loc(n),
          );
        const want: Type = { maybe: inner };
        let acc: Expr = { op: 'undefined', type: want };
        for (const w of ws) {
          if ('explicit' in w) {
            acc = coerceInit(w.explicit, lower.irType(w.explicit, tb), want, lower.types.records);
            continue;
          }
          const bagValue = lower.bagValue(spreads[w.spread].expr, tb);
          const name: Expr = { op: 'lit', value: key };
          acc = {
            op: 'cond',
            test: { op: 'builtin', name: 'attrs.has', args: [bagValue, name], type: 'boolean' },
            then: {
              op: 'builtin',
              name: 'attrs.get',
              args: [lower.bagValue(spreads[w.spread].expr, tb), name],
              type: want,
            },
            else: acc,
          };
        }
        passed.push({ name: key, value: sure ? { op: 'unwrap', value: acc } : acc });
      }
      if (bag.length) passed.push({ name: '...', value: { op: 'attrs', items: bag } });
      // The index of this instantiation site (frontend/domains.ts).
      if (siteCells.has(child.index)) {
        const site = siteOfNode.get(`${u.file}:${n.start}`);
        if (!site) fail('E_INTERNAL', 'Instantiation site not analysed', loc(n));
        passed.push({ name: '$site', value: { op: 'lit', value: domains.indexOf(site!) } });
      }
      for (const c of target.cells)
        if (c.prop && !passed.some(p => p.name === c.prop) && isRequired(c.init))
          fail('E_PROPS', `${n.name} requires the prop ${c.prop}`, loc(n));
      // Snippets and children: parent-owned content for the child's slots.
      const defs: { name: string; params?: number[]; body: Node[]; when?: Expr }[] = [];
      const declOf = (name: string, at: SNode) =>
        target.slots?.find(d => d.name === name) ??
        fail('E_PROPS', `${n.name} has no snippet prop ${name}`, loc(at));
      for (const sn of n.fragment.nodes.filter((c: SNode) => c.type === 'SnippetBlock')) {
        const name: string = sn.expression.name;
        const decl = declOf(name, sn);
        // A snippet may take fewer parameters than it is called with.
        if (sn.parameters.length > (decl.params?.length ?? 0))
          fail(
            'E_TEMPLATE',
            `Snippet ${name} takes ${decl.params?.length ?? 0} parameters`,
            loc(sn),
          );
        const params = sn.parameters.map((param: SNode, i: number) => {
          let id = nodeAt(param);
          if (ts.isParameter(id)) id = id.name;
          const t = decl.params![i];
          if (ts.isObjectBindingPattern(id)) {
            // `{#snippet child({ props })}`: fields of the argument record.
            const local = tb.local(`$snippet${i}`, t);
            if (typeof t !== 'object' || !('record' in t))
              fail('E_TEMPLATE', 'Snippet parameters destructure into object fields', loc(param));
            for (const el of id.elements) {
              if (el.dotDotDotToken || el.initializer || !ts.isIdentifier(el.name))
                fail('E_TEMPLATE', 'Snippet parameter patterns are plain field names', loc(param));
              const key = ((el.propertyName ?? el.name) as ts.Identifier).text;
              lower.bindings.set(checker.getSymbolAtLocation(el.name)!, {
                kind: 'member',
                owner: tb,
                local,
                path: [types.fieldIndex((t as { record: number }).record, key, el)],
              });
            }
            return local;
          }
          if (!ts.isIdentifier(id))
            fail('E_TEMPLATE', 'Destructured snippet parameters are object patterns', loc(param));
          const local = tb.local((id as ts.Identifier).text, t);
          lower.bindings.set(checker.getSymbolAtLocation(id)!, { kind: 'local', owner: tb, local });
          return local;
        });
        // The arguments it does not name.
        for (const t of (decl.params ?? []).slice(params.length))
          params.push(tb.local('$unused', t));
        defs.push({ name, ...(params.length ? { params } : {}), body: children(sn.body) });
      }
      const content = n.fragment.nodes.filter((c: SNode) => c.type !== 'SnippetBlock');
      if (content.some((c: SNode) => c.type !== 'Text' || c.data.trim())) {
        // Children content ignores the arguments the child renders it with
        // (bits-ui's Switch.Root renders children with its snippet props).
        const params = (declOf('children', n).params ?? []).map(t => tb.local('$unused', t));
        defs.push({
          name: 'children',
          ...(params.length ? { params } : {}),
          body: children({ nodes: content }),
        });
      }
      // Snippets this component received through its rest props, forwarded
      // where it spreads them: provided to the child when they were to this
      // component.
      if (spreads.some(s => s.rest))
        for (const name of forwardedSlots) {
          const decl = target.slots?.find(d => d.name === name);
          if (!decl) continue;
          if (defs.some(d => d.name === name))
            fail(
              'E_TEMPLATE',
              `${name} is passed both explicitly and through the rest props`,
              loc(n),
            );
          const params = (decl.params ?? []).map((t, i) => tb.local(`$${name}${i}`, t));
          defs.push({
            name,
            ...(params.length ? { params } : {}),
            body: [
              {
                kind: 'slot',
                name,
                ...(params.length
                  ? { args: params.map(p => ({ op: 'local', local: p }) as Expr) }
                  : {}),
              },
            ],
            when: { op: 'slot-provided', name },
          });
        }
      return {
        kind: 'component',
        component: child.index,
        ...(passed.length ? { props: passed } : {}),
        ...(defs.length ? { slots: defs } : {}),
        source: loc(n),
      };
    };
    /**
     * A link's `href` values: following a link is a fragment navigation of
     * this document (`#name`); the values must be known (literals, finite
     * sets), name no element (scrolling to and focusing a fragment's target
     * are not modelled) and not be the document top (`#`, `#top`).
     */
    const linkTargets = (n: SNode) => {
      const at = n.attributes.find((a: SNode) => a.type === 'Attribute' && a.name === 'href');
      for (const a of n.attributes)
        if (
          a.type === 'SpreadAttribute' &&
          mayHold(shapes.of(nodeIn(u, a.expression) as ts.Expression), 'href')
        )
          fail(
            'E_TEMPLATE',
            'A link whose href may come from spread attributes is not supported; pass href explicitly',
            loc(n),
          );
      if (!at) return;
      const values: unknown[] | undefined =
        at.value === true
          ? ['']
          : Array.isArray(at.value)
            ? at.value.length === 1 && at.value[0].type === 'Text'
              ? [at.value[0].data]
              : undefined
            : valueSet({ lower, label: '<a href>' }, exprNode(at.value.expression));
      const what =
        'links are supported to fragments of this document (#name) that name no element, with a finite set of values';
      if (!values) fail('E_TEMPLATE', `The href of this <a> is open: ${what}`, loc(at));
      for (const v of values!) {
        if (v === undefined || v === null) continue;
        const name =
          typeof v === 'string' && v.startsWith('#') ? decodeFragment(v.slice(1)) : undefined;
        if (name === undefined || name === '' || name.toLowerCase() === 'top')
          fail('E_TEMPLATE', `The <a> may link to ${JSON.stringify(v)}: ${what}`, loc(at));
        linkFragments.push({ name: name!, at: loc(at) });
      }
    };
    /**
     * SvelteKit link options and focus: `data-sveltekit-preload-*` other
     * than off (preloading runs loads early, not modelled yet) and
     * `autofocus` (Kit's focus reset focuses it) are rejected.
     */
    const kitAttributes = (n: SNode) => {
      for (const a of n.attributes) {
        if (a.type === 'SpreadAttribute') {
          const shape = shapes.of(nodeIn(u, a.expression) as ts.Expression);
          for (const name of [
            'autofocus',
            'data-sveltekit-preload-data',
            'data-sveltekit-preload-code',
          ])
            if (mayHold(shape, name))
              fail(
                'E_KIT_ATTRIBUTE',
                `Spread attributes that may hold ${name} are unsupported in a SvelteKit app`,
                loc(n),
              );
          continue;
        }
        if (a.type !== 'Attribute') continue;
        if (a.name === 'autofocus')
          fail(
            'E_KIT_ATTRIBUTE',
            'autofocus is unsupported in a SvelteKit app (the focus reset after a navigation focuses it)',
            loc(a),
          );
        if (/^data-sveltekit-preload-(data|code)$/.test(a.name)) {
          const text =
            Array.isArray(a.value) && a.value.length === 1 && a.value[0].type === 'Text'
              ? a.value[0].data
              : undefined;
          if (text !== 'off' && text !== 'false')
            fail(
              'E_KIT_PRELOAD',
              `${a.name} other than "off" or "false" preloads routes (loads run on hover or tap), which is not supported yet`,
              loc(a),
            );
        }
      }
    };
    const element = (n: SNode): Node => {
      if (!TAGS.has(n.name))
        fail('E_TEMPLATE', `<${n.name}> is outside the supported elements`, loc(n));
      // In a SvelteKit app the router follows links (its click listener).
      if (n.name === 'a' && !graph.kit) linkTargets(n);
      if (graph.kit) kitAttributes(n);
      const attrs: { name: string; value: Expr }[] = [];
      const props: { name: string; value: Expr }[] = [];
      const listeners: Listener[] = [];
      const checkbox =
        n.name === 'input' &&
        n.attributes.some(
          (a: SNode) =>
            a.type === 'Attribute' &&
            a.name === 'type' &&
            Array.isArray(a.value) &&
            a.value.length === 1 &&
            a.value[0].type === 'Text' &&
            (a.value[0].data === 'checkbox' || a.value[0].data === 'radio'),
        );
      const radio =
        checkbox &&
        n.attributes.some(
          (a: SNode) => a.type === 'Attribute' && a.name === 'type' && a.value[0].data === 'radio',
        );
      let bound: { event: HandlerEvent; handler: ReturnType<Lowerer['bindHandler']> } | undefined;
      const styles: { name: string; value: Expr }[] = [];
      const classes: { name: string; value: Expr }[] = [];
      let spread: { at: number; value: Expr; shape: Shape } | undefined;
      let reference: number | undefined;
      for (const a of n.attributes) {
        if (a.type === 'Attribute') {
          const name: string = a.name;
          if (/^on[a-z]+$/.test(name)) {
            const event = name.slice(2);
            if (!EVENT_KINDS.includes(event as HandlerEvent))
              fail('E_EVENT', `on${event} handlers are planned for a later milestone`, loc(a));
            if (event === 'resize')
              fail('E_EVENT', 'resize events go to the window (svelte:window onresize)', loc(a));
            if (event === 'change' && !checkbox && n.name !== 'select')
              fail(
                'E_EVENT',
                'onchange is supported on checkboxes and selects (text inputs: oninput)',
                loc(a),
              );
            if (a.value === true || Array.isArray(a.value))
              fail('E_EVENT', 'Event attributes need a handler expression', loc(a));
            listeners.push(handlerFor(a.value.expression, event as HandlerEvent, a));
            continue;
          }
          // SVG attribute names keep their case (viewBox).
          if (name.toLowerCase() !== name && !(SVG_TAGS.includes(n.name) && name === 'viewBox'))
            fail(
              'E_TEMPLATE',
              SVG_TAGS.includes(n.name)
                ? `SVG attribute ${name} is unsupported (viewBox is the only mixed-case one)`
                : `Attribute ${name} must be lowercase`,
              loc(a),
            );
          const values: SNode[] =
            a.value === true ? [] : Array.isArray(a.value) ? a.value : [a.value];
          if (checkbox && name === 'checked') {
            // Svelte sets the checked property.
            let v: Expr = { op: 'lit', value: true };
            if (a.value !== true) {
              if (values.length !== 1 || values[0].type !== 'ExpressionTag')
                fail('E_TEMPLATE', 'checked takes an expression', loc(a));
              const e = exprNode(values[0].expression);
              v = value(e);
              if (typeOf(e, v) !== 'boolean') v = { op: 'to-boolean', arg: v };
            }
            props.push({ name: 'checked', value: v });
            continue;
          }
          if (a.value === true) {
            attrs.push({
              name,
              value: BOOLEAN_ATTRS.has(name)
                ? { op: 'lit', value: true }
                : { op: 'lit', value: '' },
            });
            continue;
          }
          if (values.length === 1 && values[0].type === 'ExpressionTag') {
            const e = exprNode(values[0].expression);
            const v = value(e);
            const t = typeOf(e, v);
            if (name === 'value' && ['input', 'textarea', 'select'].includes(n.name) && !checkbox) {
              props.push({ name, value: t === 'string' ? v : { op: 'to-string', arg: v } });
            } else if (name === 'class' && t === 'string') {
              // Svelte 5 resolves class values with clsx and omits an empty class.
              const temp = tb.local('$class', 'string');
              const read: Expr = { op: 'local', local: temp };
              attrs.push({
                name,
                value: {
                  op: 'with',
                  local: temp,
                  value: v,
                  body: {
                    op: 'cond',
                    test: { op: 'eq', left: read, right: { op: 'lit', value: '' } },
                    then: { op: 'undefined', type: { maybe: 'string' } },
                    else: { op: 'some', value: read },
                  },
                },
              });
            } else if (name === 'class')
              fail(
                'E_TEMPLATE',
                'class values other than strings (clsx objects and arrays) are planned for M6',
                loc(a),
              );
            else if (BOOLEAN_ATTRS.has(name))
              attrs.push({ name, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } });
            else if (typeof t === 'object' && 'maybe' in t)
              attrs.push({ name, value: maybeAttribute(v, t, a) });
            else attrs.push({ name, value: t === 'string' ? v : { op: 'to-string', arg: v } });
            continue;
          }
          let joined: Expr | undefined;
          for (const v of values) {
            const part: Expr =
              v.type === 'Text' ? { op: 'lit', value: v.data } : display(exprNode(v.expression));
            joined = joined ? { op: 'concat', left: joined, right: part } : part;
          }
          attrs.push({ name, value: joined ?? { op: 'lit', value: '' } });
        } else if (a.type === 'BindDirective' && a.name === 'this') {
          const target = exprNode(a.expression);
          const b = ts.isIdentifier(target) ? lower.binding(target) : undefined;
          if (
            b?.kind !== 'cell' ||
            JSON.stringify(cells[b.cell].type) !== JSON.stringify({ maybe: 'element' })
          )
            fail('E_TEMPLATE', 'bind:this needs a component variable of an element type', loc(a));
          reference = (b as { cell: number }).cell;
        } else if (a.type === 'BindDirective' && a.name === 'group') {
          // bind:group on a radio button: checked when the bound value is the
          // button's, which a change writes (Svelte's binding group).
          const own = n.attributes.find((x: SNode) => x.type === 'Attribute' && x.name === 'value');
          const text =
            own &&
            Array.isArray(own.value) &&
            own.value.length === 1 &&
            own.value[0].type === 'Text'
              ? own.value[0].data
              : undefined;
          if (!radio || text === undefined)
            fail(
              'E_TEMPLATE',
              'bind:group is supported on radio buttons with a literal value',
              loc(a),
            );
          const target = exprNode(a.expression);
          const read = value(target);
          if (typeOf(target, read) !== 'string')
            fail('E_TEMPLATE', 'bind:group needs an assignable string value', loc(a));
          const lit: Expr = { op: 'lit', value: text! };
          props.push({ name: 'checked', value: { op: 'eq', left: read, right: lit } });
          bound = {
            event: 'change',
            handler: lower.bindHandler(target, COMPONENT, 'change', tb, lit),
          };
        } else if (a.type === 'BindDirective') {
          const kind =
            a.name === 'value' && ['input', 'textarea', 'select'].includes(n.name) && !checkbox
              ? 'string'
              : a.name === 'checked' && checkbox
                ? 'boolean'
                : undefined;
          if (!kind) fail('E_TEMPLATE', `bind:${a.name} is planned for M5`, loc(a));
          const target = exprNode(a.expression);
          const functions =
            ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken;
          if (functions)
            fail(
              'E_TEMPLATE',
              `Function bindings (bind:${a.name}={get, set}) are planned for a later milestone`,
              loc(a),
            );
          if (ts.isArrowFunction(target) || ts.isFunctionExpression(target))
            fail('E_TEMPLATE', `bind:${a.name} needs an assignable ${kind} value`, loc(a));
          const read = value(target);
          const select = n.name === 'select';
          // A text control bound to a nullable string shows `value ?? ''`
          // and writes strings (Svelte's bind_value; bits-ui's hidden input).
          const nullable =
            kind === 'string' &&
            !select &&
            JSON.stringify(typeOf(target, read)) === JSON.stringify({ maybe: 'string' });
          if (!nullable && JSON.stringify(typeOf(target, read)) !== JSON.stringify(kind))
            fail('E_TEMPLATE', `bind:${a.name} needs an assignable ${kind} value`, loc(a));
          props.push({
            name: a.name,
            value: nullable ? { op: 'nullish', left: read, right: { op: 'lit', value: '' } } : read,
          });
          // A select's value binding follows its change event (Svelte's
          // bind_select_value), reading the chosen option's value.
          const event: HandlerEvent = kind === 'string' && !select ? 'input' : 'change';
          const written: Expr | undefined = select
            ? { op: 'builtin', name: 'event.value', args: [{ op: 'event' }], type: 'string' }
            : nullable
              ? { op: 'some', value: { op: 'payload' } }
              : undefined;
          bound = { event, handler: lower.bindHandler(target, COMPONENT, event, tb, written) };
        } else if (a.type === 'StyleDirective') {
          if (a.modifiers?.length)
            fail(
              'E_TEMPLATE',
              'Important style directives are planned for a later milestone',
              loc(a),
            );
          if (a.value === true)
            fail(
              'E_TEMPLATE',
              `Write style:${a.name}={${a.name}} (the shorthand is planned for later)`,
              loc(a),
            );
          let v: Expr;
          const parts = Array.isArray(a.value) ? a.value : [a.value];
          if (parts.length === 1 && parts[0].type === 'ExpressionTag') {
            const e = exprNode(parts[0].expression);
            v = value(e);
            const t = typeOf(e, v);
            const text =
              t === 'string' || (typeof t === 'object' && 'maybe' in t && t.maybe === 'string');
            if (!text) v = { op: 'to-string', arg: v };
          } else {
            let joined: Expr | undefined;
            for (const part of parts) {
              const x: Expr =
                part.type === 'Text'
                  ? { op: 'lit', value: part.data }
                  : display(exprNode(part.expression));
              joined = joined ? { op: 'concat', left: joined, right: x } : x;
            }
            v = joined ?? { op: 'lit', value: '' };
          }
          styles.push({ name: a.name, value: v });
        } else if (a.type === 'ClassDirective') {
          const e = exprNode(a.expression);
          const v = value(e);
          classes.push({
            name: a.name,
            value: typeOf(e, v) === 'boolean' ? v : { op: 'to-boolean', arg: v },
          });
        } else if (a.type === 'SpreadAttribute') {
          if (spread) fail('E_TEMPLATE', 'One spread per element is supported', loc(a));
          const e = exprNode(a.expression);
          // A bag, or a plain record spread as its fields (bits-ui's
          // `inputState.props`, typed by its declaration file).
          const v = lower.bagValue(e, tb);
          if (lower.irType(v, tb) !== 'attrs')
            fail(
              'E_TEMPLATE',
              'Spread attributes take attribute bags (rest props, props objects)',
              loc(a),
            );
          spread = { at: n.attributes.indexOf(a), value: v, shape: shapes.of(e) };
        } else fail('E_TEMPLATE', `${a.type} is planned for a later milestone`, loc(a));
      }
      // A dynamic style, or any style with style: directives, is managed
      // through the CSSOM as Svelte's set_style does; a static one stays a
      // literal attribute.
      let styleText: Expr | undefined;
      {
        const i = attrs.findIndex(a => a.name === 'style');
        const dynamic = i >= 0 && attrs[i].value.op !== 'lit';
        if (styles.length || dynamic) {
          styleText = i >= 0 ? attrs[i].value : { op: 'lit', value: '' };
          if (i >= 0) attrs.splice(i, 1);
        }
      }
      // With class toggles the class value is a string (absent: empty), as
      // Svelte passes it to set_class.
      if (classes.length) {
        const i = attrs.findIndex(a => a.name === 'class');
        if (i >= 0 && attrs[i].value.op === 'with')
          attrs[i] = { name: 'class', value: (attrs[i].value as { value: Expr }).value };
        if (i >= 0 && lower.irType(attrs[i].value, tb) !== 'string')
          fail('E_TEMPLATE', 'With class: directives, class must be a string', loc(n));
      }
      // With a spread, the element's own attributes that the bag may also
      // hold (frontend/bags.ts) join it in source order (a later one wins).
      let bag: Expr | undefined;
      if (spread) {
        const shape = spread.shape;
        const position = (name: string) =>
          n.attributes.findIndex((a: SNode) => a.type === 'Attribute' && a.name === name);
        const before: AttrItem[] = [];
        const after: AttrItem[] = [];
        for (const a of [...attrs])
          if (mayHold(shape, a.name)) {
            (position(a.name) < spread.at ? before : after).push({ name: a.name, value: a.value });
            attrs.splice(attrs.indexOf(a), 1);
          }
        for (const l of listeners)
          if (mayHold(shape, `on${l.event}`))
            fail(
              'E_TEMPLATE',
              `on${l.event} is both on the element and possibly in the spread attributes`,
              loc(n),
            );
        bag =
          before.length || after.length
            ? { op: 'attrs', items: [...before, { spread: spread.value }, ...after] }
            : spread.value;
      }
      if (bound) {
        // A binding listens on the element itself, before the delegated
        // handler for the same event, so the bound state is written first.
        const own = listeners.find(l => l.event === bound.event);
        const { args, ...h } = bound.handler;
        if (!own) {
          handlers.push({ event: bound.event, ...h, source: loc(n) });
          listeners.push({
            event: bound.event,
            handler: handlers.length - 1,
            ...(args?.length ? { args } : {}),
          });
        } else {
          const merged = mergeHandlers(
            { ...h, args },
            { ...handlers[own.handler], args: own.args },
          );
          handlers[own.handler] = { event: bound.event, ...merged.handler, source: loc(n) };
          own.args = merged.args;
          if (!own.args?.length) delete own.args;
        }
      }
      return {
        kind: 'element',
        tag: n.name,
        ...(attrs.length ? { attrs } : {}),
        ...(props.length ? { props } : {}),
        ...(listeners.length ? { listeners } : {}),
        ...(reference !== undefined ? { ref: reference } : {}),
        ...(bag ? { spread: bag, spreadBooleanText: true as const } : {}),
        ...(classes.length ? { classes } : {}),
        ...(styleText ? { styleText } : {}),
        ...(styles.length ? { styles } : {}),
        ...(n.fragment.nodes.length ? { children: children(n.fragment, n.name) } : {}),
        source: loc(n),
      };
    };
    const template = children(u.ast.fragment);
    return {
      name: path.basename(u.file, '.svelte'),
      cells,
      handlers,
      template,
      ...(tb.locals.length ? { templateLocals: tb.locals } : {}),
      ...(slots.length ? { slots } : {}),
      ...(effects.length ? { effects } : {}),
      ...(mountSites.length ? { mounts: mountSites } : {}),
    };
  }

  const capabilities = ['dom', 'css', 'window', 'click', 'keyboard'];
  if (components.some(c => c.handlers.some(h => h.event === 'input')))
    capabilities.push('text-input');
  const ir: Program = {
    schema: 4,
    meta: {
      title: graph.config.title,
      sourceHash: graph.hash,
      frontend: {
        adapter: 'svelte',
        version: 3,
        packages: graph.tooling.packages,
        tools: { typescript: ts.version },
      },
      provenance: graph.manifest,
      mappings: packMappings(lower),
    },
    ...(graph.config.renderer ? { renderer: graph.config.renderer } : {}),
    capabilities,
    styles: { css: graph.css, assets: graph.assets },
    records: types.records,
    functions: lower.functions,
    globals: lower.globals,
    components,
    root: units.get(rootFile!)!.index,
    // Delegated listeners and microtask flushes (the defaults); teardowns
    // read state as it was before the batch that destroys or re-runs them.
    schedule: { cleanupReadsPrevious: true },
  };
  // A bound optional prop the child writes: only present values (`some`),
  // which the parent's variable of the present type can hold.
  // A `bind:` setter passes on what its own child writes.
  const writesPresent = (component: number, cell: number, seen: Set<string>): boolean => {
    const id = `${component}:${cell}`;
    if (seen.has(id)) return true;
    seen.add(id);
    let absent = false;
    const visit = (v: unknown, fn: number | undefined) => {
      if (absent || !v || typeof v !== 'object') return;
      const x = v as { op?: string; cell?: number; value?: { op?: string; local?: number } };
      if (x.op === 'set' && x.cell === cell && x.value?.op !== 'some') {
        const follows = fn !== undefined ? bindSetters.get(fn) : undefined;
        if (
          !follows ||
          x.value?.op !== 'local' ||
          x.value.local !== 0 ||
          !writesPresent(follows.component, follows.cell, seen)
        )
          absent = true;
      }
      for (const c of Array.isArray(v) ? v : Object.values(v)) visit(c, fn);
    };
    lower.functions.forEach((f, i) => f?.component === component && visit(f.body, i));
    for (const h of components[component].handlers ?? []) visit(h, undefined);
    return !absent;
  };
  for (const w of presentWrites) {
    if (!writesPresent(w.component, w.cell, new Set()))
      fail(
        'E_TEMPLATE',
        `bind:${w.name} binds a variable that cannot be undefined to a prop its component may set to undefined; declare the variable with undefined in its type`,
        w.at,
      );
  }
  // SvelteMap reads only in derived values (frontend/svelte-reactivity.ts).
  const mapRead = checkMapReads(lower);
  if (mapRead) {
    const message = `A SvelteMap is read outside a derived value (in ${mapRead.caller}): its reads depend on the whole map, where Svelte's depend on one key, so an effect reading it would run where Svelte's does not; read it in a $derived value`;
    if (mapRead.at) tsFail(mapRead.at, 'E_REACTIVITY', message);
    fail('E_REACTIVITY', message, mapRead.source);
  }
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  return { ir };
}

/**
 * One handler running `a` then `b`: params are a's then b's, locals a's then
 * b's (each body renumbered into the combined index space).
 */
function mergeHandlers(
  a: { params?: Handler['params']; locals?: Handler['locals']; body: Stmt[]; args?: Expr[] },
  b: { params?: Handler['params']; locals?: Handler['locals']; body: Stmt[]; args?: Expr[] },
): { handler: Omit<Handler, 'event'>; args?: Expr[] } {
  const aP = a.params?.length ?? 0;
  const bP = b.params?.length ?? 0;
  const aL = a.locals?.length ?? 0;
  const bodyA = remapLocals(a.body, i => (i < aP ? i : i + bP));
  const bodyB = remapLocals(b.body, i => (i < bP ? i + aP : i + aP + aL));
  const params = [...(a.params ?? []), ...(b.params ?? [])];
  const locals = [...(a.locals ?? []), ...(b.locals ?? [])];
  const args = [...(a.args ?? []), ...(b.args ?? [])];
  return {
    handler: {
      ...(params.length ? { params } : {}),
      ...(locals.length ? { locals } : {}),
      body: [...bodyA, ...bodyB],
    },
    ...(args.length ? { args } : {}),
  };
}

/**
 * A URL fragment percent-decoded as UTF-8. A malformed run of escapes is
 * kept as written (the runtime checks the targets of followed links again).
 */
function decodeFragment(s: string): string {
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, run => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** The IR type of a prop that takes `values` (strings or booleans, possibly nullish). */
function typeOfValues(values: unknown[]): Type | undefined {
  const present = values.filter(v => v !== undefined && v !== null);
  let base: Type;
  if (present.every(v => typeof v === 'string')) base = 'string';
  else if (present.every(v => typeof v === 'boolean')) base = 'boolean';
  else return undefined;
  return present.length < values.length ? { maybe: base } : base;
}

/** Whether `sf` assigns to `sym` (`x = …`, `x += …`, `x++`, destructuring targets). */
function assigned(checker: ts.TypeChecker, sf: ts.SourceFile, sym: ts.Symbol): boolean {
  let found = false;
  const targets = (n: ts.Node, f: (id: ts.Identifier) => void) => {
    if (ts.isIdentifier(n)) f(n);
    else ts.forEachChild(n, c => targets(c, f));
  };
  const visit = (n: ts.Node) => {
    if (found) return;
    let target: ts.Node | undefined;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      target = n.left;
    else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    )
      target = n.operand;
    if (target)
      targets(target, id => {
        if (id.text === sym.name && checker.getSymbolAtLocation(id) === sym) found = true;
      });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Widen an initial value to the cell type (T → Maybe<T>). */
function coerceInit(v: Expr, from: Type, to: Type, records: RecordType[]): Expr {
  // A null or undefined default takes the prop's type.
  if ((v.op === 'null' || v.op === 'undefined') && typeof to === 'object' && 'maybe' in to)
    return { op: v.op, type: to };
  if (typeof to === 'object' && 'maybe' in to && !(typeof from === 'object' && 'maybe' in from))
    return upcastTo({ op: 'some', value: v }, { maybe: from }, to, records);
  // A class instance where a class reference is expected.
  return upcastTo(v, from, to, records);
}

const isReference = (t: Type): boolean =>
  typeof t === 'object' &&
  ('array' in t ||
    'record' in t ||
    'class' in t ||
    'classes' in t ||
    'map' in t ||
    'set' in t ||
    ('maybe' in t && isReference(t.maybe)));

/** The initialiser of a prop without a default: `undefined` if nullable, otherwise required. */
function required(t: Type): Expr {
  if (typeof t === 'object' && 'maybe' in t) return { op: 'undefined', type: t };
  return { op: 'unwrap', value: { op: 'undefined', type: { maybe: t } } };
}
const isRequired = (init: Expr) => init.op === 'unwrap' && init.value.op === 'undefined';

/** `String(v ?? '')` for a nullable value, as Svelte renders text. */
export function maybeText(lower: Lowerer, v: Expr, t: Type): Expr {
  const fn = lower.reserve();
  lower.functions[fn] = {
    name: 'text$maybe',
    params: [{ name: '$v', type: t }],
    locals: [],
    result: 'string',
    body: [
      {
        op: 'if',
        test: {
          op: 'builtin',
          name: 'maybe.is-nullish',
          args: [{ op: 'local', local: 0 }],
          type: 'boolean',
        },
        then: [{ op: 'return', value: { op: 'lit', value: '' } }],
      },
      {
        op: 'return',
        value: { op: 'to-string', arg: { op: 'unwrap', value: { op: 'local', local: 0 } } },
      },
    ],
  };
  return { op: 'call', function: fn, args: [v] };
}
