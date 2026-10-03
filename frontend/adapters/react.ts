// React 19 adapter on the shared language layer (docs/design/M2-VALUES.md).
// Framework semantics only:
// - useState → identity-tracked cells; setters write, updater functions see
//   the pending value; every other read sees the render snapshot;
// - component-body `const` values are derived functions over that snapshot,
//   nested functions are component functions;
// - stateless child components are inlined with their props bound;
// - JSX → IR nodes with React's whitespace and child rendering rules.
import ts from 'typescript';
import path from 'node:path';
import { decodeHTMLStrict } from 'entities';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type { Cell, Component, Expr, Handler, Node, Program, Stmt, Type } from '../ir.ts';
import { Lowerer, skipParens, type Hooks } from '../language.ts';
import { createProgram, REACT } from '../program.ts';
import { TypeMapper } from '../types.ts';
import { lowerModules } from '../modules.ts';

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
/** React prop names → DOM attribute names. */
const ATTRS: Record<string, string> = {
  className: 'class',
  maxLength: 'maxlength',
  readOnly: 'readonly',
  tabIndex: 'tabindex',
};
const BOOLEAN_ATTRS = new Set([
  'disabled',
  'readonly',
  'hidden',
  'required',
  'checked',
  'autofocus',
  'multiple',
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
  tooling: { packages: Record<string, string> };
}

/** React's JSX text rule: trim lines, drop whitespace-only lines, join with spaces. */
/** The token at `pos` (an internal TypeScript API, stable across 5.x). */
const tokenAt = (ts as unknown as { getTokenAtPosition(sf: ts.SourceFile, pos: number): ts.Node })
  .getTokenAtPosition;

function cleanText(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const parts = lines.map((s, i) => {
    s = s.replace(/\t/g, ' ');
    if (i > 0) s = s.replace(/^ +/, '');
    if (i < lines.length - 1) s = s.replace(/ +$/, '');
    return s;
  });
  return decodeHTMLStrict(parts.filter(Boolean).join(' '));
}

export async function lowerReact(graph: Graph): Promise<{ ir: Program }> {
  const { root } = graph;
  const files = new Map<string, string>();
  for (const [id, m] of graph.modules)
    if (/\.(tsx?|jsx?|mjs)$/.test(id) && id.startsWith(root + path.sep)) files.set(id, m.code);
  const program = createProgram(files, [REACT]);
  const checker = program.getTypeChecker();
  const rel = (f: string) => path.relative(root, f);
  const sourceOf = (n: ts.Node) => {
    const sf = n.getSourceFile();
    const p = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { file: rel(sf.fileName), line: p.line + 1, column: p.character + 1 };
  };
  const fail = (n: ts.Node, code: string, message: string): never => {
    throw new Diagnostic(code, message, sourceOf(n));
  };
  for (const f of files.keys()) {
    const sf = program.getSourceFile(f)!;
    const d = program.getSyntacticDiagnostics(sf)[0];
    if (d)
      throw new Diagnostic(
        'E_PARSE',
        ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        d.start !== undefined ? sourceOf(tokenAt(sf, d.start)) : undefined,
      );
  }
  const types = new TypeMapper(checker, fail);
  const cells: Cell[] = [];
  const setters = new Map<ts.Symbol, number>();
  const COMPONENT = 0;
  const symbolOf = (n: ts.Node) => {
    const s = checker.getSymbolAtLocation(n);
    return s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  };
  const setterCall = (e: ts.Expression): { cell: number; arg: ts.Expression } | undefined => {
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    const s = symbolOf(e.expression);
    const cell = s && setters.get(s);
    if (cell === undefined) return undefined;
    if (e.arguments.length !== 1) fail(e, 'E_STATE', 'State setters take one argument');
    return { cell, arg: e.arguments[0] };
  };
  const hooks: Hooks = {
    // Render, handler and closure reads all observe the render snapshot.
    readCell: cell => ({ op: 'cell', cell, read: 'snapshot' }),
    cellType: cell => cells[cell].type,
    statement(e, ctx, lower) {
      const s = setterCall(e);
      if (!s) return undefined;
      const fnArg = skipParens(s.arg);
      // Untyped event payloads (e.target.value) are not functions.
      const t = types.typeOrUndefined(s.arg);
      let value: Expr;
      if (t !== undefined && typeof t === 'object' && 'fn' in t) {
        // Updater: applied to the pending value.
        const f =
          ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg)
            ? lower.closure(fnArg, ctx, 'updater')
            : lower.expr(s.arg, ctx);
        value = {
          op: 'call-value',
          callee: f,
          args: [{ op: 'cell', cell: s.cell, read: 'current' }],
        };
      } else value = lower.coerce(s.arg, ctx, cells[s.cell].type);
      return [{ op: 'set', cell: s.cell, value, source: sourceOf(e) }] as Stmt[];
    },
    call(node) {
      if (setterCall(node))
        return fail(node, 'E_STATE', 'State setters are statements; their result is undefined');
      return undefined;
    },
  };
  const lower = new Lowerer(program, checker, types, hooks, fail, sourceOf);

  // --- Modules: functions and constants (shared by every component) ---
  const componentDecls = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
  const returnsJsx = (f: ts.FunctionLikeDeclaration): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isReturnStatement(n) && n.expression && isJsx(skipParens(n.expression))) found = true;
      if (n !== f && ts.isFunctionLike(n)) return;
      ts.forEachChild(n, visit);
    };
    if (f.body && !ts.isBlock(f.body)) return isJsx(skipParens(f.body as ts.Expression));
    if (f.body) visit(f.body);
    return found;
  };
  const isUseState = (callee: ts.Expression): boolean => {
    if (!ts.isIdentifier(callee)) return false;
    const decl = symbolOf(callee)?.declarations?.[0];
    return (
      decl?.getSourceFile().fileName === REACT &&
      (decl as ts.FunctionDeclaration).name?.text === 'useState'
    );
  };
  const isJsx = (n: ts.Node): n is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment =>
    ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);
  let bootstrap: ts.ExpressionStatement | undefined;
  const componentDecl = (n: ts.Statement): boolean => {
    if (ts.isFunctionDeclaration(n) && n.name && returnsJsx(n)) {
      componentDecls.set(checker.getSymbolAtLocation(n.name)!, n);
      return true;
    }
    if (ts.isVariableStatement(n)) {
      const decls = n.declarationList.declarations;
      const fns = decls.map(d => d.initializer && skipParens(d.initializer));
      if (
        fns.length &&
        fns.every(i => i && (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) && returnsJsx(i))
      ) {
        decls.forEach((d, i) =>
          componentDecls.set(checker.getSymbolAtLocation(d.name)!, fns[i] as ts.ArrowFunction),
        );
        return true;
      }
    }
    return false;
  };
  // Ordinary local modules (and component modules) initialise dependencies first.
  const pending = lowerModules(graph, program, lower, cells, COMPONENT, {
    statement(stmt, file) {
      if (componentDecl(stmt)) return true;
      if (ts.isExpressionStatement(stmt) && file === graph.entry && !bootstrap) {
        bootstrap = stmt;
        return true;
      }
      return false;
    },
    frameworkImport(spec, stmt) {
      if (spec === 'react') {
        const named = stmt.importClause?.namedBindings;
        if (named && ts.isNamedImports(named))
          for (const el of named.elements)
            if ((el.propertyName ?? el.name).text !== 'useState')
              fail(
                el,
                'E_CAPABILITY',
                `react:${(el.propertyName ?? el.name).text} is planned for M3/M4`,
              );
        return true;
      }
      return spec === 'react-dom/client';
    },
  });
  // createRoot(document.getElementById('root')).render(<App />)
  const call = bootstrap && skipParens(bootstrap.expression);
  const rendered =
    call &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'render'
      ? call.arguments[0]
      : undefined;
  if (!rendered || !ts.isJsxSelfClosingElement(rendered) || !ts.isIdentifier(rendered.tagName))
    throw new Diagnostic(
      'E_BOOTSTRAP',
      'Entry must contain exactly one createRoot(document.getElementById("root")).render(<App />)',
      bootstrap && sourceOf(bootstrap),
    );
  const appDecl = componentDecls.get(symbolOf(rendered.tagName)!);
  if (!appDecl)
    fail(rendered, 'E_BOOTSTRAP', 'The rendered component must be a local function component');

  // --- The root component body ---
  const body = appDecl!.body;
  if (!body) fail(appDecl!, 'E_COMPONENT', 'The root component needs a body');
  // An expression body is the returned JSX.
  let returned: ts.Expression | undefined = ts.isBlock(body!) ? undefined : (body as ts.Expression);
  for (const stmt of ts.isBlock(body!) ? body.statements : []) {
    if (ts.isReturnStatement(stmt)) {
      returned = stmt.expression;
      break;
    }
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
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const))
      fail(
        stmt,
        'E_COMPONENT',
        'Component bodies support const declarations, useState and nested functions',
      );
    for (const d of (stmt as ts.VariableStatement).declarationList.declarations) {
      const init = d.initializer && skipParens(d.initializer);
      if (init && ts.isCallExpression(init) && isUseState(init.expression)) {
        if (!ts.isArrayBindingPattern(d.name) || d.name.elements.length !== 2)
          fail(d, 'E_STATE', 'Use const [value, setValue] = useState(initial)');
        const [v, s] = (d.name as ts.ArrayBindingPattern)
          .elements as unknown as ts.BindingElement[];
        if (!ts.isIdentifier(v.name) || !ts.isIdentifier(s.name))
          fail(d, 'E_STATE', 'useState names must be identifiers');
        const cell = cells.length;
        const type = types.of(v.name);
        const arg = init.arguments[0];
        if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)))
          fail(arg, 'E_STATE', 'Lazy useState initialisers are planned for M3');
        cells.push({
          name: (v.name as ts.Identifier).text,
          type,
          init: { op: 'lit', value: 0 },
          tracking: 'identity',
          source: sourceOf(d),
        });
        lower.bindings.set(checker.getSymbolAtLocation(v.name)!, { kind: 'cell', cell });
        setters.set(checker.getSymbolAtLocation(s.name)!, cell);
        pending.push(() => {
          if (!arg) {
            cells[cell].init = { op: 'undefined', type };
            return;
          }
          const v = lower.value(arg, COMPONENT, `${cells[cell].name}$init`);
          const from = lower.exprType(arg);
          const widen =
            typeof type === 'object' &&
            'maybe' in type &&
            !(typeof from === 'object' && 'maybe' in from);
          cells[cell].init = widen ? { op: 'some', value: v } : v;
        });
        continue;
      }
      if (!ts.isIdentifier(d.name))
        fail(d, 'E_COMPONENT', 'Destructuring in component bodies is planned for M3');
      const name = (d.name as ts.Identifier).text;
      const sym = checker.getSymbolAtLocation(d.name)!;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        const p = lower.declare(sym, init, name, COMPONENT);
        if (p) pending.push(p);
      } else {
        const index = lower.reserve();
        // A render-time value: recomputed from the render snapshot.
        lower.bindings.set(sym, { kind: 'derived', fn: index });
        pending.push(() => {
          const v = lower.value(d.initializer!, COMPONENT, `${name}$render`);
          lower.functions[index] = {
            name,
            component: COMPONENT,
            params: [],
            locals: [],
            result: lower.types.typeOrUndefined(d.initializer!) ?? lower.valueType(v),
            body: [{ op: 'return', value: v }],
          };
        });
      }
    }
  }
  if (!returned) fail(appDecl!, 'E_COMPONENT', 'The component must return JSX');
  for (const p of pending) p();

  // --- JSX ---
  const handlers: Handler[] = [];
  /** The type of lowered `v`: TypeScript's, or the IR type where TypeScript only knows any. */
  const typeOf = (e: ts.Expression, v: Expr): Type =>
    types.typeOrUndefined(e) === undefined ? lower.valueType(v) : lower.exprType(e);
  const display = (e: ts.Expression): Expr | undefined => {
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === 'map'
    )
      fail(e, 'E_JSX', 'Rendering lists is planned for M3');
    // React renders strings and numbers; booleans, null and undefined render nothing.
    const v = lower.value(e, COMPONENT, 'text');
    const t = typeOf(e, v);
    if (t === 'boolean') return undefined;
    if (t === 'string') return v;
    if (t === 'number') return { op: 'to-string', arg: v };
    if (typeof t === 'object' && 'maybe' in t && (t.maybe === 'string' || t.maybe === 'number')) {
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
    return fail(e, 'E_JSX', `Rendering ${JSON.stringify(t)} values is unsupported (lists are M3)`);
  };
  const handlerFor = (expr: ts.Expression, event: 'click' | 'input', where: ts.Node): number => {
    const e = skipParens(expr);
    let h: Omit<Handler, 'event'>;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
      h = lower.handler(e, COMPONENT, event === 'input');
    else {
      const callee = lower.value(e, COMPONENT, 'handler');
      const t = types.of(e);
      if (typeof t === 'object' && 'fn' in t && t.fn.params.length)
        fail(where, 'E_EVENT', 'Handlers taking the event object must be inline arrow functions');
      const b = ts.isIdentifier(e) ? lower.binding(e) : undefined;
      h = {
        body: [
          {
            op: 'expr',
            value:
              b?.kind === 'function'
                ? { op: 'call', function: b.fn, args: [] }
                : { op: 'call-value', callee, args: [] },
          },
        ],
      };
    }
    handlers.push({ event, ...h, source: sourceOf(where) });
    return handlers.length - 1;
  };
  const children = (list: readonly ts.JsxChild[]): Node[] => {
    const out: Node[] = [];
    let parts: Expr[] = [];
    const flush = () => {
      if (parts.length) out.push({ kind: 'text', parts });
      parts = [];
    };
    for (const child of list) {
      if (ts.isJsxText(child)) {
        const text = cleanText(child.text);
        if (text) parts.push({ op: 'lit', value: text });
      } else if (ts.isJsxExpression(child)) {
        if (!child.expression) continue;
        const e = skipParens(child.expression);
        if (isJsx(e)) {
          flush();
          out.push(...jsx(e));
        } else if (
          ts.isBinaryExpression(e) &&
          e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          isJsx(skipParens(e.right))
        ) {
          flush();
          out.push({
            kind: 'if',
            test: test(e.left),
            then: jsx(skipParens(e.right) as ts.JsxElement),
            source: sourceOf(e),
          });
        } else if (
          ts.isConditionalExpression(e) &&
          (isJsx(skipParens(e.whenTrue)) || isJsx(skipParens(e.whenFalse)))
        ) {
          flush();
          const branch = (x: ts.Expression): Node[] => {
            const y = skipParens(x);
            if (isJsx(y)) return jsx(y);
            if (
              y.kind === ts.SyntaxKind.NullKeyword ||
              (ts.isIdentifier(y) && y.text === 'undefined')
            )
              return [];
            const d = display(y);
            return d ? [{ kind: 'text', parts: [d] }] : [];
          };
          out.push({
            kind: 'if',
            test: test(e.condition),
            then: branch(e.whenTrue),
            else: branch(e.whenFalse),
            source: sourceOf(e),
          });
        } else {
          const d = display(e);
          if (d) parts.push(d);
        }
      } else if (isJsx(child)) {
        flush();
        out.push(...jsx(child as ts.JsxElement));
      } else fail(child, 'E_JSX', 'Unsupported JSX child');
    }
    flush();
    return out;
  };
  const test = (e: ts.Expression): Expr => {
    const v = lower.value(e, COMPONENT, 'condition');
    return typeOf(e, v) === 'boolean' ? v : { op: 'to-boolean', arg: v };
  };
  const inlined = new Set<ts.Node>();
  const jsx = (n: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment): Node[] => {
    if (ts.isJsxFragment(n)) return children(n.children);
    const opening = ts.isJsxElement(n) ? n.openingElement : n;
    const tag = opening.tagName;
    const kids = ts.isJsxElement(n) ? n.children : [];
    if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) return component(opening, kids, n);
    const name = tag.getText();
    if (!TAGS.has(name)) fail(tag, 'E_JSX', `<${name}> is outside the supported elements`);
    const attrs: { name: string; value: Expr }[] = [];
    const props: { name: string; value: Expr }[] = [];
    const listeners: { event: 'click' | 'input'; handler: number }[] = [];
    for (const a of opening.attributes.properties) {
      if (!ts.isJsxAttribute(a)) fail(a, 'E_JSX', 'Spread attributes are planned for M3');
      const attr = a as ts.JsxAttribute;
      const raw = attr.name.getText();
      const init = attr.initializer;
      if (raw === 'key') continue;
      if (raw === 'onClick' || (raw === 'onChange' && name === 'input')) {
        if (!init || !ts.isJsxExpression(init) || !init.expression)
          fail(attr, 'E_EVENT', 'Event props need a handler expression');
        const event = raw === 'onClick' ? 'click' : 'input';
        listeners.push({
          event,
          handler: handlerFor((init as ts.JsxExpression).expression!, event, attr),
        });
        continue;
      }
      if (/^on[A-Z]/.test(raw)) fail(attr, 'E_EVENT', `${raw} is planned for M5`);
      if (raw === 'style') fail(attr, 'E_JSX', 'Style objects are planned for M3');
      const attrName = ATTRS[raw] ?? raw;
      if (attrName !== attrName.toLowerCase() && !attrName.startsWith('aria-'))
        fail(attr, 'E_JSX', `Unsupported prop ${raw}`);
      if (!init) {
        attrs.push({ name: attrName, value: { op: 'lit', value: true } });
        continue;
      }
      if (ts.isStringLiteral(init)) {
        attrs.push({ name: attrName, value: { op: 'lit', value: decodeHTMLStrict(init.text) } });
        continue;
      }
      const e = (init as ts.JsxExpression).expression!;
      const v = lower.value(e, COMPONENT, attrName);
      const t = typeOf(e, v);
      if (attrName === 'value' && name === 'input')
        props.push({ name: 'value', value: t === 'string' ? v : { op: 'to-string', arg: v } });
      else if (BOOLEAN_ATTRS.has(attrName))
        attrs.push({ name: attrName, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } });
      else if (t === 'boolean') fail(attr, 'E_JSX', `Boolean value for ${attrName}`);
      else attrs.push({ name: attrName, value: t === 'string' ? v : { op: 'to-string', arg: v } });
    }
    return [
      {
        kind: 'element',
        tag: name,
        ...(attrs.length ? { attrs } : {}),
        ...(props.length ? { props } : {}),
        ...(listeners.length ? { listeners } : {}),
        ...(kids.length ? { children: children(kids) } : {}),
        source: sourceOf(n),
      },
    ];
  };
  /** Inline a stateless child component with its props bound to the caller's values. */
  const component = (
    opening: ts.JsxOpeningLikeElement,
    kids: readonly ts.JsxChild[],
    at: ts.Node,
  ): Node[] => {
    const decl = componentDecls.get(symbolOf(opening.tagName)!);
    if (!decl)
      return fail(
        opening.tagName,
        'E_COMPONENT',
        `${opening.tagName.getText()} is not a local function component`,
      );
    if (inlined.has(decl)) fail(at, 'E_COMPONENT', 'Recursive components are unsupported');
    if (kids.some(k => !ts.isJsxText(k) || cleanText(k.text)))
      fail(at, 'E_COMPONENT', 'Component children are planned for M3');
    const values = new Map<string, Expr>();
    for (const a of opening.attributes.properties) {
      if (!ts.isJsxAttribute(a)) fail(a, 'E_JSX', 'Spread props are planned for M3');
      const attr = a as ts.JsxAttribute;
      const init = attr.initializer;
      const v: Expr = !init
        ? { op: 'lit', value: true }
        : ts.isStringLiteral(init)
          ? { op: 'lit', value: decodeHTMLStrict(init.text) }
          : lower.value((init as ts.JsxExpression).expression!, COMPONENT, attr.name.getText());
      values.set(attr.name.getText(), v);
    }
    const [param] = decl.parameters;
    if (param) {
      if (ts.isIdentifier(param.name))
        lower.bindings.set(checker.getSymbolAtLocation(param.name)!, { kind: 'props', values });
      else if (ts.isObjectBindingPattern(param.name))
        for (const el of param.name.elements) {
          const key = ((el.propertyName ?? el.name) as ts.Identifier).text;
          if (!ts.isIdentifier(el.name))
            fail(el, 'E_COMPONENT', 'Nested prop destructuring is planned for M3');
          const v =
            values.get(key) ??
            (el.initializer ? lower.value(el.initializer, COMPONENT, key) : undefined);
          if (!v) fail(el, 'E_PROPS', `Prop ${key} is not passed`);
          const sym = checker.getSymbolAtLocation(el.name)!;
          lower.bindings.set(sym, { kind: 'value', expr: v! });
          // Untyped (JavaScript) props take the IR type of the passed value.
          if (!types.typeOrUndefined(el.name)) types.override(sym, lower.valueType(v!));
        }
    }
    const b = decl.body;
    let result: ts.Expression | undefined;
    if (b && ts.isBlock(b)) {
      for (const stmt of b.statements) {
        if (ts.isReturnStatement(stmt)) {
          result = stmt.expression;
          break;
        }
        if (!ts.isVariableStatement(stmt))
          fail(
            stmt,
            'E_COMPONENT',
            'Child components support const declarations (state in children is M3)',
          );
        for (const d of (stmt as ts.VariableStatement).declarationList.declarations) {
          const init = d.initializer && skipParens(d.initializer);
          if (init && ts.isCallExpression(init) && isUseState(init.expression))
            fail(d, 'E_COMPONENT', 'State in child components is planned for M3');
          if (!ts.isIdentifier(d.name) || !d.initializer)
            fail(d, 'E_COMPONENT', 'Unsupported declaration in a child component');
          const sym = checker.getSymbolAtLocation(d.name)!;
          const v = lower.value(d.initializer!, COMPONENT, (d.name as ts.Identifier).text);
          lower.bindings.set(sym, { kind: 'value', expr: v });
          if (!types.typeOrUndefined(d.name)) types.override(sym, lower.valueType(v));
        }
      }
    } else if (b) result = b as ts.Expression;
    const r = result && skipParens(result);
    if (!r || !isJsx(r)) return fail(decl, 'E_COMPONENT', 'Components must return JSX');
    inlined.add(decl);
    try {
      return jsx(r as ts.JsxElement);
    } finally {
      inlined.delete(decl);
    }
  };
  const template = jsx(skipParens(returned!) as ts.JsxElement);
  const comp: Component = {
    name: (appDecl as ts.FunctionDeclaration).name?.text ?? 'App',
    cells,
    handlers,
    template,
  };
  const capabilities = ['dom', 'css', 'window', 'click', 'keyboard'];
  if (handlers.some(h => h.event === 'input')) capabilities.push('text-input');
  const ir: Program = {
    schema: 4,
    meta: {
      title: graph.config.title,
      sourceHash: graph.hash,
      frontend: {
        adapter: 'react',
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
    components: [comp],
    root: 0,
  };
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  return { ir };
}

export type { Type };
