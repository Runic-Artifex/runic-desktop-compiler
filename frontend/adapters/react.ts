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
// - `children` and other ReactNode props rendered as `{children}`, and render
//   props `(x: T) => ReactNode` called as `{row(x)}`, are slots: the parent's
//   JSX (or inline render function) is slot content evaluated in the parent;
// - `useEffect`/`useLayoutEffect` → post/layout effects whose functions read
//   their render's snapshot, with React's commit schedule (batched cleanups,
//   passive writes in a later task, the first commit in a task);
// - controlled checkboxes (`checked` + `onChange` → `change`);
// - event props taking the synthetic event (EVENT_PROPS), checked against
//   React DOM's root-listener dispatch (checkEvents); component functions
//   used as listener values are one object per render (checkListenerIdentity);
// - rest props (`{ a, ...rest }`) → an attribute bag of the props each call
//   site passes beyond the declared ones, coerced as React DOM sets
//   attributes (restEntry) and spread onto elements with `{...rest}`;
// - `ref` as a prop (React 19), attached to an element or passed on: the
//   parent's ref object receives the element through a bound prop;
// - inline style objects with static keys → a managed style of properties
//   only, as setValueForStyles applies them (styleObject);
// - onFocus/onBlur → focusin/focusout listeners (they bubble in React);
//   focus() and blur() with focus listeners only in discrete handlers
//   (checkFocusCalls);
// - controlled text areas (value, and defaultValue: React DOM keeps the
//   text content equal to the value) and labels (`htmlFor`);
// - JSX → IR nodes with React's whitespace and child rendering rules.
import ts from 'typescript';
import path from 'node:path';
import { decodeHTMLStrict } from 'entities';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type {
  AttrItem,
  Cell,
  Component,
  Effect,
  Expr,
  Handler,
  Listener,
  Local,
  Node,
  Program,
  Stmt,
  Type,
  RecordType,
} from '../ir.ts';
import { FnBuilder, Lowerer, skipParens, type HandlerEvent, type Hooks } from '../language.ts';
import { createProgram, REACT } from '../program.ts';
import { sameType, TypeMapper } from '../types.ts';
import { lowerModules } from '../modules.ts';
import { packMappings, type Edge } from '../packs.ts';
import { arrayElement, maybeInner, upcastTo } from '../irtype.ts';
import { checkRadioGroups, checkSelectChildren } from '../controls.ts';

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
  'textarea',
  'label',
  'select',
  'option',
]);
/** Inline SVG elements (runic-ir's SVG_TAGS). */
const SVG_TAGS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
]);
for (const t of SVG_TAGS) TAGS.add(t);
/**
 * SVG props → attribute names, as react-dom 19.3 sets them (setProp in
 * ReactDOMComponent): `className` becomes `class` and `viewBox`, `width` and
 * `height` keep their names (setValueForKnownAttribute); other props go
 * through getAttributeAlias (shared/getAttributeAlias.js, the `aliases` map)
 * and setValueForAttribute. Only the aliases of attributes the IR accepts on
 * SVG elements are listed; other camelCase props are rejected.
 */
const SVG_PROPS: Record<string, string> = {
  className: 'class',
  viewBox: 'viewBox',
  fillOpacity: 'fill-opacity',
  fillRule: 'fill-rule',
  strokeDasharray: 'stroke-dasharray',
  strokeDashoffset: 'stroke-dashoffset',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeMiterlimit: 'stroke-miterlimit',
  strokeOpacity: 'stroke-opacity',
  strokeWidth: 'stroke-width',
};
/** The attribute an SVG prop sets (undefined: unsupported). */
function svgAttribute(prop: string): string | undefined {
  if (Object.hasOwn(SVG_PROPS, prop)) return SVG_PROPS[prop];
  // Props with rules of their own in setProp (children, data, focusable, …).
  if (SPECIAL_PROPS.has(prop) || PRESENCE_PROPS.has(prop)) return undefined;
  // aria-* and data-* (setValueForAttribute keeps the name as written) and
  // lowercase names, which getAttributeAlias does not map.
  if (/^(aria|data)-[a-z0-9-]+$/.test(prop) || /^[a-z][a-z0-9-]*$/.test(prop)) return prop;
  return undefined;
}
/** React prop names → DOM attribute names. */
const ATTRS: Record<string, string> = {
  className: 'class',
  maxLength: 'maxlength',
  readOnly: 'readonly',
  tabIndex: 'tabindex',
  htmlFor: 'for',
};
/**
 * React event props → IR event kinds (onChange: see `jsx`). React DOM runs
 * them from one root listener per native event; enter and leave props come
 * from the out/over events (see checkEvents).
 */
const EVENT_PROPS: Record<string, HandlerEvent> = {
  onClick: 'click',
  onDoubleClick: 'dblclick',
  onContextMenu: 'contextmenu',
  onMouseDown: 'mousedown',
  onMouseUp: 'mouseup',
  onMouseMove: 'mousemove',
  onMouseEnter: 'mouseenter',
  onMouseLeave: 'mouseleave',
  onPointerDown: 'pointerdown',
  onPointerUp: 'pointerup',
  onPointerMove: 'pointermove',
  onPointerEnter: 'pointerenter',
  onPointerLeave: 'pointerleave',
  onKeyDown: 'keydown',
  onKeyUp: 'keyup',
  // React DOM listens for focusin and focusout: onFocus and onBlur bubble.
  onFocus: 'focusin',
  onBlur: 'focusout',
  // A listener on the element itself; the event goes to the target only
  // (React 17 stopped bubbling it).
  onScroll: 'scroll',
};
/**
 * Continuous events: React gives their updates a lower priority and renders
 * them in a scheduler task after the input (with a later discrete update).
 * Scroll events come in the rendering step: their updates render after
 * that frame (checked in Chromium 153: an animation frame callback of the
 * same rendering step, a microtask and even a 0 ms timer and message posted
 * by the listener see the old DOM; a click dispatched before the scheduler
 * task renders the scroll update with its own). The IR models that for
 * scroll events (`schedule.continuous`, M6); the others are accepted where
 * the timing is unobservable.
 */
const CONTINUOUS = new Set<HandlerEvent>([
  'scroll',
  'mousemove',
  'mouseenter',
  'mouseleave',
  'pointermove',
  'pointerenter',
  'pointerleave',
]);
/**
 * Inline style properties that change only how an element is painted, not
 * its layout, hit testing or focusability. State that continuous events
 * update may be rendered in them as in text: what renders it later is not
 * observable before the frame is painted (and less so than text, which
 * changes layout).
 */
const PAINT_ONLY_STYLES = new Set([
  'color',
  'background-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'caret-color',
]);
const ENTER_LEAVE = new Set<HandlerEvent>([
  'mouseenter',
  'mouseleave',
  'pointerenter',
  'pointerleave',
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
/**
 * Rest props (attribute bags) follow React DOM's attribute rules (setProp in
 * react-dom 19.3). Props set as presence attributes when truthy:
 */
const PRESENCE_PROPS = new Set([
  'allowFullScreen',
  'async',
  'autoPlay',
  'controls',
  'credentialless',
  'default',
  'defer',
  'disabled',
  'disablePictureInPicture',
  'disableRemotePlayback',
  'formNoValidate',
  'hidden',
  'inert',
  'loop',
  'noModule',
  'noValidate',
  'open',
  'playsInline',
  'readOnly',
  'required',
  'reversed',
  'scoped',
  'seamless',
  'itemScope',
]);
/** Props React sets under another attribute name (setProp and its alias table). */
const RENAMED_PROPS: Record<string, string> = {
  className: 'class',
  tabIndex: 'tabindex',
  htmlFor: 'for',
  acceptCharset: 'accept-charset',
  httpEquiv: 'http-equiv',
  crossOrigin: 'crossorigin',
};
/** camelCase props React sets with setAttribute under their own name (HTML lowercases it). */
const CAMEL_ATTRS = new Set([
  'maxLength',
  'minLength',
  'autoComplete',
  'autoCapitalize',
  'inputMode',
  'enterKeyHint',
  'accessKey',
]);
/**
 * Props with rules of their own (URLs, numeric checks, DOM properties,
 * input values, styles, inner content), which rest props do not carry.
 */
const SPECIAL_PROPS = new Set([
  'style',
  'children',
  'dangerouslySetInnerHTML',
  'innerHTML',
  'innerText',
  'textContent',
  'value',
  'defaultValue',
  'checked',
  'defaultChecked',
  'selected',
  'type',
  'name',
  'autoFocus',
  'multiple',
  'muted',
  'capture',
  'download',
  'cols',
  'rows',
  'size',
  'span',
  'rowSpan',
  'start',
  'src',
  'href',
  'data',
  'action',
  'formAction',
  'contentEditable',
  'spellCheck',
  'draggable',
  'autoReverse',
  'externalResourcesRequired',
  'focusable',
  'preserveAlpha',
  'popover',
  'popoverTarget',
  'is',
  'suppressContentEditableWarning',
  'suppressHydrationWarning',
]);
/** The attribute a rest prop sets (undefined: unsupported in rest props). */
function restAttribute(key: string): string | undefined {
  if (SPECIAL_PROPS.has(key) || /^on/i.test(key)) return undefined;
  if (Object.hasOwn(RENAMED_PROPS, key)) return RENAMED_PROPS[key];
  if (/^(data|aria)-[a-z0-9-]+$/i.test(key)) return key.toLowerCase();
  if (PRESENCE_PROPS.has(key) || CAMEL_ATTRS.has(key)) return key.toLowerCase();
  return /^[a-z][a-z0-9-]*$/.test(key) ? key : undefined;
}
/** The type of element refs and ref props: the element while mounted, null after. */
const REF_TYPE: Type = { maybe: 'element' };
/** Style keys whose numbers React DOM sets without a unit (react-dom 19.3 unitlessNumbers). */
const UNITLESS = new Set(
  'animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth'.split(
    ' ',
  ),
);
/** CSSStyleDeclaration members that are not properties (React assigns `style[key]`). */
const DECLARATION_MEMBERS = new Set([
  'cssText',
  'cssFloat',
  'length',
  'parentRule',
  'item',
  'getPropertyValue',
  'getPropertyPriority',
  'setProperty',
  'removeProperty',
]);
/** A React style key's CSS property (`backgroundColor` → `background-color`). */
const kebab = (key: string): string => key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

interface Graph {
  root: string;
  entry: string;
  hash: string;
  css: string;
  styleGuards?: { selector: string; message: string }[];
  assets: { path: string; sha256: string; bytes: number; mime: string }[];
  manifest: unknown;
  config: { title: string; renderer?: 'cpu' | 'gpu' };
  modules: Map<string, { code: string; imports: Edge[] }>;
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

/**
 * A slot of a component: a ReactNode prop rendered by reference (`{children}`)
 * or a render prop called in JSX (`{row(item)}`).
 */
interface SlotInfo {
  name: string;
  call: boolean;
  /** Argument types; undefined for an untyped render prop until its first call. */
  params?: Type[];
  /** Rendered by a call without `?.`: React throws when the prop is absent. */
  required: boolean;
  at: ts.Node;
}

/** What a parent passes for a prop of an untyped child: a value or slot content. */
type SiteProp = Type | { slot: 'node' | 'call' };
const isSlotSite = (s: SiteProp | undefined): s is { slot: 'node' | 'call' } =>
  typeof s === 'object' && 'slot' in s;

/** The lowering state of the component being lowered (children nest). */
interface Scope {
  index: number;
  cells: Cell[];
  handlers: Handler[];
  /** Template scope: its locals are list items, indices and temporaries. */
  tb: FnBuilder;
  slots: SlotInfo[];
  /** Destructured slot props → slot name. */
  slotOf: Map<ts.Symbol, string>;
  /** The props object parameter (for `props.children`). */
  props?: ts.Symbol;
  /** Cells of `useRef` objects (read live, never re-render). */
  refs: Set<number>;
  /** Ref objects attached with `ref={r}` to an element of this component's JSX. */
  attached: Map<ts.Symbol, ts.JsxAttribute>;
  /** Cells of the attached refs (React owns their value). */
  elementRefs: Set<number>;
  /** Nesting depth of JSX that may render more than once (list items, slot content). */
  repeated: number;
  /** The rest props cell (an attribute bag) and the props it may hold. */
  rest?: { cell: number; keys: Set<string> };
}

/** A component's destructured props, rest binding and the props its rest bag may hold. */
interface PropsDecl {
  declared: Set<string>;
  rest?: ts.Symbol;
  /** Destructured `ref` (React 19 passes it as a prop). */
  ref?: ts.Symbol;
  keys: Set<string>;
}

/**
 * The key marking ref accesses in the IR under construction, removed before
 * the program is returned: an index into the accessing source nodes.
 */
const REF_ACCESS = '$reactRefAccess';
/** The key marking IR nodes rendered inside a Fragment fiber (removed like REF_ACCESS). */
const FRAGMENT = '$reactFragment';

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
  /** Source nodes of ref accesses (`r.current`), indexed by the REF_ACCESS marks. */
  const refAccesses: { node: ts.Node; element: boolean }[] = [];
  const markRefAccess = <T extends Expr | Stmt>(x: T, node: ts.Node, cell: number): T => {
    refAccesses.push({ node, element: cur.elementRefs.has(cell) });
    return { ...x, [REF_ACCESS]: refAccesses.length - 1 };
  };
  const hooks: Hooks = {
    // State reads (render, handlers, closures) observe the render snapshot.
    // `ref.current` is not a snapshot: React mutates the ref object at commit
    // (and on writes), so every read sees its latest value.
    readCell: (cell, _ctx, node) =>
      cur.refs.has(cell)
        ? markRefAccess({ op: 'cell', cell, read: 'current' }, node, cell)
        : { op: 'cell', cell, read: 'snapshot' },
    cellType: cell => cur.cells[cell].type,
    writeCell(cell, value, _ctx, node) {
      if (!cur.refs.has(cell))
        return fail(node, 'E_ASSIGN', 'This framework does not support direct state assignment');
      if (cur.elementRefs.has(cell))
        return fail(
          node,
          'E_REF',
          `React sets ${cur.cells[cell].name}.current to the element of ref={${cur.cells[cell].name}}; assigning it is unsupported`,
        );
      // A mutable box: the write is immediate and never re-renders.
      return [markRefAccess({ op: 'set', cell, value, source: sourceOf(node) }, node, cell)];
    },
    statement(e, ctx, lower) {
      const s = setterCall(e);
      if (!s) return undefined;
      const fnArg = skipParens(s.arg);
      const cellType = cur.cells[s.cell].type;
      // `setX(null)`: the literal's contextual type is `S | ((previous: S) => S)`.
      if (fnArg.kind === ts.SyntaxKind.NullKeyword || isNothing(fnArg)) {
        if (!maybeInner(cellType)) fail(s.arg, 'E_STATE', 'This state is not nullable');
        const op = fnArg.kind === ts.SyntaxKind.NullKeyword ? 'null' : 'undefined';
        return [{ op: 'set', cell: s.cell, value: { op, type: cellType }, source: sourceOf(e) }];
      }
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
      // Hooks at the top of a component body are lowered there; any other
      // call (in a condition, a nested function or a custom hook) is not.
      const hook = reactFunction(node.expression);
      if (hook)
        return fail(
          node,
          'E_HOOK',
          `${hook} must be called at the top level of a component body (hooks in conditions, nested functions and custom hooks are unsupported)`,
        );
      return undefined;
    },
  };
  const lower = new Lowerer(program, checker, types, hooks, fail, sourceOf);
  // Component functions are created on every render: one object per render.
  lower.hoistFunctionValues = true;

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
  /** Whether `callee` is React's hook `name` (also when imported under another name). */
  const isHook = (callee: ts.Expression, name: string): boolean => reactFunction(callee) === name;
  /** The React function `callee` names (also when imported under another name). */
  const reactFunction = (callee: ts.Expression): string | undefined => {
    if (!ts.isIdentifier(callee)) return undefined;
    const decl = symbolOf(callee)?.declarations?.[0];
    return decl?.getSourceFile().fileName === REACT && ts.isFunctionDeclaration(decl)
      ? decl.name?.text
      : undefined;
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
            if (
              !el.isTypeOnly &&
              ![
                'useState',
                'useRef',
                'useEffect',
                'useLayoutEffect',
                'RefObject',
                'ReactNode',
                'ReactElement',
              ].includes((el.propertyName ?? el.name).text)
            )
              fail(
                el,
                'E_CAPABILITY',
                `react:${(el.propertyName ?? el.name).text} is unsupported (useState, useRef, useEffect and useLayoutEffect are)`,
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

  // --- Rest props (docs/design/M5-PLATFORM.md): each component's declared
  // props and rest binding, and the props its rest bag may hold, gathered
  // from every call site and through forwarding (`<Child {...rest} />`) ---
  const propsDecls = new Map<ts.FunctionLikeDeclaration, PropsDecl>();
  for (const { decl } of componentDecls.values()) {
    const d: PropsDecl = { declared: new Set(), keys: new Set() };
    const p = decl.parameters[0];
    if (p && ts.isObjectBindingPattern(p.name))
      for (const el of p.name.elements) {
        if (el.dotDotDotToken) {
          if (ts.isIdentifier(el.name)) d.rest = checker.getSymbolAtLocation(el.name);
          continue;
        }
        const key = el.propertyName
          ? propertyName(el.propertyName)
          : ts.isIdentifier(el.name)
            ? el.name.text
            : '';
        d.declared.add(key);
        if (key === 'ref' && ts.isIdentifier(el.name)) d.ref = checker.getSymbolAtLocation(el.name);
      }
    propsDecls.set(decl, d);
  }
  /** The component a JSX tag names, if it is a local function component. */
  const componentOf = (tag: ts.JsxTagNameExpression) =>
    ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)
      ? componentDecls.get(symbolOf(tag)!)
      : undefined;
  const forwards: { from: PropsDecl; to: PropsDecl; name: string; at: ts.Node }[] = [];
  for (const { decl } of componentDecls.values()) {
    const own = propsDecls.get(decl)!;
    const visit = (n: ts.Node) => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const target = componentOf(n.tagName);
        const to = target && propsDecls.get(target.decl);
        for (const a of n.attributes.properties) {
          if (ts.isJsxSpreadAttribute(a)) {
            const e = skipParens(a.expression);
            if (!own.rest || !ts.isIdentifier(e) || symbolOf(e) !== own.rest)
              fail(
                a,
                'E_JSX',
                'Spread attributes are supported for rest props ({...rest}); other spreads are planned for later',
              );
            if (target) {
              if (!to!.rest)
                fail(
                  a,
                  'E_PROPS',
                  `${target.name} takes no rest props (destructure them: { a, ...rest })`,
                );
              forwards.push({ from: own, to: to!, name: target.name, at: a });
            }
          } else if (to?.rest) {
            const key = a.name.getText();
            if (key !== 'key' && !to.declared.has(key)) to.keys.add(key);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    if (decl.body) visit(decl.body);
    // Rest props are forwarded, not read; a ref prop is attached or passed on.
    const uses = (n: ts.Node) => {
      if (ts.isIdentifier(n) && !ts.isBindingElement(n.parent)) {
        const s = ts.isShorthandPropertyAssignment(n.parent)
          ? checker.getShorthandAssignmentValueSymbol(n.parent)
          : symbolOf(n);
        if (s && s === own.rest && !ts.isJsxSpreadAttribute(n.parent))
          fail(
            n,
            'E_PROPS',
            'Rest props can only be spread ({...rest}); reading them by name is planned for later',
          );
        if (
          s &&
          s === own.ref &&
          !(
            ts.isJsxExpression(n.parent) &&
            ts.isJsxAttribute(n.parent.parent) &&
            n.parent.parent.name.getText() === 'ref'
          )
        )
          fail(
            n,
            'E_REF',
            "A ref prop can only be attached to an element or passed on (ref={ref}): it is the parent's ref object, or undefined when the parent passes none",
          );
      }
      ts.forEachChild(n, uses);
    };
    if (decl.body && (own.rest || own.ref)) uses(decl.body);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const { from, to } of forwards)
      for (const k of from.keys)
        if (!to.keys.has(k)) {
          to.keys.add(k);
          changed = true;
        }
  }
  for (const { from, to, name, at } of forwards)
    for (const k of from.keys)
      if (to.declared.has(k))
        fail(
          at,
          'E_PROPS',
          `The rest props may hold ${k}, which ${name} declares; pass ${k} explicitly`,
        );

  // --- Components: lowered on first use, children while their parent's template is lowered ---
  const components: Component[] = [];
  /** Slots of each lowered component. */
  const slotsOf: SlotInfo[][] = [];
  const indexOf = new Map<ts.FunctionLikeDeclaration, number>();
  const active: ts.FunctionLikeDeclaration[] = [];
  /** The component index of `decl`, lowering it first if needed (`site`: first call site's prop types). */
  const instantiate = (
    entry: { decl: ts.FunctionLikeDeclaration; name: string },
    site: Map<string, SiteProp>,
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
    site: Map<string, SiteProp>,
  ): Component {
    cur = {
      index: COMPONENT,
      cells: [],
      handlers: [],
      tb: lower.template(COMPONENT),
      slots: [],
      slotOf: new Map(),
      refs: new Set(),
      attached: attachedRefs(decl),
      elementRefs: new Set(),
      repeated: 0,
    };
    const { cells, slots } = cur;
    const pending: (() => void)[] = [];
    const effects: Effect[] = [];

    // --- Props: `{ a, b = 1 }: Props` or `props: Props` → prop cells and slots ---
    if (decl.parameters.length > 1)
      fail(decl.parameters[1], 'E_PROPS', 'Function components take a single props parameter');
    const param = decl.parameters[0];
    /**
     * Declare prop `key` as a slot if its type (`t`, or for untyped props what
     * the first call site passes) is a ReactNode or a render function.
     */
    const slotProp = (key: string, t: ts.Type | undefined, at: ts.Node): boolean => {
      let kind: { call: boolean; params?: Type[] } | undefined;
      if (t && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) kind = slotKind(t, at);
      else {
        const s = site.get(key);
        if (isSlotSite(s)) kind = { call: s.slot === 'call' };
        else if (key === 'children' && s === undefined) kind = { call: false };
      }
      if (!kind) {
        if (key === 'children')
          fail(
            at,
            'E_PROPS',
            'Type children as ReactNode (or a function returning ReactNode); children used as values are unsupported',
          );
        return false;
      }
      slots.push({
        name: key,
        call: kind.call,
        ...(kind.params || !kind.call ? { params: kind.params ?? [] } : {}),
        required: false,
        at,
      });
      return true;
    };
    const propCell = (key: string, type: Type, at: ts.Node): number => {
      if (key === 'key') fail(at, 'E_PROPS', 'key is not passed to components as a prop');
      if (key === 'ref')
        fail(
          at,
          'E_REF',
          'Read the ref prop by destructuring it ({ ref }) and attach it to an element (ref={ref})',
        );
      cells.push({
        name: key,
        type,
        init: required(type),
        // Props are read-only (Rules of React): identity tracking is exact.
        tracking: 'identity',
        readonly: true,
        prop: key,
        source: sourceOf(at),
      });
      return cells.length - 1;
    };
    if (param && ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (el.dotDotDotToken) {
          // Rest props: an attribute bag of the props a call site passes beyond these.
          if (!ts.isIdentifier(el.name)) fail(el, 'E_PROPS', 'Rest props need a name');
          cells.push({
            name: (el.name as ts.Identifier).text,
            type: 'attrs',
            init: { op: 'attrs', items: [] },
            tracking: 'identity',
            readonly: true,
            prop: '...',
            source: sourceOf(el),
          });
          cur.rest = { cell: cells.length - 1, keys: propsDecls.get(decl)!.keys };
          continue;
        }
        if (!ts.isIdentifier(el.name))
          fail(el, 'E_PROPS', 'Nested prop destructuring is planned for a later milestone');
        const local = el.name as ts.Identifier;
        const key = el.propertyName ? propertyName(el.propertyName) : local.text;
        const sym = checker.getSymbolAtLocation(local)!;
        if (key === 'ref') {
          // React 19 passes `ref` as a prop. Its uses are `ref={ref}` only
          // (checked with the rest props): the cell holds the element it is
          // attached to, and the call site binds it to the parent's ref.
          if (el.initializer) fail(el.initializer, 'E_REF', 'A ref prop cannot have a default');
          cells.push({
            name: local.text,
            type: REF_TYPE,
            init: { op: 'null', type: REF_TYPE },
            tracking: 'none',
            prop: 'ref',
            source: sourceOf(el),
          });
          cur.refs.add(cells.length - 1);
          cur.elementRefs.add(cells.length - 1);
          lower.bindings.set(sym, { kind: 'ref', cell: cells.length - 1, field: 'current' });
          continue;
        }
        if (slotProp(key, checker.getTypeAtLocation(local), el)) {
          if (el.initializer)
            fail(
              el.initializer,
              'E_PROPS',
              'Defaults for children and render props are planned for a later milestone',
            );
          cur.slotOf.set(sym, key);
          continue;
        }
        let type = types.typeOrUndefined(local);
        if (type === undefined) {
          // Untyped JavaScript: the IR type of the value at the first call site.
          const s = site.get(key);
          type = isSlotSite(s) ? undefined : s;
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
              lower.types.records,
            );
          });
        }
      }
    } else if (param && ts.isIdentifier(param.name)) {
      cur.props = checker.getSymbolAtLocation(param.name)!;
      const values = new Map<string, Expr>();
      const t = checker.getTypeAtLocation(param.name);
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
        for (const [key, type] of site)
          if (!slotProp(key, undefined, param))
            values.set(key, {
              op: 'cell',
              cell: propCell(key, type as Type, param),
              read: 'snapshot',
            });
        if (!site.has('children') && readsProp(decl, cur.props, 'children'))
          slotProp('children', undefined, param);
      } else
        for (const p of checker.getPropertiesOfType(t)) {
          let pt = checker.getTypeOfSymbolAtLocation(p, param);
          if (p.flags & ts.SymbolFlags.Optional)
            pt = checker.getNullableType(pt, ts.TypeFlags.Undefined);
          const at = p.valueDeclaration ?? param;
          if (slotProp(p.name, pt, at)) continue;
          const cell = propCell(p.name, types.map(pt, at), at);
          values.set(p.name, { op: 'cell', cell, read: 'snapshot' });
        }
      lower.bindings.set(checker.getSymbolAtLocation(param.name)!, { kind: 'props', values });
    } else if (param) fail(param, 'E_PROPS', 'Unsupported props parameter');

    // --- Body: useState, derived constants, nested functions ---
    const body = decl.body;
    if (!body) fail(decl, 'E_COMPONENT', 'Components need a body');
    if (slots.length) checkSlotUses(body!);
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
      if (ts.isExpressionStatement(stmt)) {
        const call = skipParens(stmt.expression);
        const hook = ts.isCallExpression(call) ? reactFunction(call.expression) : undefined;
        if (hook === 'useEffect' || hook === 'useLayoutEffect') {
          effects.push(lowerEffect(call as ts.CallExpression, hook, COMPONENT, pending));
          continue;
        }
      }
      if (ts.isClassDeclaration(stmt))
        fail(
          stmt,
          'E_CLASS',
          'Declare classes at module level: a class in a component body is a new class at every render',
        );
      if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const))
        fail(
          stmt,
          'E_COMPONENT',
          'Component bodies support const declarations, useState, useRef, useEffect, useLayoutEffect and nested functions',
        );
      for (const d of (stmt as ts.VariableStatement).declarationList.declarations) {
        // Intl and pack constants have no runtime value (their uses are lowered).
        if (lower.isIntlConstant(d) || lower.isPackConstant(d)) continue;
        const init = d.initializer && skipParens(d.initializer);
        if (init && ts.isCallExpression(init) && isHook(init.expression, 'useRef')) {
          lowerUseRef(d, init, COMPONENT, pending);
          continue;
        }
        if (init && ts.isCallExpression(init) && isHook(init.expression, 'useState')) {
          // `const [value, setValue]`, or `const [value]` for state nothing sets.
          const elements = ts.isArrayBindingPattern(d.name) ? d.name.elements : undefined;
          if (!elements || (elements.length !== 1 && elements.length !== 2))
            fail(d, 'E_STATE', 'Use const [value, setValue] = useState(initial)');
          const [v, s] = elements as unknown as (ts.BindingElement | undefined)[];
          if (
            !v ||
            !ts.isBindingElement(v) ||
            !ts.isIdentifier(v.name) ||
            v.initializer ||
            (s && (!ts.isBindingElement(s) || !ts.isIdentifier(s.name) || s.initializer))
          )
            return fail(d, 'E_STATE', 'useState names must be identifiers');
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
            readonly: true,
            source: sourceOf(d),
          });
          lower.bindings.set(checker.getSymbolAtLocation(v.name)!, { kind: 'cell', cell });
          const setter = s && checker.getSymbolAtLocation(s.name)!;
          if (setter) setters.set(setter, cell);
          // A setter passed as a value (e.g. a callback prop): a function writing the cell.
          if (s && setter && usedAsValue(setter, body!)) {
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
            // `useState<T | null>(null)`: the literal's contextual type is `S | (() => S)`.
            const bare = skipParens(arg);
            if (bare.kind === ts.SyntaxKind.NullKeyword || isNothing(bare)) {
              cells[cell].init = {
                op: bare.kind === ts.SyntaxKind.NullKeyword ? 'null' : 'undefined',
                type,
              };
              return;
            }
            const v = lower.value(arg, COMPONENT, `${cells[cell].name}$init`);
            cells[cell].init = coerceInit(v, lower.exprType(arg), type, lower.types.records);
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
    slotsOf[COMPONENT] = slots;
    return {
      name,
      cells,
      handlers: cur.handlers,
      template,
      ...(cur.tb.locals.length ? { templateLocals: cur.tb.locals } : {}),
      ...(slots.length
        ? {
            slots: slots.map(s => ({
              name: s.name,
              ...(s.params?.length ? { params: s.params } : {}),
            })),
          }
        : {}),
      ...(effects.length ? { effects } : {}),
    };
  }

  // --- Refs: useRef objects, attached to elements or used as mutable boxes ---
  /**
   * The ref objects attached with `ref={r}` to elements in `decl`. React keeps
   * the last attached element in a ref shared by several elements and clears
   * it when any of them unmounts, so a ref may be attached once.
   */
  const attachedRefs = (decl: ts.FunctionLikeDeclaration): Map<ts.Symbol, ts.JsxAttribute> => {
    const found = new Map<ts.Symbol, ts.JsxAttribute>();
    const visit = (n: ts.Node) => {
      if (
        ts.isJsxAttribute(n) &&
        n.name.getText() === 'ref' &&
        n.initializer &&
        ts.isJsxExpression(n.initializer) &&
        n.initializer.expression &&
        ts.isIdentifier(skipParens(n.initializer.expression))
      ) {
        const sym = symbolOf(skipParens(n.initializer.expression));
        if (sym) {
          if (found.has(sym))
            fail(
              n,
              'E_REF',
              'This ref is already attached to another element; React keeps the last attached element and clears the ref when any of them unmounts, which is unsupported',
            );
          found.set(sym, n);
        }
      }
      ts.forEachChild(n, visit);
    };
    if (decl.body) visit(decl.body);
    return found;
  };
  /** The IR types a ref can hold: elements and primitives (no shared heap values). */
  const refValue = (t: Type): boolean => {
    const base = maybeInner(t) ?? t;
    return base === 'element' || base === 'number' || base === 'string' || base === 'boolean';
  };
  /** `const r = useRef<T>(initial)` → a cell read live through `r.current`. */
  const lowerUseRef = (
    d: ts.VariableDeclaration,
    call: ts.CallExpression,
    COMPONENT: number,
    pending: (() => void)[],
  ) => {
    if (!ts.isIdentifier(d.name)) return fail(d, 'E_REF', 'Use const ref = useRef(initial)');
    if (call.arguments.length > 1) fail(call.arguments[1], 'E_REF', 'useRef takes one argument');
    const name = d.name.text;
    const sym = checker.getSymbolAtLocation(d.name)!;
    const attachedAt = cur.attached.get(sym);
    const current = checker.getPropertyOfType(checker.getTypeAtLocation(d.name), 'current');
    const tsType = current && checker.getTypeOfSymbolAtLocation(current, d.name);
    // `useRef(null)` in JavaScript: TypeScript types `current` as null.
    if (!tsType || tsType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Any))
      return fail(
        d,
        'E_REF',
        `${name} needs a type: useRef<HTMLInputElement>(null) in TypeScript, useRef(/** @type {HTMLInputElement | null} */ (null)) in JavaScript`,
      );
    const type = types.map(tsType, d.name);
    if (!refValue(type))
      fail(
        d,
        'E_CAPABILITY',
        `useRef holding ${JSON.stringify(type)} is planned for a later milestone (refs hold elements, numbers, strings and booleans)`,
      );
    const cells = cur.cells;
    const cell = cells.length;
    if (attachedAt) {
      if (JSON.stringify(type) !== JSON.stringify({ maybe: 'element' }))
        fail(
          attachedAt,
          'E_REF',
          `ref={${name}} needs an element ref that can be null (React clears it on unmount): useRef<HTMLElement | null>(null)`,
        );
      cur.elementRefs.add(cell);
    }
    // React never re-renders for a ref: its cell is never dirty.
    cells.push({
      name,
      type,
      init: { op: 'lit', value: 0 },
      tracking: 'none',
      source: sourceOf(d),
    });
    cur.refs.add(cell);
    lower.bindings.set(sym, { kind: 'ref', cell, field: 'current' });
    const arg = call.arguments[0];
    pending.push(() => {
      const bare = arg && skipParens(arg);
      if (!bare || isNothing(bare)) {
        const op = bare?.kind === ts.SyntaxKind.NullKeyword ? 'null' : 'undefined';
        if (!maybeInner(type)) fail(d, 'E_REF', `${name} is ${op} initially; type it as nullable`);
        cells[cell].init = { op, type };
        return;
      }
      const v = lower.value(arg, COMPONENT, `${name}$init`);
      cells[cell].init = coerceInit(v, lower.exprType(arg), type, lower.types.records);
    });
  };

  // --- Effects: useEffect and useLayoutEffect ---
  /**
   * `useEffect(fn, deps?)` and `useLayoutEffect(fn, deps?)` (docs/design/M4-EFFECTS.md).
   * `fn` is a component function: its state reads see its render's snapshot,
   * and a cleanup it returns keeps that snapshot. Layout effects run after
   * the DOM update, passive effects after all layout effects; at unmount
   * both clean up parent first, layout cleanups while the DOM is connected.
   */
  const lowerEffect = (
    call: ts.CallExpression,
    hook: 'useEffect' | 'useLayoutEffect',
    COMPONENT: number,
    pending: (() => void)[],
  ): Effect => {
    const [arg, depsArg, extra] = call.arguments;
    if (extra) fail(extra, 'E_EFFECT', `${hook} takes a function and a dependency array`);
    const fn = arg && skipParens(arg);
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))
      return fail(arg ?? call, 'E_EFFECT', `${hook} takes an inline function`);
    if (fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword))
      fail(
        fn,
        'E_EFFECT',
        `${hook} functions must be synchronous (an async function returns a promise, not a cleanup)`,
      );
    if (ts.isFunctionExpression(fn) && fn.asteriskToken)
      fail(fn, 'E_EFFECT', `${hook} functions must not be generators`);
    if (fn.parameters.length)
      fail(fn.parameters[0], 'E_EFFECT', `${hook} functions take no parameters`);
    let deps: Effect['deps'] = { kind: 'always' };
    if (depsArg) {
      const list = skipParens(depsArg);
      if (!ts.isArrayLiteralExpression(list))
        return fail(
          depsArg,
          'E_EFFECT',
          `The dependencies of ${hook} must be an array literal ([a, b]) so they can be compared per render`,
        );
      for (const el of list.elements)
        if (ts.isSpreadElement(el) || ts.isOmittedExpression(el))
          fail(el, 'E_EFFECT', 'Dependency arrays list each dependency (no spreads or holes)');
      if (!list.elements.length) deps = { kind: 'once' };
      else {
        const values: Expr[] = [];
        deps = { kind: 'values', values };
        pending.push(() => {
          for (const el of list.elements) values.push(dependency(el, COMPONENT, hook));
        });
      }
    }
    const run = lower.reserve();
    pending.push(() => {
      lower.function(fn, hook, undefined, COMPONENT, run);
      const result = lower.functions[run].result;
      const cleanup = (t: Type) =>
        typeof t === 'object' && 'fn' in t && !t.fn.params.length && t.fn.result === 'void';
      if (result !== 'void' && !cleanup(result) && !cleanup(maybeInner(result) ?? 'void'))
        fail(fn, 'E_EFFECT', `${hook} functions return nothing or a cleanup function`);
    });
    const layout = hook === 'useLayoutEffect';
    if (layout) layoutEffects.push({ run, node: call });
    return {
      run,
      phase: layout ? 'layout' : 'post',
      deps,
      unmount: { removal: layout ? 'before' : 'after', order: 'pre' },
      source: sourceOf(call),
    };
  };
  /** Run functions of layout effects (checked once every function is lowered). */
  const layoutEffects: { run: number; node: ts.Node }[] = [];
  /**
   * One dependency: compared by `Object.is` with its value at the last run.
   * React evaluates it while rendering; the IR evaluates it after the
   * instance updated, so it must not depend on anything that changes in
   * between or on when it is evaluated: no module objects (which effects
   * may mutate) and no values created per evaluation (objects, functions),
   * whose identity React renews only on renders.
   */
  const dependency = (el: ts.Expression, COMPONENT: number, hook: string): Expr => {
    const v = lower.value(el, COMPONENT, `${hook}$dep`);
    const t = lower.exprType(el);
    const base = maybeInner(t) ?? t;
    if (typeof base === 'object' && v.op !== 'cell')
      fail(
        el,
        'E_EFFECT',
        'Object, array and function dependencies must be state or props (values created while rendering get a new identity on every render)',
      );
    dependencies.push({ value: v, node: el });
    return v;
  };
  const dependencies: { value: Expr; node: ts.Expression }[] = [];
  /** Dependencies read no module objects and call no function values (checked once all is lowered). */
  const checkDependencies = () => {
    for (const { value, node } of dependencies) {
      const reached = new Set<number>();
      const visit = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (!n || typeof n !== 'object') return;
        const o = n as Record<string, unknown>;
        if (o.op === 'global')
          fail(
            node,
            'E_EFFECT',
            'Dependencies that read module objects are unsupported (effects may change them between rendering and the comparison)',
          );
        if (o.op === 'call-value')
          fail(node, 'E_EFFECT', 'Dependencies that call function values are unsupported');
        if ((o.op === 'call' || o.op === 'closure') && !reached.has(o.function as number)) {
          reached.add(o.function as number);
          visit(lower.functions[o.function as number].body);
        }
        for (const x of Object.values(o)) visit(x);
      };
      visit(value);
    }
  };

  /** Whether `decl` reads `props.<key>` of its props object `props`. */
  const readsProp = (decl: ts.Node, props: ts.Symbol, key: string): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (
        ts.isPropertyAccessExpression(n) &&
        n.name.text === key &&
        ts.isIdentifier(n.expression) &&
        symbolOf(n.expression) === props
      )
        found = true;
      ts.forEachChild(n, visit);
    };
    visit(decl);
    return found;
  };

  // --- Slots: ReactNode props and render props ---
  /** Whether `t` can be JSX (JSX.Element or a union containing it, such as ReactNode). */
  const isNodeType = (t: ts.Type): boolean =>
    (t.isUnion() ? t.types : [t]).some(p => {
      const s = p.getSymbol();
      return (
        s?.name === 'Element' && !!s.declarations?.some(d => d.getSourceFile().fileName === REACT)
      );
    });
  /** A ReactNode prop (rendered as `{x}`) or a render prop (`(a: A) => ReactNode`, called). */
  const slotKind = (t: ts.Type, at: ts.Node): { call: boolean; params?: Type[] } | undefined => {
    if (isNodeType(t)) return { call: false };
    const sigs = checker.getNonNullableType(t).getCallSignatures();
    if (sigs.length === 1 && isNodeType(sigs[0].getReturnType()))
      return {
        call: true,
        params: sigs[0].parameters.map(p =>
          types.map(checker.getTypeOfSymbolAtLocation(p, at), at),
        ),
      };
    return undefined;
  };
  /** The slot of the current component that `e` names (`children`, `props.children`). */
  const slotName = (e: ts.Node): string | undefined => {
    if (ts.isIdentifier(e)) {
      const s = symbolOf(e);
      return s && cur.slotOf.get(s);
    }
    if (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      cur.props &&
      symbolOf(e.expression) === cur.props
    )
      return cur.slots.find(x => x.name === e.name.text)?.name;
    return undefined;
  };
  /** `{children}`, `{row(x)}` or `{row?.(x)}` (also through `props.`): the slot rendered there. */
  const slotUse = (e: ts.Expression): { info: SlotInfo; call?: ts.CallExpression } | undefined => {
    const direct = slotName(e);
    if (direct) return { info: cur.slots.find(s => s.name === direct)! };
    if (ts.isCallExpression(e)) {
      const name = slotName(skipParens(e.expression));
      if (name) return { info: cur.slots.find(s => s.name === name)!, call: e };
    }
    return undefined;
  };
  /**
   * Whether `n` is rendered as a JSX child: directly, as a branch of `?:` or
   * the right side of `&&`, as a list callback's result or as slot content
   * passed on to another component.
   */
  const renderPosition = (n: ts.Node): boolean => {
    let c = n;
    while (ts.isParenthesizedExpression(c.parent)) c = c.parent;
    const p = c.parent;
    if (ts.isJsxExpression(p))
      return (
        ts.isJsxElement(p.parent) ||
        ts.isJsxFragment(p.parent) ||
        (ts.isJsxAttribute(p.parent) && componentAttribute(p.parent))
      );
    if (ts.isConditionalExpression(p)) return p.condition !== c && renderPosition(p);
    if (ts.isBinaryExpression(p))
      return (
        p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        p.right === c &&
        renderPosition(p)
      );
    let f: ts.Node | undefined;
    if (ts.isArrowFunction(p) && p.body === c) f = p;
    else if (
      ts.isReturnStatement(p) &&
      ts.isBlock(p.parent) &&
      p.parent.statements.length === 1 &&
      (ts.isArrowFunction(p.parent.parent) || ts.isFunctionExpression(p.parent.parent))
    )
      f = p.parent.parent;
    if (!f) return false;
    // A list callback, or a render function passed to another component.
    if (isMap(f.parent as ts.Expression))
      return (f.parent as ts.CallExpression).arguments[0] === f && renderPosition(f.parent);
    return (
      ts.isJsxExpression(f.parent) &&
      ts.isJsxAttribute(f.parent.parent) &&
      componentAttribute(f.parent.parent)
    );
  };
  /** Whether `a` is an attribute of a component element (slot content can be passed on). */
  const componentAttribute = (a: ts.JsxAttribute): boolean => {
    const tag = a.parent.parent.tagName;
    return ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text);
  };
  /** Reject uses of slot props other than rendering them in JSX. */
  const checkSlotUses = (root: ts.Node) => {
    const visit = (n: ts.Node) => {
      if (ts.isBindingElement(n)) {
        if (n.initializer) visit(n.initializer);
        return;
      }
      const name = ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) ? slotName(n) : undefined;
      if (name) {
        const call =
          ts.isCallExpression(n.parent) && n.parent.expression === n ? n.parent : undefined;
        if (!renderPosition(call ?? n))
          fail(
            n,
            'E_PROPS',
            `${name} can only be rendered as a JSX child ({children}, {row(…)} or {row?.(…)})`,
          );
        call?.arguments.forEach(visit);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(root);
  };

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
  const handlerFor = (expression: ts.Expression, event: HandlerEvent, where: ts.Node): Listener => {
    const e = skipParens(expression);
    let h: Omit<Handler, 'event'> & { args?: Expr[] };
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
      h = lower.handler(e, cur.index, event, cur.tb);
    else {
      if (readsTemplateLocals(e))
        fail(where, 'E_EVENT', 'Handlers that depend on list items must be inline arrow functions');
      // A named function, a callback prop or another function value, called
      // with the event object if it takes one.
      const b = ts.isIdentifier(e) ? lower.binding(e) : undefined;
      if (b?.kind === 'generic')
        fail(
          where,
          'E_EVENT',
          `${e.getText()} has an untyped parameter: type the event (JSDoc in JavaScript) or use an inline arrow function`,
        );
      const callee = b?.kind === 'function' ? undefined : lower.value(e, cur.index, 'handler');
      const t =
        types.typeOrUndefined(e) ??
        (callee
          ? lower.valueType(callee)
          : b?.kind === 'function' && lower.functions[b.fn]
            ? {
                fn: {
                  params: lower.functions[b.fn].params.map(p => p.type),
                  result: lower.functions[b.fn].result,
                },
              }
            : undefined);
      if (typeof t !== 'object' || !('fn' in t))
        return fail(where, 'E_EVENT', 'Event handlers must be functions');
      const params = t.fn.params;
      const args: Expr[] | undefined =
        params.length === 0
          ? []
          : params.length === 1 && params[0] === 'event'
            ? [{ op: 'event' }]
            : undefined;
      if (!args)
        return fail(where, 'E_EVENT', 'Event handlers take no parameter or the event object');
      h = {
        body: [
          {
            op: 'expr',
            value:
              b?.kind === 'function'
                ? { op: 'call', function: b.fn, args }
                : { op: 'call-value', callee: callee!, args },
          },
        ],
      };
    }
    const { args, ...rest } = h;
    cur.handlers.push({ event, ...rest, source: sourceOf(where) });
    return { event, handler: cur.handlers.length - 1, ...(args?.length ? { args } : {}) };
  };
  /** Listeners passed in rest props, by the component whose call site created them. */
  const bagListeners: {
    k: number;
    event: HandlerEvent;
    value: Expr;
    source: Handler['source'];
  }[] = [];
  /**
   * A prop passed into rest props, as React DOM sets it on the element it is
   * spread onto (setProp): event props become `on<event>` listeners; known
   * boolean props set presence when truthy; other attributes are strings,
   * numbers stringified, booleans set only for `data-*` and `aria-*` (as
   * "true"/"false"), nullish values absent.
   */
  const restEntry = (attr: ts.JsxAttribute, child: string): AttrItem => {
    const key = attr.name.getText();
    const init = attr.initializer;
    if (Object.hasOwn(EVENT_PROPS, key)) {
      const e = init && ts.isJsxExpression(init) ? init.expression : undefined;
      if (!e) return fail(attr, 'E_EVENT', 'Event props need a handler expression');
      const event = EVENT_PROPS[key];
      const v = expr(e);
      const t = typeOf(e, v);
      if (
        typeof t !== 'object' ||
        !('fn' in t) ||
        !(t.fn.params.length === 0 || (t.fn.params.length === 1 && t.fn.params[0] === 'event'))
      )
        fail(
          attr,
          'E_EVENT',
          `${key} in the rest props of ${child} must be a function taking no parameter or the event object`,
        );
      bagListeners.push({ k: cur.index, event, value: v, source: sourceOf(attr) });
      return { name: `on${event}`, value: v };
    }
    if (key === 'onWheel') return wheelUnsupported(attr);
    if (/^on[A-Z].*Capture$/.test(key)) return captureUnsupported(attr, key);
    if (key === 'onChange')
      return fail(
        attr,
        'E_EVENT',
        `onChange in the rest props of ${child} is unsupported (React makes it the input or the change event by the element it reaches); declare it as a prop`,
      );
    if (/^on[A-Z]/.test(key))
      return fail(
        attr,
        'E_EVENT',
        `${key} is unsupported (supported: ${Object.keys(EVENT_PROPS).join(', ')} and onChange on inputs)`,
      );
    if (/^on./i.test(key))
      return fail(
        attr,
        'E_PROPS',
        `${key}: React DOM sets no attribute for props starting with "on"; use an event prop (onClick)`,
      );
    if (key === 'ref')
      return fail(
        attr,
        'E_REF',
        `ref goes into the rest props of ${child}, which is unsupported; destructure ref ({ ref, ...rest }) and attach it`,
      );
    if (key === 'style')
      return fail(
        attr,
        'E_JSX',
        `style in the rest props of ${child} is unsupported (React applies style objects by a rule of its own); write style={{ … }} on the element`,
      );
    const name = restAttribute(key);
    if (!name)
      return fail(
        attr,
        'E_PROPS',
        `${key} in the rest props of ${child} is unsupported (React sets it by a rule of its own); declare it as a prop`,
      );
    const presence = PRESENCE_PROPS.has(key);
    const flag = /^(data|aria)-/.test(name);
    if (!init)
      return { name, value: { op: 'lit', value: presence ? true : flag ? 'true' : false } };
    if (ts.isStringLiteral(init)) {
      const text = decodeHTMLStrict(init.text);
      return { name, value: { op: 'lit', value: presence ? text !== '' : text } };
    }
    const e = (init as ts.JsxExpression).expression;
    if (!e) return fail(attr, 'E_PROPS', `${key} needs a value`);
    const v = expr(e);
    const t = typeOf(e, v);
    const base = maybeInner(t) ?? t;
    if (base !== 'string' && base !== 'number' && base !== 'boolean')
      return fail(
        attr,
        'E_PROPS',
        `${key} in rest props has type ${JSON.stringify(t)}; React sets attributes from strings, numbers and booleans here`,
      );
    if (presence) return { name, value: t === 'boolean' ? v : lower.truthy(v, t) };
    if (base === 'boolean' && !flag) {
      // React does not set booleans on other attributes (the value is still evaluated).
      const local = cur.tb.local('$unset', t);
      return { name, value: { op: 'with', local, value: v, body: { op: 'lit', value: false } } };
    }
    if (t === 'string' || t === 'number' || t === 'boolean')
      return { name, value: t === 'string' ? v : { op: 'to-string', arg: v } };
    if (base === 'string') return { name, value: v };
    // A nullable number or boolean: absent when nullish, otherwise its text.
    const local = cur.tb.local('$attr', base);
    return {
      name,
      value: {
        op: 'optional',
        value: v,
        local,
        then: { op: 'some', value: { op: 'to-string', arg: { op: 'local', local } } },
      },
    };
  };
  const captureUnsupported = (attr: ts.Node, prop: string): never =>
    fail(
      attr,
      'E_EVENT',
      `${prop} is unsupported: React runs capture handlers in the capture phase, before the target's own handlers, while the IR's listeners run in the bubbling phase`,
    );
  const wheelUnsupported = (attr: ts.Node): never =>
    fail(
      attr,
      'E_EVENT',
      "onWheel is unsupported: React's root wheel listener is passive, so preventDefault() has no effect and Chromium scrolls before it dispatches the event, to the element under the pointer after scrolling",
    );
  /**
   * `style={{ color: c, width: w }}` → the element's managed style as
   * properties only, set as React DOM's setValueForStyles does: each key
   * through the CSSOM (`style[key] = value`, setProperty for custom
   * properties) at mount, then the keys whose value changed; numbers get
   * `px` unless 0 or unitless; other values are trimmed strings; null,
   * undefined, booleans and '' remove the property. The keys must be static.
   */
  const styleObject = (attr: ts.JsxAttribute): { name: string; value: Expr }[] => {
    const init = attr.initializer;
    if (!init || ts.isStringLiteral(init))
      return fail(
        attr,
        'E_JSX',
        'React takes style as an object (style={{ color: c }}); a style string makes it throw',
      );
    const e = ts.isJsxExpression(init) && init.expression ? skipParens(init.expression) : undefined;
    if (!e || !ts.isObjectLiteralExpression(e))
      return fail(
        attr,
        'E_JSX',
        'Write the style object inline with static keys (style={{ color: c }}); style values computed elsewhere are unsupported',
      );
    const styles: { name: string; value: Expr }[] = [];
    const seen = new Set<string>();
    for (const p of e.properties) {
      let key: string;
      let value: ts.Expression | { shorthand: ts.ShorthandPropertyAssignment };
      if (ts.isPropertyAssignment(p)) {
        if (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))
          return fail(
            p.name,
            'E_JSX',
            'Style keys must be static names (computed keys are unsupported)',
          );
        key = p.name.text;
        value = p.initializer;
      } else if (ts.isShorthandPropertyAssignment(p)) {
        key = p.name.text;
        value = { shorthand: p };
      } else if (ts.isSpreadAssignment(p))
        return fail(
          p,
          'E_JSX',
          'Spreads in style objects are unsupported (the keys must be static)',
        );
      else return fail(p, 'E_JSX', 'Style objects hold properties (no methods or accessors)');
      const custom = key.startsWith('--');
      if (!custom && !/^[a-z][a-zA-Z]*$/.test(key))
        fail(
          p,
          'E_JSX',
          `Style key ${key} is unsupported: use camelCase CSS properties (backgroundColor) or custom properties ('--accent')`,
        );
      if (!custom && (/^(webkit|moz|ms|o)[A-Z]/.test(key) || DECLARATION_MEMBERS.has(key)))
        fail(
          p,
          'E_JSX',
          `Style key ${key} is unsupported (vendor prefixes and CSSStyleDeclaration members such as cssText, which React would assign)`,
        );
      if (seen.has(key)) fail(p, 'E_JSX', `Duplicate style key ${key}`);
      seen.add(key);
      styles.push({ name: custom ? key : kebab(key), value: styleValue(key, value, custom) });
    }
    return styles;
  };
  /** One style value as React DOM sets it (setValueForStyle); absent removes. */
  const styleValue = (
    key: string,
    e: ts.Expression | { shorthand: ts.ShorthandPropertyAssignment },
    custom: boolean,
  ): Expr => {
    const absent: Expr = { op: 'undefined', type: { maybe: 'string' } };
    let v: Expr;
    let t: Type;
    if ('shorthand' in e) {
      // `{ color }`: the variable named by the key.
      const sym = checker.getShorthandAssignmentValueSymbol(e.shorthand);
      const b = sym && lower.bindings.get(sym);
      if (!b) return fail(e.shorthand, 'E_UNRESOLVED', `${key} is not a supported binding here`);
      v = lower.bindingExpr(b, e.shorthand.name, cur.tb);
      t = typeOf(e.shorthand.name, v);
    } else {
      const bare = skipParens(e);
      if (isNothing(bare)) return absent;
      if (ts.isConditionalExpression(bare)) {
        // Each branch converted on its own (`c ? 'green' : undefined`).
        const c = expr(bare.condition);
        const optional = (x: Expr): Expr =>
          lower.irType(x, cur.tb) === 'string' ? { op: 'some', value: x } : x;
        return {
          op: 'cond',
          test: lower.truthy(c, typeOf(bare.condition, c)),
          then: optional(styleValue(key, bare.whenTrue, custom)),
          else: optional(styleValue(key, bare.whenFalse, custom)),
        };
      }
      v = expr(bare);
      t = typeOf(bare, v);
    }
    const base = maybeInner(t) ?? t;
    /** The text of a defined value `x` of the base type. */
    const text = (x: Expr): Expr => {
      if (base === 'string')
        return custom ? x : { op: 'builtin', name: 'string.trim', args: [x], type: 'string' };
      // A number: `px` unless 0, unitless or a custom property.
      if (custom || UNITLESS.has(key)) return { op: 'to-string', arg: x };
      const n = cur.tb.local('$style', 'number');
      const read: Expr = { op: 'local', local: n };
      return {
        op: 'with',
        local: n,
        value: x,
        body: {
          op: 'cond',
          test: { op: 'eq', left: read, right: { op: 'lit', value: 0 } },
          then: { op: 'to-string', arg: read },
          else: {
            op: 'concat',
            left: { op: 'to-string', arg: read },
            right: { op: 'lit', value: 'px' },
          },
        },
      };
    };
    if (base === 'boolean') {
      // React removes the property for booleans (the value is still evaluated).
      const local = cur.tb.local('$unset', t);
      return { op: 'with', local, value: v, body: absent };
    }
    if (base !== 'string' && base !== 'number')
      return fail(
        'shorthand' in e ? e.shorthand : e,
        'E_JSX',
        `Style value of type ${JSON.stringify(t)} is unsupported (strings, numbers, booleans, null and undefined)`,
      );
    if (t === base) return text(v);
    const local = cur.tb.local('$style', base);
    return {
      op: 'optional',
      value: v,
      local,
      then: { op: 'some', value: text({ op: 'local', local }) },
    };
  };
  /** `ref={r}` on an element: the cell of a useRef object of this component. */
  const elementRef = (attr: ts.JsxAttribute): number => {
    const init = attr.initializer;
    const e = init && ts.isJsxExpression(init) && init.expression && skipParens(init.expression);
    if (e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)))
      return fail(attr, 'E_REF', 'Callback refs are planned for a later milestone; use useRef');
    const b = e && ts.isIdentifier(e) ? lower.binding(e) : undefined;
    if (b?.kind !== 'ref' || b.field !== 'current' || !cur.elementRefs.has(b.cell))
      return fail(attr, 'E_REF', 'ref takes a useRef object declared in this component');
    // A list item or slot content can attach the ref to several elements.
    if (cur.repeated)
      return fail(
        attr,
        'E_REF',
        'Refs on elements in list items or children/render-prop content are unsupported (the ref could be attached to several elements)',
      );
    return b.cell;
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
    if (isJsx(e) || isMap(e) || slotUse(e)) return true;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return structural(e.right);
    if (ts.isConditionalExpression(e)) return structural(e.whenTrue) || structural(e.whenFalse);
    return false;
  };
  /** A slot of the current component rendered at `e` (`{children}`, `{row(a, b)}`). */
  const renderSlot = (
    e: ts.Expression,
    use: { info: SlotInfo; call?: ts.CallExpression },
  ): Node => {
    const { info, call } = use;
    if (!call) {
      if (info.call)
        fail(e, 'E_PROPS', `${info.name} is a render prop: call it ({${info.name}(…)})`);
      return { kind: 'slot', name: info.name, source: sourceOf(e) };
    }
    if (!info.call) fail(e, 'E_PROPS', `${info.name} is rendered as {${info.name}}, not called`);
    // React throws when an absent render prop is called without `?.`.
    if (!call.questionDotToken) info.required = true;
    const values = call.arguments.map(a => {
      if (ts.isSpreadElement(a))
        fail(a, 'E_PROPS', 'Spread arguments to render props are unsupported');
      const v = expr(a);
      return { a, v, t: typeOf(a, v) };
    });
    // Untyped render props take the argument types of their first call.
    info.params ??= values.map(x => x.t);
    const want = info.params;
    if (values.length > want.length)
      fail(call, 'E_PROPS', `${info.name} takes ${want.length} arguments`);
    const args = want.map((t, i): Expr => {
      const x = values[i];
      if (!x) {
        if (maybeInner(t)) return { op: 'undefined', type: t };
        return fail(call, 'E_PROPS', `${info.name} takes ${want.length} arguments`);
      }
      if (sameType(x.t, t)) return x.v;
      if (maybeInner(t) && sameType(maybeInner(t)!, x.t)) return { op: 'some', value: x.v };
      return fail(
        x.a,
        'E_PROPS',
        `Argument ${i + 1} of ${info.name} has type ${JSON.stringify(x.t)}, not ${JSON.stringify(t)}`,
      );
    });
    return { kind: 'slot', name: info.name, ...(args.length ? { args } : {}), source: sourceOf(e) };
  };
  /** Mark `nodes` as the content of one Fragment fiber (see checkUnmountOrder). */
  const fragment = (nodes: Node[]): Node[] => {
    const id = ++fragments;
    for (const n of nodes) (n as Node & { [FRAGMENT]?: number })[FRAGMENT] = id;
    return nodes;
  };
  let fragments = 0;
  /** The nodes of one JSX child expression (`multi`: one of several children). */
  const slot = (x: ts.Expression, multi = false): Node[] => {
    const e = skipParens(x);
    if (isJsx(e)) return ts.isJsxFragment(e) && multi ? fragment(jsx(e)) : jsx(e);
    if (isMap(e)) return multi ? fragment([list(e)]) : [list(e)];
    if (isNothing(e)) return [];
    const use = slotUse(e);
    if (use) return [renderSlot(e, use)];
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
          then: slot(e.right, multi),
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
          then: slot(e.whenTrue, multi),
          else: slot(e.whenFalse, multi),
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
      // Slot content can be any element type.
      if (slotUse(y)) return ['slot'];
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
    const clash =
      a.some(k => b.includes(k)) ||
      (a.includes('slot') && b.length > 0) ||
      (b.includes('slot') && a.length > 0);
    if (!clash) return;
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
    // A fragment or array among several children is a Fragment fiber of its
    // own (as the only child it is unwrapped into its parent).
    const multi =
      kids.filter(k =>
        ts.isJsxText(k) ? !!cleanText(k.text) : !ts.isJsxExpression(k) || !!k.expression,
      ).length > 1;
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
          out.push(...slot(child.expression, multi));
        } else {
          const d = display(skipParens(child.expression));
          if (d) parts.push(d);
        }
      } else if (isJsx(child)) {
        flush();
        out.push(...(ts.isJsxFragment(child) && multi ? fragment(jsx(child)) : jsx(child)));
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
    cur.repeated++;
    const body = slot(r);
    cur.repeated--;
    return {
      kind: 'each',
      // React's reconcileChildrenArray (which blocks move is observable through focus).
      reorder: 'forward',
      items,
      item,
      ...(index !== undefined ? { index } : {}),
      ...(key ? { key } : {}),
      body,
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
    const svg = SVG_TAGS.has(name);
    const attrs: { name: string; value: Expr }[] = [];
    const props: { name: string; value: Expr }[] = [];
    const listeners: Listener[] = [];
    let ref: number | undefined;
    let styles: { name: string; value: Expr }[] | undefined;
    const inputType =
      name === 'input'
        ? opening.attributes.properties
            .map(a => {
              if (!ts.isJsxAttribute(a) || a.name.getText() !== 'type' || !a.initializer) return;
              const v = ts.isJsxExpression(a.initializer)
                ? a.initializer.expression
                : a.initializer;
              return v && ts.isStringLiteralLike(v) ? v.text : undefined;
            })
            .find(t => t !== undefined)
        : undefined;
    // Checkboxes and radio buttons: a live checked property and change events.
    const radio = inputType === 'radio';
    const checkbox = inputType === 'checkbox' || radio;
    const select = name === 'select';
    // `{...rest}`: this component's rest props (the only spread the pre-pass allows).
    const spreadAt = opening.attributes.properties.findIndex(ts.isJsxSpreadAttribute);
    const restKeys = spreadAt >= 0 ? cur.rest!.keys : new Set<string>();
    if (spreadAt >= 0) {
      if (opening.attributes.properties.filter(ts.isJsxSpreadAttribute).length > 1)
        fail(opening, 'E_JSX', 'One spread per element is supported');
      if (checkbox || select || name === 'option')
        fail(
          opening.attributes.properties[spreadAt],
          'E_JSX',
          `Spread attributes on ${radio ? 'radio buttons' : checkbox ? 'checkboxes' : `<${name}>`} are planned for later`,
        );
    }
    for (const a of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(a)) continue;
      const attr = a as ts.JsxAttribute;
      const raw = attr.name.getText();
      const init = attr.initializer;
      if (raw === 'key') continue;
      if (
        raw in EVENT_PROPS ||
        (raw === 'onChange' && (name === 'input' || name === 'textarea' || select))
      ) {
        if (!init || !ts.isJsxExpression(init) || !init.expression)
          fail(attr, 'E_EVENT', 'Event props need a handler expression');
        // React's onChange is the input event on text inputs and text areas,
        // the change (dispatched on click) on checkboxes and radio buttons
        // and the change event on selects.
        const event: HandlerEvent =
          raw === 'onChange' ? (checkbox || select ? 'change' : 'input') : EVENT_PROPS[raw];
        // React DOM drops these listeners of disabled controls (getListener),
        // while Chromium delivers mousemove and mouseenter to them.
        if (
          (raw === 'onMouseMove' || raw === 'onMouseEnter') &&
          (name === 'button' || name === 'input') &&
          (restKeys.has('disabled') ||
            opening.attributes.properties.some(
              p => ts.isJsxAttribute(p) && p.name.getText() === 'disabled',
            ))
        )
          fail(
            attr,
            'E_EVENT',
            `React ignores ${raw} on disabled controls, which still receive the browser event; ${raw} on a control with a disabled prop is unsupported`,
          );
        listeners.push(handlerFor((init as ts.JsxExpression).expression!, event, attr));
        continue;
      }
      if (raw === 'onWheel') wheelUnsupported(attr);
      if (/^on[A-Z].*Capture$/.test(raw)) captureUnsupported(attr, raw);
      if (/^on[A-Z]/.test(raw))
        fail(
          attr,
          'E_EVENT',
          `${raw} is unsupported (supported: ${Object.keys(EVENT_PROPS).join(', ')} and onChange on inputs, text areas and selects)`,
        );
      if (select && (raw === 'defaultValue' || raw === 'multiple'))
        fail(
          attr,
          'E_JSX',
          raw === 'multiple'
            ? 'Multiple selects are planned for later'
            : 'Uncontrolled selects with defaultValue are planned for later (React marks the option selected); control the select with value and onChange, or leave it uncontrolled',
        );
      if (select && raw === 'value') {
        // React DOM's updateOptions, at mount, at every commit of the select
        // and after its change events (restoreControlledState): the option
        // with that value, else the first enabled one.
        const e = init && ts.isJsxExpression(init) ? init.expression : undefined;
        let value: Expr;
        if (init && ts.isStringLiteral(init))
          value = { op: 'lit', value: decodeHTMLStrict(init.text) };
        else if (!e) return fail(attr, 'E_JSX', 'value takes a string');
        else {
          const v = expr(e);
          const t = typeOf(e, v);
          if (t !== 'string' && t !== 'number')
            fail(
              attr,
              'E_JSX',
              `The value of a select must be a string or number, not ${JSON.stringify(t)} (null and undefined make it uncontrolled; arrays need multiple)`,
            );
          value = t === 'string' ? v : { op: 'to-string', arg: v };
        }
        props.push({ name: 'selectValue', value });
        continue;
      }
      if (name === 'option' && (raw === 'selected' || raw === 'defaultSelected'))
        fail(attr, 'E_JSX', `${raw} on options is unsupported; use value on the select`);
      if (name === 'textarea' && (raw === 'value' || raw === 'defaultValue')) {
        if (raw === 'defaultValue')
          fail(
            attr,
            'E_JSX',
            'Uncontrolled text areas (defaultValue) are planned for later; control the text area with value and onChange',
          );
        const e = init && ts.isJsxExpression(init) ? init.expression : undefined;
        let value: Expr;
        if (init && ts.isStringLiteral(init))
          value = { op: 'lit', value: decodeHTMLStrict(init.text) };
        else if (!e) return fail(attr, 'E_JSX', 'value takes a string');
        else {
          const v = expr(e);
          const t = typeOf(e, v);
          if (t !== 'string' && t !== 'number')
            fail(
              attr,
              'E_JSX',
              `The value of a text area must be a string or number, not ${JSON.stringify(t)} (null and undefined make it uncontrolled)`,
            );
          value = t === 'string' ? v : { op: 'to-string', arg: v };
        }
        // React DOM also keeps the text content (defaultValue) equal to the
        // controlled value, setting it first (initTextarea, updateTextarea):
        // the value starts from it, with the caret at the start.
        props.push({ name: 'defaultValue', value }, { name: 'value', value });
        continue;
      }
      if (checkbox && raw === 'checked') {
        // A controlled checkbox: the live checked property.
        let value: Expr = { op: 'lit', value: true };
        if (init) {
          if (!ts.isJsxExpression(init) || !init.expression)
            return fail(attr, 'E_JSX', 'checked takes a boolean expression');
          const e = init.expression;
          const v = expr(e);
          const t = typeOf(e, v);
          if (maybeInner(t))
            fail(
              attr,
              'E_JSX',
              'checked may be undefined, which makes the checkbox uncontrolled in React; pass a boolean',
            );
          value = t === 'boolean' ? v : { op: 'to-boolean', arg: v };
        }
        props.push({ name: 'checked', value });
        continue;
      }
      if (raw === 'style') {
        styles = styleObject(attr);
        continue;
      }
      if (raw === 'ref') {
        ref = elementRef(attr);
        continue;
      }
      if (svg) {
        const attrName = svgAttribute(raw);
        if (!attrName)
          fail(
            attr,
            'E_JSX',
            `Unsupported SVG prop ${raw} (supported: ${Object.keys(SVG_PROPS).join(', ')} and lowercase, aria-* and data-* names)`,
          );
        // setValueForAttribute: booleans set aria-* and data-* to "true" or
        // "false" and remove other attributes (with a warning), which is
        // rejected here.
        const ariaData = /^(aria|data)-/.test(attrName!);
        if (!init) {
          if (!ariaData) fail(attr, 'E_JSX', `Boolean value for ${attrName}`);
          attrs.push({ name: attrName!, value: { op: 'lit', value: 'true' } });
          continue;
        }
        if (ts.isStringLiteral(init)) {
          attrs.push({ name: attrName!, value: { op: 'lit', value: decodeHTMLStrict(init.text) } });
          continue;
        }
        const e = (init as ts.JsxExpression).expression!;
        const v = expr(e);
        const t = typeOf(e, v);
        if (t === 'boolean' && !ariaData) fail(attr, 'E_JSX', `Boolean value for ${attrName}`);
        // React omits an attribute whose value is null or undefined.
        if (maybeInner(t) === 'string') attrs.push({ name: attrName!, value: v });
        else if (maybeInner(t))
          fail(attr, 'E_JSX', `Attribute ${attrName} of type ${JSON.stringify(t)} is unsupported`);
        else
          attrs.push({
            name: attrName!,
            value: t === 'string' ? v : { op: 'to-string', arg: v },
          });
        continue;
      }
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
      if (attrName === 'value' && name === 'input' && !checkbox)
        props.push({ name: 'value', value: t === 'string' ? v : { op: 'to-string', arg: v } });
      else if (BOOLEAN_ATTRS.has(attrName))
        attrs.push({ name: attrName, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } });
      else if (t === 'boolean') fail(attr, 'E_JSX', `Boolean value for ${attrName}`);
      // React omits an attribute whose value is null or undefined.
      else if (maybeInner(t) === 'string') attrs.push({ name: attrName, value: v });
      else if (maybeInner(t))
        fail(attr, 'E_JSX', `Attribute ${attrName} of type ${JSON.stringify(t)} is unsupported`);
      else attrs.push({ name: attrName, value: t === 'string' ? v : { op: 'to-string', arg: v } });
    }
    if (checkbox && !props.some(p => p.name === 'checked'))
      fail(
        opening,
        'E_JSX',
        radio
          ? 'Radio buttons must be controlled with checked={…} (uncontrolled radio buttons and defaultChecked are planned for later)'
          : 'Checkboxes must be controlled with checked={…} (uncontrolled checkboxes and defaultChecked are planned for M5)',
      );
    // React restores a controlled radio button or select after its change
    // event even without an onChange listener (a read-only control); the
    // IR restores after events that run listeners.
    if (
      (radio || (select && props.some(p => p.name === 'selectValue'))) &&
      !listeners.some(l => l.event === 'change')
    )
      fail(
        opening,
        'E_JSX',
        `A controlled ${radio ? 'radio button' : 'select'} needs an onChange handler (read-only controls are planned for later)`,
      );
    if (name === 'textarea' && kids.some(k => !ts.isJsxText(k) || cleanText(k.text)))
      fail(
        opening,
        'E_JSX',
        'A text area shows its value, not its children; use value and onChange',
      );
    // With rest props spread, the element's own attributes that the bag may
    // also hold join it in source order: React builds one props object, in
    // which a later prop wins.
    let spread: Expr | undefined;
    if (spreadAt >= 0) {
      const names = new Map<string, string>();
      for (const k of restKeys) {
        const n = Object.hasOwn(EVENT_PROPS, k) ? `on${EVENT_PROPS[k]}` : restAttribute(k);
        if (n) names.set(n, k);
      }
      const position = (attrName: string) =>
        opening.attributes.properties.findIndex(
          p => ts.isJsxAttribute(p) && (ATTRS[p.name.getText()] ?? p.name.getText()) === attrName,
        );
      const before: AttrItem[] = [];
      const after: AttrItem[] = [];
      for (const x of [...attrs])
        if (names.has(x.name)) {
          (position(x.name) < spreadAt ? before : after).push({ name: x.name, value: x.value });
          attrs.splice(attrs.indexOf(x), 1);
        }
      for (const l of listeners)
        if (names.has(`on${l.event}`))
          fail(
            opening,
            'E_JSX',
            `${names.get(`on${l.event}`)} is both on the element and possibly in the spread rest props`,
          );
      if (
        (name === 'button' || name === 'input') &&
        (restKeys.has('onMouseMove') || restKeys.has('onMouseEnter')) &&
        (restKeys.has('disabled') ||
          opening.attributes.properties.some(
            p => ts.isJsxAttribute(p) && p.name.getText() === 'disabled',
          ))
      )
        fail(
          opening.attributes.properties[spreadAt],
          'E_EVENT',
          'React ignores onMouseMove and onMouseEnter on disabled controls, which still receive the browser event; such rest props on a control that may be disabled are unsupported',
        );
      const bag: Expr = { op: 'cell', cell: cur.rest!.cell, read: 'snapshot' };
      spread =
        before.length || after.length
          ? { op: 'attrs', items: [...before, { spread: bag }, ...after] }
          : bag;
    }
    const node: Node & { kind: 'element' } = {
      kind: 'element',
      tag: name,
      ...(attrs.length ? { attrs } : {}),
      ...(props.length ? { props } : {}),
      ...(listeners.length ? { listeners } : {}),
      ...(ref !== undefined ? { ref } : {}),
      ...(spread ? { spread } : {}),
      ...(styles?.length ? { styles } : {}),
      ...(kids.length ? { children: children(kids) } : {}),
      source: sourceOf(n),
    };
    if (select) checkSelectChildren(node, 'React renders it as a text node');
    return keyed(keyAttr, [node], n);
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
    if (active.includes(entry.decl))
      return fail(at, 'E_COMPONENT', 'Recursive components are planned for a later milestone');
    // Content between the tags: React's `children` (comments and blank text are not).
    const content = kids.filter(
      k => !(ts.isJsxText(k) && !cleanText(k.text)) && !(ts.isJsxExpression(k) && !k.expression),
    );
    // Whether a prop is a value or slot content: from the lowered child, its
    // declared prop types, or (untyped JavaScript) what is passed.
    const known = indexOf.get(entry.decl);
    const param = entry.decl.parameters[0];
    const paramType = param && checker.getTypeAtLocation(param);
    const kindOf = (key: string, value: ts.Node | undefined): 'node' | 'call' | 'value' => {
      if (known !== undefined) {
        const s = slotsOf[known].find(x => x.name === key);
        return s ? (s.call ? 'call' : 'node') : 'value';
      }
      const p =
        paramType && !(paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
          ? checker.getPropertyOfType(paramType, key)
          : undefined;
      const t = p && checker.getTypeOfSymbolAtLocation(p, param!);
      if (t && !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        const k = slotKind(t, param!);
        return k ? (k.call ? 'call' : 'node') : 'value';
      }
      const v = attrValue(value);
      if (v && isJsx(v)) return 'node';
      const f = inlineFnOf(value);
      if (f && returnsJsx(f)) return 'call';
      return key === 'children' ? 'node' : 'value';
    };
    const passed: { name: string; value: Expr; type: Type; at: ts.Node }[] = [];
    /** Slot content: an attribute value, or the content between the tags. */
    const given: {
      name: string;
      call: boolean;
      init?: ts.JsxAttributeValue;
      kids?: ts.JsxChild[];
      at: ts.Node;
    }[] = [];
    const info = propsDecls.get(entry.decl)!;
    // Props the child does not declare go into its rest props, in source order.
    const bag: AttrItem[] = [];
    /** The ref object passed as `ref` (a cell of this component). */
    let refCell: number | undefined;
    for (const a of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(a)) {
        // This component's rest props, to a child taking rest props (checked above).
        bag.push({ spread: { op: 'cell', cell: cur.rest!.cell, read: 'snapshot' } });
        continue;
      }
      const attr = a as ts.JsxAttribute;
      const name = attr.name.getText();
      if (name === 'key') continue;
      if (name === 'ref') {
        if (info.rest && !info.declared.has('ref')) restEntry(attr, entry.name);
        if (!info.declared.has('ref'))
          fail(
            attr,
            'E_REF',
            `${entry.name} does not take a ref: React 19 passes ref as a prop, so destructure it ({ ref }) and attach it to an element`,
          );
        refCell = elementRef(attr);
        continue;
      }
      if (info.rest && !info.declared.has(name)) {
        bag.push(restEntry(attr, entry.name));
        continue;
      }
      const init = attr.initializer;
      const kind = kindOf(name, init);
      if (kind !== 'value') {
        given.push({ name, call: kind === 'call', init, at: attr });
        continue;
      }
      const v = attrValue(init);
      if (v && isJsx(v)) fail(attr, 'E_PROPS', `${name} of ${entry.name} is not a ReactNode prop`);
      const value: Expr = !init
        ? { op: 'lit', value: true }
        : ts.isStringLiteral(init)
          ? { op: 'lit', value: decodeHTMLStrict(init.text) }
          : expr((init as ts.JsxExpression).expression!);
      passed.push({ name, value, type: lower.irType(value, cur.tb), at: attr });
    }
    if (content.length) {
      if (info.rest && !info.declared.has('children'))
        fail(
          at,
          'E_PROPS',
          `The children of ${entry.name} go into its rest props, which is unsupported; destructure children`,
        );
      if (given.some(g => g.name === 'children'))
        fail(at, 'E_PROPS', 'children are passed both as a prop and between the tags');
      const single = content.length === 1 ? content[0] : undefined;
      const kind = kindOf('children', single && inlineFnOf(single) ? single : undefined);
      if (kind === 'value')
        fail(at, 'E_PROPS', `${entry.name} takes children as a value; type them as ReactNode`);
      given.push({ name: 'children', call: kind === 'call', kids: content, at });
    }
    const site = new Map<string, SiteProp>(passed.map(p => [p.name, p.type]));
    for (const g of given) site.set(g.name, { slot: g.call ? 'call' : 'node' });
    const index = instantiate(entry, site, at);
    const target = components[index];
    const declared = slotsOf[index];
    // Slot content renders wherever (and as often as) the child renders the slot.
    cur.repeated++;
    const defs = given.map(g => {
      const d = declared.find(x => x.name === g.name);
      if (!d)
        return g.name === 'children'
          ? fail(g.at, 'E_COMPONENT', `${entry.name} does not render its children`)
          : fail(g.at, 'E_PROPS', `${entry.name} has no prop ${g.name}`);
      if (d.call !== g.call)
        fail(
          g.at,
          'E_PROPS',
          d.call
            ? `${g.name} of ${entry.name} is a render prop: pass an inline function returning JSX`
            : `${g.name} of ${entry.name} is rendered as a node: pass JSX, not a function`,
        );
      return d.call ? renderFunction(g, d, entry.name) : { name: g.name, body: nodeContent(g) };
    });
    cur.repeated--;
    for (const d of declared)
      if (d.required && !given.some(g => g.name === d.name))
        fail(at, 'E_PROPS', `${entry.name} requires the render prop ${d.name}`);
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
    const all: { name: string; value: Expr; bind?: Expr }[] = props;
    if (refCell !== undefined) {
      // The child's ref prop holds its element while mounted and null after;
      // as a bound prop it writes both to this component's ref object. What
      // is passed down is never read (the child only attaches the ref).
      const own = refCell;
      const setter = lower.reserve();
      lower.functions[setter] = {
        name: `${cur.cells[own].name}$ref`,
        component: cur.index,
        params: [{ name: 'element', type: REF_TYPE }],
        locals: [],
        result: 'void',
        body: [{ op: 'set', cell: own, value: { op: 'local', local: 0 } }],
        source: sourceOf(at),
      };
      all.push({
        name: 'ref',
        value: { op: 'null', type: REF_TYPE },
        bind: { op: 'closure', function: setter, captures: [] },
      });
    }
    if (bag.length)
      all.push({
        name: '...',
        value: bag.length === 1 && 'spread' in bag[0] ? bag[0].spread : { op: 'attrs', items: bag },
      });
    return [
      {
        kind: 'component',
        component: index,
        ...(all.length ? { props: all } : {}),
        ...(defs.length ? { slots: defs } : {}),
        source: sourceOf(at),
      },
    ];
  };
  /** ReactNode slot content: JSX children, or an attribute value rendered as a child. */
  const nodeContent = (g: { init?: ts.JsxAttributeValue; kids?: ts.JsxChild[] }): Node[] => {
    if (g.kids) return children(g.kids);
    const init = g.init;
    // A bare attribute is `true`, which React renders as nothing.
    if (!init) return [];
    if (ts.isStringLiteral(init)) {
      const text = decodeHTMLStrict(init.text);
      return text ? [{ kind: 'text', parts: [{ op: 'lit', value: text }] }] : [];
    }
    if (isJsx(init)) return jsx(init);
    const e = (init as ts.JsxExpression).expression;
    return e ? slot(e) : [];
  };
  /** A render prop's inline function → slot content whose parameters are template locals. */
  const renderFunction = (
    g: { name: string; init?: ts.JsxAttributeValue; kids?: ts.JsxChild[]; at: ts.Node },
    d: SlotInfo,
    child: string,
  ) => {
    const f = g.kids
      ? g.kids.length === 1
        ? inlineFnOf(g.kids[0])
        : undefined
      : inlineFnOf(g.init);
    if (!f)
      return fail(
        g.at,
        'E_PROPS',
        `${g.name} is a render prop: pass an inline function returning JSX`,
      );
    if (!d.params) return fail(g.at, 'E_PROPS', `${child} never renders ${g.name}`);
    const want = d.params;
    if (f.parameters.length > want.length)
      fail(
        f.parameters[want.length],
        'E_PROPS',
        `${child} passes ${want.length} arguments to ${g.name}`,
      );
    const params = want.map((type, i) => {
      const p = f.parameters[i];
      if (!p) return cur.tb.local('$arg', type);
      if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken)
        fail(
          p,
          'E_PROPS',
          'Destructured or defaulted render prop parameters are planned for later',
        );
      const id = p.name as ts.Identifier;
      const local = cur.tb.local(id.text, type);
      const sym = checker.getSymbolAtLocation(id)!;
      lower.bindings.set(sym, { kind: 'local', owner: cur.tb, local });
      // Untyped JavaScript: the type the child passes.
      if (types.typeOrUndefined(id) === undefined) types.override(sym, type);
      return local;
    });
    let result: ts.Expression | undefined;
    if (ts.isBlock(f.body)) {
      const [only] = f.body.statements;
      if (f.body.statements.length === 1 && ts.isReturnStatement(only)) result = only.expression;
    } else result = f.body;
    if (!result) return fail(f, 'E_PROPS', 'Render props must return JSX directly (no statements)');
    return { name: g.name, ...(params.length ? { params } : {}), body: slot(result) };
  };
  /** An attribute value or child: the expression inside `{…}`, otherwise the node itself. */
  const attrValue = (v: ts.Node | undefined): ts.Node | undefined =>
    v && ts.isJsxExpression(v) ? v.expression && skipParens(v.expression) : v;
  /** A function written inline (`{(x) => …}`), if `v` is one. */
  const inlineFnOf = (v: ts.Node | undefined) => {
    const e = v && ts.isJsxExpression(v) ? attrValue(v) : undefined;
    return e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ? e : undefined;
  };

  /**
   * React never re-renders for a ref and sets element refs only at commit, so
   * `ref.current` read or written while rendering is not modelled (cells are
   * set at mount and bindings update only for dirty cells). Reject ref
   * accesses in code that may run during rendering: templates, initialisers
   * and the functions they call. Calls of function values there may reach any
   * closure, and closures passed to built-ins (`items.filter(…)`) run in place.
   * Then remove the REF_ACCESS marks.
   */
  /** The functions of every closure created in `n` (not inside the closures' own bodies). */
  const closures = (n: unknown, out: Set<number>) => {
    if (Array.isArray(n)) return n.forEach(x => closures(x, out));
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o.op === 'closure') out.add(o.function as number);
    for (const v of Object.values(o)) closures(v, out);
  };
  /**
   * Visit `roots` (`[ir, called]`: closures created there run in place) and
   * the bodies of the functions they may call. Closures passed to built-ins
   * run in place; once a function value is called, any closure may run.
   */
  const reachable = (roots: [unknown, boolean][], check: (o: Record<string, unknown>) => void) => {
    const reached = new Set<number>();
    const work: number[] = [];
    const reach = (fn: number) => {
      if (!reached.has(fn)) {
        reached.add(fn);
        work.push(fn);
      }
    };
    let dynamic = false;
    const visit = (n: unknown, called: boolean) => {
      if (Array.isArray(n)) return n.forEach(x => visit(x, called));
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      check(o);
      if (o.op === 'call') reach(o.function as number);
      if (o.op === 'call-value') dynamic = true;
      if (o.op === 'closure' && called) reach(o.function as number);
      for (const [k, v] of Object.entries(o))
        // Listeners run on events (their handlers are not visited).
        if (k !== 'listeners') visit(v, called || (o.op === 'builtin' && k === 'args'));
    };
    for (const [n, called] of roots) visit(n, called);
    let all: Set<number> | undefined;
    for (;;) {
      while (work.length) visit(lower.functions[work.pop()!].body, false);
      if (!dynamic || all) break;
      all = new Set();
      closures([lower.functions, components], all);
      for (const f of all) reach(f);
    }
  };
  const checkRenderRefs = () => {
    reachable(
      components.flatMap(c => [
        [c.template, false],
        [c.cells.map(x => x.init), false],
        // Dependencies are evaluated while rendering.
        [(c.effects ?? []).map(e => e.deps), false],
      ]),
      o => {
        const mark = o[REF_ACCESS];
        if (typeof mark === 'number')
          fail(
            refAccesses[mark].node,
            'E_REF',
            'This ref access may run while rendering (in JSX, an initialiser, a render-time const, an effect dependency or a function they call); React does not re-render for refs and sets element refs after rendering, so use refs in event handlers and effects',
          );
      },
    );
    for (const { run, node } of layoutEffects) {
      const made = new Set<number>();
      closures(lower.functions[run].body, made);
      // Layout cleanups at unmount run before React detaches element refs;
      // the IR clears refs when the element is removed.
      reachable(
        [...made].map(f => [{ op: 'closure', function: f }, true]),
        o => {
          const mark = o[REF_ACCESS];
          if (typeof mark === 'number' && refAccesses[mark].element)
            fail(
              refAccesses[mark].node,
              'E_REF',
              'Element refs in layout effect cleanups are unsupported (at unmount React runs them before it clears the ref)',
            );
        },
      );
      // After a non-event update React runs passive effects in a later task,
      // so microtasks queued by layout effects run before them; the IR runs
      // both phases in one flush.
      reachable([[lower.functions[run].body, true]], o => {
        if (o.op === 'builtin' && o.name === 'microtask.queue')
          fail(
            node,
            'E_EFFECT',
            'Microtasks queued by layout effects are unsupported (after non-event updates React runs passive effects in a later task)',
          );
      });
    }
    const strip = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(strip);
      if (!n || typeof n !== 'object') return;
      delete (n as Record<string, unknown>)[REF_ACCESS];
      delete (n as Record<string, unknown>)[FRAGMENT];
      for (const v of Object.values(n)) strip(v);
    };
    strip([lower.functions, components]);
  };

  /**
   * Batched cleanups visit, at each instance, the instances destroyed under
   * it before its live children (see the schedule below). React's walk is
   * over fibers: deletions run where their parent element or fragment
   * begins. Both orders agree unless a conditional or list that can unmount
   * components with effect cleanups follows, outside its own parent element
   * or fragment, another component with cleanups (or another such
   * conditional). Reject those positions, and such conditionals inside
   * children/render-prop content (rendered in another component's elements).
   */
  const checkUnmountOrder = () => {
    const holder = components.map(c =>
      (c.effects ?? []).some(e => lower.functions[e.run].result !== 'void'),
    );
    /** Whether some parent passes slot content holding such components. */
    const filled = components.map(() => false);
    const holds = (nodes: Node[], k: number): boolean =>
      nodes.some(n => {
        switch (n.kind) {
          case 'component':
            return holder[n.component] || (n.slots ?? []).some(s => holds(s.body, k));
          case 'slot':
            return filled[k] || holds(n.fallback ?? [], k);
          case 'element':
            return holds(n.children ?? [], k);
          case 'if':
            return holds(n.then, k) || holds(n.else ?? [], k);
          case 'each':
            return holds(n.body, k) || holds(n.else ?? [], k);
          default:
            return false;
        }
      });
    const eachComponent = (nodes: Node[], f: (n: Node & { kind: 'component' }) => void) => {
      for (const n of nodes) {
        if (n.kind === 'component') f(n);
        const kids = [
          ...(n.kind === 'element' ? (n.children ?? []) : []),
          ...(n.kind === 'if' ? [...n.then, ...(n.else ?? [])] : []),
          ...(n.kind === 'each' ? [...n.body, ...(n.else ?? [])] : []),
          ...(n.kind === 'slot' ? (n.fallback ?? []) : []),
          ...(n.kind === 'component' ? (n.slots ?? []).flatMap(s => s.body) : []),
        ];
        eachComponent(kids, f);
      }
    };
    for (let changed = true; changed;) {
      changed = false;
      components.forEach((c, k) => {
        if (!holder[k] && holds(c.template, k)) holder[k] = changed = true;
        eachComponent(c.template, n => {
          if (!filled[n.component] && (n.slots ?? []).some(s => holds(s.body, k)))
            filled[n.component] = changed = true;
        });
      });
    }
    const reject = (n: Node, message: string): never => {
      throw new Diagnostic('E_EFFECT', message, n.source);
    };
    components.forEach((c, k) => {
      interface Item {
        deletion: boolean;
        start: number;
        end: number;
        /** Enclosing elements and fragments (outermost first). */
        within: object[];
        container: object;
      }
      const items: Item[] = [];
      let clock = 0;
      const tokens = new Map<number, object>();
      const walk = (nodes: Node[], within: object[], inSlot: boolean) => {
        for (const n of nodes) {
          const mark = (n as Node & { [FRAGMENT]?: number })[FRAGMENT];
          if (mark !== undefined && !tokens.has(mark)) tokens.set(mark, {});
          const inner = mark !== undefined ? [...within, tokens.get(mark)!] : within;
          const start = clock++;
          const deletion = (n.kind === 'if' || n.kind === 'each') && holds([n], k);
          if (deletion && inSlot)
            reject(
              n,
              'Conditionals and lists that can unmount components with effect cleanups are unsupported in children and render-prop content (React runs those cleanups at their position in the receiving component)',
            );
          if (n.kind === 'element') walk(n.children ?? [], [...inner, n], inSlot);
          if (n.kind === 'if') walk([...n.then, ...(n.else ?? [])], inner, inSlot);
          if (n.kind === 'each') walk([...n.body, ...(n.else ?? [])], inner, inSlot);
          if (n.kind === 'slot') walk(n.fallback ?? [], inner, inSlot);
          if (n.kind === 'component') for (const s of n.slots ?? []) walk(s.body, inner, true);
          const end = clock++;
          if (deletion || ((n.kind === 'component' || n.kind === 'slot') && holds([n], k))) {
            const item = { deletion, start, end, within: inner, container: inner.at(-1)! };
            for (const y of items)
              if (
                deletion &&
                y.end < start &&
                (!y.within.includes(item.container) ||
                  (y.deletion && y.container !== item.container))
              )
                reject(
                  n,
                  'This conditional or list can unmount components with effect cleanups, and components with cleanups come before it outside its parent element (or fragment); React runs these unmount cleanups at the position of that element, which is unsupported. Move it into the same element as the components before it, or before them',
                );
            items.push(item);
          }
        }
      };
      walk(c.template, [c], false);
    });
  };

  /**
   * `always` effects run after every update of their instance, and an
   * instance updates when its rendering parent does. React re-renders an
   * element only when the component that created it renders: children
   * content (`{children}`, ReactNode props) is created by the parent passing
   * it, so it does not re-render when only the receiving component does.
   * Reject effects without dependencies in components rendered (at any
   * depth) inside children content; render props create their content on
   * each call, so they follow the rendering parent as the IR does.
   */
  const checkChildrenEffects = () => {
    const inside = new Set<number>();
    const add = (k: number) => {
      if (inside.has(k)) return;
      inside.add(k);
      visit(components[k].template, true);
    };
    const visit = (nodes: Node[], within: boolean) => {
      for (const n of nodes) {
        if (n.kind === 'component') {
          if (within) add(n.component);
          for (const s of n.slots ?? []) {
            const call = slotsOf[n.component].find(x => x.name === s.name)?.call;
            visit(s.body, within || !call);
          }
        }
        if (n.kind === 'element') visit(n.children ?? [], within);
        if (n.kind === 'if') visit([...n.then, ...(n.else ?? [])], within);
        if (n.kind === 'each') visit([...n.body, ...(n.else ?? [])], within);
        if (n.kind === 'slot') visit(n.fallback ?? [], within);
      }
    };
    components.forEach(c => visit(c.template, false));
    for (const k of inside)
      for (const e of components[k].effects ?? [])
        if (e.deps.kind === 'always')
          throw new Diagnostic(
            'E_EFFECT',
            `${components[k].name} is rendered inside children content, which React does not re-render when only the receiving component renders; effects without dependencies are unsupported there (list the dependencies)`,
            e.source,
          );
  };

  // --- Events: React DOM semantics the IR models only in part ---
  type Obj = Record<string, unknown>;
  /** The types and names of a function's (or handler's) locals, by IR index. */
  const localsOf = (f: { captures?: Local[]; params?: Local[]; locals?: Local[] }): Local[] => [
    ...(f.captures ?? []),
    ...(f.params ?? []),
    ...(f.locals ?? []),
  ];
  /**
   * Visit the code `roots` may run: the functions they call and the closures
   * they create (which may run now or later), each node with the component
   * whose cells it reads and the locals in scope. A function value called
   * with the event object (`event`: the dispatch's event may reach it) makes
   * every closure of the program reachable.
   */
  const runs = (
    roots: { body: unknown; component: number | undefined; locals: Local[] }[],
    visit: (o: Obj, component: number | undefined, locals: Local[]) => void,
    event = false,
  ) => {
    const seen = new Set<number>();
    let all = false;
    const enter = (fn: number) => {
      if (seen.has(fn)) return;
      seen.add(fn);
      const f = lower.functions[fn];
      walk(f.body, f.component, localsOf(f));
    };
    const walk = (n: unknown, component: number | undefined, locals: Local[]) => {
      if (Array.isArray(n)) return n.forEach(x => walk(x, component, locals));
      if (!n || typeof n !== 'object') return;
      const o = n as Obj;
      visit(o, component, locals);
      if (o.op === 'call' || o.op === 'closure') enter(o.function as number);
      if (
        event &&
        !all &&
        o.op === 'call-value' &&
        (o.args as Expr[]).some(
          a => a.op === 'event' || (a.op === 'local' && locals[a.local]?.type === 'event'),
        )
      ) {
        all = true;
        const every = new Set<number>();
        closures([lower.functions, components], every);
        for (const f of every) enter(f);
      }
      for (const [k, v] of Object.entries(o)) if (k !== 'listeners') walk(v, component, locals);
    };
    for (const r of roots) walk(r.body, r.component, r.locals);
  };
  const handlerRoot = (k: number, h: Handler) => ({
    body: h.body,
    component: k,
    locals: localsOf(h),
  });
  const rejectEvent = (source: Handler['source'], message: string): never => {
    throw new Diagnostic('E_EVENT', message, source);
  };
  const eventMember = (o: Obj) =>
    o.op === 'builtin' && typeof o.name === 'string' && o.name.startsWith('event.')
      ? o.name.slice(6)
      : undefined;
  /** Props of the IR event kinds, for messages. */
  const propOf = (event: HandlerEvent) =>
    Object.entries(EVENT_PROPS).find(([, e]) => e === event)?.[0] ?? 'onChange';
  /**
   * Template expressions of `nodes`, split into text parts (with inline
   * style properties that only change painting) and the rest (attributes,
   * other style properties, properties, listener arguments, conditions,
   * lists, props).
   */
  const templateExprs = (nodes: Node[], text: Expr[], rest: unknown[]) => {
    for (const n of nodes)
      switch (n.kind) {
        case 'text':
          text.push(...n.parts);
          break;
        case 'element':
          rest.push(
            n.attrs ?? [],
            n.props ?? [],
            (n.listeners ?? []).map(l => l.args ?? []),
            n.spread ?? [],
            n.classes ?? [],
            n.styleText ?? [],
          );
          for (const s of n.styles ?? [])
            (PAINT_ONLY_STYLES.has(s.name) ? text : rest).push(s.value);
          templateExprs(n.children ?? [], text, rest);
          break;
        case 'if':
          rest.push(n.test);
          templateExprs([...n.then, ...(n.else ?? [])], text, rest);
          break;
        case 'each':
          rest.push(n.items, n.key ?? []);
          templateExprs([...n.body, ...(n.else ?? [])], text, rest);
          break;
        case 'component':
          rest.push(n.props ?? []);
          for (const s of n.slots ?? []) templateExprs(s.body, text, rest);
          break;
        case 'slot':
          rest.push(n.args ?? []);
          templateExprs(n.fallback ?? [], text, rest);
          break;
      }
  };
  /** Components rendered (at any depth) by the templates `nodes`. */
  const renderedBy = (nodes: Node[], out: Set<number>) => {
    for (const n of nodes) {
      if (n.kind === 'component') {
        if (!out.has(n.component)) {
          out.add(n.component);
          renderedBy(components[n.component].template, out);
        }
        for (const s of n.slots ?? []) renderedBy(s.body, out);
      }
      if (n.kind === 'element') renderedBy(n.children ?? [], out);
      if (n.kind === 'if') renderedBy([...n.then, ...(n.else ?? [])], out);
      if (n.kind === 'each') renderedBy([...n.body, ...(n.else ?? [])], out);
      if (n.kind === 'slot') renderedBy(n.fallback ?? [], out);
    }
  };
  /** Whether running `roots` may write component state (or call unknown functions). */
  const writesState = (roots: Parameters<typeof runs>[0]) => {
    let found = false;
    runs(roots, (o, component) => {
      if (o.op === 'call-value') found = true;
      if (
        o.op === 'set' &&
        component !== undefined &&
        components[component].cells[o.cell as number].tracking !== 'none'
      )
        found = true;
    });
    return found;
  };

  /**
   * The code a listener passed in rest props runs: an inline function's
   * body, or (any other function value) a call with the event.
   */
  const bagRoot = (l: (typeof bagListeners)[number]) => {
    if (l.value.op === 'closure') {
      const f = lower.functions[l.value.function];
      return { body: f.body, component: f.component, locals: localsOf(f) };
    }
    return {
      body: [{ op: 'expr', value: { op: 'call-value', callee: l.value, args: [{ op: 'event' }] } }],
      component: l.k,
      locals: components[l.k].templateLocals ?? [],
    };
  };

  const checkEvents = () => {
    const written = new Map<
      string,
      { k: number; cell: number; handler: { event: HandlerEvent } }
    >();
    // Element listeners, and listeners passed in rest props.
    const listening = [
      ...components.flatMap((c, k) =>
        c.handlers.map(h => ({
          h: h as { event: HandlerEvent; source: Handler['source'] },
          root: handlerRoot(k, h),
        })),
      ),
      ...bagListeners.map(l => ({ h: l, root: bagRoot(l) })),
    ];
    // Change listeners of selects (the others are on checkboxes and radio buttons).
    const selectChanges = new Set<unknown>();
    const selects = (k: number, nodes: Node[]) => {
      for (const n of nodes) {
        if (n.kind === 'element') {
          if (n.tag === 'select')
            for (const l of n.listeners ?? [])
              if (l.event === 'change') selectChanges.add(components[k].handlers[l.handler]);
          selects(k, n.children ?? []);
        }
        if (n.kind === 'if') selects(k, [...n.then, ...(n.else ?? [])]);
        if (n.kind === 'each') selects(k, [...n.body, ...(n.else ?? [])]);
        if (n.kind === 'slot') selects(k, n.fallback ?? []);
        if (n.kind === 'component') for (const s of n.slots ?? []) selects(k, s.body);
      }
    };
    components.forEach((c, k) => selects(k, c.template));
    for (const { h, root } of listening) {
      const prop = propOf(h.event);
      let micro = false;
      let current = false;
      runs(
        [root],
        o => {
          const member = eventMember(o);
          if (member === 'stopImmediatePropagation')
            rejectEvent(
              h.source,
              "React's synthetic events have no stopImmediatePropagation(); use stopPropagation()",
            );
          if (
            ENTER_LEAVE.has(h.event) &&
            ['preventDefault', 'stopPropagation', 'target', 'value', 'checked'].includes(
              member ?? '',
            )
          )
            rejectEvent(
              h.source,
              `${prop} uses e.${member === 'value' || member === 'checked' ? 'target' : member}: React dispatches one synthetic ${h.event} event to all entered (or left) elements, whose target is the innermost one and whose propagation and cancellation span them, unlike the browser's events per element`,
            );
          if (
            h.event === 'scroll' &&
            (member === 'preventDefault' || member === 'defaultPrevented')
          )
            rejectEvent(
              h.source,
              `onScroll uses e.${member}: React's synthetic event reports itself prevented after preventDefault() although scroll events cannot be cancelled, which is unsupported`,
            );
          if (h.event === 'input' && (member === 'type' || member === 'preventDefault'))
            rejectEvent(
              h.source,
              `onChange of a text input reads e.${member}: React's change event comes from the input event (type "change"; preventDefault() marks it prevented though input events cannot be cancelled)`,
            );
          if (
            (h.event === 'focusin' || h.event === 'focusout') &&
            ['type', 'preventDefault', 'defaultPrevented'].includes(member ?? '')
          )
            rejectEvent(
              h.source,
              `${prop} uses e.${member}: React dispatches it from ${h.event} as a synthetic event of type "${h.event === 'focusin' ? 'focus' : 'blur'}" whose preventDefault() marks it prevented though focus events cannot be cancelled, which is unsupported`,
            );
          if (
            h.event === 'change' &&
            selectChanges.has(h) &&
            (member === 'preventDefault' || member === 'defaultPrevented')
          )
            rejectEvent(
              h.source,
              `onChange of a select uses e.${member}: React's synthetic event reports itself prevented after preventDefault() although change events cannot be cancelled, which is unsupported`,
            );
          if (
            h.event === 'change' &&
            !selectChanges.has(h) &&
            (member === 'preventDefault' || member === 'stopPropagation')
          )
            rejectEvent(
              h.source,
              `onChange of a checkbox or radio button calls e.${member}(): React applies it to the click that produced the change`,
            );
          if (member === 'currentTarget') current = true;
          if (o.op === 'builtin' && /^(microtask|promise)\./.test(o.name as string)) micro = true;
        },
        true,
      );
      if (current && micro)
        rejectEvent(
          h.source,
          'e.currentTarget in a handler that awaits or queues microtasks: React sets currentTarget to null when the listener returns, before microtasks run',
        );
      if (!CONTINUOUS.has(h.event)) continue;
      // Scroll events (M6): their updates render in a default-priority task
      // after the frame (schedule.continuous), or with an earlier discrete
      // update, as React's continuous lane does. A timer posted in the
      // listener runs before that render in Chromium, after it natively.
      if (h.event === 'scroll') {
        runs([root], o => {
          if (o.op === 'builtin' && /^(timer|flush)\./.test(o.name as string))
            rejectEvent(
              h.source,
              `${prop} schedules a timer: Chromium runs it before React renders the scroll update (a scheduler task after the frame), which is unsupported`,
            );
        });
        continue;
      }
      // Pointer and mouse continuous events: React renders their updates
      // after the input, or with the next discrete update (a click's press
      // after its move), while the IR renders after each dispatch. Supported
      // where the two agree: updates of state that is only rendered as text.
      runs([root], (o, component, locals) => {
        if (o.op === 'builtin' && /^(timer|microtask|promise|flush)\./.test(o.name as string))
          rejectEvent(
            h.source,
            `${prop} schedules a timer, microtask or promise: React renders updates from continuous events after the input (after such callbacks), which is unsupported`,
          );
        if (o.op === 'call-value') {
          const callee = o.callee as Expr;
          if (
            callee.op !== 'closure' &&
            !(callee.op === 'local' && locals[callee.local]?.name.endsWith('$fn'))
          )
            rejectEvent(
              h.source,
              `${prop} calls a function value (such as a callback prop): updates from continuous events are supported only for this component's state`,
            );
        }
        if (o.op === 'set' && component !== undefined) {
          const cell = o.cell as number;
          if (components[component].cells[cell].tracking !== 'none')
            written.set(`${component}:${cell}`, { k: component, cell, handler: h });
        }
      });
    }
    // State updated by continuous handlers: rendered as text only, so the
    // render's timing is not observable.
    for (const { k, cell, handler } of written.values()) {
      const c = components[k];
      const name = c.cells[cell].name;
      const text: Expr[] = [];
      const rest: unknown[] = [];
      templateExprs(c.template, text, rest);
      const fromText = new Set<number>();
      runs([{ body: text, component: k, locals: c.templateLocals ?? [] }], (o, component) => {
        if ((o.op === 'call' || o.op === 'closure') && component === k)
          fromText.add(o.function as number);
      });
      const roots = [
        { body: rest, component: k, locals: [] as Local[] },
        { body: c.cells.map(x => x.init), component: k, locals: [] as Local[] },
        ...(c.effects ?? []).map(e => ({ body: e.deps, component: k, locals: [] as Local[] })),
        ...c.handlers.map(h => handlerRoot(k, h)),
        // Functions not only used for text (closures may run anywhere).
        ...lower.functions
          .map((f, i) => ({ f, i }))
          .filter(({ f, i }) => f.component === k && !fromText.has(i))
          .map(({ f }) => ({ body: f.body, component: k, locals: localsOf(f) })),
      ];
      runs(roots, (o, component) => {
        if (o.op === 'cell' && o.cell === cell && o.read === 'snapshot' && component === k)
          throw new Diagnostic(
            'E_EVENT',
            `${name} is updated by ${propOf(handler.event)}, a continuous event whose updates React renders in a later scheduler task (after the input) or with the next click, while the IR renders after each event; such state may only be rendered as text (it is read elsewhere here)`,
            c.cells[cell].source,
          );
      });
      const subtree = new Set([k]);
      renderedBy(c.template, subtree);
      for (const s of subtree)
        for (const e of components[s].effects ?? [])
          if (e.deps.kind === 'always')
            throw new Diagnostic(
              'E_EVENT',
              `${components[s].name} has an effect without dependencies and renders with ${c.name}, whose state ${propOf(handler.event)} updates: React renders updates from continuous events after the input (or together with the next click), the IR after each event, so the effect would run a different number of times`,
              e.source,
            );
    }
    // Every function and handler: updaters, and window/document listeners.
    const everything = [
      ...components.flatMap((c, k) => c.handlers.map(h => handlerRoot(k, h))),
      ...lower.functions.map(f => ({ body: f.body, component: f.component, locals: localsOf(f) })),
    ];
    for (const root of everything) {
      let statement: Handler['source'];
      const visit = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (!n || typeof n !== 'object') return;
        const o = n as Obj;
        if (o.source && typeof o.op === 'string') statement = o.source as Handler['source'];
        if (
          o.op === 'set' &&
          (o.value as Obj).op === 'call-value' &&
          ((o.value as Obj).callee as Obj).op === 'closure'
        ) {
          const updater = ((o.value as Obj).callee as Obj).function as number;
          runs([{ body: lower.functions[updater].body, component: undefined, locals: [] }], x => {
            const member = eventMember(x);
            if (member === 'currentTarget' || member === 'defaultPrevented')
              rejectEvent(
                o.source as Handler['source'],
                `A state updater reads e.${member}: React may run updaters while rendering, after the event's dispatch`,
              );
          });
        }
        if (
          o.op === 'builtin' &&
          /^(window|document)\.listen$/.test(o.name as string) &&
          ['mousemove', 'pointermove', 'wheel', 'scroll', 'resize'].includes(
            ((o.args as Obj[])[0].value as string) ?? '',
          )
        )
          rejectEvent(
            statement,
            `${(o.name as string).split('.')[0]} listeners for ${(o.args as Obj[])[0].value} are unsupported in React apps (React renders updates from continuous events, scroll and resize among them, after the input or the rendering step; wheel listeners on the window and document are passive)`,
          );
        for (const v of Object.values(o)) visit(v);
      };
      visit(root.body);
    }
    // A cancelled checkbox click: React still runs onChange and keeps the
    // state it sets, while the browser reverts the box.
    const prevents = (root: Parameters<typeof runs>[0][number]) => {
      let found = false;
      runs(
        [root],
        o => {
          if (eventMember(o) === 'preventDefault') found = true;
        },
        true,
      );
      return found;
    };
    const cancels = (k: number, n: Node & { kind: 'element' }) =>
      (n.listeners ?? []).some(
        l => l.event === 'click' && prevents(handlerRoot(k, components[k].handlers[l.handler])),
      );
    const checkboxes = (k: number, nodes: Node[], seen = new Set<number>()): boolean =>
      nodes.some(n => {
        switch (n.kind) {
          case 'element':
            return (
              (n.tag === 'input' &&
                (n.props ?? []).some(p => p.name === 'checked') &&
                (n.listeners ?? []).some(
                  l =>
                    l.event === 'change' &&
                    writesState([handlerRoot(k, components[k].handlers[l.handler])]),
                )) ||
              checkboxes(k, n.children ?? [], seen)
            );
          case 'if':
            return checkboxes(k, [...n.then, ...(n.else ?? [])], seen);
          case 'each':
            return checkboxes(k, [...n.body, ...(n.else ?? [])], seen);
          case 'slot':
            return checkboxes(k, n.fallback ?? [], seen);
          case 'component': {
            const inSlots = (n.slots ?? []).some(s => checkboxes(k, s.body, seen));
            if (inSlots || seen.has(n.component)) return inSlots;
            seen.add(n.component);
            return checkboxes(n.component, components[n.component].template, seen);
          }
          default:
            return false;
        }
      });
    // A cancelled click on a radio button: React restores the group to its
    // state, then the browser checks the previously checked button again,
    // unchecking the rest of the group; the IR does not uncheck the group
    // when it reverts, so a cancelling click handler must not change state.
    const radios = (k: number, nodes: Node[], seen = new Set<number>()): boolean =>
      nodes.some(n => {
        switch (n.kind) {
          case 'element':
            return (
              (n.tag === 'input' &&
                (n.attrs ?? []).some(
                  a => a.name === 'type' && a.value.op === 'lit' && a.value.value === 'radio',
                )) ||
              radios(k, n.children ?? [], seen)
            );
          case 'if':
            return radios(k, [...n.then, ...(n.else ?? [])], seen);
          case 'each':
            return radios(k, [...n.body, ...(n.else ?? [])], seen);
          case 'slot':
            return radios(k, n.fallback ?? [], seen);
          case 'component': {
            const inSlots = (n.slots ?? []).some(s => radios(k, s.body, seen));
            if (inSlots || seen.has(n.component)) return inSlots;
            seen.add(n.component);
            return radios(n.component, components[n.component].template, seen);
          }
          default:
            return false;
        }
      });
    const cancelsWriting = (k: number, n: Node & { kind: 'element' }) =>
      (n.listeners ?? []).some(l => {
        const root = handlerRoot(k, components[k].handlers[l.handler]);
        return l.event === 'click' && prevents(root) && writesState([root]);
      });
    const visitElements = (k: number, nodes: Node[]) => {
      for (const n of nodes) {
        if (n.kind === 'element') {
          if (cancels(k, n) && checkboxes(k, [n]))
            throw new Diagnostic(
              'E_EVENT',
              'A click handler here may cancel the click on a checkbox or radio button whose onChange updates state: React still runs onChange (and keeps that state) while the browser reverts the click, which is unsupported; ignore the change in onChange instead',
              n.source,
            );
          if (cancelsWriting(k, n) && radios(k, [n]))
            throw new Diagnostic(
              'E_EVENT',
              'A click handler here may cancel the click on a radio button and updates state: the browser then checks the previously checked button again after React restored the group, which is unsupported',
              n.source,
            );
          visitElements(k, n.children ?? []);
        }
        if (n.kind === 'if') visitElements(k, [...n.then, ...(n.else ?? [])]);
        if (n.kind === 'each') visitElements(k, [...n.body, ...(n.else ?? [])]);
        if (n.kind === 'slot') visitElements(k, n.fallback ?? []);
        if (n.kind === 'component') for (const s of n.slots ?? []) visitElements(k, s.body);
      }
    };
    components.forEach((c, k) => visitElements(k, c.template));
    // A click listener in rest props may reach any element with a spread, and
    // children content around it: rejected if it cancels and the program has
    // such a checkbox.
    const cancelling = bagListeners.find(l => l.event === 'click' && prevents(bagRoot(l)));
    if (cancelling && components.some((c, k) => checkboxes(k, c.template)))
      rejectEvent(
        cancelling.source,
        'A click handler in rest props may cancel the click on a checkbox or radio button whose onChange updates state: React still runs onChange (and keeps that state) while the browser reverts the click, which is unsupported; ignore the change in onChange instead',
      );
    const writing = bagListeners.find(
      l => l.event === 'click' && prevents(bagRoot(l)) && writesState([bagRoot(l)]),
    );
    if (writing && components.some((c, k) => radios(k, c.template)))
      rejectEvent(
        writing.source,
        'A click handler in rest props may cancel the click on a radio button and updates state: the browser then checks the previously checked button again after React restored the group, which is unsupported',
      );
  };

  /**
   * A picked option dispatches input, then change; React restores a
   * controlled select after the change only, while the IR restores after
   * every event that runs listeners. Window and document input listeners
   * would see that restore (and the change event the restored value), so
   * they are rejected in programs with controlled selects.
   */
  const checkSelectInput = () => {
    const controlled = (nodes: Node[]): boolean =>
      nodes.some(n => {
        switch (n.kind) {
          case 'element':
            return (
              (n.tag === 'select' && (n.props ?? []).some(p => p.name === 'selectValue')) ||
              controlled(n.children ?? [])
            );
          case 'if':
            return controlled([...n.then, ...(n.else ?? [])]);
          case 'each':
            return controlled([...n.body, ...(n.else ?? [])]);
          case 'slot':
            return controlled(n.fallback ?? []);
          case 'component':
            return (n.slots ?? []).some(s => controlled(s.body));
          default:
            return false;
        }
      });
    if (!components.some(c => controlled(c.template))) return;
    const roots = [
      ...components.flatMap((c, k) => c.handlers.map(h => handlerRoot(k, h))),
      ...lower.functions.map(f => ({ body: f.body, component: f.component, locals: localsOf(f) })),
      ...components.flatMap((c, k) =>
        c.cells.map(x => ({ body: x.init, component: k, locals: [] as Local[] })),
      ),
    ];
    for (const root of roots) {
      let statement: Handler['source'];
      const visit = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (!n || typeof n !== 'object') return;
        const o = n as Obj;
        if (o.source && typeof o.op === 'string') statement = o.source as Handler['source'];
        if (
          o.op === 'builtin' &&
          /^(window|document)\.listen$/.test(o.name as string) &&
          (o.args as Obj[])[0]?.value === 'input'
        )
          rejectEvent(
            statement,
            `${(o.name as string).split('.')[0]} input listeners in a program with controlled selects are unsupported: React restores a select after its change event only, the IR after every event with listeners`,
          );
        for (const v of Object.values(o)) visit(v);
      };
      visit(root.body);
    }
  };

  /**
   * Script `focus()` and `blur()` run the focus listeners nested in the call.
   * React DOM gives updates from focusin and focusout (discrete events) the
   * sync lane: inside a discrete event handler they render with the
   * handler's own updates, as the IR models (case focus). Called from
   * effects, timers, promises or continuous events, React renders them
   * apart from the caller's (react-dom 19.3: sync work is flushed at the end
   * of passive effects or in a microtask, other lanes later), which the IR
   * does not model. With focus listeners in the program, focus() and blur()
   * are therefore supported in discrete event handlers and in functions
   * that only such handlers call.
   */
  const checkFocusCalls = () => {
    const kinds = ['focus', 'blur', 'focusin', 'focusout'];
    let listened =
      components.some(c => c.handlers.some(h => kinds.includes(h.event))) ||
      bagListeners.some(l => kinds.includes(l.event));
    const scan = (n: unknown, f: (o: Obj) => void) => {
      if (Array.isArray(n)) return n.forEach(x => scan(x, f));
      if (!n || typeof n !== 'object') return;
      f(n as Obj);
      for (const v of Object.values(n as Obj)) scan(v, f);
    };
    scan([lower.functions, lower.globals, components], o => {
      if (
        o.op === 'builtin' &&
        /^(window|document)\.listen$/.test(o.name as string) &&
        kinds.includes(((o.args as Obj[])[0].value as string) ?? '')
      )
        listened = true;
    });
    if (!listened) return;
    // Functions every use of which is a direct call from a discrete handler
    // or from another such function (a greatest fixpoint).
    const discreteClosures = new Set<unknown>(
      bagListeners.filter(l => !CONTINUOUS.has(l.event)).map(l => l.value),
    );
    /** References to functions: [function, container (-1: a discrete handler, -2: elsewhere)]. */
    const uses: [number, number][] = [];
    const collect = (n: unknown, container: number) =>
      scan(n, o => {
        if (o.op === 'call') uses.push([o.function as number, container]);
        if (o.op === 'closure')
          uses.push([o.function as number, discreteClosures.has(o) ? -1 : -2]);
      });
    components.forEach(c => {
      for (const h of c.handlers) collect(h.body, CONTINUOUS.has(h.event) ? -2 : -1);
      collect([c.template, c.cells.map(x => x.init), c.effects ?? []], -2);
      for (const e of c.effects ?? []) uses.push([e.run, -2]);
    });
    collect(lower.globals, -2);
    lower.functions.forEach((f, i) => collect(f.body, i));
    const ok = lower.functions.map(() => true);
    for (let changed = true; changed;) {
      changed = false;
      for (const [fn, container] of uses)
        if (ok[fn] && (container === -2 || (container >= 0 && !ok[container]))) {
          ok[fn] = false;
          changed = true;
        }
    }
    const reject = (source: Handler['source']): never =>
      rejectEvent(
        source,
        "focus() and blur() outside event handlers (in effects, timers, promises or continuous events) are unsupported in a program with focus listeners: React renders the updates of the focus listeners they run apart from the caller's",
      );
    const check = (n: unknown, source: Handler['source']) => {
      let statement = source;
      scan(n, o => {
        if (o.source && typeof o.op === 'string') statement = o.source as Handler['source'];
        if (o.op === 'builtin' && (o.name === 'element.focus' || o.name === 'element.blur'))
          reject(statement);
      });
    };
    lower.functions.forEach((f, i) => {
      if (!ok[i]) check(f.body, f.source);
    });
    components.forEach(c => {
      for (const h of c.handlers) if (CONTINUOUS.has(h.event)) check(h.body, h.source);
      check([c.template, c.cells.map(x => x.init)], undefined);
    });
    check(lower.globals, undefined);
  };

  /**
   * React creates component functions on every render: an `addEventListener`
   * and the `removeEventListener` meant to undo it agree only within one
   * render. The IR creates one object per invocation of the function around
   * the use (`hoistFunctionValues`), so window and document listeners that
   * are component functions are supported when one effect (with its cleanup)
   * adds and removes them.
   */
  const checkListenerIdentity = () => {
    for (const { decl } of componentDecls.values()) {
      const uses = new Map<number, Set<ts.Node>>();
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          ['addEventListener', 'removeEventListener'].includes(n.expression.name.text) &&
          ts.isIdentifier(n.expression.expression) &&
          ['window', 'document'].includes(n.expression.expression.text) &&
          !lower.binding(n.expression.expression)
        ) {
          const listener = n.arguments[1] && skipParens(n.arguments[1]);
          const b = listener && ts.isIdentifier(listener) ? lower.binding(listener) : undefined;
          if (b?.kind === 'function' && !b.stable) {
            // The outermost function around the call inside the component.
            let root: ts.Node | undefined;
            for (let p: ts.Node = n.parent; p && p !== decl; p = p.parent)
              if (ts.isFunctionLike(p)) root = p;
            const effect =
              root &&
              root.parent &&
              ts.isCallExpression(root.parent) &&
              root.parent.arguments[0] === root &&
              ['useEffect', 'useLayoutEffect'].includes(
                reactFunction(root.parent.expression) ?? '',
              );
            if (!effect)
              fail(
                n,
                'E_EVENT',
                `${listener.getText()} is created on every render: add and remove it as a listener in one effect (and its cleanup), or define the listener in the effect`,
              );
            if (!uses.has(b.fn)) uses.set(b.fn, new Set());
            uses.get(b.fn)!.add(root!);
            if (uses.get(b.fn)!.size > 1)
              fail(
                n,
                'E_EVENT',
                `${listener.getText()} is created on every render and added or removed by several effects, whose renders may differ; add and remove it in one effect`,
              );
          }
        }
        ts.forEachChild(n, visit);
      };
      if (decl.body) visit(decl.body);
    }
  };

  const rootIndex = instantiate(app!, new Map(), rendered);
  for (const c of components[rootIndex].cells)
    if (c.prop && isRequired(c.init))
      fail(rendered, 'E_BOOTSTRAP', `The root component requires the prop ${c.prop}`);
  for (const s of slotsOf[rootIndex])
    if (s.required)
      fail(rendered, 'E_BOOTSTRAP', `The root component requires the render prop ${s.name}`);
  lower.settleFunctionValues();
  checkListenerIdentity();
  checkEvents();
  checkFocusCalls();
  checkDependencies();
  checkUnmountOrder();
  checkChildrenEffects();
  checkRenderRefs();
  checkRadioGroups(components, rootIndex);
  checkSelectInput();
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
      mappings: packMappings(lower),
    },
    ...(graph.config.renderer ? { renderer: graph.config.renderer } : {}),
    capabilities,
    // React DOM restores the focused element after each commit.
    restoreFocus: true,
    // One delegated root listener; discrete events render in a microtask,
    // other updates in a scheduler task; onChange of checkboxes comes from
    // the click (docs/design/M4-ORDERING.md §2). A commit runs all cleanups
    // of a phase before its effects; state set by passive effects (or their
    // cleanups) renders in a later scheduler task, state set by layout
    // effects re-renders synchronously in the same flush; the initial render
    // commits in a scheduler task. Cleanups close over their own render.
    schedule: {
      flush: 'event-microtask',
      changeWithClick: true,
      controlledRestore: true,
      // React DOM disables its event system while it commits.
      commitEventsIgnored: true,
      cleanups: 'batched',
      postWritesDeferred: true,
      mount: 'task',
      // Updates from scroll events render in a scheduler task after the
      // frame (continuous priority), or with an earlier discrete update.
      continuous: ['scroll'],
    },
    styles: {
      css: graph.css,
      assets: graph.assets,
      ...(graph.styleGuards ? { guards: graph.styleGuards } : {}),
    },
    records: types.records,
    functions: lower.functions,
    globals: lower.globals,
    components,
    root: rootIndex,
  };
  lower.checkStyleSpreads(ir);
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  return { ir };
}

const propertyName = (n: ts.PropertyName): string =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText();

/** Widen an initial value to the cell type (T → Maybe<T>). */
function coerceInit(v: Expr, from: Type, to: Type, records: RecordType[]): Expr {
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

export type { Type };
