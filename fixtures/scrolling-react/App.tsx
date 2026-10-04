import React, { useLayoutEffect, useRef, useState } from 'react';

// Scroll events: one per moved scroller in the rendering step after the
// action; none at the wrapper (React's onScroll does not bubble since React
// 17). Shrinking the content clamps the scroll position, whose event follows
// a frame later. React renders updates from scroll events in a later task
// (continuous priority), so their state is only rendered as text.
function range(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

export function App() {
  const [n, setN] = useState(40);
  const [log, setLog] = useState<number[]>([]);
  const [outer, setOuter] = useState(0);
  const [reads, setReads] = useState(0);
  const [readout, setReadout] = useState('');
  const list = useRef<HTMLDivElement | null>(null);
  const items = range(n);

  // After the DOM update of a read: a forced layout clamps at once.
  useLayoutEffect(() => {
    if (reads > 0 && list.current !== null) setReadout(String(list.current.scrollTop));
  }, [reads]);

  return (
    <main>
      {/* First: Blitz hit-tests a scrolled container over the area above it (docs/BLITZ-GAPS.md). */}
      <div id="outer" onScroll={() => setOuter(o => o + 1)}>
        <div
          id="list"
          ref={list}
          onScroll={() => {
            const top = list.current ? list.current.scrollTop : -1;
            setLog(l => [...l, top]);
          }}
        >
          {items.map(i => (
            <div key={i} className="item">
              Item {i}
            </div>
          ))}
        </div>
      </div>
      <div className="row">
        <button
          id="down"
          onClick={() => {
            if (list.current) list.current.scrollTop = 400;
          }}
        >
          Down
        </button>
        <button id="shrink" onClick={() => setN(20)}>
          Shrink
        </button>
        <button id="tiny" onClick={() => setN(3)}>
          Tiny
        </button>
        <button id="grow" onClick={() => setN(40)}>
          Grow
        </button>
        <button
          id="read"
          onClick={() => {
            setN(10);
            setReads(r => r + 1);
          }}
        >
          Read
        </button>
      </div>
      <p id="log">{log.join(' ')}</p>
      <p id="state">
        {outer} {readout}
      </p>
    </main>
  );
}
