import { useState } from 'react';

export function App() {
  const [size, setSize] = useState('m');
  const [log, setLog] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);
  const pick = (v: string) => {
    setSize(v);
    setLog(l => [...l, v]);
  };

  return (
    <main>
      <div className="row">
        <button id="before">Before</button>
        <label id="s-label">
          <input
            id="s"
            type="radio"
            name="size"
            value="s"
            checked={size === 's'}
            onChange={() => pick('s')}
          />{' '}
          Small
        </label>
        <label id="m-label">
          <input
            id="m"
            type="radio"
            name="size"
            value="m"
            checked={size === 'm'}
            onChange={() => pick('m')}
          />{' '}
          Medium
        </label>
        <label id="l-label">
          <input
            id="l"
            type="radio"
            name="size"
            value="l"
            checked={size === 'l'}
            disabled
            onChange={() => pick('l')}
          />{' '}
          Large
        </label>
        <label id="xl-label">
          <input
            id="xl"
            type="radio"
            name="size"
            value="xl"
            checked={size === 'xl'}
            onClick={e => {
              if (locked) e.preventDefault();
            }}
            onChange={() => {}}
          />{' '}
          Extra
        </label>
      </div>
      <div className="row">
        <label id="f-label">
          <input
            id="f"
            type="radio"
            name="size"
            value="f"
            checked={size === 'f'}
            onChange={() => setLog(l => [...l, 'f'])}
          />{' '}
          Fixed
        </label>
        <button id="after">After</button>
        <button id="lock" onClick={() => setLocked(!locked)}>
          Lock
        </button>
        <button id="pick" onClick={() => setSize('s')}>
          Pick small
        </button>
      </div>
      <p id="state">
        {size} {String(locked)}
      </p>
      <p id="log">{log.join(' ')}</p>
    </main>
  );
}
