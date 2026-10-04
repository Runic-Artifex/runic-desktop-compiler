import { useState } from 'react';

export function App() {
  const [notes, setNotes] = useState('one\ntwo');
  const [agreed, setAgreed] = useState(false);
  const [name, setName] = useState('');
  const lines = notes.split('\n').length;
  // Controlled values that nothing writes: React restores them after every
  // event (the handlers keep React from warning about read-only fields).
  const [frozen] = useState(false);
  const [fixed] = useState('fixed');
  const [other, setOther] = useState(0);

  return (
    <main>
      <div className="row">
        <label id="notes-label" htmlFor="notes">
          Notes
        </label>
      </div>
      <div className="row">
        <textarea id="notes" value={notes} onChange={e => setNotes(e.target.value)} />
      </div>
      <p id="lines">{lines} lines</p>
      <div className="row">
        <label id="agree-label">
          <input
            id="agree"
            type="checkbox"
            checked={agreed}
            onChange={e => setAgreed(e.target.checked)}
          />{' '}
          I agree
        </label>
      </div>
      <div className="row">
        <label id="name-label">
          Name <input id="name" type="text" value={name} onChange={e => setName(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <input id="frozen" type="checkbox" aria-label="Frozen" checked={frozen} onChange={() => {}} />
        <input id="fixed" type="text" aria-label="Fixed" value={fixed} onChange={() => {}} />
        <button id="other" onClick={() => setOther(other + 1)}>
          Other {other}
        </button>
      </div>
      <p id="state">
        {String(agreed)} {name}
      </p>
    </main>
  );
}
