import { useState } from 'react';

export function App() {
  const [count, setCount] = useState(0);
  const [log, setLog] = useState('');
  function later() {
    setCount(count + 1);
    setTimeout(() => setLog(l => `${l} later:${count}`), 100);
  }
  function micro() {
    setCount(count + 1);
    queueMicrotask(() => setLog(l => `${l} micro:${count}`));
  }
  function functional() {
    setTimeout(() => setCount(c => c + 10), 50);
    setCount(count + 1);
  }
  return (
    <main>
      <h1 id="title">Closures</h1>
      <p id="count">{count}</p>
      <p id="log">{log}</p>
      <div className="controls">
        <button id="later" onClick={later}>Later</button>
        <button id="micro" onClick={micro}>Micro</button>
        <button id="functional" onClick={functional}>Functional</button>
      </div>
    </main>
  );
}
