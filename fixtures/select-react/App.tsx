import { useState } from 'react';

const units = ['day', 'hour', 'minute'];

export function App() {
  const [unit, setUnit] = useState('hour');
  const [kind, setKind] = useState('text');
  const [extra, setExtra] = useState(false);
  // A controlled value that nothing writes: React restores it after the change.
  const [fixed] = useState('b');
  const [log, setLog] = useState<string[]>([]);

  return (
    <main>
      <div className="row">
        <select id="unit" aria-label="Unit" value={unit} onChange={e => setUnit(e.target.value)}>
          {units.map(u => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
          {extra && <option value="week">week</option>}
        </select>
        <select
          id="kind"
          aria-label="Kind"
          value={kind}
          onChange={e => {
            const v = e.target.value;
            setKind(v);
            setLog(l => [...l, `kind:${v}`]);
          }}
        >
          <option value="text">Text</option>
          <option value="input" disabled>
            Input
          </option>
          <option value="markup">Semantic markup</option>
        </select>
        <select
          id="free"
          aria-label="Free"
          onChange={e => {
            const v = e.target.value;
            setLog(l => [...l, `free:${v}`]);
          }}
          onClick={() => setLog(l => [...l, 'free-click'])}
        >
          <option>Alpha</option>
          <option disabled>Off</option>
          <option>  Beta   gamma </option>
          <option>Gamma</option>
        </select>
        <select
          id="fixed"
          aria-label="Fixed"
          value={fixed}
          onChange={e => {
            const v = e.target.value;
            setLog(l => [...l, `fixed:${v}`]);
          }}
        >
          <option value="a">A</option>
          <option value="b">B</option>
          <option value="c">C</option>
        </select>
      </div>
      <div className="row">
        <button id="extra" onClick={() => setExtra(!extra)}>
          Extra
        </button>
        <button id="reset" onClick={() => setUnit('day')}>
          Reset
        </button>
        <button id="bad" onClick={() => setUnit('month')}>
          Bad
        </button>
      </div>
      <p id="state">
        {unit} {kind}
      </p>
      <p id="log">{log.join(' ')}</p>
    </main>
  );
}
