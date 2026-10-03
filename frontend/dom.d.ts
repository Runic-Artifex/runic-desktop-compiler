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

declare function setTimeout(handler: () => void, timeout?: number): number;
declare function setInterval(handler: () => void, timeout?: number): number;
declare function clearTimeout(id: number | undefined): void;
declare function clearInterval(id: number | undefined): void;
declare function requestAnimationFrame(callback: (time: number) => void): number;
declare function cancelAnimationFrame(id: number): void;
declare const performance: { now(): number };
declare function queueMicrotask(callback: () => void): void;
