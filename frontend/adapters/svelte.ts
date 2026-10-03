// Svelte 5 (runes) adapter on the shared language layer (docs/design/M2-VALUES.md).
// Framework semantics only: runes → cells/derived functions, immediate reads
// and writes, template → IR nodes, events → handlers. Ordinary code goes
// through frontend/language.ts.
import ts from 'typescript';
import path from 'node:path';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type { Cell, Component, Expr, Handler, Node, Program, Stmt, Type } from '../ir.ts';
import { Lowerer, type Hooks } from '../language.ts';
import { createProgram, RUNES } from '../program.ts';
import { TypeMapper } from '../types.ts';
import { lowerModules } from '../modules.ts';

// The svelte/compiler AST is untyped here; nodes are plain objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SNode = any;

const TAGS = new Set([
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

/** Source location in the original file for an offset. */
function locate(text: string, offset: number, file: string) {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { file, line: lines.length, column: lines.at(-1)!.length + 1 };
}

export async function lowerSvelte(graph: Graph): Promise<{ ir: Program }> {
  const { root } = graph;
  const fail = (
    code: string,
    message: string,
    source?: { file: string; line: number; column: number },
  ): never => {
    throw new Diagnostic(code, message, source);
  };

  // --- Bootstrap: mount(App, { target: document.getElementById('root') }) ---
  const entryCode = graph.modules.get(graph.entry)!.code;
  const entry = ts.createSourceFile(graph.entry, entryCode, ts.ScriptTarget.Latest, true);
  const rel = (f: string) => path.relative(root, f);
  const at = (sf: ts.SourceFile, n: ts.Node) => {
    const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { file: rel(sf.fileName), line: p.line + 1, column: p.character + 1 };
  };
  let componentFile: string | undefined;
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
    if (component && ts.isIdentifier(component)) componentFile = componentNames.get(component.text);
  }
  if (!componentFile)
    fail(
      'E_BOOTSTRAP',
      'Expected mount(App, {target: document.getElementById("root")})',
      bootstrap ? at(entry, bootstrap) : undefined,
    );
  const file = componentFile!;
  const original = graph.modules.get(file)!.code;
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
  if (ast.module) fail('E_TEMPLATE', '<script module> is planned for M3', loc(ast.module));
  if (ast.css)
    fail(
      'E_TEMPLATE',
      'Component styles (scoped CSS) are planned for M6; import local CSS instead',
      loc(ast.css),
    );
  if (ast.options) fail('E_TEMPLATE', '<svelte:options> is unsupported', loc(ast.options));

  // --- Virtual TypeScript module: script + template expressions ---
  const script = ast.instance
    ? original.slice(ast.instance.content.start, ast.instance.content.end)
    : '';
  const scriptStart = ast.instance ? ast.instance.content.start : 0;
  const segments: { synth: number; orig: number; length: number }[] = [];
  let synthetic = script + '\nfunction __runic_template() {\n';
  const templateExprs: SNode[] = [];
  const addExpr = (e: SNode) => {
    const text = original.slice(e.start, e.end);
    synthetic += '(';
    segments.push({ synth: synthetic.length, orig: e.start, length: text.length });
    synthetic += text + ');\n';
    templateExprs.push(e);
  };
  const collect = (n: SNode) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(collect);
    if (n.type === 'ExpressionTag') addExpr(n.expression);
    else if (n.type === 'IfBlock') addExpr(n.test);
    else if (n.type === 'Attribute' && n.value !== true) {
      for (const v of Array.isArray(n.value) ? n.value : [n.value])
        if (v.type === 'ExpressionTag') addExpr(v.expression);
      return;
    } else if (n.type === 'BindDirective') addExpr(n.expression);
    for (const [k, v] of Object.entries(n))
      if (k !== 'metadata' && v && typeof v === 'object') collect(v);
  };
  collect(ast.fragment);
  synthetic += '}\n';
  const virtual = file + '.__runic.ts';
  const files = new Map<string, string>([[virtual, synthetic]]);
  for (const [id, m] of graph.modules)
    if (/\.(ts|js|mjs)$/.test(id) && id.startsWith(root + path.sep)) files.set(id, m.code);
  const program = createProgram(files, [RUNES]);
  const sf = program.getSourceFile(virtual)!;
  const syntax = program.getSyntacticDiagnostics(sf);
  if (syntax.length) {
    const d = syntax[0];
    fail(
      'E_PARSE',
      ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      d.start !== undefined ? sourceAt(d.start) : undefined,
    );
  }
  function sourceAt(pos: number) {
    if (pos < script.length) return locate(original, scriptStart + pos, fileRel);
    const seg = segments.find(s => pos >= s.synth && pos <= s.synth + s.length);
    return seg
      ? locate(original, seg.orig + (pos - seg.synth), fileRel)
      : { file: fileRel, line: 1, column: 1 };
  }
  const sourceOf = (n: ts.Node) => {
    const f = n.getSourceFile();
    if (f !== sf) {
      const p = f.getLineAndCharacterOfPosition(n.getStart(f));
      return { file: rel(f.fileName), line: p.line + 1, column: p.character + 1 };
    }
    return sourceAt(n.getStart(sf));
  };
  const tsFail = (n: ts.Node, code: string, message: string): never =>
    fail(code, message, sourceOf(n));
  const checker = program.getTypeChecker();
  const types = new TypeMapper(checker, tsFail);

  // --- Component state ---
  const cells: Cell[] = [];
  const COMPONENT = 0;
  const hooks: Hooks = {
    readCell: cell => ({ op: 'cell', cell, read: 'current' }),
    cellType: cell => cells[cell].type,
    writeCell: (cell, value) => [{ op: 'set', cell, value }],
    call(node, _ctx, lower) {
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

  const statements = [...sf.statements].filter(s => s.getStart(sf) < script.length);
  // Ordinary local modules initialise first (dependencies first).
  const pending = lowerModules(graph, program, lower, cells, COMPONENT, {
    skip: f => f === graph.entry,
  });
  // Pass 1: register bindings (functions are hoisted; cells get indices).
  for (const stmt of statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (stmt.importClause?.isTypeOnly) continue;
      if (spec === 'svelte' || spec.startsWith('svelte/'))
        tsFail(
          stmt,
          'E_CAPABILITY',
          `${spec} imports (lifecycle, context, stores) are planned for M3/M4`,
        );
      if (spec.endsWith('.svelte'))
        tsFail(stmt, 'E_TEMPLATE', 'Child components are planned for M3');
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
        if (!ts.isIdentifier(d.name))
          tsFail(
            d,
            'E_DECLARATION',
            'Destructured component declarations are planned for M3 ($props)',
          );
        const name = (d.name as ts.Identifier).text;
        const sym = checker.getSymbolAtLocation(d.name)!;
        const init = d.initializer;
        const rune = runeName(init);
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
            } else {
              const v = lower.value(call.arguments[0], COMPONENT, `${name}$derived`);
              lower.functions[index] = {
                name,
                component: COMPONENT,
                params: [],
                locals: [],
                result: types.of(d.name),
                body: [{ op: 'return', value: v }],
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
          tsFail(init!, 'E_RUNE', `${rune} is planned for a later milestone (see docs/ROADMAP.md)`);
        const cell = cells.length;
        const type = types.of(d.name) as Type;
        const tracking =
          rune === '$state'
            ? 'deep'
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
          cells[cell].init = value
            ? coerceInit(lower.value(value, COMPONENT, `${name}$init`), lower.exprType(value), type)
            : { op: 'undefined', type };
        });
      }
      continue;
    }
    if (ts.isExpressionStatement(stmt))
      tsFail(stmt, 'E_STATEMENT', 'Top-level statements ($effect, calls) are planned for M4');
    if (ts.isClassDeclaration(stmt))
      tsFail(stmt, 'E_TYPE_UNSUPPORTED', 'Classes are planned for later');
    if (!ts.isEmptyStatement(stmt)) tsFail(stmt, 'E_STATEMENT', 'Unsupported component statement');
  }
  for (const p of pending) p();

  // --- Template ---
  const exprNode = (e: SNode): ts.Expression => {
    const index = templateExprs.indexOf(e);
    const fn = sf.statements.find(
      s => ts.isFunctionDeclaration(s) && s.name?.text === '__runic_template',
    ) as ts.FunctionDeclaration;
    const stmt = fn.body!.statements[index] as ts.ExpressionStatement;
    return (stmt.expression as ts.ParenthesizedExpression).expression;
  };
  const handlers: Handler[] = [];
  const display = (e: ts.Expression): Expr => {
    // Svelte renders `value ?? ''` stringified.
    const t = types.of(e);
    const v = lower.value(e, COMPONENT, 'text');
    if (t === 'string') return v;
    if (typeof t === 'object' && 'maybe' in t) {
      const wrapper = lower.reserve();
      lower.functions[wrapper] = {
        name: 'text$maybe',
        component: COMPONENT,
        params: [],
        locals: [{ name: '$v', type: t }],
        result: 'string',
        body: [
          { op: 'let', local: 0, value: v },
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
      return { op: 'call', function: wrapper, args: [] };
    }
    return { op: 'to-string', arg: v };
  };
  const clean = (fragment: SNode): SNode[] => {
    const list = fragment.nodes
      .filter((n: SNode) => n.type !== 'Comment')
      .map((n: SNode) => ({ ...n }));
    while (list[0]?.type === 'Text' && !list[0].data.trim()) list.shift();
    while (list.at(-1)?.type === 'Text' && !list.at(-1).data.trim()) list.pop();
    if (list[0]?.type === 'Text') list[0].data = list[0].data.trimStart();
    if (list.at(-1)?.type === 'Text') list.at(-1).data = list.at(-1).data.trimEnd();
    for (let i = 0; i < list.length; i++)
      if (list[i].type === 'Text') {
        if (list[i - 1]?.type !== 'ExpressionTag') list[i].data = list[i].data.replace(/^\s+/, ' ');
        if (list[i + 1]?.type !== 'ExpressionTag') list[i].data = list[i].data.replace(/\s+$/, ' ');
      }
    return list;
  };
  const handlerFor = (value: SNode, event: 'click' | 'input', where: SNode): number => {
    const e = exprNode(value);
    let h: Omit<Handler, 'event'>;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
      h = lower.handler(e, COMPONENT, event === 'input');
    else if (ts.isIdentifier(e)) {
      const b = lower.binding(e);
      if (b?.kind !== 'function')
        return fail('E_EVENT', 'Event handlers must be functions', loc(where));
      const target = lower.functions[b.fn];
      if (target && target.params.length)
        return fail(
          'E_EVENT',
          'Named handlers with typed parameters: use an inline arrow function',
          loc(where),
        );
      h = { body: [{ op: 'expr', value: { op: 'call', function: b.fn, args: [] } }] };
    } else return fail('E_EVENT', 'Unsupported event handler expression', loc(where));
    handlers.push({ event, ...h, source: loc(where) });
    return handlers.length - 1;
  };
  const children = (fragment: SNode): Node[] => {
    const out: Node[] = [];
    let parts: Expr[] = [];
    const flush = () => {
      if (parts.length) out.push({ kind: 'text', parts });
      parts = [];
    };
    for (const n of clean(fragment)) {
      if (n.type === 'Text') {
        if (n.data) parts.push({ op: 'lit', value: n.data });
      } else if (n.type === 'ExpressionTag') parts.push(display(exprNode(n.expression)));
      else if (n.type === 'RegularElement') {
        flush();
        out.push(element(n));
      } else if (n.type === 'IfBlock') {
        flush();
        const testNode = exprNode(n.test);
        const tv = lower.value(testNode, COMPONENT, 'if');
        out.push({
          kind: 'if',
          test: types.of(testNode) === 'boolean' ? tv : { op: 'to-boolean', arg: tv },
          then: children(n.consequent),
          ...(n.alternate ? { else: children(n.alternate) } : {}),
          source: loc(n),
        });
      } else if (
        n.type === 'EachBlock' ||
        n.type === 'KeyBlock' ||
        n.type === 'SnippetBlock' ||
        n.type === 'RenderTag' ||
        n.type === 'Component'
      )
        fail('E_TEMPLATE', `${n.type} is planned for M3`, loc(n));
      else if (n.type === 'AwaitBlock')
        fail('E_TEMPLATE', 'Await blocks are planned for M4', loc(n));
      else fail('E_TEMPLATE', `Unsupported template node ${n.type}`, loc(n));
    }
    flush();
    return out;
  };
  const element = (n: SNode): Node => {
    if (!TAGS.has(n.name))
      fail('E_TEMPLATE', `<${n.name}> is outside the supported elements`, loc(n));
    const attrs: { name: string; value: Expr }[] = [];
    const props: { name: string; value: Expr }[] = [];
    const listeners: { event: 'click' | 'input'; handler: number }[] = [];
    for (const a of n.attributes) {
      if (a.type === 'Attribute') {
        const name: string = a.name;
        if (/^on[a-z]+$/.test(name)) {
          const event = name.slice(2);
          if (event !== 'click' && event !== 'input')
            fail('E_EVENT', `on${event} handlers are planned for M5`, loc(a));
          if (a.value === true || Array.isArray(a.value))
            fail('E_EVENT', 'Event attributes need a handler expression', loc(a));
          listeners.push({
            event: event as 'click' | 'input',
            handler: handlerFor(a.value.expression, event as 'click' | 'input', a),
          });
          continue;
        }
        if (name.toLowerCase() !== name)
          fail('E_TEMPLATE', `Attribute ${name} must be lowercase`, loc(a));
        const values: SNode[] =
          a.value === true ? [] : Array.isArray(a.value) ? a.value : [a.value];
        if (a.value === true) {
          attrs.push({
            name,
            value: BOOLEAN_ATTRS.has(name) ? { op: 'lit', value: true } : { op: 'lit', value: '' },
          });
          continue;
        }
        if (values.length === 1 && values[0].type === 'ExpressionTag') {
          const e = exprNode(values[0].expression);
          const t = types.of(e);
          const v = lower.value(e, COMPONENT, name);
          if (name === 'value' && n.name === 'input') {
            props.push({ name, value: t === 'string' ? v : { op: 'to-string', arg: v } });
          } else if (BOOLEAN_ATTRS.has(name))
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
        let value: Expr | undefined;
        for (const v of values) {
          const part: Expr =
            v.type === 'Text' ? { op: 'lit', value: v.data } : display(exprNode(v.expression));
          value = value ? { op: 'concat', left: value, right: part } : part;
        }
        attrs.push({ name, value: value ?? { op: 'lit', value: '' } });
      } else if (a.type === 'BindDirective') {
        if (a.name !== 'value' || n.name !== 'input')
          fail('E_TEMPLATE', `bind:${a.name} is planned for M5`, loc(a));
        const target = exprNode(a.expression);
        const b = ts.isIdentifier(target) ? lower.binding(target) : undefined;
        if (b?.kind !== 'cell' || types.of(target) !== 'string')
          fail('E_TEMPLATE', 'bind:value needs a string $state variable', loc(a));
        const cell = (b as { cell: number }).cell;
        props.push({ name: 'value', value: { op: 'cell', cell } });
        handlers.push({
          event: 'input',
          body: [{ op: 'set', cell, value: { op: 'payload' } }],
          source: loc(a),
        });
        listeners.push({ event: 'input', handler: handlers.length - 1 });
      } else fail('E_TEMPLATE', `${a.type} is planned for a later milestone`, loc(a));
    }
    if (listeners.filter(l => l.event === 'input').length > 1)
      fail('E_EVENT', 'bind:value combined with oninput is unsupported', loc(n));
    return {
      kind: 'element',
      tag: n.name,
      ...(attrs.length ? { attrs } : {}),
      ...(props.length ? { props } : {}),
      ...(listeners.length ? { listeners } : {}),
      ...(n.fragment.nodes.length ? { children: children(n.fragment) } : {}),
      source: loc(n),
    };
  };
  const template = children(ast.fragment);
  const component: Component = { name: path.basename(file, '.svelte'), cells, handlers, template };
  const capabilities = ['dom', 'css', 'window', 'click', 'keyboard'];
  if (handlers.some(h => h.event === 'input')) capabilities.push('text-input');
  const ir: Program = {
    schema: 4,
    meta: {
      title: graph.config.title,
      sourceHash: graph.hash,
      frontend: {
        adapter: 'svelte',
        version: 2,
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
    components: [component],
    root: 0,
  };
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  return { ir };
}

/** Widen an initial value to the cell type (T → Maybe<T>). */
function coerceInit(v: Expr, from: Type, to: Type): Expr {
  if (typeof to === 'object' && 'maybe' in to && !(typeof from === 'object' && 'maybe' in from))
    return { op: 'some', value: v };
  return v;
}
