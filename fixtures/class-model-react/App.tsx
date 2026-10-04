import { useEffect, useState } from 'react';
import { Stack, Tally } from './model.ts';

/** A class at module level (classes in component bodies are rejected). */
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
const EMPTY = Stack.empty();

export function App() {
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState('');
  const [stack, setStack] = useState(EMPTY);
  const [tally] = useState(
    Tally.create(3, (c, s) => {
      setCount(c);
      setSummary(s);
    }),
  );
  // A bound method and an arrow function field used as listeners.
  const increment = tally.increment;
  const decrement = tally.decrement;

  function push() {
    setStack(stack.push(labeller.label(count)));
  }
  function pop() {
    setStack(stack.pop());
  }
  function reset() {
    tally.count = 0;
  }

  useEffect(() => {
    window.addEventListener('keydown', tally.onKey);
    return () => window.removeEventListener('keydown', tally.onKey);
  }, []);

  return (
    <main>
      <h1 id="title">Classes</h1>
      <p id="count">{count}</p>
      <p id="summary">{summary}</p>
      <p id="stack">
        {stack.size} items, top {stack.top}
        {stack === EMPTY ? ' (initial)' : ''}
      </p>
      <p id="limit">
        Limit {Tally.LIMIT}
        {count >= Tally.LIMIT ? ' reached' : ''}
      </p>
      <div className="controls">
        <button id="increment" onClick={increment}>
          Increment
        </button>
        <button id="decrement" onClick={decrement}>
          Decrement
        </button>
        <button id="push" onClick={push} disabled={stack.includes(labeller.label(count))}>
          Push
        </button>
        <button id="pop" onClick={pop} disabled={stack.size === 0}>
          Pop
        </button>
        <button id="reset" onClick={reset}>
          Reset
        </button>
      </div>
    </main>
  );
}
