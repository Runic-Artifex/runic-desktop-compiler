import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const format = (n: number): string => String(Math.round(n * 100) / 100);

function App() {
  const [celsius, setCelsius] = useState('');
  const [fahrenheit, setFahrenheit] = useState('');

  function fromCelsius(text: string) {
    setCelsius(text);
    const value = Number(text);
    if (text.trim() !== '' && !Number.isNaN(value)) setFahrenheit(format((value * 9) / 5 + 32));
  }

  function fromFahrenheit(text: string) {
    setFahrenheit(text);
    const value = Number(text);
    if (text.trim() !== '' && !Number.isNaN(value)) setCelsius(format(((value - 32) * 5) / 9));
  }

  return (
    <main>
      <h1>Temperature Converter</h1>
      <div className="row">
        <input id="celsius" type="text" value={celsius} onChange={e => fromCelsius(e.target.value)} />
        <span>Celsius =</span>
        <input id="fahrenheit" type="text" value={fahrenheit} onChange={e => fromFahrenheit(e.target.value)} />
        <span>Fahrenheit</span>
      </div>
      <p id="status">{celsius.trim() === '' ? 'Enter a temperature' : `${celsius} °C is ${fahrenheit} °F`}</p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
