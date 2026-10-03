import React, { useState } from 'react';
import { Row } from './Row.tsx';
import { Editor } from './Editor.tsx';

interface Item {
  id: number;
  label: string;
}

export function App() {
  const [items, setItems] = useState<Item[]>([
    { id: 1, label: 'Alpha' },
    { id: 2, label: 'Beta' },
    { id: 3, label: 'Gamma' },
  ]);
  const [next, setNext] = useState(4);
  const [name, setName] = useState('Delta');
  const [showEditor, setShowEditor] = useState(true);

  function add() {
    setItems([...items, { id: next, label: name }]);
    setNext(next + 1);
  }
  function remove(id: number) {
    setItems(items.filter(i => i.id !== id));
  }
  function up(id: number) {
    const i = items.findIndex(x => x.id === id);
    if (i > 0) {
      const moved = items.slice();
      moved[i] = items[i - 1];
      moved[i - 1] = items[i];
      setItems(moved);
    }
  }
  function reverse() {
    setItems(items.toReversed());
  }

  return (
    <main>
      <h1 id="title">Components</h1>
      <ul>
        {items.length === 0 ? (
          <li id="empty">Nothing left</li>
        ) : (
          items.map((item, i) => (
            <Row
              key={item.id}
              id={item.id}
              label={item.label}
              first={i === 0}
              onRemove={remove}
              onUp={up}
            />
          ))
        )}
      </ul>
      <p id="summary">
        {items.length} items, next {next}, name {name}
      </p>
      <div className="controls">
        <button id="add" onClick={add}>
          Add
        </button>
        <button id="reverse" onClick={reverse}>
          Reverse
        </button>
        <button id="toggle" onClick={() => setShowEditor(!showEditor)}>
          Toggle editor
        </button>
      </div>
      {showEditor && <Editor value={name} onChange={setName} />}
    </main>
  );
}
