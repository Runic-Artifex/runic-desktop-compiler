// State classes in the style of bits-ui's Slider and DropdownMenu.RadioGroup
// (svelte-toolbelt boxes): every assignment to a box's `current` is of a
// present value, so the components' box setters never write undefined.
import type { WritableBox } from 'svelte-toolbelt';

export class RangeState {
  readonly opts: { value: WritableBox<number[] | undefined>; max: number };
  constructor(opts: { value: WritableBox<number[] | undefined>; max: number }) {
    this.opts = opts;
  }

  /** Moves thumb `index` by `delta`, within 0 and the maximum. */
  step(index: number, delta: number) {
    const current = this.opts.value.current ?? [];
    this.opts.value.current = current.map((v, i) =>
      i === index ? Math.min(this.opts.max, Math.max(0, v + delta)) : v,
    );
  }

  thumbs = $derived.by(() => this.opts.value.current ?? []);
}

export class ChoiceState {
  readonly opts: { value: WritableBox<string> };
  changes = $state(0);
  constructor(opts: { value: WritableBox<string> }) {
    this.opts = opts;
  }

  select(option: string) {
    this.opts.value.current = option;
    this.changes++;
  }
}
