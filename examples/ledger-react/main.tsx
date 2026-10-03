import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

interface Entry {
  label: string;
  amount: number;
  category: string;
  paid: boolean;
}

const presets: Entry[] = [
  { label: 'Coffee', amount: 3.5, category: 'food', paid: false },
  { label: 'Train ticket', amount: 12.4, category: 'travel', paid: false },
  { label: 'Notebook', amount: 7.25, category: 'office', paid: true },
  { label: 'Lunch', amount: 9.9, category: 'food', paid: false },
];

function describe(list: Entry[]): string {
  if (list.length === 0) return 'nothing';
  const labels = list.map(e => e.label);
  if (labels.length > 2) return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`;
  return labels.join(' and ');
}

function categoriesOf(entries: Entry[]): string {
  const counts = new Map<string, number>();
  const names: string[] = [];
  for (const e of entries) {
    if (!counts.has(e.category)) names.push(e.category);
    counts.set(e.category, (counts.get(e.category) ?? 0) + e.amount);
  }
  names.sort();
  return names.map(name => `${name}: ${(counts.get(name) ?? 0).toFixed(2)}`).join(', ');
}

function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [added, setAdded] = useState(0);

  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  const unpaid = entries.filter(e => !e.paid);
  const largest = entries.reduce((max, e) => Math.max(max, e.amount), 0);
  const categories = categoriesOf(entries);

  function addPreset() {
    const preset = presets[added % presets.length];
    setEntries([...entries, { ...preset }]);
    setAdded(added + 1);
  }

  function addDraft() {
    const label = draft.trim();
    if (label.length === 0) return;
    const name = label.slice(0, 1).toUpperCase() + label.slice(1);
    setEntries([...entries, { label: name, amount: label.length * 1.5, category: 'custom', paid: false }]);
    setDraft('');
  }

  function payFirst() {
    const index = entries.findIndex(e => !e.paid);
    if (index < 0) return;
    setEntries(entries.map((e, i) => (i === index ? { ...e, paid: true } : e)));
  }

  function removeLast() {
    setEntries(entries.slice(0, -1));
  }

  return (
    <main>
      <h1>Ledger</h1>
      <p id="count">
        {entries.length} entries, {unpaid.length} unpaid
      </p>
      <p id="total">
        Total: {total.toFixed(2)}, largest: {largest.toFixed(2)}
      </p>
      <p id="unpaid">Unpaid: {describe(unpaid)}</p>
      <p id="categories">{categories || 'No categories yet'}</p>
      <div className="row">
        <input id="draft" type="text" value={draft} onChange={e => setDraft(e.target.value)} />
        <button id="add-draft" onClick={addDraft} disabled={draft.trim() === ''}>
          Add
        </button>
      </div>
      <div className="row">
        <button id="add" onClick={addPreset}>
          Add preset
        </button>
        <button id="pay" onClick={payFirst} disabled={unpaid.length === 0}>
          Pay first unpaid
        </button>
        <button id="remove" onClick={removeLast} disabled={entries.length === 0}>
          Remove last
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
