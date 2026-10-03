import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {advance as next, amount, ceiling, starting, heading} from './logic.ts';
import './style.css';
function App(){
 const [n,setN]=useState(starting);
 const [seen,setSeen]=useState(0);
 const [show,setShow]=useState(true);
 const initial=starting;
 const label=n;
 function increment(){setN(next(n,amount,ceiling));}
 function sequence(){setN(next(n,amount,ceiling));setSeen(n);}
 function reset(){setN(starting);setSeen(starting);}
 function toggle(){setShow(!show);}
 return <main><h1 id="heading">{heading}</h1><p id="value">{label}</p><p id="seen">{seen}</p><p id="initial">{initial}</p><p id="flag">{show?'true':'false'}</p><div className="controls"><button id="increment" disabled={n===ceiling} onClick={increment}>Increment</button><button id="sequence" onClick={sequence}>Sequence</button><button id="reset" onClick={reset}>Reset</button><button id="toggle" onClick={toggle}>Toggle</button></div>{show&&<p id="details">Visible</p>}</main>;
}
createRoot(document.getElementById('root')).render(<App/>);
