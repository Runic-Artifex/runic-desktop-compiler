// A toggle group's selection as immutable classes (framework state holds
// the current instance): an abstract base with the shared behaviour, single
// and multiple subclasses chosen by a `type` prop through a static factory.

export interface Item {
  value: string;
  label: string;
}

export type AnySelection = SingleSelection | MultipleSelection;

export abstract class Selection {
  constructor(
    readonly name: string,
    readonly items: Item[],
    readonly presses: number,
  ) {}

  static create(type: 'single' | 'multiple', name: string, items: Item[]): AnySelection {
    return type === 'single'
      ? new SingleSelection(name, items, 0, '')
      : new MultipleSelection(name, items, 0, [], 0);
  }

  abstract isPressed(value: string): boolean;
  protected abstract select(value: string): AnySelection;
  abstract cleared(): AnySelection;

  get pressedCount(): number {
    return this.items.filter(i => this.isPressed(i.value)).length;
  }

  get summary(): string {
    const on = this.items.filter(i => this.isPressed(i.value)).map(i => i.label);
    return `${this.name}: ${on.length ? on.join(', ') : 'none'}`;
  }

  toggled(value: string): AnySelection {
    return this.select(value);
  }
}

export class SingleSelection extends Selection {
  readonly kind = 'single';

  constructor(
    name: string,
    items: Item[],
    presses: number,
    readonly value: string,
  ) {
    super(name, items, presses);
  }

  isPressed(value: string): boolean {
    return this.value === value;
  }

  protected select(value: string): SingleSelection {
    return new SingleSelection(
      this.name,
      this.items,
      this.presses + 1,
      this.value === value ? '' : value,
    );
  }

  cleared(): SingleSelection {
    return new SingleSelection(this.name, this.items, this.presses, '');
  }
}

export class MultipleSelection extends Selection {
  readonly kind = 'multiple';

  constructor(
    name: string,
    items: Item[],
    presses: number,
    readonly values: string[],
    readonly clears: number,
  ) {
    super(name, items, presses);
  }

  isPressed(value: string): boolean {
    return this.values.includes(value);
  }

  protected select(value: string): MultipleSelection {
    const values = this.isPressed(value)
      ? this.values.filter(v => v !== value)
      : [...this.values, value];
    return new MultipleSelection(this.name, this.items, this.presses + 1, values, this.clears);
  }

  cleared(): MultipleSelection {
    return new MultipleSelection(this.name, this.items, this.presses, [], this.clears + 1);
  }

  get summary(): string {
    return `${super.summary} (${this.values.length} of ${this.items.length}, cleared ${this.clears}×)`;
  }
}
