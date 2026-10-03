import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
function App(){
 const[text,setText]=useState('');const[locked,setLocked]=useState(false);const[readonly,setReadonly]=useState(false);const[show,setShow]=useState(true);
 return <main><h1 id="heading">Native text editor</h1><input id="editor" aria-label="Text" type="text" maxLength={256} value={text} disabled={locked} readOnly={readonly} onChange={event=>setText(event.target.value)}/><p id="preview">{text}</p><p id="count">{text.length}</p><button id="clear" disabled={text===''} onClick={()=>setText('')}>Clear</button><button id="lock" onClick={()=>setLocked(v=>!v)}>Lock</button><button id="readonly" onClick={()=>setReadonly(v=>!v)}>Read only</button><button id="toggle" onClick={()=>setShow(v=>!v)}>Toggle details</button>{show&&<p id="details">Stable editor identity</p>}</main>;
}
createRoot(document.getElementById('root')).render(<App/>);
