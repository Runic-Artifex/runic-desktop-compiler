import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Effects of keyed list items, logged into a plain module array: React runs
// them in the commit after rendering the new order, children before their
// parent and siblings in document order, for new and updated items alike.
const log: string[] = [];
function note(s: string) {
  log.push(s);
}

function prepend(id: number, xs: number[]): number[] {
  const out: number[] = [id];
  for (const x of xs) out.push(x);
  return out;
}
function append(xs: number[], id: number): number[] {
  const out = xs.slice();
  out.push(id);
  return out;
}
function rotated(xs: number[]): number[] {
  const out = xs.slice(1);
  if (xs.length > 0) out.push(xs[0]);
  return out;
}
function shuffled(xs: number[], a: number, b: number): number[] {
  const mid = Math.floor(xs.length / 2);
  const out: number[] = [a];
  for (const x of xs.slice(mid).reverse()) out.push(x);
  out.push(b);
  for (const x of xs.slice(0, mid)) out.push(x);
  return out;
}

function Row({ id, n }: { id: number; n: number }) {
  useLayoutEffect(() => {
    note(`layout ${id} ${n}`);
    return () => note(`layout cleanup ${id} ${n}`);
  }, [id, n]);
  useEffect(() => {
    note(`effect ${id} ${n}`);
    return () => note(`cleanup ${id} ${n}`);
  }, [id, n]);
  return (
    <p id={'row-' + id}>
      {id} {n}
    </p>
  );
}

export function App() {
  const [items, setItems] = useState([1, 2, 3]);
  const [n, setN] = useState(0);
  const [shown, setShown] = useState('');
  const next = useRef(4);
  function fresh(): number {
    const id = next.current;
    next.current += 1;
    return id;
  }
  function front() {
    const id = fresh();
    setItems(xs => prepend(id, xs));
    setN(v => v + 1);
  }
  function back() {
    const id = fresh();
    setItems(xs => append(xs, id));
    setN(v => v + 1);
  }
  function reverse() {
    setItems(xs => xs.slice().reverse());
    setN(v => v + 1);
  }
  function rotate() {
    setItems(xs => rotated(xs));
    setN(v => v + 1);
  }
  function shuffle() {
    const a = fresh();
    const b = fresh();
    setItems(xs => shuffled(xs, a, b));
    setN(v => v + 1);
  }
  function dump() {
    setShown(log.join(' | '));
    log.splice(0, log.length);
  }
  return (
    <main>
      <h1 id="title">Effects of list items</h1>
      {items.map(i => (
        <Row key={i} id={i} n={n} />
      ))}
      <p id="log">{shown}</p>
      <div className="controls">
        <button id="bump" onClick={() => setN(v => v + 1)}>
          Bump
        </button>
        <button id="front" onClick={front}>
          Front
        </button>
        <button id="back" onClick={back}>
          Back
        </button>
        <button id="reverse" onClick={reverse}>
          Reverse
        </button>
        <button id="rotate" onClick={rotate}>
          Rotate
        </button>
        <button id="shuffle" onClick={shuffle}>
          Shuffle
        </button>
        <button id="dump" onClick={dump}>
          Dump
        </button>
      </div>
    </main>
  );
}
