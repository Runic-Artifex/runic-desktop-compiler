import { useState } from 'react';
import type { HTMLAttributes } from 'react';

// React DOM's attribute rules for props spread onto an element: className
// becomes class, aria-* and data-* booleans are stringified, other attributes
// with boolean values are not set, known boolean attributes are present when
// truthy, numbers are stringified, null and undefined remove the attribute,
// and a later prop wins over an earlier one.
function Tag({ label, ...rest }: { label: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="tag" {...rest} data-pos="own">
      {label}
    </span>
  );
}

export function App() {
  const [on, setOn] = useState(false);
  const [n, setN] = useState(0);
  const title: string | undefined = on ? 'On' : undefined;
  const level: number | null = n > 0 ? n : null;
  return (
    <main>
      <p>
        <Tag
          id="tag"
          label="Tag"
          className={on ? 'tag on' : undefined}
          title={title}
          aria-pressed={on}
          data-on={on}
          data-flag
          lang={on}
          required={n}
          hidden={false}
          aria-level={level}
          data-n={n}
          data-pos={on ? 'rest' : 'rest2'}
        />
      </p>
      <div className="row">
        <button id="toggle" onClick={() => setOn(!on)}>
          Toggle
        </button>
        <button id="inc" onClick={() => setN(n + 1)}>
          Increment
        </button>
      </div>
    </main>
  );
}
