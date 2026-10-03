import { useEffect, useLayoutEffect, useState } from 'react';

// Effect runs are logged into a plain module array and shown on Dump.
const log: string[] = [];

export function App() {
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const [shown, setShown] = useState('');
  // State set by a layout effect re-renders synchronously, before microtasks.
  useLayoutEffect(() => {
    log.push(`layout a=${a} b=${b}`);
    setB(a * 10);
  }, [a]);
  useLayoutEffect(() => {
    log.push(`layout b=${b}`);
  }, [b]);
  useEffect(() => {
    log.push(`effect a=${a} b=${b}`);
  });
  function inc() {
    setA(a + 1);
    queueMicrotask(() => log.push('microtask'));
  }
  function dump() {
    setShown(log.join(' | '));
    log.splice(0, log.length);
  }
  return (
    <main>
      <h1 id="title">Layout effect writes state</h1>
      <p id="a">a = {a}</p>
      <p id="b">b = {b}</p>
      <p id="log">{shown}</p>
      <div className="controls">
        <button id="inc" onClick={inc}>
          Increment
        </button>
        <button id="dump" onClick={dump}>
          Dump
        </button>
      </div>
    </main>
  );
}
