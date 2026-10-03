import { useEffect, useRef, useState } from 'react';

export function App() {
  const [open, setOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const panel = useRef<HTMLDivElement | null>(null);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'k' && e.ctrlKey) {
      e.preventDefault();
      setShortcuts(shortcuts + 1);
    }
    if (e.key === 'Escape') setOpen(false);
    const entry = `window:${e.key}`;
    setLog(l => [...l, entry]);
  }

  // Keyboard shortcuts: a window listener, added again with the count it reads
  // (the cleanup removes the function object the effect added).
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcuts]);

  useEffect(() => {
    const onDocument = () => setLog(l => [...l, 'document']);
    document.addEventListener('click', onDocument);
    return () => document.removeEventListener('click', onDocument);
  }, []);

  // Click outside: a document listener while the panel is open.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (e.target !== panel.current) {
        setOpen(false);
        setLog(l => [...l, 'outside']);
      }
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <main>
      <div className="row">
        <button
          id="open"
          onClick={e => {
            e.stopPropagation();
            setOpen(true);
            setLog(l => [...l, 'open']);
          }}
        >
          Open
        </button>
        <button
          id="open-late"
          onClick={() => {
            setOpen(true);
            setLog(l => [...l, 'open-late']);
          }}
        >
          Open late
        </button>
      </div>
      {open && (
        <div id="panel" ref={panel}>
          Panel
        </div>
      )}
      <div className="row">
        <input
          id="field"
          type="text"
          aria-label="Field"
          onKeyDown={e => {
            if (e.key === 'q') e.stopPropagation();
          }}
        />
      </div>
      <p id="state">
        {String(open)} {shortcuts}
      </p>
      <p id="log">{log.join(' ')}</p>
    </main>
  );
}
