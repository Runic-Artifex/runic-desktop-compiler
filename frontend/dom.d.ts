// Host APIs of the browser that the compiler lowers (instead of lib.dom, which
// is not part of the program): the DOM element interfaces components may hold
// as refs (bind:this, useRef, template refs; opaque handles in the IR whose
// methods below lower to `element.*` built-ins), timers and clocks.
interface HTMLElement {
  readonly __runicElement: true;
  focus(): void;
  blur(): void;
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
declare const window: WindowEventTarget;
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
  pushState(data: null, unused: string, url?: string | null): void;
  replaceState(data: null, unused: string, url?: string | null): void;
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
}
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
declare function matchMedia(query: string): { readonly matches: boolean };

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
