// React 19 adapter on the shared language layer (docs/design/M2-VALUES.md,
// docs/design/M3-COMPONENTS.md). Framework semantics only:
// - every function component is an IR component: each rendered <Child/> is an
//   instance with its own cells, created and destroyed with its template
//   region (conditional branches, list items), so state resets on remount;
// - props are prop cells (destructured or `props.name`); their types come from
//   TypeScript, or from the first call site for untyped JavaScript props;
// - useState → identity-tracked cells; setters write, updater functions see
//   the pending value; every other read sees the render snapshot;
// - component-body `const` values are derived functions over that snapshot,
//   nested functions are component functions;
// - `items.map(item => <Row key={…}/>)` → keyed (or, without a key, indexed)
//   lists; a `key` elsewhere remounts its element when it changes;
// - JSX → IR nodes with React's whitespace and child rendering rules.
import ts from 'typescript';
import path from 'node:path';
import { decodeHTMLStrict } from 'entities';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type { Cell, Component, Expr, Handler, Listener, Node, Program, Stmt, Type } from '../ir.ts';
import { FnBuilder, Lowerer, skipParens, type Hooks } from '../language.ts';
import { createProgram, REACT } from '../program.ts';
import { sameType, TypeMapper } from '../types.ts';
import { lowerModules } from '../modules.ts';
import { arrayElement, maybeInner } from '../irtype.ts';

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

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

/** The token at `pos` (an internal TypeScript API, stable across 5.x). */
const tokenAt = (ts as unknown as { getTokenAtPosition(sf: ts.SourceFile, pos: number): ts.Node })
  .getTokenAtPosition;

/** React's JSX text rule: trim lines, drop whitespace-only lines, join with spaces. */
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

/** The lowering state of the component being lowered (children nest). */
interface Scope {
  index: number;
  cells: Cell[];
  handlers: Handler[];
  /** Template scope: its locals are list items, indices and temporaries. */
  tb: FnBuilder;
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
  /** The component being lowered. */
  let cur: Scope = undefined as unknown as Scope;
  const setters = new Map<ts.Symbol, number>();
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
    cellType: cell => cur.cells[cell].type,
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
      } else value = lower.coerce(s.arg, ctx, cur.cells[s.cell].type);
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
  const componentDecls = new Map<ts.Symbol, { decl: ts.FunctionLikeDeclaration; name: string }>();
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
  const isJsx = (n: ts.Node): n is Jsx =>
    ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);
  let bootstrap: ts.ExpressionStatement | undefined;
  const componentDecl = (n: ts.Statement): boolean => {
    if (ts.isFunctionDeclaration(n) && n.name && returnsJsx(n)) {
      componentDecls.set(checker.getSymbolAtLocation(n.name)!, { decl: n, name: n.name.text });
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
          componentDecls.set(checker.getSymbolAtLocation(d.name)!, {
            decl: fns[i] as ts.ArrowFunction,
            name: d.name.getText(),
          }),
        );
        return true;
      }
    }
    return false;
  };
  // Ordinary local modules (and component modules) initialise dependencies first.
  const modulePending = lowerModules(graph, program, lower, {
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
                `react:${(el.propertyName ?? el.name).text} is planned for M4`,
              );
        return true;
      }
      return spec === 'react-dom/client';
    },
  });
  for (const p of modulePending) p();
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
  const app = componentDecls.get(symbolOf(rendered.tagName)!);
  if (!app)
    fail(rendered, 'E_BOOTSTRAP', 'The rendered component must be a local function component');
  if (rendered.attributes.properties.length)
    fail(rendered.attributes, 'E_BOOTSTRAP', 'The root component is rendered without props');

  // --- Components: lowered on first use, children while their parent's template is lowered ---
  const components: Component[] = [];
  const indexOf = new Map<ts.FunctionLikeDeclaration, number>();
  const active: ts.FunctionLikeDeclaration[] = [];
  /** The component index of `decl`, lowering it first if needed (`site`: first call site's prop types). */
  const instantiate = (
    entry: { decl: ts.FunctionLikeDeclaration; name: string },
    site: Map<string, Type>,
    at: ts.Node,
  ): number => {
    if (active.includes(entry.decl))
      return fail(at, 'E_COMPONENT', 'Recursive components are planned for a later milestone');
    const known = indexOf.get(entry.decl);
    if (known !== undefined) return known;
    const index = components.length;
    components.push(undefined as unknown as Component);
    indexOf.set(entry.decl, index);
    const saved = cur;
    active.push(entry.decl);
    try {
      components[index] = lowerComponent(entry.decl, entry.name, index, site);
    } finally {
      active.pop();
      cur = saved;
    }
    return index;
  };

  function lowerComponent(
    decl: ts.FunctionLikeDeclaration,
    name: string,
    COMPONENT: number,
    site: Map<string, Type>,
  ): Component {
    cur = { index: COMPONENT, cells: [], handlers: [], tb: lower.template(COMPONENT) };
    const { cells } = cur;
    const pending: (() => void)[] = [];

    // --- Props: `{ a, b = 1 }: Props` or `props: Props` → prop cells ---
    if (decl.parameters.length > 1)
      fail(decl.parameters[1], 'E_PROPS', 'Function components take a single props parameter');
    const param = decl.parameters[0];
    const propCell = (key: string, type: Type, at: ts.Node): number => {
      if (key === 'children')
        fail(at, 'E_PROPS', 'children props are planned for a later M3 step (slots)');
      if (key === 'key' || key === 'ref')
        fail(at, 'E_PROPS', `${key} is not passed to components as a prop`);
      cells.push({
        name: key,
        type,
        init: required(type),
        tracking: isReference(type) ? 'deep' : 'identity',
        prop: key,
        source: sourceOf(at),
      });
      return cells.length - 1;
    };
    if (param && ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (el.dotDotDotToken) fail(el, 'E_PROPS', 'Rest props are planned for a later milestone');
        if (!ts.isIdentifier(el.name))
          fail(el, 'E_PROPS', 'Nested prop destructuring is planned for a later milestone');
        const local = el.name as ts.Identifier;
        const key = el.propertyName ? propertyName(el.propertyName) : local.text;
        const sym = checker.getSymbolAtLocation(local)!;
        let type = types.typeOrUndefined(local);
        if (type === undefined) {
          // Untyped JavaScript: the IR type of the value at the first call site.
          type = site.get(key);
          if (type === undefined)
            return fail(
              el,
              'E_PROPS',
              `Prop ${key} needs a type: annotate the props or pass it where ${name} is first used`,
            );
          types.override(sym, type);
        }
        const cell = propCell(key, type, el);
        cells[cell].name = local.text;
        lower.bindings.set(sym, { kind: 'cell', cell });
        const fallback = el.initializer;
        if (fallback) {
          if (isReference(type))
            fail(
              fallback,
              'E_PROPS',
              'React re-creates object and array prop defaults on every render; such defaults are unsupported (pass the prop)',
            );
          const t = type;
          pending.push(() => {
            cells[cell].init = coerceInit(
              lower.value(fallback, COMPONENT, `${key}$default`),
              lower.exprType(fallback),
              t,
            );
          });
        }
      }
    } else if (param && ts.isIdentifier(param.name)) {
      const values = new Map<string, Expr>();
      const t = checker.getTypeAtLocation(param.name);
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
        for (const [key, type] of site)
          values.set(key, { op: 'cell', cell: propCell(key, type, param), read: 'snapshot' });
      } else
        for (const p of checker.getPropertiesOfType(t)) {
          let pt = checker.getTypeOfSymbolAtLocation(p, param);
          if (p.flags & ts.SymbolFlags.Optional)
            pt = checker.getNullableType(pt, ts.TypeFlags.Undefined);
          const at = p.valueDeclaration ?? param;
          const cell = propCell(p.name, types.map(pt, at), at);
          values.set(p.name, { op: 'cell', cell, read: 'snapshot' });
        }
      lower.bindings.set(checker.getSymbolAtLocation(param.name)!, { kind: 'props', values });
    } else if (param) fail(param, 'E_PROPS', 'Unsupported props parameter');

    // --- Body: useState, derived constants, nested functions ---
    const body = decl.body;
    if (!body) fail(decl, 'E_COMPONENT', 'Components need a body');
    // An expression body is the returned JSX.
    let returned: ts.Expression | undefined = ts.isBlock(body!)
      ? undefined
      : (body as ts.Expression);
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
            fail(arg, 'E_STATE', 'Lazy useState initialisers are planned for a later milestone');
          cells.push({
            name: (v.name as ts.Identifier).text,
            type,
            init: { op: 'lit', value: 0 },
            tracking: 'identity',
            source: sourceOf(d),
          });
          lower.bindings.set(checker.getSymbolAtLocation(v.name)!, { kind: 'cell', cell });
          const setter = checker.getSymbolAtLocation(s.name)!;
          setters.set(setter, cell);
          // A setter passed as a value (e.g. a callback prop): a function writing the cell.
          if (usedAsValue(setter, body!)) {
            const fn = lower.reserve();
            lower.functions[fn] = {
              name: (s.name as ts.Identifier).text,
              component: COMPONENT,
              params: [{ name: 'value', type }],
              locals: [],
              result: 'void',
              body: [{ op: 'set', cell, value: { op: 'local', local: 0 } }],
              source: sourceOf(s),
            };
            lower.bindings.set(setter, { kind: 'function', fn });
          }
          pending.push(() => {
            if (!arg) {
              cells[cell].init = { op: 'undefined', type };
              return;
            }
            const v = lower.value(arg, COMPONENT, `${cells[cell].name}$init`);
            cells[cell].init = coerceInit(v, lower.exprType(arg), type);
          });
          continue;
        }
        if (!ts.isIdentifier(d.name))
          fail(
            d,
            'E_COMPONENT',
            'Destructuring in component bodies is planned for a later milestone',
          );
        const local = (d.name as ts.Identifier).text;
        const sym = checker.getSymbolAtLocation(d.name)!;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const p = lower.declare(sym, init, local, COMPONENT);
          if (p) pending.push(p);
        } else {
          const index = lower.reserve();
          // A render-time value: recomputed from the render snapshot.
          lower.bindings.set(sym, { kind: 'derived', fn: index });
          pending.push(() => {
            const v = lower.value(d.initializer!, COMPONENT, `${local}$render`);
            lower.functions[index] = {
              name: local,
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
    const r = returned && skipParens(returned);
    if (!r || !isJsx(r)) fail(decl, 'E_COMPONENT', 'Components must return JSX');
    for (const p of pending) p();
    const template = jsx(r as Jsx);
    return {
      name,
      cells,
      handlers: cur.handlers,
      template,
      ...(cur.tb.locals.length ? { templateLocals: cur.tb.locals } : {}),
    };
  }

  /** Whether `sym` is referenced in `body` other than as a callee. */
  const usedAsValue = (sym: ts.Symbol, body: ts.Node): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (
        ts.isIdentifier(n) &&
        !ts.isBindingElement(n.parent) &&
        !(ts.isCallExpression(n.parent) && n.parent.expression === n) &&
        symbolOf(n) === sym
      )
        found = true;
      ts.forEachChild(n, visit);
    };
    visit(body);
    return found;
  };

  // --- JSX ---
  const expr = (e: ts.Expression): Expr => lower.expr(e, cur.tb);
  /** The type of lowered `v`: TypeScript's, or the IR type where TypeScript only knows any. */
  const typeOf = (e: ts.Expression, v: Expr): Type =>
    types.typeOrUndefined(e) === undefined ? lower.irType(v, cur.tb) : lower.exprType(e);
  /** Text for a rendered value; undefined when React renders nothing. */
  const display = (e: ts.Expression): Expr | undefined => {
    // React renders strings and numbers; booleans, null and undefined render nothing.
    const v = expr(e);
    const t = typeOf(e, v);
    if (t === 'boolean') return undefined;
    if (t === 'string') return v;
    if (t === 'number') return { op: 'to-string', arg: v };
    if (typeof t === 'object' && 'maybe' in t) {
      if (t.maybe === 'string' || t.maybe === 'number') return maybeText(v, t);
      if (t.maybe === 'boolean') return undefined;
    }
    if (typeof t === 'object' && 'array' in t)
      return fail(e, 'E_JSX', 'Render arrays as lists: items.map(item => <li key={…}>…</li>)');
    return fail(e, 'E_JSX', `Rendering ${JSON.stringify(t)} values is unsupported`);
  };
  /** `String(v ?? '')` for a nullable value, as React renders text. */
  const maybeText = (v: Expr, t: Type): Expr => {
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
  };
  /** Whether `e` reads a list item or index (a template local). */
  const readsTemplateLocals = (e: ts.Node): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(n)) {
        const b = lower.binding(n);
        if (b?.kind === 'local' && b.owner === cur.tb) found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(e);
    return found;
  };
  const handlerFor = (
    expression: ts.Expression,
    event: 'click' | 'input',
    where: ts.Node,
  ): Listener => {
    const e = skipParens(expression);
    let h: Omit<Handler, 'event'> & { args?: Expr[] };
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
      h = lower.handler(e, cur.index, event === 'input', cur.tb);
    else {
      if (readsTemplateLocals(e))
        fail(where, 'E_EVENT', 'Handlers that depend on list items must be inline arrow functions');
      const callee = lower.value(e, cur.index, 'handler');
      const t = types.typeOrUndefined(e) ?? lower.valueType(callee);
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
    const { args, ...rest } = h;
    cur.handlers.push({ event, ...rest, source: sourceOf(where) });
    return { event, handler: cur.handlers.length - 1, ...(args?.length ? { args } : {}) };
  };
  const isNothing = (e: ts.Expression) =>
    e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
  const isMap = (e: ts.Expression): e is ts.CallExpression =>
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'map';
  /** Whether a child expression renders elements (rather than text). */
  const structural = (x: ts.Expression): boolean => {
    const e = skipParens(x);
    if (isJsx(e) || isMap(e)) return true;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return structural(e.right);
    if (ts.isConditionalExpression(e)) return structural(e.whenTrue) || structural(e.whenFalse);
    return false;
  };
  /** The nodes of one JSX child expression. */
  const slot = (x: ts.Expression): Node[] => {
    const e = skipParens(x);
    if (isJsx(e)) return jsx(e);
    if (isMap(e)) return [list(e)];
    if (isNothing(e)) return [];
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      structural(e.right)
    ) {
      // `n && <X/>` renders a falsy number (0, NaN) as text.
      const v = expr(e.left);
      const t = typeOf(e.left, v);
      const text: Expr | undefined =
        t === 'number'
          ? { op: 'to-string', arg: v }
          : maybeInner(t) === 'number'
            ? maybeText(v, t)
            : undefined;
      return [
        {
          kind: 'if',
          test: lower.truthy(v, t),
          then: slot(e.right),
          ...(text ? { else: [{ kind: 'text', parts: [text] }] } : {}),
          source: sourceOf(e),
        },
      ];
    }
    if (ts.isConditionalExpression(e) && structural(e)) {
      sameBranchType(e);
      const v = expr(e.condition);
      return [
        {
          kind: 'if',
          test: lower.truthy(v, typeOf(e.condition, v)),
          then: slot(e.whenTrue),
          else: slot(e.whenFalse),
          source: sourceOf(e),
        },
      ];
    }
    const d = display(e);
    return d ? [{ kind: 'text', parts: [d] }] : [];
  };
  /** Keys consumed by a list or a branch (no remount wrapper). */
  const consumedKeys = new Set<ts.JsxAttribute>();
  const keyOf = (n: ts.Expression): ts.JsxAttribute | undefined => {
    const opening = ts.isJsxElement(n)
      ? n.openingElement
      : ts.isJsxSelfClosingElement(n)
        ? n
        : undefined;
    return opening?.attributes.properties.find(
      (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'key',
    );
  };
  /**
   * React reconciles the two branches of a conditional at the same position:
   * the same element type or component keeps its DOM node or instance. IR
   * branches remount, so that case is rejected unless distinct literal keys
   * make React remount too.
   */
  const sameBranchType = (e: ts.ConditionalExpression) => {
    /** The element types a branch can render at this position. */
    const kinds = (x: ts.Expression): string[] => {
      const y = skipParens(x);
      if (ts.isJsxFragment(y)) return ['<>'];
      if (isMap(y)) return ['[]'];
      if (ts.isJsxElement(y) || ts.isJsxSelfClosingElement(y)) {
        const tag = (ts.isJsxElement(y) ? y.openingElement : y).tagName;
        const s = ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text) ? symbolOf(tag) : undefined;
        return [s ? `component:${componentDecls.get(s)?.name ?? tag.getText()}` : tag.getText()];
      }
      if (ts.isConditionalExpression(y)) return [...kinds(y.whenTrue), ...kinds(y.whenFalse)];
      if (
        ts.isBinaryExpression(y) &&
        y.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return kinds(y.right);
      return [];
    };
    const a = kinds(e.whenTrue);
    const b = kinds(e.whenFalse);
    if (!a.some(k => b.includes(k))) return;
    const ka = keyOf(skipParens(e.whenTrue));
    const kb = keyOf(skipParens(e.whenFalse));
    const literal = (k: ts.JsxAttribute | undefined) =>
      k?.initializer && ts.isStringLiteral(k.initializer) ? k.initializer.text : undefined;
    if (
      a.length === 1 &&
      b.length === 1 &&
      literal(ka) !== undefined &&
      literal(kb) !== undefined &&
      literal(ka) !== literal(kb)
    ) {
      consumedKeys.add(ka!);
      consumedKeys.add(kb!);
      return;
    }
    fail(
      e,
      'E_JSX',
      'Both branches can render the same element type or component, which React updates in place instead of remounting; render it once with conditional props, or give the branches distinct keys',
    );
  };
  const children = (kids: readonly ts.JsxChild[]): Node[] => {
    const out: Node[] = [];
    let parts: Expr[] = [];
    const flush = () => {
      if (parts.length) out.push({ kind: 'text', parts });
      parts = [];
    };
    for (const child of kids) {
      if (ts.isJsxText(child)) {
        const text = cleanText(child.text);
        if (text) parts.push({ op: 'lit', value: text });
      } else if (ts.isJsxExpression(child)) {
        if (!child.expression) continue;
        if (structural(child.expression)) {
          flush();
          out.push(...slot(child.expression));
        } else {
          const d = display(skipParens(child.expression));
          if (d) parts.push(d);
        }
      } else if (isJsx(child)) {
        flush();
        out.push(...jsx(child));
      } else fail(child, 'E_JSX', 'Unsupported JSX child');
    }
    flush();
    return out;
  };
  /** `items.map((item, i) => <Row key={item.id} …/>)` → an each node. */
  const list = (call: ts.CallExpression): Node => {
    const receiver = (call.expression as ts.PropertyAccessExpression).expression;
    const [cb, thisArg] = call.arguments;
    if (!cb || thisArg || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)))
      return fail(
        call,
        'E_JSX',
        'Lists need an inline callback returning JSX: items.map(item => <li key={…}>…</li>)',
      );
    const items = expr(receiver);
    const element = arrayElement(lower.irType(items, cur.tb));
    if (!element) return fail(receiver, 'E_JSX', 'Lists render arrays (.map on an array)');
    const [itemParam, indexParam, arrayParam] = cb.parameters;
    if (arrayParam)
      fail(arrayParam, 'E_JSX', 'The array parameter of list callbacks is unsupported');
    const bind = (p: ts.ParameterDeclaration, type: Type): number => {
      if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken)
        fail(
          p,
          'E_JSX',
          'Destructured or defaulted list parameters are planned for a later M3 step',
        );
      const local = cur.tb.local((p.name as ts.Identifier).text, type);
      lower.bindings.set(checker.getSymbolAtLocation(p.name)!, {
        kind: 'local',
        owner: cur.tb,
        local,
      });
      return local;
    };
    const item = itemParam ? bind(itemParam, element) : cur.tb.local('$item', element);
    const index = indexParam ? bind(indexParam, 'number') : undefined;
    let result: ts.Expression | undefined;
    if (ts.isBlock(cb.body)) {
      const [only] = cb.body.statements;
      if (cb.body.statements.length === 1 && ts.isReturnStatement(only)) result = only.expression;
    } else result = cb.body;
    const r = result && skipParens(result);
    if (!r || !structural(r))
      return fail(cb, 'E_JSX', 'List callbacks must return JSX directly (no statements)');
    const keyAttr = keyOf(r);
    let key: Expr | undefined;
    if (keyAttr) {
      consumedKeys.add(keyAttr);
      key = keyValue(keyAttr).value;
    } else {
      // A key inside `c ? <A key/> : …` or `c && <A key/>` keys the item in React.
      const branchKeyed = (x: ts.Expression): boolean => {
        const y = skipParens(x);
        if (ts.isConditionalExpression(y))
          return branchKeyed(y.whenTrue) || branchKeyed(y.whenFalse);
        if (
          ts.isBinaryExpression(y) &&
          y.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        )
          return branchKeyed(y.right);
        return !!keyOf(y);
      };
      if (branchKeyed(r))
        fail(
          r,
          'E_JSX',
          'Keys on conditional list items are unsupported; key the returned element',
        );
    }
    return {
      kind: 'each',
      // React's reconcileChildrenArray (which blocks move is observable through focus).
      reorder: 'forward',
      items,
      item,
      ...(index !== undefined ? { index } : {}),
      ...(key ? { key } : {}),
      body: slot(r),
      source: sourceOf(call),
    };
  };
  /** A key's value: React keys are strings; numbers and strings map one-to-one. */
  const keyValue = (attr: ts.JsxAttribute): { value: Expr; type: Type } => {
    const init = attr.initializer;
    if (!init) return fail(attr, 'E_JSX', 'key needs a value');
    if (ts.isStringLiteral(init)) return { value: { op: 'lit', value: init.text }, type: 'string' };
    const e = (init as ts.JsxExpression).expression;
    if (!e) return fail(attr, 'E_JSX', 'key needs a value');
    const value = expr(e);
    const type = lower.irType(value, cur.tb);
    if (type !== 'string' && type !== 'number')
      fail(
        attr,
        'E_JSX',
        `Keys must be strings or numbers (React stringifies other values), not ${JSON.stringify(type)}`,
      );
    return { value, type };
  };
  /** A key outside a list root: the element remounts when the key changes. */
  const keyed = (attr: ts.JsxAttribute | undefined, nodes: Node[], at: ts.Node): Node[] => {
    if (!attr || consumedKeys.has(attr)) return nodes;
    const { value, type } = keyValue(attr);
    const local = cur.tb.local('$key', type);
    return [
      {
        kind: 'each',
        // React's reconcileChildrenArray (which blocks move is observable through focus).
        reorder: 'forward',
        items: { op: 'array', type: { array: type }, items: [value] },
        item: local,
        key: { op: 'local', local },
        body: nodes,
        source: sourceOf(at),
      },
    ];
  };
  const jsx = (n: Jsx): Node[] => {
    if (ts.isJsxFragment(n)) return children(n.children);
    const opening = ts.isJsxElement(n) ? n.openingElement : n;
    const tag = opening.tagName;
    const kids = ts.isJsxElement(n) ? n.children : [];
    const keyAttr = keyOf(n);
    if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text))
      return keyed(keyAttr, component(opening, kids, n), n);
    const name = tag.getText();
    if (!TAGS.has(name)) fail(tag, 'E_JSX', `<${name}> is outside the supported elements`);
    const attrs: { name: string; value: Expr }[] = [];
    const props: { name: string; value: Expr }[] = [];
    const listeners: Listener[] = [];
    for (const a of opening.attributes.properties) {
      if (!ts.isJsxAttribute(a))
        fail(a, 'E_JSX', 'Spread attributes are planned for a later milestone');
      const attr = a as ts.JsxAttribute;
      const raw = attr.name.getText();
      const init = attr.initializer;
      if (raw === 'key') continue;
      if (raw === 'onClick' || (raw === 'onChange' && name === 'input')) {
        if (!init || !ts.isJsxExpression(init) || !init.expression)
          fail(attr, 'E_EVENT', 'Event props need a handler expression');
        const event = raw === 'onClick' ? 'click' : 'input';
        listeners.push(handlerFor((init as ts.JsxExpression).expression!, event, attr));
        continue;
      }
      if (/^on[A-Z]/.test(raw)) fail(attr, 'E_EVENT', `${raw} is planned for M5`);
      if (raw === 'style') fail(attr, 'E_JSX', 'Style objects are planned for a later milestone');
      if (raw === 'ref') fail(attr, 'E_JSX', 'Element refs are planned for a later M3 step');
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
      const v = expr(e);
      const t = typeOf(e, v);
      if (attrName === 'value' && name === 'input')
        props.push({ name: 'value', value: t === 'string' ? v : { op: 'to-string', arg: v } });
      else if (BOOLEAN_ATTRS.has(attrName))
        attrs.push({ name: attrName, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } });
      else if (t === 'boolean') fail(attr, 'E_JSX', `Boolean value for ${attrName}`);
      else attrs.push({ name: attrName, value: t === 'string' ? v : { op: 'to-string', arg: v } });
    }
    return keyed(
      keyAttr,
      [
        {
          kind: 'element',
          tag: name,
          ...(attrs.length ? { attrs } : {}),
          ...(props.length ? { props } : {}),
          ...(listeners.length ? { listeners } : {}),
          ...(kids.length ? { children: children(kids) } : {}),
          source: sourceOf(n),
        },
      ],
      n,
    );
  };
  /** A child component instance; its props are evaluated in the parent's template scope. */
  const component = (
    opening: ts.JsxOpeningLikeElement,
    kids: readonly ts.JsxChild[],
    at: ts.Node,
  ): Node[] => {
    const entry = componentDecls.get(symbolOf(opening.tagName)!);
    if (!entry)
      return fail(
        opening.tagName,
        'E_COMPONENT',
        `${opening.tagName.getText()} is not a local function component`,
      );
    if (kids.some(k => !ts.isJsxText(k) || cleanText(k.text)))
      fail(at, 'E_COMPONENT', 'Component children are planned for a later M3 step');
    const passed: { name: string; value: Expr; type: Type; at: ts.Node }[] = [];
    for (const a of opening.attributes.properties) {
      if (!ts.isJsxAttribute(a)) fail(a, 'E_JSX', 'Spread props are planned for a later milestone');
      const attr = a as ts.JsxAttribute;
      const name = attr.name.getText();
      if (name === 'key') continue;
      const init = attr.initializer;
      const value: Expr = !init
        ? { op: 'lit', value: true }
        : ts.isStringLiteral(init)
          ? { op: 'lit', value: decodeHTMLStrict(init.text) }
          : expr((init as ts.JsxExpression).expression!);
      passed.push({ name, value, type: lower.irType(value, cur.tb), at: attr });
    }
    const index = instantiate(entry, new Map(passed.map(p => [p.name, p.type])), at);
    const target = components[index];
    const props = passed.map(p => {
      const cell = target.cells.find(c => c.prop === p.name);
      if (!cell) return fail(p.at, 'E_PROPS', `${entry.name} has no prop ${p.name}`);
      if (sameType(p.type, cell.type)) return { name: p.name, value: p.value };
      if (maybeInner(cell.type) && sameType(maybeInner(cell.type)!, p.type))
        return { name: p.name, value: { op: 'some', value: p.value } as Expr };
      if (maybeInner(p.type) && sameType(maybeInner(p.type)!, cell.type) && !isRequired(cell.init))
        return fail(
          p.at,
          'E_PROPS',
          `${p.name} may be undefined, where React uses the prop's default; pass a defined value`,
        );
      return fail(
        p.at,
        'E_PROPS',
        `Prop ${p.name} of ${entry.name} has type ${JSON.stringify(cell.type)}, not ${JSON.stringify(p.type)}`,
      );
    });
    for (const c of target.cells)
      if (c.prop && !passed.some(p => p.name === c.prop) && isRequired(c.init))
        fail(at, 'E_PROPS', `${entry.name} requires the prop ${c.prop}`);
    return [
      {
        kind: 'component',
        component: index,
        ...(props.length ? { props } : {}),
        source: sourceOf(at),
      },
    ];
  };

  const rootIndex = instantiate(app!, new Map(), rendered);
  for (const c of components[rootIndex].cells)
    if (c.prop && isRequired(c.init))
      fail(rendered, 'E_BOOTSTRAP', `The root component requires the prop ${c.prop}`);
  const capabilities = ['dom', 'css', 'window', 'click', 'keyboard'];
  if (components.some(c => c.handlers.some(h => h.event === 'input')))
    capabilities.push('text-input');
  const ir: Program = {
    schema: 4,
    meta: {
      title: graph.config.title,
      sourceHash: graph.hash,
      frontend: {
        adapter: 'react',
        version: 3,
        packages: graph.tooling.packages,
        tools: { typescript: ts.version },
      },
      provenance: graph.manifest,
      mappings: [],
    },
    ...(graph.config.renderer ? { renderer: graph.config.renderer } : {}),
    capabilities,
    // React DOM restores the focused element after each commit.
    restoreFocus: true,
    styles: { css: graph.css, assets: graph.assets },
    records: types.records,
    functions: lower.functions,
    globals: lower.globals,
    components,
    root: rootIndex,
  };
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  return { ir };
}

const propertyName = (n: ts.PropertyName): string =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText();

/** Widen an initial value to the cell type (T → Maybe<T>). */
function coerceInit(v: Expr, from: Type, to: Type): Expr {
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

export type { Type };
