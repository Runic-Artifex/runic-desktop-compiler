import { useRef, useState } from 'react';

export function App() {
  const input = useRef<HTMLInputElement>(null);
  const details = useRef<HTMLButtonElement | null>(null);
  const [text, setText] = useState('');
  const [show, setShow] = useState(true);
  const [status, setStatus] = useState('unchecked');
  function check() {
    setStatus(details.current === null ? 'details gone' : 'details mounted');
  }
  return (
    <main>
      <h1 id="title">Refs</h1>
      <p>
        <input
          id="field"
          aria-label="Field"
          type="text"
          ref={input}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') input.current!.blur();
          }}
        />
      </p>
      <p id="echo">Text: {text}</p>
      <div className="controls">
        <button id="focus" onClick={() => input.current?.focus()}>
          Focus field
        </button>
        <button id="toggle" onClick={() => setShow(!show)}>
          Toggle
        </button>
        <button id="check" onClick={check}>
          Check
        </button>
        <button
          id="focus-details"
          onClick={() => {
            if (details.current) details.current.focus();
          }}
        >
          Focus details
        </button>
        <button
          id="hide-focus"
          onClick={() => {
            setShow(false);
            details.current?.focus();
          }}
        >
          Hide and focus
        </button>
      </div>
      {show && (
        <p>
          <button id="details" ref={details}>
            Details
          </button>
        </p>
      )}
      <p id="status">{status}</p>
    </main>
  );
}
