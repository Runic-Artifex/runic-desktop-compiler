import React from 'react';
export function Controls({ cold, hot, decrease, increase }) {
  return <section className="controls">
    <button id="cool" onClick={decrease} disabled={cold}>Cooler</button>
    <button id="warm" onClick={increase} disabled={hot}>Warmer</button>
  </section>;
}
