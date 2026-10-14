// stopPropagation in a capture listener ends the dispatch at its invocation
// (DOM standard: one per node and phase): the node's own bubbling
// listeners, and at the target its non-capture ones, do not run. The
// listeners here are ones script adds for `mousedown`, a kind with no React
// handler in the program (React's own order with them is a separate policy),
// at the container, the document and elements; a harness click and a script
// dispatchEvent take the same path.
import { useEffect, useRef, useState } from 'react';

export function App() {
  const [log, setLog] = useState('ready');
  const [mode, setMode] = useState('open');
  const modeRef = useRef('open');
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const note = (s: string) => setLog(l => (l === 'ready' ? s : l + ' ' + s).slice(-480));
  const select = (m: string) => {
    modeRef.current = m;
    setMode(m);
    setLog('ready');
  };
  useEffect(() => {
    const root = document.getElementById('root');
    const o = outer.current;
    const i = inner.current;
    const t = target.current;
    if (!root || !o || !i || !t) return;
    const rootCapture = (e: Event) => {
      if (e.target !== t) return;
      note('rc');
      if (modeRef.current === 'root-stop') e.stopPropagation();
    };
    const rootBubble = (e: Event) => {
      if (e.target !== t) return;
      note('rb');
    };
    const documentBubble = (e: Event) => {
      if (e.target !== t) return;
      note('d');
    };
    const outerCapture = (e: Event) => {
      note('oc');
      if (modeRef.current === 'outer-stop') e.stopPropagation();
      if (modeRef.current === 'outer-immediate') e.stopImmediatePropagation();
    };
    const outerCapture2 = () => note('oc2');
    const outerBubble = () => note('ob');
    const innerBubble = () => note('si');
    const targetCapture = (e: Event) => {
      note('tc');
      if (modeRef.current === 'target-stop') e.stopPropagation();
    };
    const targetCapture2 = () => note('tc2');
    const targetBubble = () => note('ts');
    root.addEventListener('mousedown', rootCapture, true);
    root.addEventListener('mousedown', rootBubble);
    document.addEventListener('mousedown', documentBubble);
    o.addEventListener('mousedown', outerCapture, true);
    o.addEventListener('mousedown', outerCapture2, true);
    o.addEventListener('mousedown', outerBubble);
    i.addEventListener('mousedown', innerBubble);
    // (The target's bubbling listener first: at the target capture
    // listeners still run before it.)
    t.addEventListener('mousedown', targetBubble);
    t.addEventListener('mousedown', targetCapture, true);
    t.addEventListener('mousedown', targetCapture2, true);
    return () => {
      root.removeEventListener('mousedown', rootCapture, true);
      root.removeEventListener('mousedown', rootBubble);
      document.removeEventListener('mousedown', documentBubble);
      o.removeEventListener('mousedown', outerCapture, true);
      o.removeEventListener('mousedown', outerCapture2, true);
      o.removeEventListener('mousedown', outerBubble);
      i.removeEventListener('mousedown', innerBubble);
      t.removeEventListener('mousedown', targetBubble);
      t.removeEventListener('mousedown', targetCapture, true);
      t.removeEventListener('mousedown', targetCapture2, true);
    };
  }, []);
  const nestedDispatch = () => {
    note('d<');
    target.current?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    note('>d');
  };
  return (
    <main>
      <section>
        <button id="mode-open" type="button" onClick={() => select('open')}>
          Open
        </button>
        <button id="mode-root-stop" type="button" onClick={() => select('root-stop')}>
          Stop at root
        </button>
        <button id="mode-outer-stop" type="button" onClick={() => select('outer-stop')}>
          Stop at outer
        </button>
        <button id="mode-outer-immediate" type="button" onClick={() => select('outer-immediate')}>
          Immediate at outer
        </button>
        <button id="mode-target-stop" type="button" onClick={() => select('target-stop')}>
          Stop at target
        </button>
        <button id="nested-dispatch" type="button" onClick={nestedDispatch}>
          Nested dispatch
        </button>
      </section>
      <div id="outer" ref={outer}>
        <section id="inner" ref={inner}>
          <div id="target" ref={target}>
            Target
          </div>
        </section>
      </div>
      <p id="mode">{mode}</p>
      <p id="log">{log}</p>
    </main>
  );
}
