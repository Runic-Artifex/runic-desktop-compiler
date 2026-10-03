// The DOM element interfaces that components may hold as refs (bind:this,
// useRef, template refs). Elements are opaque handles in the IR: only the
// methods below are lowered (to `element.*` built-ins); everything else about
// an element is outside the value model.
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
