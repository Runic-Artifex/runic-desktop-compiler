import React, { useState as localState } from 'react';
import { Controls } from './Controls.jsx';
import { keepBetween } from './range.js';

export function Thermostat() {
  const [temperature, updateTemperature] = localState(20);
  const [eco, toggleEco] = localState(true);
  const cool = () => updateTemperature(t => keepBetween(t - 2, 16, 28));
  const warm = () => updateTemperature(t => keepBetween(t + 2, 16, 28));
  const comfort = temperature < 20 ? 'Cool' : temperature > 24 ? 'Warm' : 'Comfortable';
  return <article className={eco ? 'panel eco' : 'panel'}>
    <div className="brand">RUNIC / HOME</div>
    <h1>Thermostat</h1>
    <p id="temperature" className="readout">{temperature} C</p>
    <p id="comfort">{comfort}</p>
    <Controls cold={temperature === 16} hot={temperature === 28} decrease={cool} increase={warm} />
    <button id="eco" onClick={() => toggleEco(enabled => !enabled)}>{eco ? 'Disable eco' : 'Enable eco'}</button>
    {eco && <p id="eco-note" className="note">Eco mode is enabled.</p>}
  </article>;
}
