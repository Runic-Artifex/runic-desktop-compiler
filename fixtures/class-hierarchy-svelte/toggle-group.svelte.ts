// A toggle group's state in the shape bits-ui gives its component families
// (ToggleGroup, Accordion, Select): a base state class with the shared
// behaviour, single and multiple subclasses overriding what differs, chosen
// by a `type` prop through a static factory.

export interface Item {
  value: string;
  label: string;
}

export type ToggleGroupState = ToggleGroupSingleState | ToggleGroupMultipleState;

export class ToggleGroupBaseState {
  readonly name: string;
  readonly items: Item[];
  #presses = $state(0);
  /** Read through a method each subclass overrides. */
  pressedCount = $derived(this.items.filter(i => this.isPressed(i.value)).length);

  constructor(name: string, items: Item[]) {
    this.name = name;
    this.items = items;
  }

  static create(type: 'single' | 'multiple', name: string, items: Item[]): ToggleGroupState {
    return type === 'single'
      ? new ToggleGroupSingleState(name, items)
      : new ToggleGroupMultipleState(name, items);
  }

  // Overridden by the subclasses (bits-ui's base classes leave these to them).
  isPressed(_value: string): boolean {
    return false;
  }

  protected select(_value: string): void {}

  clear(): void {}

  get presses(): number {
    return this.#presses;
  }

  get summary(): string {
    const on = this.items.filter(i => this.isPressed(i.value)).map(i => i.label);
    return `${this.name}: ${on.length ? on.join(', ') : 'none'}`;
  }

  toggle(value: string): void {
    this.#presses += 1;
    this.select(value);
  }
}

export class ToggleGroupSingleState extends ToggleGroupBaseState {
  readonly kind = 'single';
  value = $state('');

  constructor(name: string, items: Item[]) {
    super(name, items);
  }

  isPressed(value: string): boolean {
    return this.value === value;
  }

  protected select(value: string): void {
    this.value = this.value === value ? '' : value;
  }

  clear(): void {
    this.value = '';
  }
}

export class ToggleGroupMultipleState extends ToggleGroupBaseState {
  readonly kind = 'multiple';
  values = $state<string[]>([]);
  #cleared = $state(0);

  isPressed(value: string): boolean {
    return this.values.includes(value);
  }

  protected select(value: string): void {
    this.values = this.isPressed(value)
      ? this.values.filter(v => v !== value)
      : [...this.values, value];
  }

  clear(): void {
    this.values = [];
    this.#cleared += 1;
  }

  get summary(): string {
    return `${super.summary} (${this.values.length} of ${this.items.length}, cleared ${this.#cleared}×)`;
  }
}
