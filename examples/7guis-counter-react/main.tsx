import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Counter</h1>
      <div className="row">
        <input id="value" type="text" readOnly value={count} />
        <button id="count" onClick={() => setCount(c => c + 1)}>
          Count
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
