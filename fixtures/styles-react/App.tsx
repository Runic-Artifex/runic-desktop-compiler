import { useState } from 'react';

// Inline style objects as React DOM applies them (setValueForStyles): each
// key through the CSSOM in order, numbers in px unless unitless, custom
// properties with setProperty, null/undefined/booleans/'' removing; updates
// set only the keys whose value changed.
export function App() {
  const [color, setColor] = useState<string | undefined>('rgb(32, 80, 160)');
  const [width, setWidth] = useState(120);
  const [alt, setAlt] = useState(false);
  const [tone, setTone] = useState('#dfe7f0');
  const [dim, setDim] = useState(false);
  const [accent, setAccent] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const margin = alt ? undefined : 4;
  const padding = alt ? 2 : 6;

  return (
    <main>
      <div className="row">
        <button id="color" onClick={() => setColor(c => (c ? undefined : 'rgb(32, 80, 160)'))}>
          Color
        </button>
        <button id="wider" onClick={() => setWidth(width + 20)}>
          Wider
        </button>
        <button id="base" onClick={() => setAlt(!alt)}>
          Base
        </button>
        <button id="tone" onClick={() => setTone(tone === '#dfe7f0' ? '#f0e7df' : '#dfe7f0')}>
          Tone
        </button>
      </div>
      <div className="row">
        <button id="dim" onClick={() => setDim(!dim)}>
          Dim
        </button>
        <button id="accent" onClick={() => setAccent(a => (a === null ? ' #204080 ' : null))}>
          Accent
        </button>
        <button id="hide" onClick={() => setHidden(!hidden)}>
          Hide
        </button>
      </div>
      <p id="directive" style={{ color, width }}>
        Directive
      </p>
      <p id="text" style={{ margin, padding, color: alt ? 'green' : undefined }}>
        Text
      </p>
      <p id="both" style={{ border: '1px solid #52665b', backgroundColor: tone }}>
        Both
      </p>
      <p id="mixed" style={{ margin, padding, color }}>
        Mixed
      </p>
      <p id="static" style={{ color: 'RED' }}>
        Static
      </p>
      <p
        id="numbers"
        style={{
          opacity: dim ? 0.5 : 1,
          zIndex: dim ? 2 : 0,
          lineHeight: 1.5,
          marginTop: dim ? 0 : 8,
          letterSpacing: dim ? 0.5 : undefined,
          flexGrow: 1,
        }}
      >
        Numbers
      </p>
      <p
        id="custom"
        style={{ '--accent': accent, borderLeft: '4px solid var(--accent, #b7b7a9)', paddingLeft: 6 }}
      >
        Custom
      </p>
      <p id="removed" style={{ fontStyle: hidden ? null : 'italic', textDecoration: hidden ? '' : ' underline ', fontWeight: !hidden }}>
        Removed
      </p>
    </main>
  );
}
