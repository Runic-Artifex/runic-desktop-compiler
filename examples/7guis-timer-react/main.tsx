import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const segments = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function App() {
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(5000);
  // The tick reads this render's duration, so a new duration restarts the
  // interval; the cleanup clears the previous one.
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(e => (e < duration ? Math.min(e + 100, duration) : e));
    }, 100);
    return () => clearInterval(id);
  }, [duration]);
  return (
    <main>
      <h1>Timer</h1>
      <div className="row">
        <span>Elapsed time:</span>
        <div id="gauge" className="gauge">
          {segments.map(i => (
            <div
              key={i}
              className={elapsed * 10 >= (i + 1) * duration ? 'segment on' : 'segment'}
            ></div>
          ))}
        </div>
      </div>
      <p id="elapsed">{(elapsed / 1000).toFixed(1)}s</p>
      <div className="row">
        <span>Duration:</span>
        <button id="shorter" onClick={() => setDuration(d => Math.max(1000, d - 1000))}>
          −1s
        </button>
        <span id="duration">{duration / 1000}s</span>
        <button id="longer" onClick={() => setDuration(d => d + 1000)}>
          +1s
        </button>
      </div>
      <div className="row">
        <button id="reset" onClick={() => setElapsed(0)}>
          Reset
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
