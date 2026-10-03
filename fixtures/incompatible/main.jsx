import React from 'react';
import {createRoot} from 'react-dom/client';
function sameImplementation(x,low,high) { return Math.min(Math.max(x,low),high); }
function App() { return <p>{sameImplementation(4,8,1)}</p>; }
createRoot(document.getElementById('root')).render(<App />);
