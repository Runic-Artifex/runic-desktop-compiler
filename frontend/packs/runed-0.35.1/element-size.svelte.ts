// runed 0.35.1's ElementSize (dist/utilities/element-size/element-size.svelte.js),
// ported to the language the compiler lowers: the runed pack
// (frontend/packs/runed-0.35.1.ts) compiles this module in place of the
// package's, as a module of a package compiled from source.
// runed: MIT License, Copyright (c) 2024 Hunter Johnston, Thomas G. Lopes.
//
// As runed computes it, the size is the one a ResizeObserver last reported
// for the element once it observed it, and otherwise the element's offset
// size (`calculateSize`), or 0×0 without an element. The difference to the
// package is when the element is observed. Runed observes while effects
// read the size (svelte/reactivity's `createSubscriber`, which the runtime
// does not have): the port observes the element the getter gives from the
// creating instance's effect pass, again when the getter's element changes,
// until the instance is destroyed. The sizes read are the same while effects
// read them (bits-ui reads its arrow's size in its positioning effects);
// observing longer only makes later reads report an observed size where
// runed would measure the element again, which differs only for a fractional
// size (offsets are whole pixels). Only the border box (runed's default) is
// covered: `content-box` sizes need computed paddings and borders, which
// the runtime does not read.

type Size = { width: number; height: number };

export class ElementSize {
  #size: Size = { width: 0, height: 0 };
  #observed = false;
  #node: () => HTMLElement | null | undefined;
  #version = $state(0);
  #width = $derived.by(() => {
    void this.#version;
    return this.getSize().width;
  });
  #height = $derived.by(() => {
    void this.#version;
    return this.getSize().height;
  });

  constructor(node: () => HTMLElement | null | undefined, options?: { box?: 'border-box' }) {
    this.#node = node;
    if (options?.box !== undefined && options.box !== 'border-box')
      throw new Error('runed ElementSize: only the border box is covered');
    $effect(() => {
      const element = this.#node();
      if (!element) return;
      const observer = new ResizeObserver(entries => {
        this.#observed = true;
        for (const entry of entries) {
          this.#size.width = entry.borderBoxSize.reduce(
            (acc, size) => Math.max(acc, size.inlineSize),
            0,
          );
          this.#size.height = entry.borderBoxSize.reduce(
            (acc, size) => Math.max(acc, size.blockSize),
            0,
          );
        }
        this.#version++;
      });
      observer.observe(element);
      return () => {
        this.#observed = false;
        observer.disconnect();
        this.#version++;
      };
    });
  }

  calculateSize(): Size | undefined {
    const element = this.#node();
    if (!element) return undefined;
    return { width: element.offsetWidth, height: element.offsetHeight };
  }

  getSize(): Size {
    return this.#observed ? this.#size : (this.calculateSize() ?? this.#size);
  }

  get current(): Size {
    void this.#version;
    return this.getSize();
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }
}
