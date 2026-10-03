import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {limitIncrease} from './advance.js';
import {Price} from './Price.jsx';
import './base.css';
import './theme.css';
const App = () => {
  const [quantity, setQuantity] = useState(1);
  const [plan, setPlan] = useState('basic');
  const [annual, setAnnual] = useState(false);
  const unit = plan === 'basic' ? 10 : plan === 'pro' ? 20 : 30;
  const total = quantity * (annual ? unit - 2 : unit);
  const reset = () => { setQuantity(1); setQuantity(v => v + 1); setAnnual(false); };
  return <main id="card" className="card">
    <p className="brand">RUNIC / PRICING</p><h1 id="heading">Configure your plan</h1>
    <p id="selection">{quantity} seats, {annual ? 'annual billing' : 'monthly billing'}</p>
    <Price total={total} plan={plan}/>
    <div className="controls">
      <button id="less" disabled={quantity === 1} onClick={() => setQuantity(v => Math.max(v - 1, 1))}>Less</button>
      <button id="more" disabled={quantity === 6} onClick={() => setQuantity(v => limitIncrease(v, 1, 6))}>More</button>
      <button id="plan" onClick={() => setPlan(plan === 'basic' ? 'pro' : plan === 'pro' ? 'team' : 'basic')}>Change plan</button>
      <button id="billing" onClick={() => setAnnual(v => !v)}>Toggle billing</button>
      <button id="reset" onClick={reset}>Reset to two</button>
    </div>
    {plan === 'team' && <p id="team-note" className="note">Team includes shared workspaces.</p>}
  </main>;
};
createRoot(document.getElementById('root')).render(<App/>);
