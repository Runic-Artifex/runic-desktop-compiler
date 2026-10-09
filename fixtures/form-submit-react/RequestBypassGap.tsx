import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

// Diagnostic reduction, intentionally not imported by the pass fixture entry.
// A physical default-button activation bypasses required validation. A no-arg
// requestSubmit must validate independently of that button's formNoValidate.
export function App() {
  const form = useRef<HTMLElement | null>(null);
  const [log, setLog] = useState('ready');
  function note(s: string) {
    setLog(l => (l === 'ready' ? s : l + ' ' + s).slice(-512));
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    note('submit');
  }
  function request() {
    note('before');
    form.current?.requestSubmit();
    note('after');
  }
  return (
    <main>
      <form id="gap-form" ref={form} onSubmit={submit}>
        <input id="gap-field" type="text" aria-label="Required field" required />
        <button id="gap-default" type="submit" formNoValidate>
          Bypass only for this button
        </button>
      </form>
      <button id="gap-request" type="button" onClick={request}>
        Request without submitter
      </button>
      <p id="log">{log}</p>
    </main>
  );
}
