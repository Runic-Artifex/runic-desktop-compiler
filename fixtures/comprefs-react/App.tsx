import { useEffect, useRef, useState } from 'react';
import { Field } from './Field.tsx';

export function App() {
  const field = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');
  const [shown, setShown] = useState(true);
  // React does not re-render for refs: an effect reports what the ref holds
  // after each commit that mounts or unmounts the field.
  const [held, setHeld] = useState('none');
  useEffect(() => {
    setHeld(field.current ? 'ref' : 'none');
  }, [shown]);
  return (
    <main>
      {shown && (
        <div className="row">
          <Field ref={field} value={name} onValue={setName} id="name" aria-label="Name" />
        </div>
      )}
      <div className="row">
        <button id="focus" onClick={() => field.current?.focus()}>
          Focus
        </button>
        <button id="toggle" onClick={() => setShown(!shown)}>
          Toggle
        </button>
      </div>
      <p id="state">
        {held} {name}
      </p>
    </main>
  );
}
