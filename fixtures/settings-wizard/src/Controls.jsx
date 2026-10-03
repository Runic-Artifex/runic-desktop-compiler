import React from 'react';
export function Controls({back, next, choose, restart, step}) {
  return <div className="controls">
    <button id="back" disabled={step === 0} onClick={back}>Back</button>
    <button id="next" disabled={step === 3} onClick={next}>Next</button>
    <button id="choose" onClick={choose}>Switch profile</button>
    <button id="restart" onClick={restart}>Restart</button>
  </div>;
}
