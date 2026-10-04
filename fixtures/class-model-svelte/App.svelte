<script lang="ts">
  import { onMount } from 'svelte';
  import { Stack, Tally } from './model';

  let count = $state(0);
  let summary = $state('');
  let stack = $state(Stack.empty());
  const first = stack;
  const tally = Tally.create(3, (c, s) => {
    count = c;
    summary = s;
  });
  // A bound method and an arrow function field used as listeners.
  const increment = tally.increment;
  const decrement = tally.decrement;

  /** A class declared in the component script. */
  class Labeller {
    #prefix: string;
    constructor(prefix: string) {
      this.#prefix = prefix;
    }
    label(n: number): string {
      return `${this.#prefix}${n}`;
    }
  }
  const labeller = new Labeller('#');

  function push() {
    stack = stack.push(labeller.label(count));
  }
  function pop() {
    stack = stack.pop();
  }
  function reset() {
    tally.count = 0;
  }

  onMount(() => {
    window.addEventListener('keydown', tally.onKey);
    return () => window.removeEventListener('keydown', tally.onKey);
  });
</script>

<main>
  <h1 id="title">Classes</h1>
  <p id="count">{count}</p>
  <p id="summary">{summary}</p>
  <p id="stack">{stack.size} items, top {stack.top}{stack === first ? ' (initial)' : ''}</p>
  <p id="limit">Limit {Tally.LIMIT}{count >= Tally.LIMIT ? ' reached' : ''}</p>
  <div class="controls">
    <button id="increment" onclick={increment}>Increment</button>
    <button id="decrement" onclick={decrement}>Decrement</button>
    <button id="push" onclick={push} disabled={stack.includes(labeller.label(count))}>Push</button>
    <button id="pop" onclick={pop} disabled={stack.size === 0}>Pop</button>
    <button id="reset" onclick={reset}>Reset</button>
  </div>
</main>
