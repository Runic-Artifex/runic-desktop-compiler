// Svelte 5 (runes) adapter on the shared language layer (docs/design/M2-VALUES.md,
// docs/design/M3-COMPONENTS.md). Framework semantics only: runes → cells and
// derived functions with immediate reads and writes, `$props` → prop cells,
// child components → instances, `{#each}` → lists, template → IR nodes,
// events → handlers. Ordinary code goes through frontend/language.ts.
import ts from 'typescript';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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
  StyleGuard,
  Lowering,
  ImageUrl,
} from '../ir.ts';
import { EVENT_KINDS, IMAGE_EVENT_KINDS } from '../ir.ts';
import {
  FnBuilder,
  Lowerer,
  remapLocals,
  skipParens,
  type HandlerEvent,
  type Hooks,
} from '../language.ts';
import { createProgram, RUNES } from '../program.ts';
import { sameType, TypeMapper } from '../types.ts';
import { lowerModules, ModuleResolver } from '../modules.ts';
import {
  annotate,
  displayPath,
  DTS_PREFIX,
  exportAllDeclarations,
  implementationOf,
  inferFields,
  portModule,
  reachedPackageModules,
  type PackageModule,
} from '../package-modules.ts';
import { PropDomains, type PropDecl, type Site, type SiteValue } from '../domains.ts';
import { svelteReactivityImport } from '../svelte-reactivity.ts';
import { svelteContextImport } from '../svelte-context.ts';
import { openOrigin, valueSet } from '../packs/choice.ts';
import { ABSENT, BagShapes, emptyShape, mayHold, openShape, union, type Shape } from '../bags.ts';
import { packageBindings } from '../package-bindings.ts';
import { componentBinding, componentGlobal } from '../component-values.ts';
import { jsonBinding, reexportsJson } from '../json-modules.ts';
import { Fragments } from '../html-fragments.ts';
import {
  componentValues,
  dynamicSites,
  requiredProps,
  rewriteGlobs,
  type GlobCall,
} from './svelte-dynamic.ts';
import { arrayElement, containsDyn, maybeInner, upcastTo } from '../irtype.ts';
import {
  bindPackImport,
  packExport,
  packFor,
  packMappings,
  packPorts,
  PackError,
  usePack,
  type Edge,
  type Pack,
  type PackAttr,
  type PackComponent,
} from '../packs.ts';
import { FIELDSET_TAGS, FIELDSET_DISABLED, INERT_TAGS, TABLE_TAGS } from '../elements.ts';

// The svelte/compiler AST is untyped here; nodes are plain objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SNode = any;

/** `svelte` exports modules may import. */
const MODULE_SVELTE = ['tick', 'untrack', 'settled', 'setContext', 'getContext', 'hasContext'];

/** Inline SVG elements (runic-ir's SVG_TAGS). */
const SVG_TAGS = ['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect'];

const TAGS = new Set([
  ...TABLE_TAGS,
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
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'form',
  // M6 images: `src` values pinned at build time (`imageSources` below).
  'img',
  // Fieldsets without `disabled` (`fieldsetAttributes` below).
  ...FIELDSET_TAGS,
  ...SVG_TAGS,
  ...INERT_TAGS,
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
  'novalidate',
  'formnovalidate',
  'open',
]);

/**
 * The type parameters of a generic component (`<script lang="ts"
 * generics="T extends C = D">`) with their defaults, and the module
 * script's type aliases they shadow (offsets in the original file).
 */
function genericDefaults(u: Unit): { params: [string, string][]; shadowed: [number, number][] } {
  const attr = (u.ast.instance?.attributes ?? []).find((a: SNode) => a.name === 'generics');
  if (!attr) return { params: [], shadowed: [] };
  const text: string = Array.isArray(attr.value)
    ? attr.value.map((v: SNode) => v.data).join('')
    : '';
  // (The type parameter list of a type alias parses it.)
  const parsed = ts.createSourceFile(
    'generics.ts',
    `type __R<${text}> = 0;`,
    ts.ScriptTarget.Latest,
  );
  const alias = parsed.statements[0];
  const params: [string, string][] = [];
  for (const p of (alias && ts.isTypeAliasDeclaration(alias) ? alias.typeParameters : undefined) ??
    []) {
    if (!p.default)
      throw new Diagnostic(
        'E_TEMPLATE',
        `The generic parameter ${p.name.text} needs a default: a generic component has one instantiation, its parameters' defaults`,
        locate(u.original, attr.start, u.rel),
      );
    params.push([p.name.text, p.default!.getText(parsed)]);
  }
  const shadowed: [number, number][] = [];
  if (u.moduleLength) {
    const code = u.original.slice(u.moduleStart, u.moduleStart + u.moduleLength);
    const sf = ts.createSourceFile('module.ts', code, ts.ScriptTarget.Latest);
    for (const st of sf.statements)
      if (ts.isTypeAliasDeclaration(st) && params.some(([n]) => n === st.name.text))
        shadowed.push([u.moduleStart + st.getStart(sf), u.moduleStart + st.end]);
  }
  return { params, shadowed };
}

interface Graph {
  root: string;
  /** A SvelteKit app (compiler/adapters/kit-app.mjs). */
  kit?: KitGraph;
  entry: string;
  hash: string;
  css: string;
  styleGuards?: StyleGuard[];
  assets: { path: string; sha256: string; bytes: number; mime: string }[];
  manifest: unknown;
  config: { title: string; renderer?: 'cpu' | 'gpu'; dynamicValues?: boolean };
  modules: Map<
    string,
    {
      code: string;
      imports: Edge[];
      package?: { name: string; version: string; dir: string };
      globs?: GlobCall[];
    }
  >;
  tooling: {
    packages: Record<string, string>;
    compiler: {
      parse: (src: string, opts: object) => SNode;
      compile: (
        src: string,
        opts: object,
      ) => { js: { code: string }; css: { code: string } | null };
    };
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
  /** The strings of the build-time data tables (server data, endpoint responses). */
  htmlStrings?: string[];
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

export async function lowerSvelte(graph: Graph): Promise<Lowering> {
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
  /** HTML parsed at build time for `{@html}` (frontend/html-fragments.ts). */
  const fragments = new Fragments();
  const order: Unit[] = [];
  /** Optional props bound to variables of the present type (`bind:` on components). */
  const presentWrites: { component: number; cell: number; name: string; at: Source }[] = [];
  /** `bind:` setters (function index) by the child component and prop cell they follow. */
  const bindSetters = new Map<number, { component: number; cell: number }>();
  /**
   * The truth of an `{#if}` test that the values of props decide at every
   * site (shadcn-svelte's Input: `{#if type === "file"}` where no site
   * passes `type`): a prop, its negation, comparisons of it with literals,
   * and `&&`/`||` of such tests; undefined otherwise. Reading a prop has no
   * effect, so a decided test leaves the other branch unrendered.
   */
  const decidedTest = (u: Unit, test: SNode): boolean | undefined => {
    const e = nodeIn(u, test) as ts.Expression;
    const K = ts.SyntaxKind;
    const values = (x: ts.Expression): unknown[] | undefined => {
      x = skipParens(x);
      if (ts.isStringLiteralLike(x)) return [x.text];
      if (ts.isNumericLiteral(x)) return [Number(x.text)];
      if (x.kind === K.TrueKeyword) return [true];
      if (x.kind === K.FalseKeyword) return [false];
      if (x.kind === K.NullKeyword) return [null];
      if (!ts.isIdentifier(x)) return undefined;
      if (x.text === 'undefined' && !checker.getSymbolAtLocation(x)?.valueDeclaration)
        return [undefined];
      const sym = checker.getSymbolAtLocation(x);
      // (Not a snippet or function prop: sites pass snippets as content,
      // which the prop domains do not see.)
      const t = sym && checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(sym, x));
      if (!sym || !t || t.getCallSignatures().length) return undefined;
      return lower.domains?.values(sym);
    };
    const truth = (x: ts.Expression): boolean | undefined => {
      x = skipParens(x);
      if (ts.isPrefixUnaryExpression(x) && x.operator === K.ExclamationToken) {
        const v = truth(x.operand);
        return v === undefined ? undefined : !v;
      }
      if (ts.isBinaryExpression(x)) {
        const op = x.operatorToken.kind;
        if (op === K.AmpersandAmpersandToken || op === K.BarBarToken) {
          const l = truth(x.left);
          const r = truth(x.right);
          if (op === K.AmpersandAmpersandToken)
            return l === false || r === false ? false : l && r ? true : undefined;
          return l === true || r === true ? true : l === false && r === false ? false : undefined;
        }
        const strict = op === K.EqualsEqualsEqualsToken || op === K.ExclamationEqualsEqualsToken;
        const loose = op === K.EqualsEqualsToken || op === K.ExclamationEqualsToken;
        if (!strict && !loose) return undefined;
        const a = values(x.left);
        const b = values(x.right);
        if (!a || !b) return lower.buildTimeTruth(x);
        const same = (p: unknown, q: unknown) =>
          strict ? p === q : p === q || (p == null && q == null);
        const results = a.flatMap(p => b.map(q => same(p, q)));
        const negate = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
        if (results.every(r => r)) return !negate;
        if (results.every(r => !r)) return negate;
        return undefined;
      }
      // A snippet prop every site passes (or none does): a function is truthy.
      if (ts.isIdentifier(x)) {
        const decl = checker.getSymbolAtLocation(x)?.valueDeclaration;
        const passed = decl && lower.unions.functionPropPassed(decl);
        if (passed !== undefined) return passed;
      }
      const v = values(x);
      // (Otherwise what the lowering knows at build time: a member of a
      // union the values reaching it narrowed, `Lowerer.buildTimeTruth`.)
      if (!v || !v.length) return lower.buildTimeTruth(x);
      if (v.every(Boolean)) return true;
      if (v.every(y => !y)) return false;
      return undefined;
    };
    return truth(e);
  };
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
  /**
   * Whether a component's `<style>` scopes anything: compiled with a marker
   * as its hash, the marker appears in the CSS (scoped selectors and
   * keyframes) or in the code (the scoping class on elements).
   */
  const scopedStyles = (u: Unit) => {
    const marker = 'runic-scoped-css';
    const out = graph.tooling.compiler.compile(u.original, {
      filename: u.file,
      generate: 'client',
      css: 'external',
      cssHash: () => marker,
      runes: true,
      dev: false,
    });
    return out.js.code.includes(marker) || !!out.css?.code.includes(marker);
  };
  /** A reached component: its checks, and the components its template instantiates. */
  const reach = (u: Unit) => {
    const loc = (n: SNode) => locate(u.original, n.start ?? 0, u.rel);
    // Tags naming a component value (`<Markdown />`): a copy per candidate.
    dynamicSites(
      u,
      name =>
        u.children.has(name) ||
        u.packs.has(name) ||
        (r => r !== undefined && r.kind !== 'binding')(resolver.dotted(u.file, name)),
      componentFiles,
      file => requiredProps(unitOfFile(file)),
      offset => locate(u.original, offset, u.rel),
    );
    const { ast } = u;
    // Component styles whose rules are all `:global(…)` join the stylesheet
    // Vite emits, where they are checked with the rest (compiler/collect.mjs).
    // Scoped rules would need the compiler's scoping class on the elements
    // they match, which lowering does not add.
    if (ast.css && scopedStyles(u))
      fail(
        'E_TEMPLATE',
        'Scoped component styles are unsupported; use :global(…) rules or import local CSS instead',
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
  for (const id of graph.modules.keys())
    if (id.endsWith('.svelte') && id.startsWith(root + path.sep)) unitOfFile(id);
  // Components used as values (frontend/adapters/svelte-dynamic.ts).
  const componentFiles = componentValues(
    units.values(),
    graph.modules,
    id => units.has(id),
    (file, name) => {
      const ref = resolver.dotted(file, name);
      return ref?.kind === 'component' ? ref.file : undefined;
    },
    root,
  );
  visit(rootFile!, []);

  // A component's instance bound to a variable nothing else names
  // (shadcn-svelte's Command wrapper: `bind:this={api}` of a prop `api =
  // $bindable(null)` no site binds): the binding is unobservable, and is
  // left out. (A name in the script beyond its declaration, in the
  // template, or a site binding the prop keeps it, and its diagnostic.)
  for (const u of order) {
    const binds: { n: SNode; a: SNode }[] = [];
    walkTemplate(u.ast.fragment, n => {
      if (n.type === 'Component')
        for (const a of n.attributes ?? [])
          if (
            a.type === 'BindDirective' &&
            a.name === 'this' &&
            a.expression?.type === 'Identifier'
          )
            binds.push({ n, a });
    });
    for (const { n, a } of binds) {
      const name: string = a.expression.name;
      let named = 0;
      walkTemplate(u.ast.fragment, x => {
        if (x.type === 'Identifier' && x.name === name && x !== a.expression) named++;
      });
      if (named) continue;
      if (
        u.moduleLength &&
        new RegExp(`\\b${name}\\b`).test(
          u.original.slice(u.moduleStart, u.moduleStart + u.moduleLength),
        )
      )
        continue;
      const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
      const sf = ts.createSourceFile(u.file + '.ts', script, ts.ScriptTarget.Latest, true);
      let declared: { prop?: string } | undefined;
      const visitScript = (x: ts.Node) => {
        if (ts.isIdentifier(x) && x.text === name) {
          const at = x.parent;
          // (The name of a property of a type: `{ api?: … }`.)
          if (ts.isPropertySignature(at) && at.name === x) return;
          const props =
            ts.isBindingElement(at) &&
            at.name === x &&
            ts.isObjectBindingPattern(at.parent) &&
            ts.isVariableDeclaration(at.parent.parent) &&
            runeName(at.parent.parent.initializer) === '$props';
          const state =
            ts.isVariableDeclaration(at) &&
            at.name === x &&
            ['$state', '$state.raw'].includes(runeName(at.initializer) ?? '');
          if (!declared && (props || state))
            declared = props
              ? {
                  prop:
                    ((at as ts.BindingElement).propertyName as ts.Identifier | undefined)?.text ??
                    name,
                }
              : {};
          else named++;
        }
        ts.forEachChild(x, visitScript);
      };
      visitScript(sf);
      if (named || !declared) continue;
      const prop = declared.prop;
      const boundBySite =
        prop !== undefined &&
        order.some(o => {
          let found = false;
          walkTemplate(o.ast.fragment, x => {
            if (
              x.type === 'Component' &&
              o.children.get(x.name) === u.file &&
              x.attributes?.some((b: SNode) => b.type === 'BindDirective' && b.name === prop)
            )
              found = true;
          });
          return found;
        });
      if (!boundBySite) n.attributes = n.attributes.filter((b: SNode) => b !== a);
    }
  }

  // Rest props (docs/design/M5-PLATFORM.md): each component's declared prop
  // names and rest binding, and the names its rest bag may hold, gathered
  // from every call site and through forwarding (`<Child {...rest} />`).
  const decls = new Map<string, { declared: Set<string>; rest?: string; restBags: Set<string> }>();
  for (const u of order) {
    const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
    const sf = ts.createSourceFile(u.file + '.ts', script, ts.ScriptTarget.Latest, true);
    const d: { declared: Set<string>; rest?: string; restBags: Set<string> } = {
      declared: new Set(),
      restBags: new Set(),
    };
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
    // Constants holding the rest props merged with other bags
    // (`mergedProps = $derived(mergeProps(restProps, arrowState.props))`,
    // bits-ui's FloatingLayerArrow): spreading them passes the rest props on.
    if (d.rest)
      for (const stmt of sf.statements)
        if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & ts.NodeFlags.Const)
          for (const v of stmt.declarationList.declarations) {
            let init = v.initializer;
            if (
              init &&
              ts.isCallExpression(init) &&
              init.expression.getText(sf) === '$derived' &&
              init.arguments.length === 1
            )
              init = init.arguments[0];
            if (
              ts.isIdentifier(v.name) &&
              init &&
              ts.isCallExpression(init) &&
              ts.isIdentifier(init.expression) &&
              init.expression.text === 'mergeProps' &&
              init.arguments.some(
                a => ts.isIdentifier(a) && (a.text === d.rest || d.restBags.has(a.text)),
              )
            )
              d.restBags.add(v.name.text);
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
  /** Snippets sites pass on as attributes (`{children}`), by site (`snippetAttributes`). */
  const snippetAttrs = new Map<SNode, string[]>();
  /** The snippets a site passes (`children` for content). */
  const snippetsPassed = (n: SNode): string[] => {
    const out: string[] = n.fragment.nodes
      .filter((c: SNode) => c.type === 'SnippetBlock')
      .map((c: SNode) => c.expression.name);
    out.push(...(snippetAttrs.get(n) ?? []));
    if (
      n.fragment.nodes.some(
        (c: SNode) => c.type !== 'SnippetBlock' && !(c.type === 'Text' && !c.data.trim()),
      )
    )
      out.push('children');
    return out;
  };
  /**
   * Whether attribute `a` spreads the rest props of the component `file`
   * (or a constant merging them with other bags).
   */
  const spreadsRest = (file: string, a: SNode) =>
    a.type === 'SpreadAttribute' &&
    a.expression.type === 'Identifier' &&
    (a.expression.name === decls.get(file)?.rest ||
      !!decls.get(file)?.restBags.has(a.expression.name));
  /**
   * Whether a site of component `file` may pass both snippets `a` and `b`
   * (as `{#snippet}` blocks or content, or through its own rest props).
   */
  const sitePassesBoth = (file: string, a: string, b: string): boolean => {
    let found = false;
    for (const u of order)
      walkTemplate(u.ast.fragment, n => {
        if (found || n.type !== 'Component' || u.children.get(n.name) !== file) return;
        const passed = new Set(snippetsPassed(n));
        if (n.attributes.some((x: SNode) => spreadsRest(u.file, x)))
          for (const s of restSlots.get(u.file) ?? []) passed.add(s);
        found = passed.has(a) && passed.has(b);
      });
    return found;
  };
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
  const forwardRestSlots = () => {
    for (let changed = true; changed;) {
      changed = false;
      for (const { from, to } of slotForwards)
        for (const s of restSlots.get(from) ?? [])
          if (!decls.get(to)!.declared.has(s) && restSlots.get(to) && !restSlots.get(to)!.has(s)) {
            restSlots.get(to)!.add(s);
            changed = true;
          }
    }
  };
  forwardRestSlots();

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
    // A generic component (`<script generics="T = never">`) has one
    // instantiation in the program, as generic classes do: each type
    // parameter is its default. A value of another instantiation fails the
    // IR's type checks where the types differ. (svelte-package declares
    // `type T = unknown` in the module script for its declaration files;
    // the instance script's parameter shadows it, so it is left out.)
    const generics = genericDefaults(u);
    {
      let at = u.moduleStart;
      for (const [start, end] of generics.shadowed) {
        copy(at, start);
        s += ' '.repeat(end - start);
        at = end;
      }
      copy(at, u.moduleStart + u.moduleLength);
    }
    s += '\n';
    for (const [name, type] of generics.params) s += `type ${name} = ${type};\n`;
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
      // `{@const}` declarations hold for their whole block (Svelte hoists them).
      for (const n of f?.nodes ?? [])
        if (n.type === 'ConstTag') {
          u.starts.set(n.declaration, s.length);
          copy(n.declaration.start, n.declaration.end);
          s += ';\n';
        }
      for (const n of f?.nodes ?? []) {
        if (n.type === 'ExpressionTag') expr(n.expression);
        else if (n.type === 'IfBlock') {
          // As svelte-check types it: the test narrows its branches
          // (bits-ui's Select root reads its value box as an array inside
          // `{#if Array.isArray(…)}`).
          s += 'if ';
          inline(n.test);
          s += ' {\n';
          fragment(n.consequent);
          s += '} else {\n';
          fragment(n.alternate);
          s += '}\n';
        } else if (n.type === 'EachBlock') {
          s += 'for (const ';
          // `{#each items, i}` and `{#each items}` bind no item (context null).
          if (n.context) {
            u.starts.set(n.context, s.length);
            copy(n.context.start, n.context.end);
          } else s += '__runicEachItem';
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
        } else if (n.type === 'RunicDynamic') {
          // A dynamic tag: its value, and a copy of the tag per candidate.
          expr(n.nameNode);
          fragment({ nodes: n.cases });
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
            } else if (a.type === 'Attribute') {
              // Text (a string; mixed with expressions, typed below) and
              // bare attributes (true): the values the site passes.
              const text = Array.isArray(a.value) && a.value.every((v: SNode) => v.type === 'Text');
              s += `${JSON.stringify(a.name)}: ${
                a.value === true
                  ? 'true'
                  : text
                    ? JSON.stringify(a.value.map((v: SNode) => v.data).join(''))
                    : '"" as string'
              },\n`;
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
        } else if (n.type === 'RenderTag' || n.type === 'HtmlTag') expr(n.expression);
        else if (n.type === 'KeyBlock') {
          expr(n.expression);
          fragment(n.fragment);
        } else if (n.type === 'SnippetBlock') {
          // A snippet of the template itself (bits-ui's Command root: `{#snippet
          // Label()}` rendered by `{@render Label()}`): a function of its
          // content, hoisted as Svelte hoists snippets in their fragment.
          if (n.parameters.length)
            fail(
              'E_TEMPLATE',
              'Snippets declared in a template take no parameters (snippets with parameters are supported as children of a component tag)',
              locate(u.original, n.start, u.rel),
            );
          s += `function ${n.expression.name}() {\n`;
          fragment(n.body);
          s += '}\n';
        } else if (n.type === 'RegularElement') {
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
    // Modules of packed packages that their packs port (frontend/packs.ts
    // `PackPort`): the port stands for the package's module.
    const refs = [...graph.modules.values()].flatMap(m =>
      m.imports.flatMap(i => (i.package && !i.package.source ? [i.package] : [])),
    );
    for (const [js, { file, ref }] of packPorts(refs))
      packageModules.set(js, portModule(js, file, ref));
  }
  const buildProgram = () => {
    const files = new Map<string, string>();
    for (const u of units.values()) files.set(u.virtual, u.synthetic);
    for (const [id, m] of graph.modules)
      if (/\.(ts|js|mjs)$/.test(id) && id.startsWith(root + path.sep) && !isPackageModule(id))
        files.set(
          id,
          m.globs?.length
            ? rewriteGlobs(
                id,
                m.code,
                m.globs,
                f => readFileSync(f, 'utf8'),
                (offset, message) => fail('E_GLOB', message, locate(m.code, offset, rel(id))),
              )
            : m.code,
        );
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
      // A module an import.meta.glob loads (rewriteGlobs): its id.
      if (path.isAbsolute(specifier) && units.has(specifier)) return units.get(specifier)!.virtual;
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
      // A script module re-exporting JSON files with a declaration file beside
      // it is typed by the declarations, as TypeScript resolves it (velite's
      // content index); other script modules are lowered from their source.
      const declarations = target.replace(/\.m?js$/, '.d.ts');
      if (
        declarations !== target &&
        existsSync(declarations) &&
        reexportsJson(graph.modules.get(target)?.code ?? readFileSync(target, 'utf8'), target)
      )
        return declarations;
      // A module only imported for its types is not collected; TypeScript reads it.
      return files.has(target) || (/\.(ts|js|mjs)$/.test(target) && existsSync(target))
        ? target
        : undefined;
    });
  };
  let program = buildProgram();
  // Class fields of package modules typed from what the classes assign.
  // (Again while types change: a field typed by a pass types the values
  // assigned to others, bits-ui's `#closeTimeout = this.#domContext.setTimeout(…)`.)
  for (let pass = 0; pass < 8 && inferFields(packageModules, program).length; pass++)
    program = buildProgram();
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
        // (A pack's port is its own text.)
        const code = graph.modules.get(m.file)?.code ?? (m.port ? m.text : '');
        const where = rel(m.port ? m.virtual : m.file);
        return seg
          ? locate(code, seg.orig + (pos - seg.synth), where)
          : { file: where, line: 1, column: 1 };
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
  // A snippet a site passes as an attribute to a component that collects
  // it in its rest props (shadcn-svelte's CommandDialog `<Command
  // {...restProps} {children} />`): a slot of that component, as content
  // or a `{#snippet}` block would be (the site forwards its own snippet
  // prop, or is rejected where it lowers the attribute).
  const isSnippet = (t: ts.Type): boolean => {
    const present = checker.getNonNullableType(t);
    if (present.isUnion()) return present.types.every(isSnippet);
    const sym = present.aliasSymbol ?? present.getSymbol();
    const file = sym?.declarations?.[0]?.getSourceFile().fileName ?? '';
    return sym?.name === 'Snippet' && /[\\/]svelte[\\/]/.test(file);
  };
  for (const u of order)
    walkTemplate(u.ast.fragment, n => {
      if (n.type !== 'Component') return;
      const to = u.children.get(n.name);
      if (!to || !restSlots.get(to)) return;
      for (const a of n.attributes) {
        if (
          a.type !== 'Attribute' ||
          decls.get(to)!.declared.has(a.name) ||
          a.value === true ||
          Array.isArray(a.value)
        )
          continue;
        const e = skipParens(nodeIn(u, a.value.expression) as ts.Expression);
        if (!ts.isIdentifier(e) || !isSnippet(checker.getTypeAtLocation(e))) continue;
        snippetAttrs.set(n, [...(snippetAttrs.get(n) ?? []), a.name]);
        restSlots.get(to)!.add(a.name);
      }
    });
  forwardRestSlots();
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
  // Dynamic values (M6 spike, opt-in): docs/design/M6-DYNAMIC-VALUES.md.
  types.dynamic = graph.config.dynamicValues === true;

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
  /** Records of a function's `$state` and `$derived` locals, by kind and value type. */
  const localRuneRecords = new Map<string, number>();
  const hooks: Hooks = {
    // `let x = $state(v)`, `$state.raw(v)`, `$derived(e)` and `$derived.by(f)`
    // in a function of a rune module (bits-ui's useFloating): a signal of
    // the function's invocation, a record with one reactive field the
    // local's reads and writes go to (a derived one with the getter its
    // value is computed by), captured by reference as closures capture it.
    localRune(d, b, lower) {
      const rune = runeName(d.initializer);
      if (!rune || !['$state', '$state.raw', '$derived', '$derived.by'].includes(rune))
        return undefined;
      if (!ts.isIdentifier(d.name)) return tsFail(d, 'E_RUNE', `${rune} locals are plain names`);
      if (!runeFile(d)) return undefined;
      const call = d.initializer as ts.CallExpression;
      const [arg] = call.arguments;
      const name = d.name.text;
      const sym = checker.getSymbolAtLocation(d.name)!;
      // TypeScript's type where it has one; in untyped JavaScript the type
      // of the initial value, or where that is a literal saying little (`{}`,
      // `null`) the type its uses expect (the getter of a returned object
      // of a declared type reading it).
      let init: ts.Expression | undefined = arg && skipParens(arg);
      if (
        rune === '$derived.by' &&
        init &&
        (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      )
        init = ts.isBlock(init.body) ? undefined : skipParens(init.body);
      const literal =
        !init ||
        ts.isObjectLiteralExpression(init) ||
        ts.isArrayLiteralExpression(init) ||
        init.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(init) && init.text === 'undefined');
      const declared = literal
        ? (lower.flowType(d, sym) ?? lower.types.typeOrUndefined(d.name))
        : (lower.types.typeOrUndefined(d.name) ??
          (rune === '$derived.by' ? lower.flowType(d, sym) : undefined));
      if (rune.startsWith('$state')) {
        let value: Expr;
        let t: Type;
        if (declared !== undefined) {
          t = declared;
          // (An object literal takes the declared record: `$state({})` of
          // floating-ui's middleware data, all of whose fields are optional.)
          if (arg && !lower.expected.has(skipParens(arg))) lower.expected.set(skipParens(arg), t);
          value = arg ? lower.coerce(arg, b, t) : { op: 'undefined', type: t };
        } else {
          if (!arg) return tsFail(d, 'E_RUNE', `${name} needs a type or an initial value`);
          value = lower.expr(arg, b);
          t = lower.irType(value, b);
        }
        const reactive = rune === '$state' ? 'state' : 'raw';
        const key = JSON.stringify([reactive, t]);
        let r = localRuneRecords.get(key);
        if (r === undefined) {
          r = lower.types.records.length;
          lower.types.records.push({
            name: 'State',
            class: true,
            fields: [{ name: 'value', type: t, reactive }],
          });
          localRuneRecords.set(key, r);
        }
        const local = b.local(name, { record: r }, b.boxed.has(sym));
        lower.bindings.set(sym, { kind: 'member', owner: b, local, path: [0] });
        return [{ op: 'let', local, value: { op: 'record', record: r, fields: [value] } }];
      }
      // `$derived(e)` / `$derived.by(f)`: the getter, and the derived field reading it.
      if (!arg)
        return tsFail(
          d,
          'E_RUNE',
          `${rune} takes ${rune === '$derived' ? 'an expression' : 'a function'}`,
        );
      let getter: Expr;
      let t: Type;
      if (rune === '$derived') {
        getter = lower.expressionClosure(arg, b, `${name}$derived`, declared);
        const gt = lower.irType(getter, b);
        t = (gt as { fn: { result: Type } }).fn.result;
      } else {
        if (declared !== undefined)
          lower.expected.set(skipParens(arg), { fn: { params: [], result: declared } });
        getter = lower.expr(arg, b);
        const gt = lower.irType(getter, b);
        if (typeof gt !== 'object' || !('fn' in gt) || gt.fn.params.length)
          return tsFail(arg, 'E_RUNE', '$derived.by takes a function without parameters');
        t = gt.fn.result;
      }
      const key = JSON.stringify(['derived', t]);
      let r = localRuneRecords.get(key);
      if (r === undefined) {
        r = lower.types.records.length;
        const derived = lower.reserve();
        lower.types.records.push({
          name: 'Derived',
          class: true,
          fields: [
            { name: 'get', type: { fn: { params: [], result: t } } },
            { name: 'value', type: t, reactive: 'derived', derived },
          ],
        });
        lower.functions[derived] = {
          name: 'Derived.value$derived',
          params: [{ name: 'this', type: { record: r } }],
          locals: [],
          result: t,
          body: [
            {
              op: 'return',
              value: {
                op: 'call-value',
                callee: { op: 'get', object: { op: 'local', local: 0 }, field: 0 },
                args: [],
              },
            },
          ],
        };
        localRuneRecords.set(key, r);
      }
      const local = b.local(name, { record: r }, b.boxed.has(sym));
      lower.bindings.set(sym, { kind: 'member', owner: b, local, path: [1] });
      return [{ op: 'let', local, value: { op: 'record', record: r, fields: [getter] } }];
    },
    // svelte/events' `on(target, type, handler)`: the handler takes the event.
    argumentType(call, index) {
      return index === 2 &&
        ts.isIdentifier(call.expression) &&
        svelteImport(call.expression, 'svelte/events') === 'on'
        ? { fn: { params: ['event'], result: 'void' } }
        : undefined;
    },
    readCell: cell => ({ op: 'cell', cell, read: 'current' }),
    cellType: cell => cells[cell].type,
    writeCell: (cell, value) => [{ op: 'set', cell, value }],
    call(node, ctx, lower) {
      // A load's `await res.json()` (frontend/adapters/kit/client.ts
      // KitResponse): the recorded body parsed into the type the program
      // declares for it.
      if (
        graph.kit &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'json' &&
        node.arguments.length === 0
      ) {
        const receiver = node.expression.expression;
        const symbol = checker.getTypeAtLocation(receiver).getSymbol();
        if (
          symbol?.getName() === 'KitResponse' &&
          symbol.declarations?.some(
            d => d.getSourceFile().fileName === path.join(graph.kit!.generated, 'client.ts'),
          )
        ) {
          const awaited = ts.isAwaitExpression(node.parent) ? node.parent : undefined;
          const contextual = awaited && checker.getContextualType(awaited);
          if (!contextual)
            return tsFail(
              node,
              'E_KIT_FETCH',
              'res.json() needs a declared result type (const item: Item = await res.json())',
            );
          const type = lower.types.map(contextual, node);
          const r = lower.expr(receiver, ctx);
          const rt = lower.irType(r, ctx);
          const record = typeof rt === 'object' && 'record' in rt ? rt.record : -1;
          const field =
            record < 0 ? -1 : lower.types.records[record].fields.findIndex(f => f.name === 'body');
          if (field < 0) return tsFail(node, 'E_INTERNAL', 'KitResponse has no body');
          return {
            op: 'builtin',
            name: 'promise.resolve',
            args: [
              { op: 'builtin', name: 'JSON.parse', args: [{ op: 'get', object: r, field }], type },
            ],
            type: { promise: type },
          };
        }
      }
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
      // onMount(fn) outside a component script's top level (bits-ui's
      // menubar and pin input state constructors, run while an instance is
      // created): Svelte 5 runs `user_effect(() => { const cleanup =
      // untrack(fn); if (typeof cleanup === 'function') return cleanup; })`,
      // a post effect of the instance that tracks nothing. (Called while
      // no instance is created nor an effect runs, Svelte throws
      // lifecycle_outside_component and the effect builtin RunicEffectError.)
      if (ts.isIdentifier(node.expression) && svelteImport(node.expression) === 'onMount') {
        const [fn] = node.arguments;
        const f = fn && node.arguments.length === 1 ? lower.expr(fn, ctx) : undefined;
        const t = f && lower.irType(f, ctx);
        const result =
          typeof t === 'object' && 'fn' in t && !t.fn.params.length ? t.fn.result : undefined;
        const cleanup = (x: Type | undefined) =>
          typeof x === 'object' && 'fn' in x && !x.fn.params.length && x.fn.result === 'void';
        if (
          !f ||
          result === undefined ||
          (result !== 'void' &&
            !cleanup(result) &&
            !(typeof result === 'object' && 'maybe' in result && cleanup(result.maybe)))
        )
          return tsFail(
            node,
            'E_EFFECT',
            'onMount takes a function without parameters returning nothing or a cleanup function',
          );
        const call: Expr = {
          op: 'builtin',
          name: 'reactive.untrack-call',
          args: [{ op: 'local', local: 0 }],
          type: result,
        };
        const run = lower.reserve();
        lower.functions[run] = {
          name: 'onMount$run',
          captures: [{ name: 'fn', type: t! }],
          params: [],
          locals: [],
          result,
          body: result === 'void' ? [{ op: 'expr', value: call }] : [{ op: 'return', value: call }],
        };
        const tmp = ctx.local('$onMount', t!);
        return {
          op: 'with',
          local: tmp,
          value: f,
          body: {
            op: 'builtin',
            name: 'effect.post',
            args: [{ op: 'closure', function: run, captures: [tmp] }],
            type: 'void',
          },
        };
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
        // (An inline function, or a function value: `$effect(attach)`.)
        const inline = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn));
        const bad = () =>
          tsFail(node, 'E_EFFECT', `${rune} takes one synchronous function without parameters`);
        if (
          !fn ||
          node.arguments.length !== 1 ||
          (inline &&
            (fn.parameters.length ||
              fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)))
        )
          return bad();
        const f = lower.expr(fn, ctx);
        const t = lower.irType(f, ctx) as { fn: { params: Type[]; result: Type } };
        if (typeof t !== 'object' || !('fn' in t) || t.fn.params.length) return bad();
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
      // $effect.root(f) (M6, bits-ui's SharedState and keyboard tracking): f
      // runs at once in a root its effects belong to; the result destroys
      // the root (docs/IR.md, `effect.root`).
      if (rune === '$effect.root' && runeFile(node)) {
        const [fn] = node.arguments;
        if (!fn || node.arguments.length !== 1)
          return tsFail(node, 'E_EFFECT', '$effect.root takes one function');
        const f = lower.expr(fn, ctx);
        const t = lower.irType(f, ctx);
        if (typeof t !== 'object' || !('fn' in t) || t.fn.params.length)
          return tsFail(node, 'E_EFFECT', '$effect.root takes a function without parameters');
        const local = ctx.local('$root', 'number');
        return {
          op: 'with',
          local,
          value: { op: 'builtin', name: 'effect.root', args: [f], type: 'number' },
          body: { op: 'closure', function: lower.destroyRootFunction(), captures: [local] },
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
    const [el, type, handler, given, ...more] = node.arguments;
    if (!el || !type || !handler || more.length)
      return tsFail(
        node,
        'E_EVENT',
        'on(target, "event", handler, options?) takes three or four arguments',
      );
    // (Options a parameter holds that no call passes: none.)
    const options = given && l.unpassedParameter(given) ? undefined : given;
    // A type that is not a native event's, or one known at run time
    // (bits-ui's `on(element, this.eventName, handler)`): a custom event
    // listener of an element, which only `dispatchEvent` calls.
    if (
      !ts.isStringLiteralLike(type) ||
      (!EVENT_KINDS.includes(type.text as HandlerEvent) &&
        !['beforematch', 'popstate', 'hashchange', 'resize'].includes(type.text))
    )
      return customOn(node, el, type, handler, options, b, l);
    const kind = type.text;
    // Options: `capture` (the document's and the window's), `passive: false`
    // (the default of every event the runtime fires), `once` (reported
    // unsupported where the listener would be added: bits-ui adds one only
    // for touch input, which the runtime has not).
    let capture = false;
    let once = false;
    if (options) {
      const o = skipParens(options);
      if (!ts.isObjectLiteralExpression(o))
        return tsFail(options, 'E_EVENT', 'on() options are an object literal');
      for (const p of o.properties) {
        const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
        const v = ts.isPropertyAssignment(p) ? skipParens(p.initializer) : undefined;
        const flag =
          v?.kind === ts.SyntaxKind.TrueKeyword
            ? true
            : v?.kind === ts.SyntaxKind.FalseKeyword
              ? false
              : undefined;
        if (!key || flag === undefined)
          return tsFail(p, 'E_EVENT', 'on() options are boolean literals');
        if (key === 'capture') capture = flag;
        else if (key === 'once') once = flag;
        else if (key === 'passive' && (!flag || takesNothing(handler))) {
          // The default, or a listener that cannot cancel the event.
        } else
          return tsFail(
            p,
            'E_EVENT',
            `on() option ${key}${key === 'passive' ? ': true' : ''} is not covered`,
          );
      }
    }
    // A field holding the document or the window once assigned (bits-ui's
    // `#documentObj`, frontend/classes.ts `hostFieldOf`): adding the
    // listener throws a TypeError while it does not.
    const field = l.classes.hostField(el);
    const host = field ?? l.hostOf(el);
    const target: 'document' | 'window' | 'element' =
      host === 'document' || host === 'window' ? host : 'element';
    const supported =
      target === 'element'
        ? kind === 'beforematch' ||
          (EVENT_KINDS.includes(kind as HandlerEvent) && kind !== 'resize')
        : EVENT_KINDS.includes(kind as HandlerEvent) ||
          (target === 'window' && ['popstate', 'hashchange'].includes(kind));
    if (!supported)
      return tsFail(
        type,
        'E_EVENT',
        `on() of ${target === 'element' ? 'an element' : `the ${target}`} for ${kind} is not covered`,
      );
    if (capture && target === 'element')
      return tsFail(
        options!,
        'E_EVENT',
        'Capture listeners are supported on the document and the window',
      );
    // The handler takes the event (an untyped function its declaration
    // types from here: `flowType`).
    const want: Type = { fn: { params: ['event'], result: 'void' } };
    // (The element is evaluated before the handler, as the arguments are.)
    const e = target === 'element' ? onElement(el, b, l) : undefined;
    if (e && l.irType(e, b) !== 'element')
      return tsFail(el, 'E_EVENT', 'on() takes an element, the document or the window');
    l.expected.set(skipParens(handler), want);
    const f = l.expr(handler, b);
    const ft = l.irType(f, b);
    if (
      typeof ft !== 'object' ||
      !('fn' in ft) ||
      !(ft.fn.params.length === 0 || (ft.fn.params.length === 1 && ft.fn.params[0] === 'event'))
    )
      return tsFail(handler, 'E_EVENT', 'on() takes a listener taking the event or nothing');
    const remover: Type = { fn: { params: [], result: 'void' } };
    const guarded = (body: (handler: Expr) => Expr): Expr => {
      if (!field) return body(f);
      const local = b.local('$listener', ft);
      return {
        op: 'with',
        local,
        value: f,
        body: {
          op: 'cond',
          test: l.expr(el, b),
          then: body({ op: 'local', local }),
          else: l.typeErrorValue(
            'on$target',
            remover,
            "Cannot read properties of undefined (reading 'addEventListener')",
          ),
        },
      };
    };
    if (once)
      return guarded(handler => ({
        op: 'with',
        local: b.local('$listener', ft),
        value: handler,
        body: l.unsupportedValue('on$once', remover, `on() with { once: true } (${kind})`),
      }));
    const element = target === 'element';
    const name = target;
    const listen = element ? 'listen' : capture ? 'listen-capture' : 'listen';
    const unlisten = element ? 'unlisten' : capture ? 'unlisten-capture' : 'unlisten';
    const argsOf = (): Expr[] =>
      element
        ? [
            { op: 'local', local: 0 },
            { op: 'lit', value: kind },
            { op: 'local', local: 1 },
          ]
        : [
            { op: 'lit', value: kind },
            { op: 'local', local: 0 },
          ];
    const captured = element
      ? [
          { name: 'element', type: 'element' as Type },
          { name: 'handler', type: ft },
        ]
      : [{ name: 'handler', type: ft }];
    const remove = l.reserve();
    l.functions[remove] = {
      name: 'on$remove',
      captures: captured,
      params: [],
      locals: [],
      result: 'void',
      body: [
        {
          op: 'expr',
          value: { op: 'builtin', name: `${name}.${unlisten}`, args: argsOf(), type: 'void' },
        },
      ],
    };
    const add = l.reserve();
    l.functions[add] = {
      name: 'on',
      params: captured,
      locals: [],
      result: remover,
      body: [
        {
          op: 'expr',
          value: { op: 'builtin', name: `${name}.${listen}`, args: argsOf(), type: 'void' },
        },
        {
          op: 'return',
          value: { op: 'closure', function: remove, captures: element ? [0, 1] : [0] },
        },
      ],
    };
    return guarded(handler => ({
      op: 'call',
      function: add,
      args: element ? [e!, handler] : [handler],
    }));
  };
  /** `on(element, type, handler)` of a custom event type (`svelteOn`). */
  /**
   * Whether a listener takes no parameters, so it cannot reach the event (a
   * passive listener's `preventDefault` is ignored: bits-ui's Select marks
   * its `wheel` and `touchmove` listeners passive, which only set a flag).
   */
  const takesNothing = (handler: ts.Expression): boolean => {
    const sigs = checker.getTypeAtLocation(handler).getCallSignatures();
    return sigs.length > 0 && sigs.every(s => s.parameters.length === 0);
  };
  /**
   * The element of `on(element, …)`: a nullable one TypeScript narrowed to
   * present (bits-ui's `on(this.opts.ref.current, …)` after testing it) is
   * unwrapped (adding a listener to null throws a TypeError).
   */
  const onElement = (el: ts.Expression, b: FnBuilder, l: Lowerer): Expr => {
    const e = l.expr(el, b);
    return maybeInner(l.irType(e, b)) === 'element' && l.tsPresent(el)
      ? { op: 'unwrap', value: e }
      : e;
  };
  const customOn = (
    node: ts.CallExpression,
    el: ts.Expression,
    type: ts.Expression,
    handler: ts.Expression,
    options: ts.Expression | undefined,
    b: FnBuilder,
    l: Lowerer,
  ): Expr => {
    // (`passive` of a listener that takes nothing: it cannot cancel the event.)
    const o = options && skipParens(options);
    const passiveOnly =
      !!o &&
      ts.isObjectLiteralExpression(o) &&
      o.properties.every(
        p =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === 'passive' &&
          [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
            skipParens(p.initializer).kind,
          ),
      ) &&
      takesNothing(handler);
    if (options && !passiveOnly)
      return tsFail(options, 'E_EVENT', 'on() options are not covered for custom event types');
    if (l.hostOf(el) || l.classes.hostField(el))
      return tsFail(el, 'E_EVENT', 'Custom event listeners are covered on elements');
    const e = onElement(el, b, l);
    if (l.irType(e, b) !== 'element')
      return tsFail(el, 'E_EVENT', 'on() takes an element, the document or the window');
    const name = l.coerce(type, b, 'string');
    const want: Type = { fn: { params: ['event'], result: 'void' } };
    l.expected.set(skipParens(handler), want);
    const f = l.expr(handler, b);
    const ft = l.irType(f, b);
    if (
      typeof ft !== 'object' ||
      !('fn' in ft) ||
      !(ft.fn.params.length === 0 || (ft.fn.params.length === 1 && ft.fn.params[0] === 'event'))
    )
      return tsFail(handler, 'E_EVENT', 'on() takes a listener taking the event or nothing');
    const remover: Type = { fn: { params: [], result: 'void' } };
    const captured = [
      { name: 'element', type: 'element' as Type },
      { name: 'type', type: 'string' as Type },
      { name: 'handler', type: ft },
    ];
    const args: Expr[] = [0, 1, 2].map(i => ({ op: 'local', local: i }));
    const remove = l.reserve();
    l.functions[remove] = {
      name: 'on$remove',
      captures: captured,
      params: [],
      locals: [],
      result: 'void',
      body: [{ op: 'expr', value: { op: 'builtin', name: 'custom.unlisten', args, type: 'void' } }],
    };
    const add = l.reserve();
    l.functions[add] = {
      name: 'on',
      params: captured,
      locals: [],
      result: remover,
      body: [
        { op: 'expr', value: { op: 'builtin', name: 'custom.listen', args, type: 'void' } },
        { op: 'return', value: { op: 'closure', function: remove, captures: [0, 1, 2] } },
      ],
    };
    void node;
    return { op: 'call', function: add, args: [e, name, f] };
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
  {
    const unrendered = new Set([...units.values()].filter(u => !u.reached).map(u => u.virtual));
    lower.unrenderedFile = f => unrendered.has(f);
  }
  // The script runs once per instance: its functions keep their identity.
  lower.stableFunctions = true;
  // Declarations of package modules are lowered when the program reaches them.
  const packageLazy = packageBindings(lower, graph.modules, packageModules);
  // A component's default export used as a value (frontend/component-values.ts).
  const unitOfVirtual = new Map([...units.values()].map(u => [u.virtual, u.rel]));
  lower.lazy = symbol =>
    componentBinding(lower, symbol, f => unitOfVirtual.get(f)) ??
    jsonBinding(lower, symbol, graph.modules) ??
    packageLazy(symbol);
  lower.implementation = implementationOf(program, packageModules);
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
    // called; setContext, getContext and hasContext are bound (frontend/svelte-context.ts).
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
  /** Whether `e` reads the rest props of component `file` (also through constants). */
  const mentionsRest = (e: ts.Node, file: string, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isIdentifier(e)) {
      const sym = checker.getSymbolAtLocation(e);
      if (!sym) return false;
      if (restOf.get(sym) === file) return true;
      const d = sym.valueDeclaration;
      return (
        !!d &&
        ts.isVariableDeclaration(d) &&
        !!d.initializer &&
        !!(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) &&
        mentionsRest(d.initializer, file, seen)
      );
    }
    return !!ts.forEachChild(e, c => mentionsRest(c, file, seen) || undefined);
  };
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
  // Before prop domains exist (bag shapes come first): a prop without a
  // default that no site passes, by an attribute, a binding or a spread
  // (which may hold any name), holds only undefined.
  {
    const unpassed = new Map<ts.Symbol, boolean>();
    for (const u of order)
      for (const stmt of instanceStatements(u)) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const d of stmt.declarationList.declarations) {
          if (runeName(d.initializer) !== '$props' || !ts.isObjectBindingPattern(d.name)) continue;
          for (const el of d.name.elements) {
            if (el.dotDotDotToken || el.initializer || !ts.isIdentifier(el.name)) continue;
            const symbol = checker.getSymbolAtLocation(el.name);
            const key = ((el.propertyName ?? el.name) as ts.Identifier).text;
            let passed = false;
            for (const p of order)
              walkTemplate(p.ast.fragment, n => {
                if (n.type !== 'Component' || p.children.get(n.name) !== u.file) return;
                for (const a of n.attributes)
                  if (
                    a.type === 'SpreadAttribute' ||
                    ((a.type === 'Attribute' || a.type === 'BindDirective') && a.name === key)
                  )
                    passed = true;
              });
            if (symbol) unpassed.set(symbol, !passed);
          }
        }
      }
    lower.unpassedProp = sym => unpassed.get(sym) === true;
  }
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
    bindingValues(sym, key) {
      // Rest props: what the component's sites pass.
      const rest = restOf.get(sym);
      if (rest) return domains.passed(units.get(rest)!.index, key);
      // A field of a destructured snippet parameter: what the render sites pass.
      const found = snippetParamOf(sym);
      if (!found) return null;
      const { site, field } = found;
      const to = site.unit.children.get(site.node.name);
      if (!to) return undefined;
      let out: unknown[] | undefined = [];
      for (const args of renderArgs(to, site.name)) {
        const v = args[site.index] ? argFieldValues(args[site.index], field, key) : [ABSENT];
        out = v && out && [...out, ...v];
        if (!out) return undefined;
      }
      return out;
    },
  });
  /** The snippet parameter a destructured field `sym` belongs to, and the field. */
  function snippetParamOf(sym: ts.Symbol) {
    const decl = sym.valueDeclaration;
    if (!decl || !ts.isBindingElement(decl)) return undefined;
    let param: ts.Node = decl;
    while (param.parent && !ts.isParameter(param)) param = param.parent;
    if (!ts.isParameter(param) || decl.parent.parent !== param) return undefined;
    const site = snippetParams.find(
      p => p.virtual === param.getSourceFile().fileName && p.start === param.getStart(),
    );
    return site && { site, field: ((decl.propertyName ?? decl.name) as ts.Identifier).text };
  }
  /** The values for `key` of the bag a snippet argument's field `field` holds. */
  const argFieldValues = (
    arg: ts.Expression,
    field: string,
    key: string,
  ): unknown[] | undefined => {
    const e = skipParens(arg);
    if (!ts.isObjectLiteralExpression(e)) return undefined;
    for (const p of [...e.properties].reverse()) {
      if (ts.isPropertyAssignment(p) && shapes.propertyName(p.name) === field)
        return shapes.values(p.initializer, key);
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === field)
        return shapes.values(p.name, key);
      if (ts.isSpreadAssignment(p)) return undefined;
    }
    return [ABSENT];
  };
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
    /** The names bound in branches that can render (`decidedTest`). */
    let boundLive: Set<string> | undefined;
    // (Not kept while a prop's `written` is being decided: the tests that
    // read that prop are open then, so more binds count.)
    let deciding = 0;
    const bound = {
      has(name: string): boolean {
        let live = boundLive;
        if (!live) {
          const found = new Set<string>();
          live = found;
          const visit = (node: unknown) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) return node.forEach(visit);
            const n = node as SNode;
            if (n.type === 'BindDirective' && n.expression?.type === 'Identifier')
              found.add(n.expression.name);
            if (n.type === 'IfBlock') {
              const known = decidedTest(u, n.test);
              visit(n.test);
              if (known !== false) visit(n.consequent);
              if (known !== true) visit(n.alternate);
              return;
            }
            for (const [k, v] of Object.entries(n)) if (k !== 'parent') visit(v);
          };
          visit(u.ast.fragment);
          if (!deciding) boundLive = found;
        }
        return live.has(name);
      },
    };
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
          // (Written: decided when first asked, as binds in branches that
          // cannot render do not count, which the other props' values decide.)
          const name = el.name.text;
          let written: boolean | undefined;
          propDecls.push({
            component: u.index,
            key: el.propertyName ? (el.propertyName as ts.Identifier).text : name,
            symbol,
            fallback,
            get written() {
              if (written === undefined) {
                written = true;
                deciding++;
                try {
                  written = bound.has(name) || assigned(checker, sf, symbol);
                } finally {
                  deciding--;
                }
              }
              return written;
            },
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
            if (mayHold(s, key)) {
              const before = values.get(key);
              values.set(key, {
                open: true,
                spread,
                ...(rest !== undefined ? { restOf: rest } : {}),
                ...(before ? { before } : {}),
              });
            }
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
  /** Prop cells (`component:cell`) whose default no site lets take effect, so not lowered. */
  const unusedDefaults = new Set<string>();
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
  // Constants passed to a component prop declared with records of more
  // optional fields (shadcn-svelte's select demo: `const fruits = [{ value,
  // label }, …]` passed as `items`, declared `{ value; label; disabled?:
  // boolean }[]`) take the prop's type, as TypeScript types the literal
  // written in place (`Lowerer.widens`): arrays and objects keep their
  // identity, so the site cannot convert them. Sites passing one constant
  // to props of different types leave it its own.
  const passedTypes = new Map<ts.Symbol, Type | null>();
  for (const u of order)
    walkTemplate(u.ast.fragment, n => {
      if (n.type !== 'Component' || u.packs.has(n.name)) return;
      for (const a of n.attributes) {
        if (a.type !== 'Attribute' || a.value === true || Array.isArray(a.value)) continue;
        const at = nodeIn(u, a.value.expression) as ts.Expression;
        const id = skipParens(at);
        const sym = ts.isIdentifier(id) ? checker.getSymbolAtLocation(id) : undefined;
        const decl = sym?.valueDeclaration;
        if (
          !decl ||
          !ts.isVariableDeclaration(decl) ||
          decl.type ||
          !decl.initializer ||
          !(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)
        )
          continue;
        const init = skipParens(decl.initializer);
        if (!ts.isArrayLiteralExpression(init) && !ts.isObjectLiteralExpression(init)) continue;
        const ctx = checker.getContextualType(at);
        const want = ctx && lower.types.tryMap(checker.getNonNullableType(ctx), at);
        const own = lower.types.tryMap(checker.getTypeAtLocation(id), id);
        if (!want || !own || !lower.widens(own, want)) continue;
        const known = passedTypes.get(sym!);
        passedTypes.set(
          sym!,
          known === undefined || (known !== null && sameType(known, want)) ? want : null,
        );
      }
    });
  for (const [sym, t] of passedTypes) if (t) lower.types.override(sym, t);
  domains.spreadValues = (spread, key) => shapes.values(spread, key);

  /** The fragments links may navigate to (checked against the element ids below). */
  const linkFragments: { name: string; at: Source }[] = [];
  /** The image URLs `<img>` elements can load (pinned by compiler/images.mjs). */
  const imageUrls: ImageUrl[] = [];
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
      // Snippets of several parameter lists (bits-ui's `Snippet |
      // Snippet<[Props]>`): the snippet is rendered with the longest list,
      // and one declaring fewer parameters ignores the rest. The shorter
      // lists must be its prefixes.
      if (t.isUnion()) {
        const lists = t.types.map(m => snippetParams(node, m));
        if (lists.some(l => l === undefined)) return undefined;
        const longest = (lists as Type[][]).reduce((a, b) => (b.length > a.length ? b : a));
        for (const l of lists as Type[][])
          if (l.some((p, i) => JSON.stringify(p) !== JSON.stringify(longest[i])))
            return tsFail(
              node,
              'E_PROPS',
              'Snippet types of a prop must agree on their common parameters',
            );
        return longest;
      }
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
     * A prop typed wider than the value model that no site passes a value,
     * written only by `bind:value` of inputs whose type the props' values
     * decide is not `number` or `range` (shadcn's Input under
     * `defaultValue`): Svelte's bind_value writes the input's value, so the
     * prop is a nullable string. (Binds in branches that cannot render are
     * left out, as for `written`.) Undefined otherwise.
     */
    const typeOfBinds = (sym: ts.Symbol, el: ts.BindingElement): Type | undefined => {
      const passed = domains.siteTypes(sym);
      if (!passed?.length || passed.some(t => t !== undefined)) return undefined;
      const name = (el.name as ts.Identifier).text;
      const numberlike = (v: unknown) => v === 'number' || v === 'range';
      let ok = true;
      let found = false;
      const typeOk = (n: SNode): boolean => {
        for (const a of n.attributes ?? []) {
          if (a.type === 'SpreadAttribute') {
            if (mayHold(shapes.of(nodeIn(u, a.expression) as ts.Expression), 'type')) return false;
            continue;
          }
          if (a.type !== 'Attribute' || a.name !== 'type') continue;
          if (a.value === true) return false;
          if (Array.isArray(a.value)) {
            if (a.value.length === 1 && a.value[0].type === 'Text')
              return !numberlike(a.value[0].data);
            return false;
          }
          const e = nodeIn(u, a.value.expression) as ts.Expression;
          const values = valueSet({ lower, label: 'input types' }, e);
          return (
            !!values &&
            values.every(v => v === undefined || (typeof v === 'string' && !numberlike(v)))
          );
        }
        return true;
      };
      const visit = (node: unknown) => {
        if (!ok || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);
        const n = node as SNode;
        if (n.type === 'IfBlock') {
          const known = decidedTest(u, n.test);
          if (known !== false) visit(n.consequent);
          if (known !== true) visit(n.alternate);
          return;
        }
        for (const a of n.attributes ?? [])
          if (
            a.type === 'BindDirective' &&
            a.expression?.type === 'Identifier' &&
            a.expression.name === name
          ) {
            if (
              n.type !== 'RegularElement' ||
              n.name !== 'input' ||
              a.name !== 'value' ||
              !typeOk(n)
            )
              ok = false;
            else found = true;
          }
        for (const [k, v] of Object.entries(n)) if (k !== 'parent' && k !== 'attributes') visit(v);
      };
      visit(u.ast.fragment);
      return ok && found ? { maybe: 'string' } : undefined;
    };

    /**
     * A prop typed wider than the value model that no site passes a value
     * and that has no default, bound only by `bind:K={name}` on components
     * this one renders (shadcn-svelte's InputGroup.Input `bind:value` to
     * Input's `value`): the bound child prop's cell type, which the child,
     * lowered first, has decided. Each bind reads and writes the child's
     * prop, so the prop holds only values of that type, and its initial
     * undefined must be one (the type is nullable). Binds in branches that
     * cannot render are left out, as for `typeOfBinds`. Undefined unless
     * there is at least one such bind and every bind of the prop is one, of
     * the same type.
     */
    const typeOfChildBinds = (sym: ts.Symbol, el: ts.BindingElement): Type | undefined => {
      const passed = domains.siteTypes(sym);
      if (!passed?.length || passed.some(t => t !== undefined)) return undefined;
      if (
        el.initializer &&
        !(
          runeName(el.initializer) === '$bindable' &&
          !(el.initializer as ts.CallExpression).arguments.length
        )
      )
        return undefined;
      const name = (el.name as ts.Identifier).text;
      let ok = true;
      let found: Type | undefined;
      const visit = (node: unknown) => {
        if (!ok || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);
        const n = node as SNode;
        if (n.type === 'IfBlock') {
          const known = decidedTest(u, n.test);
          if (known !== false) visit(n.consequent);
          if (known !== true) visit(n.alternate);
          return;
        }
        for (const a of n.attributes ?? [])
          if (
            a.type === 'BindDirective' &&
            a.expression?.type === 'Identifier' &&
            a.expression.name === name
          ) {
            const file = n.type === 'Component' ? u.children.get(n.name) : undefined;
            const child = file !== undefined ? units.get(file) : undefined;
            const target = child && components[child.index];
            const cell = target?.cells.find(c => c.prop === a.name);
            if (!cell || cell.prop === '...' || maybeInner(cell.type) === undefined) ok = false;
            else if (found && JSON.stringify(found) !== JSON.stringify(cell.type)) ok = false;
            else found = cell.type;
          }
        for (const [k, v] of Object.entries(n)) if (k !== 'parent' && k !== 'attributes') visit(v);
      };
      visit(u.ast.fragment);
      return ok ? found : undefined;
    };

    /**
     * A prop typed wider than the value model that no site passes a value
     * and its component never writes, with a default (bits-ui's PinInput
     * `onComplete = noop`, typed `(...args: any[]) => void`, under
     * shadcn-svelte's InputOTP, which no example gives one): it only ever
     * holds its default, so it has the default's type. Undefined otherwise
     * (also where the default's type is outside the value model).
     */
    const typeOfDefault = (sym: ts.Symbol, el: ts.BindingElement): Type | undefined => {
      const passed = domains.siteTypes(sym);
      if (!passed?.length || passed.some(t => t !== undefined)) return undefined;
      if (domains.written(sym) !== false) return undefined;
      let fallback = el.initializer;
      if (fallback && runeName(fallback) === '$bindable')
        fallback = (fallback as ts.CallExpression).arguments[0];
      if (!fallback) return undefined;
      const t = types.tryMap(checker.getTypeAtLocation(fallback), fallback);
      return t && t !== 'void' ? t : undefined;
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
          const t =
            (values && typeOfValues(values)) ??
            typeOfSites(sym, el) ??
            typeOfBinds(sym, el) ??
            typeOfChildBinds(sym, el) ??
            typeOfDefault(sym, el);
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
        // A default no site lets take effect (every site passes the prop
        // with a value that is never undefined, frontend/unions.ts) is not
        // lowered: it never runs, and it may be of a member of the prop's
        // union that no value of the program reaches (bits-ui's
        // FloatingLayerContent `style = {}` under a Popover, which always
        // passes a style string).
        if (
          fallback &&
          lower.unions.narrowed(checker.getNonNullableType(checker.getTypeAtLocation(el.name))) &&
          lower.unions.unusedDefault(el)
        ) {
          fallback = undefined;
          unusedDefaults.add(`${u.index}:${cell}`);
        }
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
                // (A value with dynamic values in it keeps its own type where
                // the type is TypeScript's inference: M6 dynamic values.)
                const own = lower.valueType(v);
                const dynamic = !d.type && containsDyn(own);
                lower.functions[index] = {
                  name,
                  component: COMPONENT,
                  params: [],
                  locals: [],
                  result: bag ? 'attrs' : dynamic ? own : types.of(d.name),
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
            // A call TypeScript cannot type (untyped JavaScript) returns the
            // annotated variable's type.
            const call = skipParens(value);
            if (d.type && ts.isCallExpression(call) && !lower.expected.has(call))
              lower.expected.set(call, type);
            // A literal of a constant typed by the prop it is passed to
            // (`passedTypes`): that type.
            if (
              lower.types.overridden(d.name) &&
              (ts.isArrayLiteralExpression(call) || ts.isObjectLiteralExpression(call)) &&
              !lower.expected.has(call)
            )
              lower.expected.set(call, type);
            // The IR type of the lowered value (a bare `null` takes its contextual type).
            const v = lower.value(value, COMPONENT, `${name}$init`);
            // (An unannotated variable whose value has dynamic values in it
            // holds it with that type: M6 dynamic values.)
            const own = lower.valueType(v);
            if (!d.type && containsDyn(own) && JSON.stringify(own) !== JSON.stringify(type)) {
              cells[cell].type = own;
              type = own;
            }
            cells[cell].init = coerceInit(v, own, type, lower.types.records);
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
    // (A value lowered as dynamic is dynamic whatever TypeScript narrowed
    // it to: M6 dynamic values.)
    const typeOf = (e: ts.Expression, v: Expr): Type => {
      const lowered = lower.irType(v, tb);
      return lowered === 'dyn' ? lowered : (types.typeOrUndefined(e) ?? lowered);
    };
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
    /**
     * The snippets the template declares (`{#snippet name()}`, no
     * parameters), innermost fragment last: each `{@render name()}` of one
     * renders its content in place, as Svelte's snippet function does (it
     * closes over the component's scope; a snippet rendering itself is
     * rejected).
     */
    const localSnippets: Map<string, SNode>[] = [];
    const rendering = new Set<SNode>();
    const children = (fragment: SNode, parent?: string): Node[] => {
      // An <svg>'s content is in the SVG namespace.
      if (parent === 'svg') inSvg++;
      const declared = new Map<string, SNode>(
        (fragment?.nodes ?? [])
          .filter((c: SNode) => c.type === 'SnippetBlock')
          .map((c: SNode) => [c.expression.name, c] as [string, SNode]),
      );
      localSnippets.push(declared);
      try {
        // (Svelte hoists them before trimming the fragment's whitespace:
        // bits-ui's Command root declares `{#snippet Label()}` first.)
        return childNodes(
          declared.size
            ? { ...fragment, nodes: fragment.nodes.filter((c: SNode) => c.type !== 'SnippetBlock') }
            : fragment,
          parent,
        );
      } finally {
        localSnippets.pop();
        if (parent === 'svg') inSvg--;
      }
    };
    /** The template's snippet `{@render}` tag `n` names, if any. */
    const localSnippet = (n: SNode): SNode | undefined => {
      if (n.expression.type !== 'CallExpression' || n.expression.callee.type !== 'Identifier')
        return undefined;
      const name = n.expression.callee.name;
      for (let i = localSnippets.length - 1; i >= 0; i--) {
        const found = localSnippets[i].get(name);
        if (found) return found;
      }
      return undefined;
    };
    /**
     * Whether rendering `nodes` certainly reads `sym` (a `{@const}`) before
     * evaluating anything that may have effects: Svelte computes the
     * `{@const}` at that first read, so evaluating it as the block renders
     * is the same (bits-ui's `{@const finalProps = mergeProps(props,
     * mergedProps, …)}`, read by the content's spread after the wrapper's).
     * Effect-free here is syntactic: names, member reads, literals.
     */
    const readFirst = (sym: ts.Symbol, nodes: SNode[]): 'read' | 'effect' | 'none' => {
      const reads = (e: ts.Node): boolean =>
        (ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === sym) ||
        !!ts.forEachChild(e, c => reads(c) || undefined);
      const pure = (e: ts.Node): boolean =>
        ts.isIdentifier(e) ||
        e.kind === ts.SyntaxKind.ThisKeyword ||
        ts.isLiteralExpression(e) ||
        ts.isNoSubstitutionTemplateLiteral(e) ||
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
          e.kind,
        ) ||
        (ts.isPropertyAccessExpression(e) && pure(e.expression)) ||
        (ts.isParenthesizedExpression(e) && pure(e.expression)) ||
        (ts.isTemplateExpression(e) && e.templateSpans.every(t => pure(t.expression)));
      const expression = (x: SNode): 'read' | 'effect' | 'none' => {
        const e = exprNode(x);
        return reads(e) ? 'read' : pure(e) ? 'none' : 'effect';
      };
      const walk = (list: SNode[]): 'read' | 'effect' | 'none' => {
        for (const n of list) {
          let r: 'read' | 'effect' | 'none' = 'none';
          if (n.type === 'Text' || n.type === 'Comment') continue;
          if (n.type === 'ExpressionTag') r = expression(n.expression);
          else if (n.type === 'RegularElement') {
            for (const a of n.attributes) {
              const values =
                a.type === 'Attribute'
                  ? a.value === true
                    ? []
                    : (Array.isArray(a.value) ? a.value : [a.value])
                        .filter((v: SNode) => v.type === 'ExpressionTag')
                        .map((v: SNode) => v.expression)
                  : a.type === 'SpreadAttribute'
                    ? [a.expression]
                    : null;
              if (values === null) return 'effect';
              for (const v of values) {
                r = expression(v);
                if (r !== 'none') return r;
              }
            }
            r = walk(n.fragment.nodes);
          } else if (n.type === 'IfBlock') {
            const decided = decidedTest(u, n.test);
            if (decided === undefined) return 'effect';
            r = walk((decided ? n.consequent : n.alternate)?.nodes ?? []);
          } else return 'effect';
          if (r !== 'none') return r;
        }
        return 'none';
      };
      return walk(nodes);
    };
    const childNodes = (fragment: SNode, parent?: string): Node[] => {
      const cleaned = clean(fragment, parent);
      // `{@const name = value}` (bits-ui's `{@const finalProps =
      // mergeProps(…)}`): Svelte hoists it to its block as a derived value,
      // computed when first read. A value without identity whose evaluation
      // has no effect (Lowerer.effectFree) is evaluated as the block
      // renders, as the item of a one-item list around the block's content;
      // others are rejected.
      const consts = cleaned.filter(n => n.type === 'ConstTag');
      if (consts.length) {
        const bound = consts.map(c => {
          const list = nodeAt(c.declaration);
          const decl =
            ts.isVariableDeclarationList(list) && list.declarations.length === 1
              ? list.declarations[0]
              : undefined;
          if (!decl || !ts.isIdentifier(decl.name) || !decl.initializer)
            return fail('E_TEMPLATE', '{@const} declares one name with a value', loc(c));
          const v = value(decl.initializer);
          const t = lower.irType(v, tb);
          const plain = (x: Type): boolean =>
            ['string', 'number', 'boolean', 'attrs'].includes(x as string) ||
            (typeof x === 'object' && 'maybe' in x && plain(x.maybe));
          if (
            !plain(t) ||
            (!lower.effectFree(v) &&
              readFirst(
                checker.getSymbolAtLocation(decl.name)!,
                cleaned.filter((n: SNode) => n.type !== 'ConstTag'),
              ) !== 'read')
          )
            fail(
              'E_TEMPLATE',
              '{@const} is supported for text, numbers, booleans and attribute bags computed without effects',
              loc(c),
            );
          const local = tb.local(decl.name.text, t);
          lower.bindings.set(checker.getSymbolAtLocation(decl.name)!, {
            kind: 'local',
            owner: tb,
            local,
          });
          return { local, v, t };
        });
        // (Whitespace around the declarations is trimmed as at the block's edges.)
        let body = childNodes(
          { ...fragment, nodes: fragment.nodes.filter((n: SNode) => n.type !== 'ConstTag') },
          parent,
        );
        for (const { local, v, t } of bound.reverse())
          body = [
            {
              kind: 'each',
              items: { op: 'array', type: { array: t }, items: [v] },
              item: local,
              body,
            },
          ];
        return body;
      }
      const out: Node[] = [];
      let parts: Expr[] = [];
      const flush = () => {
        if (parts.length) out.push({ kind: 'text', parts });
        parts = [];
      };
      for (const n of cleaned) {
        if (n.type === 'Text') {
          if (n.data) parts.push({ op: 'lit', value: n.data });
        } else if (n.type === 'ExpressionTag') parts.push(display(exprNode(n.expression)));
        else if (n.type === 'RegularElement') {
          flush();
          out.push(element(n));
        } else if (n.type === 'SvelteElement') {
          flush();
          out.push(...dynamicElement(n));
        } else if (n.type === 'IfBlock' && decidedTest(u, n.test) !== undefined) {
          // A test the props' values decide: the branch that renders.
          flush();
          const branch = decidedTest(u, n.test) ? n.consequent : n.alternate;
          if (branch) out.push(...children(branch));
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
        } else if (n.type === 'RunicDynamic') {
          flush();
          out.push(...dynamicComponent(n));
        } else if (n.type === 'HtmlTag') {
          flush();
          out.push(htmlTag(n));
        } else if (n.type === 'RenderTag' && localSnippet(n)) {
          flush();
          const snippet = localSnippet(n)!;
          if (rendering.has(snippet))
            fail('E_TEMPLATE', 'A snippet that renders itself is unsupported', loc(n));
          if (n.expression.arguments.length)
            fail('E_TEMPLATE', 'This snippet takes no arguments', loc(n));
          rendering.add(snippet);
          try {
            out.push(...children(snippet.body));
          } finally {
            rendering.delete(snippet);
          }
        } else if (n.type === 'SnippetBlock' && localSnippets.at(-1)?.has(n.expression.name)) {
          // (Rendered where `{@render}` names it.)
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
     * `{@html value}` (frontend/html-fragments.ts): a constant string's
     * fragment, or, for another string, the fragments of the build-time data
     * tables' strings (a SvelteKit app's server data and endpoint
     * responses); the runtime selects the one whose string is the value.
     */
    const htmlTag = (n: SNode): Node => {
      const e = exprNode(n.expression);
      const known = lower.staticValue(e);
      const add = (html: string): number => {
        try {
          return fragments.add(html);
        } catch (err) {
          return fail('E_TEMPLATE', `{@html}: ${(err as Error).message}`, loc(n));
        }
      };
      if (known && typeof known.value === 'string')
        return {
          kind: 'html',
          value: { op: 'lit', value: known.value },
          fragments: known.value ? [add(known.value)] : [],
          source: loc(n),
        };
      const v = value(e);
      const t = typeOf(e, v);
      if (t !== 'string' && !(typeof t === 'object' && 'maybe' in t && t.maybe === 'string'))
        return fail('E_TEMPLATE', '{@html} needs a string', loc(n));
      const strings = graph.kit?.htmlStrings ?? [];
      if (!strings.length)
        return fail(
          'E_TEMPLATE',
          '{@html} of a value that is neither a constant nor build-time data is unsupported (HTML is parsed at build time only)',
          loc(n),
        );
      const candidates: number[] = [];
      for (const s of strings) {
        if (!s) continue;
        try {
          candidates.push(fragments.add(s));
        } catch {
          // A string holding unsupported markup: unsupported if it is ever the value.
        }
      }
      return { kind: 'html', value: v, fragments: candidates, source: loc(n) };
    };
    /**
     * A tag naming a component value (frontend/adapters/svelte-dynamic.ts):
     * an `if` chain on the value, one branch per candidate component (Svelte
     * creates the new component and destroys the old one when the value
     * changes, as switching branches does). A nullish value renders nothing;
     * another component (only through casts TypeScript cannot check) throws
     * a `TypeError`, as an unchecked class downcast does.
     */
    const dynamicComponent = (n: SNode): Node[] => {
      const e = exprNode(n.nameNode);
      const v = value(e);
      // (The value's own type: `{#if Example}` narrows TypeScript's.)
      const t = lower.irType(v, tb);
      const inner = maybeInner(t) ?? t;
      if (
        typeof inner !== 'object' ||
        !('record' in inner) ||
        lower.types.records[inner.record].name !== 'Component'
      )
        return fail('E_TEMPLATE', `${n.name} is not a component`, loc(n));
      const nullable = maybeInner(t) !== undefined;
      const missing: Node = {
        kind: 'text',
        parts: [{ op: 'unwrap', value: { op: 'undefined', type: { maybe: 'string' } } }],
      };
      let chain: Node[] = nullable
        ? [{ kind: 'if', test: { op: 'to-boolean', arg: v }, then: [missing], source: loc(n) }]
        : [missing];
      for (let k = n.cases.length - 1; k >= 0; k--) {
        const global: Expr = {
          op: 'global',
          global: componentGlobal(lower, rel(n.files[k])),
        };
        chain = [
          {
            kind: 'if',
            test: { op: 'eq', left: v, right: nullable ? { op: 'some', value: global } : global },
            then: [component(n.cases[k])],
            else: chain,
            source: loc(n),
          },
        ];
      }
      return chain;
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
      // `{#each items, i}` / `{#each items}`: no item binding.
      let pattern = n.context ? nodeAt(n.context) : undefined;
      if (pattern && ts.isVariableDeclaration(pattern)) pattern = pattern.name;
      const item = tb.local(pattern && ts.isIdentifier(pattern) ? pattern.text : '$item', itemType);
      if (pattern && ts.isIdentifier(pattern))
        lower.bindings.set(checker.getSymbolAtLocation(pattern)!, {
          kind: 'local',
          owner: tb,
          local: item,
        });
      else if (pattern) {
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
    /**
     * Where the entry `key` of the bag `e` comes from: `rest`, the rest
     * props' entry (present or not); `absent`, no entry; undefined where it
     * may come from elsewhere. Bags: the rest props, and constants of object
     * literals (also as `$derived(…)`), whose last entry that may hold the
     * key gives it. (The rest props hold the snippets they reached as
     * slots, `forwardedSlots`, beyond their shape.)
     */
    const restEntryOf = (
      e: ts.Expression,
      key: string,
      seen = new Set<ts.Node>(),
    ): 'rest' | 'absent' | undefined => {
      e = skipParens(e);
      if (!ts.isIdentifier(e) || seen.has(e)) return undefined;
      seen.add(e);
      const binding = lower.binding(e);
      if (binding?.kind === 'cell' && cells[binding.cell].prop === '...') return 'rest';
      const sym = checker.getSymbolAtLocation(e);
      const decl = sym?.valueDeclaration;
      if (
        !decl ||
        !ts.isVariableDeclaration(decl) ||
        !(decl.parent.flags & ts.NodeFlags.Const) ||
        !decl.initializer
      )
        return undefined;
      let init = skipParens(decl.initializer);
      if (
        ts.isCallExpression(init) &&
        init.expression.getText() === '$derived' &&
        init.arguments.length === 1
      )
        init = skipParens(init.arguments[0]);
      if (!ts.isObjectLiteralExpression(init)) return undefined;
      for (const p of [...init.properties].reverse()) {
        if (ts.isSpreadAssignment(p)) {
          const from = restEntryOf(p.expression, key, seen);
          const may = mayHold(shapes.of(p.expression), key);
          if (from === 'rest' && (may || forwardedSlots.has(key))) return 'rest';
          if (from === 'absent' || !may) continue;
          return undefined;
        }
        const name = p.name && shapes.propertyName(p.name);
        if (name === undefined) return undefined;
        if (name === key) return undefined;
      }
      return 'absent';
    };
    /**
     * `{@render name(args)}` / `{@render name?.(args)}` of a snippet prop → a
     * slot; also of a snippet the rest props hold, read from a bag of them
     * (shadcn-svelte's `{@render mergedProps.children?.()}` of
     * `mergedProps = $derived({ class: …, ...restProps })`): the slot it
     * reached the rest props as, nothing where no site passes it.
     */
    const render = (n: SNode): Node => {
      let call = exprNode(n.expression);
      while (ts.isParenthesizedExpression(call)) call = call.expression;
      const callee = ts.isCallExpression(call) ? call.expression : undefined;
      let name =
        callee && ts.isIdentifier(callee)
          ? snippetOf.get(checker.getSymbolAtLocation(callee)!)
          : undefined;
      let member: ts.Expression | undefined = callee;
      while (member && ts.isNonNullExpression(member)) member = member.expression;
      if (!name && member && ts.isPropertyAccessExpression(member)) {
        const key = member.name.text;
        const from = restEntryOf(member.expression, key);
        const optional = !!(call as ts.CallExpression).questionDotToken;
        const passed = mayHold(restShape.get(u.file) ?? openShape(), key);
        if (from === 'rest' && forwardedSlots.has(key) && !passed) name = key;
        // No site passes it (as a snippet or a value): the bag has no such
        // entry, and an optional call renders nothing.
        else if (
          optional &&
          (from === 'absent' || (from === 'rest' && !forwardedSlots.has(key) && !passed))
        )
          return { kind: 'if', test: { op: 'lit', value: false }, then: [], source: loc(n) };
      }
      if (!name)
        return fail('E_TEMPLATE', '{@render} supports snippet props of this component', loc(n));
      // Snippets the rest props received are slots, not bag entries: a bag
      // of the rest props passed to a snippet lacks them. Svelte's holds
      // them where the instance received both, so a site passing both is
      // rejected.
      if (
        forwardedSlots.size &&
        (call as ts.CallExpression).arguments.some(a => mentionsRest(a, u.file))
      )
        for (const held of forwardedSlots)
          if (held !== name && sitePassesBoth(u.file, name, held))
            fail(
              'E_TEMPLATE',
              `${name} receives a bag of the rest props, which hold the snippet ${held} where a site passes both; snippets in bags passed to snippets are unsupported`,
              loc(n),
            );
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
      const named = /^on([a-z]+)$/.exec(name)?.[1];
      // (`on<event>capture`: a listener of the capture phase.)
      const kind =
        named && !EVENT_KINDS.includes(named as HandlerEvent) && named.endsWith('capture')
          ? named.slice(0, -'capture'.length)
          : named;
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
      // Values of other types (a number, an array, an object: M6 overlays,
      // bits-ui forwards `sideOffset` and `collisionBoundary`) reach the
      // receiving component as they are; an element the bag is spread onto
      // sets a number's text (docs/IR.md, attrs).
      const inner = typeof t === 'object' && 'maybe' in t ? t.maybe : t;
      if (bagValueType(inner)) return { name, value: v };
      if (typeof t === 'object' && 'maybe' in t) return { name, value: maybeAttribute(v, t, a) };
      // `title={undefined}`: an entry holding undefined (no attribute, and
      // it overrides an earlier entry of its name), not the text "undefined".
      if (v.op === 'undefined')
        return { name, value: { op: 'undefined', type: { maybe: 'string' } } };
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
        if (a.type === 'SpreadAttribute') {
          // A bag the pack reads by name (frontend/bags.ts). Snippets this
          // component received in its rest props are slots, not entries, so
          // a spread of them would not pass them on.
          const e = exprNode(a.expression) as ts.Expression;
          if (forwardedSlots.size && mentionsRest(e, u.file))
            reject(
              a,
              `this spread passes on the rest props, which hold the snippets ${[...forwardedSlots].join(', ')}`,
            );
          attrs.push({ name: '...', at: loc(a), value: { spread: e } });
          continue;
        }
        if (a.type !== 'Attribute') reject(a, `${a.type} on ${n.name} are not covered`);
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
      return component.expand(attrs, {
        lower,
        b: tb,
        at: loc(n),
        fail,
        bags: {
          shape: e => shapes.of(e),
          values: (e, key) => shapes.values(e, key),
          value: e => lower.bagValue(e, tb),
        },
      });
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
      /** Snippet props of this component passed on as the child's (`{content}`). */
      const forwarded: { name: string; params?: number[]; body: Node[]; when?: Expr }[] = [];
      for (const a of n.attributes) {
        // A snippet prop of this component passed on as one of the child's
        // (bits-ui's `<FloatingLayerContent {content} />`): provided to the
        // child when it was to this component.
        const slotDecl =
          a.type === 'Attribute' && !declared(a.name)
            ? target.slots?.find(d => d.name === a.name)
            : undefined;
        if (slotDecl) {
          const e =
            a.value !== true && !Array.isArray(a.value)
              ? skipParens(exprNode(a.value.expression))
              : undefined;
          const own =
            e && ts.isIdentifier(e) ? snippetOf.get(checker.getSymbolAtLocation(e)!) : undefined;
          if (!own)
            fail(
              'E_TEMPLATE',
              `${a.name} is a snippet prop of ${n.name}: pass a {#snippet} block or a snippet prop of this component`,
              loc(a),
            );
          const mine = slots.find(d => d.name === own)!;
          if (JSON.stringify(mine.params ?? []) !== JSON.stringify(slotDecl.params ?? []))
            fail(
              'E_TEMPLATE',
              `${own} and ${n.name}'s ${a.name} take different parameters`,
              loc(a),
            );
          const params = (slotDecl.params ?? []).map((t, i) => tb.local(`$${a.name}${i}`, t));
          forwarded.push({
            name: a.name,
            ...(params.length ? { params } : {}),
            body: [
              {
                kind: 'slot',
                name: own!,
                ...(params.length
                  ? { args: params.map(p => ({ op: 'local', local: p }) as Expr) }
                  : {}),
              },
            ],
            when: { op: 'slot-provided', name: own! },
          });
          continue;
        }
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
          const rest = spreadsRest(u.file, a);
          // Snippets this component received in its rest props are passed
          // on only by spreads of the rest props (or of constants merging
          // them): another bag built from them would lose them.
          if (!rest && forwardedSlots.size && mentionsRest(e, u.file))
            fail(
              'E_TEMPLATE',
              `This spread passes on the rest props, which hold the snippets ${[...forwardedSlots].join(', ')}: spread the rest props or a mergeProps(…) constant of them`,
              loc(a),
            );
          spreads.push({ expr: e, shape, rest, at: a });
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
          // (Without rest props, names the child does not declare are getters
          // nothing reads, as for attributes: bits-ui's
          // `<EscapeLayer {...mergedProps} …>` of DialogContent's props.)
          continue;
        }
        if (a.type === 'Attribute' && restCell >= 0 && !declared(a.name)) {
          bag.push(restEntry(a));
          continue;
        }
        // A prop the child neither declares nor collects in rest props: Svelte
        // passes it as a getter nothing reads, so it is never evaluated (M6:
        // bits-ui passes FocusScope `forceMount`, mdsx its blueprint the
        // page's metadata).
        if (a.type === 'Attribute' && restCell < 0 && !declared(a.name)) continue;
        // A binding after spreads that may hold its prop (bits-ui's
        // `<HiddenInput {...hiddenInputState.props} bind:value />`) gives
        // the prop: Svelte's props read the last source holding it.
        if (a.type === 'BindDirective') writers.delete(a.name);
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
            let from = typeOf(e, v);
            // A prop whose default is not lowered (no site leaves it
            // undefined) takes a nullable value only where TypeScript has
            // narrowed it to present (`{#if el}<Target to={el} />`).
            const inner = maybeInner(from);
            if (inner && !maybeInner(want) && unusedDefaults.has(`${child.index}:${propCell(a)}`)) {
              const t = checker.getTypeAtLocation(e);
              if (checker.getNonNullableType(t) !== t)
                fail(
                  'E_PROPS',
                  `${n.name}'s prop ${a.name} is passed a value that may be null or undefined here, which its type does not hold`,
                  loc(a),
                );
              v = { op: 'unwrap', value: v };
              from = inner;
            }
            // A prop of this component that only ever holds undefined (no
            // site passes it, it has no default and is never written:
            // shadcn-svelte's CommandDialog `portalProps`, typed by its
            // values as a nullable string), passed where another nullable
            // type is expected: undefined of that type.
            const decl = ts.isIdentifier(e) ? checker.getSymbolAtLocation(e) : undefined;
            const el = decl?.valueDeclaration;
            if (
              maybeInner(from) !== undefined &&
              maybeInner(want) !== undefined &&
              !sameType(from, want) &&
              el &&
              ts.isBindingElement(el) &&
              !el.initializer &&
              domains.values(decl!)?.every(x => x === undefined) &&
              domains.written(decl!) === false
            ) {
              v = { op: 'undefined', type: want };
              from = want;
            }
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
          // A member (bits-ui's Select root binds `rootState.opts.value.current
          // as string`): read there, and written there by the setter.
          if (b?.kind !== 'cell' && ts.isPropertyAccessExpression(e)) {
            const asserted = exprNode(a.expression);
            const read = value(asserted);
            const have = typeOf(asserted, read);
            const present = !!maybeInner(want) && sameType(have, maybeInner(want)!);
            if (!sameType(have, want) && !present)
              fail('E_TEMPLATE', `bind:${a.name} needs a value of the prop's type`, loc(a));
            if (present)
              presentWrites.push({
                component: child.index,
                cell: propCell(a),
                name: a.name,
                at: loc(a),
              });
            passed.push({
              name: a.name,
              value: present ? { op: 'some', value: read } : read,
              bind: lower.bindSetter(e, tb, want, present),
            });
            continue;
          }
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
          ws.every(
            w =>
              'explicit' in w ||
              spreadHolds(spreads[w.spread].expr, key, new Set()) ||
              // (Also a bag the census knows holds it: a mergeProps
              // result, frontend/unions.ts `bagHas`.)
              lower.unions.bagHolds(spreads[w.spread].expr, key),
          );
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
      defs.push(...forwarded);
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
     * An image's sources (M6 images, docs/design/M6-IMAGES.md): every value
     * its `src` can take must be known at build time (a literal, or an
     * expression with a finite set of string values: the value domains of
     * frontend/packs/choice.ts) and becomes an image URL the builder pins.
     * Attributes whose loading behaviour the runtime does not model are
     * rejected: `loading` (lazy loading changes when `load` fires), `srcset`
     * and `sizes` (selection by device pixel ratio; Blitz loads `src` only),
     * `crossorigin` (no canvas reads it), and the `naturalWidth`/
     * `naturalHeight` bindings. A spread (bits-ui's Avatar image: `<img
     * {...mergedProps} {src} />`) is supported where the bag provably holds
     * none of those names with a value (absent, undefined or null: frontend/
     * bags.ts), and where its `src` is determined: an attribute after every
     * spread, or the bags' `src` values (each spread's, from the last; one
     * that may not hold it leaves it to those before it).
     */
    const IMG_REJECTED: Record<string, string> = {
      loading: 'lazy loading changes when load fires',
      srcset: 'the runtime loads src only, without selection by device pixel ratio',
      sizes: 'the runtime loads src only, without selection by device pixel ratio',
      crossorigin: 'it only affects canvas reads, and there is no canvas',
    };
    const imageSources = (n: SNode) => {
      for (const a of n.attributes) {
        if (a.type === 'BindDirective' && a.name !== 'this')
          fail('E_TEMPLATE', `bind:${a.name} on <img> is not supported`, loc(a));
        if (a.type === 'SpreadAttribute') {
          const bag = nodeIn(u, a.expression) as ts.Expression;
          const shape = shapes.of(bag);
          for (const [name, why] of Object.entries(IMG_REJECTED)) {
            if (!mayHold(shape, name)) continue;
            const values = shapes.values(bag, name);
            // (Svelte sets false as the attribute "false": only absent,
            // undefined and null remove it.)
            const valued = values?.find(v => v !== ABSENT && v !== undefined && v !== null);
            if (!values || valued !== undefined)
              fail(
                'E_TEMPLATE',
                `This spread may give the <img> a ${name} attribute${
                  values ? ` (${JSON.stringify(valued)})` : ' (its values are open)'
                }, which is not supported (${why})`,
                loc(a),
              );
          }
        }
        if (a.type !== 'Attribute') continue;
        if (IMG_REJECTED[a.name])
          fail(
            'E_TEMPLATE',
            `The ${a.name} attribute of <img> is not supported (${IMG_REJECTED[a.name]})`,
            loc(a),
          );
      }
      const record = (values: unknown[], at: SNode, what: string) => {
        for (const v of values) {
          // No attribute: no request.
          if (v === undefined || v === null || v === ABSENT) continue;
          if (typeof v !== 'string')
            fail(
              'E_ASSET',
              `The src of this <img> may be ${JSON.stringify(v)}${what}, not a URL`,
              loc(at),
            );
          imageUrls.push({ url: v as string, source: loc(at) });
        }
      };
      const srcAt = n.attributes.findLastIndex(
        (a: SNode) => a.type === 'Attribute' && a.name === 'src',
      );
      const at = srcAt >= 0 ? n.attributes[srcAt] : undefined;
      // Spreads after the attribute, from the last.
      const later = n.attributes
        .slice(srcAt + 1)
        .filter((a: SNode) => a.type === 'SpreadAttribute')
        .reverse();
      for (const spread of later) {
        const bag = nodeIn(u, spread.expression) as ts.Expression;
        if (!mayHold(shapes.of(bag), 'src')) continue;
        const values = shapes.values(bag, 'src');
        if (!values)
          fail(
            'E_ASSET',
            'The src this spread may give the <img> is open: image sources must have a finite set of string values known at build time (literals, or values of a literal union type), each pinned as an asset; or set src as an attribute after the spread',
            loc(spread),
          );
        record(values!, spread, ' (from this spread)');
        if (!values!.includes(ABSENT)) return;
      }
      if (!at) return;
      const values: unknown[] | undefined =
        at.value === true
          ? ['']
          : Array.isArray(at.value)
            ? at.value.every((v: SNode) => v.type === 'Text')
              ? [at.value.map((v: SNode) => v.data).join('')]
              : at.value.length === 1
                ? valueSet({ lower, label: '<img src>' }, exprNode(at.value[0].expression))
                : undefined
            : valueSet({ lower, label: '<img src>' }, exprNode(at.value.expression));
      if (!values) {
        const what =
          'image sources must have a finite set of string values known at build time (literals, or values of a literal union type), each pinned as an asset';
        // (A value passed on through props: where it comes from.)
        const single =
          at.value !== true && !Array.isArray(at.value)
            ? exprNode(at.value.expression)
            : Array.isArray(at.value) && at.value.length === 1 && at.value[0].expression
              ? exprNode(at.value[0].expression)
              : undefined;
        const origin = single && openOrigin({ lower, label: '<img src>' }, single);
        const here = loc(at);
        if (origin && origin !== single)
          fail(
            'E_ASSET',
            `The src of an <img> (${here.file}:${here.line}:${here.column}) may take this value, which is open: ${what}`,
            lower.sourceOf(origin)!,
          );
        fail('E_ASSET', `The src of this <img> is open: ${what}`, here);
      }
      record(values!, at, '');
    };
    /** A fieldset's `disabled`, also from a spread that may hold it (FIELDSET_DISABLED). */
    const fieldsetAttributes = (n: SNode) => {
      for (const a of n.attributes)
        if (
          (a.type === 'Attribute' && a.name === 'disabled') ||
          (a.type === 'SpreadAttribute' &&
            mayHold(shapes.of(nodeIn(u, a.expression) as ts.Expression), 'disabled'))
        )
          fail('E_TEMPLATE', FIELDSET_DISABLED(a.type === 'SpreadAttribute'), loc(a));
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
      if (n.name === 'img') imageSources(n);
      if (n.name === 'fieldset') fieldsetAttributes(n);
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
      // bind_value's start: a nullish bound value takes the control's value
      // (a spread's defaultValue) at mount.
      let adoptWhen: Expr | undefined;
      const styles: { name: string; value: Expr }[] = [];
      const classes: { name: string; value: Expr }[] = [];
      let spread: { at: number; value: Expr; shape: Shape } | undefined;
      let reference: number | undefined;
      for (const a of n.attributes) {
        if (a.type === 'Attribute') {
          const name: string = a.name;
          if (/^on[a-z]+$/.test(name)) {
            const event = name.slice(2);
            // An image's outcome (M6 images): `<img>` attributes only.
            if (IMAGE_EVENT_KINDS.includes(event as HandlerEvent) && n.name !== 'img')
              fail('E_EVENT', `on${event} handlers are supported on <img> elements only`, loc(a));
            if (
              !EVENT_KINDS.includes(event as HandlerEvent) &&
              !IMAGE_EVENT_KINDS.includes(event as HandlerEvent)
            )
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
            } else if (name === 'class' && (t === 'string' || t === 'dyn')) {
              // Svelte 5 resolves class values with clsx and omits an empty class.
              // (A dynamic value is unboxed to a string with a check: clsx's
              // objects and arrays are not supported, docs/GAPS.md.)
              const temp = tb.local('$class', 'string');
              const read: Expr = { op: 'local', local: temp };
              attrs.push({
                name,
                value: {
                  op: 'with',
                  local: temp,
                  value:
                    t === 'dyn' ? { op: 'builtin', name: 'dyn.to', args: [v], type: 'string' } : v,
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
          if (nullable)
            adoptWhen = { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: 'boolean' };
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
      // The binding's write alone, not the element's own input handler.
      let adopt: { when: Expr; handler: number; args?: Expr[] } | undefined;
      if (bound && adoptWhen) {
        const { args, ...h } = JSON.parse(JSON.stringify(bound.handler)) as typeof bound.handler;
        handlers.push({ event: 'input', ...h, source: loc(n) });
        adopt = {
          when: adoptWhen,
          handler: handlers.length - 1,
          ...(args?.length ? { args } : {}),
        };
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
        ...(adopt ? { adopt } : {}),
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
    schema: 5,
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
    styles: {
      css: graph.css,
      ...(graph.styleGuards ? { guards: graph.styleGuards } : {}),
    },
    assets: graph.assets,
    // Nothing resolves image URLs yet (docs/design/M6-IMAGES.md).
    images: [],
    records: types.records,
    functions: lower.functions,
    globals: lower.globals,
    components,
    root: units.get(rootFile!)!.index,
    // Delegated listeners and microtask flushes (the defaults); teardowns
    // read state as it was before the batch that destroys or re-runs them.
    schedule: { cleanupReadsPrevious: true },
    ...(fragments.list.length ? { fragments: fragments.list } : {}),
  };
  lower.checkStyleSpreads(ir);
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
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  imageUrls.push(...lower.imageUrls);
  return imageUrls.length ? { ir, imageUrls } : { ir };
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
/**
 * A type of the values a bag passes to declared props besides text,
 * booleans, functions and style objects (runic_ir::builtins::bag_value_type).
 */
function bagValueType(t: Type): boolean {
  if (typeof t === 'string')
    return !['void', 'event', 'attrs', 'string', 'boolean', 'contexts', 'mounted'].includes(t);
  return !('fn' in t) && !('maybe' in t);
}

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
  // Static and dynamic values meet (M6 dynamic values): boxed, or unboxed
  // with a check.
  if (from === 'dyn' && to !== 'dyn') return { op: 'builtin', name: 'dyn.to', args: [v], type: to };
  if (to === 'dyn' && from !== 'dyn' && from !== 'void')
    return {
      op: 'builtin',
      name: 'dyn.from',
      args: [v, { op: 'lit', value: JSON.stringify(from) }],
      type: 'dyn',
    };
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
