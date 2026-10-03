import { useEffect, useLayoutEffect, useState } from 'react';

// One commit that unmounts a subtree and updates its siblings: the cleanups
// of destroyed components run in the batched cleanup walk of their phase.
const log: string[] = [];
function note(s: string) {
  log.push(s);
}

function Leaf({ owner, n }: { owner: string; n: number }) {
  useLayoutEffect(() => {
    note(`${owner}.leaf layout ${n}`);
    return () => note(`${owner}.leaf layout cleanup ${n}`);
  });
  useEffect(() => {
    note(`${owner}.leaf effect ${n}`);
    return () => note(`${owner}.leaf cleanup ${n}`);
  });
  return <span> ({owner}.leaf)</span>;
}

function Panel({ name, n, onGone }: { name: string; n: number; onGone: () => void }) {
  useLayoutEffect(() => {
    note(`${name} layout ${n}`);
    return () => note(`${name} layout cleanup ${n}`);
  });
  useEffect(() => {
    note(`${name} effect ${n}`);
    return () => note(`${name} cleanup ${n}`);
  });
  // A passive cleanup at unmount that sets the parent's state.
  useEffect(() => () => onGone(), []);
  return (
    <div id={'panel-' + name}>
      {name} {n}
      <Leaf owner={name} n={n} />
    </div>
  );
}

function Counter({ n }: { n: number }) {
  useLayoutEffect(() => {
    note(`C layout ${n}`);
    return () => note(`C layout cleanup ${n}`);
  });
  useEffect(() => {
    note(`C effect ${n}`);
    return () => note(`C cleanup ${n}`);
  });
  return <p id="counter">C {n}</p>;
}

export function App() {
  const [show, setShow] = useState(true);
  const [n, setN] = useState(0);
  const [gone, setGone] = useState(0);
  const [shown, setShown] = useState('');
  useEffect(() => {
    note(`App effect gone=${gone}`);
  });
  function swap() {
    setShow(s => !s);
    setN(x => x + 1);
    queueMicrotask(() => note('microtask'));
  }
  function dump() {
    setShown(log.join(' | '));
    log.splice(0, log.length);
  }
  return (
    <main>
      <h1 id="title">Swap</h1>
      <Counter n={n} />
      {show ? (
        <Panel key="A" name="A" n={n} onGone={() => setGone(g => g + 1)} />
      ) : (
        <Panel key="B" name="B" n={n} onGone={() => setGone(g => g + 1)} />
      )}
      <p id="gone">gone {gone}</p>
      <p id="log">{shown}</p>
      <div className="controls">
        <button id="swap" onClick={swap}>
          Swap
        </button>
        <button id="dump" onClick={dump}>
          Dump
        </button>
      </div>
    </main>
  );
}
