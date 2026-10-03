import { useEffect, useState } from 'react';

// Effect runs are logged into a plain module array and shown on Dump.
const log: string[] = [];

export function App() {
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const [shown, setShown] = useState('');
  // A passive effect deriving b from a: React renders b in a later task.
  useEffect(() => {
    setB(a * 10);
  }, [a]);
  useEffect(() => {
    log.push(`b effect ${b}`);
  }, [b]);
  function dump() {
    setShown(`${log.join(' | ')} (${log.length} runs)`);
    log.splice(0, log.length);
  }
  return (
    <main>
      <h1 id="title">Effect writes state</h1>
      <p id="a">a = {a}</p>
      <p id="b">b = {b}</p>
      <p id="log">{shown}</p>
      <div className="controls">
        <button id="inc" onClick={() => setA(a + 1)}>
          Increment
        </button>
        <button id="dump" onClick={dump}>
          Dump
        </button>
      </div>
    </main>
  );
}
