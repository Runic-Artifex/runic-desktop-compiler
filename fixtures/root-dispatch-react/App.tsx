// React 19 runs its handlers from listeners of its own at the container,
// added by createRoot before the first render (IR schedule.rootDispatch): at
// the root's capture listener the onXCapture handlers on the path, root
// down; at its bubbling listener the onX handlers, target up; each phase's
// as one callback with a synthetic event of its own. Listeners script adds
// below the root run between the two; those it adds at the container after
// createRoot run after React's in each phase. A synthetic stopPropagation
// ends the rest of React's handlers of that phase and the native
// propagation after the container's invocation; a native one below the root
// keeps React's bubbling handlers from running. A checkbox's onChange runs
// with the click, after its onClick handlers, with an event of its own.
// Nested click() and dispatchEvent take the same path; a script click at a
// disabled button skips its onClick (React's shouldPreventMouseEvent). The
// trace is written to the DOM directly, not to React state: a render during
// the click of the controlled checkbox would make React re-apply its value
// and skip onChange (reported unsupported, docs/gaps/PLATFORM.md).
import { useEffect, useRef, useState } from 'react';

export function App() {
  const [mode, setMode] = useState('open');
  const [checked, setChecked] = useState(false);
  const modeRef = useRef('open');
  const outer = useRef<HTMLElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLElement>(null);
  const dis = useRef<HTMLButtonElement>(null);
  const trace = useRef<HTMLParagraphElement>(null);
  const note = (s: string) => {
    const t = trace.current;
    if (t) t.textContent = t.textContent === 'ready' ? s : (t.textContent + ' ' + s).slice(-160);
  };
  const select = (m: string) => {
    modeRef.current = m;
    setMode(m);
    if (trace.current) trace.current.textContent = 'ready';
  };
  useEffect(() => {
    if (trace.current) trace.current.textContent = 'ready';
    const root = document.getElementById('root');
    const o = outer.current;
    const t = target.current;
    const b = box.current;
    const f = form.current;
    const d = dis.current;
    if (!root || !o || !t || !b || !f || !d) return;
    const inside = (e: Event) => e.target instanceof Node && o.contains(e.target);
    const rootCapture = (e: Event) => {
      if (inside(e)) note('Rc');
    };
    const rootBubble = (e: Event) => {
      if (inside(e)) note('Rb');
    };
    const documentBubble = (e: Event) => {
      if (inside(e)) note('D');
    };
    const windowCapture = (e: Event) => {
      if (inside(e)) note('Wc');
    };
    const outerCapture = () => note('Oc');
    const outerBubble = () => note('Ob');
    const targetCapture = (e: Event) => {
      note('Tc');
      if (modeRef.current === 'Tc-stop') e.stopPropagation();
    };
    const targetBubble = (e: Event) => {
      note('Tb');
      if (modeRef.current === 'Tb-stop') e.stopPropagation();
    };
    const boxClick = () => note('Bclick');
    const boxChange = () => note('Bchange');
    const formSubmit = () => note('Fs');
    const disClick = () => note('Xclick');
    root.addEventListener('click', rootCapture, true);
    root.addEventListener('click', rootBubble);
    document.addEventListener('click', documentBubble);
    window.addEventListener('click', windowCapture, true);
    o.addEventListener('click', outerCapture, true);
    o.addEventListener('click', outerBubble);
    t.addEventListener('click', targetCapture, true);
    t.addEventListener('click', targetBubble);
    b.addEventListener('click', boxClick);
    b.addEventListener('change', boxChange);
    f.addEventListener('submit', formSubmit);
    d.addEventListener('click', disClick);
    return () => {
      root.removeEventListener('click', rootCapture, true);
      root.removeEventListener('click', rootBubble);
      document.removeEventListener('click', documentBubble);
      window.removeEventListener('click', windowCapture, true);
      o.removeEventListener('click', outerCapture, true);
      o.removeEventListener('click', outerBubble);
      t.removeEventListener('click', targetCapture, true);
      t.removeEventListener('click', targetBubble);
      b.removeEventListener('click', boxClick);
      b.removeEventListener('change', boxChange);
      f.removeEventListener('submit', formSubmit);
      d.removeEventListener('click', disClick);
    };
  }, []);
  const nestedClick = () => {
    note('n<');
    target.current?.click();
    note('>n');
  };
  const nestedDispatch = () => {
    note('d<');
    target.current?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    note('>d');
  };
  const disabledDispatch = () => {
    note('x<');
    dis.current?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    note('>x');
  };
  return (
    <main>
      <section className="modes">
        <button id="mode-open" type="button" onClick={() => select('open')}>
          Open
        </button>
        <button id="mode-tb-stop" type="button" onClick={() => select('Tb-stop')}>
          Tb
        </button>
        <button id="mode-tc-stop" type="button" onClick={() => select('Tc-stop')}>
          Tc
        </button>
        <button id="mode-roc-stop" type="button" onClick={() => select('rOc-stop')}>
          rOc
        </button>
        <button id="mode-rtb-stop" type="button" onClick={() => select('rTb-stop')}>
          rTb
        </button>
        <button id="nested-click" type="button" onClick={nestedClick}>
          n
        </button>
        <button id="nested-dispatch" type="button" onClick={nestedDispatch}>
          d
        </button>
      </section>
      <section
        id="outer"
        ref={outer}
        onClickCapture={e => {
          note('rOc');
          // (React's stopPropagation: the rest of its capture handlers and the
          // native propagation after the container's invocation.)
          if (modeRef.current === 'rOc-stop') e.stopPropagation();
        }}
        onClick={() => note('rOb')}
      >
        <div
          id="target"
          ref={target}
          onClickCapture={() => note('rTc')}
          onClick={e => {
            note('rTb');
            if (modeRef.current === 'rTb-stop') e.stopPropagation();
          }}
        >
          Target
        </div>
        <label>
          <input
            id="box"
            ref={box}
            type="checkbox"
            checked={checked}
            onClick={e => {
              note('rBclick');
              if (modeRef.current === 'rTb-stop') e.stopPropagation();
            }}
            onChange={() => {
              note('rBchange');
              setChecked(c => !c);
            }}
          />
          Box
        </label>
        <form
          id="form"
          ref={form}
          onSubmit={e => {
            e.preventDefault();
            note('rFs');
          }}
        >
          <button id="submit" type="submit">
            Submit
          </button>
        </form>
        <button id="dis" ref={dis} type="button" disabled onClick={() => note('rXclick')}>
          X
        </button>
      </section>
      <section className="modes">
        <button id="disabled-dispatch" type="button" onClick={disabledDispatch}>
          x
        </button>
      </section>
      <p id="mode">{mode}</p>
      <p id="log" ref={trace} />
    </main>
  );
}
