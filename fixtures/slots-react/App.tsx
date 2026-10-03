import React, { useState } from 'react';
import { Card } from './Card.tsx';
import { Picker } from './Picker.tsx';
import { Tally } from './Tally.tsx';

export function App() {
  const [items, setItems] = useState([
    { id: 1, name: 'Apple' },
    { id: 2, name: 'Pear' },
    { id: 3, name: 'Plum' },
  ]);
  const [picked, setPicked] = useState(0);
  const [note, setNote] = useState('none');
  function pick(id: number) {
    setPicked(id);
  }
  return (
    <main>
      <h1 id="title">Slots</h1>
      <Card title="plain">
        <p id="plain-body">Picked {picked}</p>
      </Card>
      <Card title="fancy" header={t => <span id="fancy-header">Header for {t}</span>}>
        <p id="fancy-body">Note: {note}</p>
        <button id="note" onClick={() => setNote(note === 'none' ? 'set' : 'none')}>
          Note
        </button>
      </Card>
      <Picker
        items={items}
        row={(item, first) => (
          <>
            <span id={`name-${item.id}`}>
              {first ? '* ' : ''}
              {item.name}
            </span>
            <button id={`pick-${item.id}`} disabled={picked === item.id} onClick={() => pick(item.id)}>
              Pick
            </button>
            <Tally id={item.id} />
          </>
        )}
      />
      <button id="drop" onClick={() => setItems(items.slice(1))}>
        Drop first
      </button>
    </main>
  );
}
