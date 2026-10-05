// A selection group in the shape of bits-ui's ToggleGroup state: a class
// hierarchy whose subclasses declare their options field again with a
// narrower type (one record for all the options types), constructed from
// the rest of an options object after its discriminant, and boxes of
// different value types behind one field. ListGroup keeps the options its
// base sets (bits-ui's AccordionMultiState); the base sets a field from a
// constructor that reads a derived field (bits-ui's PresenceManager) and
// watches with a field holding an arrow function over a tuple (bits-ui's
// `watch([…], this.#updateDimensions)`).
import { watch } from 'runed';
import type { ReadableBox, WritableBox } from 'svelte-toolbelt';

/** Reads its getter while it is constructed. */
class Summary {
  first: string;
  #get: () => string;

  constructor(get: () => string) {
    this.#get = get;
    this.first = get();
  }

  get now(): string {
    return this.#get();
  }
}

interface BaseOpts {
  name: ReadableBox<string>;
  loop: ReadableBox<boolean>;
}

interface SingleOpts extends BaseOpts {
  value: WritableBox<string>;
}

export interface MultipleOpts extends BaseOpts {
  value: WritableBox<string[]>;
}

export interface GroupOpts extends BaseOpts {
  type: 'single' | 'multiple';
  value: WritableBox<string> | WritableBox<string[]>;
}

class GroupBase {
  opts: BaseOpts;
  changes = $state(0);

  constructor(opts: BaseOpts) {
    this.opts = opts;
  }

  label = $derived.by(() => `${this.opts.name.current} (${this.changes})`);
}

export class SingleGroup extends GroupBase {
  opts: SingleOpts;
  isMulti = false;
  anyPressed = $derived.by(() => this.opts.value.current !== '');

  constructor(opts: SingleOpts) {
    super(opts);
    this.opts = opts;
  }

  includes(item: string): boolean {
    return this.opts.value.current === item;
  }

  toggle(item: string) {
    this.changes++;
    this.opts.value.current = this.includes(item) ? '' : item;
  }
}

export class MultipleGroup extends GroupBase {
  opts: MultipleOpts;
  isMulti = true;
  anyPressed = $derived.by(() => this.opts.value.current.length > 0);

  constructor(opts: MultipleOpts) {
    super(opts);
    this.opts = opts;
  }

  includes(item: string): boolean {
    return this.opts.value.current.includes(item);
  }

  toggle(item: string) {
    this.changes++;
    if (this.includes(item))
      this.opts.value.current = this.opts.value.current.filter(v => v !== item);
    else this.opts.value.current = [...this.opts.value.current, item];
  }
}

export class ListGroup extends GroupBase {
  #value: WritableBox<string[]>;
  anyPressed = $derived.by(() => this.#value.current.length > 0);
  history = $state<string[]>([]);
  summary: Summary;

  constructor(opts: MultipleOpts) {
    super(opts);
    this.#value = opts.value;
    this.summary = new Summary(() => this.label);
    watch([() => this.opts.name.current, () => this.changes], this.#record);
  }

  #record = ([name, changes]: [string, number]) => {
    this.history = [...this.history, `${name}:${changes}`];
  };

  includes(item: string): boolean {
    return this.#value.current.includes(item);
  }

  toggle(item: string) {
    this.changes++;
    this.#value.current = this.includes(item)
      ? this.#value.current.filter(v => v !== item)
      : [...this.#value.current, item];
  }
}

export function createList(opts: MultipleOpts): ListGroup {
  return new ListGroup(opts);
}

export function createGroup(opts: GroupOpts): SingleGroup | MultipleGroup {
  const { type, ...rest } = opts;
  return type === 'single'
    ? new SingleGroup(rest as SingleOpts)
    : new MultipleGroup(rest as MultipleOpts);
}
