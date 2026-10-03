import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
function Counter() {
  const [n, setN] = useState(0);
  return <main><p id="count">{n}</p><button id="increment" disabled={n === 3} onClick={() => setN(v => Math.min(v + 1, 3))}>Increment</button></main>;
}
createRoot(document.getElementById('root')).render(<Counter />);
