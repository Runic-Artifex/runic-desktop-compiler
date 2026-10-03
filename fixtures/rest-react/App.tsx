import { useState } from 'react';
import { Button } from './Button.tsx';
import { IconButton } from './IconButton.tsx';

export function App() {
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState<string | undefined>('First');
  const [log, setLog] = useState<string[]>([]);
  return (
    <main>
      <div className="row">
        <Button id="inc" onClick={() => setCount(c => c + 1)} aria-label="Increment" title={title}>
          Add
        </Button>
        <Button
          id="toggle"
          variant="outline"
          className="wide"
          onClick={() => {
            const next: string | undefined = busy ? 'Second' : undefined;
            setBusy(!busy);
            setTitle(next);
          }}
        >
          Toggle
        </Button>
        <IconButton
          id="icon"
          label="Icon"
          disabled={busy}
          data-count={count}
          onClick={e => {
            const type = e.type;
            setLog(l => [...l, type]);
          }}
          onPointerEnter={() => setLog(l => [...l, 'enter'])}
        />
      </div>
      <p id="state">
        {count} {String(busy)}
      </p>
      <p id="log">{log.join(' ')}</p>
    </main>
  );
}
