import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
function App() {
  const [moved, setMoved] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1 id="heading">Animations</h1>
      <div id="badges" className="badges"><span className="badge">New</span></div>
      <button id="tint" className="tint">Hover me</button>
      <div className="controls">
        <button id="move" onClick={() => setMoved(v => !v)}>Move</button>
        <button id="open" onClick={() => setOpen(v => !v)}>{open ? 'Close' : 'Open'}</button>
      </div>
      <div id="stage" className="stage"><div className={moved ? 'box moved' : 'box'}></div></div>
      <div id="loaders" className="row"><div className="spinner"></div><div className="pulse"></div></div>
      <div id="panels" className="panels">{open && <div className="panel">Panel content</div>}</div>
    </main>
  );
}
createRoot(document.getElementById('root')).render(<App />);
