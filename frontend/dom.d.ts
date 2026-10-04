// Host APIs of the browser that the compiler lowers (instead of lib.dom, which
// is not part of the program): the DOM element interfaces components may hold
// as refs (bind:this, useRef, template refs; opaque handles in the IR whose
// methods below lower to `element.*` built-ins), timers and clocks.
interface HTMLElement {
  readonly __runicElement: true;
  focus(): void;
  blur(): void;
  // Layout reads and scrolling (CSSOM View), from the native layout.
  getBoundingClientRect(): DOMRect;
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
  readonly localName: string;
  readonly style: ElementInlineStyle;
  getAnimations(): Animation[];
}
/** An element's inline style: CSS properties by their camelCase names. */
interface ElementInlineStyle {
  [property: string]: string;
}
/** A running CSS animation or transition (`element.getAnimations()`). */
interface Animation {
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
interface HTMLButtonElement extends HTMLElement {}
interface HTMLDivElement extends HTMLElement {}
interface HTMLSpanElement extends HTMLElement {}
interface HTMLParagraphElement extends HTMLElement {}
interface HTMLLIElement extends HTMLElement {}
interface HTMLUListElement extends HTMLElement {}
interface HTMLHeadingElement extends HTMLElement {}
interface Element extends HTMLElement {}
interface EventTarget {}
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
interface InputEvent extends UIEvent {}
interface KeyboardEvent extends UIEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
}
interface MouseEvent extends UIEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;
  readonly buttons: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}
interface PointerEvent extends MouseEvent {}
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
  dblclick: MouseEvent;
  contextmenu: MouseEvent;
  mousedown: MouseEvent;
  mouseup: MouseEvent;
  mousemove: MouseEvent;
  pointerdown: PointerEvent;
  pointerup: PointerEvent;
  pointermove: PointerEvent;
  keydown: KeyboardEvent;
  keyup: KeyboardEvent;
  input: Event;
  change: Event;
  wheel: WheelEvent;
  scroll: Event;
  resize: Event;
}
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
  ): void;
  removeEventListener<K extends keyof HostEventMap>(
    type: K,
    listener: (event: HostEventMap[K]) => void,
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
  ): void;
  removeEventListener<K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void,
  ): void;
}
interface HostWindow extends WindowEventTarget {
  matchMedia(query: string): MediaQueryList;
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
