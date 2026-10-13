import { useEffect, useRef, useState } from 'react';

type Item = { id: number; label: string };

function Row({ item, count }: { item: Item; count: number }) {
  const [first, setFirst] = useState('');
  // An effect with no dependencies keeps the props of its first render.
  useEffect(() => {
    setFirst(`${item.label}/${count}`);
  }, []);
  return (
    <li id={`row-${item.id}`}>
      {item.label} {count} first {first}
    </li>
  );
}

export function App() {
  const [items, setItems] = useState<Item[]>([
    { id: 1, label: 'one' },
    { id: 2, label: 'two' },
  ]);
  const [count, setCount] = useState(0);
  const [log, setLog] = useState('');
  const commits = useRef(0);
  // Runs after every commit of App: none when a state is set to its value.
  useEffect(() => {
    commits.current += 1;
  });
  // A timeout started at mount reads the mount's count when it fires.
  useEffect(() => {
    const t = setTimeout(() => setLog(l => `${l ? l + ' ' : ''}timeout:${count}`), 300);
    return () => clearTimeout(t);
  }, []);
  function rename() {
    setItems(items.map(i => (i.id === 1 ? { ...i, label: i.label + '!' } : i)));
  }
  function same() {
    setItems(items);
    setCount(count);
  }
  function twice() {
    setCount(count + 1);
    setCount(count + 1);
  }
  function updaters() {
    setCount(c => c + 1);
    setCount(c => c + 1);
  }
  function show() {
    setLog(l => `${l ? l + ' ' : ''}commits:${commits.current}`);
  }
  return (
    <main>
      <h1 id="title">Staleness</h1>
      <ul>
        {items.map(item => (
          <Row key={item.id} item={item} count={count} />
        ))}
      </ul>
      <p id="count">{count}</p>
      <p id="log">{log}</p>
      <div className="controls">
        <button id="rename" onClick={rename}>Rename</button>
        <button id="same" onClick={same}>Same</button>
        <button id="twice" onClick={twice}>Twice</button>
        <button id="updaters" onClick={updaters}>Updaters</button>
        <button id="show" onClick={show}>Show</button>
      </div>
    </main>
  );
}
