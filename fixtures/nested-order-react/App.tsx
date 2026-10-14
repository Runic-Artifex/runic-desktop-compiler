// React runs every handler from its root; a listener script adds below the
// root, of a type known only at run time, may run in another order than
// Chromium's. The runtime and the interpreter report it alike, also for
// nested dispatches: requestSubmit and dispatchEvent from a listener (M6
// script DOM; the differential checks that both engines stop at the same
// step).
import { useEffect, useRef, useState } from 'react';

const TYPES: string[] = ['submit', 'click'];

export function App() {
  const [log, setLog] = useState('ready');
  const box = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLElement>(null);
  const other = useRef<HTMLButtonElement>(null);
  const note = (s: string) => setLog(l => (l === 'ready' ? s : l + ' ' + s).slice(-200));
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const f = () => note('script');
    for (const t of TYPES) el.addEventListener(t, f);
    return () => {
      for (const t of TYPES) el.removeEventListener(t, f);
    };
  }, []);
  return (
    <main>
      <section>
        <button id="count" type="button" onClick={() => note('count')}>
          Count
        </button>
        <button id="request" type="button" onClick={() => form.current?.requestSubmit()}>
          Request submission
        </button>
        <button
          id="dispatch"
          type="button"
          onClick={() => other.current?.dispatchEvent(new MouseEvent('click', { bubbles: true }))}
        >
          Dispatch click
        </button>
      </section>
      <div id="box" ref={box}>
        <form
          ref={form}
          onSubmit={e => {
            e.preventDefault();
            note('submit');
          }}
        >
        </form>
        <button id="other" ref={other} type="button" onClick={() => note('other')}>
          Other
        </button>
      </div>
      <p id="log">{log}</p>
    </main>
  );
}
