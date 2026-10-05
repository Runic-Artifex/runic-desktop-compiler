import React, { useEffect, useRef, useState } from 'react';

// ResizeObserver (M6) in React: the resize-svelte fixture's observers. The
// callbacks' state updates render in a later task (React's default lane),
// so the deeper element's size follows in a later frame; the log after the
// two frames each step waits for is the same.
function name(
  t: HTMLElement,
  outer: HTMLDivElement | null,
  inner: HTMLDivElement | null,
  hidden: HTMLDivElement | null,
): string {
  if (t === outer) return 'outer';
  if (t === inner) return 'inner';
  if (t === hidden) return 'hidden';
  return '?';
}

export function App() {
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);
  const hidden = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(200.5);
  const [shown, setShown] = useState(false);
  const [innerWidth, setInnerWidth] = useState(10);
  const [log, setLog] = useState<string[]>([]);
  const [observer, setObserver] = useState<ResizeObserver | null>(null);

  useEffect(() => {
    const fmt = (e: ResizeObserverEntry): string => {
      const r = e.contentRect;
      const b = e.borderBoxSize[0];
      const c = e.contentBoxSize[0];
      const d = e.devicePixelContentBoxSize[0];
      const who = name(e.target, outer.current, inner.current, hidden.current);
      return `${who} rect ${r.x},${r.y},${r.width}x${r.height} ${r.top},${r.right},${r.bottom},${r.left} border ${b.inlineSize}x${b.blockSize} content ${c.inlineSize}x${c.blockSize} device ${d.inlineSize}x${d.blockSize}`;
    };
    const content = new ResizeObserver((entries, me) => {
      for (const e of entries) {
        const line = `content ${fmt(e)} same ${me === content}`;
        setLog(l => [...l, line]);
        if (e.target === outer.current) setInnerWidth(Math.floor(e.contentRect.width / 2));
      }
    });
    const border = new ResizeObserver(entries => {
      const line = `border ${entries
        .map(e => name(e.target, outer.current, inner.current, hidden.current))
        .join(' ')}`;
      setLog(l => [...l, line]);
    });
    if (outer.current && inner.current && hidden.current) {
      content.observe(outer.current);
      content.observe(inner.current);
      content.observe(hidden.current);
      border.observe(outer.current, { box: 'border-box' });
    }
    setObserver(content);
    return () => {
      content.disconnect();
      border.disconnect();
    };
  }, []);

  return (
    <div id="app">
      <div className="controls">
        <button id="wider" onClick={() => setWidth(w => w + 40)}>
          Wider
        </button>
        <button id="show" onClick={() => setShown(s => !s)}>
          Toggle hidden
        </button>
        <button
          id="unobserve"
          onClick={() => {
            if (outer.current && observer) observer.unobserve(outer.current);
          }}
        >
          Unobserve
        </button>
        <button
          id="observe"
          onClick={() => {
            if (outer.current && observer) observer.observe(outer.current);
          }}
        >
          Observe
        </button>
        <button
          id="disconnect"
          onClick={() => {
            if (observer) observer.disconnect();
          }}
        >
          Disconnect
        </button>
        <button id="clear" onClick={() => setLog([] as string[])}>
          Clear
        </button>
      </div>
      <div id="outer" ref={outer} style={{ width: `${width}px` }}>
        <div id="inner" ref={inner} style={{ width: `${innerWidth}px` }}></div>
      </div>
      <div id="hidden" ref={hidden} className={shown ? 'shown' : ''}></div>
      <ol id="log">
        {log.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>
    </div>
  );
}
