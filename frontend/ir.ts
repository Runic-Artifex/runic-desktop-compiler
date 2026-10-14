// Runic IR schema 5 as TypeScript types. Mirrors crates/runic-ir/src/lib.rs;
// the Rust validator is authoritative. See docs/IR.md and
// docs/design/M2-VALUES.md.

export const SCHEMA = 5;

export interface Source {
  file: string;
  line: number;
  column: number;
}

export type Type =
  | 'number'
  | 'string'
  | 'boolean'
  | { maybe: Type }
  | { array: Type }
  | { record: number }
  /** An instance of class record `class` or of a subclass (M6 inheritance; the class has subclasses). */
  | { class: number }
  /** An instance of one of several unrelated classes or their subclasses (ascending, two or more). */
  | { classes: number[] }
  /**
   * A value of one of two or more members, in this order: number, string,
   * boolean, element, one plain record (M6 unions). The value knows its
   * member as a JavaScript value does.
   */
  | { union: Type[] }
  | { map: [Type, Type] }
  | { set: Type }
  | { promise: Type }
  | { fn: { params: Type[]; result: Type } }
  /** An element handle (DOM ref). */
  | 'element'
  /** An event object (handlers' `event`). */
  | 'event'
  /** An attribute bag (rest props, spread attributes). */
  | 'attrs'
  /** A RegExp object (identity; mutable lastIndex). */
  | 'regexp'
  | 'media-query'
  /** A Date object (identity; mutable time value). */
  | 'date'
  /** A component instance mounted imperatively (`mount`; identity, M6). */
  | 'mounted'
  /** The contexts an instance sees (`context.all`, Svelte's getAllContexts; identity, M6). */
  | 'contexts'
  /** A CSS animation or transition of an element (`element.getAnimations()`; identity, M6). */
  | 'animation'
  /**
   * An image object (`new Image()`; identity, M6 images): its source,
   * reflected attributes and load/error listeners, through `image.*`
   * built-ins (docs/IR.md).
   */
  | 'image'
  /**
   * A dynamic value (M6 spike, docs/design/M6-DYNAMIC-VALUES.md): any
   * JavaScript value, operated on through `dyn.*` built-ins; static values
   * are boxed (`dyn.from`) and unboxed with a check (`dyn.to`).
   */
  | 'dyn'
  | 'void';

export type Literal = boolean | number | string;

/**
 * A declaration the style engine drops (docs/IR.md, styles): reported once
 * an element matches `selector` and not `unless` (the rules overriding it);
 * with `when` `"scroll-target"`, once such an element is scrolled into view;
 * with `"scroll-container:<axis>:<px>"` (a scroll padding of `block`,
 * `inline` or `both` axes, in pixels where known), once a target inside
 * such an element is scrolled into view where the padding would move it;
 * with `"desktop:<features>"` (`prefers-reduced-motion`, `prefers-contrast`,
 * comma-separated: a rule under a media query on desktop preferences),
 * natively where the runtime cannot read one of them on the desktop.
 */
export interface StyleGuard {
  selector: string;
  unless?: string;
  when?:
    | 'scroll-target'
    | `scroll-container:${'block' | 'inline' | 'both'}:${string}`
    | `desktop:${string}`;
  message: string;
}

/**
 * An attribute bag item: an entry, the entries of another bag, or an
 * attachment (a function of the element returning its cleanup or nothing)
 * under a key of its own, created when the bag is (M6).
 */
export type AttrItem = { name: string; value: Expr } | { spread: Expr } | { attach: Expr };

/** Event kinds (docs/design/M5-PLATFORM.md). */
export type EventKind =
  | 'click'
  | 'submit'
  | 'input'
  | 'change'
  | 'keydown'
  | 'keyup'
  | 'dblclick'
  | 'contextmenu'
  | 'pointerdown'
  | 'pointerup'
  | 'pointermove'
  | 'pointerenter'
  | 'pointerleave'
  | 'mousedown'
  | 'mouseup'
  | 'mousemove'
  | 'mouseenter'
  | 'mouseleave'
  | 'pointerover'
  | 'pointerout'
  | 'mouseover'
  | 'mouseout'
  | 'wheel'
  | 'focus'
  | 'blur'
  | 'focusin'
  | 'focusout'
  | 'scroll'
  | 'resize'
  | 'popstate'
  | 'hashchange'
  | 'load'
  | 'error';

export const EVENT_KINDS: readonly EventKind[] = [
  'click',
  'submit',
  'input',
  'change',
  'keydown',
  'keyup',
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
  'pointerover',
  'pointerout',
  'mouseover',
  'mouseout',
  'wheel',
  'focus',
  'blur',
  'focusin',
  'focusout',
  'scroll',
  'resize',
];

/** Session history events: fired at the window only (window listeners). */
export const WINDOW_EVENT_KINDS: readonly EventKind[] = ['popstate', 'hashchange'];

/**
 * An image request's outcome (M6 images): listened to only through `<img>`
 * elements' template attributes, never by script or at the window.
 */
export const IMAGE_EVENT_KINDS: readonly EventKind[] = ['load', 'error'];

export type Read = 'current' | 'snapshot';

export type Expr =
  | { op: 'lit'; value: Literal }
  | { op: 'undefined'; type: Type }
  | { op: 'null'; type: Type }
  | { op: 'cell'; cell: number; read?: Read }
  | { op: 'global'; global: number }
  | { op: 'local'; local: number }
  | { op: 'payload' }
  /** The event object of the running handler. */
  | { op: 'event' }
  /**
   * An attribute bag; a later entry of a name wins. With `merge`, an entry
   * (or a spread bag's resolved entry) combines with an earlier one of its
   * name in place: `class` values join, other names take the later value.
   */
  | { op: 'attrs'; items: AttrItem[]; merge?: true }
  | {
      op:
        | 'not'
        | 'neg'
        | 'to-string'
        | 'to-number'
        | 'to-boolean'
        | 'utf16-length'
        | 'typeof'
        | 'bit-not';
      arg: Expr;
    }
  | {
      op:
        | 'add'
        | 'sub'
        | 'mul'
        | 'div'
        | 'rem'
        | 'pow'
        | 'min'
        | 'max'
        | 'concat'
        | 'eq'
        | 'ne'
        | 'lt'
        | 'le'
        | 'gt'
        | 'ge'
        | 'and'
        | 'or'
        | 'nullish'
        | 'bit-and'
        | 'bit-or'
        | 'bit-xor'
        | 'shl'
        | 'shr'
        | 'ushr';
      left: Expr;
      right: Expr;
    }
  | { op: 'cond'; test: Expr; then: Expr; else: Expr }
  | { op: 'mapped'; rule: string; guard: Expr; fast: Expr; reference: Expr }
  | { op: 'record'; record: number; fields: Expr[] }
  | { op: 'array'; type: Type; items: (Expr | { spread: Expr })[] }
  | { op: 'get'; object: Expr; field: number }
  | { op: 'index'; array: Expr; index: Expr }
  | { op: 'some'; value: Expr }
  | { op: 'optional'; value: Expr; local: number; then: Expr }
  | { op: 'call'; function: number; args: Expr[] }
  | { op: 'call-value'; callee: Expr; args: Expr[] }
  | { op: 'closure'; function: number; captures: number[]; stable?: boolean }
  | { op: 'builtin'; name: string; args: Expr[]; type: Type }
  /** Evaluate `value`, bind it to `local`, then evaluate `body` (sequencing with a temporary). */
  | { op: 'with'; local: number; value: Expr; body: Expr }
  /** Whether the running instance's parent provides content for its slot `name` (M6). */
  | { op: 'slot-provided'; name: string }
  /** Unwrap a Maybe; throws TypeError when nullish (`x!` then member access). */
  | { op: 'unwrap'; value: Expr }
  /**
   * A class instance (or a Maybe of one) as a wider class type (M6
   * inheritance), or a union member (or narrower union) as a union.
   */
  | { op: 'upcast'; value: Expr; type: Type }
  /**
   * A class reference (or a Maybe of one) as a narrower class type, or a
   * union value as some of its members; TypeError when it is not.
   */
  | { op: 'downcast'; value: Expr; type: Type }
  /** Branch on the member a union value holds; each case binds the value as that member. */
  | {
      op: 'match-union';
      value: Expr;
      cases: { type: Type; local: number; body: Expr }[];
      else?: Expr;
    }
  /** Branch on the class of a class reference; each case binds the instance as its exact class. */
  | {
      op: 'match-class';
      value: Expr;
      cases: { record: number; local: number; body: Expr }[];
      else?: Expr;
    }
  /**
   * Mount an instance of the component of mount site `site` of the running
   * function's component as the last child of `target` (Svelte's `mount`, M6):
   * props evaluated once, contexts found through `context`.
   */
  | {
      op: 'mount';
      site: number;
      target: Expr;
      props?: { name: string; value: Expr }[];
      context?: Expr;
    };

export type Place =
  | { place: 'local'; local: number }
  | { place: 'cell'; cell: number }
  | { place: 'field'; object: Expr; field: number }
  | { place: 'index'; array: Expr; index: Expr };

export type Stmt = (
  | { op: 'set'; cell: number; value: Expr }
  | { op: 'let'; local: number; value?: Expr }
  | { op: 'assign'; target: Place; value: Expr }
  | { op: 'expr'; value: Expr }
  | { op: 'if'; test: Expr; then: Stmt[]; else?: Stmt[] }
  | { op: 'while'; test: Expr; body: Stmt[]; update?: Stmt[]; label?: string }
  | { op: 'for-of'; local: number; iterable: Expr; body: Stmt[]; label?: string }
  | { op: 'break' | 'continue'; label?: string }
  | { op: 'return'; value?: Expr }
  | { op: 'throw'; value: Expr }
  | { op: 'try'; body: Stmt[]; catch?: { local?: number; body: Stmt[] }; finally?: Stmt[] }
) & { source?: Source };

export interface Local {
  name: string;
  type: Type;
  boxed?: boolean;
}

/** Local index space of a function: [...captures, ...params, ...locals]. */
export interface Fn {
  /** A cached derived value of its component (`$derived`, `computed`). */
  derived?: boolean;
  /** Compare recomputed values with === (Svelte), not SameValue. */
  derivedStrict?: boolean;
  name: string;
  /** Component whose cells the function reads and writes, if any. */
  component?: number;
  captures?: Local[];
  params: Local[];
  locals: Local[];
  result: Type;
  body: Stmt[];
  source?: Source;
}

export interface RecordType {
  name: string;
  fields: RecordField[];
  /** A class instance record (nominal: never shared by shape; not proxied, not plain data). */
  class?: true;
  /** The base class record (M6 inheritance): its fields are a prefix of this record's. */
  extends?: number;
  /** An abstract class (never constructed). */
  abstract?: true;
  /** A tuple of items of different types (fields `0`…): an array in JavaScript. */
  tuple?: true;
}

export interface RecordField {
  name: string;
  type: Type;
  /**
   * A reactive class field (M6 stage B): Svelte's `$state` (deep: plain
   * objects and arrays stored into it become proxies), `$state.raw` or
   * `$derived` (computed from the instance by function `derived` when read).
   */
  reactive?: 'state' | 'raw' | 'derived';
  derived?: number;
}

export interface Cell {
  /** Must not be mutated in place (React state and props). */
  readonly?: boolean;
  name: string;
  type: Type;
  init: Expr;
  tracking?: 'deep' | 'identity' | 'none' | 'proxied';
  domain?: { kind: 'text'; maxUtf16: number };
  /** The prop this cell receives from its parent (`init` is the default). */
  prop?: string;
  /**
   * A prop whose parent passes `undefined` takes its default (`init`), as
   * Svelte's `$props()` defaults do; the parent may then pass a nullable value
   * of the cell's type (M6).
   */
  undefinedDefault?: true;
  source?: Source;
}

/** A module constant (evaluated once at startup). */
export interface Global {
  name: string;
  type: Type;
  init: Expr;
  source?: Source;
}

export interface Handler {
  name?: string;
  event: EventKind;
  /** Values passed by the listener; the local index space is params, then locals. */
  params?: Local[];
  locals?: Local[];
  body: Stmt[];
  source?: Source;
}

export interface Attr {
  name: string;
  value: Expr;
}

export type Node =
  | {
      kind: 'element';
      tag: string;
      attrs?: Attr[];
      /**
       * Live properties: `value`, `checked`, a text area's `defaultValue`, a
       * select's `selectValue` (React DOM: unmatched, the first enabled option).
       */
      props?: Attr[];
      listeners?: Listener[];
      /**
       * Listeners of custom event types (M6 script DOM, slice 3): a type
       * Chromium never dispatches itself, and a listener value (template
       * scope, evaluated at each dispatch; nullish: nothing runs).
       */
      customListeners?: { event: string; listener: Expr }[];
      /** A cell holding this element while mounted (null after removal). */
      ref?: number;
      /** An attribute bag applied after `attrs` (whose names it never holds). */
      spread?: Expr;
      /**
       * Boolean spread entries of names without a boolean element property
       * become "true"/"false" (Svelte); otherwise true is empty, false absent.
       */
      spreadBooleanText?: true;
      /** Class toggles composed with the (string) class attribute. */
      classes?: Attr[];
      /**
       * A managed inline style: value and properties (through the CSSOM);
       * without `styleText`, properties only (React DOM).
       */
      styleText?: Expr;
      styles?: Attr[];
      /**
       * `replace` (Vue's patchStyle): a style text set through cssText when it
       * changes, or properties all set again in order when one changes.
       */
      styleUpdate?: 'compose' | 'replace';
      /** `render`: live properties are also applied at each re-render of the instance. */
      restore?: 'render';
      /**
       * A text control adopting its own value at mount (Svelte's bind_value):
       * after the attributes and spread, before the live properties, when
       * `when` holds and the value is not empty, the `input` handler runs
       * once for an input event of it.
       */
      adopt?: { when: Expr; handler: number; args?: Expr[] };
      children?: Node[];
      source?: Source;
    }
  | { kind: 'text'; parts: Expr[]; source?: Source }
  /**
   * `{@html value}` (M6): the nodes of the program fragment (`Program.fragments`)
   * among `fragments` whose `html` is the value (a string, nullish rendering
   * nothing), parsed at build time; another value is unsupported at run time.
   */
  | { kind: 'html'; value: Expr; fragments: number[]; source?: Source }
  | { kind: 'if'; test: Expr; then: Node[]; else?: Node[]; source?: Source }
  | {
      kind: 'component';
      component: number;
      props?: { name: string; value: Expr; bind?: Expr }[];
      /**
       * Parent-owned content for the child's slots; params are template
       * locals. With `when`, the content counts as provided only while it
       * holds (evaluated in the parent: content forwarded from the parent's
       * own slot, M6).
       */
      slots?: SlotDef[];
      source?: Source;
    }
  | { kind: 'slot'; name: string; args?: Expr[]; fallback?: Node[]; source?: Source }
  | {
      kind: 'each';
      items: Expr;
      item: number;
      index?: number;
      key?: Expr;
      /** Which reused blocks a keyed update moves (the framework's keyed diff). */
      reorder?: 'lis' | 'forward' | 'stash';
      body: Node[];
      else?: Node[];
      source?: Source;
    };

export interface Listener {
  event: EventKind;
  handler: number;
  args?: Expr[];
  /** A listener of the capture phase (M6 script DOM; React's `onClickCapture`). */
  capture?: true;
}

export interface Component {
  name: string;
  cells: Cell[];
  handlers: Handler[];
  template: Node[];
  templateLocals?: Local[];
  /** Slots the template renders, with the types of their arguments. */
  slots?: { name: string; params?: Type[] }[];
  /** Effects of each instance, in declaration order. */
  effects?: Effect[];
  /** Components its functions mount imperatively (`mount` names a site by index; M6). */
  mounts?: MountSite[];
}

/** Parent-owned content for a child's slot (params are template locals of the parent). */
export interface SlotDef {
  name: string;
  params?: number[];
  body: Node[];
  when?: Expr;
}

/** A component a component mounts imperatively, with the content it provides for its slots. */
export interface MountSite {
  component: number;
  slots?: SlotDef[];
  source?: Source;
}

/**
 * A component function run around updates when its dependencies changed;
 * a returned function is its cleanup (docs/design/M4-EFFECTS.md).
 */
export interface Effect {
  run: number;
  phase: 'pre' | 'layout' | 'post';
  deps:
    { kind: 'tracked' | 'once' | 'always' } | { kind: 'values'; values: Expr[]; initial?: boolean };
  unmount: { removal: 'before' | 'after'; order: 'pre' | 'post' };
  /** The instance's render (Vue's render effect): each run is a re-render. */
  render?: boolean;
  source?: Source;
}

/** The framework's update scheduling (docs/design/M4-EFFECTS.md). */
export interface Schedule {
  /** `event-microtask`: a microtask during input events, otherwise a default-priority task. */
  flush?: 'microtask' | 'event-microtask';
  /** `listener`: a microtask checkpoint after each listener instead of after each event. */
  checkpoint?: 'dispatch' | 'listener';
  /** A checkbox's `change` listeners run in the `click` dispatch. */
  changeWithClick?: boolean;
  /** Controlled values are restored after every event (React). */
  controlledRestore?: boolean;
  /** The framework ignores events dispatched during its DOM update (React DOM's commit). */
  commitEventsIgnored?: boolean;
  /**
   * `batched`: all cleanups of a phase run before its effects, in one walk
   * (children first) that includes the layout and post cleanups of
   * instances destroyed by the update: at each instance the destroyed
   * subtrees under it, then its live children, then its own cleanups.
   */
  cleanups?: 'interleaved' | 'batched';
  /** Writes from post effects update in a later default-priority task. */
  postWritesDeferred?: boolean;
  /** When the initial mount's effects run (default: a microtask). */
  mount?: 'sync' | 'microtask' | 'task';
  /** Cleanups read state as it was before the running flush's writes. */
  cleanupReadsPrevious?: boolean;
  /**
   * Events whose listeners' updates render as a default-priority task (React's
   * continuous priority): after the rendering step for events it dispatches
   * (`scroll`); a discrete update before that renders them at once.
   */
  continuous?: EventKind[];
  /**
   * How the framework orders its template listeners with listeners script
   * adds (docs/IR.md "Delegation"): the kinds whose bubbling template
   * listeners it runs from a delegation root (Svelte's); absent where not
   * declared (the runtime then reports an order it cannot know).
   */
  delegation?: EventKind[];
  /**
   * The framework's template listeners are native listeners of their
   * elements, registered when it creates the element (Vue's invokers;
   * docs/IR.md "Delegation"): they run at their elements in registration
   * order with listeners script adds. Not together with `delegation`.
   */
  elementListeners?: true;
  /**
   * The framework runs its template listeners from listeners of its own at
   * the container, one in the capture and one in the bubbling phase per
   * kind, registered at the start of the mount (React's root; docs/IR.md
   * "Delegation"). Not together with `delegation` or `elementListeners`.
   */
  rootDispatch?: RootDispatch;
}

/** `schedule.rootDispatch` (M6 script DOM; docs/IR.md "Delegation"). */
export interface RootDispatch {
  /**
   * The kinds the root listens for: their template listeners run from the
   * root's capture listener (capture ones, root down to the target) and its
   * bubbling listener (the others, target up), each phase's as one callback.
   * Template listeners of other kinds are native listeners of their elements.
   */
  kinds: EventKind[];
  /** Kinds whose template listeners do not run on a disabled button, input, select or textarea. */
  skipDisabled?: EventKind[];
  /** Kinds whose listeners script adds are reported unsupported (an order the IR does not model). */
  reported?: EventKind[];
}

/**
 * A file embedded in the application: a CSS font or (M6) an image, at most
 * 4 MiB, and 32 MiB for all of a program's assets. `mime` is `font/woff2`,
 * `image/png`, `image/jpeg`, `image/webp`, `image/gif`, or `image/svg+xml` in a
 * program that draws inline SVG (the validator checks it).
 */
export interface Asset {
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
}

/**
 * An image URL pinned at build time (M6, docs/design/M6-IMAGES.md): the index
 * of an image asset in `Program.assets`, or the HTTP status of a pinned failure.
 */
export type Image = { url: string; asset: number } | { url: string; status: number };

/**
 * An image URL a program can load, with the source location naming it (M6,
 * docs/design/M6-IMAGES.md). The builder pins each one (`compiler/images.mjs`).
 */
export interface ImageUrl {
  url: string;
  source: Source;
}

/**
 * What a frontend adapter returns: the program and the image URLs it can load
 * (absent: none; the Svelte adapter lists each `<img>` `src` value).
 */
export interface Lowering {
  ir: Program;
  imageUrls?: ImageUrl[];
}

export interface Program {
  schema: 5;
  meta: {
    title: string;
    sourceHash: string;
    frontend: unknown;
    provenance?: unknown;
    mappings?: { id: string; version: number; sha256: string }[];
  };
  renderer?: 'cpu' | 'gpu';
  capabilities: string[];
  styles: {
    css: string;
    /** Declarations the style engine drops, reported once their selector matches. */
    guards?: StyleGuard[];
  };
  /** Embedded files: fonts the CSS references and, from M6, images. */
  assets: Asset[];
  /** The image URLs the program can load, each pinned once. */
  images: Image[];
  records?: RecordType[];
  functions?: Fn[];
  globals?: Global[];
  components: Component[];
  root: number;
  containerAttrs?: Record<string, string>;
  /** The document element's initial attributes (index.html's or app.html's `<html>`). */
  document?: Record<string, string>;
  /** `<body>`'s attributes in the app's HTML template (SvelteKit's app.html, M6). */
  body?: Record<string, string>;
  /** The mount container's attributes from the app's HTML template (M6); absent: `div#root`. */
  container?: Record<string, string>;
  /** Refocus an element blurred by a list move after each update (React DOM). */
  restoreFocus?: boolean;
  /** When updates run relative to tasks and microtasks (default: microtask flush, one checkpoint per event). */
  schedule?: Schedule;
  /** HTML parsed at build time for `{@html}` (M6): each string and its nodes. */
  fragments?: Fragment[];
}

/** An HTML string parsed at build time (`{@html}`, M6). */
export interface Fragment {
  html: string;
  nodes: FragmentNode[];
}

/** A static node of a fragment: an element with literal attributes, or text. */
export type FragmentNode =
  { tag: string; attrs?: [string, string][]; children?: FragmentNode[] } | { text: string };

export const lit = (value: Literal): Expr => ({ op: 'lit', value });
export const str = (value: string): Expr => ({ op: 'lit', value });
