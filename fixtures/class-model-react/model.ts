// A class-based model shared by the class-model fixtures (case `classes`).

/** A stepped counter with a private count, reporting changes to a callback. */
export class Tally {
  static LIMIT = 12;
  #count = 0;
  readonly step: number;
  history: number[] = [];
  onChange: (count: number, summary: string) => void;

  constructor(step: number, onChange: (count: number, summary: string) => void) {
    this.step = step;
    this.onChange = onChange;
    // A bound method can be passed around as a listener.
    this.increment = this.increment.bind(this);
  }

  static create(step: number, onChange: (count: number, summary: string) => void): Tally {
    return new Tally(step, onChange);
  }

  get count(): number {
    return this.#count;
  }

  set count(value: number) {
    this.#count = Math.min(Tally.LIMIT, Math.max(0, value));
    this.#notify();
  }

  get summary(): string {
    return `${this.#count} in steps of ${this.step}, ${this.history.length} increments`;
  }

  increment(): void {
    this.history.push(this.#count + this.step);
    this.count += this.step;
  }

  /** An arrow function field: `this` is the instance wherever it is called. */
  decrement = (): void => {
    this.count -= this.step;
  };

  /** A window keydown listener. */
  onKey = (e: KeyboardEvent): void => {
    if (e.key === '+') this.increment();
    else if (e.key === '-') this.decrement();
  };

  #notify(): void {
    this.onChange(this.#count, this.summary);
  }
}

/** An immutable stack: operations return new instances. */
export class Stack {
  readonly items: string[];

  constructor(items: string[]) {
    this.items = items;
  }

  static empty(): Stack {
    return new Stack([]);
  }

  push(item: string): Stack {
    return new Stack([...this.items, item]);
  }

  pop(): Stack {
    return new Stack(this.items.slice(0, -1));
  }

  get size(): number {
    return this.items.length;
  }

  get top(): string {
    return this.items.at(-1) ?? 'empty';
  }

  includes(item: string): boolean {
    return this.items.includes(item);
  }
}
