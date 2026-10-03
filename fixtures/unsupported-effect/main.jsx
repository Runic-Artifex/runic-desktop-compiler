import React, {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
function App() { useEffect(() => {document.title='Changed';},[]); return <p>Effect</p>; }
createRoot(document.getElementById('root')).render(<App />);
