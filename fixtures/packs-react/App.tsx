import { useState } from 'react';
import clsx from 'clsx';
import { clsx as cx } from 'clsx';

const label = (on: boolean) => (on ? 'label on' : 'label');
const nextTone = (t: string | null): string | null => (t === null ? 'warm' : null);

export function App() {
  const [active, setActive] = useState(false);
  const [size, setSize] = useState(16);
  const [tone, setTone] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [tags, setTags] = useState(['one', '', 'two']);

  return (
    <main>
      <h1 id="title">Packs</h1>
      <div className="row">
        <button id="toggle" onClick={() => setActive(!active)}>
          Toggle
        </button>
        <button id="grow" className={cx(size === 24 && 'grown')} onClick={() => setSize(size === 16 ? 24 : 16)}>
          Grow
        </button>
        <button id="tone" onClick={() => setTone(nextTone(tone))}>
          Tone
        </button>
        <button id="count" onClick={() => setCount(count + 1)}>
          Count
        </button>
        <button id="tags" onClick={() => setTags(active ? [] : [...tags, 'three'])}>
          Tags
        </button>
      </div>
      <div
        id="box"
        className={clsx(
          'box',
          active && 'active',
          { muted: !active, 'is-on': active, 2: count > 1 },
          tone,
          ['pad', active ? 'wide' : null, [count && 'counted', false]],
          count,
          tags,
        )}
      >
        Box
      </div>
      <p id="spaced" className={cx('  spaced ', active ? 'x' : '', tone ?? 'plain')}>
        {cx(label(active), tone || 'none', count)}
      </p>
    </main>
  );
}
