// A roving focus list in the style of bits-ui's RovingFocusGroup and Tabs
// (docs/design/M6-LIBRARIES.md), written against the same features without
// layout reads, so that the reference interpreter runs it too: options as a
// union of object types, svelte-toolbelt's box(), a SvelteMap read by
// derived values, querySelectorAll over the list, a dictionary object from
// keys to indices, a record read with a computed key, Object.is,
// $state.snapshot and methods bound late in the constructor.
import { box, type ReadableBox, type WritableBox } from 'svelte-toolbelt';
import { SvelteMap } from 'svelte/reactivity';

type Options = ({ attr: string; selector?: undefined } | { selector: string; attr?: undefined }) & {
  root: ReadableBox<HTMLElement | null>;
  loop: ReadableBox<boolean>;
  orientation: ReadableBox<'horizontal' | 'vertical'>;
};

export class Roving {
  readonly opts: Options;
  current: WritableBox<string | null> = box(null);
  labels = new SvelteMap<string, string>();
  moves = $state(0);
  history = $state<string[]>([]);
  // The label of the current item, read from the map (a derived value).
  label = $derived.by(() => {
    const id = this.current.current;
    return id === null ? 'none' : (this.labels.get(id) ?? 'unknown');
  });
  size = $derived.by(() => this.labels.size);

  constructor(opts: Options) {
    this.opts = opts;
    this.moves = 0;
    this.onkeydown = this.onkeydown.bind(this);
  }

  register(id: string, label: string) {
    this.labels.set(id, label);
    return () => {
      this.labels.delete(id);
    };
  }

  items(): HTMLElement[] {
    const root = this.opts.root.current;
    if (!root) return [];
    if (this.opts.selector) return Array.from(root.querySelectorAll(this.opts.selector));
    if (this.opts.attr) return Array.from(root.querySelectorAll(`[${this.opts.attr}]:not([data-disabled])`));
    return [];
  }

  onkeydown(e: KeyboardEvent) {
    const items = this.items();
    if (!items.length) return;
    const node = items.find(i => i.id === this.current.current) ?? items[0];
    const index = items.indexOf(node);
    const next = { horizontal: 'ArrowRight', vertical: 'ArrowDown' }[this.opts.orientation.current];
    const prev = { horizontal: 'ArrowLeft', vertical: 'ArrowUp' }[this.opts.orientation.current];
    const keyToIndex = {
      [next]: index + 1,
      [prev]: index - 1,
      Home: 0,
      End: items.length - 1,
      Enter: index + 1,
    };
    keyToIndex['Escape'] = index - 1;
    let target = keyToIndex[e.key];
    if (target === undefined) return;
    e.preventDefault();
    if (target < 0 && this.opts.loop.current) target = items.length - 1;
    else if (target === items.length && this.opts.loop.current) target = 0;
    const item = items[target];
    if (!item) return;
    item.focus();
    if (!Object.is(this.current.current, item.id)) this.moves++;
    this.current.current = item.id;
    const snapshot = $state.snapshot(this.history);
    this.history = [...snapshot.slice(-2), item.id];
  }
}
