import { useRef, useState } from 'react';

// React's onFocus and onBlur come from focusin and focusout, so they bubble:
// the row's handlers see its children's focus changes.
export function App() {
  const [log, setLog] = useState<string[]>([]);
  const field = useRef<HTMLInputElement | null>(null);
  const add = (entry: string) => setLog(l => [...l, entry]);

  return (
    <main>
      <div className="row" onFocus={() => add('row-in')} onBlur={() => add('row-out')}>
        <button
          id="a"
          onFocus={() => add('a-focus')}
          onBlur={() => add('a-blur')}
          onClick={() => {
            add('a-click');
            field.current?.focus();
            add('a-after');
          }}
        >
          A
        </button>
        <input
          id="field"
          type="text"
          aria-label="Field"
          ref={field}
          onFocus={e => add(`field-focus ${e.relatedTarget !== null}`)}
          onBlur={() => add('field-blur')}
        />
        <div
          id="box"
          tabIndex={0}
          onFocus={() => add('box-focus')}
          onBlur={e => add(`box-blur ${e.relatedTarget === null}`)}
        >
          Box
        </div>
      </div>
      <p id="plain">Plain</p>
      <p id="log">{log.join(' ')}</p>
    </main>
  );
}
