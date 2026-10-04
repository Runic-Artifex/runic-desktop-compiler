import { useState } from 'react';

export function App() {
  const [warm, setWarm] = useState(false);
  const [done, setDone] = useState(false);
  const [weight, setWeight] = useState(2);
  const [size, setSize] = useState(24);
  const [dots, setDots] = useState([6, 12]);

  return (
    <main>
      <h1 id="title">Icons</h1>
      <div className="row">
        <button id="tone" onClick={() => setWarm(!warm)}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          Tone
        </button>
        <button id="done" onClick={() => setDone(!done)}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {done ? (
              <path d="M20 6 9 17l-5-5" />
            ) : (
              <>
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </>
            )}
          </svg>
          Done
        </button>
        <button id="weight" onClick={() => setWeight(weight === 2 ? 3 : 2)}>
          Weight
        </button>
        <button id="size" onClick={() => setSize(size === 24 ? 32 : 24)}>
          Size
        </button>
        <button id="dot" onClick={() => setDots([...dots, 18])}>
          Dot
        </button>
      </div>
      <div id="palette" className={warm ? 'row warm' : 'row'}>
        <svg
          id="panel"
          xmlns="http://www.w3.org/2000/svg"
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={weight}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path className="accent" stroke="currentColor" d="M9 3v18" />
        </svg>
        <svg
          id="alert"
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" x2="12" y1="8" y2="12" /> <line x1="12" x2="12.01" y1="16" y2="16" />
        </svg>
        <svg
          id="star"
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="currentColor"
          fillOpacity="0.6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="miter"
          strokeMiterlimit="8"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        <svg
          id="pulse"
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="square"
          strokeLinejoin="bevel"
        >
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <svg
          id="frame"
          className="big"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="currentColor"
          fillRule="evenodd"
        >
          <path d="M2 2h20v20H2z M7 7h10v10H7z" />
        </svg>
      </div>
      <div className="row">
        <svg id="dots" width="48" height="24" viewBox="0 0 24 12" fill="#52665b" stroke="none">
          <ellipse
            cx="12"
            cy="6"
            rx="11"
            ry="5"
            fill="none"
            stroke="#b7b7a9"
            strokeWidth="1"
            strokeDasharray="2 1"
            strokeDashoffset="1"
          />
          {dots.map((x, i) => (
            <circle key={i} cx={x} cy="6" r="2" />
          ))}
        </svg>
        <svg
          id="spin"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#a0452a"
          strokeWidth="2"
          strokeLinecap="round"
          strokeOpacity="0.8"
        >
          <g transform="rotate(45 12 12)" opacity="0.5">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </g>
        </svg>
      </div>
      <p id="state">
        {String(warm)} {String(done)} {weight} {size} {dots.length}
      </p>
    </main>
  );
}
