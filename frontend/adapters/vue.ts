// Vue 3.5 <script setup> adapter on the shared language layer
// (docs/design/M2-VALUES.md). Framework semantics only:
// - ref → deep-tracked cell read/written through `.value`; computed → derived;
//   reads observe earlier writes immediately;
// - templates unwrap refs (typed through a synthetic template function);
// - interpolation follows toDisplayString; bindings follow Vue 3 attribute
//   coercion; inline handlers are statements with `$event`.
import ts from 'typescript';
import path from 'node:path';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type { Cell, Component, Expr, Handler, Node, Program } from '../ir.ts';
import { Lowerer, skipParens, type Hooks } from '../language.ts';
import { createProgram, VUE } from '../program.ts';
import { TypeMapper } from '../types.ts';
import { lowerModules } from '../modules.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VNode = any;

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
const BOOLEAN_ATTRS = new Set([
  'disabled',
  'readonly',
  'hidden',
  'required',
  'checked',
  'autofocus',
  'multiple',
]);
const ELEMENT = 1;
const TEXT = 2;
const COMMENT = 3;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

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
    compiler: { parse: (src: string, opts: object) => { descriptor: VNode; errors: unknown[] } };
  };
}

function locate(text: string, offset: number, file: string) {
  const lines = text.slice(0, offset).split('\n');
  return { file, line: lines.length, column: lines.at(-1)!.length + 1 };
}

export async function lowerVue(graph: Graph): Promise<{ ir: Program }> {
  const { root } = graph;
  const fail = (code: string, message: string, source?: object): never => {
    throw new Diagnostic(code, message, source);
  };
  // --- Bootstrap: createApp(App).mount('#root') ---
  const entry = ts.createSourceFile(
    graph.entry,
    graph.modules.get(graph.entry)!.code,
    ts.ScriptTarget.Latest,
    true,
  );
  let componentFile: string | undefined;
  const local = new Map<string, string>();
  let createName: string | undefined;
  let bootstrap: ts.Expression | undefined;
  for (const stmt of entry.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const edge = graph.modules.get(graph.entry)!.imports.find(i => i.specifier === spec);
      const clause = stmt.importClause;
      if (!clause) continue;
      if (spec === 'vue' && clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const b of clause.namedBindings.elements) {
          if ((b.propertyName ?? b.name).text !== 'createApp')
            fail('E_CAPABILITY', 'Vue entry only imports createApp');
          createName = b.name.text;
        }
      else if (edge?.resolved.endsWith('.vue') && clause.name)
        local.set(clause.name.text, edge.resolved);
      else fail('E_IMPORT', 'Entry requires a local default SFC import and Vue createApp');
    } else if (ts.isExpressionStatement(stmt) && !bootstrap) bootstrap = stmt.expression;
    else fail('E_BOOTSTRAP', 'Vue entry may only import its component/CSS and mount once');
  }
  const mount =
    bootstrap &&
    ts.isCallExpression(bootstrap) &&
    ts.isPropertyAccessExpression(bootstrap.expression)
      ? bootstrap.expression
      : undefined;
  const create = mount && ts.isCallExpression(mount.expression) ? mount.expression : undefined;
  if (
    create &&
    ts.isIdentifier(create.expression) &&
    create.expression.text === createName &&
    ts.isIdentifier(create.arguments[0])
  )
    componentFile = local.get(create.arguments[0].text);
  if (!componentFile || mount!.name.text !== 'mount')
    fail('E_BOOTSTRAP', 'Expected createApp(App).mount("#root")');
  const file = componentFile!;
  const original = graph.modules.get(file)!.code;
  const fileRel = path.relative(root, file);
  const { descriptor, errors } = graph.tooling.compiler.parse(original, { filename: file });
  if (errors.length) fail('E_PARSE', String(errors[0]));
  if (
    !descriptor.scriptSetup ||
    descriptor.script ||
    !descriptor.template ||
    descriptor.styles.length ||
    descriptor.customBlocks.length
  )
    fail(
      'E_SFC',
      'Use one template and <script setup> (component styles are M6; import CSS instead)',
    );
  const loc = (n: VNode) => locate(original, n.loc?.start.offset ?? 0, fileRel);

  // --- Virtual module: script + synthetic template function ---
  const script: string = descriptor.scriptSetup.content;
  const scriptStart: number = descriptor.scriptSetup.loc.start.offset;
  const segments: { synth: number; orig: number; length: number }[] = [];
  const scriptSf = ts.createSourceFile('setup.ts', script, ts.ScriptTarget.Latest, true);
  const topNames: string[] = [];
  for (const stmt of scriptSf.statements) {
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name)) topNames.push(d.name.text);
    if (ts.isFunctionDeclaration(stmt) && stmt.name) topNames.push(stmt.name.text);
  }
  let synthetic =
    script +
    `\nfunction __runic_template(__u = { ${topNames.map(n => `${n}: __runic_unref(${n})`).join(', ')} }) {\n  const { ${topNames.join(', ')} } = __u;\n`;
  const exprIndex = new Map<VNode, number>();
  let count = 0;
  const add = (node: VNode, code: string, prefix: string, suffix: string) => {
    synthetic += prefix;
    segments.push({ synth: synthetic.length, orig: node.loc.start.offset, length: code.length });
    synthetic += code + suffix;
    exprIndex.set(node, count++);
  };
  const collect = (n: VNode) => {
    if (n.type === INTERPOLATION) add(n.content, n.content.content, '(', ');\n');
    if (n.type === ELEMENT)
      for (const p of n.props) {
        if (p.type !== DIRECTIVE || !p.exp) continue;
        if (p.name === 'on') {
          const code: string = p.exp.content;
          const simple = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(code.trim());
          if (simple) add(p.exp, code, '(', ');\n');
          else if (
            /^\s*(\(.*?\)|[A-Za-z_$][\w$]*)\s*=>/.test(code) ||
            /^\s*(async\s+)?function\b/.test(code)
          )
            add(p.exp, code, '(', ');\n');
          else add(p.exp, code, '(($event: any) => { ', ' });\n');
        } else add(p.exp, p.exp.content, '(', ');\n');
      }
    for (const c of n.children ?? []) collect(c);
  };
  for (const c of descriptor.template.ast.children) collect(c);
  synthetic += '}\n';
  const virtual = file + '.__runic.ts';
  const files = new Map<string, string>([[virtual, synthetic]]);
  for (const [id, m] of graph.modules)
    if (/\.(ts|js|mjs)$/.test(id) && id.startsWith(root + path.sep)) files.set(id, m.code);
  const program = createProgram(files, [VUE]);
  const sf = program.getSourceFile(virtual)!;
  const syntax = program.getSyntacticDiagnostics(sf)[0];
  if (syntax)
    fail(
      'E_PARSE',
      ts.flattenDiagnosticMessageText(syntax.messageText, '\n'),
      syntax.start !== undefined ? sourceAt(syntax.start) : undefined,
    );
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
      return { file: path.relative(root, f.fileName), line: p.line + 1, column: p.character + 1 };
    }
    return sourceAt(n.getStart(sf));
  };
  const tsFail = (n: ts.Node, code: string, message: string): never =>
    fail(code, message, sourceOf(n));
  const checker = program.getTypeChecker();
  const types = new TypeMapper(checker, tsFail);
  const cells: Cell[] = [];
  const COMPONENT = 0;
  const hooks: Hooks = {
    readCell: cell => ({ op: 'cell', cell, read: 'current' }),
    cellType: cell => cells[cell].type,
    writeCell: (cell, value) => [{ op: 'set', cell, value }],
  };
  const lower = new Lowerer(program, checker, types, hooks, tsFail, sourceOf);
  const vueCall = (e: ts.Expression | undefined): string | undefined => {
    if (!e || !ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    const s = checker.getSymbolAtLocation(e.expression);
    const decl =
      s && (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).declarations?.[0];
    return decl && decl.getSourceFile().fileName === VUE ? e.expression.text : undefined;
  };

  // --- Setup bindings ---
  const statements = [...sf.statements].filter(s => s.getStart(sf) < script.length);
  const pending = lowerModules(graph, program, lower, {
    skip: f => f === graph.entry,
  });
  const setupBindings = new Map<string, ts.Symbol>();
  for (const stmt of statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (stmt.importClause?.isTypeOnly) continue;
      if (spec === 'vue') {
        const named = stmt.importClause?.namedBindings;
        if (named && ts.isNamedImports(named))
          for (const el of named.elements) {
            const n = (el.propertyName ?? el.name).text;
            if (!['ref', 'computed', 'shallowRef'].includes(n))
              tsFail(el, 'E_CAPABILITY', `vue:${n} is planned for M3/M4`);
          }
        continue;
      }
      if (spec.endsWith('.vue')) tsFail(stmt, 'E_TEMPLATE', 'Child components are planned for M3');
      if (!spec.startsWith('.'))
        tsFail(stmt, 'E_DEPENDENCY', `No adapter for dependency ${spec} (npm libraries are M6)`);
      continue;
    }
    if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const sym = checker.getSymbolAtLocation(stmt.name)!;
      setupBindings.set(stmt.name.text, sym);
      const p = lower.declare(sym, stmt, stmt.name.text, COMPONENT);
      if (p) pending.push(p);
      continue;
    }
    if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & ts.NodeFlags.Const) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer)
          tsFail(d, 'E_DECLARATION', 'Destructured setup declarations are planned for M3');
        const name = (d.name as ts.Identifier).text;
        const sym = checker.getSymbolAtLocation(d.name)!;
        setupBindings.set(name, sym);
        const init = skipParens(d.initializer!);
        const kind = vueCall(init);
        if (kind === 'ref' || kind === 'shallowRef') {
          const call = init as ts.CallExpression;
          const refType = checker.getTypeOfSymbolAtLocation(sym, d) as ts.TypeReference;
          const [inner] = checker.getTypeArguments(refType);
          if (!inner) tsFail(d, 'E_REF', 'Unexpected ref type');
          const type = types.map(inner, d);
          const cell = cells.length;
          cells.push({
            name,
            type,
            init: { op: 'undefined', type },
            tracking: kind === 'ref' ? 'deep' : 'identity',
            source: sourceOf(d),
          });
          lower.bindings.set(sym, { kind: 'ref', cell });
          pending.push(() => {
            const arg = call.arguments[0];
            if (!arg) return;
            const v = lower.value(arg, COMPONENT, `${name}$init`);
            const from = lower.exprType(arg);
            const widen =
              typeof type === 'object' &&
              'maybe' in type &&
              !(typeof from === 'object' && 'maybe' in from);
            cells[cell].init = widen ? { op: 'some', value: v } : v;
          });
          continue;
        }
        if (kind === 'computed') {
          const getter = (init as ts.CallExpression).arguments[0];
          if (!getter || !(ts.isArrowFunction(getter) || ts.isFunctionExpression(getter)))
            tsFail(init, 'E_COMPUTED', 'computed takes a getter function');
          const index = lower.reserve();
          lower.bindings.set(sym, { kind: 'computed', fn: index });
          pending.push(() =>
            lower.function(getter as ts.ArrowFunction, name, undefined, COMPONENT, index),
          );
          continue;
        }
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const p = lower.declare(sym, init, name, COMPONENT);
          if (p) pending.push(p);
          continue;
        }
        // A setup constant, captured once.
        const cell = cells.length;
        const type = lower.exprType(init);
        cells.push({
          name,
          type,
          init: { op: 'undefined', type },
          tracking: 'identity',
          source: sourceOf(d),
        });
        lower.bindings.set(sym, { kind: 'cell', cell });
        pending.push(() => (cells[cell].init = lower.value(init, COMPONENT, `${name}$init`)));
      }
      continue;
    }
    tsFail(
      stmt,
      'E_STATEMENT',
      'Setup supports const declarations, functions and imports from vue (watchers/lifecycle are M4)',
    );
  }
  for (const p of pending) p();
  // Template-scope (unwrapped) bindings mirror the setup bindings.
  const templateFn = sf.statements.find(
    s => ts.isFunctionDeclaration(s) && s.name?.text === '__runic_template',
  ) as ts.FunctionDeclaration;
  const unwrapped = (templateFn.body!.statements[0] as ts.VariableStatement).declarationList
    .declarations[0].name as ts.ObjectBindingPattern;
  for (const el of unwrapped.elements) {
    const name = (el.name as ts.Identifier).text;
    const binding = lower.bindings.get(setupBindings.get(name)!);
    const sym = checker.getSymbolAtLocation(el.name)!;
    if (binding?.kind === 'ref') lower.bindings.set(sym, { kind: 'cell', cell: binding.cell });
    else if (binding?.kind === 'computed')
      lower.bindings.set(sym, { kind: 'derived', fn: binding.fn });
    else if (binding) lower.bindings.set(sym, binding);
  }
  const exprNode = (n: VNode): ts.Expression => {
    const stmt = templateFn.body!.statements[1 + exprIndex.get(n)!] as ts.ExpressionStatement;
    return (stmt.expression as ts.ParenthesizedExpression).expression;
  };

  // --- Template ---
  const handlers: Handler[] = [];
  const display = (e: ts.Expression): Expr => {
    // toDisplayString: nullish → '', arrays/objects → JSON with 2 spaces.
    const t = lower.exprType(e);
    const v = lower.value(e, COMPONENT, 'text');
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean') return { op: 'to-string', arg: v };
    if (typeof t === 'object' && ('array' in t || 'record' in t))
      return {
        op: 'builtin',
        name: 'JSON.stringify',
        args: [v, { op: 'undefined', type: { maybe: 'number' } }, { op: 'lit', value: 2 }],
        type: 'string',
      };
    if (typeof t === 'object' && 'maybe' in t) {
      const fn = lower.reserve();
      lower.functions[fn] = {
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
      return { op: 'call', function: fn, args: [] };
    }
    return fail('E_TEMPLATE', `Interpolating ${JSON.stringify(t)} is unsupported`, sourceOf(e));
  };
  const handlerFor = (p: VNode, event: 'click' | 'input'): number => {
    const e = skipParens(exprNode(p.exp));
    let h: Omit<Handler, 'event'>;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
      h = lower.handler(e, COMPONENT, event === 'input');
    else if (ts.isIdentifier(e)) {
      const b = lower.binding(e);
      if (b?.kind !== 'function' && b?.kind !== 'generic')
        return tsFail(e, 'E_EVENT', 'Event handlers must be functions');
      // A method handler receives the event: lower its body with that parameter.
      const sym = checker.getSymbolAtLocation(e);
      const decl =
        sym &&
        lower.bindings.get(sym) &&
        (setupDecl(e.text) as ts.FunctionLikeDeclaration | undefined);
      if (decl && decl.parameters.length) h = lower.handler(decl, COMPONENT, event === 'input');
      else if (b.kind === 'function')
        h = { body: [{ op: 'expr', value: { op: 'call', function: b.fn, args: [] } }] };
      else return tsFail(e, 'E_EVENT', 'Unsupported handler');
    } else return tsFail(e, 'E_EVENT', 'Unsupported event handler');
    handlers.push({ event, ...h, source: loc(p) });
    return handlers.length - 1;
  };
  const setupDecl = (name: string): ts.Node | undefined => {
    for (const stmt of statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
      if (ts.isVariableStatement(stmt))
        for (const d of stmt.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
            const i = skipParens(d.initializer);
            if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) return i;
          }
    }
    return undefined;
  };
  const condition = (e: ts.Expression): Expr => {
    const v = lower.value(e, COMPONENT, 'if');
    return lower.exprType(e) === 'boolean' ? v : { op: 'to-boolean', arg: v };
  };
  const children = (list: VNode[]): Node[] => {
    const out: Node[] = [];
    let parts: Expr[] = [];
    const flush = () => {
      if (parts.length) out.push({ kind: 'text', parts });
      parts = [];
    };
    const items = list.filter(n => n.type !== COMMENT);
    for (let i = 0; i < items.length; i++) {
      const n = items[i];
      if (n.type === TEXT) {
        if (n.content) parts.push({ op: 'lit', value: n.content });
      } else if (n.type === INTERPOLATION) parts.push(display(exprNode(n.content)));
      else if (n.type === ELEMENT) {
        flush();
        const vIf = n.props.find((p: VNode) => p.type === DIRECTIVE && p.name === 'if');
        if (!vIf) {
          if (
            n.props.some(
              (p: VNode) => p.type === DIRECTIVE && (p.name === 'else' || p.name === 'else-if'),
            )
          )
            fail('E_TEMPLATE', 'v-else without v-if', loc(n));
          out.push(element(n));
          continue;
        }
        // v-if / v-else-if / v-else chain → nested if nodes.
        const chain: { test?: VNode; node: VNode }[] = [{ test: vIf, node: n }];
        while (items[i + 1]?.type === ELEMENT) {
          const next = items[i + 1];
          const d = next.props.find(
            (p: VNode) => p.type === DIRECTIVE && (p.name === 'else-if' || p.name === 'else'),
          );
          if (!d) break;
          chain.push({ test: d.name === 'else' ? undefined : d, node: next });
          i++;
        }
        const build = (k: number): Node[] => {
          if (k >= chain.length) return [];
          const { test, node } = chain[k];
          if (!test) return [element(node)];
          return [
            {
              kind: 'if',
              test: condition(exprNode(test.exp)),
              then: [element(node)],
              else: build(k + 1),
              source: loc(node),
            },
          ];
        };
        out.push(...build(0));
      } else fail('E_TEMPLATE', 'Unsupported template node', loc(n));
    }
    flush();
    return out;
  };
  const element = (n: VNode): Node => {
    if (n.tagType !== 0 || !TAGS.has(n.tag))
      fail(
        'E_TEMPLATE',
        `<${n.tag}> is outside the supported elements (components are M3)`,
        loc(n),
      );
    const attrs: { name: string; value: Expr }[] = [];
    const props: { name: string; value: Expr }[] = [];
    const listeners: { event: 'click' | 'input'; handler: number }[] = [];
    for (const p of n.props) {
      if (p.type === ATTRIBUTE) {
        attrs.push({
          name: p.name,
          value: BOOLEAN_ATTRS.has(p.name)
            ? { op: 'lit', value: true }
            : { op: 'lit', value: p.value?.content ?? '' },
        });
        continue;
      }
      if (['if', 'else-if', 'else'].includes(p.name)) continue;
      if (p.modifiers?.length) fail('E_TEMPLATE', `Directive modifiers are planned for M5`, loc(p));
      if (p.name === 'on') {
        const event = p.arg?.content;
        if (event !== 'click' && event !== 'input')
          fail('E_EVENT', `@${event} is planned for M5`, loc(p));
        listeners.push({ event, handler: handlerFor(p, event) });
        continue;
      }
      if (p.name === 'bind' && p.arg?.isStatic) {
        const name: string = p.arg.content;
        const e = exprNode(p.exp);
        const t = lower.exprType(e);
        const v = lower.value(e, COMPONENT, name);
        if (name === 'value' && n.tag === 'input')
          props.push({ name, value: t === 'string' ? v : { op: 'to-string', arg: v } });
        else if (BOOLEAN_ATTRS.has(name))
          attrs.push({ name, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } });
        else if (typeof t === 'object' && 'maybe' in t && t.maybe === 'string')
          attrs.push({ name, value: v });
        else if (t === 'string' || t === 'number' || t === 'boolean')
          attrs.push({ name, value: t === 'string' ? v : { op: 'to-string', arg: v } });
        else
          fail(
            'E_TEMPLATE',
            `:${name} with ${JSON.stringify(t)} (class/style objects are M3)`,
            loc(p),
          );
        continue;
      }
      fail('E_TEMPLATE', `v-${p.name} is planned for a later milestone`, loc(p));
    }
    return {
      kind: 'element',
      tag: n.tag,
      ...(attrs.length ? { attrs } : {}),
      ...(props.length ? { props } : {}),
      ...(listeners.length ? { listeners } : {}),
      ...(n.children.length ? { children: children(n.children) } : {}),
      source: loc(n),
    };
  };
  const template = children(descriptor.template.ast.children);
  const comp: Component = { name: path.basename(file, '.vue'), cells, handlers, template };
  const capabilities = ['dom', 'css', 'window', 'click', 'keyboard'];
  if (handlers.some(h => h.event === 'input')) capabilities.push('text-input');
  const ir: Program = {
    schema: 4,
    meta: {
      title: graph.config.title,
      sourceHash: graph.hash,
      frontend: {
        adapter: 'vue',
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
    globals: lower.globals,
    components: [comp],
    root: 0,
    // Vue's app.mount() marks the container.
    containerAttrs: { 'data-v-app': '' },
  };
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  return { ir };
}
