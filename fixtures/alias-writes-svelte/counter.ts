// Mutations through aliases of a $state object (a context's value and the
// constants that hold it) are writes through its proxy: every reader updates.
import { getContext, setContext } from 'svelte';

export type Counter = { count: number; items: number[] };

export function setCounter(counter: Counter): Counter {
  setContext('counter', counter);
  return counter;
}

export function getCounter(): Counter {
  return getContext<Counter>('counter');
}
