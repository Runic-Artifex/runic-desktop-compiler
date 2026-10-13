import { useState } from 'react';
import { label, run } from './logic.ts';

export function App() {
  const [k, setK] = useState(1);
  const [kind, setKind] = useState(0);
  const rows = run(k);
  return (
    <main>
      <h1>Default parameters</h1>
      <div className="row">
        <button id="next" onClick={() => setK(k + 1)}>
          next
        </button>
        <button id="kind" onClick={() => setKind((kind + 1) % 4)}>
          kind
        </button>
      </div>
      <ol>
        {rows.map((row, i) => (
          <li key={i} id={'r' + i}>
            {row}
          </li>
        ))}
      </ol>
      <p id="date">{label(kind, kind % 2 ? undefined : 'kind')}</p>
    </main>
  );
}
