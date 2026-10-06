import React, { useEffect, useRef, useState } from 'react';
import { ROW, matching, clamp, first, last, describe } from './rows.ts';

// A virtualized list: 10,000 rows of a fixed height, of which only the
// rows in view (plus a few above and below) are in the document. React
// renders the updates of the list's scroll events in a scheduler task after
// the frame (continuous priority), so the frame of a scroll still shows the
// rows it had.
export function App() {
  const [filter, setFilter] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  const rows = matching(filter);
  const top = clamp(scrollTop, rows.length, height);
  const start = first(top);
  const end = last(top, height, rows.length);
  const visible = rows.slice(start, end);
  const status = describe(selected);

  function measure() {
    if (list.current === null) return;
    setScrollTop(list.current.scrollTop);
    setHeight(list.current.clientHeight);
  }
  useEffect(() => {
    measure();
  }, []);

  function jump() {
    const i = rows.findIndex(r => r.id === 5000);
    if (i < 0) return;
    setSelected(5000);
    if (list.current !== null) list.current.scrollTop = i * ROW;
  }

  return (
    <main>
      {/* First: Blitz hit-tests a scrolled container over the area above it (docs/BLITZ-GAPS.md). */}
      <div id="list" ref={list} onScroll={measure}>
        <div className="spacer" style={{ height: rows.length * ROW, paddingTop: start * ROW }}>
          {visible.map(row => (
            <button
              key={row.id}
              id={`row-${row.id}`}
              className={`row${row.id % 2 === 0 ? ' even' : ''}${row.id === selected ? ' selected' : ''}`}
              onClick={() => setSelected(row.id)}
            >
              <span className="id">{row.id}</span>
              {row.label} · {row.kind}
            </button>
          ))}
        </div>
      </div>
      <div className="bar">
        <input
          id="filter"
          type="text"
          aria-label="Filter"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <button id="jump" onClick={jump}>
          Jump to 5,000
        </button>
      </div>
      <p id="status">
        {status} ·{rows.length} rows, rendering {start + 1}–{end}
      </p>
    </main>
  );
}
