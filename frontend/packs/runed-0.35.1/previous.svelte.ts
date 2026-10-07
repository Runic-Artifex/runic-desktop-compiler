// runed 0.35.1's Previous (dist/utilities/previous/previous.svelte.js), with
// types for the language the compiler lowers: the runed pack
// (frontend/packs/runed-0.35.1.ts) compiles this module in place of the
// package's, as a module of a package compiled from source. The code is the
// package's: a derived value whose function returns the getter's value from
// its previous run and then reads the getter again (tracked). Its
// `try { return previous } finally { previous = getter() }` is written as
// statements in that order, which has the same effect (also where the
// getter throws: the throw propagates and `previous` keeps its value).
// runed: MIT License, Copyright (c) 2024 Hunter Johnston, Thomas G. Lopes.

export class Previous<T> {
  #previousCallback: () => T | undefined = () => undefined;
  #previous: T | undefined = $derived.by(() => this.#previousCallback());

  constructor(getter: () => T, initialValue?: T) {
    let actualPrevious: T | undefined = undefined;
    if (initialValue !== undefined) actualPrevious = initialValue;
    this.#previousCallback = () => {
      const previous = actualPrevious;
      actualPrevious = getter();
      return previous;
    };
  }

  get current(): T | undefined {
    return this.#previous;
  }
}
