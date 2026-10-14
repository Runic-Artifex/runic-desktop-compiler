import { useEffect, useLayoutEffect, useState } from 'react';

// Effect runs are logged into a plain module array and shown on Dump.
const log: string[] = [];

export function App() {
  const [n, setN] = useState(0);
  const [m, setM] = useState(0);
  const [k, setK] = useState(0);
  const [boot, setBoot] = useState(0);
  const [shown, setShown] = useState('');
  // Every commit of App, before the effects below.
  useLayoutEffect(() => {
    log.push(`commit ${n}${m}${k}${boot}`);
  });
  // A passive effect whose dependencies include the state it sets: React
  // runs it again after the next commit, not in the same flush.
  useEffect(() => {
    log.push(`n ${n}`);
    if (n > 0 && n < 3) setN(n + 1);
  }, [n]);
  // The same in a layout effect: the re-render is synchronous.
  useLayoutEffect(() => {
    log.push(`m ${m}`);
    if (m > 0 && m < 3) setM(m + 1);
  }, [m]);
  // No dependencies: an updater that stops changing the state commits nothing.
  useEffect(() => {
    setK(x => (x < 2 ? x + 1 : x));
  });
  // A chain that starts at mount.
  useEffect(() => {
    if (boot < 3) setBoot(boot + 1);
  }, [boot]);
  function dump() {
    setShown(log.join(' | '));
    log.splice(0, log.length);
  }
  function both() {
    setN(1);
    setM(1);
  }
  return (
    <main>
      <h1 id="title">Effect self</h1>
      <p id="values">
        {n} {m} {k} {boot}
      </p>
      <p id="log">{shown}</p>
      <div className="controls">
        <button id="passive" onClick={() => setN(1)}>
          Passive
        </button>
        <button id="layout" onClick={() => setM(1)}>
          Layout
        </button>
        <button id="both" onClick={both}>
          Both
        </button>
        <button id="dump" onClick={dump}>
          Dump
        </button>
      </div>
    </main>
  );
}
