import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {progressStep as forward} from './progress.js';
import {Controls} from './Controls.jsx';
import './base.css';
import './theme.css';
function App() {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState('home');
  const [details, setDetails] = useState(false);
  function restart() { setStep(2); setStep(v => v - 2); setDetails(false); }
  const next = () => setStep(v => forward(v, 1, 3));
  const back = () => setStep(v => Math.max(v - 1, 0));
  return <article id="card" className="card">
    <p className="brand">RUNIC / SETTINGS</p><h1 id="heading">Setup assistant</h1>
    <h2 id="step">Step {step + 1} of 4</h2>
    <p id="profile">Profile: {profile}</p>
    <Controls back={back} next={next} choose={() => setProfile(profile === 'home' ? 'office' : 'home')} restart={restart} step={step}/>
    <button id="details" onClick={() => setDetails(v => !v)}>Show details</button>
    {details && <section id="detail-panel" className="note"><p id="detail-text">Selected profile: {profile}. Review at step {step + 1}.</p></section>}
    {step === 3 && <p id="complete" className="note">Ready to save your settings.</p>}
  </article>;
}
createRoot(document.getElementById('root')).render(<App/>);
