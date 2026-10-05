import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// React's continuous lane for scroll events: the listener's update renders
// in a scheduler task after the frame (after its microtasks and the frame's
// ResizeObserver notifications), its passive effects after that; a click's
// update renders in its microtask. The console lines show the order.
export function App() {
  const [top, setTop] = useState(0);
  const [clicks, setClicks] = useState(0);
  const list = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    console.log(`layout ${top} ${clicks}`);
  }, [top, clicks]);
  useEffect(() => {
    console.log(`passive ${top} ${clicks}`);
  }, [top, clicks]);
  useEffect(() => {
    const o = new ResizeObserver(entries => {
      console.log('resize ' + entries[0].contentRect.width);
    });
    if (box.current !== null) o.observe(box.current);
    return () => o.disconnect();
  }, []);

  function scrolled() {
    if (list.current === null) return;
    const t = list.current.scrollTop;
    console.log('scroll ' + t);
    setTop(t);
    queueMicrotask(() => console.log('microtask'));
    Promise.resolve(t).then(v => console.log('promise ' + v));
  }

  function down() {
    if (list.current !== null) list.current.scrollTop = list.current.scrollTop + 200;
  }

  return (
    <main>
      <div id="list" ref={list} onScroll={scrolled}>
        <div className="tall"></div>
      </div>
      <div id="box" ref={box} style={{ width: 100 + top / 4 }}>
        {top}
      </div>
      <div className="row">
        <button
          id="down"
          onClick={() => {
            down();
            console.log('down');
          }}
        >
          Down
        </button>
        <button id="count" onClick={() => setClicks(clicks + 1)}>
          {clicks}
        </button>
      </div>
    </main>
  );
}
