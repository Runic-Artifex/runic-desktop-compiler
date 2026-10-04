import { useEffect, useState } from 'react';

type Mode = 'system' | 'light' | 'dark';
const modes: Mode[] = ['system', 'light', 'dark'];
const palettes = ['runic', 'moss', 'fjord'];
const wide = matchMedia('(min-width: 600px)').matches;

export function App() {
  const [mode, setMode] = useState<Mode>('system');
  const [palette, setPalette] = useState('runic');
  const [accent, setAccent] = useState(false);

  function apply() {
    const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = mode === 'dark' || (mode === 'system' && systemDark);
    document.documentElement.dataset.reducedMotion = String(
      matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    if (accent) document.documentElement.style.setProperty('--desktop-accent', 'rgb(32 80 160)');
    else document.documentElement.style.removeProperty('--desktop-accent');
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.theme = palette;
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }

  useEffect(() => {
    apply();
  }, [mode, palette, accent]);

  return (
    <main>
      <h1 id="title">Appearance</h1>
      <div className="row">
        <button id="mode" onClick={() => setMode(modes[(modes.indexOf(mode) + 1) % modes.length])}>
          Mode
        </button>
        <button
          id="palette"
          onClick={() => setPalette(palettes[(palettes.indexOf(palette) + 1) % palettes.length])}
        >
          Palette
        </button>
        <button id="accent" onClick={() => setAccent(!accent)}>
          Accent
        </button>
      </div>
      <p id="state">
        {mode} {palette} {String(accent)} {String(wide)}
      </p>
    </main>
  );
}
