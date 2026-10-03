import { useEffect, useLayoutEffect, useState } from 'react';

// A plain module array: logging into state would change scheduling.
const log: string[] = [];
function note(s: string) {
  log.push(s);
}

function Child({ name, count }: { name: string; count: number }) {
  // No dependency array: runs after every render (a parent render re-renders it).
  useLayoutEffect(() => {
    note(`${name} layout ${count}`);
    return () => note(`${name} layout cleanup ${count}`);
  });
  useEffect(() => {
    note(`${name} effect ${count}`);
    return () => note(`${name} cleanup ${count}`);
  }, [count]);
  useEffect(() => {
    note(`${name} mount`);
    return () => note(`${name} unmount`);
  }, []);
  return (
    <p id={'child-' + name}>
      {name}: {count}
    </p>
  );
}

export function App() {
  const [count, setCount] = useState(0);
  const [show, setShow] = useState(true);
  const [shown, setShown] = useState('');
  useLayoutEffect(() => {
    note(`App layout ${count}`);
  }, [count]);
  useEffect(() => {
    note(`App effect ${count}`);
    return () => note(`App cleanup ${count}`);
  }, [count]);
  useEffect(() => {
    note('App mount');
    return () => note('App destroy');
  }, []);
  function dump() {
    setShown(log.join(' | '));
    log.splice(0, log.length);
  }
  return (
    <main>
      <h1 id="title">Effects</h1>
      {show && (
        <>
          <Child name="A" count={count} />
          <Child name="B" count={count} />
        </>
      )}
      <p id="log">{shown}</p>
      <div className="controls">
        <button id="inc" onClick={() => setCount(c => c + 1)}>
          Increment
        </button>
        <button id="toggle" onClick={() => setShow(s => !s)}>
          Toggle
        </button>
        <button id="dump" onClick={dump}>
          Dump
        </button>
      </div>
    </main>
  );
}
