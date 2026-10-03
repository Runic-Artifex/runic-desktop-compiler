import React, { useState } from 'react';
import { MODES, reorder } from './order.ts';

export function App() {
  const [items, setItems] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [mode, setMode] = useState('reverse');
  return (
    <main>
      <p id="mode">Mode: {mode}</p>
      <div className="modes">
        {MODES.map(m => (
          <button key={m} id={`mode-${m}`} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <ul>
        {items.map(x => (
          <li key={x}>
            <button id={`item-${x}`} onClick={() => setItems(reorder(items, mode, x))}>
              Item {x}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
