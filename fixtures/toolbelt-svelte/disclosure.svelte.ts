// A disclosure in the style of bits-ui (docs/design/M6-LIBRARIES.md, step 6),
// written against svelte-toolbelt and runed directly: state classes holding
// boxes, a context keyed by a runed Context, watch and watch.pre, props
// bags merged with mergeProps (composed handlers, joined classes, style
// objects) and an attachment registering the panel's node.
import { Context, watch } from 'runed';
import { attachRef, type ReadableBox, type WritableBox } from 'svelte-toolbelt';

type RootOpts = {
  open: WritableBox<boolean>;
  id: ReadableBox<string>;
};

export const RootContext = new Context<RootState>('Disclosure.Root');

export class RootState {
  static create(opts: RootOpts) {
    return RootContext.set(new RootState(opts));
  }
  readonly opts: RootOpts;
  panelId = $state('');
  panelNode = $state<HTMLElement | null>(null);
  toggles = $state(0);
  seen = $state('');

  constructor(opts: RootOpts) {
    this.opts = opts;
    // Runs after the DOM update with the new and the previous value.
    watch(
      () => this.opts.open.current,
      (open, previous) => {
        if (previous !== undefined) this.toggles++;
      },
    );
    // Runs before the DOM update.
    watch.pre(
      () => this.panelId,
      id => {
        this.seen = id;
      },
    );
  }

  toggle() {
    this.opts.open.current = !this.opts.open.current;
  }

  props: Record<string, unknown> = $derived.by(() => ({
    id: this.opts.id.current,
    'data-state': this.opts.open.current ? 'open' : 'closed',
    class: 'root',
    style: { '--toggles': String(this.toggles) },
  }));
}

export class TriggerState {
  static create() {
    return new TriggerState(RootContext.get());
  }
  readonly root: RootState;
  constructor(root: RootState) {
    this.root = root;
  }

  onclick = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    this.root.toggle();
  };

  props: Record<string, unknown> = $derived.by(() => ({
    'aria-expanded': this.root.opts.open.current ? 'true' : 'false',
    'aria-controls': this.root.panelId,
    class: 'trigger',
    onclick: this.onclick,
  }));
}

export class PanelState {
  static create(id: ReadableBox<string>, ref: WritableBox<HTMLElement | null>) {
    return new PanelState(RootContext.get(), id, ref);
  }
  readonly root: RootState;
  readonly id: ReadableBox<string>;
  readonly attachment;
  constructor(root: RootState, id: ReadableBox<string>, ref: WritableBox<HTMLElement | null>) {
    this.root = root;
    this.id = id;
    this.root.panelId = id.current;
    this.attachment = attachRef(ref, node => (this.root.panelNode = node));
  }

  props: Record<string, unknown> = $derived.by(() => ({
    id: this.id.current,
    hidden: !this.root.opts.open.current,
    'data-node': this.root.panelNode ? 'attached' : 'none',
    ...this.attachment,
  }));
}
