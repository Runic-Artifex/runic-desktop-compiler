import React, { useState } from 'react';
import {
  COLUMNS,
  cellName,
  columnName,
  columns,
  commit,
  display,
  emptySheet,
  rows,
  type Cell,
} from './sheet.ts';

const EMPTY: Cell[] = emptySheet();

// Every cell is a text input showing its value; focusing one (a click or
// Tab) edits its formula in place, and leaving it (Enter or blur) commits.
export function App() {
  const [cells, setCells] = useState(EMPTY);
  const [editing, setEditing] = useState(-1);
  const [draft, setDraft] = useState('');

  function start(i: number) {
    setEditing(i);
    setDraft(cells[i].formula);
  }

  function finish(i: number) {
    if (editing !== i) return;
    setEditing(-1);
    if (draft !== cells[i].formula) setCells(commit(cells, i, draft));
  }

  return (
    <main>
      <h1>Cells</h1>
      <div id="sheet" className="sheet">
        <div className="row">
          <div className="corner"></div>
          {columns.map(c => (
            <div key={c} className="head">
              {columnName(c)}
            </div>
          ))}
        </div>
        {rows.map(r => (
          <div key={r} className="row">
            <div className="side">{r}</div>
            {columns.map(c => (
              <input
                key={c}
                id={cellName(r * COLUMNS + c)}
                type="text"
                className={cells[r * COLUMNS + c].kind === 'error' ? 'cell error' : 'cell'}
                value={editing === r * COLUMNS + c ? draft : display(cells[r * COLUMNS + c])}
                onFocus={() => start(r * COLUMNS + c)}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.currentTarget?.blur();
                }}
                onBlur={() => finish(r * COLUMNS + c)}
              />
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}
