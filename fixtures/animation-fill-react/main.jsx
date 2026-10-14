import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
function App() {
  const [marked, setMarked] = useState(false);
  const [unfilled, setUnfilled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [renamed, setRenamed] = useState(false);
  return (
    <main>
      <div className="controls">
        <button id="mark" onClick={() => setMarked(v => !v)}>Mark</button>
        <button id="unfill" onClick={() => setUnfilled(v => !v)}>Unfill</button>
        <button id="toggle" onClick={() => setHidden(v => !v)}>Hide</button>
        <button id="swap" onClick={() => setRenamed(v => !v)}>Rename</button>
      </div>
      <div id="rows" className={marked ? 'rows marked' : 'rows'}>
        <div id="row-fwd" className="row"><div id="fwd" className="box"></div></div>
        <div id="row-both" className="row"><div id="both" className="box"></div></div>
        <div id="row-alt" className="row"><div id="alt" className="box"></div></div>
        <div id="row-var" className="row"><div id="var" className="box"></div></div>
        <div id="row-unfilled" className="row"><div id="unfilled" className="box" style={{ animationFillMode: unfilled ? 'none' : 'forwards' }}></div></div>
        <div id="row-inline" className="row"><div id="inline" className="box" style={{ animationFillMode: 'both' }}></div></div>
        <div id="row-hide" className="row"><div id="hide" className={hidden ? 'box hidden' : 'box'}></div></div>
        <div id="row-rename" className="row"><div id="rename" className={renamed ? 'box renamed' : 'box'}></div></div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')).render(<App />);
