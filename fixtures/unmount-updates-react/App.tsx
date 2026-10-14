import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Effect runs are logged into a plain module array and shown on Dump.
const log: string[] = [];

function Child({
  name,
  step,
  onGone,
  onLayoutGone,
}: {
  name: string;
  step: number;
  onGone: (name: string) => void;
  onLayoutGone: (name: string) => void;
}) {
  const [own, setOwn] = useState(0);
  const clicks = useRef(0);
  // A cleanup at unmount updates the parent's state (rendered later) and
  // its own (the component is gone: nothing renders); it reads the ref's
  // current value, not the one at the effect's run.
  useEffect(() => {
    return () => {
      log.push(`${name} cleanup ${clicks.current}`);
      onGone(name);
      setOwn(o => o + 1);
    };
  }, []);
  // A layout cleanup at unmount runs while React commits.
  useLayoutEffect(() => {
    return () => {
      log.push(`${name} layout cleanup`);
      onLayoutGone(name);
    };
  }, []);
  // A cleanup when a dependency changes updates the parent too.
  useEffect(() => {
    return () => {
      log.push(`${name} step cleanup ${step}`);
      onGone(`${name}${step}`);
    };
  }, [step]);
  function click() {
    clicks.current += 1;
    setOwn(own + 1);
  }
  return (
    <button id={`child-${name}`} onClick={click}>
      {name} {own}
    </button>
  );
}

export function App() {
  const [show, setShow] = useState(true);
  const [step, setStep] = useState(0);
  const [gone, setGone] = useState('');
  const [layoutGone, setLayoutGone] = useState('');
  const [shown, setShown] = useState('');
  useLayoutEffect(() => {
    log.push(`commit ${show ? 'shown' : 'hidden'} ${step} [${gone}] [${layoutGone}]`);
  });
  function dump() {
    setShown(log.join(' | '));
    log.splice(0, log.length);
  }
  return (
    <main>
      <h1 id="title">Unmount updates</h1>
      {show && (
        <div className="controls">
          <Child
            name="a"
            step={step}
            onGone={n => setGone(g => g + n)}
            onLayoutGone={n => setLayoutGone(g => g + n)}
          />
          <Child
            name="b"
            step={step}
            onGone={n => setGone(g => g + n)}
            onLayoutGone={n => setLayoutGone(g => g + n)}
          />
        </div>
      )}
      <p id="gone">
        [{gone}] [{layoutGone}]
      </p>
      <p id="log">{shown}</p>
      <div className="controls">
        <button id="toggle" onClick={() => setShow(!show)}>
          Toggle
        </button>
        <button id="step" onClick={() => setStep(step + 1)}>
          Step
        </button>
        <button id="dump" onClick={dump}>
          Dump
        </button>
      </div>
    </main>
  );
}
