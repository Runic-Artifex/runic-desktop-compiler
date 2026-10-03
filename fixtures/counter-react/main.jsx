import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
function App(){
 const [n,setN]=useState(1);const [seen,setSeen]=useState(0);const [observed,setObserved]=useState(0);const [show,setShow]=useState(true);
 const captured=n;
 function sequence(){setN(2);setN(v=>Math.min(v+1,3));setSeen(captured);setObserved(n);}
 return <main><h1 id="heading">Counter</h1><p id="value">{n}</p><p id="seen">{seen}</p><p id="observed">{observed}</p><p id="flag">{show}</p><button id="sequence" onClick={sequence}>Sequence</button><button id="increment" disabled={n===3} onClick={()=>setN(v=>Math.min(v+1,3))}>Increment</button><button id="toggle" onClick={()=>setShow(v=>!v)}>Toggle</button>{show&&<p id="details">Visible</p>}</main>;
}
createRoot(document.getElementById('root')).render(<App/>);
