import { useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';

// TodoMVC's edit mode in React: Enter saves and leaves edit mode, which
// removes the focused input during the commit (Chromium blurs it then; the
// onBlur handler is the render's closure); clicking elsewhere saves through
// blur; Alt+ArrowUp moves the edited item (React DOM restores focus after a
// move).
type Item = { id: number; text: string };

export function App() {
  const [items, setItems] = useState<Item[]>([
    { id: 1, text: 'Milk' },
    { id: 2, text: 'Bread' },
    { id: 3, text: 'Eggs' },
  ]);
  const [editing, setEditing] = useState(0);
  const [draft, setDraft] = useState('');
  const [log, setLog] = useState<string[]>([]);

  function save(item: Item, text: string, why: string) {
    setLog(l => [...l, `${why} ${item.id} ${editing}`]);
    if (editing !== item.id) return;
    setItems(list => list.map(i => (i.id === item.id ? { id: i.id, text: text.trim() } : i)));
    setEditing(0);
  }

  function key(e: KeyboardEvent<HTMLInputElement>, item: Item) {
    if (e.key === 'Enter') save(item, (e.target as HTMLInputElement).value, 'enter');
    if (e.key === 'ArrowUp' && e.altKey) {
      const i = items.indexOf(item);
      if (i > 0) setItems([...items.slice(0, i - 1), item, items[i - 1], ...items.slice(i + 1)]);
      setLog(l => [...l, `up ${item.id}`]);
    }
  }

  return (
    <main>
      <button id="other">Other</button>
      <ul>
        {items.map(item => (
          <li key={item.id}>
            {editing === item.id ? (
              <input
                id={'edit-' + item.id}
                type="text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={(e: FocusEvent<HTMLInputElement>) => save(item, e.target.value, 'blur')}
                onKeyDown={e => key(e, item)}
              />
            ) : (
              <span id={'label-' + item.id} onDoubleClick={() => {
                  setEditing(item.id);
                  setDraft(item.text);
                }}>
                {item.text}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p id="log">{log.join(', ')}</p>
    </main>
  );
}
