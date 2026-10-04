// Svelte 5 (runes) adapter on the shared language layer (docs/design/M2-VALUES.md,
// docs/design/M3-COMPONENTS.md). Framework semantics only: runes → cells and
// derived functions with immediate reads and writes, `$props` → prop cells,
// child components → instances, `{#each}` → lists, template → IR nodes,
// events → handlers. Ordinary code goes through frontend/language.ts.
import ts from 'typescript';
import path from 'node:path';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type {
  AttrItem,
  Cell,
  Component,
  Expr,
  Handler,
  Listener,
  Node,
  Program,
  Stmt,
  Type,
  Effect,
} from '../ir.ts';
import { EVENT_KINDS } from '../ir.ts';
import { FnBuilder, Lowerer, remapLocals, type HandlerEvent, type Hooks } from '../language.ts';
import { createProgram, RUNES } from '../program.ts';
import { TypeMapper } from '../types.ts';
import { lowerModules } from '../modules.ts';
import { arrayElement } from '../irtype.ts';

// The svelte/compiler AST is untyped here; nodes are plain objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SNode = any;

const TAGS = new Set([
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
]);
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
  entry: string;
  hash: string;
  css: string;
  assets: { path: string; sha256: string; bytes: number; mime: string }[];
  manifest: unknown;
  config: { title: string; renderer?: 'cpu' | 'gpu' };
  modules: Map<string, { code: string; imports: { specifier: string; resolved: string }[] }>;
  tooling: {
    packages: Record<string, string>;
    compiler: { parse: (src: string, opts: object) => SNode };
  };
}

type Source = { file: string; line: number; column: number };

/** Source location in the original file for an offset. */
function locate(text: string, offset: number, file: string): Source {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { file, line: lines.length, column: lines.at(-1)!.length + 1 };
}

/** A `.svelte` file and its virtual TypeScript module. */
interface Unit {
  file: string;
  rel: string;
  original: string;
  ast: SNode;
  index: number;
  virtual: string;
  synthetic: string;
  /** Script length and its offset in the original file. */
  scriptLength: number;
  /** End of the script statements in the virtual module (the script and synthesized code). */
  statementsEnd: number;
  scriptStart: number;
  /** Synthetic ranges copied from the original (template expressions, patterns). */
  segments: { synth: number; orig: number; length: number }[];
  /** Synthetic start of each template expression, each pattern and each index. */
  starts: Map<SNode, number>;
  /** Child components by local name. */
  children: Map<string, string>;
}

export async function lowerSvelte(graph: Graph): Promise<{ ir: Program }> {
  const { root } = graph;
  const fail = (code: string, message: string, source?: Source): never => {
    throw new Diagnostic(code, message, source);
  };
  const rel = (f: string) => path.relative(root, f);

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

  // --- Components: parse, then build each virtual module (children first) ---
  const units = new Map<string, Unit>();
  const order: Unit[] = [];
  const parse = (file: string, from?: Source): Unit => {
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
    const loc = (n: SNode) => locate(original, n.start ?? 0, fileRel);
    if (ast.module)
      fail('E_TEMPLATE', '<script module> is planned for a later milestone', loc(ast.module));
    if (ast.css)
      fail(
        'E_TEMPLATE',
        'Component styles (scoped CSS) are planned for M6; import local CSS instead',
        loc(ast.css),
      );
    if (ast.options) fail('E_TEMPLATE', '<svelte:options> is unsupported', loc(ast.options));
    const script = ast.instance
      ? original.slice(ast.instance.content.start, ast.instance.content.end)
      : '';
    // Child components imported by the instance script.
    const children = new Map<string, string>();
    const scriptSf = ts.createSourceFile(file + '.ts', script, ts.ScriptTarget.Latest, true);
    for (const stmt of scriptSf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (!spec.endsWith('.svelte')) continue;
      const edge = graph.modules.get(file)!.imports.find(i => i.specifier === spec);
      const name = stmt.importClause?.name?.text;
      if (!edge || !name || stmt.importClause?.namedBindings)
        fail(
          'E_IMPORT',
          'Import components as `import Name from "./Name.svelte"`',
          locate(original, ast.instance.content.start + stmt.getStart(scriptSf), fileRel),
        );
      children.set(name!, edge!.resolved);
    }
    return {
      file,
      rel: fileRel,
      original,
      ast,
      index: -1,
      virtual: file + '.__runic.ts',
      synthetic: '',
      scriptLength: script.length,
      statementsEnd: script.length,
      scriptStart: ast.instance ? ast.instance.content.start : 0,
      segments: [],
      starts: new Map(),
      children,
    };
  };
  const visit = (file: string, stack: string[], from?: Source) => {
    if (stack.includes(file))
      fail('E_COMPONENT', 'Recursive components are planned for a later milestone', from);
    if (units.has(file)) return;
    const u = parse(file, from);
    units.set(file, u);
    for (const [, child] of u.children)
      visit(child, [...stack, file], { file: u.rel, line: 1, column: 1 });
    u.index = order.length;
    order.push(u);
  };
  visit(rootFile!, []);

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
  const restKeys = new Map<string, Set<string>>();
  for (const [file, d] of decls) if (d.rest) restKeys.set(file, new Set());
  const forwards: { from: string; to: string; at: Source }[] = [];
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
  for (const u of order) {
    const rest = decls.get(u.file)!.rest;
    walkTemplate(u.ast.fragment, n => {
      if (n.type !== 'Component' && n.type !== 'RegularElement') return;
      for (const a of n.attributes ?? []) {
        if (a.type === 'SpreadAttribute') {
          if (!rest || a.expression.type !== 'Identifier' || a.expression.name !== rest)
            fail(
              'E_TEMPLATE',
              'Spread attributes are supported for rest props ({...rest}); other spreads are planned for later',
              locate(u.original, a.start, u.rel),
            );
          if (n.type === 'Component') {
            const to = u.children.get(n.name);
            if (to) forwards.push({ from: u.file, to, at: locate(u.original, a.start, u.rel) });
          }
        } else if (
          n.type === 'Component' &&
          (a.type === 'Attribute' || a.type === 'BindDirective')
        ) {
          const to = u.children.get(n.name);
          const keys = to && restKeys.get(to);
          if (keys && !decls.get(to)!.declared.has(a.name)) keys.add(a.name);
        }
      }
    });
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const { from, to, at } of forwards) {
      const into = restKeys.get(to);
      if (!into) fail('E_PROPS', 'The component takes no rest props', at);
      for (const k of restKeys.get(from)!)
        if (!into!.has(k)) {
          into!.add(k);
          changed = true;
        }
    }
  }
  for (const { from, to, at } of forwards)
    for (const k of restKeys.get(from)!)
      if (decls.get(to)!.declared.has(k))
        fail(
          'E_PROPS',
          `The rest props may hold ${k}, which the receiving component declares; pass ${k} explicitly`,
          at,
        );

  // The props type each component exports to its parents' virtual modules.
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

  // Virtual modules: the script, then the template as typed statements.
  for (const u of order) {
    const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
    let s = script + '\n';
    const copy = (start: number, end: number) => {
      u.segments.push({ synth: s.length, orig: start, length: end - start });
      s += u.original.slice(start, end);
    };
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
        const event = JSON.stringify(a.name.slice(2));
        const name = `__runic_${target}_${hosts++}`;
        s += `const ${name} = (`;
        copy(a.value.expression.start, a.value.expression.end);
        s += `) satisfies (event: HostEventMap[${event}]) => void;\n$effect.pre(() => { ${target}.addEventListener(${event}, ${name}); return () => ${target}.removeEventListener(${event}, ${name}); });\n`;
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
        } else if (n.type === 'Component') {
          if (!u.children.has(n.name))
            fail(
              'E_TEMPLATE',
              `${n.name} is not an imported component`,
              locate(u.original, n.start, u.rel),
            );
          // Props are checked against the child's props type (typing inline callbacks).
          s += `((__p: __RunicProps_${n.name}) => 0)({\n`;
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
              for (const param of sn.parameters) u.starts.set(param, base + (param.start - first));
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
        }
      }
    };
    fragment(u.ast.fragment);
    s += '}\n';
    for (const [name, file] of u.children)
      s += `import type { __RunicProps as __RunicProps_${name} } from ${JSON.stringify(units.get(file)!.virtual)};\n`;
    s += `export type __RunicProps = ${propsType(u)};\n`;
    u.synthetic = s;
  }
  const files = new Map<string, string>();
  for (const u of order) files.set(u.virtual, u.synthetic);
  for (const [id, m] of graph.modules)
    if (/\.(ts|js|mjs)$/.test(id) && id.startsWith(root + path.sep)) files.set(id, m.code);
  const program = createProgram(files, [RUNES]);
  const unitOf = new Map<ts.SourceFile, Unit>();
  for (const u of order) unitOf.set(program.getSourceFile(u.virtual)!, u);
  const sourceAt = (u: Unit, pos: number): Source => {
    if (pos < u.scriptLength) return locate(u.original, u.scriptStart + pos, u.rel);
    const seg = u.segments.find(s => pos >= s.synth && pos <= s.synth + s.length);
    return seg
      ? locate(u.original, seg.orig + (pos - seg.synth), u.rel)
      : { file: u.rel, line: 1, column: 1 };
  };
  const sourceOf = (n: ts.Node): Source => {
    const f = n.getSourceFile();
    const u = unitOf.get(f);
    if (!u) {
      const p = f.getLineAndCharacterOfPosition(n.getStart(f));
      return { file: rel(f.fileName), line: p.line + 1, column: p.character + 1 };
    }
    return sourceAt(u, n.getStart(f));
  };
  for (const u of order) {
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
  const tsFail = (n: ts.Node, code: string, message: string): never =>
    fail(code, message, sourceOf(n));
  const checker = program.getTypeChecker();
  const types = new TypeMapper(checker, tsFail);

  // --- Lowering state (one component at a time) ---
  let cells: Cell[] = [];
  /** The name a binding imported from 'svelte' has there (`undefined` for other bindings). */
  const svelteImport = (id: ts.Identifier): string | undefined => {
    const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
    if (!decl || !ts.isImportSpecifier(decl)) return undefined;
    const from = decl.parent.parent.parent.moduleSpecifier;
    return ts.isStringLiteral(from) && from.text === 'svelte'
      ? (decl.propertyName ?? decl.name).text
      : undefined;
  };
  const hooks: Hooks = {
    readCell: cell => ({ op: 'cell', cell, read: 'current' }),
    cellType: cell => cells[cell].type,
    writeCell: (cell, value) => [{ op: 'set', cell, value }],
    call(node, _ctx, lower) {
      // tick(): a microtask that runs any pending flush, then fulfils.
      if (ts.isIdentifier(node.expression) && svelteImport(node.expression) === 'tick') {
        if (node.arguments.length) return tsFail(node, 'E_CALL', 'tick takes no arguments');
        return { op: 'builtin', name: 'flush.tick', args: [], type: { promise: 'void' } };
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
  const lower = new Lowerer(program, checker, types, hooks, tsFail, sourceOf);
  // The script runs once per instance: its functions keep their identity.
  lower.stableFunctions = true;
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
  // Ordinary local modules initialise first (dependencies first).
  for (const p of lowerModules(graph, program, lower, { skip: f => f === graph.entry })) p();

  const components: Component[] = [];
  for (const u of order) components[u.index] = lowerComponent(u);

  function lowerComponent(u: Unit): Component {
    cells = [];
    const COMPONENT = u.index;
    const sf = program.getSourceFile(u.virtual)!;
    const loc = (n: SNode) => locate(u.original, n.start ?? 0, u.rel);
    const statements = [...sf.statements].filter(s => s.getStart(sf) < u.statementsEnd);
    const pending: (() => void)[] = [];
    /** Snippet props become slots: declaration and the prop's symbol. */
    const slots: { name: string; params?: Type[] }[] = [];
    const effects: Effect[] = [];
    /** Local names of the lifecycle functions imported from 'svelte'. */
    const lifecycle = new Map<string, string>();
    const snippetOf = new Map<ts.Symbol, string>();
    /** Parameter types of a `Snippet<[A, B]>` prop, or undefined for other props. */
    const snippetParams = (node: ts.Node): Type[] | undefined => {
      const t = checker.getNonNullableType(checker.getTypeAtLocation(node));
      const sym = t.aliasSymbol ?? t.getSymbol();
      const file = sym?.declarations?.[0]?.getSourceFile().fileName ?? '';
      if (sym?.name !== 'Snippet' || !/[\\/]svelte[\\/]/.test(file)) return undefined;
      const [tuple] = checker.getTypeArguments(t as ts.TypeReference);
      if (!tuple) return [];
      if (!checker.isTupleType(tuple))
        return tsFail(node, 'E_PROPS', 'Snippet parameters must be a tuple type');
      return checker.getTypeArguments(tuple as ts.TypeReference).map(x => types.map(x, node));
    };

    /** `let { a, b = 1, c = $bindable() }: Props = $props()` → prop cells. */
    const props = (d: ts.VariableDeclaration) => {
      if (!ts.isObjectBindingPattern(d.name))
        return tsFail(d, 'E_PROPS', 'Destructure $props(): let { a, b } = $props()');
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
        const type = types.of(el.name) as Type;
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
          pending.push(() => {
            const v = lower.value(f, COMPONENT, `${name}$default`);
            cells[cell].init = coerceInit(v, lower.valueType(v), type);
          });
        }
      }
    };

    /**
     * `$effect`, `$effect.pre`, `onMount` and `onDestroy` (docs/design/M4-EFFECTS.md):
     * effects tracking what they read, or running once; Svelte tears effects
     * down after removing the DOM, pre effects before the component's children.
     */
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
            const imported = (el.propertyName ?? el.name).text;
            if (!['onMount', 'onDestroy', 'tick'].includes(imported))
              tsFail(
                el,
                'E_CAPABILITY',
                `svelte's ${imported} is planned for a later milestone (onMount and onDestroy are supported)`,
              );
            lifecycle.set(el.name.text, imported);
          }
          continue;
        }
        if (spec.startsWith('svelte/'))
          tsFail(stmt, 'E_CAPABILITY', `${spec} imports (stores, reactivity) are planned for M6`);
        if (spec.endsWith('.svelte')) continue;
        if (!spec.startsWith('.'))
          tsFail(stmt, 'E_DEPENDENCY', `No adapter for dependency ${spec} (npm libraries are M6)`);
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
          // Intl constants have no runtime value (their uses are lowered).
          if (lower.isIntlConstant(d)) continue;
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
              } else {
                const v = lower.value(call.arguments[0], COMPONENT, `${name}$derived`);
                lower.functions[index] = {
                  name,
                  component: COMPONENT,
                  params: [],
                  locals: [],
                  result: types.of(d.name),
                  body: [{ op: 'return', value: v }],
                  derived: true,
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
          if (rune && !['$state', '$state.raw'].includes(rune))
            tsFail(
              init!,
              'E_RUNE',
              `${rune} is planned for a later milestone (see docs/ROADMAP.md)`,
            );
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
            if (rune) value = (init as ts.CallExpression).arguments[0];
            if (!value) {
              cells[cell].init = { op: 'undefined', type };
              return;
            }
            // The IR type of the lowered value (a bare `null` takes its contextual type).
            const v = lower.value(value, COMPONENT, `${name}$init`);
            cells[cell].init = coerceInit(v, lower.valueType(v), type);
          });
        }
        continue;
      }
      if (ts.isExpressionStatement(stmt)) {
        effect(stmt);
        continue;
      }
      if (ts.isClassDeclaration(stmt))
        tsFail(stmt, 'E_TYPE_UNSUPPORTED', 'Classes are planned for later');
      if (!ts.isEmptyStatement(stmt))
        tsFail(stmt, 'E_STATEMENT', 'Unsupported component statement');
    }
    for (const p of pending) p();

    // --- Template ---
    const tb: FnBuilder = lower.template(COMPONENT);
    const handlers: Handler[] = [];
    /** The TS node of a template expression (or each pattern) by its synthetic span. */
    const nodeAt = (n: SNode, length = n.end - n.start): ts.Node => {
      const start = u.starts.get(n);
      if (start === undefined) return fail('E_INTERNAL', 'Template expression not mapped', loc(n));
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
      return found ?? fail('E_INTERNAL', 'Template expression not found', loc(n));
    };
    const exprNode = (e: SNode) => nodeAt(e) as ts.Expression;
    const value = (e: ts.Expression): Expr => lower.expr(e, tb);
    const typeOf = (e: ts.Expression, v: Expr): Type =>
      types.typeOrUndefined(e) ?? lower.irType(v, tb);
    const display = (e: ts.Expression): Expr => {
      // Svelte renders `value ?? ''` stringified.
      const v = value(e);
      const t = typeOf(e, v);
      if (t === 'string') return v;
      if (typeof t === 'object' && 'maybe' in t) return maybeText(lower, v, t);
      return { op: 'to-string', arg: v };
    };
    const clean = (fragment: SNode, parent?: string): SNode[] => {
      // Comments, <svelte:window> and <svelte:document> leave no node;
      // the text around them joins.
      const list: SNode[] = [];
      for (const n of fragment.nodes) {
        if (['Comment', 'SvelteWindow', 'SvelteDocument'].includes(n.type)) continue;
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
      const drops = ['select', 'tr', 'table', 'tbody', 'thead', 'tfoot', 'colgroup', 'datalist'];
      if (parent && drops.includes(parent))
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
        } else if (n.type === 'IfBlock') {
          flush();
          const testNode = exprNode(n.test);
          const tv = value(testNode);
          out.push({
            kind: 'if',
            test: typeOf(testNode, tv) === 'boolean' ? tv : { op: 'to-boolean', arg: tv },
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
        return coerceInit(v, typeOf(a, v), decl.params![i]);
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
        return { name, value: { op: 'lit', value: BOOLEAN_ATTRS.has(name) ? true : '' } };
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
      if (kind) {
        const listener =
          EVENT_KINDS.includes(kind as HandlerEvent) &&
          typeof t === 'object' &&
          'fn' in t &&
          (t.fn.params.length === 0 || (t.fn.params.length === 1 && t.fn.params[0] === 'event'));
        if (!listener)
          fail('E_EVENT', `${name} in rest props must be a listener of a supported event`, loc(a));
        return { name, value: v };
      }
      if (BOOLEAN_ATTRS.has(name))
        return { name, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } };
      if (t === 'string' || (typeof t === 'object' && 'maybe' in t && t.maybe === 'string'))
        return { name, value: v };
      if (typeof t === 'object' && 'maybe' in t)
        fail('E_TEMPLATE', `Attribute ${name} of type ${JSON.stringify(t)} is unsupported`, loc(a));
      return { name, value: { op: 'to-string', arg: v } };
    };
    const component = (n: SNode): Node => {
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
      for (const a of n.attributes) {
        if (a.type === 'SpreadAttribute') {
          if (restCell < 0) fail('E_PROPS', `${n.name} takes no rest props`, loc(a));
          bag.push({ spread: value(exprNode(a.expression)) });
          continue;
        }
        if (a.type === 'Attribute' && restCell >= 0 && !declared(a.name)) {
          bag.push(restEntry(a));
          continue;
        }
        if (a.type === 'Attribute') {
          const want = target.cells[propCell(a)].type;
          let v: Expr;
          if (a.value === true) v = { op: 'lit', value: true };
          else if (Array.isArray(a.value)) {
            let joined: Expr | undefined;
            for (const part of a.value) {
              const p: Expr =
                part.type === 'Text'
                  ? { op: 'lit', value: part.data }
                  : display(exprNode(part.expression));
              joined = joined ? { op: 'concat', left: joined, right: p } : p;
            }
            v = joined ?? { op: 'lit', value: '' };
          } else {
            const e = exprNode(a.value.expression);
            v = value(e);
            v = coerceInit(v, typeOf(e, v), want);
          }
          passed.push({ name: a.name, value: v });
        } else if (a.type === 'BindDirective') {
          const want = target.cells[propCell(a)].type;
          const e = exprNode(a.expression);
          const b = ts.isIdentifier(e) ? lower.binding(e) : undefined;
          if (b?.kind !== 'cell' || JSON.stringify(cells[b.cell].type) !== JSON.stringify(want))
            fail('E_TEMPLATE', `bind:${a.name} needs a $state variable of the prop's type`, loc(a));
          const own = (b as { cell: number }).cell;
          const setter = lower.reserve();
          lower.functions[setter] = {
            name: `bind:${a.name}`,
            component: COMPONENT,
            params: [{ name: 'v', type: want }],
            locals: [],
            result: 'void',
            body: [{ op: 'set', cell: own, value: { op: 'local', local: 0 } }],
          };
          passed.push({
            name: a.name,
            value: { op: 'cell', cell: own, read: 'current' },
            bind: { op: 'closure', function: setter, captures: [] },
          });
        } else fail('E_TEMPLATE', `${a.type} on components is planned for a later M3 step`, loc(a));
      }
      if (bag.length) passed.push({ name: '...', value: { op: 'attrs', items: bag } });
      for (const c of target.cells)
        if (c.prop && !passed.some(p => p.name === c.prop) && isRequired(c.init))
          fail('E_PROPS', `${n.name} requires the prop ${c.prop}`, loc(n));
      // Snippets and children: parent-owned content for the child's slots.
      const defs: { name: string; params?: number[]; body: Node[] }[] = [];
      const declOf = (name: string, at: SNode) =>
        target.slots?.find(d => d.name === name) ??
        fail('E_PROPS', `${n.name} has no snippet prop ${name}`, loc(at));
      for (const sn of n.fragment.nodes.filter((c: SNode) => c.type === 'SnippetBlock')) {
        const name: string = sn.expression.name;
        const decl = declOf(name, sn);
        if (sn.parameters.length !== (decl.params?.length ?? 0))
          fail(
            'E_TEMPLATE',
            `Snippet ${name} takes ${decl.params?.length ?? 0} parameters`,
            loc(sn),
          );
        const params = sn.parameters.map((param: SNode, i: number) => {
          let id = nodeAt(param);
          if (ts.isParameter(id)) id = id.name;
          if (!ts.isIdentifier(id))
            fail('E_TEMPLATE', 'Destructured snippet parameters are planned for later', loc(param));
          const local = tb.local((id as ts.Identifier).text, decl.params![i]);
          lower.bindings.set(checker.getSymbolAtLocation(id)!, { kind: 'local', owner: tb, local });
          return local;
        });
        defs.push({ name, ...(params.length ? { params } : {}), body: children(sn.body) });
      }
      const content = n.fragment.nodes.filter((c: SNode) => c.type !== 'SnippetBlock');
      if (content.some((c: SNode) => c.type !== 'Text' || c.data.trim())) {
        declOf('children', n);
        defs.push({ name: 'children', body: children({ nodes: content }) });
      }
      return {
        kind: 'component',
        component: child.index,
        ...(passed.length ? { props: passed } : {}),
        ...(defs.length ? { slots: defs } : {}),
        source: loc(n),
      };
    };
    const element = (n: SNode): Node => {
      if (!TAGS.has(n.name))
        fail('E_TEMPLATE', `<${n.name}> is outside the supported elements`, loc(n));
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
      let spread: { at: number; value: Expr } | undefined;
      let reference: number | undefined;
      for (const a of n.attributes) {
        if (a.type === 'Attribute') {
          const name: string = a.name;
          if (/^on[a-z]+$/.test(name)) {
            const event = name.slice(2);
            if (!EVENT_KINDS.includes(event as HandlerEvent))
              fail('E_EVENT', `on${event} handlers are planned for a later milestone`, loc(a));
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
          if (name.toLowerCase() !== name)
            fail('E_TEMPLATE', `Attribute ${name} must be lowercase`, loc(a));
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
              attrs.push({
                name,
                value:
                  t.maybe === 'string'
                    ? v
                    : fail(
                        'E_TEMPLATE',
                        `Attribute ${name} of type ${JSON.stringify(t)} is unsupported`,
                        loc(a),
                      ),
              });
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
          if (JSON.stringify(typeOf(target, read)) !== JSON.stringify(kind))
            fail('E_TEMPLATE', `bind:${a.name} needs an assignable ${kind} value`, loc(a));
          props.push({ name: a.name, value: read });
          // A select's value binding follows its change event (Svelte's
          // bind_select_value), reading the chosen option's value.
          const select = n.name === 'select';
          const event: HandlerEvent = kind === 'string' && !select ? 'input' : 'change';
          const written: Expr | undefined = select
            ? { op: 'builtin', name: 'event.value', args: [{ op: 'event' }], type: 'string' }
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
          spread = { at: n.attributes.indexOf(a), value: value(exprNode(a.expression)) };
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
      // With a spread of rest props, the element's own attributes that the
      // bag may also hold join it in source order (a later one wins).
      let bag: Expr | undefined;
      if (spread) {
        const keys = restKeys.get(u.file)!;
        const position = (name: string) =>
          n.attributes.findIndex((a: SNode) => a.type === 'Attribute' && a.name === name);
        const before: AttrItem[] = [];
        const after: AttrItem[] = [];
        for (const a of [...attrs])
          if (keys.has(a.name)) {
            (position(a.name) < spread.at ? before : after).push({ name: a.name, value: a.value });
            attrs.splice(attrs.indexOf(a), 1);
          }
        for (const l of listeners)
          if (keys.has(`on${l.event}`))
            fail(
              'E_TEMPLATE',
              `on${l.event} is both on the element and possibly in the spread rest props`,
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
        ...(bag ? { spread: bag } : {}),
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
      mappings: [],
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

/** Widen an initial value to the cell type (T → Maybe<T>). */
function coerceInit(v: Expr, from: Type, to: Type): Expr {
  // A null or undefined default takes the prop's type.
  if ((v.op === 'null' || v.op === 'undefined') && typeof to === 'object' && 'maybe' in to)
    return { op: v.op, type: to };
  if (typeof to === 'object' && 'maybe' in to && !(typeof from === 'object' && 'maybe' in from))
    return { op: 'some', value: v };
  return v;
}

const isReference = (t: Type): boolean =>
  typeof t === 'object' &&
  ('array' in t ||
    'record' in t ||
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
