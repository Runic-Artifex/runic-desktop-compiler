import { useState } from 'react';
import type { KeyboardEvent } from 'react';

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const [stop, setStop] = useState(false);
  const [locked, setLocked] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [text, setText] = useState('');
  const [hovers, setHovers] = useState(0);
  const [inside, setInside] = useState(false);
  const [doubles, setDoubles] = useState(0);
  const [menus, setMenus] = useState(0);
  const [closed, setClosed] = useState(false);
  const [later, setLater] = useState('');
  // React's wheel listener is passive (onWheel is unsupported): nothing scrolls the box.
  const scrolled = 0;

  function onKey(e: KeyboardEvent) {
    const entry = `${e.type}:${e.key}:${e.code}${e.shiftKey ? '+shift' : ''}${e.repeat ? '+repeat' : ''}`;
    setLog(l => [...l, entry]);
    if (e.key === 'x') e.preventDefault();
  }

  return (
    <main>
      <div
        id="outer"
        onClick={e => {
          setLog(l => [...l, 'outer']);
          if (e.target === e.currentTarget) setClosed(true);
        }}
      >
        <button
          id="inner"
          onClick={e => {
            setLog(l => [...l, 'inner']);
            if (stop) e.stopPropagation();
          }}
        >
          Inner
        </button>
      </div>
      <div className="row">
        <button id="stop" onClick={() => setStop(!stop)}>
          Stop: {String(stop)}
        </button>
        <button id="lock" onClick={() => setLocked(!locked)}>
          Locked: {String(locked)}
        </button>
        {/* React runs onChange even for a cancelled click, so the lock keeps the state instead. */}
        <input
          id="agree"
          type="checkbox"
          aria-label="Agree"
          checked={agreed}
          onChange={e => {
            if (!locked) setAgreed(e.target.checked);
          }}
        />
      </div>
      <div className="row">
        <input
          id="field"
          type="text"
          aria-label="Field"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKey}
          onKeyUp={onKey}
        />
        <button
          id="keep"
          onMouseDown={e => e.preventDefault()}
          onClick={() => setLog(l => [...l, 'keep'])}
        >
          Keep focus
        </button>
      </div>
      <div
        id="box"
        onPointerEnter={() => {
          setHovers(h => h + 1);
          setInside(true);
        }}
        onPointerLeave={() => setInside(false)}
        onDoubleClick={() => setDoubles(d => d + 1)}
        onContextMenu={e => {
          e.preventDefault();
          setMenus(m => m + 1);
        }}
      >
        Box {hovers} {String(inside)} {doubles} {menus} {scrolled}
      </div>
      <div className="row">
        <button
          id="late"
          onClick={e =>
            setTimeout(
              () => setLater(`${e.type} ${e.currentTarget === null} ${e.defaultPrevented}`),
              0,
            )
          }
        >
          Later
        </button>
        <button
          id="enter"
          onKeyDown={e => {
            if (e.key === 'Enter') e.preventDefault();
          }}
          onClick={() => setLog(l => [...l, 'enter-click'])}
        >
          No enter
        </button>
      </div>
      <p id="state">
        {String(closed)} {String(agreed)} {text} {later}
      </p>
      <p id="log">{log.join(' ')}</p>
    </main>
  );
}
