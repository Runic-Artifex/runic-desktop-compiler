// A $state object shared through a context and held by other values: every
// read through the proxy is a dependency of the reader, wherever it is held.
import { getContext, setContext } from 'svelte';

export type Counter = { count: number; items: number[] };

export function setCounter(counter: Counter): Counter {
  setContext('counter', counter);
  return counter;
}

export function getCounter(): Counter {
  return getContext<Counter>('counter');
}

export function mapOf(counter: Counter): Map<string, Counter> {
  const map = new Map<string, Counter>();
  map.set('c', counter);
  return map;
}

export class Holder {
  counter: Counter;
  constructor(counter: Counter) {
    this.counter = counter;
  }
}
