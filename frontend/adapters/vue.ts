// Vue 3.5 <script setup> adapter on the shared language layer
// (docs/design/M2-VALUES.md, docs/design/M3-COMPONENTS.md). Framework
// semantics only:
// - ref → deep-tracked cell read/written through `.value`; computed → derived;
//   reads observe earlier writes immediately;
// - templates unwrap refs (typed through a synthetic template function);
// - interpolation follows toDisplayString; bindings follow Vue 3 attribute
//   coercion; inline handlers are statements with `$event`;
// - child SFCs → component instances (children first); `defineProps<T>()`
//   (destructured or as an object, optionally `withDefaults`) → prop cells;
//   `defineEmits<T>()` → function-typed `on<Event>` prop cells that default to
//   a no-op; `defineModel<T>()` → a prop cell written through `.value`, bound
//   by the parent's `v-model`; `v-for` → lists;
// - `<slot>` outlets → slot nodes with fallbacks (props typed by
//   `defineSlots<T>()` or inferred from the outlets); `<template #name>` and
//   default content → parent-owned slot bodies with destructured slot props;
// - checkboxes: `:checked` / `v-model` → the live checked property, `@change`
//   (vModelCheckbox listens first); listeners of one event on an element
//   (`@click` and `@click.self`) run in order in one handler;
// - element listeners take the event object (`$event`, method handlers, arrow
//   functions); event modifiers follow compiler-dom and runtime-dom
//   (withModifiers guards, withKeys on keyboard events, `@click.right` →
//   contextmenu, `@click.middle` → mouseup); listener options are rejected;
// - templates see setup bindings and Vue's allowed globals only;
// - template refs: `ref="name"` on an element binds a `ref()`/`shallowRef()`
//   variable of that name or a `useTemplateRef('name')` to an element cell
//   (set when the element mounts, null when it unmounts). Vue sets them in the
//   post flush and re-renders readers, so they may be read in handlers and
//   template text only. On a component, the ref is the instance: a record of
//   the element template ref the child exposes (`defineExpose({ input })`);
// - fallthrough attributes: what a parent passes beyond the declared props,
//   emits and models is the child's attrs (an attribute bag, rest props),
//   applied to its single root (unless `inheritAttrs: false`) and where it
//   binds `v-bind="$attrs"` (or the `useAttrs()` object), merged with the
//   element's own attributes as `mergeProps` does (class values join);
// - `:class` objects, arrays and strings with a static `class` → the string
//   normalizeClass builds (Vue sets className); `:style` objects, arrays and
//   strings with a static `style` → the IR's `replace` inline style
//   (runtime-dom patchStyle), static styles of content the compiler
//   stringifies → their HTML text;
// - text inputs and text areas with `:value` or `v-model` → a value Vue
//   patches at every re-render, through a render effect reading what the
//   template reads (`restore: render`); `<label>`, focus events.
import ts from 'typescript';
import path from 'node:path';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type {
  AttrItem,
  Cell,
  Effect,
  Component,
  Expr,
  Fn,
  Handler,
  Listener,
  Local,
  Node,
  Program,
  Stmt,
  Type,
  RecordType,
  StyleGuard,
} from '../ir.ts';
import { EVENT_KINDS } from '../ir.ts';
import {
  FnBuilder,
  Lowerer,
  isAssignmentOperator,
  remapLocals,
  skipParens,
  type HandlerEvent,
  type Hooks,
} from '../language.ts';
import { createProgram, VUE } from '../program.ts';
import { sameType, TypeMapper } from '../types.ts';
import { lowerModules } from '../modules.ts';
import { bindPackImport, packMappings, type Edge } from '../packs.ts';
import { arrayElement, maybeInner, upcastTo } from '../irtype.ts';
import { checkRadioGroups, checkSelectChildren } from '../controls.ts';
import { INERT_TAGS, TABLE_TAGS } from '../elements.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VNode = any;

const TAGS = new Set([
  ...TABLE_TAGS,
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
  // Inline SVG (runic-ir's SVG_TAGS): runtime-dom sets their attributes and
  // class with setAttribute (patchAttr, patchClass).
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
  ...INERT_TAGS,
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
const MACROS = new Set([
  'defineProps',
  'withDefaults',
  'defineEmits',
  'defineModel',
  'defineSlots',
  'defineOptions',
  'defineExpose',
]);
/**
 * Fallthrough attributes (runtime-dom patchProp): runtime-dom's special
 * boolean attributes, present when the value is truthy or ''.
 */
const SPECIAL_BOOLEAN_ATTRS = new Set([
  'itemscope',
  'allowfullscreen',
  'formnovalidate',
  'ismap',
  'nomodule',
  'novalidate',
  'readonly',
]);
/**
 * Boolean DOM properties of the supported tags (`'*'`: every element), which
 * runtime-dom sets as properties (`''` → true); other attributes are set as
 * text, so `false` becomes "false".
 */
const BOOLEAN_PROPS: Record<string, string[]> = {
  '*': ['hidden', 'autofocus', 'inert'],
  button: ['disabled'],
  input: ['disabled', 'required', 'multiple'],
  ol: ['reversed'],
};
/** Lowercase DOM properties whose value is not the attribute text (live state, numbers). */
const UNREFLECTED_PROPS: Record<string, string[]> = {
  '*': ['value', 'checked', 'indeterminate', 'nonce'],
  input: ['size', 'width', 'height'],
  ol: ['start'],
};
/** Watchers and lifecycle hooks lowered to effects (docs/design/M4-EFFECTS.md). */
const LIFECYCLE = new Set([
  'watch',
  'watchEffect',
  'onBeforeMount',
  'onMounted',
  'onBeforeUnmount',
  'onUnmounted',
]);
/** Vue exports with no lowering yet, and why. */
const UNSUPPORTED_VUE: Record<string, string> = {
  onBeforeUpdate:
    'onBeforeUpdate is planned for a later milestone (it runs per component render, which Runic does not model yet)',
  onUpdated:
    'onUpdated is planned for a later milestone (post-flush hooks run in insertion order, which Runic does not model yet)',
  watchPostEffect:
    "watchPostEffect (flush: 'post') is planned for a later milestone (post watchers run in insertion order)",
  watchSyncEffect:
    "watchSyncEffect (flush: 'sync') is planned for a later milestone (it runs inside every write)",
  onErrorCaptured: 'onErrorCaptured is planned for a later milestone',
  onActivated: 'onActivated is planned with KeepAlive',
  onDeactivated: 'onDeactivated is planned with KeepAlive',
  onRenderTracked: 'onRenderTracked is a development hook and unsupported',
  onRenderTriggered: 'onRenderTriggered is a development hook and unsupported',
  onServerPrefetch: 'onServerPrefetch is server-side only',
};
const CLEANUP: Type = { fn: { params: [], result: 'void' } };
const L = (i: number): Expr => ({ op: 'local', local: i });
/** runtime-dom withKeys aliases (`.esc` → `escape`, …). */
const KEY_NAMES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  up: 'arrow-up',
  left: 'arrow-left',
  right: 'arrow-right',
  down: 'arrow-down',
  delete: 'backspace',
};
/** compiler-dom's runtime guards (withModifiers); `left`/`right` too except on keyboard events. */
const NON_KEY_MODIFIERS = new Set([
  'stop',
  'prevent',
  'self',
  'ctrl',
  'shift',
  'alt',
  'meta',
  'exact',
  'middle',
]);
/** compiler-dom's listener options (addEventListener options, not guards). */
const OPTION_MODIFIERS = new Set(['passive', 'once', 'capture']);
const SYSTEM_MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'];
const KEYBOARD_EVENTS = new Set(['keydown', 'keyup']);
/** Events whose objects are MouseEvents (they have `button` and the modifier keys). */
const MOUSE_EVENTS = new Set([
  'click',
  'dblclick',
  'contextmenu',
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerenter',
  'pointerleave',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseenter',
  'mouseleave',
  'mouseover',
  'mouseout',
  'pointerover',
  'pointerout',
  'wheel',
]);
const FOCUS_EVENTS = new Set(['focus', 'blur', 'focusin', 'focusout']);
/** The DOM interface (frontend/dom.d.ts) of an event's object, typing `$event`. */
const eventInterface = (event: string): string =>
  KEYBOARD_EVENTS.has(event)
    ? 'KeyboardEvent'
    : event === 'wheel'
      ? 'WheelEvent'
      : event.startsWith('pointer')
        ? 'PointerEvent'
        : MOUSE_EVENTS.has(event)
          ? 'MouseEvent'
          : FOCUS_EVENTS.has(event)
            ? 'FocusEvent'
            : 'Event';
/** Globals Vue templates can read (@vue/shared GLOBALS_ALLOWED); others resolve on the instance. */
const TEMPLATE_GLOBALS = new Set(
  'Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI,decodeURIComponent,encodeURI,encodeURIComponent,Math,Number,Date,Array,Object,Boolean,String,RegExp,Map,Set,JSON,Intl,BigInt,console,Error,Symbol'.split(
    ',',
  ),
);
// compiler-core node types
const ELEMENT = 1;
const TEXT = 2;
const COMMENT = 3;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;
// compiler-core element tag types
const PLAIN = 0;
const COMPONENT_TAG = 1;
const SLOT_TAG = 2;

interface Graph {
  root: string;
  entry: string;
  hash: string;
  css: string;
  styleGuards?: StyleGuard[];
  assets: { path: string; sha256: string; bytes: number; mime: string }[];
  manifest: unknown;
  config: { title: string; renderer?: 'cpu' | 'gpu' };
  modules: Map<string, { code: string; imports: Edge[] }>;
  tooling: {
    packages: Record<string, string>;
    compiler: {
      parse: (src: string, opts: object) => { descriptor: VNode; errors: unknown[] };
      compileScript: (descriptor: VNode, opts: object) => { bindings?: object };
      compileTemplate: (opts: object) => { ast?: VNode; errors: unknown[] };
    };
  };
}

type Source = { file: string; line: number; column: number };

function locate(text: string, offset: number, file: string): Source {
  const lines = text.slice(0, offset).split('\n');
  return { file, line: lines.length, column: lines.at(-1)!.length + 1 };
}

const camelize = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hyphenate = (s: string) => s.replace(/\B([A-Z])/g, '-$1').toLowerCase();
/** The prop that carries a listener for `event` (`remove` → `onRemove`). */
const handlerKey = (event: string) => 'on' + capitalize(camelize(event));
/** Vue's method-handler test: a member path is called with the event arguments. */
const isSimplePath = (code: string) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(code.trim());
/** Vue's function-expression test (`fnExpRE`). */
const isFunctionExpression = (code: string) =>
  /^\s*(async\s*)?(\([^)]*?\)|[\w$_]+)\s*(:[^=]+)?=>|^\s*(async\s+)?function(?:\s+[\w$]+)?\s*\(/.test(
    code,
  );

/** Props, emits and models a component declares (from its script syntax). */
interface Macros {
  props?: {
    /** Type argument text of defineProps (resolves in the component's module). */
    typeText: string;
    names: string[];
    /** `const props = defineProps<T>()`: the variable. */
    variable?: string;
  };
  emits?: {
    typeText: string;
    variable?: string;
    events: { key: string; params: string; arity: number }[];
  };
  models: { prop: string; typeText: string; nullable: boolean }[];
  /** `defineSlots<T>()`: its type argument (without it, slot props are inferred). */
  slots?: { typeText: string };
  /** `defineOptions({ inheritAttrs: false })`. */
  inheritAttrs: boolean;
  /** `const attrs = useAttrs()`: the variable. */
  attrsVar?: string;
  /** `defineExpose({ key: ref })`: exposed template refs. */
  expose?: { key: string; name: string; at: Source }[];
  /** Top-level setup names the template can see (refs unwrapped). */
  topNames: string[];
}

/** An SFC and its virtual TypeScript module. */
interface Unit {
  file: string;
  rel: string;
  original: string;
  descriptor: VNode;
  index: number;
  virtual: string;
  synthetic: string;
  scriptLength: number;
  scriptStart: number;
  segments: { synth: number; orig: number; length: number }[];
  /** Synthetic [start, end) of each template expression (keyed by AST node). */
  starts: Map<object, [number, number]>;
  /** Child components by local name. */
  children: Map<string, string>;
  macros: Macros;
  /** Elements that stay virtual nodes in the development and production builds (by offset). */
  vnodeElements?: [Set<number>, Set<number>];
}

/** Members of a props/emits type: a type literal, intersection or local interface/alias. */
function typeMembers(
  sf: ts.SourceFile,
  node: ts.TypeNode,
  fail: (n: ts.Node, message: string) => never,
): ts.TypeElement[] {
  if (ts.isTypeLiteralNode(node)) return [...node.members];
  if (ts.isParenthesizedTypeNode(node)) return typeMembers(sf, node.type, fail);
  if (ts.isIntersectionTypeNode(node)) return node.types.flatMap(t => typeMembers(sf, t, fail));
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments)
    return namedMembers(sf, node.typeName.text, node, fail);
  return fail(
    node,
    'Declare the type as a type literal or a local interface/type alias (imported types are planned for later)',
  );
}

function namedMembers(
  sf: ts.SourceFile,
  name: string,
  at: ts.Node,
  fail: (n: ts.Node, message: string) => never,
): ts.TypeElement[] {
  for (const s of sf.statements) {
    if (ts.isInterfaceDeclaration(s) && s.name.text === name && !s.typeParameters) {
      const inherited = (s.heritageClauses ?? []).flatMap(h =>
        h.types.flatMap(t =>
          ts.isIdentifier(t.expression) && !t.typeArguments
            ? namedMembers(sf, t.expression.text, t, fail)
            : fail(t, 'Interfaces may extend only local interfaces'),
        ),
      );
      return [...inherited, ...s.members];
    }
    if (ts.isTypeAliasDeclaration(s) && s.name.text === name && !s.typeParameters)
      return typeMembers(sf, s.type, fail);
  }
  return fail(
    at,
    'Declare the type as a type literal or a local interface/type alias (imported types are planned for later)',
  );
}

function memberName(m: ts.TypeElement): string | undefined {
  const n = m.name;
  if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n))) return n.text;
  return undefined;
}

export async function lowerVue(graph: Graph): Promise<{ ir: Program }> {
  const { root } = graph;
  const fail = (code: string, message: string, source?: Source): never => {
    throw new Diagnostic(code, message, source);
  };
  const rel = (f: string) => path.relative(root, f);

  // --- Bootstrap: createApp(App).mount('#root') ---
  const entry = ts.createSourceFile(
    graph.entry,
    graph.modules.get(graph.entry)!.code,
    ts.ScriptTarget.Latest,
    true,
  );
  let rootFile: string | undefined;
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
    rootFile = local.get(create.arguments[0].text);
  if (!rootFile || mount!.name.text !== 'mount')
    fail('E_BOOTSTRAP', 'Expected createApp(App).mount("#root")');

  // --- Components: parse and analyse each SFC (children first) ---
  const units = new Map<string, Unit>();
  const order: Unit[] = [];
  const parse = (file: string, from?: Source): Unit => {
    const original = graph.modules.get(file)?.code;
    if (original === undefined)
      return fail('E_IMPORT', `Component ${rel(file)} was not collected`, from);
    const fileRel = rel(file);
    const { descriptor, errors } = graph.tooling.compiler.parse(original, { filename: file });
    if (errors.length) fail('E_PARSE', String(errors[0]), { file: fileRel, line: 1, column: 1 });
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
        { file: fileRel, line: 1, column: 1 },
      );
    if (descriptor.scriptSetup.attrs?.generic)
      fail(
        'E_SFC',
        'Generic components are planned for a later milestone',
        locate(original, descriptor.scriptSetup.loc.start.offset, fileRel),
      );
    const script: string = descriptor.scriptSetup.content;
    const scriptStart: number = descriptor.scriptSetup.loc.start.offset;
    const sf = ts.createSourceFile(file + '.ts', script, ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node) => locate(original, scriptStart + n.getStart(sf), fileRel);
    const synFail =
      (code: string) =>
      (n: ts.Node, message: string): never =>
        fail(code, message, at(n));
    const text = (n: ts.Node) => script.slice(n.getStart(sf), n.end);
    const macroOf = (e: ts.Expression | undefined) => {
      const c = e && skipParens(e);
      return c &&
        ts.isCallExpression(c) &&
        ts.isIdentifier(c.expression) &&
        MACROS.has(c.expression.text)
        ? { name: c.expression.text, call: c }
        : undefined;
    };
    const children = new Map<string, string>();
    const macros: Macros = { models: [], topNames: [], inheritAttrs: true };
    const options = (call: ts.CallExpression) => {
      const arg = call.arguments[0] && skipParens(call.arguments[0]);
      if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(arg))
        return fail('E_OPTIONS', 'defineOptions takes an object literal', at(call));
      for (const p of arg.properties) {
        const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
        const v = ts.isPropertyAssignment(p) ? p.initializer.kind : undefined;
        if (
          key !== 'inheritAttrs' ||
          (v !== ts.SyntaxKind.TrueKeyword && v !== ts.SyntaxKind.FalseKeyword)
        )
          fail(
            'E_OPTIONS',
            'defineOptions supports inheritAttrs: true or false (other options are planned for later)',
            at(p),
          );
        macros.inheritAttrs = v === ts.SyntaxKind.TrueKeyword;
      }
    };
    const expose = (call: ts.CallExpression) => {
      if (macros.expose) fail('E_EXPOSE', 'defineExpose may be called once', at(call));
      const arg = call.arguments[0] && skipParens(call.arguments[0]);
      if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(arg))
        return fail('E_EXPOSE', 'defineExpose takes an object literal', at(call));
      macros.expose = arg.properties.map(p => {
        if (ts.isShorthandPropertyAssignment(p))
          return { key: p.name.text, name: p.name.text, at: at(p) };
        if (
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          ts.isIdentifier(p.initializer)
        )
          return { key: p.name.text, name: p.initializer.text, at: at(p) };
        return fail(
          'E_EXPOSE',
          'defineExpose supports template refs by name ({ input } or { el: input })',
          at(p),
        );
      });
    };
    const props = (call: ts.CallExpression, variable?: ts.BindingName) => {
      if (macros.props) fail('E_PROPS', 'defineProps may be called once', at(call));
      let define = call;
      if ((call.expression as ts.Identifier).text === 'withDefaults') {
        const inner = call.arguments[0] && macroOf(call.arguments[0]);
        if (inner?.name !== 'defineProps')
          fail('E_PROPS', 'withDefaults wraps defineProps<T>()', at(call));
        if (!variable) fail('E_PROPS', 'Assign withDefaults(...) to a variable', at(call));
        if (ts.isObjectBindingPattern(variable!))
          fail(
            'E_PROPS',
            'withDefaults with destructured props is invalid in Vue; use destructure defaults',
            at(call),
          );
        define = inner!.call;
      }
      const typeArg = define.typeArguments?.[0];
      if (!typeArg || define.arguments.length)
        fail(
          'E_PROPS',
          'Declare props with a type: defineProps<{ ... }>() (runtime declarations are unsupported)',
          at(define),
        );
      const names: string[] = [];
      for (const m of typeMembers(sf, typeArg!, synFail('E_PROPS'))) {
        const name = memberName(m);
        if (!name || !(ts.isPropertySignature(m) || ts.isMethodSignature(m)))
          fail('E_PROPS', 'Props must be named properties', at(m));
        names.push(name!);
      }
      macros.props = {
        typeText: text(typeArg!),
        names,
        ...(variable && ts.isIdentifier(variable) ? { variable: variable.text } : {}),
      };
    };
    const emits = (call: ts.CallExpression, variable?: ts.BindingName) => {
      if (macros.emits) fail('E_EMITS', 'defineEmits may be called once', at(call));
      const typeArg = call.typeArguments?.[0];
      if (!typeArg || call.arguments.length)
        fail(
          'E_EMITS',
          'Declare emits with a type: defineEmits<{ remove: [id: number] }>() (runtime declarations are unsupported)',
          at(call),
        );
      if (variable && !ts.isIdentifier(variable))
        fail(
          'E_EMITS',
          'Assign defineEmits to a variable: const emit = defineEmits<…>()',
          at(call),
        );
      const events: { key: string; params: string; arity: number }[] = [];
      const add = (event: string, params: string[], where: ts.Node) => {
        const key = handlerKey(event);
        if (events.some(e => e.key === key))
          fail(
            'E_EMITS',
            `Event ${event} is declared twice (overloads are unsupported)`,
            at(where),
          );
        events.push({ key, params: `(${params.join(', ')})`, arity: params.length });
      };
      for (const m of typeMembers(sf, typeArg!, synFail('E_EMITS'))) {
        if (ts.isCallSignatureDeclaration(m)) {
          const [first, ...rest] = m.parameters;
          const t = first?.type;
          const literals = t && ts.isUnionTypeNode(t) ? t.types : t ? [t] : [];
          const names = literals.map(l =>
            ts.isLiteralTypeNode(l) && ts.isStringLiteral(l.literal) ? l.literal.text : undefined,
          );
          if (!names.length || names.some(n => n === undefined))
            fail(
              'E_EMITS',
              "Emit signatures start with the event name: (e: 'remove', …): void",
              at(m),
            );
          for (const p of rest)
            if (!p.type || p.dotDotDotToken)
              fail(
                'E_EMITS',
                'Emit parameters need a type (rest parameters are unsupported)',
                at(p),
              );
          for (const n of names) add(n!, rest.map(text), m);
        } else if (
          ts.isPropertySignature(m) &&
          memberName(m) &&
          m.type &&
          ts.isTupleTypeNode(m.type)
        ) {
          const params = m.type.elements.map((el, i) => {
            if (ts.isNamedTupleMember(el)) {
              if (el.dotDotDotToken) fail('E_EMITS', 'Rest emit arguments are unsupported', at(el));
              return `${el.name.text}${el.questionToken ? '?' : ''}: ${text(el.type)}`;
            }
            if (ts.isRestTypeNode(el))
              return fail('E_EMITS', 'Rest emit arguments are unsupported', at(el));
            if (ts.isOptionalTypeNode(el)) return `a${i}?: ${text(el.type)}`;
            return `a${i}: ${text(el)}`;
          });
          add(memberName(m)!, params, m);
        } else
          fail(
            'E_EMITS',
            "Declare each event as `name: [arg: T]` or `(e: 'name', arg: T): void`",
            at(m),
          );
      }
      macros.emits = {
        typeText: text(typeArg!),
        ...(variable ? { variable: (variable as ts.Identifier).text } : {}),
        events,
      };
    };
    const model = (call: ts.CallExpression, variable: ts.BindingName) => {
      if (!ts.isIdentifier(variable))
        fail(
          'E_MODEL',
          'Assign defineModel to a variable: const model = defineModel<T>()',
          at(call),
        );
      const typeArg = call.typeArguments?.[0];
      if (!typeArg)
        fail('E_MODEL', 'defineModel needs a type argument: defineModel<string>()', at(call));
      let [nameArg, options] = call.arguments;
      if (nameArg && !ts.isStringLiteral(nameArg)) [nameArg, options] = [undefined!, nameArg];
      const prop = nameArg ? (nameArg as ts.StringLiteral).text : 'modelValue';
      if (macros.models.some(m => m.prop === prop))
        fail('E_MODEL', `Model ${prop} is declared twice`, at(call));
      let nullable = true;
      if (options) {
        if (!ts.isObjectLiteralExpression(options))
          fail('E_MODEL', 'defineModel options must be an object literal', at(options));
        for (const p of (options as ts.ObjectLiteralExpression).properties) {
          const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
          if (!ts.isPropertyAssignment(p) || (key !== 'default' && key !== 'required'))
            fail(
              'E_MODEL',
              'defineModel supports the default and required options (get/set transformers and local are planned for later)',
              at(p),
            );
          if (
            key === 'default' ||
            (p as ts.PropertyAssignment).initializer.kind === ts.SyntaxKind.TrueKeyword
          )
            nullable = false;
        }
      }
      macros.models.push({ prop, typeText: text(typeArg!), nullable });
    };
    const slots = (call: ts.CallExpression) => {
      if (macros.slots) fail('E_SLOTS', 'defineSlots may be called once', at(call));
      const typeArg = call.typeArguments?.[0];
      if (!typeArg || call.arguments.length)
        fail(
          'E_SLOTS',
          'Declare slots with a type: defineSlots<{ row(props: { item: T }): any }>()',
          at(call),
        );
      macros.slots = { typeText: text(typeArg!) };
    };
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (!spec.endsWith('.vue')) continue;
        const edge = graph.modules.get(file)!.imports.find(i => i.specifier === spec);
        const name = stmt.importClause?.name?.text;
        if (!edge || !name || stmt.importClause?.namedBindings || stmt.importClause?.isTypeOnly)
          fail('E_IMPORT', 'Import components as `import Name from "./Name.vue"`', at(stmt));
        children.set(name!, edge!.resolved);
        continue;
      }
      if (ts.isExpressionStatement(stmt)) {
        const m = macroOf(stmt.expression);
        if (m?.name === 'defineProps' || m?.name === 'withDefaults') props(m.call);
        else if (m?.name === 'defineEmits') emits(m.call);
        else if (m?.name === 'defineSlots') slots(m.call);
        else if (m?.name === 'defineOptions') options(m.call);
        else if (m?.name === 'defineExpose') expose(m.call);
        else if (m) fail('E_MODEL', 'Assign defineModel to a variable', at(stmt));
        continue;
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.name) macros.topNames.push(stmt.name.text);
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        const m = macroOf(d.initializer);
        if (m?.name === 'defineProps' || m?.name === 'withDefaults') props(m.call, d.name);
        else if (m?.name === 'defineEmits') emits(m.call, d.name);
        else if (m?.name === 'defineModel') model(m.call, d.name);
        else if (m?.name === 'defineSlots') slots(m.call);
        else if (m) fail('E_MACRO', `${m.name} is a statement`, at(d));
        const init = d.initializer && skipParens(d.initializer);
        if (
          init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'useAttrs'
        ) {
          if (macros.attrsVar || !ts.isIdentifier(d.name))
            fail('E_ATTRS', 'Call useAttrs once, as const attrs = useAttrs()', at(d));
          macros.attrsVar = (d.name as ts.Identifier).text;
        }
        if (ts.isIdentifier(d.name)) macros.topNames.push(d.name.text);
        else if (ts.isObjectBindingPattern(d.name) && m)
          for (const el of d.name.elements)
            if (ts.isIdentifier(el.name)) macros.topNames.push(el.name.text);
      }
    }
    return {
      file,
      rel: fileRel,
      original,
      descriptor,
      index: -1,
      virtual: file + '.__runic.ts',
      synthetic: '',
      scriptLength: script.length,
      scriptStart,
      segments: [],
      starts: new Map(),
      children,
      macros,
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
  /** The local name of the child component a template tag refers to. */
  const childName = (u: Unit, tag: string): string | undefined => {
    if (u.children.has(tag)) return tag;
    const pascal = capitalize(camelize(tag));
    return u.children.has(pascal) ? pascal : undefined;
  };
  const dir = (n: VNode, name: string): VNode | undefined =>
    n.props.find((p: VNode) => p.type === DIRECTIVE && p.name === name);
  /** `<template #name>` children of a component tag. */
  const slotTemplates = (n: VNode): VNode[] =>
    n.children.filter((c: VNode) => c.type === ELEMENT && c.tag === 'template' && dir(c, 'slot'));
  /**
   * Whether slot content always yields a vnode that renderSlot counts as
   * content (ensureValidVNode): text, an element or a component, possibly in
   * a v-if chain that ends in v-else. Lists, nested slots and v-if without
   * v-else may render only comments or empty fragments.
   */
  const alwaysRenders = (list: VNode[]): boolean => {
    const items = list.filter(c => c.type !== COMMENT);
    const single = (c: VNode) =>
      c.type === ELEMENT && c.tagType !== SLOT_TAG && c.tag !== 'template' && !dir(c, 'for');
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      if (c.type === TEXT || c.type === INTERPOLATION) return true;
      if (!dir(c, 'if')) {
        if (single(c)) return true;
        continue;
      }
      const chain = [c];
      while (
        items[i + 1]?.type === ELEMENT &&
        (dir(items[i + 1], 'else-if') || dir(items[i + 1], 'else'))
      )
        chain.push(items[++i]);
      if (dir(chain.at(-1), 'else') && chain.every(single)) return true;
    }
    return false;
  };

  // --- Fallthrough attributes (docs/design/M5-PLATFORM.md, rest props) ---
  // A component's attrs are the props and listeners a parent passes that it
  // does not declare (props, emits, models). Vue applies them to its single
  // root element or component (unless inheritAttrs is false) and wherever its
  // template binds $attrs (or the useAttrs() object) with v-bind. The names a
  // component's attrs may hold, and the elements they reach, come from every
  // call site and through forwarding.
  /** Whether component `c` declares the vnode prop `key` (a prop, model or emit listener). */
  const declares = (c: Unit, key: string): boolean => {
    const camel = camelize(key);
    if ((c.macros.props?.names ?? []).includes(camel)) return true;
    if (c.macros.models.some(m => m.prop === camel || 'onUpdate:' + m.prop === key)) return true;
    return /^on[A-Z]/.test(key) && !!c.macros.emits?.events.some(e => e.key === key);
  };
  /** `v-bind="$attrs"` or `v-bind="attrs"` (the useAttrs() object). */
  const isAttrsSpread = (u: Unit, p: VNode): boolean => {
    if (p.type !== DIRECTIVE || p.name !== 'bind' || p.arg || !p.exp) return false;
    const code = p.exp.content.trim();
    return code === '$attrs' || (!!u.macros.attrsVar && code === u.macros.attrsVar);
  };
  /** The vnode prop key a component tag passes with `p`, if it passes one. */
  const passedKey = (p: VNode): string | undefined => {
    if (p.type === ATTRIBUTE) return ['ref', 'key'].includes(p.name) ? undefined : p.name;
    if (p.type !== DIRECTIVE || !p.arg?.isStatic) return undefined;
    if (p.name === 'bind')
      return ['ref', 'key'].includes(p.arg.content) ? undefined : p.arg.content;
    if (p.name === 'on') return handlerKey(p.arg.content);
    return undefined;
  };
  /** The IR bag name of a vnode prop key: `onClick` → `onclick`. */
  const bagName = (key: string) => (/^on[A-Z]/.test(key) ? 'on' + hyphenate(key.slice(2)) : key);
  interface AttrsPlan {
    /** IR names the attrs may hold → the vnode prop key. */
    keys: Map<string, string>;
    /** Tags of the elements the attrs reach. */
    tags: Set<string>;
    /** Root nodes that receive the attrs (inheritAttrs); undefined without a single root. */
    roots?: VNode[];
    /** Nodes with v-bind="$attrs". */
    sites: VNode[];
    /** Child components the attrs are forwarded to. */
    forwards: Unit[];
    /** A call site that passes attributes (diagnostics). */
    at?: Source;
  }
  const plans = new Map<Unit, AttrsPlan>();
  const eachNode = (list: VNode[], f: (n: VNode) => void) => {
    for (const n of list ?? [])
      if (n.type === ELEMENT) {
        f(n);
        eachNode(n.children, f);
      }
  };
  for (const u of order) {
    const loc = (n: VNode) => locate(u.original, n.loc?.start.offset ?? 0, u.rel);
    const items = u.descriptor.template.ast.children.filter(
      (c: VNode) => c.type !== COMMENT && !(c.type === TEXT && !c.content.trim()),
    );
    const plain = (c: VNode) =>
      c.type === ELEMENT &&
      !dir(c, 'for') &&
      c.tag !== 'template' &&
      (c.tagType === PLAIN || (c.tagType === COMPONENT_TAG && !!childName(u, c.tag)));
    // One root node, or one v-if chain of them.
    const single =
      items.length > 0 &&
      items.every(plain) &&
      (items.length === 1
        ? !dir(items[0], 'else') && !dir(items[0], 'else-if')
        : !!dir(items[0], 'if') &&
          items.slice(1).every((c: VNode) => dir(c, 'else-if') || dir(c, 'else')));
    const sites: VNode[] = [];
    eachNode(u.descriptor.template.ast.children, n => {
      if (n.tagType === SLOT_TAG) return; // slot props (outlet)
      for (const p of n.props)
        if (p.type === DIRECTIVE && p.name === 'bind' && !p.arg) {
          if (!isAttrsSpread(u, p))
            fail(
              'E_TEMPLATE',
              `v-bind with an object is supported for $attrs${u.macros.attrsVar ? ` and ${u.macros.attrsVar}` : ''} (other objects are planned for later)`,
              loc(p),
            );
          if (u.macros.inheritAttrs && single && items.includes(n))
            fail(
              'E_ATTRS',
              'Vue already applies $attrs to the root node; set defineOptions({ inheritAttrs: false }) to bind them here',
              loc(p),
            );
          sites.push(n);
        }
    });
    plans.set(u, {
      keys: new Map(),
      tags: new Set(),
      ...(single ? { roots: items } : {}),
      sites,
      forwards: [],
    });
  }
  for (const u of order) {
    const loc = (n: VNode) => locate(u.original, n.loc?.start.offset ?? 0, u.rel);
    const plan = plans.get(u)!;
    const targets = [...(u.macros.inheritAttrs ? (plan.roots ?? []) : []), ...plan.sites];
    for (const t of targets) {
      const name = t.tagType === COMPONENT_TAG ? childName(u, t.tag) : undefined;
      if (name) plan.forwards.push(units.get(u.children.get(name)!)!);
      else plan.tags.add(t.tag);
    }
    eachNode(u.descriptor.template.ast.children, n => {
      const name = n.tagType === COMPONENT_TAG ? childName(u, n.tag) : undefined;
      if (!name) return;
      const child = units.get(u.children.get(name)!)!;
      const into = plans.get(child)!;
      for (const p of n.props) {
        const key = passedKey(p);
        if (key === undefined || declares(child, key)) continue;
        if (into.keys.has(bagName(key)) && into.keys.get(bagName(key)) !== key)
          fail('E_ATTRS', `${key} and ${into.keys.get(bagName(key))} name one attribute`, loc(p));
        into.keys.set(bagName(key), key);
        into.at ??= loc(p);
      }
    });
  }
  // Names flow to the components attrs are forwarded to; element tags flow back.
  for (let changed = true; changed;) {
    changed = false;
    for (const plan of plans.values())
      for (const to of plan.forwards) {
        const into = plans.get(to)!;
        for (const [k, key] of plan.keys)
          if (!into.keys.has(k)) {
            into.keys.set(k, key);
            into.at ??= plan.at;
            changed = true;
          }
        for (const tag of into.tags)
          if (!plan.tags.has(tag)) {
            plan.tags.add(tag);
            changed = true;
          }
      }
  }
  for (const u of order) {
    const plan = plans.get(u)!;
    if (plan.keys.size && u.macros.inheritAttrs && !plan.roots)
      fail(
        'E_ATTRS',
        `${path.basename(u.file)} renders no single root element or component (but several nodes, text, a list or a slot), so Vue drops the attributes it does not declare (${[...plan.keys.values()].join(', ')}); declare them as props or bind $attrs with inheritAttrs: false`,
        plan.at,
      );
    for (const to of plan.forwards)
      for (const [, key] of plan.keys)
        if (declares(to, key))
          fail(
            'E_ATTRS',
            `The attributes of ${path.basename(u.file)} may hold ${key}, which ${path.basename(to.file)} declares; pass ${key} explicitly`,
            plan.at,
          );
  }

  // --- Virtual modules: script, then the template as typed statements ---
  for (const u of order) {
    const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
    const loc = (n: VNode) => locate(u.original, n.loc?.start.offset ?? 0, u.rel);
    const { macros } = u;
    const top = macros.topNames;
    let s =
      script +
      `\nfunction __runic_template(__u = { ${top.map(n => `${n}: __runic_unref(${n})`).join(', ')} }) {\n` +
      `const { ${top.join(', ')} } = __u;\n`;
    const extra = (macros.props?.names ?? []).filter(n => !top.includes(n));
    if (extra.length) {
      s += `const __runic_P = ${macros.props!.variable ?? `defineProps<${macros.props!.typeText}>()`};\n`;
      s += `const { ${extra.join(', ')} } = __runic_P;\n`;
    }
    if (macros.emits)
      s += `const $emit = ${macros.emits.variable ?? `defineEmits<${macros.emits.typeText}>()`};\n`;
    const copy = (orig: number, code: string) => {
      u.segments.push({ synth: s.length, orig, length: code.length });
      s += code;
    };
    /** Copy an expression node, recording its synthetic span. */
    const mark = (e: VNode) => {
      const start = s.length;
      copy(e.loc.start.offset, e.content);
      u.starts.set(e, [start, s.length]);
    };
    const inline = (e: VNode) => {
      s += '(';
      mark(e);
      s += ')';
    };
    /** A handler expression: method paths and functions as is, statements wrapped. */
    const handler = (e: VNode, params: string) => {
      const code: string = e.content;
      if (isSimplePath(code) || isFunctionExpression(code)) return inline(e);
      s += '(';
      const start = s.length;
      s += `(${params}) => { `;
      copy(e.loc.start.offset, code);
      s += ' }';
      u.starts.set(e, [start, s.length]);
      s += ')';
    };
    /** v-if/v-else-if tests and v-for keys of a component or slot outlet. */
    const structuralExprs = (n: VNode) => {
      for (const p of n.props)
        if (
          p.type === DIRECTIVE &&
          p.exp &&
          (['if', 'else-if'].includes(p.name) || (p.name === 'bind' && p.arg?.content === 'key'))
        ) {
          inline(p.exp);
          s += ';\n';
        }
    };
    const walk = (n: VNode) => {
      if (n.type === INTERPOLATION) {
        inline(n.content);
        s += ';\n';
        return;
      }
      if (n.type !== ELEMENT) return;
      const vFor = dir(n, 'for');
      if (vFor) {
        const r = vFor.forParseResult;
        if (!r?.source || !r.value)
          fail('E_TEMPLATE', 'Unsupported v-for expression (use `item in items`)', loc(vFor));
        s += 'for (const ';
        mark(r.value);
        s += ' of (';
        mark(r.source);
        s += ')) {\n';
        if (r.key) {
          s += 'const ';
          mark(r.key);
          s += ': number = 0;\n';
        }
      }
      const name = n.tagType === COMPONENT_TAG ? childName(u, n.tag) : undefined;
      if (name) {
        const child = units.get(u.children.get(name)!)!;
        // Props are checked against the child's props type (typing inline callbacks).
        s += `((__p: __RunicProps_${name}) => 0)({\n`;
        // Attributes the child does not declare fall through to an element.
        const fallthrough: VNode[] = [];
        for (const p of n.props) {
          if (p.type !== DIRECTIVE || !p.exp || (p.arg && !p.arg.isStatic)) continue;
          const key = passedKey(p);
          if (
            key !== undefined &&
            (p.name === 'bind' || p.name === 'on') &&
            !declares(child, key)
          ) {
            fallthrough.push(p);
            continue;
          }
          if (p.name === 'bind' && p.arg && p.arg.content !== 'key') {
            s += `${JSON.stringify(camelize(p.arg.content))}: `;
            inline(p.exp);
            s += ',\n';
          } else if (p.name === 'on' && p.arg) {
            const key = handlerKey(p.arg.content);
            const arity = child.macros.emits?.events.find(e => e.key === key)?.arity;
            s += `${JSON.stringify(key)}: `;
            handler(
              p.exp,
              arity === undefined
                ? '$event: any'
                : Array.from({ length: arity }, (_, i) => (i ? `__runic_a${i}` : '$event')).join(
                    ', ',
                  ),
            );
            s += ',\n';
          } else if (p.name === 'model') {
            const m: string = p.arg?.content ?? 'modelValue';
            s += `${JSON.stringify(m)}: `;
            inline(p.exp);
            s += `,\n${JSON.stringify('onUpdate:' + m)}: (`;
            const start = s.length;
            s += '($event) => { ';
            copy(p.exp.loc.start.offset, p.exp.content);
            s += ' = $event }';
            u.starts.set(p, [start, s.length]);
            s += '),\n';
          }
        }
        s += '});\n';
        for (const p of fallthrough) {
          if (p.name === 'on') {
            // A listener on the element: typed by the event's interface.
            s += `__runic_on<${eventInterface(hyphenate(handlerKey(p.arg.content).slice(2)))}>(`;
            handler(p.exp, '$event');
            s += ')';
          } else inline(p.exp);
          s += ';\n';
        }
        structuralExprs(n);
        // Slot content, in blocks that destructure the child's slot props.
        const block = (slot: string, exp: VNode | undefined, body: VNode[]) => {
          s += '{\n';
          if (exp) {
            s += 'const ';
            mark(exp);
            s += ` = __runic_slot<__RunicSlots_${name}, ${JSON.stringify(slot)}>();\n`;
          }
          for (const c of body) walk(c);
          s += '}\n';
        };
        const templates = slotTemplates(n);
        for (const t of templates) {
          const d = dir(t, 'slot');
          block(d.arg?.isStatic ? d.arg.content : 'default', d.exp, t.children);
        }
        const rest = n.children.filter((c: VNode) => !templates.includes(c));
        if (rest.length) block('default', dir(n, 'slot')?.exp, rest);
      } else if (n.tagType === SLOT_TAG) {
        // A slot outlet returns its props, so the slot type of an untyped
        // component is inferred from the template function's return type
        // (through a function, so TypeScript does not normalise the props of
        // different slots into one object type with optional members).
        structuralExprs(n);
        const slot = n.props.find((p: VNode) => p.type === ATTRIBUTE && p.name === 'name');
        s += `if (__runic_never) return { __slot: ${JSON.stringify(slot?.value?.content ?? 'default')} as const, props: () => ({\n`;
        for (const p of n.props) {
          if (p.type === ATTRIBUTE && p.name !== 'name')
            s += `${JSON.stringify(camelize(p.name))}: ${JSON.stringify(p.value?.content ?? '')},\n`;
          else if (
            p.type === DIRECTIVE &&
            p.name === 'bind' &&
            p.exp &&
            p.arg?.isStatic &&
            !['key', 'name'].includes(p.arg.content)
          ) {
            s += `${JSON.stringify(camelize(p.arg.content))}: `;
            inline(p.exp);
            s += ',\n';
          }
        }
        s += '}) };\n';
        for (const c of n.children ?? []) walk(c);
      } else {
        for (const p of n.props) {
          if (p.type !== DIRECTIVE || !p.exp || p.name === 'for') continue;
          if (p.name === 'bind' && !p.arg) continue; // v-bind="$attrs"
          if (p.name === 'on') {
            // `$event` and handler parameters are typed by the event's interface.
            const event = p.arg?.isStatic ? listenedEvent(p.arg.content, modifierNames(p)) : '';
            s += `__runic_on<${eventInterface(event)}>(`;
            handler(p.exp, '$event');
            s += ')';
          } else inline(p.exp);
          s += ';\n';
        }
        for (const c of n.children ?? []) walk(c);
      }
      if (vFor) s += '}\n';
    };
    for (const c of u.descriptor.template.ast.children) walk(c);
    s += '}\n';
    for (const [name, file] of u.children)
      s += `import type { __RunicProps as __RunicProps_${name}, __RunicSlots as __RunicSlots_${name} } from ${JSON.stringify(units.get(file)!.virtual)};\n`;
    s +=
      'type __RunicSlotReturn = Exclude<ReturnType<typeof __runic_template>, void | undefined>;\n';
    s += macros.slots
      ? `export type __RunicSlots = ${macros.slots.typeText};\n`
      : "export type __RunicSlots = { [K in __RunicSlotReturn['__slot']]: (props: ReturnType<Extract<__RunicSlotReturn, { __slot: K }>['props']>) => unknown };\n";
    const events = macros.emits?.events ?? [];
    s += `type __RunicEmits = { ${events.map(e => `${JSON.stringify(e.key)}: ${e.params} => void;`).join(' ')} };\n`;
    s += `type __RunicModels = { ${macros.models
      .map(m => {
        const t = m.nullable ? `(${m.typeText}) | undefined` : m.typeText;
        return `${JSON.stringify(m.prop)}: ${t}; ${JSON.stringify('onUpdate:' + m.prop)}: (value: ${t}) => void;`;
      })
      .join(' ')} };\n`;
    s += `export type __RunicProps = (${macros.props?.typeText ?? '{}'}) & Partial<__RunicEmits> & Partial<__RunicModels>;\n`;
    // The component instance a parent's template ref sees: the exposed refs, unwrapped.
    s += `export type __RunicInstance = { ${(macros.expose ?? [])
      .map(e => `${JSON.stringify(e.key)}: __RunicUnref<typeof ${e.name}>;`)
      .join(' ')} };\n`;
    u.synthetic = s;
  }
  const files = new Map<string, string>();
  for (const u of order) {
    files.set(u.virtual, u.synthetic);
    // `import Field from './Field.vue'` resolves here (InstanceType<typeof Field>).
    files.set(
      u.file + '.d.ts',
      `declare const component: new () => import(${JSON.stringify(u.virtual)}).__RunicInstance;\nexport default component;\n`,
    );
  }
  for (const [id, m] of graph.modules)
    if (/\.(ts|js|mjs)$/.test(id) && id.startsWith(root + path.sep)) files.set(id, m.code);
  const program = createProgram(files, [VUE]);
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
    const syntax = program.getSyntacticDiagnostics(program.getSourceFile(u.virtual)!)[0];
    if (syntax)
      fail(
        'E_PARSE',
        ts.flattenDiagnosticMessageText(syntax.messageText, '\n'),
        syntax.start !== undefined ? sourceAt(u, syntax.start) : undefined,
      );
  }
  const tsFail = (n: ts.Node, code: string, message: string): never =>
    fail(code, message, sourceOf(n));
  const checker = program.getTypeChecker();
  const types = new TypeMapper(checker, tsFail);
  // Template expressions see the setup bindings and Vue's allowed globals;
  // other names resolve on the component instance (`setTimeout` there is
  // undefined), so host globals are rejected in templates.
  for (const u of order) {
    const sf = program.getSourceFile(u.virtual)!;
    const copied = (pos: number) =>
      u.segments.some(g => pos >= g.synth && pos < g.synth + g.length);
    const visit = (n: ts.Node): void => {
      if (ts.isTypeNode(n)) return;
      if (
        ts.isIdentifier(n) &&
        copied(n.getStart(sf)) &&
        !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
        !TEMPLATE_GLOBALS.has(n.text)
      ) {
        const sym = checker.getSymbolAtLocation(n);
        if (
          sym &&
          sym.flags & ts.SymbolFlags.Value &&
          sym.declarations?.length &&
          sym.declarations.every(d => d.getSourceFile().isDeclarationFile)
        )
          tsFail(
            n,
            'E_TEMPLATE',
            `${n.text} is not available in Vue templates (they see setup bindings and a few globals such as Math and JSON); use it in a script function`,
          );
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // --- Lowering state (one component at a time) ---
  let cells: Cell[] = [];
  /** Cells of defineModel refs (writable props). */
  let modelCells = new Set<number>();
  /** Model cells written so far in each function (reads after that are stale in Vue). */
  let written = new Map<FnBuilder, Set<number>>();
  /** Symbols of the component's emit function (`emit`, template `emit`/`$emit`). */
  let emitSymbols = new Set<ts.Symbol>();
  /** Emit prop cells by handler key (`onRemove`). */
  let emitCells = new Map<string, number>();
  /** Cells bound to an element by `ref="name"` (Vue writes them; code only reads). */
  let templateRefCells = new Set<number>();
  /** Reads of template refs (lowering order) of the current component. */
  let refReadSites: { cell: number; node: ts.Node }[] = [];
  /** Template-ref cells of each component and their reads. */
  const templateRefsOf: { cells: Set<number>; reads: { cell: number; node: ts.Node }[] }[] = [];
  /** The source node of each template-ref read (function bodies are copied when finished). */
  const refReads = new WeakMap<object, ts.Node>();
  /** Template-ref reads Vue does not make while rendering (a component ref passed back to its child). */
  const unrenderedReads = new WeakSet<object>();
  /** The attrs (rest props) cell of the current component. */
  let restCell: number | undefined;
  /** Per component: the exposed template ref (`defineExpose`), its key and prop. */
  const exposedOf: ({ key: string; prop: string } | undefined)[] = [];
  /** Watcher and lifecycle functions by builder name: the local collecting registered cleanups. */
  const effectRoots = new Map<string, { watcher: boolean; cleanup?: number }>();
  /** Getter functions of computeds. */
  const computedFns = new Set<number>();
  /** `onCleanup` parameters of watcher functions. */
  const cleanupParams = new Set<ts.Symbol>();
  /** Calls `onCleanup(f)` / `onWatcherCleanup(f)` registering a watcher cleanup. */
  const isCleanupCall = (node: ts.Expression): node is ts.CallExpression => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
    const s = checker.getSymbolAtLocation(node.expression);
    return (s !== undefined && cleanupParams.has(s)) || vueCall(node) === 'onWatcherCleanup';
  };
  /** Shared helpers: run two cleanups in order; call a function as a cleanup. */
  let bothCleanups: number | undefined;
  const asCleanup = new Map<string, number>();
  const vueCall = (e: ts.Expression | undefined): string | undefined => {
    if (!e || !ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    const s = checker.getSymbolAtLocation(e.expression);
    const decl =
      s && (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).declarations?.[0];
    return decl && decl.getSourceFile().fileName === VUE ? e.expression.text : undefined;
  };
  const isPropsMember = (e: ts.Expression, lower: Lowerer) => {
    e = skipParens(e);
    return (
      (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) &&
      ts.isIdentifier(e.expression) &&
      lower.binding(e.expression)?.kind === 'props'
    );
  };
  const hooks: Hooks = {
    readCell(cell, ctx, node) {
      if (modelCells.has(cell) && written.get(ctx)?.has(cell))
        tsFail(
          node,
          'E_MODEL',
          'Reading a model after writing it in the same function: Vue returns the old value until the parent re-renders; keep the written value in a local instead',
        );
      if (cell === restCell)
        tsFail(
          node,
          'E_ATTRS',
          'Reading fallthrough attributes by name is planned for a later milestone; forward them with v-bind',
        );
      const read: Expr = { op: 'cell', cell, read: 'current' };
      if (templateRefCells.has(cell)) {
        refReads.set(read, node);
        refReadSites.push({ cell, node });
      }
      return read;
    },
    cellType: cell => cells[cell].type,
    writeCell(cell, value, ctx, node) {
      const c = cells[cell];
      if (c.prop !== undefined && !modelCells.has(cell))
        tsFail(
          node,
          'E_PROPS',
          `Props are read-only in Vue (${c.prop}); emit an event or use defineModel`,
        );
      if (templateRefCells.has(cell))
        tsFail(
          node,
          'E_REF',
          `${c.name} is a template ref: Vue sets it when its element mounts and unmounts, so it is read-only here`,
        );
      if (modelCells.has(cell)) {
        if (!written.has(ctx)) written.set(ctx, new Set());
        written.get(ctx)!.add(cell);
      }
      return [{ op: 'set', cell, value }];
    },
    call(node, ctx, lower) {
      const callee = node.expression;
      if (!ts.isIdentifier(callee)) return undefined;
      const sym = lower.symbol(callee);
      if (sym && emitSymbols.has(sym)) {
        const [first, ...rest] = node.arguments;
        if (!first || !ts.isStringLiteralLike(first))
          return tsFail(node, 'E_EMITS', 'emit takes a literal event name');
        const cell = emitCells.get(handlerKey(first.text));
        if (cell === undefined)
          return tsFail(first, 'E_EMITS', `Event ${first.text} is not declared in defineEmits`);
        const t = cells[cell].type as { fn: { params: Type[] } };
        if (rest.length > t.fn.params.length)
          return tsFail(
            node,
            'E_EMITS',
            `Event ${first.text} takes ${t.fn.params.length} arguments`,
          );
        const args = t.fn.params.map((p, i): Expr => {
          if (rest[i]) return lower.coerce(rest[i], ctx, p);
          if (maybeInner(p)) return { op: 'undefined', type: p };
          return tsFail(node, 'E_EMITS', `Event ${first.text} needs argument ${i + 1}`);
        });
        return { op: 'call-value', callee: { op: 'cell', cell, read: 'current' }, args };
      }
      // nextTick(): the pending flush's promise (fulfilled already when none
      // is pending); nextTick(fn) chains fn on it.
      if (vueCall(node) === 'nextTick') {
        const after: Expr = {
          op: 'builtin',
          name: 'flush.after',
          args: [],
          type: { promise: 'void' },
        };
        if (!node.arguments.length) return after;
        if (node.arguments.length > 1)
          return tsFail(node, 'E_CALL', 'nextTick takes at most one callback');
        const type = types.of(node);
        return {
          op: 'builtin',
          name: 'promise.then',
          args: [after, lower.expr(node.arguments[0], ctx)],
          type,
        };
      }
      if (MACROS.has(callee.text) && vueCall(node))
        return tsFail(node, 'E_MACRO', `${callee.text} is a top-level <script setup> declaration`);
      if (vueCall(node) === 'useTemplateRef')
        return tsFail(
          node,
          'E_REF',
          'useTemplateRef is supported as a top-level const declaration of <script setup>',
        );
      if (isCleanupCall(node))
        return tsFail(
          node,
          'E_EFFECT',
          `${callee.text}(fn) is supported as a statement of the watcher function itself`,
        );
      const v = vueCall(node);
      if (v && LIFECYCLE.has(v))
        return tsFail(
          node,
          'E_EFFECT',
          `${v} is supported as a top-level statement of <script setup> (Vue binds it to the component while setup runs)`,
        );
      return undefined;
    },
    statement(node, ctx, lower) {
      if (isCleanupCall(node)) return registerCleanup(node, ctx, lower);
      const K = ts.SyntaxKind;
      const target =
        ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)
          ? node.left
          : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
              [K.PlusPlusToken, K.MinusMinusToken].includes(node.operator)
            ? node.operand
            : undefined;
      if (target && isPropsMember(target, lower))
        tsFail(target, 'E_PROPS', 'Props are read-only in Vue; emit an event or use defineModel');
      // Template refs: rejected before the assigned value is lowered.
      const t = target && skipParens(target);
      const b =
        t && ts.isIdentifier(t)
          ? lower.binding(t)
          : t &&
              ts.isPropertyAccessExpression(t) &&
              t.name.text === 'value' &&
              ts.isIdentifier(t.expression)
            ? lower.binding(t.expression)
            : undefined;
      if (b && (b.kind === 'cell' || b.kind === 'ref') && templateRefCells.has(b.cell))
        tsFail(
          t!,
          'E_REF',
          `${cells[b.cell].name} is a template ref: Vue sets it when its element mounts and unmounts, so it is read-only here`,
        );
      return undefined;
    },
  };
  const lower = new Lowerer(program, checker, types, hooks, tsFail, sourceOf);
  // Vue's reactive proxy is the `this` of methods called through it, but not
  // of closures made while constructing: their writes would not re-render.
  const rawThisCheck = (type: Type, at: ts.Node) => {
    const cls = lower.classes.rawThis(type);
    if (cls)
      tsFail(
        at,
        'E_CLASS',
        `${cls} keeps its raw instance in closures made by its constructor (arrow function fields, bound methods); Vue's reactive proxy would not see their writes, so it is unsupported in a ref (reactive classes are M6 stage B)`,
      );
  };
  // The script runs once per instance: its functions keep their identity.
  lower.stableFunctions = true;

  /**
   * `onCleanup(f)` / `onWatcherCleanup(f)` in a watcher function: Vue runs the
   * registered cleanups in order before the watcher's next run and when it
   * stops. The watcher function collects them in a local it returns (see
   * `finishEffect`), which is the effect's cleanup.
   */
  function registerCleanup(node: ts.CallExpression, ctx: FnBuilder, lower: Lowerer): Stmt[] {
    const root = ctx.parent ? undefined : effectRoots.get(ctx.name);
    if (!root?.watcher)
      return tsFail(
        node,
        'E_EFFECT',
        'Register watcher cleanups directly in the function of watch or watchEffect (not in nested functions or other hooks)',
      );
    if (node.arguments.length !== 1)
      return tsFail(node, 'E_EFFECT', 'Cleanup registration takes one function');
    const value = lower.expr(node.arguments[0], ctx);
    const type = lower.irType(value, ctx);
    if (typeof type !== 'object' || !('fn' in type) || type.fn.params.length)
      return tsFail(node.arguments[0], 'E_EFFECT', 'Cleanups are functions without parameters');
    const out: Stmt[] = [];
    let f = ctx.local('$cleanupFn', type);
    out.push({ op: 'let', local: f, value });
    if (!sameType(type, CLEANUP)) {
      // A cleanup's result is ignored.
      const key = JSON.stringify(type);
      if (!asCleanup.has(key)) {
        const index = lower.reserve();
        lower.functions[index] = {
          name: 'cleanup$call',
          captures: [{ name: 'f', type }],
          params: [],
          locals: [],
          result: 'void',
          body: [{ op: 'expr', value: { op: 'call-value', callee: L(0), args: [] } }],
        };
        asCleanup.set(key, index);
      }
      const wrapped = ctx.local('$cleanupFn', CLEANUP);
      out.push({
        op: 'let',
        local: wrapped,
        value: { op: 'closure', function: asCleanup.get(key)!, captures: [f] },
      });
      f = wrapped;
    }
    root.cleanup ??= ctx.local('$cleanup', { maybe: CLEANUP });
    const c = root.cleanup;
    if (bothCleanups === undefined) {
      bothCleanups = lower.reserve();
      lower.functions[bothCleanups] = {
        name: 'cleanup$both',
        captures: [
          { name: 'first', type: CLEANUP },
          { name: 'second', type: CLEANUP },
        ],
        params: [],
        locals: [],
        result: 'void',
        body: [
          { op: 'expr', value: { op: 'call-value', callee: L(0), args: [] } },
          { op: 'expr', value: { op: 'call-value', callee: L(1), args: [] } },
        ],
      };
    }
    const previous = ctx.local('$cleanupPrev', CLEANUP);
    out.push({
      op: 'if',
      test: { op: 'builtin', name: 'maybe.is-nullish', args: [L(c)], type: 'boolean' },
      then: [
        { op: 'assign', target: { place: 'local', local: c }, value: { op: 'some', value: L(f) } },
      ],
      else: [
        { op: 'let', local: previous, value: { op: 'unwrap', value: L(c) } },
        {
          op: 'assign',
          target: { place: 'local', local: c },
          value: {
            op: 'some',
            value: { op: 'closure', function: bothCleanups, captures: [previous, f] },
          },
        },
      ],
      ...(sourceOf(node) ? { source: sourceOf(node) } : {}),
    });
    return out;
  }

  /**
   * Finish a lowered watcher or hook function: its own return values are
   * ignored (Vue discards them); it returns the registered cleanups, if any.
   * `drop` removes a parameter that is only used to register cleanups.
   */
  function finishEffect(index: number, b: FnBuilder, drop?: number) {
    const fn = lower.functions[index];
    const root = effectRoots.get(b.name);
    const c = root?.cleanup !== undefined ? b.final(root.cleanup) : undefined;
    const ret = (): Stmt => (c === undefined ? { op: 'return' } : { op: 'return', value: L(c) });
    const rewrite = (stmts: Stmt[]): Stmt[] =>
      stmts.flatMap((s): Stmt[] => {
        switch (s.op) {
          case 'return':
            return s.value ? [{ op: 'expr', value: s.value }, ret()] : [ret()];
          case 'if':
            return [{ ...s, then: rewrite(s.then), ...(s.else ? { else: rewrite(s.else) } : {}) }];
          case 'while':
            return [
              { ...s, body: rewrite(s.body), ...(s.update ? { update: rewrite(s.update) } : {}) },
            ];
          case 'for-of':
            return [{ ...s, body: rewrite(s.body) }];
          case 'try':
            return [
              {
                ...s,
                body: rewrite(s.body),
                ...(s.catch ? { catch: { ...s.catch, body: rewrite(s.catch.body) } } : {}),
                ...(s.finally ? { finally: rewrite(s.finally) } : {}),
              },
            ];
          default:
            return [s];
        }
      });
    let body = rewrite(fn.body);
    if (c !== undefined)
      body = [
        { op: 'let', local: c, value: { op: 'undefined', type: { maybe: CLEANUP } } },
        ...body,
        ret(),
      ];
    let params = fn.params;
    if (drop !== undefined && drop < params.length) {
      const at = drop + (fn.captures?.length ?? 0);
      body = remapLocals(body, i => (i > at ? i - 1 : i));
      params = params.filter((_, i) => i !== drop);
    }
    lower.functions[index] = {
      ...fn,
      params,
      result: c === undefined ? 'void' : { maybe: CLEANUP },
      body,
    };
  }
  // Ordinary local modules initialise first (dependencies first).
  for (const p of lowerModules(graph, program, lower, { skip: f => f === graph.entry })) p();

  const components: Component[] = [];
  /** Slot prop names of each component, in the order of the slot's IR params. */
  const slotProps: Map<string, string[]>[] = [];
  /** The refs v-model assigns on selects and radio buttons, with the elements' @change listeners. */
  const selectModels: {
    component: number;
    cell: number;
    radio: boolean;
    source: Source;
    change: Part[];
  }[] = [];
  for (const u of order) components[u.index] = lowerComponent(u);
  rejectRenderRefReads();
  components.forEach(rejectWatcherWrites);
  rejectUnmountOrder();
  checkRadioGroups(components, units.get(rootFile!)!.index);
  checkControlModels();
  checkCancelledRadios();

  /**
   * A cancelled click on a radio button: the browser checks the previously
   * checked button again after the listeners (and Vue's flush), unchecking
   * the rest of its group; the IR does not uncheck the group when it
   * reverts, so a click listener that may cancel the click on a radio
   * button (on it or an ancestor) must not write state.
   */
  function checkCancelledRadios() {
    const prevents = (roots: unknown[], fns: Set<number>) => {
      let found = false;
      const visit = (x: unknown) => {
        if (found || !x || typeof x !== 'object') return;
        if (Array.isArray(x)) return x.forEach(visit);
        const o = x as { op?: string; name?: string };
        if (o.op === 'builtin' && o.name === 'event.preventDefault') found = true;
        if (o.op === 'call-value') found = true;
        for (const v of Object.values(x)) visit(v);
      };
      visit(roots);
      for (const f of fns) visit(lower.functions[f]?.body);
      return found;
    };
    const hasRadio = (nodes: Node[]): boolean =>
      nodes.some(n =>
        n.kind === 'element'
          ? (n.tag === 'input' &&
              (n.attrs ?? []).some(
                a => a.name === 'type' && a.value.op === 'lit' && a.value.value === 'radio',
              )) ||
            hasRadio(n.children ?? [])
          : n.kind === 'if'
            ? hasRadio([...n.then, ...(n.else ?? [])])
            : n.kind === 'each'
              ? hasRadio([...n.body, ...(n.else ?? [])])
              : n.kind === 'slot'
                ? hasRadio(n.fallback ?? [])
                : n.kind === 'component'
                  ? (n.slots ?? []).some(s => hasRadio(s.body)) ||
                    hasRadio(components[n.component].template)
                  : false,
      );
    components.forEach((c, k) => {
      const visit = (nodes: Node[]) => {
        for (const n of nodes) {
          if (n.kind === 'element') {
            for (const l of n.listeners ?? []) {
              if (l.event !== 'click') continue;
              const h = c.handlers[l.handler];
              const a = access([h.body], c.cells);
              if (
                prevents([h.body], a.calls) &&
                (a.writes.size || a.heap || a.unknown) &&
                hasRadio([n])
              )
                fail(
                  'E_EVENT',
                  'A click listener here may cancel the click on a radio button and writes state: the browser checks the previously checked button again after the flush, which is unsupported',
                  n.source,
                );
            }
            visit(n.children ?? []);
          }
          if (n.kind === 'if') visit([...n.then, ...(n.else ?? [])]);
          if (n.kind === 'each') visit([...n.body, ...(n.else ?? [])]);
          if (n.kind === 'slot') visit(n.fallback ?? []);
          if (n.kind === 'component') for (const s of n.slots ?? []) visit(s.body);
        }
      };
      visit(c.template);
    });
  }

  /**
   * v-model on a select or radio button.
   * - vModelRadio sets every button of the model where the model changed
   *   since the last render; the IR sets a button where its checked value
   *   changed. They agree while the buttons show the model after each
   *   flush, which an effect writing the model in the flush of a change
   *   (before the render) could break: rejected.
   * - The directive's change listener is a native listener of its own, with
   *   a microtask checkpoint (and the flush) before the element's @change
   *   listener; the IR runs both in one handler. Supported where that flush
   *   has nothing else to run (no watchers or lifecycle hooks) and, for
   *   radio buttons, @change does not write the model (Vue would set the
   *   buttons in both flushes). vModelSelect applies the model after every
   *   update where it is not the value it just assigned, as the IR's
   *   re-render restore does.
   */
  function checkControlModels() {
    const calls = (fns: Set<number>, roots: unknown[]): boolean => {
      let found = false;
      const visit = (x: unknown) => {
        if (found || !x || typeof x !== 'object') return;
        if (Array.isArray(x)) return x.forEach(visit);
        if ((x as { op?: string }).op === 'call-value') found = true;
        for (const v of Object.values(x)) visit(v);
      };
      visit(roots);
      for (const f of fns) visit(lower.functions[f]?.body);
      return found;
    };
    const effects = components.flatMap((c, k) =>
      (c.effects ?? []).filter(e => !e.render).map(e => ({ e, k })),
    );
    for (const m of selectModels) {
      const name = components[m.component].cells[m.cell].name;
      if (m.radio)
        for (const { e, k } of effects) {
          const roots = [
            lower.functions[e.run].body,
            e.deps.kind === 'values' ? e.deps.values : [],
          ];
          const a = access(roots, components[k].cells);
          if ((k === m.component && a.writes.has(m.cell)) || a.unknown || calls(a.calls, roots))
            fail(
              'E_EFFECT',
              `This effect may write ${name}, which v-model binds to radio buttons: Vue sets the buttons only where the model changed since the last render, which the IR does not model when the model changes back in the flush of a change`,
              e.source,
            );
        }
      if (!m.change.length) continue;
      if (effects.length)
        fail(
          'E_EVENT',
          `v-model and @change on one select or radio button in a program with watchers or lifecycle hooks are planned for later (Vue flushes between the two listeners: line ${effects[0].e.source?.line} would run in between)`,
          m.source,
        );
      const bodies = m.change.map(p => p.body);
      const a = access(bodies, components[m.component].cells);
      if (m.radio && (a.writes.has(m.cell) || a.unknown || calls(a.calls, bodies)))
        fail(
          'E_EVENT',
          `@change on this radio button may write ${name}, which its v-model assigns: Vue sets the buttons in the flush between the two listeners, which is unsupported`,
          m.change[0].source ?? m.source,
        );
    }
  }

  /**
   * What a function can do to the state of its component: the cells it reads
   * and writes, heap mutations, and calls of function values that may write
   * anything (statically, through the functions and closures it reaches).
   * Calls of function props run the parent's code and are not counted.
   */
  /** Cells read and written by `roots` (`cells`: the component's, to tell plain values from reactive state). */
  function access(roots: unknown[], cells?: Cell[]) {
    const reads = new Set<number>();
    const writes = new Set<number>();
    let heap = false;
    let unknown = false;
    const seen = new Set<number>();
    const queue: unknown[] = [...roots];
    const MUTATORS =
      /^(array\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set)|map\.(set|delete|clear)|set\.(add|delete|clear))$/;
    const visit = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(visit);
      if (!x || typeof x !== 'object') return;
      const o = x as Record<string, unknown>;
      switch (o.op) {
        case 'cell':
          reads.add(o.cell as number);
          break;
        case 'set':
          writes.add(o.cell as number);
          break;
        case 'assign': {
          const t = o.target as { place: string; cell?: number };
          if (t.place === 'cell') writes.add(t.cell!);
          else if (t.place !== 'local') heap = true;
          break;
        }
        case 'builtin': {
          // Mutating a plain (non-reactive) value held by a cell is not a write
          // to reactive state.
          const recv = (o.args as { op: string; cell?: number }[])[0];
          const plain =
            recv?.op === 'cell' && cells !== undefined && cells[recv.cell!].tracking !== 'deep';
          if (MUTATORS.test(o.name as string) && !plain) heap = true;
          // Callbacks of other built-ins (forEach, map, …) run during the
          // call; timer and microtask callbacks run later.
          if (!/^(timer|microtask)\./.test(o.name as string))
            for (const a of o.args as { op: string; function?: number }[])
              if (a.op === 'closure') reach(a.function!);
          break;
        }
        case 'call':
          reach(o.function as number);
          break;
        case 'closure':
          // Created, not run (calling it is a call-value).
          return;
        case 'call-value': {
          const callee = o.callee as { op: string; cell?: number };
          if (callee.op !== 'cell') unknown = true;
          break;
        }
      }
      for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
    };
    const reach = (f: number) => {
      if (!seen.has(f)) {
        seen.add(f);
        queue.push(lower.functions[f]?.body);
      }
    };
    while (queue.length) visit(queue.shift());
    return { reads, writes, heap, unknown, calls: seen };
  }

  /**
   * Vue runs the watchers a watcher triggers after the watchers already
   * queued for the component (and never re-runs a watchEffect for its own
   * writes); Runic checks each watcher once per pass in declaration order.
   * Watchers writing state that a watcher of the same component reads are
   * rejected until the IR can express Vue's queue.
   */
  function rejectWatcherWrites(c: Component) {
    // The render effect writes nothing, and Vue renders after the watchers
    // (it re-renders for their writes, as the effect re-runs).
    const watchers = (c.effects ?? []).filter(
      e => e.phase === 'pre' && e.deps.kind !== 'once' && !e.render,
    );
    const info = watchers.map(e => {
      const run = access([lower.functions[e.run].body], c.cells);
      const deps = e.deps.kind === 'values' ? access(e.deps.values).reads : run.reads;
      return { e, run, deps };
    });
    for (const w of info)
      for (const r of info) {
        const own = c.cells.filter((_, i) => r.deps.has(i));
        const hit =
          [...w.run.writes].find(cell => r.deps.has(cell) && c.cells[cell].tracking !== 'none') ??
          (w.run.heap ? [...r.deps].find(cell => c.cells[cell].tracking === 'deep') : undefined);
        if (hit === undefined && !(w.run.unknown && own.some(x => x.tracking !== 'none'))) continue;
        const name = hit !== undefined ? c.cells[hit].name : 'component state';
        fail(
          'E_EFFECT',
          w === r
            ? `This watcher writes ${name}, which it depends on: Vue does not re-run a watchEffect for its own writes and repeats a watch callback until the value settles; planned for a later milestone`
            : `This watcher writes ${name}, which another watcher of ${c.name} depends on (line ${r.e.source?.line}): Vue runs the triggered watcher after the watchers already queued, which Runic does not model yet`,
          w.e.source,
        );
      }
  }

  /**
   * Vue unmounts a removed component (onBeforeUnmount, watcher cleanups) where
   * the patch removes it, before it patches or creates the components after
   * it (their watchers, onBeforeMount); Runic creates and updates instances
   * while rendering and unmounts after the render. Trees where a removable
   * component with such unmount work comes before (in document order, or in
   * another branch of the same v-if chain, or in the same list) a component
   * with watchers or onBeforeMount are rejected.
   */
  function rejectUnmountOrder() {
    type Flag = 'before' | 'create' | 'pre';
    const memo = new Map<string, boolean>();
    const has = (nodes: Node[] | undefined, flag: Flag): boolean =>
      (nodes ?? []).some(n => {
        switch (n.kind) {
          case 'element':
            return has(n.children, flag);
          case 'if':
            return has(n.then, flag) || has(n.else, flag);
          case 'each':
            return has(n.body, flag) || has(n.else, flag);
          case 'component':
            return n.slots?.some(s => has(s.body, flag)) || componentHas(n.component, flag);
          default:
            return false;
        }
      });
    const componentHas = (k: number, flag: Flag): boolean => {
      const key = `${k}:${flag}`;
      if (memo.has(key)) return memo.get(key)!;
      memo.set(key, false);
      // The render effect only reads (it runs nothing observable).
      const own = (components[k].effects ?? []).some(e =>
        e.render
          ? false
          : flag === 'before'
            ? // onBeforeUnmount, or a watcher that registers cleanups
              e.unmount.removal === 'before' &&
              (e.phase === 'post' || lower.functions[e.run].result !== 'void')
            : flag === 'create'
              ? e.phase === 'pre' && !(e.deps.kind === 'values' && e.deps.initial === false)
              : e.phase === 'pre',
      );
      const result = own || has(components[k].template, flag);
      memo.set(key, result);
      return result;
    };
    const message =
      'Vue unmounts a removed component (onBeforeUnmount, watcher cleanups) before it updates or creates the components after it (their watchers, onBeforeMount), which Runic does not model yet';
    /** The first removable region with unmount work seen so far (document order). */
    let removal: Source | undefined;
    const walk = (nodes: Node[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.kind === 'element') walk(n.children);
        else if (n.kind === 'component') {
          if (removal && componentHas(n.component, 'pre'))
            fail(
              'E_EFFECT',
              `${message}: this conditional or list comes before ${components[n.component].name} (line ${n.source?.line})`,
              removal,
            );
          n.slots?.forEach(s => walk(s.body));
          walk(components[n.component].template);
        } else if (n.kind === 'if') {
          const [a, b] = [n.then, n.else ?? []];
          if ((has(a, 'before') && has(b, 'create')) || (has(b, 'before') && has(a, 'create')))
            fail(
              'E_EFFECT',
              `${message}: one branch of this v-if chain replaces the other`,
              n.source,
            );
          walk(n.then);
          walk(n.else);
          if (has(a, 'before') || has(b, 'before')) removal ??= n.source;
        } else if (n.kind === 'each') {
          if (has(n.body, 'before') && has(n.body, 'pre'))
            fail('E_EFFECT', `${message}: items of this list`, n.source);
          walk(n.body);
          walk(n.else);
          if (has(n.body, 'before') || has(n.else, 'before')) removal ??= n.source;
        }
      }
    };
    walk(components[units.get(rootFile!)!.index].template);
  }

  /**
   * Vue sets a template ref in the post flush (null synchronously on unmount)
   * and re-renders what read it; the IR sets it while rendering and renders
   * again in the same flush (a ref write extends the flush), after the
   * pass's post effects, as Vue re-renders after its mounted hooks. The
   * renders differ in between: the IR's first pass already shows the new
   * ref to what renders after the element. Only text shows that difference,
   * and nothing observes text between the passes (no IR operation reads
   * rendered text or layout; revisit with layout reads), so template text
   * may read a ref directly. Other code that runs while rendering may not:
   * attributes (a disabled state changes focus), structure (v-if, lists,
   * components mount in the first pass), the functions and computeds the
   * template calls and, when rendering calls function values, every closure.
   */
  function rejectRenderRefReads() {
    if (!templateRefsOf.some(r => r?.cells.size)) return;
    type Visit = (e: { op: string; [k: string]: unknown }) => void;
    const visit = (x: unknown, f: Visit) => {
      if (Array.isArray(x)) for (const y of x) visit(y, f);
      else if (x && typeof x === 'object') {
        if (typeof (x as { op?: unknown }).op === 'string') f(x as Parameters<Visit>[0]);
        for (const y of Object.values(x)) visit(y, f);
      }
    };
    // Reads in template text (direct: called functions are scanned on their own).
    const textReads = new WeakSet<object>();
    const texts = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(texts);
      else if (x && typeof x === 'object') {
        if ((x as { kind?: unknown }).kind === 'text')
          visit((x as { parts: unknown }).parts, e => {
            if (e.op === 'cell') textReads.add(e);
          });
        else for (const y of Object.values(x)) texts(y);
      }
    };
    components.forEach(c => texts(c.template));
    const reached = new Set<number>();
    const queue: number[] = [];
    let dynamic = false;
    const before = (a: Source, b: Source) =>
      a.file === b.file && (a.line < b.line || (a.line === b.line && a.column <= b.column));
    const scan = (root: unknown, component: number | undefined, fn?: Fn) =>
      visit(root, e => {
        if (e.op === 'call' && !reached.has(e.function as number)) {
          reached.add(e.function as number);
          queue.push(e.function as number);
        } else if (e.op === 'call-value') dynamic = true;
        else if (
          e.op === 'cell' &&
          component !== undefined &&
          templateRefsOf[component]?.cells.has(e.cell as number) &&
          !(fn === undefined && textReads.has(e)) &&
          !unrenderedReads.has(e)
        ) {
          const c = components[component].cells[e.cell as number];
          // The read itself, or (in a copied function body) the first read of
          // this ref after the start of the function.
          const at =
            refReads.get(e) ??
            templateRefsOf[component].reads
              .filter(r => r.cell === e.cell && fn?.source && before(fn.source, sourceOf(r.node)))
              .map(r => r.node)
              .sort((a, b) => (before(sourceOf(a), sourceOf(b)) ? -1 : 1))[0];
          fail(
            'E_REF',
            `Template ref ${c.name} is read while rendering (in an attribute, a condition, a list or a function or computed the template calls): Vue sets template refs after rendering and renders again; read it in template text or event handlers`,
            at ? sourceOf(at) : (fn?.source ?? c.source),
          );
        }
      });
    const drain = () => {
      while (queue.length) {
        const f = lower.functions[queue.shift()!];
        scan(f.body, f.component, f);
      }
    };
    components.forEach((c, i) => scan(c.template, i));
    drain();
    if (!dynamic) return;
    visit([components, lower.functions, lower.globals], e => {
      if (e.op === 'closure' && !reached.has(e.function as number)) {
        reached.add(e.function as number);
        queue.push(e.function as number);
      }
    });
    drain();
  }

  /**
   * Elements Vue renders as static HTML (compiler-dom's stringifyStatic):
   * the offsets of the elements that remain virtual nodes, in the
   * development build (plugin-vue's dev server) and the production build
   * (the template inlined into the script). A stringified element carries
   * its style as text instead of setting it through the CSSOM.
   */
  function liveElements(u: Unit): [Set<number>, Set<number>] {
    if (u.vnodeElements) return u.vnodeElements;
    const c = graph.tooling.compiler;
    const { bindings } = c.compileScript(u.descriptor, { id: 'runic' });
    const base: number = u.descriptor.template.loc.start.offset;
    const live = (inline: boolean) => {
      const r = c.compileTemplate({
        source: u.descriptor.template.content,
        filename: u.file,
        id: 'runic',
        compilerOptions: { bindingMetadata: bindings, inline },
      });
      if (r.errors.length || !r.ast)
        fail('E_PARSE', String(r.errors[0] ?? 'template'), { file: u.rel, line: 1, column: 1 });
      const out = new Set<number>();
      const walk = (n: VNode) => {
        if (!n) return;
        if (n.type === ELEMENT) {
          // compiler-core: a cached createStaticVNode call (JS_CACHE_EXPRESSION
          // holding a JS_CALL_EXPRESSION) replaces a stringified chunk.
          if (n.codegenNode?.type === 20 && n.codegenNode.value?.type === 14) return;
          out.add(base + n.loc.start.offset);
        }
        for (const x of n.children ?? []) walk(x);
        for (const x of n.branches ?? []) walk(x);
      };
      walk(r.ast);
      return out;
    };
    u.vnodeElements = [live(false), live(true)];
    return u.vnodeElements;
  }

  function lowerComponent(u: Unit): Component {
    cells = [];
    modelCells = new Set();
    written = new Map();
    emitSymbols = new Set();
    emitCells = new Map();
    templateRefCells = new Set();
    refReadSites = [];
    const COMPONENT = u.index;
    const sf = program.getSourceFile(u.virtual)!;
    const loc = (n: VNode) => locate(u.original, n.loc?.start.offset ?? 0, u.rel);
    const statements = [...sf.statements].filter(s => s.getStart(sf) < u.scriptLength);
    const pending: (() => void)[] = [];
    const setupBindings = new Map<string, ts.Symbol>();
    // The attrs: an attribute bag the parent passes as the rest props.
    const plan = plans.get(u)!;
    restCell = undefined;
    if (plan.keys.size || plan.sites.length || u.macros.attrsVar) {
      restCell = cells.length;
      cells.push({
        name: '$attrs',
        type: 'attrs',
        init: { op: 'attrs', items: [] },
        prop: '...',
        source: { file: u.rel, line: 1, column: 1 },
      });
    }
    const attrsRead = (): Expr => ({ op: 'cell', cell: restCell!, read: 'current' });

    // Template refs (`ref="name"`), found before setup so writes can be rejected.
    const refAttrs: { element: VNode; attr: VNode }[] = [];
    const scanRefs = (list: VNode[], listed: boolean, slotted: boolean) => {
      for (const n of list) {
        if (n.type !== ELEMENT) continue;
        const inList = listed || !!dir(n, 'for');
        for (const p of n.props) {
          if (p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === 'ref')
            fail(
              'E_REF',
              'Function and dynamic template refs (:ref) are planned for a later milestone; use ref="name"',
              loc(p),
            );
          if (p.type !== ATTRIBUTE || p.name !== 'ref') continue;
          const component = n.tagType === COMPONENT_TAG && !!childName(u, n.tag);
          if ((n.tagType !== PLAIN && !component) || n.tag === 'template')
            fail('E_REF', `ref on <${n.tag}> is unsupported (refs bind elements)`, loc(p));
          if (inList)
            fail(
              'E_REF',
              'Template refs inside v-for collect arrays in Vue (ref_for); planned for a later milestone',
              loc(p),
            );
          if (slotted)
            fail(
              'E_REF',
              'Template refs in slot content are planned for a later milestone (the child may render the content more than once)',
              loc(p),
            );
          if (!p.value?.content) fail('E_REF', 'ref needs a name', loc(p));
          refAttrs.push({ element: n, attr: p });
        }
        const slotContent = n.tagType === COMPONENT_TAG && !!childName(u, n.tag);
        scanRefs(n.children ?? [], inList, slotted || slotContent);
      }
    };
    scanRefs(u.descriptor.template.ast.children, false, false);
    /** Cells of ref()/shallowRef()/useTemplateRef() variables, and useTemplateRef keys. */
    const refVars = new Map<ts.Symbol, number>();
    const refKeys = new Map<string, number>();
    /** The cell each element with `ref="name"` binds. */
    const refOf = new Map<VNode, number>();
    /** The cell each component tag with `ref="name"` binds (its instance). */
    const componentRefOf = new Map<VNode, number>();

    /** A prop default: `withDefaults`/`default:` factories are called for non-function props. */
    const defaultValue = (e: ts.Expression, type: Type, name: string, factory: boolean): Expr => {
      let value = skipParens(e);
      if (factory && !(typeof type === 'object' && 'fn' in type)) {
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
          const body = value.body;
          if (ts.isBlock(body)) {
            const ret = body.statements[0];
            if (body.statements.length !== 1 || !ts.isReturnStatement(ret) || !ret.expression)
              return tsFail(value, 'E_PROPS', 'Default factories return a single expression');
            value = ret.expression;
          } else value = body;
        }
      }
      return coerceInit(
        lower.value(value, COMPONENT, `${name}$default`),
        lower.exprType(value),
        type,
        lower.types.records,
      );
    };

    /** defineProps<T>() (destructured, as an object, or bare) → prop cells. */
    const props = (call: ts.CallExpression, d?: ts.VariableDeclaration) => {
      let define = call;
      let defaults: ts.ObjectLiteralExpression | undefined;
      if (vueCall(call) === 'withDefaults') {
        define = skipParens(call.arguments[0]) as ts.CallExpression;
        const dflt = call.arguments[1] && skipParens(call.arguments[1]);
        if (dflt && !ts.isObjectLiteralExpression(dflt))
          tsFail(dflt, 'E_PROPS', 'withDefaults takes an object literal');
        defaults = dflt as ts.ObjectLiteralExpression | undefined;
      }
      const typeArg = define.typeArguments![0];
      const names = typeMembers(sf, typeArg, (n, m) => tsFail(n, 'E_PROPS', m)).map(m =>
        memberName(m)!,
      );
      const propsType = checker.getTypeFromTypeNode(typeArg);
      const elements = new Map<string, ts.BindingElement>();
      if (d && ts.isObjectBindingPattern(d.name))
        for (const el of d.name.elements) {
          if (el.dotDotDotToken)
            tsFail(el, 'E_PROPS', 'Rest props are planned for a later milestone');
          if (!ts.isIdentifier(el.name))
            tsFail(el, 'E_PROPS', 'Nested prop destructuring is unsupported');
          const key = el.propertyName
            ? ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)
              ? el.propertyName.text
              : tsFail(el, 'E_PROPS', 'Computed prop keys are unsupported')
            : (el.name as ts.Identifier).text;
          if (!names.includes(key)) tsFail(el, 'E_PROPS', `${key} is not a declared prop`);
          elements.set(key, el);
        }
      else if (d && !ts.isIdentifier(d.name))
        tsFail(d, 'E_PROPS', 'Destructure props as const { a, b } = defineProps<T>()');
      const fallbacks = new Map<string, ts.Expression>();
      for (const p of defaults?.properties ?? []) {
        const key =
          ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
            ? p.name.text
            : tsFail(p, 'E_PROPS', 'withDefaults takes `name: value` entries');
        if (!names.includes(key)) tsFail(p, 'E_PROPS', `${key} is not a declared prop`);
        fallbacks.set(key, (p as ts.PropertyAssignment).initializer);
      }
      const values = new Map<string, Expr>();
      for (const name of names) {
        const sym = checker.getPropertyOfType(propsType, name)!;
        let t = checker.getTypeOfSymbolAtLocation(sym, typeArg);
        if (sym.flags & ts.SymbolFlags.Optional)
          t = checker.getNullableType(t, ts.TypeFlags.Undefined);
        const el = elements.get(name);
        const fallback = el?.initializer ?? fallbacks.get(name);
        let type = types.map(t, typeArg);
        if (fallback) type = maybeInner(type) ?? type;
        // Boolean casting: an absent boolean prop is false.
        const boolean = !fallback && (type === 'boolean' || sameType(type, { maybe: 'boolean' }));
        if (boolean) type = 'boolean';
        const cell = cells.length;
        cells.push({
          name: el ? (el.name as ts.Identifier).text : name,
          type,
          init: boolean
            ? { op: 'lit', value: false }
            : maybeInner(type)
              ? { op: 'undefined', type }
              : required(type),
          tracking: isReference(type) ? 'deep' : 'identity',
          prop: name,
          source: sourceOf(el ?? typeArg),
        });
        if (fallback)
          pending.push(() => (cells[cell].init = defaultValue(fallback, type, name, !el)));
        if (el) {
          const s = checker.getSymbolAtLocation(el.name)!;
          lower.bindings.set(s, { kind: 'cell', cell });
          setupBindings.set((el.name as ts.Identifier).text, s);
        }
        values.set(name, { op: 'cell', cell, read: 'current' });
      }
      if (d && ts.isIdentifier(d.name)) {
        const s = checker.getSymbolAtLocation(d.name)!;
        lower.bindings.set(s, { kind: 'props', values });
        setupBindings.set(d.name.text, s);
      }
    };

    /** defineEmits<T>() → `on<Event>` prop cells defaulting to a no-op. */
    const emits = (call: ts.CallExpression, d?: ts.VariableDeclaration) => {
      const alias = sf.statements.find(
        s => ts.isTypeAliasDeclaration(s) && s.name.text === '__RunicEmits',
      ) as ts.TypeAliasDeclaration;
      for (const p of checker.getPropertiesOfType(checker.getTypeAtLocation(alias.name))) {
        const type = types.map(
          checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, alias)),
          call,
        );
        if (typeof type !== 'object' || !('fn' in type))
          return tsFail(call, 'E_EMITS', 'Unexpected emit type');
        const noop = lower.reserve();
        lower.functions[noop] = {
          name: `${p.name}$none`,
          params: type.fn.params.map((t, i) => ({ name: `a${i}`, type: t })),
          locals: [],
          result: 'void',
          body: [],
        };
        emitCells.set(p.name, cells.length);
        cells.push({
          name: p.name,
          type,
          init: { op: 'closure', function: noop, captures: [] },
          tracking: 'identity',
          prop: p.name,
          source: sourceOf(call),
        });
      }
      if (d) {
        const s = checker.getSymbolAtLocation(d.name)!;
        emitSymbols.add(s);
        setupBindings.set((d.name as ts.Identifier).text, s);
      }
    };

    /** defineModel<T>() → a writable prop cell, read and written through `.value`. */
    const model = (call: ts.CallExpression, d: ts.VariableDeclaration) => {
      let [nameArg, options] = call.arguments;
      if (nameArg && !ts.isStringLiteral(nameArg)) [nameArg, options] = [undefined!, nameArg];
      const prop = nameArg ? (nameArg as ts.StringLiteral).text : 'modelValue';
      const name = (d.name as ts.Identifier).text;
      const sym = checker.getSymbolAtLocation(d.name)!;
      const refType = checker.getTypeOfSymbolAtLocation(sym, d) as ts.TypeReference;
      const [inner] = checker.getTypeArguments(refType);
      if (!inner) tsFail(d, 'E_MODEL', 'Unexpected model type');
      const type = types.map(inner, d);
      let fallback: ts.Expression | undefined;
      let isRequired = false;
      for (const p of (options as ts.ObjectLiteralExpression | undefined)?.properties ?? []) {
        const a = p as ts.PropertyAssignment;
        if ((a.name as ts.Identifier).text === 'default') fallback = a.initializer;
        else if (a.initializer.kind === ts.SyntaxKind.TrueKeyword) isRequired = true;
      }
      const cell = cells.length;
      cells.push({
        name,
        type,
        init: isRequired && !fallback ? required(type) : { op: 'undefined', type },
        tracking: isReference(type) ? 'deep' : 'identity',
        prop,
        source: sourceOf(d),
      });
      if (fallback) {
        const f = fallback;
        pending.push(() => (cells[cell].init = defaultValue(f, type, name, true)));
      }
      modelCells.add(cell);
      lower.bindings.set(sym, { kind: 'ref', cell });
      setupBindings.set(name, sym);
    };

    // --- Watchers and lifecycle hooks (docs/design/M4-EFFECTS.md) ---
    /** Effects with their position: onBeforeUnmount first, onBeforeMount last (see `lifecycle`). */
    const effects: { effect: Effect; group: number }[] = [];
    /** Cells of shallowRef() variables and of plain setup constants. */
    const shallowCells = new Set<number>();
    const plainCells = new Set<number>();
    /** The first watcher: Vue runs it where it is declared, Runic after the setup state. */
    let firstWatcher: ts.Node | undefined;
    let effectCount = 0;
    const fnArg = (
      arg: ts.Expression | undefined,
      call: ts.Node,
      kind: string,
      maxParams: number,
    ) => {
      const fn = arg && skipParens(arg);
      if (
        !fn ||
        !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
        fn.parameters.length > maxParams ||
        fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ||
        fn.asteriskToken
      )
        return tsFail(
          call,
          'E_EFFECT',
          maxParams
            ? `${kind} takes an inline synchronous function`
            : `${kind} takes an inline synchronous function without parameters`,
        );
      return fn;
    };
    /** `onCleanup` may only be called as a statement (it is not a value in Runic). */
    const cleanupParam = (p: ts.ParameterDeclaration | undefined, fn: ts.Node) => {
      if (!p) return;
      if (!ts.isIdentifier(p.name) || p.initializer)
        tsFail(p, 'E_EFFECT', 'The onCleanup parameter is a plain name');
      const sym = checker.getSymbolAtLocation(p.name)!;
      cleanupParams.add(sym);
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n !== p.name && checker.getSymbolAtLocation(n) === sym) {
          const call = n.parent;
          if (
            !ts.isCallExpression(call) ||
            call.expression !== n ||
            !(
              ts.isExpressionStatement(call.parent) ||
              (ts.isArrowFunction(call.parent) && call.parent.body === call)
            )
          )
            tsFail(n, 'E_EFFECT', `${n.text} is supported as a call statement: ${n.text}(() => …)`);
        }
        ts.forEachChild(n, visit);
      };
      visit(fn);
    };
    /** A watcher or hook function, lowered with its cleanups collected. */
    const effectFn = (
      fn: ts.ArrowFunction | ts.FunctionExpression,
      kind: string,
      reserved: number,
      drop?: number,
    ) => {
      const name = `${kind}$${COMPONENT}$${effectCount++}`;
      effectRoots.set(name, { watcher: kind === 'watch' || kind === 'watchEffect' });
      const { builder } = lower.function(fn, name, undefined, COMPONENT, reserved, undefined, {
        tupleParams: true,
      });
      finishEffect(reserved, builder, drop);
    };
    /** A watch source as a value expression of the component. */
    const watchSource = (e: ts.Expression, multi: boolean): Expr => {
      e = skipParens(e);
      if (ts.isIdentifier(e)) {
        const b = lower.binding(e);
        if (b?.kind === 'ref') {
          if (templateRefCells.has(b.cell))
            tsFail(
              e,
              'E_EFFECT',
              'Watching a template ref is planned for a later milestone (Vue sets it in the post flush)',
            );
          if (shallowCells.has(b.cell))
            tsFail(
              e,
              'E_EFFECT',
              `Watch a shallowRef through a getter: () => ${e.text}.value (Vue calls the callback of a shallowRef source on every trigger${multi ? ', and of every source in its array' : ''}, even when the value is unchanged)`,
            );
          return { op: 'cell', cell: b.cell, read: 'current' };
        }
        if (b?.kind === 'computed') return { op: 'call', function: b.fn, args: [] };
        return tsFail(
          e,
          'E_EFFECT',
          `${e.text} is not a ref or computed: watch a getter (() => …) instead${b?.kind === 'props' ? ' (reactive objects are watched deeply; planned for a later milestone)' : ''}`,
        );
      }
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
        if (e.parameters.length || e.modifiers?.length)
          tsFail(e, 'E_EFFECT', 'Watch getters are synchronous functions without parameters');
        // Runic evaluates the getter whenever its component updates, Vue only
        // when a reactive dependency changed: getters must be pure reads of
        // reactive state.
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
            const callee = n.expression;
            const sym = ts.isIdentifier(callee) ? lower.symbol(callee) : undefined;
            const file = sym?.declarations?.[0]?.getSourceFile();
            if (ts.isIdentifier(callee) && !(file && program.isSourceFileDefaultLibrary(file)))
              tsFail(
                n,
                'E_EFFECT',
                'Watch getters read reactive state without calling functions (Runic re-evaluates them at every update of the component, Vue only when a dependency changed)',
              );
          }
          if (ts.isIdentifier(n)) {
            const b = lower.binding(n);
            const plain =
              (b?.kind === 'cell' && plainCells.has(b.cell)) ||
              (b?.kind === 'value' && b.expr.op === 'global');
            if (plain)
              tsFail(
                n,
                'E_EFFECT',
                `${n.text} is not reactive: Vue does not re-run the getter when it changes`,
              );
          }
          ts.forEachChild(n, visit);
        };
        visit(e.body);
        const index = lower.reserve();
        lower.function(e, `watch$source`, undefined, COMPONENT, index);
        return { op: 'call', function: index, args: [] };
      }
      return tsFail(
        e,
        'E_EFFECT',
        'Watch sources are refs, computeds, getters (() => …) or arrays of these (reactive objects are planned for a later milestone)',
      );
    };
    /** Coerce a value between T and Maybe<T>. */
    const coerceTo = (v: Expr, from: Type, to: Type, at: ts.Node): Expr => {
      if (sameType(from, to)) return v;
      if (maybeInner(to) && sameType(maybeInner(to)!, from)) return { op: 'some', value: v };
      if (maybeInner(from) && sameType(maybeInner(from)!, to)) return { op: 'unwrap', value: v };
      return tsFail(at, 'E_EFFECT', 'The callback parameter types do not match the watch sources');
    };
    const watch = (call: ts.CallExpression, source: Source): Effect => {
      const [src, cb, options] = call.arguments;
      if (!src || !cb || call.arguments.length > 3)
        tsFail(call, 'E_EFFECT', 'watch takes a source, a callback and options');
      let immediate = false;
      if (options) {
        const o = skipParens(options);
        if (!ts.isObjectLiteralExpression(o))
          return tsFail(options, 'E_EFFECT', 'watch options are an object literal');
        for (const p of o.properties) {
          const key =
            ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
              ? p.name.text
              : tsFail(p, 'E_EFFECT', 'watch options are `name: value` entries');
          const v = skipParens((p as ts.PropertyAssignment).initializer);
          const K = ts.SyntaxKind;
          if (key === 'immediate' && (v.kind === K.TrueKeyword || v.kind === K.FalseKeyword))
            immediate = v.kind === K.TrueKeyword;
          else if (key === 'flush' && ts.isStringLiteral(v) && v.text === 'pre') {
            // The default.
          } else if (key === 'flush')
            tsFail(
              p,
              'E_EFFECT',
              "flush: 'post' and 'sync' watchers are planned for a later milestone (post watchers run in insertion order, sync watchers inside every write)",
            );
          else if (key === 'deep')
            tsFail(p, 'E_EFFECT', 'Deep watchers are planned for a later milestone');
          else if (key === 'once')
            tsFail(p, 'E_EFFECT', 'once watchers are planned for a later milestone');
          else if (key === 'immediate')
            tsFail(p, 'E_EFFECT', 'immediate is a literal true or false');
          else tsFail(p, 'E_EFFECT', `watch option ${key} is unsupported`);
        }
      }
      const fn = fnArg(cb, call, 'watch', 3);
      const s = skipParens(src);
      const multi = ts.isArrayLiteralExpression(s);
      if (multi && s.elements.some(el => ts.isSpreadElement(el)))
        tsFail(s, 'E_EFFECT', 'Spread watch sources are unsupported');
      const sources = multi ? [...s.elements] : [s];
      if (multi)
        for (const p of fn.parameters.slice(0, 2))
          if (!ts.isArrayBindingPattern(p.name))
            tsFail(
              p,
              'E_EFFECT',
              'Destructure the values of an array of watch sources: ([a, b], [oldA, oldB]) => …',
            );
      cleanupParam(fn.parameters[2], fn);
      const run = lower.reserve();
      const values: Expr[] = [];
      pending.push(() => {
        values.push(...sources.map(e => watchSource(e, multi)));
        const types = values.map(v => lower.valueType(v));
        const inner = fn.parameters.length ? lower.reserve() : run;
        // The callback's own parameters: values, old values (flattened for arrays), onCleanup.
        const width = multi ? sources.length : 1;
        const given = Math.min(fn.parameters.length, 2) * width;
        effectFn(fn, 'watch', inner, fn.parameters.length === 3 ? given : undefined);
        if (inner === run) return;
        const f = lower.functions[inner];
        const n = types.length;
        const params: Local[] = [
          ...types.map((t, i) => ({ name: `value${i}`, type: t })),
          ...types.map((t, i) => ({ name: `old${i}`, type: maybeInner(t) ? t : { maybe: t } })),
        ];
        // Values, then old values (the callback may take fewer).
        const args = f.params.map((p, i) =>
          coerceTo(L(i), params[i].type, p.type, fn.parameters[i < n ? 0 : 1]),
        );
        const callInner: Expr = { op: 'call', function: inner, args };
        lower.functions[run] = {
          name: 'watch',
          component: COMPONENT,
          params,
          locals: [],
          result: f.result,
          body: [
            f.result === 'void'
              ? { op: 'expr', value: callInner }
              : { op: 'return', value: callInner },
          ],
          ...(f.source ? { source: f.source } : {}),
        };
      });
      return {
        run,
        phase: 'pre',
        deps: { kind: 'values', values, initial: immediate },
        unmount: { removal: 'before', order: 'pre' },
        source,
      };
    };
    /**
     * A top-level watcher or lifecycle hook. Vue unmounts a component by
     * calling its onBeforeUnmount hooks, stopping its watchers (their
     * cleanups) and unmounting its children, then runs onUnmounted after the
     * DOM is removed, children first. onBeforeMount runs after setup (and so
     * after the first runs of watchers), before the first render.
     */
    const lifecycle = (stmt: ts.Statement, call: ts.CallExpression, kind: string) => {
      const source = sourceOf(stmt);
      if (kind === 'watch' || kind === 'watchEffect') firstWatcher ??= stmt;
      if (kind === 'watch') {
        effects.push({ effect: watch(call, source), group: 1 });
        return;
      }
      if (kind === 'watchEffect') {
        if (call.arguments.length > 2)
          tsFail(call, 'E_EFFECT', 'watchEffect takes a function and options');
        const options = call.arguments[1] && skipParens(call.arguments[1]);
        if (options) {
          const ok =
            ts.isObjectLiteralExpression(options) &&
            options.properties.every(
              p =>
                ts.isPropertyAssignment(p) &&
                ts.isIdentifier(p.name) &&
                p.name.text === 'flush' &&
                ts.isStringLiteral(p.initializer) &&
                p.initializer.text === 'pre',
            );
          if (!ok)
            tsFail(
              options,
              'E_EFFECT',
              "watchEffect options other than flush: 'pre' are planned for a later milestone (post watchers run in insertion order, sync watchers inside every write)",
            );
        }
        const fn = fnArg(call.arguments[0], call, kind, 1);
        cleanupParam(fn.parameters[0], fn);
        const run = lower.reserve();
        pending.push(() => effectFn(fn, kind, run, fn.parameters.length ? 0 : undefined));
        effects.push({
          effect: {
            run,
            phase: 'pre',
            deps: { kind: 'tracked' },
            unmount: { removal: 'before', order: 'pre' },
            source,
          },
          group: 1,
        });
        return;
      }
      if (call.arguments.length !== 1)
        tsFail(call, 'E_EFFECT', `${kind} takes one function (lifecycle targets are unsupported)`);
      const fn = fnArg(call.arguments[0], call, kind, 0);
      const run = lower.reserve();
      if (kind === 'onBeforeUnmount' || kind === 'onUnmounted') {
        // A hook run at unmount: an effect that runs once and returns it as its cleanup.
        const f = lower.reserve();
        pending.push(() => {
          effectFn(fn, kind, f);
          lower.functions[run] = {
            name: `${kind}$effect`,
            component: COMPONENT,
            params: [],
            locals: [],
            result: CLEANUP,
            body: [{ op: 'return', value: { op: 'closure', function: f, captures: [] } }],
          };
        });
        effects.push({
          effect: {
            run,
            phase: 'post',
            deps: { kind: 'once' },
            unmount:
              kind === 'onBeforeUnmount'
                ? { removal: 'before', order: 'pre' }
                : { removal: 'after', order: 'post' },
            source,
          },
          group: kind === 'onBeforeUnmount' ? 0 : 1,
        });
        return;
      }
      pending.push(() => effectFn(fn, kind, run));
      effects.push({
        effect: {
          run,
          phase: kind === 'onBeforeMount' ? 'pre' : 'post',
          deps: { kind: 'once' },
          unmount: { removal: 'after', order: 'post' },
          source,
        },
        group: kind === 'onBeforeMount' ? 2 : 1,
      });
    };

    // --- Setup bindings ---
    for (const stmt of statements) {
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (stmt.importClause?.isTypeOnly) continue;
        if (spec === 'vue') {
          const named = stmt.importClause?.namedBindings;
          if (named && ts.isNamedImports(named))
            for (const el of named.elements) {
              const n = (el.propertyName ?? el.name).text;
              if (UNSUPPORTED_VUE[n]) tsFail(el, 'E_CAPABILITY', UNSUPPORTED_VUE[n]);
              if (
                ![
                  'ref',
                  'computed',
                  'shallowRef',
                  'useTemplateRef',
                  'useAttrs',
                  'onWatcherCleanup',
                  'nextTick',
                ].includes(n) &&
                !LIFECYCLE.has(n)
              )
                tsFail(el, 'E_CAPABILITY', `vue:${n} is planned for a later milestone`);
            }
          continue;
        }
        if (spec.endsWith('.vue')) continue;
        bindPackImport(
          stmt,
          graph.modules.get(u.file)!.imports.find(i => i.specifier === spec),
          lower,
        );
        continue;
      }
      if (ts.isClassDeclaration(stmt)) {
        pending.push(...lower.classes.declare(stmt, COMPONENT));
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
      if (ts.isExpressionStatement(stmt)) {
        const e = skipParens(stmt.expression);
        const kind = vueCall(e);
        if (kind === 'defineProps') props(e as ts.CallExpression);
        else if (kind === 'defineEmits') emits(e as ts.CallExpression);
        else if (kind === 'defineSlots' || kind === 'defineOptions' || kind === 'defineExpose') {
          // Types only (read through __RunicSlots); options and the exposed
          // refs were read when parsing.
        } else if (kind && LIFECYCLE.has(kind)) lifecycle(stmt, e as ts.CallExpression, kind);
        else
          tsFail(
            stmt,
            'E_STATEMENT',
            'Setup supports const declarations, functions, watchers, lifecycle hooks and imports from vue',
          );
        continue;
      }
      if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & ts.NodeFlags.Const) {
        for (const d of stmt.declarationList.declarations) {
          // Intl and pack constants have no runtime value (their uses are lowered).
          if (lower.isIntlConstant(d) || lower.isPackConstant(d)) continue;
          const init = d.initializer && skipParens(d.initializer);
          const kind = vueCall(init);
          if (kind === 'defineProps' || kind === 'withDefaults') {
            props(init as ts.CallExpression, d);
            continue;
          }
          if (kind === 'defineEmits') {
            emits(init as ts.CallExpression, d);
            continue;
          }
          if (kind && LIFECYCLE.has(kind))
            tsFail(
              init!,
              'E_EFFECT',
              kind.startsWith('watch')
                ? 'Watch handles (stop, pause, resume) are planned for a later milestone; call watch as a statement'
                : `${kind} is a statement`,
            );
          if (firstWatcher)
            tsFail(
              d,
              'E_EFFECT',
              `Declare setup state and functions before the first watcher (line ${sourceOf(firstWatcher).line}): Vue runs a watcher where it is declared, Runic after the component's setup state`,
            );
          if (kind === 'defineModel') {
            model(init as ts.CallExpression, d);
            continue;
          }
          if (kind === 'useAttrs') {
            // The attrs object, forwarded with v-bind (read by name: rejected).
            if ((init as ts.CallExpression).arguments.length || !ts.isIdentifier(d.name))
              tsFail(d, 'E_ATTRS', 'Call useAttrs once, as const attrs = useAttrs()');
            const sym = checker.getSymbolAtLocation(d.name)!;
            setupBindings.set((d.name as ts.Identifier).text, sym);
            lower.bindings.set(sym, { kind: 'cell', cell: restCell! });
            continue;
          }
          if (kind === 'defineSlots') {
            // `slots.x` in setup (render functions) is planned for later; the
            // template's slot outlets are typed through __RunicSlots.
            if (ts.isIdentifier(d.name))
              setupBindings.set(d.name.text, checker.getSymbolAtLocation(d.name)!);
            continue;
          }
          if (!ts.isIdentifier(d.name) || !init)
            tsFail(d, 'E_DECLARATION', 'Destructuring is supported for defineProps only');
          const name = (d.name as ts.Identifier).text;
          const sym = checker.getSymbolAtLocation(d.name)!;
          setupBindings.set(name, sym);
          if (kind === 'ref' || kind === 'shallowRef') {
            const call = init as ts.CallExpression;
            const refType = checker.getTypeOfSymbolAtLocation(sym, d) as ts.TypeReference;
            const [inner] = checker.getTypeArguments(refType);
            if (!inner) tsFail(d, 'E_REF', 'Unexpected ref type');
            const type = types.map(inner, d);
            if (kind === 'ref') rawThisCheck(type, d);
            const cell = cells.length;
            cells.push({
              name,
              type,
              init: { op: 'undefined', type },
              // A primitive changes only through `.value`, so identity is exact.
              tracking: kind === 'ref' && isReference(type) ? 'deep' : 'identity',
              source: sourceOf(d),
            });
            if (kind === 'shallowRef') shallowCells.add(cell);
            lower.bindings.set(sym, { kind: 'ref', cell });
            refVars.set(sym, cell);
            pending.push(() => {
              const arg = call.arguments[0];
              if (!arg) return;
              // The IR type of the lowered value (a bare `null` takes the ref's type).
              const v = lower.value(arg, COMPONENT, `${name}$init`);
              cells[cell].init = coerceInit(v, lower.valueType(v), type, lower.types.records);
            });
            continue;
          }
          if (kind === 'useTemplateRef') {
            // A shallowRef(null) that Vue writes through `refs[key]`.
            const [key, extra] = (init as ts.CallExpression).arguments;
            if (!key || extra || !ts.isStringLiteralLike(key))
              tsFail(
                init!,
                'E_REF',
                'useTemplateRef takes a literal key: useTemplateRef<T>("name")',
              );
            const k = (key as ts.StringLiteralLike).text;
            if (refKeys.has(k))
              tsFail(key, 'E_REF', `useTemplateRef("${k}") is declared twice (Vue throws)`);
            const typeArg = (init as ts.CallExpression).typeArguments?.[0];
            let type: Type = { maybe: 'element' };
            // A component ref: the instance's exposed refs, InstanceType<typeof Child>.
            const instance = refAttrs.some(
              r => r.attr.value?.content === k && r.element.tagType === COMPONENT_TAG,
            );
            if (instance) {
              const t = typeArg && types.map(checker.getTypeFromTypeNode(typeArg), typeArg);
              if (!t || typeof t !== 'object' || !('record' in t))
                tsFail(
                  typeArg ?? init!,
                  'E_REF',
                  `A component ref takes the component's instance type: useTemplateRef<InstanceType<typeof Child>>("${k}")`,
                );
              type = { maybe: t as Type };
            }
            // DOM element interfaces (frontend/dom.d.ts) carry `__runicElement`.
            else if (
              !typeArg ||
              !checker.getTypeFromTypeNode(typeArg).getProperty('__runicElement')
            )
              tsFail(
                init!,
                'E_REF',
                `useTemplateRef needs an element type argument: useTemplateRef<HTMLInputElement>("${k}")`,
              );
            const cell = cells.length;
            cells.push({
              name,
              type,
              init: { op: 'null', type },
              tracking: 'identity',
              source: sourceOf(d),
            });
            lower.bindings.set(sym, { kind: 'ref', cell });
            refVars.set(sym, cell);
            refKeys.set(k, cell);
            continue;
          }
          if (kind === 'computed') {
            const getter = (init as ts.CallExpression).arguments[0];
            if (!getter || !(ts.isArrowFunction(getter) || ts.isFunctionExpression(getter)))
              tsFail(init!, 'E_COMPUTED', 'computed takes a getter function');
            const index = lower.reserve();
            lower.bindings.set(sym, { kind: 'computed', fn: index });
            computedFns.add(index);
            pending.push(() => {
              lower.function(getter as ts.ArrowFunction, name, undefined, COMPONENT, index);
              lower.functions[index].derived = true;
            });
            continue;
          }
          if (ts.isArrowFunction(init!) || ts.isFunctionExpression(init!)) {
            const p = lower.declare(sym, init, name, COMPONENT);
            if (p) pending.push(p);
            continue;
          }
          // A setup constant, captured once.
          const cell = cells.length;
          const type = lower.exprType(init!);
          cells.push({
            name,
            type,
            init: { op: 'undefined', type },
            tracking: 'identity',
            source: sourceOf(d),
          });
          lower.bindings.set(sym, { kind: 'cell', cell });
          plainCells.add(cell);
          pending.push(() => (cells[cell].init = lower.value(init!, COMPONENT, `${name}$init`)));
        }
        continue;
      }
      tsFail(
        stmt,
        'E_STATEMENT',
        'Setup supports const declarations, functions, watchers, lifecycle hooks and imports from vue',
      );
    }
    // `ref="name"` binds the setup ref `name` (compiled to ref_key) and the
    // useTemplateRef with key `name` (through `refs[name]`).
    for (const { element, attr } of refAttrs) {
      const name: string = attr.value.content;
      const own = setupBindings.get(name);
      const byName = own && refVars.get(own);
      const byKey = refKeys.get(name);
      if (own && byName === undefined)
        fail(
          'E_REF',
          `${name} is not a ref: template refs bind ref()/shallowRef()/useTemplateRef() declarations`,
          loc(attr),
        );
      if (byName !== undefined && byKey !== undefined && byName !== byKey)
        fail(
          'E_REF',
          `ref="${name}" names a ref and the key of another useTemplateRef (Vue versions bind it differently)`,
          loc(attr),
        );
      const cell =
        byName ??
        byKey ??
        fail(
          'E_REF',
          `No ref() or useTemplateRef("${name}") declares the template ref ${name}`,
          loc(attr),
        );
      if (element.tagType === COMPONENT_TAG) {
        // A component ref: the instance, through which the parent reaches the
        // template ref the child exposes. That element is mounted exactly
        // while the instance is, so the ref holds a record of it while both
        // are mounted (one record per mount, like Vue's exposed proxy).
        const child = units.get(u.children.get(childName(u, element.tag)!)!)!;
        const exposed = exposedOf[child.index];
        if (!exposed)
          fail(
            'E_REF',
            `${element.tag} exposes no template ref: component refs reach what the child exposes with defineExpose({ input })`,
            loc(attr),
          );
        const t = cells[cell].type;
        const rec = maybeInner(t);
        const fields =
          rec && typeof rec === 'object' && 'record' in rec
            ? types.records[rec.record].fields
            : undefined;
        if (
          !fields ||
          fields.length !== 1 ||
          fields[0].name !== exposed!.key ||
          !sameType(fields[0].type, { maybe: 'element' })
        )
          fail(
            'E_REF',
            `Template ref ${name} needs the component's instance type: useTemplateRef<InstanceType<typeof ${element.tag}>>("${name}")`,
            loc(attr),
          );
        if (templateRefCells.has(cell))
          fail('E_REF', `${cells[cell].name} is bound twice`, loc(attr));
        templateRefCells.add(cell);
        componentRefOf.set(element, cell);
        continue;
      }
      if (!sameType(cells[cell].type, { maybe: 'element' }))
        fail(
          'E_REF',
          `Template ref ${name} needs an element type: ref<HTMLInputElement | null>(null) or useTemplateRef<HTMLInputElement>("${name}")`,
          loc(attr),
        );
      if (templateRefCells.has(cell))
        fail(
          'E_REF',
          `${cells[cell].name} is bound by two elements (Vue keeps the last mounted one); one element per template ref is supported`,
          loc(attr),
        );
      templateRefCells.add(cell);
      refOf.set(element, cell);
    }
    templateRefsOf[COMPONENT] = { cells: templateRefCells, reads: refReadSites };
    // defineExpose({ input }): an element template ref the parent's component
    // ref reaches, forwarded through a bound prop (Vue sets both refs in the
    // same post flush and clears them when the instance unmounts).
    if (u.macros.expose) {
      const [first, ...more] = u.macros.expose;
      if (!first || more.length)
        fail(
          'E_EXPOSE',
          'defineExpose with one template ref is supported (more members are planned for later)',
          more[0]?.at ?? { file: u.rel, line: 1, column: 1 },
        );
      const sym = setupBindings.get(first.name);
      const cell = sym && refVars.get(sym);
      const bound = [...refOf].find(([, c]) => c === cell)?.[0];
      if (cell === undefined || !bound)
        fail(
          'E_EXPOSE',
          `${first.name} is not an element template ref (defineExpose supports template refs)`,
          first.at,
        );
      // Mounted exactly while the instance is: outside v-if branches.
      const unconditional = (list: VNode[]): boolean =>
        list.some(
          (n: VNode) =>
            n.type === ELEMENT &&
            !dir(n, 'if') &&
            !dir(n, 'else-if') &&
            !dir(n, 'else') &&
            (n === bound || (n.tagType === PLAIN && unconditional(n.children))),
        );
      if (!unconditional(u.descriptor.template.ast.children))
        fail(
          'E_EXPOSE',
          `The exposed ${first.name} is bound inside v-if: a parent's component ref would see an instance without it`,
          first.at,
        );
      const prop = `$expose.${first.key}`;
      cells[cell!].prop = prop;
      exposedOf[COMPONENT] = { key: first.key, prop };
    }
    for (const p of pending) p();

    // Template-scope bindings: unwrapped setup bindings, props, $emit.
    const templateFn = sf.statements.find(
      s => ts.isFunctionDeclaration(s) && s.name?.text === '__runic_template',
    ) as ts.FunctionDeclaration;
    const propCells = new Map<string, number>();
    cells.forEach((c, i) => c.prop !== undefined && propCells.set(c.prop, i));
    for (const stmt of templateFn.body!.statements) {
      if (!ts.isVariableStatement(stmt)) break;
      const d = stmt.declarationList.declarations[0];
      const from = d.initializer && ts.isIdentifier(d.initializer) ? d.initializer.text : '';
      if (ts.isObjectBindingPattern(d.name))
        for (const el of d.name.elements) {
          const name = (el.name as ts.Identifier).text;
          const sym = checker.getSymbolAtLocation(el.name)!;
          if (from === '__runic_P') {
            lower.bindings.set(sym, { kind: 'cell', cell: propCells.get(name)! });
            continue;
          }
          const setup = setupBindings.get(name);
          if (setup && emitSymbols.has(setup)) emitSymbols.add(sym);
          const binding = setup && lower.bindings.get(setup);
          if (binding?.kind === 'ref')
            lower.bindings.set(sym, { kind: 'cell', cell: binding.cell });
          else if (binding?.kind === 'computed')
            lower.bindings.set(sym, { kind: 'derived', fn: binding.fn });
          else if (binding) lower.bindings.set(sym, binding);
        }
      else if (ts.isIdentifier(d.name) && d.name.text === '$emit')
        emitSymbols.add(checker.getSymbolAtLocation(d.name)!);
    }

    // --- Slots: declared by defineSlots or inferred from the <slot> outlets ---
    const slotDecls = new Map<string, { names: string[]; types: Type[] }>();
    {
      const alias = sf.statements.find(
        s => ts.isTypeAliasDeclaration(s) && s.name.text === '__RunicSlots',
      ) as ts.TypeAliasDeclaration;
      const define = statements
        .flatMap(s =>
          ts.isExpressionStatement(s)
            ? [s.expression]
            : ts.isVariableStatement(s)
              ? s.declarationList.declarations.map(d => d.initializer)
              : [],
        )
        .find(e => e && vueCall(skipParens(e)) === 'defineSlots');
      /** The first outlet of a slot (where inferred types are reported). */
      const outletOf = (list: VNode[], name: string): VNode | undefined => {
        for (const n of list) {
          if (n.type !== ELEMENT) continue;
          if (
            n.tagType === SLOT_TAG &&
            (n.props.find((p: VNode) => p.type === ATTRIBUTE && p.name === 'name')?.value
              ?.content ?? 'default') === name
          )
            return n;
          const inner = outletOf(n.children ?? [], name);
          if (inner) return inner;
        }
        return undefined;
      };
      for (const slot of checker.getPropertiesOfType(checker.getTypeAtLocation(alias.name))) {
        const at = define ?? alias;
        const relocate = <T>(f: () => T): T => {
          if (define) return f();
          try {
            return f();
          } catch (e) {
            const outlet = outletOf(u.descriptor.template.ast.children, slot.name);
            if (e instanceof Diagnostic && outlet)
              throw new Diagnostic(
                (e as Diagnostic & { code: string }).code,
                `Slot ${slot.name}: ${e.message}`,
                loc(outlet),
              );
            throw e;
          }
        };
        const fn = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(slot, alias));
        const [sig] = fn.getCallSignatures();
        if (!sig)
          tsFail(
            at,
            'E_SLOTS',
            `Declare slot ${slot.name} as a function: ${slot.name}(props: { … }): any`,
          );
        const names: string[] = [];
        const params: Type[] = [];
        const param = sig.parameters[0];
        if (param) {
          const propsType = checker.getTypeOfSymbolAtLocation(param, alias);
          for (const p of checker.getPropertiesOfType(propsType)) {
            let t = checker.getTypeOfSymbolAtLocation(p, alias);
            if (p.flags & ts.SymbolFlags.Optional)
              t = checker.getNullableType(t, ts.TypeFlags.Undefined);
            names.push(p.name);
            params.push(relocate(() => types.map(t, at)));
          }
        }
        slotDecls.set(slot.name, { names, types: params });
      }
      slotProps[COMPONENT] = new Map([...slotDecls].map(([k, d]) => [k, d.names]));
    }

    // --- Template ---
    const tb: FnBuilder = lower.template(COMPONENT);
    const handlers: Handler[] = [];
    /** Text controls whose value Vue patches at every re-render. */
    const restoreElements: VNode[] = [];
    /** Nesting of slot content being lowered. */
    let slotDepth = 0;
    /** The TS node of a template expression by its synthetic span. */
    const nodeAt = (key: VNode): ts.Node => {
      const span = u.starts.get(key);
      if (!span) return fail('E_INTERNAL', 'Template expression not mapped', loc(key));
      const [start, end] = span;
      let found: ts.Node | undefined;
      const walk = (x: ts.Node) => {
        if (found) return;
        if (x.getStart(sf) === start && x.end === end) {
          found = x;
          return;
        }
        if (x.getStart(sf) <= start && x.end >= end) ts.forEachChild(x, walk);
      };
      walk(sf);
      return found ?? fail('E_INTERNAL', 'Template expression not found', loc(key));
    };
    const exprNode = (e: VNode) => nodeAt(e) as ts.Expression;
    const value = (e: ts.Expression): Expr => lower.expr(e, tb);
    const typeOf = (v: Expr): Type => lower.irType(v, tb);
    const display = (e: ts.Expression): Expr => {
      // toDisplayString: nullish → '', arrays/objects → JSON with 2 spaces.
      const v = value(e);
      const t = typeOf(v);
      if (t === 'string') return v;
      if (t === 'number' || t === 'boolean') return { op: 'to-string', arg: v };
      if (typeof t === 'object' && ('array' in t || 'record' in t))
        return {
          op: 'builtin',
          name: 'JSON.stringify',
          args: [v, { op: 'undefined', type: { maybe: 'number' } }, { op: 'lit', value: 2 }],
          type: 'string',
        };
      const inner = maybeInner(t);
      if (inner === 'string' || inner === 'number' || inner === 'boolean')
        return maybeText(lower, v, t);
      return fail('E_TEMPLATE', `Interpolating ${JSON.stringify(t)} is unsupported`, sourceOf(e));
    };
    const condition = (e: ts.Expression): Expr => {
      const v = value(e);
      return typeOf(v) === 'boolean' ? v : { op: 'to-boolean', arg: v };
    };
    const setupDecl = (name: string): ts.FunctionLikeDeclaration | undefined => {
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
    const handlerFor = (p: VNode, event: HandlerEvent): Part => {
      // A listener with modifiers only (`@click.stop`): Vue's `() => {}`.
      if (!p.exp?.content.trim()) return { body: [], source: loc(p) };
      const e = skipParens(exprNode(p.exp));
      let h: Part;
      /** Arguments for a function called with the event: none, or the event object. */
      const eventArgs = (params: Type[]): Expr[] | undefined =>
        params.length === 0
          ? []
          : params.length === 1 && params[0] === 'event'
            ? [{ op: 'event' }]
            : undefined;
      const misfit = 'Event handlers take no parameter or the event object';
      // Vue catches a promise a listener returns (callWithAsyncErrorHandling).
      const returned = (p: Expr) => lower.loggedRejection(p, COMPONENT);
      const caught = (call: Expr, result: Type | undefined): Expr =>
        typeof result === 'object' && 'promise' in result ? returned(call) : call;
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
        h = lower.handler(e, COMPONENT, event, tb, returned);
      else if (ts.isIdentifier(e)) {
        const b = lower.binding(e);
        if (b?.kind === 'function') {
          // A method handler is called with the event (Vue passes it to every handler).
          const args = eventArgs(lower.functions[b.fn]?.params.map(q => q.type) ?? []);
          if (!args) return tsFail(e, 'E_EVENT', misfit);
          const call: Expr = { op: 'call', function: b.fn, args };
          h = { body: [{ op: 'expr', value: caught(call, lower.functions[b.fn]?.result) }] };
        } else if (b?.kind === 'generic') {
          // An untyped method handler: its body is lowered with the event parameter.
          const decl = setupDecl(e.text);
          if (decl && decl.parameters.length)
            h = lower.handler(decl, COMPONENT, event, undefined, returned);
          else return tsFail(e, 'E_EVENT', 'Unsupported handler');
        } else if (b?.kind === 'cell') {
          // A function-valued prop or ref: called with the event.
          const t = cells[b.cell].type;
          if (typeof t !== 'object' || !('fn' in t))
            return tsFail(e, 'E_EVENT', 'Event handlers must be functions');
          const args = eventArgs(t.fn.params);
          if (!args) return tsFail(e, 'E_EVENT', misfit);
          const call: Expr = { op: 'call-value', callee: { op: 'cell', cell: b.cell }, args };
          h = { body: [{ op: 'expr', value: caught(call, t.fn.result) }] };
        } else return tsFail(e, 'E_EVENT', 'Event handlers must be functions');
      } else return tsFail(e, 'E_EVENT', 'Unsupported event handler');
      return { ...h, source: loc(p) };
    };
    /**
     * Whether a listener may call stopImmediatePropagation: itself, in a
     * function it calls, or through a function value it passes the event to.
     */
    const mayStopImmediately = (part: Part): boolean => {
      const seen = new Set<number>();
      let found = false;
      /** Visit `x` in a function whose local index space has `types`. */
      const visit = (x: unknown, types: Type[]): void => {
        if (found || !x || typeof x !== 'object') return;
        if (Array.isArray(x)) return x.forEach(y => visit(y, types));
        const o = x as Record<string, unknown>;
        const isEvent = (a: Expr) =>
          a.op === 'event' || (a.op === 'local' && types[a.local] === 'event');
        if (
          (o.op === 'builtin' && o.name === 'event.stopImmediatePropagation') ||
          (o.op === 'call-value' && (o.args as Expr[]).some(isEvent))
        ) {
          found = true;
          return;
        }
        if ((o.op === 'call' || o.op === 'closure') && typeof o.function === 'number') {
          const f = lower.functions[o.function];
          if (f && !seen.has(o.function)) {
            seen.add(o.function);
            const space = [...(f.captures ?? []), ...f.params, ...f.locals].map(l => l.type);
            visit(f.body, space);
          }
        }
        for (const v of Object.values(o)) visit(v, types);
      };
      visit(
        part.body,
        [...(part.params ?? []), ...(part.locals ?? [])].map(l => l.type),
      );
      return found;
    };
    /** Fit a value to a prop type (T → Maybe<T>). */
    const fit = (v: Expr, want: Type, what: string, at: VNode): Expr => {
      const t = typeOf(v);
      if (sameType(t, want)) return v;
      if (maybeInner(want) && sameType(maybeInner(want)!, t)) return { op: 'some', value: v };
      return fail(
        'E_PROPS',
        `${what} expects ${JSON.stringify(want)} but receives ${JSON.stringify(t)}${maybeInner(t) ? ' (an undefined value does not select the default)' : ''}`,
        loc(at),
      );
    };
    /**
     * A listener for an emit of type `want`. Vue calls it with all emitted
     * arguments, so a function taking fewer of them (or returning a value) is
     * wrapped.
     */
    const listenerFn = (v: Expr, want: Type, at: VNode): Expr => {
      const from = typeOf(v);
      if (sameType(from, want)) return v;
      const f = typeof from === 'object' && 'fn' in from ? from.fn : undefined;
      const w = (want as { fn: { params: Type[]; result: Type } }).fn;
      if (
        !f ||
        f.params.length > w.params.length ||
        f.params.some((p, i) => !sameType(p, w.params[i]))
      )
        return fail(
          'E_EVENT',
          `The listener has type ${JSON.stringify(from)}; the event passes ${JSON.stringify(w.params)}`,
          loc(at),
        );
      let captures: Local[] = [];
      let sources: number[] = [];
      let callee: Expr = v;
      if (v.op === 'closure') {
        captures = lower.functions[v.function].captures ?? [];
        sources = v.captures;
        callee = { op: 'closure', function: v.function, captures: captures.map((_, i) => i) };
      } else if (JSON.stringify(v).includes('"op":"local"'))
        return fail('E_EVENT', 'Use an arrow function for this listener', loc(at));
      const index = lower.reserve();
      lower.functions[index] = {
        name: 'listener',
        component: COMPONENT,
        ...(captures.length ? { captures } : {}),
        params: w.params.map((type, i) => ({ name: `a${i}`, type })),
        locals: [],
        result: 'void',
        body: [
          {
            op: 'expr',
            // Vue's emit catches a promise the listener returns.
            value: ((call: Expr) =>
              typeof f.result === 'object' && 'promise' in f.result
                ? lower.loggedRejection(call, COMPONENT)
                : call)({
              op: 'call-value',
              callee,
              args: f.params.map((_, i): Expr => ({ op: 'local', local: captures.length + i })),
            }),
          },
        ],
      };
      return { op: 'closure', function: index, captures: sources };
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
          const vIf = dir(n, 'if');
          if (!vIf) {
            if (dir(n, 'else') || dir(n, 'else-if'))
              fail('E_TEMPLATE', 'v-else without v-if', loc(n));
            out.push(node(n));
            continue;
          }
          // v-if / v-else-if / v-else chain → nested if nodes.
          const chain: { test?: VNode; node: VNode }[] = [{ test: vIf, node: n }];
          while (items[i + 1]?.type === ELEMENT) {
            const next = items[i + 1];
            const d = dir(next, 'else-if') ?? dir(next, 'else');
            if (!d) break;
            chain.push({ test: d.name === 'else' ? undefined : d, node: next });
            i++;
          }
          for (const c of chain)
            if (dir(c.node, 'for'))
              fail(
                'E_TEMPLATE',
                'v-if and v-for on one element: Vue evaluates v-if first; wrap the list or filter it',
                loc(c.node),
              );
          const build = (k: number): Node[] => {
            if (k >= chain.length) return [];
            const { test, node: target } = chain[k];
            if (!test) return [node(target)];
            return [
              {
                kind: 'if',
                test: condition(exprNode(test.exp)),
                then: [node(target)],
                else: build(k + 1),
                source: loc(target),
              },
            ];
          };
          out.push(...build(0));
        } else fail('E_TEMPLATE', 'Unsupported template node', loc(n));
      }
      flush();
      return out;
    };
    const node = (n: VNode): Node => (dir(n, 'for') ? each(n) : single(n, false));
    const single = (n: VNode, listed: boolean): Node =>
      n.tagType === SLOT_TAG
        ? outlet(n, listed)
        : n.tagType === COMPONENT_TAG && childName(u, n.tag)
          ? component(n, listed)
          : element(n, listed);
    /** `<slot name="x" :prop="v">fallback</slot>` → a slot node (args in declaration order). */
    const outlet = (n: VNode, listed: boolean): Node => {
      let name = 'default';
      const given = new Map<string, Expr>();
      for (const p of n.props) {
        if (p.type === ATTRIBUTE) {
          if (p.name === 'name') {
            if (!p.value?.content) fail('E_SLOTS', 'Slot names must not be empty', loc(p));
            name = p.value.content;
          } else given.set(camelize(p.name), { op: 'lit', value: p.value?.content ?? '' });
          continue;
        }
        if (structural(p, listed)) continue;
        if (
          p.name === 'bind' &&
          p.exp &&
          p.arg?.isStatic &&
          p.arg.content !== 'name' &&
          !p.modifiers?.length
        ) {
          const prop = camelize(p.arg.content);
          if (given.has(prop)) fail('E_SLOTS', `Slot prop ${prop} is passed twice`, loc(p));
          given.set(prop, value(exprNode(p.exp)));
          continue;
        }
        fail(
          'E_SLOTS',
          p.name === 'bind' && p.arg?.content === 'name'
            ? 'Dynamic slot names are planned for a later milestone'
            : `v-${p.name}${p.arg ? ':' + p.arg.content : ''} on <slot> is planned for a later milestone`,
          loc(p),
        );
      }
      const decl =
        slotDecls.get(name) ??
        fail('E_SLOTS', `Slot ${name} is not declared in defineSlots`, loc(n));
      const args = decl.names.map((prop, i): Expr => {
        const v = given.get(prop);
        given.delete(prop);
        if (v) return fit(v, decl.types[i], `Slot prop ${prop}`, n);
        if (maybeInner(decl.types[i])) return { op: 'undefined', type: decl.types[i] };
        return fail('E_SLOTS', `Slot ${name} needs the prop ${prop}`, loc(n));
      });
      for (const extra of given.keys())
        fail('E_SLOTS', `Slot ${name} declares no prop ${extra}`, loc(n));
      const fallback = children(n.children);
      return {
        kind: 'slot',
        name,
        ...(args.length ? { args } : {}),
        ...(fallback.length ? { fallback } : {}),
        source: loc(n),
      };
    };
    const each = (n: VNode): Node => {
      const r = dir(n, 'for').forParseResult;
      if (r.index)
        fail('E_TEMPLATE', 'v-for over objects (a third alias) is planned for later', loc(n));
      const items = value(exprNode(r.source));
      const itemType = arrayElement(typeOf(items));
      if (!itemType)
        fail(
          'E_TEMPLATE',
          'v-for requires an array (ranges, objects and maps are planned for later)',
          loc(n),
        );
      let pattern = nodeAt(r.value);
      if (ts.isVariableDeclaration(pattern)) pattern = pattern.name;
      if (!ts.isIdentifier(pattern))
        fail('E_TEMPLATE', 'Destructured v-for items are planned for a later M3 step', loc(n));
      const item = tb.local((pattern as ts.Identifier).text, itemType!);
      lower.bindings.set(checker.getSymbolAtLocation(pattern)!, {
        kind: 'local',
        owner: tb,
        local: item,
      });
      let index: number | undefined;
      if (r.key) {
        index = tb.local(r.key.content, 'number');
        lower.bindings.set(checker.getSymbolAtLocation(nodeAt(r.key))!, {
          kind: 'local',
          owner: tb,
          local: index,
        });
      }
      const k = n.props.find(
        (p: VNode) => p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === 'key',
      );
      const key = k?.exp ? value(exprNode(k.exp)) : undefined;
      return {
        kind: 'each',
        // Vue 3's patchKeyedChildren (which blocks move is observable through focus).
        reorder: 'lis',
        items,
        item,
        ...(index !== undefined ? { index } : {}),
        ...(key ? { key } : {}),
        body: [single(n, true)],
        source: loc(n),
      };
    };
    /** Directives handled by the enclosing chain or list. */
    const structural = (p: VNode, listed: boolean) => {
      if (['if', 'else-if', 'else', 'for'].includes(p.name)) return true;
      if (p.name === 'bind' && p.arg?.content === 'key') {
        if (!listed)
          fail('E_TEMPLATE', ':key outside v-for is planned for a later milestone', loc(p));
        return true;
      }
      return false;
    };
    /**
     * A fallthrough attribute or listener `p` (vnode prop `key`) for the
     * attrs of `child`, with the value runtime-dom's patchProp gives the
     * elements those attrs reach: listeners stay functions; boolean DOM
     * properties (and the special boolean attributes) are present when true;
     * other attributes are text (`false` → "false"), absent when nullish;
     * `class` is normalised (trimmed) as the compiler does.
     */
    const fallEntry = (p: VNode, key: string, child: Unit): AttrItem => {
      const name = bagName(key);
      if (p.modifiers?.length)
        fail(
          'E_ATTRS',
          `Modifiers on fallthrough ${p.name === 'on' ? 'listeners' : 'attributes'} are planned for a later milestone (Vue wraps the listener, which then sees the element's event)`,
          loc(p),
        );
      if (p.type === DIRECTIVE && p.name === 'on') {
        const event = name.slice(2);
        if (!EVENT_KINDS.includes(event as HandlerEvent))
          fail('E_EVENT', `@${p.arg.content} listeners are planned for a later milestone`, loc(p));
        const v = value(exprNode(p.exp));
        const t = typeOf(v);
        const f = typeof t === 'object' && 'fn' in t ? t.fn : undefined;
        if (!f || !(f.params.length === 0 || (f.params.length === 1 && f.params[0] === 'event')))
          fail('E_EVENT', 'Event handlers take no parameter or the event object', loc(p));
        return { name, value: v };
      }
      if (/^on/i.test(key) || /[A-Z]/.test(key) || name === 'style')
        fail(
          'E_ATTRS',
          /^on/i.test(key)
            ? `The fallthrough attribute ${key} would be an inline handler or a listener prop; use @event`
            : name === 'style'
              ? 'Fallthrough style is planned for a later milestone (Vue merges it with the root element’s style)'
              : `Fallthrough attribute names are lowercase (${key})`,
          loc(p),
        );
      const tags = [...plans.get(child)!.tags];
      for (const tag of tags)
        if ([...UNREFLECTED_PROPS['*'], ...(UNREFLECTED_PROPS[tag] ?? [])].includes(name))
          fail(
            'E_ATTRS',
            `${name} falls through to <${tag}>, where Vue sets a property that is not the attribute text; declare it as a prop`,
            loc(p),
          );
      const isProp = (tag: string) =>
        [...BOOLEAN_PROPS['*'], ...(BOOLEAN_PROPS[tag] ?? [])].includes(name);
      const flag = SPECIAL_BOOLEAN_ATTRS.has(name) || (tags.length > 0 && tags.every(isProp));
      if (!flag && tags.some(isProp))
        fail(
          'E_ATTRS',
          `${name} falls through to elements where it is a boolean property (${tags.filter(isProp).join(', ')}) and to others where it is attribute text (${tags.filter(t => !isProp(t)).join(', ')})`,
          loc(p),
        );
      if (p.type === ATTRIBUTE) {
        // Static: the compiler's text (class condensed), '' without a value.
        const text: string = p.value?.content ?? '';
        if (flag && name === 'hidden' && text === 'until-found')
          fail('E_ATTRS', 'hidden="until-found" is unsupported', loc(p));
        return { name, value: { op: 'lit', value: flag ? true : text } };
      }
      // `:class` compiles to normalizeClass.
      if (name === 'class') return { name, value: classOf(exprNode(p.exp)) };
      const v = value(exprNode(p.exp));
      const t = typeOf(v);
      if (flag) {
        if (t !== 'boolean')
          fail(
            'E_ATTRS',
            `${name} falls through as a boolean property; pass a boolean (Vue's coercion of ${JSON.stringify(t)} differs)`,
            loc(p),
          );
        return { name, value: v };
      }
      if (t === 'string' || maybeInner(t) === 'string') return { name, value: v };
      if (t === 'number' || t === 'boolean') return { name, value: { op: 'to-string', arg: v } };
      return fail(
        'E_ATTRS',
        `Fallthrough attribute ${name} of type ${JSON.stringify(t)} is unsupported`,
        loc(p),
      );
    };
    const component = (n: VNode, listed: boolean): Node => {
      const name = childName(u, n.tag)!;
      const child = units.get(u.children.get(name)!)!;
      const target = components[child.index];
      const passed: { name: string; value: Expr; bind?: Expr }[] = [];
      const propCell = (prop: string, at: VNode, what = 'prop') => {
        const cell = target.cells.findIndex(c => c.prop === prop);
        if (cell < 0) fail('E_PROPS', `${name} has no ${what} ${prop}`, loc(at));
        if (passed.some(p => p.name === prop)) fail('E_PROPS', `${prop} is passed twice`, loc(at));
        return cell;
      };
      // Attributes the child does not declare: its attrs (a bag in source
      // order; mergeProps when $attrs is bound here or falls through to it).
      const bag: AttrItem[] = [];
      let merged = false;
      for (const p of n.props) {
        if (p.type === ATTRIBUTE && p.name === 'ref') continue; // componentRefOf
        if (isAttrsSpread(u, p)) {
          bag.push({ spread: attrsRead() });
          merged = true;
          continue;
        }
        const key = passedKey(p);
        if (
          key !== undefined &&
          (p.type === ATTRIBUTE || p.name === 'bind' || p.name === 'on') &&
          !declares(child, key)
        ) {
          const merged = classProps(n);
          if (key === 'class' && merged.length > 1) {
            // A static and a dynamic class: one normalizeClass of both, in source order.
            if (p === merged[0]) {
              fallEntry(merged.find((q: VNode) => q.type === DIRECTIVE) ?? p, key, child);
              bag.push({ name: 'class', value: classValue(merged) });
            }
            continue;
          }
          if (bag.some(b => 'name' in b && b.name === bagName(key)))
            fail('E_ATTRS', `${key} is passed twice`, loc(p));
          bag.push(fallEntry(p, key, child));
          continue;
        }
        if (p.type === ATTRIBUTE) {
          const prop = camelize(p.name);
          const want = target.cells[propCell(prop, p)].type;
          const text: string | undefined = p.value?.content;
          let v: Expr;
          if (want === 'boolean' && (text === undefined || text === '' || text === hyphenate(prop)))
            v = { op: 'lit', value: true };
          else if (want === 'string' || maybeInner(want) === 'string')
            v = fit({ op: 'lit', value: text ?? '' }, want, prop, p);
          else
            return fail(
              'E_PROPS',
              `${prop} expects ${JSON.stringify(want)}; use :${p.name}`,
              loc(p),
            );
          passed.push({ name: prop, value: v });
          continue;
        }
        if (structural(p, listed)) continue;
        if (p.name === 'slot') continue; // the default slot's props, below
        if (!p.exp) fail('E_TEMPLATE', `v-${p.name} needs an expression`, loc(p));
        if (p.modifiers?.length)
          fail(
            'E_TEMPLATE',
            p.name === 'on'
              ? 'Event modifiers on component listeners are planned for a later milestone (Vue applies them to the emitted arguments)'
              : 'Directive modifiers are planned for M5',
            loc(p),
          );
        if (p.arg && !p.arg.isStatic)
          fail('E_TEMPLATE', 'Dynamic arguments are unsupported', loc(p));
        if (p.name === 'bind' && p.arg && p.exp) {
          const prop = camelize(p.arg.content);
          const want = target.cells[propCell(prop, p)].type;
          passed.push({ name: prop, value: fit(value(exprNode(p.exp)), want, prop, p) });
        } else if (p.name === 'on' && p.arg && p.exp) {
          const key = handlerKey(p.arg.content);
          if (!child.macros.emits?.events.some(e => e.key === key))
            fail('E_PROPS', `${name} declares no event ${p.arg.content} in defineEmits`, loc(p));
          const want = target.cells[propCell(key, p, 'event')].type;
          passed.push({ name: key, value: listenerFn(value(exprNode(p.exp)), want, p) });
        } else if (p.name === 'model' && p.exp) {
          const prop: string = p.arg?.content ?? 'modelValue';
          if (!child.macros.models.some(m => m.prop === prop))
            fail('E_MODEL', `${name} declares no defineModel(${JSON.stringify(prop)})`, loc(p));
          const want = target.cells[propCell(prop, p, 'model')].type;
          const v = value(exprNode(p.exp));
          if (!sameType(typeOf(v), want))
            fail(
              'E_MODEL',
              `v-model target has type ${JSON.stringify(typeOf(v))}; ${name} models ${JSON.stringify(want)} (a model without default or required is nullable)`,
              loc(p),
            );
          const bind = value(exprNode(p));
          if (!sameType(typeOf(bind), { fn: { params: [want], result: 'void' } }))
            fail('E_MODEL', 'Unsupported v-model target', loc(p));
          passed.push({ name: prop, value: v, bind });
        } else
          fail(
            'E_TEMPLATE',
            `v-${p.name}${p.arg ? ':' + p.arg.content : ''} on components is planned for a later milestone`,
            loc(p),
          );
      }
      // The root component also receives this component's attrs (cloneVNode
      // merges them after its own props).
      if (restCell !== undefined && u.macros.inheritAttrs && plan.roots?.includes(n)) {
        bag.push({ spread: attrsRead() });
        merged = true;
      }
      if (bag.length) {
        if (!target.cells.some(c => c.prop === '...')) {
          // Only spreads of attrs no call site fills.
          if (bag.some(b => 'name' in b)) fail('E_INTERNAL', `${name} has no attrs cell`, loc(n));
        } else
          passed.push({
            name: '...',
            value:
              bag.length === 1 && 'spread' in bag[0]
                ? bag[0].spread
                : { op: 'attrs', items: bag, ...(merged ? { merge: true as const } : {}) },
          });
      }
      // A component ref: the child forwards its exposed element through a
      // bound prop; the ref holds a record of it (one per mount).
      const refCell = componentRefOf.get(n);
      if (refCell !== undefined) {
        const exposed = exposedOf[child.index]!;
        const refType = cells[refCell].type;
        const rec = (maybeInner(refType) as { record: number }).record;
        const el: Type = { maybe: 'element' };
        const nullish = (e: Expr): Expr => ({
          op: 'builtin',
          name: 'maybe.is-nullish',
          args: [e],
          type: 'boolean',
        });
        const read = (): Expr => {
          const r: Expr = { op: 'cell', cell: refCell, read: 'current' };
          unrenderedReads.add(r);
          return r;
        };
        const fn = lower.reserve();
        lower.functions[fn] = {
          name: `${cells[refCell].name}$ref`,
          component: COMPONENT,
          params: [{ name: 'el', type: el }],
          locals: [],
          result: 'void',
          body: [
            {
              op: 'set',
              cell: refCell,
              value: {
                op: 'cond',
                test: nullish(L(0)),
                then: { op: 'null', type: refType },
                else: { op: 'some', value: { op: 'record', record: rec, fields: [L(0)] } },
              },
            },
          ],
        };
        passed.push({
          name: exposed.prop,
          // The child's element as the ref shows it (equal to the child's own cell).
          value: {
            op: 'cond',
            test: nullish(read()),
            then: { op: 'null', type: el },
            else: { op: 'get', object: { op: 'unwrap', value: read() }, field: 0 },
          },
          bind: { op: 'closure', function: fn, captures: [] },
        });
      }
      for (const c of target.cells)
        if (c.prop && !passed.some(p => p.name === c.prop) && isRequired(c.init))
          fail('E_PROPS', `${name} requires the prop ${c.prop}`, loc(n));
      // Slot content: parent-owned nodes with the slot props as template locals.
      const defs: { name: string; params?: number[]; body: Node[] }[] = [];
      const def = (slot: string, exp: VNode | undefined, body: VNode[], at: VNode) => {
        const names = slotProps[child.index].get(slot);
        if (!names)
          fail(
            'E_SLOTS',
            `${name} renders no slot ${slot} (Vue would discard this content)`,
            loc(at),
          );
        if (defs.some(d => d.name === slot))
          fail('E_SLOTS', `Slot ${slot} is given twice`, loc(at));
        const types = target.slots!.find(d => d.name === slot)!.params ?? [];
        const params = types.map(() => -1);
        if (exp) {
          let pattern = nodeAt(exp);
          if (ts.isVariableDeclaration(pattern)) pattern = pattern.name;
          if (!ts.isObjectBindingPattern(pattern))
            fail('E_SLOTS', 'Destructure slot props: #name="{ item, index }"', loc(exp));
          for (const el of (pattern as ts.ObjectBindingPattern).elements) {
            const key =
              el.propertyName &&
              (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))
                ? el.propertyName.text
                : !el.propertyName && ts.isIdentifier(el.name)
                  ? el.name.text
                  : undefined;
            if (el.dotDotDotToken || el.initializer || !key || !ts.isIdentifier(el.name))
              tsFail(
                el,
                'E_SLOTS',
                'Slot props support plain and renamed destructuring ({ item, first: isFirst }); defaults, rest and nested patterns are planned for later',
              );
            const i = names!.indexOf(key!);
            if (i < 0) tsFail(el, 'E_SLOTS', `Slot ${slot} of ${name} has no prop ${key}`);
            if (params[i] >= 0) tsFail(el, 'E_SLOTS', `Slot prop ${key} is destructured twice`);
            const id = el.name as ts.Identifier;
            params[i] = tb.local(id.text, types[i]);
            lower.bindings.set(checker.getSymbolAtLocation(id)!, {
              kind: 'local',
              owner: tb,
              local: params[i],
            });
          }
        }
        params.forEach((p, i) => {
          if (p < 0) params[i] = tb.local(`$${names![i]}`, types[i]);
        });
        // renderSlot shows the fallback when the content renders only comments.
        if (hasFallback(target.template, slot) && !alwaysRenders(body))
          fail(
            'E_SLOTS',
            `${name} has fallback content for slot ${slot}, which Vue also renders when this content renders nothing (only v-if or v-for); add an unconditional element or text`,
            loc(at),
          );
        slotDepth++;
        const content = children(body);
        slotDepth--;
        defs.push({ name: slot, ...(params.length ? { params } : {}), body: content });
      };
      const own = dir(n, 'slot');
      const templates = slotTemplates(n);
      const rest = n.children.filter((c: VNode) => !templates.includes(c) && c.type !== COMMENT);
      if (own) {
        if (own.arg && !(own.arg.isStatic && own.arg.content === 'default'))
          fail('E_SLOTS', 'v-slot on a component tag names the default slot', loc(own));
        if (templates.length)
          fail(
            'E_SLOTS',
            'Use <template #default> when the component also has named slots (Vue rejects mixing)',
            loc(own),
          );
        def('default', own.exp, rest, own);
      } else {
        for (const t of templates) {
          const d = dir(t, 'slot');
          if (d.arg && !d.arg.isStatic)
            fail('E_SLOTS', 'Dynamic slot names are planned for a later milestone', loc(d));
          for (const p of t.props)
            if (p !== d)
              fail(
                'E_SLOTS',
                'Slot templates with other directives (conditional or repeated slots) are planned for a later milestone',
                loc(p),
              );
          def(d.arg?.content ?? 'default', d.exp, t.children, t);
        }
        // Implicit default content (whitespace alone does not make one next to named slots).
        if (
          rest.length &&
          (!templates.length || rest.some((c: VNode) => c.type !== TEXT || c.content.trim()))
        )
          def('default', undefined, rest, rest.find((c: VNode) => c.type !== TEXT) ?? n);
      }
      return {
        kind: 'component',
        component: child.index,
        ...(passed.length ? { props: passed } : {}),
        ...(defs.length ? { slots: defs } : {}),
        source: loc(n),
      };
    };
    const lit = (value: string): Expr => ({ op: 'lit', value });
    const concat = (left: Expr, right: Expr): Expr =>
      left.op === 'lit' && left.value === '' ? right : { op: 'concat', left, right };
    const trimmed = (v: Expr): Expr => ({
      op: 'builtin',
      name: 'string.trim',
      args: [v],
      type: 'string',
    });
    /** The value of a shorthand member (`{ on }`): the binding it names. */
    const shorthand = (p: ts.ShorthandPropertyAssignment): Expr => {
      const sym = checker.getShorthandAssignmentValueSymbol(p);
      const b = sym && lower.bindings.get(sym);
      return b
        ? lower.bindingExpr(b, p.name, tb, lower.typeOfNode(p.name))
        : tsFail(p, 'E_UNRESOLVED', `${p.name.text} is not a supported binding`);
    };
    /** The static key and value of an object literal member, or a diagnostic. */
    const member = (p: ts.ObjectLiteralElementLike, what: string): [string, Expr] => {
      let key: string | undefined;
      let v: Expr | undefined;
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        key = p.name.text;
        v = value(p.initializer);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        key = p.name.text;
        v = shorthand(p);
      } else
        return tsFail(
          p,
          'E_TEMPLATE',
          `${what} objects support members with static names (name: value, 'name': value, shorthand)`,
        );
      // Object enumeration puts array-index keys first.
      if (isIndexKey(key)) tsFail(p, 'E_TEMPLATE', `${what} keys that are numbers are unsupported`);
      return [key, v];
    };
    /**
     * normalizeClass (@vue/shared) of a template value: a string trimmed
     * (nullish: ''); an object the names of its truthy values; an array its
     * items' non-empty normalized values, each followed by a space; trimmed.
     */
    const classOf = (e: ts.Expression): Expr => {
      const x = skipParens(e);
      if (ts.isObjectLiteralExpression(x)) {
        let out = lit('');
        const seen = new Set<string>();
        for (const p of x.properties) {
          const [key, v] = member(p, ':class');
          if (seen.has(key)) tsFail(p, 'E_TEMPLATE', `:class names ${key} twice`);
          seen.add(key);
          out = concat(out, {
            op: 'cond',
            test: lower.truthy(v, typeOf(v)),
            then: lit(key + ' '),
            else: lit(''),
          });
        }
        return trimmed(out);
      }
      if (ts.isArrayLiteralExpression(x)) {
        let out = lit('');
        for (const el of x.elements) {
          if (ts.isSpreadElement(el) || ts.isOmittedExpression(el))
            tsFail(el, 'E_TEMPLATE', ':class arrays with spreads or holes are unsupported');
          out = concat(out, classPiece(classOf(el as ts.Expression)));
        }
        return trimmed(out);
      }
      if (x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined'))
        return lit('');
      const v = value(x);
      const t = typeOf(v);
      if (t === 'string') return trimmed(v);
      if (maybeInner(t) === 'string') return trimmed({ op: 'nullish', left: v, right: lit('') });
      return tsFail(
        x,
        'E_TEMPLATE',
        `:class with ${JSON.stringify(t)}: write objects and arrays in the template (class values by reference are planned for later)`,
      );
    };
    /** A normalized class within an array: followed by a space unless empty. */
    const classPiece = (v: Expr): Expr => {
      if (v.op === 'lit') return lit(v.value === '' ? '' : `${v.value} `);
      const l = tb.local('$class', 'string');
      return {
        op: 'with',
        local: l,
        value: v,
        body: {
          op: 'cond',
          test: { op: 'eq', left: L(l), right: lit('') },
          then: lit(''),
          else: { op: 'concat', left: L(l), right: lit(' ') },
        },
      };
    };
    /**
     * The class of an element or component tag: a static `class` (the
     * parser condensed it) as it is, or with `:class` the compiler's
     * normalizeClass of the values in source order.
     */
    const classProps = (n: VNode): VNode[] =>
      n.props.filter(
        (p: VNode) =>
          (p.type === ATTRIBUTE && p.name === 'class') ||
          (p.type === DIRECTIVE &&
            p.name === 'bind' &&
            p.arg?.isStatic &&
            p.arg.content === 'class'),
      );
    const classValue = (list: VNode[]): Expr => {
      if (list.length === 1 && list[0].type === ATTRIBUTE) return lit(list[0].value?.content ?? '');
      for (const p of list)
        if (p.type === DIRECTIVE && p.modifiers?.length)
          fail('E_TEMPLATE', 'Directive modifiers on :class are unsupported', loc(p));
      const items = list.map(p =>
        p.type === ATTRIBUTE ? lit((p.value?.content ?? '').trim()) : classOf(exprNode(p.exp)),
      );
      if (items.length === 1) return items[0];
      return trimmed(items.map(classPiece).reduce(concat, lit('')));
    };
    /**
     * A style key as runtime-dom's setStyle resolves it (autoPrefix): a
     * custom property as is, otherwise the CSS property of its camelCase
     * form. Vendor prefixes and keys that are not property names (Vue then
     * sets an expando or a prefixed alias) are rejected.
     */
    const styleProperty = (key: string, tag: string, at: Source): string => {
      if (key.startsWith('--')) return key;
      const c = camelize(key);
      if (!/^[a-z][a-zA-Z]*$/.test(c) || /^(webkit|moz|ms)[A-Z]/.test(c))
        fail(
          'E_TEMPLATE',
          `Style key ${JSON.stringify(key)} is not a CSS property name in kebab-case or camelCase (Vue would set it through a vendor prefix or as an expando)`,
          at,
        );
      if (tag === 'textarea' && (key === 'width' || key === 'height'))
        fail(
          'E_TEMPLATE',
          `Vue keeps an unchanged ${key} style of a text area (user resizing); this is planned for later`,
          at,
        );
      if (c === 'filter')
        fail(
          'E_TEMPLATE',
          'Vue sets the filter style through the WebkitFilter alias (an !important value then sets nothing); this is unsupported',
          at,
        );
      return hyphenate(c);
    };
    /** A style object value: a string (nullish removes), numbers as text. */
    const styleText = (v: Expr, at: ts.Node): Expr => {
      const t = typeOf(v);
      if (t === 'string' || maybeInner(t) === 'string') return v;
      if (t === 'number') return { op: 'to-string', arg: v };
      if (maybeInner(t) === 'number') {
        const l = tb.local('$style', t);
        return {
          op: 'with',
          local: l,
          value: v,
          body: {
            op: 'cond',
            test: { op: 'builtin', name: 'maybe.is-nullish', args: [L(l)], type: 'boolean' },
            then: { op: 'undefined', type: { maybe: 'string' } },
            else: { op: 'some', value: { op: 'to-string', arg: { op: 'unwrap', value: L(l) } } },
          },
        };
      }
      return tsFail(
        at,
        'E_TEMPLATE',
        `Style values are strings or numbers, not ${JSON.stringify(t)}`,
      );
    };
    type Declarations = Map<string, { value: Expr; at: Source }>;
    /**
     * normalizeStyle (@vue/shared) of a template value: a string stays a
     * text; an object is its declarations; an array merges its items'
     * declarations (strings parsed by parseStringStyle), a later key
     * winning in place.
     */
    const styleOf = (e: ts.Expression): Expr | Declarations => {
      const x = skipParens(e);
      if (ts.isObjectLiteralExpression(x)) {
        const out: Declarations = new Map();
        for (const p of x.properties) {
          const [key, v] = member(p, ':style');
          out.set(key, { value: styleText(v, p), at: sourceOf(p) });
        }
        return out;
      }
      if (ts.isArrayLiteralExpression(x)) {
        const out: Declarations = new Map();
        for (const el of x.elements) {
          if (ts.isSpreadElement(el) || ts.isOmittedExpression(el))
            tsFail(el, 'E_TEMPLATE', ':style arrays with spreads or holes are unsupported');
          const item = skipParens(el as ts.Expression);
          if (item.kind === ts.SyntaxKind.NullKeyword) continue;
          if (ts.isIdentifier(item) && item.text === 'undefined') continue;
          const parsed =
            ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item)
              ? staticDeclarations(item.text, sourceOf(item))
              : styleOf(item);
          if (!(parsed instanceof Map))
            tsFail(
              item,
              'E_TEMPLATE',
              'A dynamic style text in a :style array (Vue parses it into declarations at run time) is planned for later',
            );
          for (const [k, v] of parsed as Declarations) out.set(k, v);
        }
        return out;
      }
      const v = value(x);
      const t = typeOf(v);
      if (t === 'string' || maybeInner(t) === 'string') return v;
      return tsFail(
        x,
        'E_TEMPLATE',
        `:style with ${JSON.stringify(t)}: write a string, or objects and arrays in the template (style objects by reference are planned for later)`,
      );
    };
    const staticDeclarations = (text: string, at: Source): Declarations => {
      const out: Declarations = new Map();
      for (const [k, v] of parseStringStyle(text)) {
        if (isIndexKey(k)) fail('E_TEMPLATE', `Style keys that are numbers are unsupported`, at);
        out.set(k, { value: lit(v), at });
      }
      return out;
    };
    /**
     * The inline style of an element (runtime-dom patchStyle, docs/IR.md
     * `replace`): a static `style` (parsed at build time) and `:style`, merged
     * in source order as the compiler does. A stringified element carries
     * its static style as HTML text.
     */
    const elementStyle = (
      n: VNode,
    ):
      | { attr: string }
      | { styleText: Expr; styleUpdate: 'replace' }
      | { styles: { name: string; value: Expr }[]; styleUpdate: 'replace' }
      | undefined => {
      const list: VNode[] = n.props.filter(
        (p: VNode) =>
          (p.type === ATTRIBUTE && p.name === 'style') ||
          (p.type === DIRECTIVE &&
            p.name === 'bind' &&
            p.arg?.isStatic &&
            p.arg.content === 'style'),
      );
      if (!list.length) return undefined;
      const at = n.loc.start.offset;
      const [dev, prod] = liveElements(u);
      if (dev.has(at) !== prod.has(at))
        fail(
          'E_TEMPLATE',
          'Vue renders this element as static HTML in one build mode and not in the other, which sets its style differently',
          loc(n),
        );
      if (!dev.has(at)) {
        // Static HTML: the compiler's text of a static style.
        if (list.length !== 1 || list[0].type !== ATTRIBUTE)
          fail(
            'E_TEMPLATE',
            'A constant :style in content Vue renders as static HTML is unsupported',
            loc(list[0]),
          );
        return {
          attr: stringifyStyle(
            new Map(
              [...staticDeclarations(list[0].value?.content ?? '', loc(list[0]))].map(([k, v]) => [
                k,
                (v.value as { value: string }).value,
              ]),
            ),
          ),
        };
      }
      let style: Expr | Declarations;
      if (list.length === 1)
        style =
          list[0].type === ATTRIBUTE
            ? staticDeclarations(list[0].value?.content ?? '', loc(list[0]))
            : styleOf(exprNode(list[0].exp));
      else {
        style = new Map();
        for (const p of list) {
          if (p.type === DIRECTIVE && p.modifiers?.length)
            fail('E_TEMPLATE', 'Directive modifiers on :style are unsupported', loc(p));
          const part =
            p.type === ATTRIBUTE
              ? staticDeclarations(p.value?.content ?? '', loc(p))
              : styleOf(exprNode(p.exp));
          if (!(part instanceof Map))
            fail(
              'E_TEMPLATE',
              'A dynamic style text with a static style (Vue parses it into declarations at run time) is planned for later',
              loc(p),
            );
          for (const [k, v] of part as Declarations) style.set(k, v);
        }
      }
      if (!(style instanceof Map)) return { styleText: style, styleUpdate: 'replace' };
      if (!style.size) return undefined;
      return {
        styles: [...style].map(([k, v]) => ({
          name: styleProperty(k, n.tag, v.at),
          value: v.value,
        })),
        styleUpdate: 'replace',
      };
    };
    const element = (n: VNode, listed: boolean): Node => {
      if (n.tagType !== PLAIN || !TAGS.has(n.tag))
        fail(
          'E_TEMPLATE',
          n.tagType === COMPONENT_TAG
            ? `${n.tag} is not an imported component`
            : `<${n.tag}> is outside the supported elements`,
          loc(n),
        );
      const attrs: { name: string; value: Expr }[] = [];
      const props: { name: string; value: Expr }[] = [];
      const listeners: Listener[] = [];
      /** Text inputs and text areas: Vue patches their value at every re-render. */
      const typeAttr = n.props.find((p: VNode) => p.type === ATTRIBUTE && p.name === 'type');
      // Checkboxes and radio buttons: a live checked property and change events.
      const radio = n.tag === 'input' && typeAttr?.value?.content === 'radio';
      const checkbox = (n.tag === 'input' && typeAttr?.value?.content === 'checkbox') || radio;
      const select = n.tag === 'select';
      const textControl = (n.tag === 'input' && !checkbox) || n.tag === 'textarea';
      /** A radio button's value: a static value or a string literal bound with :value. */
      const radioValue = (): string | undefined => {
        for (const q of n.props) {
          if (q.type === ATTRIBUTE && q.name === 'value') return q.value?.content ?? '';
          if (q.type === DIRECTIVE && q.name === 'bind' && q.arg?.content === 'value' && q.exp) {
            const e = skipParens(exprNode(q.exp));
            if (ts.isStringLiteralLike(e)) return e.text;
            fail(
              'E_TEMPLATE',
              ':value on a radio button takes a string literal (other values are planned for later)',
              loc(q),
            );
          }
        }
        return undefined;
      };
      let restoreRender = false;
      /** Listener parts per event, in Vue's call order. */
      const parts = new Map<HandlerEvent, Part[]>();
      let model: Part | undefined;
      let modelEvent: HandlerEvent = 'change';
      /** The ref a v-model on a select or radio button assigns. */
      let controlModel: { cell: number; radio: boolean; source: Source } | undefined;
      /** The prop index of v-bind="$attrs". */
      let spreadAt: number | undefined;
      const checked = (v: Expr, at: VNode) => {
        if (props.some(q => q.name === 'checked'))
          fail('E_TEMPLATE', 'checked is set twice (checked, :checked, v-model)', loc(at));
        props.push({ name: 'checked', value: v });
      };
      const classes = classProps(n);
      const style = elementStyle(n);
      for (const p of n.props) {
        // class and style: below.
        if (classes.includes(p) || (p.name === 'style' && p.type === ATTRIBUTE)) continue;
        if (
          p.type === DIRECTIVE &&
          p.name === 'bind' &&
          p.arg?.isStatic &&
          p.arg.content === 'style'
        )
          continue;
        if (p.type === ATTRIBUTE) {
          if (p.name === 'ref') continue; // a reserved prop: the template ref (refOf)
          if (radio && p.name === 'checked')
            fail(
              'E_TEMPLATE',
              'checked on a radio button is planned for later; use v-model with a value',
              loc(p),
            );
          if (checkbox && p.name === 'checked') {
            // Vue sets checked as a DOM property ('' → true), not an attribute.
            checked({ op: 'lit', value: true }, p);
            continue;
          }
          if (select && p.name === 'value')
            fail(
              'E_TEMPLATE',
              'A static value on a select is planned for later; use v-model or :value',
              loc(p),
            );
          attrs.push({
            name: p.name,
            value: BOOLEAN_ATTRS.has(p.name)
              ? { op: 'lit', value: true }
              : { op: 'lit', value: p.value?.content ?? '' },
          });
          continue;
        }
        if (structural(p, listed)) continue;
        if (p.name === 'on') {
          const written: string | undefined = p.arg?.isStatic ? p.arg.content : undefined;
          if (written === undefined)
            fail('E_EVENT', 'Dynamic event names and v-on objects are unsupported', loc(p));
          const modifiers = modifierNames(p);
          if (!p.exp?.content.trim() && !modifiers.length)
            fail('E_TEMPLATE', `@${written} needs a handler or modifiers`, loc(p));
          const { keys, guards, options } = resolveModifiers(written!, modifiers);
          if (options.length)
            fail(
              'E_EVENT',
              `The listener options .${options.join(', .')} are planned for a later milestone`,
              loc(p),
            );
          // compiler-dom listens to contextmenu for @click.right and mouseup for @click.middle.
          const event = listenedEvent(written!, modifiers) as HandlerEvent;
          // scroll: a native listener on the element, like Svelte's (Vue 3.5.43 in Chromium 153).
          if (!EVENT_KINDS.includes(event))
            fail('E_EVENT', `@${event} listeners are planned for a later milestone`, loc(p));
          if (event === 'change' && !checkbox && !select)
            fail(
              'E_EVENT',
              '@change is supported on checkboxes, radio buttons and selects (text inputs: @input)',
              loc(p),
            );
          const part = withModifiers(handlerFor(p, event), event, guards, keys);
          parts.set(event, [...(parts.get(event) ?? []), part]);
          continue;
        }
        if (isAttrsSpread(u, p)) {
          // v-bind="$attrs": the element's attributes around it merge with the attrs.
          spreadAt = n.props.indexOf(p);
          continue;
        }
        if (!p.exp) fail('E_TEMPLATE', `v-${p.name} needs an expression`, loc(p));
        if (p.modifiers?.length)
          fail(
            'E_TEMPLATE',
            p.name === 'model'
              ? `v-model modifiers (.${modifierNames(p).join(', .')}) are planned for a later milestone`
              : `Directive modifiers are planned for a later milestone`,
            loc(p),
          );
        if (
          p.name === 'bind' &&
          p.arg?.isStatic &&
          (textControl || select) &&
          p.arg.content === 'value'
        ) {
          // patchProp: el.value = String(value) (nullish: ''), forced at every
          // re-render where it differs from the live value (after the
          // children, so a select's options are there); a text area's
          // attribute too.
          const v = value(exprNode(p.exp));
          const t = typeOf(v);
          if (props.some(q => q.name === 'value'))
            fail('E_TEMPLATE', 'value is set twice (:value, v-model)', loc(p));
          if (t !== 'string' && t !== 'number' && maybeInner(t) !== 'string')
            fail(
              'E_TEMPLATE',
              `:value takes a string or a number, not ${JSON.stringify(t)}`,
              loc(p),
            );
          props.push({
            name: 'value',
            value:
              t === 'string'
                ? v
                : t === 'number'
                  ? { op: 'to-string', arg: v }
                  : { op: 'nullish', left: v, right: lit('') },
          });
          // runtime-dom patchProp also sets the value attribute. It is compared
          // for text areas and selects (inputs show their live value).
          if (n.tag === 'textarea' || select)
            attrs.push({ name: 'value', value: t === 'number' ? { op: 'to-string', arg: v } : v });
          restoreRender = true;
          continue;
        }
        if (p.name === 'bind' && radio && p.arg?.content === 'checked')
          fail(
            'E_TEMPLATE',
            ':checked on a radio button is planned for later (Vue patches it only when it changes, so a click the state does not follow leaves the group out of step); use v-model with a value',
            loc(p),
          );
        if (p.name === 'bind' && radio && p.arg?.isStatic && p.arg.content === 'value') {
          // A string literal (radioValue): Vue sets el.value, which is the attribute.
          attrs.push({ name: 'value', value: lit(radioValue()!) });
          continue;
        }
        if (
          p.name === 'bind' &&
          p.arg?.isStatic &&
          n.tag === 'option' &&
          p.arg.content === 'value'
        ) {
          // option._value: what v-model assigns; strings only.
          const v = value(exprNode(p.exp));
          if (typeOf(v) !== 'string')
            fail(
              'E_TEMPLATE',
              `:value on an option takes a string, not ${JSON.stringify(typeOf(v))} (v-model would assign the value itself)`,
              loc(p),
            );
          attrs.push({ name: 'value', value: v });
          continue;
        }
        if (p.name === 'bind' && p.arg?.isStatic && checkbox && p.arg.content === 'checked') {
          // Vue sets the checked DOM property; '' would be true and null false.
          const v = value(exprNode(p.exp));
          if (typeOf(v) !== 'boolean')
            fail('E_TEMPLATE', ':checked on a checkbox takes a boolean', loc(p));
          checked(v, p);
          continue;
        }
        if (
          p.name === 'bind' &&
          checkbox &&
          ['value', 'true-value', 'false-value'].includes(p.arg?.content)
        )
          fail(
            'E_TEMPLATE',
            `:${p.arg.content} on checkboxes is planned for a later milestone`,
            loc(p),
          );
        if (p.name === 'bind' && p.arg?.isStatic) {
          const name: string = p.arg.content;
          const v = value(exprNode(p.exp));
          const t = typeOf(v);
          if (BOOLEAN_ATTRS.has(name))
            attrs.push({ name, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } });
          else if (maybeInner(t) === 'string') attrs.push({ name, value: v });
          else if (t === 'string' || t === 'number' || t === 'boolean')
            attrs.push({ name, value: t === 'string' ? v : { op: 'to-string', arg: v } });
          else
            fail(
              'E_TEMPLATE',
              `:${name} with ${JSON.stringify(t)} (class/style objects are planned for later)`,
              loc(p),
            );
          continue;
        }
        if (p.name === 'model' && (select || radio)) {
          // vModelSelect: a change listener assigns the chosen option's value
          // (added when the directive is created); setSelected after the
          // mount and after every re-render (`updated`), except while a
          // change it made is being flushed. vModelRadio: checked when the
          // model equals the button's value, set where the model changed;
          // a change assigns the value.
          const what = select ? 'a select' : 'a radio button';
          if (props.some(q => q.name === (select ? 'value' : 'checked')))
            fail('E_TEMPLATE', `${select ? 'value' : 'checked'} is set twice (v-model)`, loc(p));
          const target = skipParens(exprNode(p.exp));
          if (ts.isIdentifier(target) && lower.binding(target)?.kind === 'local')
            fail(
              'E_TEMPLATE',
              'v-model cannot assign a v-for or slot scope variable (Vue rejects it)',
              loc(p),
            );
          const read = value(target);
          if (typeOf(read) !== 'string')
            fail(
              'E_TEMPLATE',
              `v-model on ${what} needs a string target, not ${JSON.stringify(typeOf(read))} (Vue compares values loosely; other types are planned for later)`,
              loc(p),
            );
          if (read.op !== 'cell' || cells[read.cell]?.prop !== undefined)
            fail(
              'E_TEMPLATE',
              `v-model on ${what} needs a ref of this component (props and models are planned for later)`,
              loc(p),
            );
          const cell = (read as { cell: number }).cell;
          if (select) {
            props.push({ name: 'value', value: read });
            restoreRender = true;
            model = {
              ...lower.bindHandler(target, COMPONENT, 'change', tb, {
                op: 'builtin',
                name: 'event.value',
                args: [{ op: 'event' }],
                type: 'string',
              }),
              source: loc(p),
            };
          } else {
            const own = radioValue();
            if (own === undefined)
              fail(
                'E_TEMPLATE',
                'v-model on a radio button needs a value (value="…" or :value with a string literal)',
                loc(p),
              );
            checked({ op: 'eq', left: read, right: lit(own!) }, p);
            model = {
              ...lower.bindHandler(target, COMPONENT, 'change', tb, lit(own!)),
              source: loc(p),
            };
          }
          controlModel = { cell, radio, source: loc(p) };
          continue;
        }
        if (p.name === 'model' && textControl) {
          // vModelText: an input listener assigns el.value (added when the
          // directive is created); before every re-render the value is set
          // where it differs. Composition (IME) defers the assignment to
          // compositionend; the native runtime receives no input events while
          // composing either (Blitz reports the committed text).
          const type = typeAttr?.value?.content;
          if (n.tag === 'input' && type !== undefined && type !== 'text')
            fail(
              'E_TEMPLATE',
              `v-model on <input type="${type}"> is planned for a later milestone`,
              loc(p),
            );
          if (
            n.props.some(
              (q: VNode) => q.type === DIRECTIVE && q.name === 'bind' && q.arg?.content === 'type',
            )
          )
            fail('E_TEMPLATE', 'v-model with a dynamic type is unsupported', loc(p));
          if (props.some(q => q.name === 'value'))
            fail('E_TEMPLATE', 'value is set twice (:value, v-model)', loc(p));
          const target = skipParens(exprNode(p.exp));
          if (ts.isIdentifier(target) && lower.binding(target)?.kind === 'local')
            fail(
              'E_TEMPLATE',
              'v-model cannot assign a v-for or slot scope variable (Vue rejects it)',
              loc(p),
            );
          const read = value(target);
          const t = typeOf(read);
          if (t !== 'string' && maybeInner(t) !== 'string')
            fail(
              'E_TEMPLATE',
              `v-model on a text control needs a string target, not ${JSON.stringify(t)}`,
              loc(p),
            );
          props.push({
            name: 'value',
            value: t === 'string' ? read : { op: 'nullish', left: read, right: lit('') },
          });
          model = { ...lower.bindHandler(target, COMPONENT, 'input', tb), source: loc(p) };
          modelEvent = 'input';
          restoreRender = true;
          continue;
        }
        if (p.name === 'model') {
          if (!checkbox)
            fail('E_TEMPLATE', 'v-model on this element is planned for a later milestone', loc(p));
          if (
            n.props.some(
              (q: VNode) => q.type === ATTRIBUTE && ['true-value', 'false-value'].includes(q.name),
            )
          )
            fail(
              'E_TEMPLATE',
              'Checkbox value attributes with v-model are planned for later',
              loc(p),
            );
          const target = skipParens(exprNode(p.exp));
          if (ts.isIdentifier(target) && lower.binding(target)?.kind === 'local')
            fail(
              'E_TEMPLATE',
              'v-model cannot assign a v-for or slot scope variable (Vue rejects it)',
              loc(p),
            );
          const read = value(target);
          if (typeOf(read) !== 'boolean')
            fail(
              'E_TEMPLATE',
              `v-model on a checkbox needs a boolean target, not ${JSON.stringify(typeOf(read))} (arrays and sets are planned for later)`,
              loc(p),
            );
          checked(read, p);
          // vModelCheckbox assigns el.checked on change.
          model = { ...lower.bindHandler(target, COMPONENT, 'change', tb), source: loc(p) };
          continue;
        }
        fail('E_TEMPLATE', `v-${p.name} is planned for a later milestone`, loc(p));
      }
      if (classes.length) {
        // With v-bind="$attrs", the compiler merges the class values on each side of it separately.
        const side = (p: VNode) => spreadAt !== undefined && n.props.indexOf(p) > spreadAt;
        if (classes.some(side) && !classes.every(side))
          fail(
            'E_ATTRS',
            'class on both sides of v-bind="$attrs" is unsupported; write the classes together',
            loc(classes[0]),
          );
        attrs.push({ name: 'class', value: classValue(classes) });
      }
      if (style && 'attr' in style) attrs.push({ name: 'style', value: lit(style.attr) });
      if (checkbox && !props.some(q => q.name === 'checked'))
        fail(
          'E_TEMPLATE',
          radio
            ? 'Radio buttons need v-model (uncontrolled radio buttons are planned for later)'
            : 'Checkboxes need :checked or v-model (uncontrolled checkboxes are planned for later)',
          loc(n),
        );
      if (controlModel)
        selectModels.push({
          component: COMPONENT,
          ...controlModel,
          change: parts.get('change') ?? [],
        });
      // v-model's listener is added when the directive is created, before
      // Vue patches the element's props (and its @change listener). A text
      // model's input listener is a native listener of its own (a microtask
      // checkpoint follows it), so it cannot merge with an @input.
      if (model && modelEvent === 'input' && parts.has('input'))
        fail(
          'E_EVENT',
          'v-model and @input on one text control are planned for later (Vue runs them as separate listeners, with a microtask checkpoint between them)',
          loc(n),
        );
      if (model) parts.set(modelEvent, [model, ...(parts.get(modelEvent) ?? [])]);
      if (restoreRender) {
        restoreElements.push(n);
        if (slotDepth)
          fail(
            'E_TEMPLATE',
            'A text control or select with :value or v-model in slot content is planned for later (Vue patches it when the child re-renders)',
            loc(n),
          );
      }
      for (const [event, list] of parts) {
        // Vue's invoker skips the rest of an element's listeners for an event
        // after stopImmediatePropagation(); the merged handler cannot.
        const stopper = list.slice(0, -1).find(mayStopImmediately);
        if (stopper)
          fail(
            'E_EVENT',
            `stopImmediatePropagation (or passing the event on) in one of several @${event} listeners of an element is unsupported`,
            stopper.source ?? loc(n),
          );
        const { args, source, ...h } = mergeParts(list);
        handlers.push({ event, ...h, source: list.length === 1 ? source : loc(n) });
        listeners.push({ event, handler: handlers.length - 1, ...(args?.length ? { args } : {}) });
      }
      // The attrs reach this element through v-bind="$attrs" or as the root
      // (cloneVNode: mergeProps of its own props, then the attrs). Its own
      // attributes the attrs may hold join the bag in source order: `class`
      // values join, other names take the later value.
      let spread: Expr | undefined;
      if (u.macros.inheritAttrs && plan.roots?.includes(n)) spreadAt = n.props.length;
      if (spreadAt !== undefined && restCell !== undefined) {
        const keys = plan.keys;
        for (const l of listeners)
          if (keys.has(`on${l.event}`))
            fail(
              'E_ATTRS',
              `@${l.event} is on the element and possibly in its fallthrough attributes (${keys.get(`on${l.event}`)}), which Vue would both call; this is planned for a later milestone`,
              loc(n),
            );
        const position = (name: string) =>
          n.props.findIndex(
            (q: VNode) =>
              (q.type === ATTRIBUTE && q.name === name) ||
              (q.type === DIRECTIVE && q.name === 'bind' && q.arg?.content === name),
          );
        const before: AttrItem[] = [];
        const after: AttrItem[] = [];
        for (const a of [...attrs])
          if (keys.has(a.name)) {
            (position(a.name) < spreadAt! ? before : after).push(a);
            attrs.splice(attrs.indexOf(a), 1);
          }
        spread =
          before.length || after.length
            ? { op: 'attrs', merge: true, items: [...before, { spread: attrsRead() }, ...after] }
            : attrsRead();
      }
      if (spread && (select || radio || n.tag === 'option'))
        fail(
          'E_ATTRS',
          `Fallthrough attributes on ${radio ? 'radio buttons' : `<${n.tag}>`} are planned for later`,
          loc(n),
        );
      const node: Node & { kind: 'element' } = {
        kind: 'element',
        tag: n.tag,
        ...(attrs.length ? { attrs } : {}),
        ...(props.length ? { props } : {}),
        ...(listeners.length ? { listeners } : {}),
        ...(refOf.has(n) ? { ref: refOf.get(n)! } : {}),
        ...(spread ? { spread } : {}),
        ...(style && !('attr' in style) ? style : {}),
        ...(restoreRender ? { restore: 'render' as const } : {}),
        ...(n.children.length ? { children: children(n.children) } : {}),
        source: loc(n),
      };
      if (select) checkSelectChildren(node, 'Vue keeps text between options on one line');
      return node;
    };
    /**
     * Vue's render effect, for a component whose text controls it re-patches
     * at every re-render (docs/IR.md `restore`): a tracked pre effect that
     * reads what the template reads, in its structure (branches as rendered,
     * every list item), after the props and the attrs (a parent passing a
     * changed one re-renders the child). It runs after the component's
     * watchers, as Vue renders after its pre-flush jobs; its runs are the
     * re-renders.
     */
    const renderEffect = (template: Node[]): Effect => {
      const at = loc(restoreElements[0]);
      const planned = (why: string, where = at): never =>
        fail(
          'E_TEMPLATE',
          `A text control or select with :value or v-model ${why} is planned for later`,
          where,
        );
      if (slotDecls.size)
        planned('in a component that renders slots (the content is part of its render)');
      const body: Stmt[] = [];
      const declared = new Set([
        ...(u.macros.props?.names ?? []),
        ...u.macros.models.map(m => m.prop),
      ]);
      cells.forEach((c, i) => {
        if (c.prop === '...') {
          const listeners = [...plan.keys.keys()].filter(k => /^on/.test(k));
          if (listeners.length)
            planned(
              `in a component whose fallthrough attributes may hold listeners (${listeners.join(', ')}; Vue re-renders it when a parent passes a new listener function)`,
            );
        } else if (!c.prop || !declared.has(c.prop)) return;
        else if (!primitive(c.type))
          planned(
            `in a component with a prop ${c.prop} of type ${JSON.stringify(c.type)} (Vue re-renders it whenever its parent passes a new object)`,
            c.source ?? at,
          );
        body.push({ op: 'expr', value: { op: 'cell', cell: i, read: 'current' } });
      });
      const check = (e: Expr, where: Source | undefined) => {
        if (!pure(e))
          planned('in a component whose template calls functions with side effects', where ?? at);
      };
      const read = (e: Expr | undefined, out: Stmt[], where: Source | undefined) => {
        if (!e) return;
        check(e, where);
        out.push({ op: 'expr', value: e });
      };
      const reads = (nodes: Node[], out: Stmt[]) => {
        for (const n of nodes)
          switch (n.kind) {
            case 'text':
              for (const p of n.parts) read(p, out, n.source);
              break;
            case 'element':
              for (const a of [...(n.attrs ?? []), ...(n.props ?? []), ...(n.styles ?? [])])
                read(a.value, out, n.source);
              read(n.spread, out, n.source);
              read(n.styleText, out, n.source);
              reads(n.children ?? [], out);
              break;
            case 'if': {
              const then: Stmt[] = [];
              const otherwise: Stmt[] = [];
              check(n.test, n.source);
              reads(n.then, then);
              reads(n.else ?? [], otherwise);
              out.push({ op: 'if', test: n.test, then, else: otherwise });
              break;
            }
            case 'each': {
              // renderList reads every item (and its key) in order.
              const loop: Stmt[] = [];
              read(n.key, loop, n.source);
              reads(n.body, loop);
              if (n.index !== undefined) {
                out.push({ op: 'let', local: n.index, value: { op: 'lit', value: 0 } });
                loop.push({
                  op: 'assign',
                  target: { place: 'local', local: n.index },
                  value: { op: 'add', left: L(n.index), right: { op: 'lit', value: 1 } },
                });
              }
              check(n.items, n.source);
              out.push({ op: 'for-of', local: n.item, iterable: n.items, body: loop });
              break;
            }
            case 'component':
              // Props are evaluated in this render; slot content in the child's.
              // (The prop forwarding a component ref is Runic's, not Vue's.)
              for (const p of n.props ?? [])
                if (p.name !== exposedOf[n.component]?.prop) read(p.value, out, n.source);
              break;
            case 'slot':
              planned('in a component that renders slots');
          }
      };
      reads(template, body);
      const fn = lower.reserve();
      lower.functions[fn] = {
        name: 'render',
        component: COMPONENT,
        params: [],
        locals: tb.locals.map(l => ({ ...l })),
        result: 'void',
        body,
      };
      return {
        run: fn,
        phase: 'pre',
        deps: { kind: 'tracked' },
        unmount: { removal: 'before', order: 'pre' },
        render: true,
        source: at,
      };
    };
    /** Whether evaluating an expression has no side effects (it may run again in the render effect). */
    const pure = (e: Expr): boolean => {
      const seen = new Set<number>();
      /** A function the evaluation calls: its body must be pure too. */
      const called = (fn: number): boolean => {
        if (seen.has(fn)) return true;
        seen.add(fn);
        // A computed value is cached: reading it again runs nothing new.
        if (lower.functions[fn]?.derived) return true;
        return visit(lower.functions[fn]?.body);
      };
      const visit = (x: unknown): boolean => {
        if (!x || typeof x !== 'object') return true;
        if (Array.isArray(x)) return x.every(visit);
        const o = x as Record<string, unknown>;
        if (o.op === 'set' || o.op === 'call-value') return false;
        if (o.op === 'assign' && (o.target as { place: string }).place !== 'local') return false;
        if (o.op === 'call' && !called(o.function as number)) return false;
        if (o.op === 'builtin') {
          if (!pureBuiltin(o.name as string)) return false;
          // Callbacks of array methods run during the evaluation.
          for (const a of o.args as Expr[])
            if (a.op === 'closure' && !called(a.function)) return false;
        }
        // Creating a function value runs nothing.
        if (o.op === 'closure') return true;
        return Object.values(o).every(visit);
      };
      return visit(e);
    };
    const template = children(u.descriptor.template.ast.children);
    if (restoreElements.length) effects.push({ effect: renderEffect(template), group: 3 });
    return {
      name: path.basename(u.file, '.vue'),
      cells,
      handlers,
      template,
      ...(tb.locals.length ? { templateLocals: tb.locals } : {}),
      ...(slotDecls.size
        ? {
            slots: [...slotDecls].map(([name, d]) => ({
              name,
              ...(d.types.length ? { params: d.types } : {}),
            })),
          }
        : {}),
      ...(effects.length
        ? { effects: [...effects].sort((a, b) => a.group - b.group).map(e => e.effect) }
        : {}),
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
        adapter: 'vue',
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
      assets: graph.assets,
      ...(graph.styleGuards ? { guards: graph.styleGuards } : {}),
    },
    records: types.records,
    functions: lower.functions,
    globals: lower.globals,
    components,
    root: units.get(rootFile!)!.index,
    // Vue's app.mount() marks the container.
    containerAttrs: { 'data-v-app': '' },
    // Listeners are attached to the elements themselves (a microtask
    // checkpoint after each); app.mount() runs onMounted before it returns;
    // watcher cleanups run right before their own watcher re-runs (the
    // default `interleaved`) and read live state.
    schedule: { checkpoint: 'listener', mount: 'sync' },
  };
  lower.checkStyleSpreads(ir);
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  return { ir };
}

/** Whether a component template renders fallback content for `slot`. */
function hasFallback(nodes: Node[], slot: string): boolean {
  return nodes.some(n => {
    switch (n.kind) {
      case 'slot':
        return (n.name === slot && !!n.fallback?.length) || hasFallback(n.fallback ?? [], slot);
      case 'element':
        return hasFallback(n.children ?? [], slot);
      case 'if':
        return hasFallback(n.then, slot) || hasFallback(n.else ?? [], slot);
      case 'each':
        return hasFallback(n.body, slot) || hasFallback(n.else ?? [], slot);
      case 'component':
        return (n.slots ?? []).some(d => hasFallback(d.body, slot));
      default:
        return false;
    }
  });
}

/** A lowered listener body before it becomes a handler. */
type Part = {
  params?: Local[];
  locals?: Local[];
  body: Stmt[];
  args?: Expr[];
  source?: Source;
};

/**
 * The KeyboardEvent.key values a list of Vue key modifiers accepts: withKeys
 * runs the handler when `hyphenate(event.key)` equals a modifier or its alias.
 * Key values are named keys in PascalCase or single characters, so the
 * candidates are the modifier as written, capitalised, upper-cased and in
 * PascalCase, kept when they hyphenate back to the modifier.
 */
export function vueKeyValues(modifiers: string[]): string[] {
  const out = new Set<string>();
  for (const m of modifiers)
    for (const t of [m, KEY_NAMES[m]]) {
      if (t === undefined) continue;
      const pascal = t.split('-').map(capitalize).join('');
      for (const k of [t, capitalize(t), t.toUpperCase(), pascal])
        if (hyphenate(k) === t) out.add(k);
    }
  return [...out];
}

/** The modifiers of a directive as written. */
function modifierNames(p: VNode): string[] {
  return (p.modifiers ?? []).map((m: VNode) => (typeof m === 'string' ? m : m.content) as string);
}

/**
 * compiler-dom's resolveModifiers for a static element event: key names
 * (withKeys, applied on keyboard events only), runtime guards (withModifiers)
 * and listener options. `left`/`right` are arrow keys on keyboard events and
 * mouse buttons elsewhere; any other unknown modifier is a key name.
 */
export function resolveModifiers(
  event: string,
  modifiers: string[],
): { keys: string[]; guards: string[]; options: string[] } {
  const keys: string[] = [];
  const guards: string[] = [];
  const options: string[] = [];
  for (const m of modifiers) {
    if (OPTION_MODIFIERS.has(m)) options.push(m);
    else if (m === 'left' || m === 'right') (KEYBOARD_EVENTS.has(event) ? keys : guards).push(m);
    else if (NON_KEY_MODIFIERS.has(m)) guards.push(m);
    else keys.push(m);
  }
  return { keys, guards, options };
}

/** The event compiler-dom listens to: `@click.right` → contextmenu, `@click.middle` → mouseup. */
export function listenedEvent(event: string, modifiers: string[]): string {
  const { guards } = resolveModifiers(event, modifiers);
  let listened = event;
  if (guards.includes('right') && listened === 'click') listened = 'contextmenu';
  if (guards.includes('middle') && listened === 'click') listened = 'mouseup';
  return listened;
}

/**
 * Wrap a listener as compiler-dom does: withModifiers(handler, guards) runs
 * the guards in order (`stop` and `prevent` act and continue; the others end
 * the listener when they fail), then withKeys(…, keys) checks the key first on
 * keyboard events. Key modifiers on other events are ignored, as in Vue.
 * Modifier keys and `button` are undefined on input and change events (a
 * `.ctrl` guard always fails there; `.exact` and the button guards pass).
 */
function withModifiers(part: Part, event: string, guards: string[], keys: string[]): Part {
  const member = (name: string, type: Type): Expr => ({
    op: 'builtin',
    name: `event.${name}`,
    args: [{ op: 'event' }],
    type,
  });
  const act = (name: string): Stmt => ({ op: 'expr', value: member(name, 'void') });
  const keyed = KEYBOARD_EVENTS.has(event) || MOUSE_EVENTS.has(event);
  /** When a guard lets the event through: an expression, always (true) or never (false). */
  const passes = (m: string): Expr | boolean => {
    switch (m) {
      case 'self': // e.target !== e.currentTarget
        return {
          op: 'eq',
          left: { op: 'some', value: member('target', 'element') },
          right: member('currentTarget', { maybe: 'element' }),
        };
      case 'ctrl':
      case 'shift':
      case 'alt':
      case 'meta':
        return keyed && member(`${m}Key`, 'boolean');
      case 'exact': {
        const others = SYSTEM_MODIFIERS.filter(s => !guards.includes(s));
        if (!keyed || !others.length) return true;
        return others
          .map((s): Expr => ({ op: 'not', arg: member(`${s}Key`, 'boolean') }))
          .reduce((a, b) => ({ op: 'and', left: a, right: b }));
      }
      case 'left':
      case 'middle':
      case 'right': // 'button' in e && e.button !== n
        return (
          !MOUSE_EVENTS.has(event) || {
            op: 'eq',
            left: member('button', 'number'),
            right: { op: 'lit', value: ['left', 'middle', 'right'].indexOf(m) },
          }
        );
      default:
        return true;
    }
  };
  let body = part.body;
  for (const m of [...guards].reverse()) {
    if (m === 'stop') body = [act('stopPropagation'), ...body];
    else if (m === 'prevent') body = [act('preventDefault'), ...body];
    else {
      const test = passes(m);
      if (test === false) body = [];
      else if (test !== true) body = [{ op: 'if', test, then: body }];
    }
  }
  if (keys.length && KEYBOARD_EVENTS.has(event)) {
    // hyphenate(e.key) is one of the modifiers (or its alias).
    const values = vueKeyValues(keys);
    body = values.length
      ? [
          {
            op: 'if',
            test: values
              .map((k): Expr => ({
                op: 'eq',
                left: member('key', 'string'),
                right: { op: 'lit', value: k },
              }))
              .reduce((a, b) => ({ op: 'or', left: a, right: b })),
            then: body,
          },
        ]
      : [];
  }
  return { ...part, body };
}

const hasReturn = (body: Stmt[]): boolean =>
  body.some(s => {
    switch (s.op) {
      case 'return':
        return true;
      case 'if':
        return hasReturn(s.then) || hasReturn(s.else ?? []);
      case 'while':
        return hasReturn(s.body) || hasReturn(s.update ?? []);
      case 'for-of':
        return hasReturn(s.body);
      case 'try':
        return hasReturn(s.body) || hasReturn(s.catch?.body ?? []) || hasReturn(s.finally ?? []);
      default:
        return false;
    }
  });

/** Replace `return` by a break out of the loop labelled `label`. */
function breakReturns(body: Stmt[], label: string): Stmt[] {
  return body.flatMap((s): Stmt[] => {
    switch (s.op) {
      case 'return':
        return [
          ...(s.value ? [{ op: 'expr', value: s.value } as Stmt] : []),
          { op: 'break', label },
        ];
      case 'if':
        return [
          {
            ...s,
            then: breakReturns(s.then, label),
            ...(s.else ? { else: breakReturns(s.else, label) } : {}),
          },
        ];
      case 'while':
        return [
          {
            ...s,
            body: breakReturns(s.body, label),
            ...(s.update ? { update: breakReturns(s.update, label) } : {}),
          },
        ];
      case 'for-of':
        return [{ ...s, body: breakReturns(s.body, label) }];
      case 'try':
        return [
          {
            ...s,
            body: breakReturns(s.body, label),
            ...(s.catch ? { catch: { ...s.catch, body: breakReturns(s.catch.body, label) } } : {}),
            ...(s.finally ? { finally: breakReturns(s.finally, label) } : {}),
          },
        ];
      default:
        return [s];
    }
  });
}

/**
 * One handler calling Vue's listeners for an event in order (Vue merges
 * duplicate `@event` bindings into an array; v-model listens first). A
 * `return` ends only its own listener.
 */
function mergeParts(list: Part[]): Part {
  if (list.length === 1) return list[0];
  return list
    .map((p, i): Part => {
      if (!hasReturn(p.body)) return p;
      const label = `listener$${i}`;
      return {
        ...p,
        body: [
          {
            op: 'while',
            test: { op: 'lit', value: true },
            label,
            body: [...breakReturns(p.body, label), { op: 'break', label }],
          },
        ],
      };
    })
    .reduce((a, b) => {
      const aP = a.params?.length ?? 0;
      const bP = b.params?.length ?? 0;
      const aL = a.locals?.length ?? 0;
      const bodyA = remapLocals(a.body, i => (i < aP ? i : i + bP));
      const bodyB = remapLocals(b.body, i => (i < bP ? i + aP : i + aP + aL));
      const params = [...(a.params ?? []), ...(b.params ?? [])];
      const locals = [...(a.locals ?? []), ...(b.locals ?? [])];
      const args = [...(a.args ?? []), ...(b.args ?? [])];
      return {
        ...(params.length ? { params } : {}),
        ...(locals.length ? { locals } : {}),
        body: [...bodyA, ...bodyB],
        ...(args.length ? { args } : {}),
      };
    });
}

/** Widen an initial value to the cell type (T → Maybe<T>). */
function coerceInit(v: Expr, from: Type, to: Type, records: RecordType[]): Expr {
  if (maybeInner(to) && !maybeInner(from))
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

/** The initialiser of a required prop: reading it unpassed throws. */
function required(t: Type): Expr {
  return { op: 'unwrap', value: { op: 'undefined', type: { maybe: t } } };
}
const isRequired = (init: Expr) => init.op === 'unwrap' && init.value.op === 'undefined';

/** toDisplayString of a nullable primitive: '' when nullish. */
function maybeText(lower: Lowerer, v: Expr, t: Type): Expr {
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

// @vue/shared 3.5.43 style helpers, for static styles (the compiler parses a
// static `style` attribute into an object at build time).
const listDelimiterRE = /;(?![^(]*\))/g;
const propertyDelimiterRE = /:([^]+)/;
const styleCommentRE = /"(?:[^"\\]|\\[^])*"|'(?:[^'\\]|\\[^])*'|\\[^]|\/\*[^]*?\*\//g;

/** parseStringStyle: the declarations of a style text by key, in order (a later one wins in place). */
export function parseStringStyle(cssText: string): Map<string, string> {
  const ret = new Map<string, string>();
  cssText
    .replace(styleCommentRE, match => (match.startsWith('/*') ? '' : match))
    .split(listDelimiterRE)
    .forEach(item => {
      if (item) {
        const tmp = item.split(propertyDelimiterRE);
        if (tmp.length > 1) ret.set(tmp[0].trim(), tmp[1].trim());
      }
    });
  return ret;
}

/** stringifyStyle: the text static HTML carries for a style object. */
export function stringifyStyle(styles: Map<string, string>): string {
  let ret = '';
  for (const [key, value] of styles)
    ret += `${key.startsWith('--') ? key : hyphenate(key)}:${value};`;
  return ret;
}

/** Whether a key is an array index, which object enumeration puts first. */
const isIndexKey = (key: string) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;

/** Types whose props Vue compares by value (a changed prop re-renders the child). */
const primitive = (t: Type): boolean => {
  const inner = maybeInner(t) ?? t;
  return inner === 'string' || inner === 'number' || inner === 'boolean';
};

/** Built-ins that mutate state or act on the host (runic-ir's catalogue). */
const IMPURE_BUILTINS = new Set([
  'array.push',
  'array.pop',
  'array.shift',
  'array.unshift',
  'array.splice',
  'array.sort',
  'array.reverse',
  'array.fill',
  'array.copyWithin',
  'map.set',
  'map.delete',
  'map.clear',
  'set.add',
  'set.delete',
  'set.clear',
  'storage.set',
  'storage.remove',
  'storage.clear',
  'event.preventDefault',
  'event.stopPropagation',
  'event.stopImmediatePropagation',
]);
const pureBuiltin = (name: string): boolean =>
  !IMPURE_BUILTINS.has(name) &&
  !/^(timer|microtask|promise|flush|window|document|element|console|clipboard|history|location|random)\./.test(
    name,
  ) &&
  !/^root\.(set-attr|remove-attr|class-toggle|class-add|class-remove|style-set|style-remove)$/.test(
    name,
  );
