// An element or an object measured like one (M6 unions): floating-ui's
// `Measurable`, which bits-ui's floating anchor holds as `HTMLElement |
// Measurable` (a context menu's virtual element at the pointer).

export interface Measurable {
  getBoundingClientRect(): DOMRect;
}

function rectAt(x: number, y: number): DOMRect {
  return { x, y, width: 0, height: 0, top: y, right: x, bottom: y, left: x };
}

export class Anchor {
  anchor = $state<HTMLElement | Measurable | null>(null);
  previous = $state<HTMLElement | Measurable | null>(null);

  useElement(el: HTMLElement) {
    this.previous = this.anchor;
    this.anchor = el;
  }

  usePoint(x: number, y: number) {
    this.previous = this.anchor;
    this.anchor = { getBoundingClientRect: () => rectAt(x, y) };
  }

  /** The anchor's rectangle, from the member it holds. */
  describe(): string {
    const a = this.anchor;
    if (a === null) return 'none';
    const r = a.getBoundingClientRect();
    const kind = a instanceof HTMLElement ? 'element' : 'virtual';
    const same = a === this.previous ? ' (same)' : '';
    return `${kind} ${typeof a} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}${same}`;
  }
}
