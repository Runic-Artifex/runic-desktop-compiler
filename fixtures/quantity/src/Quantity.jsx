import React, { useState } from 'react';
import { constrain } from './bounds.js';
import { Heading } from './Heading.jsx';

export function Quantity() {
  const [quantity, setQuantity] = useState(2);
  const [details, setDetails] = useState(false);
  const label = quantity === 1 ? 'item' : 'items';
  const total = quantity * 7;
  function addPair() {
    setQuantity(previous => constrain(previous + 1, 1, 8));
    setQuantity(previous => constrain(previous + 1, 1, 8));
  }
  return <main className="card">
    <Heading />
    <p className="eyebrow">YOUR ORDER</p>
    <h1>Quantity picker</h1>
    <p id="readout" className={quantity === 8 ? 'readout limit' : 'readout'}>{quantity} {label}</p>
    <div className="controls">
      <button id="minus" disabled={quantity === 1} onClick={() => setQuantity(n => constrain(n - 1, 1, 8))}>Remove</button>
      <button id="plus" disabled={quantity === 8} onClick={() => setQuantity(n => constrain(n + 1, 1, 8))}>Add</button>
      <button id="pair" disabled={quantity === 8} onClick={addPair}>Add two</button>
    </div>
    <p id="total">Total: {total} EUR</p>
    <button id="details" onClick={() => setDetails(shown => !shown)}>{details ? 'Hide details' : 'Show details'}</button>
    {details && <p id="note" className="note">Each item costs 7 EUR. Maximum 8 items.</p>}
  </main>;
}
