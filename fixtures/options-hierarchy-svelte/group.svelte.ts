// A selection group in the shape of bits-ui's ToggleGroup state: a class
// hierarchy whose subclasses declare their options field again with a
// narrower type (one record for all the options types), constructed from
// the rest of an options object after its discriminant, and boxes of
// different value types behind one field.
import type { ReadableBox, WritableBox } from 'svelte-toolbelt';

interface BaseOpts {
  name: ReadableBox<string>;
  loop: ReadableBox<boolean>;
}

interface SingleOpts extends BaseOpts {
  value: WritableBox<string>;
}

interface MultipleOpts extends BaseOpts {
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

export function createGroup(opts: GroupOpts): SingleGroup | MultipleGroup {
  const { type, ...rest } = opts;
  return type === 'single'
    ? new SingleGroup(rest as SingleOpts)
    : new MultipleGroup(rest as MultipleOpts);
}
