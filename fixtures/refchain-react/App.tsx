import { useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes, RefObject } from 'react';

type InputProps = { ref?: RefObject<HTMLInputElement | null> } & InputHTMLAttributes<HTMLInputElement>;

function Input({ ref, ...rest }: InputProps) {
  return <input ref={ref} type="text" {...rest} />;
}

// A ref passed on through two components: React 19 passes ref as a prop.
function Labeled({ ref, label, ...rest }: InputProps & { label: string }) {
  return (
    <div className="row">
      <span>{label}</span>
      <Input ref={ref} {...rest} />
    </div>
  );
}

export function App() {
  const field = useRef<HTMLInputElement | null>(null);
  const [shown, setShown] = useState(true);
  const [held, setHeld] = useState('none');
  useEffect(() => {
    setHeld(field.current ? 'ref' : 'none');
  }, [shown]);
  return (
    <main>
      {shown && <Labeled ref={field} label="Name" id="name" aria-label="Name" />}
      <div className="row">
        <button id="focus" onClick={() => field.current?.focus()}>
          Focus
        </button>
        <button id="toggle" onClick={() => setShown(!shown)}>
          Toggle
        </button>
      </div>
      <p id="state">{held}</p>
    </main>
  );
}
