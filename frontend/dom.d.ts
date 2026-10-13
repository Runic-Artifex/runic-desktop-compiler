// Host APIs of the browser that the compiler lowers (instead of lib.dom, which
// is not part of the program): the DOM element interfaces components may hold
// as refs (bind:this, useRef, template refs; opaque handles in the IR whose
// methods below lower to `element.*` built-ins), timers and clocks.
interface HTMLElement extends Node {
  readonly __runicElement: true;
  /** M6 script DOM, slice 2: ParentNode members, classList and dataset. */
  append(...nodes: (Node | string)[]): void;
  prepend(...nodes: (Node | string)[]): void;
  readonly children: HTMLCollection;
  readonly firstElementChild: HTMLElement | null;
  readonly lastElementChild: HTMLElement | null;
  readonly classList: DOMTokenList;
  readonly dataset: DOMStringMap;
  focus(): void;
  blur(): void;
  /** M6 overlays: a click nested in the script; `select()` the text of a text control. */
  click(): void;
  select(): void;
  /**
   * M6 (bits-ui's Select trigger): no pointer is ever captured natively
   * (`setPointerCapture` is unsupported; the mouse is not captured
   * implicitly), so this is false and releasing is reported unsupported.
   */
  hasPointerCapture(pointerId: number): boolean;
  /**
   * M6 (bits-ui's Command): the parent element (null when detached; the
   * container of the program's top-level elements is reported unsupported),
   * and moving one of the children to the end (other uses are reported
   * unsupported, as is the framework inserting into the element afterwards).
   */
  readonly parentElement: HTMLElement | null;
  readonly nextElementSibling: HTMLElement | null;
  readonly previousElementSibling: HTMLElement | null;
  /**
   * M6 script DOM (docs/design/M6-SCRIPT-DOM.md): nodes script created move
   * within child lists script owns (theirs, the body's outside the
   * container, an element the template renders without children); a
   * child of this element moves to its end (bits-ui's Command).
   */
  appendChild(child: Node): Node;
  insertBefore(node: Node, child: Node | null): Node;
  replaceChildren(...nodes: Node[]): void;
  remove(): void;
  /** The first child node: of nodes script created, script hosts and the body. */
  readonly firstChild: ChildNode | null;
  readonly childElementCount: number;
  /** Writes replace the children by text (with `<br>` for line breaks); reads are not covered. */
  innerText: string;
  className: string;
  role: string | null;
  ariaAtomic: string | null;
  ariaAutoComplete: string | null;
  ariaBusy: string | null;
  ariaChecked: string | null;
  ariaColCount: string | null;
  ariaColIndex: string | null;
  ariaColSpan: string | null;
  ariaCurrent: string | null;
  ariaDescription: string | null;
  ariaDisabled: string | null;
  ariaExpanded: string | null;
  ariaHasPopup: string | null;
  ariaHidden: string | null;
  ariaInvalid: string | null;
  ariaKeyShortcuts: string | null;
  ariaLabel: string | null;
  ariaLevel: string | null;
  ariaLive: string | null;
  ariaModal: string | null;
  ariaMultiLine: string | null;
  ariaMultiSelectable: string | null;
  ariaOrientation: string | null;
  ariaPlaceholder: string | null;
  ariaPosInSet: string | null;
  ariaPressed: string | null;
  ariaReadOnly: string | null;
  ariaRelevant: string | null;
  ariaRequired: string | null;
  ariaRoleDescription: string | null;
  ariaRowCount: string | null;
  ariaRowIndex: string | null;
  ariaRowSpan: string | null;
  ariaSelected: string | null;
  ariaSetSize: string | null;
  ariaSort: string | null;
  ariaValueMax: string | null;
  ariaValueMin: string | null;
  ariaValueNow: string | null;
  ariaValueText: string | null;
  releasePointerCapture(pointerId: number): void;
  // Layout reads and scrolling (CSSOM View), from the native layout.
  getBoundingClientRect(): DOMRect;
  /** M6 (bits-ui's floating layer): the element's border boxes (none without a box). */
  getClientRects(): DOMRect[];
  /** M6: the `hidden` attribute's presence (`until-found` is reported unsupported). */
  readonly hidden: boolean;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly clientLeft: number;
  readonly clientTop: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  scrollTop: number;
  scrollLeft: number;
  scrollTo(options?: ScrollToOptions): void;
  scrollTo(x: number, y: number): void;
  scrollBy(options?: ScrollToOptions): void;
  scrollBy(x: number, y: number): void;
  scrollIntoView(arg?: boolean | ScrollIntoViewOptions): void;
  // M6 (bits-ui): attributes, connection, inline style properties through
  // the CSSOM, and the element's running CSS animations and transitions.
  hasAttribute(name: string): boolean;
  readonly isConnected: boolean;
  // M6 (the SvelteKit router): attribute values and the tag name.
  getAttribute(name: string): string | null;
  /** M6 (bits-ui's Command): checked against the framework's writes at run time. */
  setAttribute(name: string, value: string): void;
  /** M6 script DOM: checked against the framework's writes as `setAttribute` is. */
  removeAttribute(name: string): void;
  readonly localName: string;
  readonly style: ElementInlineStyle;
  getAnimations(): Animation[];
  // M6 (bits-ui's checkbox): the nearest ancestor with a tag name.
  closest(tagName: string): HTMLElement | null;
  // M6 (bits-ui's roving focus): the id attribute; descendants matching a
  // selector (a subset: tags, #id, .class, [attr], [attr=value], :not(),
  // descendant and child combinators), a static list.
  id: string;
  /** M6 overlays (bits-ui's typeahead): the text of its descendant text nodes. */
  textContent: string;
  querySelectorAll(selectors: string): HTMLElement[];
  querySelector(selectors: string): HTMLElement | null;
  /** M6 overlays: whether the node is this element or one of its descendants. */
  contains(other: HTMLElement | null): boolean;
  /** Dispatch a cancelable form submit event; no submitter argument is supported. */
  requestSubmit(): void;
  /**
   * M6 overlays (bits-ui's menu): dispatch an event created by script, of a
   * type that is not a native event's; whether it was not cancelled.
   */
  dispatchEvent(event: Event): boolean;
  // M6 overlays (floating-ui's autoUpdate): listeners added by script;
  // pointer movement too (bits-ui's submenu intent).
  addEventListener<K extends ElementScriptEvent>(
    type: K,
    listener: (event: RunicEventMap[K]) => void,
  ): void;
  removeEventListener<K extends ElementScriptEvent>(
    type: K,
    listener: (event: RunicEventMap[K]) => void,
  ): void;
}
/** M6 (bits-ui's isHTMLElement): `x instanceof HTMLElement` of element values. */
declare var HTMLElement: { prototype: HTMLElement };
/** An element's inline style: CSS properties by their camelCase names. */
interface ElementInlineStyle {
  [property: string]: string;
}
/** A running CSS animation or transition (`element.getAnimations()`, M6). */
interface Animation {
  readonly __runicAnimation: true;
  readonly pending: boolean;
  readonly playState: 'idle' | 'running' | 'paused' | 'finished';
  readonly finished: Promise<Animation>;
}
/** A MutationObserver watching attributes (its callback receives no records here). */
interface MutationObserver {
  readonly __runicMutationObserver: true;
  observe(target: HTMLElement, options: { attributes?: boolean; attributeFilter?: string[] }): void;
  disconnect(): void;
}
declare var MutationObserver: { new (callback: () => void): MutationObserver };
/** A ResizeObserver (M6): its callback receives entries after layout, before paint. */
interface ResizeObserver {
  /** The callback type (a record of the IR holds the callback). */
  readonly __runicResizeObserver: (
    entries: ResizeObserverEntry[],
    observer: ResizeObserver,
  ) => void;
  observe(
    target: HTMLElement,
    options?: { box?: 'content-box' | 'border-box' | 'device-pixel-content-box' },
  ): void;
  unobserve(target: HTMLElement): void;
  disconnect(): void;
}
declare var ResizeObserver: {
  new (
    callback: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void,
  ): ResizeObserver;
};
/**
 * An IntersectionObserver (M6 overlays): the document's viewport is its root
 * (`root` is the document or absent); its callback receives the entries in
 * a task after a frame's layout.
 */
interface IntersectionObserver {
  /** The callback type (a record of the IR holds the callback). */
  readonly __runicIntersectionObserver: (
    entries: IntersectionObserverEntry[],
    observer: IntersectionObserver,
  ) => void;
  observe(target: HTMLElement): void;
  unobserve(target: HTMLElement): void;
  disconnect(): void;
}
interface IntersectionObserverInit {
  root?: HostDocument | null;
  rootMargin?: string;
  threshold?: number | number[];
}
declare var IntersectionObserver: {
  new (
    callback: (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void,
    options?: IntersectionObserverInit,
  ): IntersectionObserver;
};
interface IntersectionObserverEntry {
  readonly boundingClientRect: DOMRect;
  readonly intersectionRatio: number;
  readonly intersectionRect: DOMRect;
  readonly isIntersecting: boolean;
  readonly rootBounds: DOMRect | null;
  readonly target: HTMLElement;
  readonly time: number;
}
interface ResizeObserverSize {
  readonly inlineSize: number;
  readonly blockSize: number;
}
interface ResizeObserverEntry {
  readonly target: HTMLElement;
  readonly contentRect: DOMRect;
  readonly borderBoxSize: ReadonlyArray<ResizeObserverSize>;
  readonly contentBoxSize: ReadonlyArray<ResizeObserverSize>;
  readonly devicePixelContentBoxSize: ReadonlyArray<ResizeObserverSize>;
}
interface DOMRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}
type ScrollBehavior = 'auto' | 'instant' | 'smooth';
type ScrollLogicalPosition = 'start' | 'center' | 'end' | 'nearest';
interface ScrollToOptions {
  left?: number;
  top?: number;
  behavior?: ScrollBehavior;
}
interface ScrollIntoViewOptions {
  block?: ScrollLogicalPosition;
  inline?: ScrollLogicalPosition;
  behavior?: ScrollBehavior;
}
interface HTMLInputElement extends HTMLElement {}
/** M6 overlays (bits-ui's isSelectableInput): `x instanceof HTMLInputElement` of element values. */
declare var HTMLInputElement: { prototype: HTMLInputElement };
interface HTMLButtonElement extends HTMLElement {}
interface HTMLDivElement extends HTMLElement {}
interface HTMLSpanElement extends HTMLElement {}
interface HTMLParagraphElement extends HTMLElement {}
interface HTMLLIElement extends HTMLElement {}
interface HTMLUListElement extends HTMLElement {}
interface HTMLHeadingElement extends HTMLElement {}
interface HTMLFieldSetElement extends HTMLElement {}
interface HTMLLegendElement extends HTMLElement {}
interface Element extends HTMLElement {}
/** M6 (bits-ui's floating layer): `x instanceof Element` of element values. */
declare var Element: { prototype: Element };
/**
 * M6 (bits-ui's tooltip provider): `target instanceof Document` of an event
 * target, the document for a window `scroll` listener; `instanceof Node`.
 */
declare var Document: { prototype: HostDocument };
/** The document's type where declaration files name it (svelte-toolbelt's `getDocument(…): Document`). */
type Document = HostDocument;
declare var Node: { prototype: Element };
/**
 * M6 script DOM (docs/design/M6-SCRIPT-DOM.md): nodes are handles of one
 * IR type; slice 1 types them as elements (text, comment and fragment
 * interfaces follow with their members).
 */
interface Node {
  readonly __runicElement: true;
  /** 1 element, 3 text, 8 comment, 9 document, 11 fragment. */
  readonly nodeType: number;
  readonly nodeName: string;
  /** A text or comment node's data; null for others (setting it on them does nothing). */
  nodeValue: string | null;
  textContent: string;
  readonly isConnected: boolean;
  /**
   * Node-level traversal (rule O5, docs/design/M6-SCRIPT-DOM.md): exact in
   * child lists script owns and at the body before the container; elsewhere
   * reported unsupported.
   */
  readonly parentNode: Node | null;
  readonly parentElement: HTMLElement | null;
  readonly firstChild: ChildNode | null;
  readonly lastChild: ChildNode | null;
  readonly nextSibling: ChildNode | null;
  readonly previousSibling: ChildNode | null;
  /** Read where used: `.length`, `[i]`, `Array.from(…)`. */
  readonly childNodes: NodeListOf<ChildNode>;
  appendChild(child: Node): Node;
  insertBefore(node: Node, child: Node | null): Node;
  removeChild(child: Node): Node;
  replaceChild(node: Node, child: Node): Node;
  cloneNode(deep?: boolean): Node;
  contains(other: Node | null): boolean;
  // ChildNode
  remove(): void;
  before(...nodes: (Node | string)[]): void;
  after(...nodes: (Node | string)[]): void;
  replaceWith(...nodes: (Node | string)[]): void;
}
type ChildNode = Node;
/** Text and comment nodes (M6 script DOM, slice 2). */
interface CharacterData extends Node {
  data: string;
}
interface Text extends CharacterData {}
interface Comment extends CharacterData {}
declare var Text: { prototype: Text };
declare var Comment: { prototype: Comment };
declare var CharacterData: { prototype: CharacterData };
/** A document fragment: inserting it moves its children (M6 script DOM). */
interface DocumentFragment extends Node {
  append(...nodes: (Node | string)[]): void;
  prepend(...nodes: (Node | string)[]): void;
  replaceChildren(...nodes: Node[]): void;
  readonly children: HTMLCollection;
  readonly firstElementChild: HTMLElement | null;
  readonly lastElementChild: HTMLElement | null;
  readonly childElementCount: number;
  querySelector(selectors: string): HTMLElement | null;
  querySelectorAll(selectors: string): HTMLElement[];
}
declare var DocumentFragment: { prototype: DocumentFragment };
/** A live list, read where it is used (`.length`, `[i]`, `Array.from`). */
interface NodeListOf<T> {
  readonly length: number;
  readonly [index: number]: T;
}
interface HTMLCollection {
  readonly length: number;
  readonly [index: number]: HTMLElement;
}
/** `classList` (the DOM standard's DOMTokenList steps). */
interface DOMTokenList {
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  toggle(token: string, force?: boolean): boolean;
  contains(token: string): boolean;
  replace(token: string, newToken: string): boolean;
}
/** `dataset`: `data-*` attributes by camelCase names. */
interface DOMStringMap {
  [name: string]: string | undefined;
}
/**
 * An event target where declaration files name one (bits-ui's
 * `CustomEventDispatcher.listen(element: EventTarget, …)`): an element value
 * (which may stand for the document or the window as an event's target).
 */
interface EventTarget {
  readonly __runicElement: true;
}
/** M6 overlays: an event created by script (`detail` is not covered). */
interface CustomEvent<T = unknown> extends Event {}
interface CustomEventInit<T = unknown> {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
  detail?: T;
}
interface AddEventListenerOptions {
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
}
/**
 * An attribute bag (docs/IR.md `attrs`): attribute values, listeners and
 * attachments by name. Object literals that build one (computed keys in
 * package modules, frontend/package-modules.ts) are typed with it.
 */
interface RunicAttrs {
  readonly __runicAttrs: true;
  readonly [name: string]: unknown;
}

// Event objects: opaque values whose members lower to `event.*` built-ins.
interface Event {
  readonly __runicEvent: true;
  readonly type: string;
  readonly target: HTMLElement;
  readonly currentTarget: HTMLElement | null;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}
interface UIEvent extends Event {}
/** Native form submission: only the common Event operations are covered. */
interface SubmitEvent extends Event {}
/** M6 overlays (bits-ui's escape layer): a copy of a keyboard event, never dispatched. */
declare var KeyboardEvent: {
  new (type: string, init: KeyboardEvent): KeyboardEvent;
  prototype: KeyboardEvent;
};
/**
 * M6 overlays (bits-ui's dismissible layer): `instanceof` of events.
 * `new PointerEvent(…)` throws RunicUnsupportedError where it runs.
 */
declare var PointerEvent: {
  new (type: string, init: PointerEvent): PointerEvent;
  prototype: PointerEvent;
};
declare var MouseEvent: { prototype: MouseEvent };
declare var FocusEvent: { prototype: FocusEvent };
declare var WheelEvent: { prototype: WheelEvent };
declare var UIEvent: { prototype: UIEvent };
declare var Event: { prototype: Event };
declare var SubmitEvent: { prototype: SubmitEvent };
/** `x instanceof SVGElement` of element values (M6 overlays). */
interface SVGElement extends HTMLElement {}
declare var SVGElement: { prototype: SVGElement };
/**
 * M6 overlays (bits-ui's focus scope and menu): an event created by script,
 * dispatched by `element.dispatchEvent` where its type is not a native one.
 */
declare var CustomEvent: {
  new <T = unknown>(type: string, init?: CustomEventInit<T>): CustomEvent<T>;
};
interface InputEvent extends UIEvent {}
interface KeyboardEvent extends UIEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  /** Only compared with 229 (the IME's "Process" key, M6). */
  readonly keyCode: number;
}
interface MouseEvent extends UIEvent {
  /** The other element of a boundary transition, or null when there is none. */
  readonly relatedTarget: HTMLElement | null;
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;
  readonly buttons: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}
interface PointerEvent extends MouseEvent {
  /** 1, the mouse's (the runtime's only pointer). */
  readonly pointerId: number;
}
interface FocusEvent extends UIEvent {
  readonly relatedTarget: HTMLElement | null;
}
interface WheelEvent extends MouseEvent {
  readonly deltaX: number;
  readonly deltaY: number;
}

// The window and the document as event targets (listeners lower to
// `window.listen` / `document.unlisten` built-ins).
interface HostEventMap {
  click: MouseEvent;
  submit: SubmitEvent;
  dblclick: MouseEvent;
  contextmenu: MouseEvent;
  mousedown: MouseEvent;
  mouseup: MouseEvent;
  mousemove: MouseEvent;
  mouseover: MouseEvent;
  mouseout: MouseEvent;
  pointerdown: PointerEvent;
  pointerup: PointerEvent;
  pointermove: PointerEvent;
  pointerover: PointerEvent;
  pointerout: PointerEvent;
  keydown: KeyboardEvent;
  keyup: KeyboardEvent;
  input: Event;
  change: Event;
  wheel: WheelEvent;
  scroll: Event;
  resize: Event;
}
/** The events of listeners an element takes from script. */
type ElementScriptEvent = 'scroll' | 'pointermove' | 'pointerenter' | 'pointerleave';
// Every event kind (listeners passed through rest props).
interface RunicEventMap extends HostEventMap {
  pointerenter: PointerEvent;
  pointerleave: PointerEvent;
  mouseenter: MouseEvent;
  mouseleave: MouseEvent;
  focus: FocusEvent;
  blur: FocusEvent;
}
interface HostEventTarget {
  addEventListener<K extends keyof HostEventMap>(
    type: K,
    listener: (event: HostEventMap[K]) => void,
    options?: boolean | { capture?: boolean; once?: boolean },
  ): void;
  removeEventListener<K extends keyof HostEventMap>(
    type: K,
    listener: (event: HostEventMap[K]) => void,
    options?: boolean | { capture?: boolean; once?: boolean },
  ): void;
}
// The window also receives the session history events.
interface WindowEventMap extends HostEventMap {
  popstate: Event;
  hashchange: Event;
}
interface WindowEventTarget {
  addEventListener<K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: boolean | { capture?: boolean; once?: boolean },
  ): void;
  removeEventListener<K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: boolean | { capture?: boolean; once?: boolean },
  ): void;
}
/** `getComputedStyle(element)` (M6, bits-ui's direction): property reads only. */
interface ComputedStyle {
  readonly __runicComputedStyle: true;
  getPropertyValue(property: string): string;
  /** M6 overlays (bits-ui's floating layer). */
  readonly zIndex: string;
  /** M6 overlays (bits-ui's scroll lock). */
  readonly scrollbarGutter: string;
  readonly paddingTop: string;
  readonly paddingRight: string;
  readonly paddingBottom: string;
  readonly paddingLeft: string;
  readonly marginTop: string;
  readonly marginRight: string;
  readonly marginBottom: string;
  readonly marginLeft: string;
}
interface HostWindow extends WindowEventTarget {
  matchMedia(query: string): MediaQueryList;
  getComputedStyle(element: HTMLElement | HostRootElement): ComputedStyle;
  /** M6 overlays (bits-ui's platform checks). */
  readonly navigator: typeof navigator;
  /** The CSS namespace (bits-ui's PinInput `window?.CSS?.supports`). */
  readonly CSS: typeof CSS;
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
  requestAnimationFrame: typeof requestAnimationFrame;
  cancelAnimationFrame: typeof cancelAnimationFrame;
  queueMicrotask: typeof queueMicrotask;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  scrollTo(options?: ScrollToOptions): void;
  scrollTo(x: number, y: number): void;
  scrollBy(options?: ScrollToOptions): void;
  scrollBy(x: number, y: number): void;
}
declare const window: HostWindow;
/** The window's type where declaration files name it (bits-ui's `getWindow: () => Window & typeof globalThis`). */
type Window = HostWindow;
/**
 * M6 overlays (floating-ui's autoUpdate): the visual viewport. Without
 * pinch zoom it resizes with the window, after it, and never scrolls.
 */
interface HostVisualViewport {
  addEventListener(type: 'resize' | 'scroll', listener: (event: Event) => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: (event: Event) => void): void;
}
declare const visualViewport: HostVisualViewport;
declare const document: HostDocument;

// Host services (docs/design/M5-PLATFORM.md); members lower to `console.*`,
// `clipboard.*`, `history.*`, `location.*` and `random.*` built-ins.
declare const console: {
  log(...data: any[]): void;
  info(...data: any[]): void;
  warn(...data: any[]): void;
  error(...data: any[]): void;
  debug(...data: any[]): void;
};
declare const navigator: {
  /** The runtime's user agent (M6: a desktop platform's, not a browser's). */
  readonly userAgent: string;
  /** No touch points: the runtime takes no touch input (M6). */
  readonly maxTouchPoints: number;
  readonly clipboard: {
    writeText(data: string): Promise<void>;
    readText(): Promise<string>;
  };
};
declare const history: {
  readonly length: number;
  /** The current entry's state: a string (M6) or null. */
  readonly state: string | null;
  pushState(data: string | null, unused: string, url?: string | null): void;
  replaceState(data: string | null, unused: string, url?: string | null): void;
  back(): void;
  forward(): void;
  go(delta: number): void;
};
declare const location: {
  readonly pathname: string;
  readonly search: string;
  hash: string;
};
declare const crypto: { randomUUID(): string };

// The document element (theming): attributes, class list, inline style.
interface HostDocument extends HostEventTarget {
  readonly documentElement: HostRootElement;
  /** The document title (M6). */
  title: string;
  getElementById(id: string): HTMLElement | null;
  /** M6 overlays: the body (where imperative mounts append). */
  readonly body: HTMLElement;
  /** M6 overlays: a selector of the subset; the first match in tree order. */
  querySelector(selectors: string): HTMLElement | null;
  /**
   * M6 script DOM: an element script owns, of a literal tag of the static
   * elements (docs/design/M6-SCRIPT-DOM.md).
   */
  createElement(tagName: string): HTMLElement;
  /** M6 script DOM, slice 2: nodes script owns. */
  createTextNode(data: string): Text;
  createComment(data: string): Comment;
  createDocumentFragment(): DocumentFragment;
  /** M6 overlays: the focused element (the body when none is). */
  readonly activeElement: HTMLElement | null;
  /** M6 overlays: whether the element is in the document. */
  contains(other: HTMLElement | null): boolean;
  /** M6 overlays: the element at a viewport point (bits-ui's submenu intent). */
  elementFromPoint(x: number, y: number): HTMLElement | null;
}

/**
 * Runic intrinsics for framework support code the compiler generates (the
 * SvelteKit router, frontend/kit): not part of the web platform.
 */
declare const __runic: {
  /** The parent element inside the app's DOM (null for its top-level elements). */
  parent(element: HTMLElement): HTMLElement | null;
  /** The focused element (null when the body has focus). */
  focused(): HTMLElement | null;
  /** Focus moves to the body; Tab then starts at the start of the document. */
  resetFocus(): void;
  /** The sequential focus navigation starting point moves to the element (a fragment navigation to it). */
  focusStart(element: HTMLElement): void;
  /** `new URL(input, base)` without the origin (undefined for other origins and absolute URLs). */
  resolve(input: string, base: string): string | undefined;
  /** The name-value pairs of a query, as `URLSearchParams` parses them. */
  queryPairs(search: string): string[][];
  /** A promise fulfilled in a host task after the running one (an I/O round trip). */
  hostReply(): Promise<void>;
  /** A value as Svelte renders it in text (nullish: empty). */
  text(value: unknown): string;
  /** Report a runtime shape the native model does not cover (probes stop). */
  unsupported(what: string): void;
  /**
   * `new Intl.DateTimeFormat().resolvedOptions().timeZone` (`intl.time-zone`):
   * the default time zone, when it is verified against Chromium.
   */
  timeZone(): string;
  /**
   * `new Intl.DateTimeFormat(locale, options).format(time)` with options
   * written as `intl.*` option strings (`m=f;month=long;…`) built at run
   * time (`intl.format-date-runtime`): unverified options are unsupported.
   */
  formatDate(time: number, options: string, locale: string): string;
};
interface HostRootElement {
  readonly dataset: { [name: string]: string | undefined };
  readonly classList: {
    toggle(token: string, force?: boolean): boolean;
    add(token: string): void;
    remove(token: string): void;
    contains(token: string): boolean;
  };
  readonly style: {
    setProperty(name: string, value: string | null, priority?: string): void;
    removeProperty(name: string): string;
    getPropertyValue(name: string): string;
    colorScheme: string;
  };
  lang: string;
  dir: string;
  /** M6 overlays: the viewport's size without scrollbars. */
  readonly clientWidth: number;
  readonly clientHeight: number;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}
// Media query lists: matches (evaluated when read) and change listeners.
interface MediaQueryList {
  readonly __runicMediaQuery: true;
  readonly matches: boolean;
  addEventListener(type: 'change', listener: (event: MediaQueryListEvent) => void): void;
  removeEventListener(type: 'change', listener: (event: MediaQueryListEvent) => void): void;
}
interface MediaQueryListEvent {
  readonly __runicEvent: true;
  readonly type: string;
  readonly matches: boolean;
}
declare function matchMedia(query: string): MediaQueryList;

declare function setTimeout(handler: () => void, timeout?: number): number;
declare function setInterval(handler: () => void, timeout?: number): number;
/**
 * The timer handle of @types/node, which packages built with Node's types
 * write in their declaration files for what `setTimeout` and `setInterval`
 * return (bits-ui's announcer, svelte-toolbelt's `afterSleep`). A program
 * runs on the browser's timers, whose handles are numbers (HTML: a positive
 * integer); Node's handle object never exists in it.
 */
declare namespace NodeJS {
  type Timeout = number;
}
// The autofill tokens of lib.dom (TypeScript 5.9.3, the same declarations): svelte/elements
// types the `autocomplete` attribute by them (`FullAutoFill`).
type AutoFill =
  | AutoFillBase
  | `${OptionalPrefixToken<AutoFillSection>}${OptionalPrefixToken<AutoFillAddressKind>}${AutoFillField}${OptionalPostfixToken<AutoFillCredentialField>}`;
type AutoFillField =
  AutoFillNormalField | `${OptionalPrefixToken<AutoFillContactKind>}${AutoFillContactField}`;
type AutoFillSection = `section-${string}`;
type OptionalPostfixToken<T extends string> = ` ${T}` | '';
type OptionalPrefixToken<T extends string> = `${T} ` | '';
type AutoFillAddressKind = 'billing' | 'shipping';
type AutoFillBase = '' | 'off' | 'on';
type AutoFillContactField =
  | 'email'
  | 'tel'
  | 'tel-area-code'
  | 'tel-country-code'
  | 'tel-extension'
  | 'tel-local'
  | 'tel-local-prefix'
  | 'tel-local-suffix'
  | 'tel-national';
type AutoFillContactKind = 'home' | 'mobile' | 'work';
type AutoFillCredentialField = 'webauthn';
type AutoFillNormalField =
  | 'additional-name'
  | 'address-level1'
  | 'address-level2'
  | 'address-level3'
  | 'address-level4'
  | 'address-line1'
  | 'address-line2'
  | 'address-line3'
  | 'bday-day'
  | 'bday-month'
  | 'bday-year'
  | 'cc-csc'
  | 'cc-exp'
  | 'cc-exp-month'
  | 'cc-exp-year'
  | 'cc-family-name'
  | 'cc-given-name'
  | 'cc-name'
  | 'cc-number'
  | 'cc-type'
  | 'country'
  | 'country-name'
  | 'current-password'
  | 'family-name'
  | 'given-name'
  | 'honorific-prefix'
  | 'honorific-suffix'
  | 'name'
  | 'new-password'
  | 'one-time-code'
  | 'organization'
  | 'postal-code'
  | 'street-address'
  | 'transaction-amount'
  | 'transaction-currency'
  | 'username';
declare function clearTimeout(id: number | undefined): void;
declare function clearInterval(id: number | undefined): void;
declare function requestAnimationFrame(callback: (time: number) => void): number;
declare function cancelAnimationFrame(id: number): void;
declare const performance: { now(): number };
declare function queueMicrotask(callback: () => void): void;
declare const localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};
/**
 * M6 images: image objects (`new Image()`, the `image` IR type). Setting
 * `src` requests a pinned image (every value must be known at build time)
 * and fires `load` or `error`; `crossOrigin` and `referrerPolicy` are
 * reflected only. The members below the listeners are declared so that
 * reading them is a located E_MEMBER, not a type error (docs/GAPS.md).
 */
interface HTMLImageElement {
  readonly __runicImage: true;
  src: string;
  crossOrigin: string | null;
  referrerPolicy: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: 'load' | 'error', listener: () => void): void;
  removeEventListener(type: 'load' | 'error', listener: () => void): void;
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  decode(): Promise<void>;
}
declare var Image: { new (): HTMLImageElement };
/** M6: the referrer policies (svelte/elements' image attributes name it). */
type ReferrerPolicy =
  | ''
  | 'no-referrer'
  | 'no-referrer-when-downgrade'
  | 'origin'
  | 'origin-when-cross-origin'
  | 'same-origin'
  | 'strict-origin'
  | 'strict-origin-when-cross-origin'
  | 'unsafe-url';
/** `getComputedStyle(element)` as a global (M6 overlays: bits-ui's scroll lock). */
declare function getComputedStyle(element: HTMLElement | HostRootElement): ComputedStyle;

/**
 * M6 (bits-ui's Command): CSSOM's `CSS.escape`. `CSS.supports(property,
 * value)` (bits-ui's PinInput) of constant arguments, answered at build time
 * as Chromium does (frontend/css-supports.ts).
 */
declare var CSS: {
  escape(ident: string): string;
  supports(property: string, value: string): boolean;
};
