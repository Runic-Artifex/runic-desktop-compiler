// A lazily created static singleton holding a WeakMap (as bits-ui's
// FocusScopeManager does).
export class Registry {
  static instance: Registry | undefined;
  static get(): Registry {
    if (!this.instance) this.instance = new Registry();
    return this.instance;
  }
  #seen = new WeakMap<HTMLElement, number>();
  count(el: HTMLElement): number {
    const n = (this.#seen.get(el) ?? 0) + 1;
    this.#seen.set(el, n);
    return n;
  }
}
