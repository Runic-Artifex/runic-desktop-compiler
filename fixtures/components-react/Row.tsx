import React, { useState } from 'react';

interface RowProps {
  id: number;
  label: string;
  first: boolean;
  onRemove: (id: number) => void;
  onUp: (id: number) => void;
}

export function Row({ id, label, first, onRemove, onUp }: RowProps) {
  const [clicks, setClicks] = useState(0);
  return (
    <li id={`row-${id}`}>
      <span id={`label-${id}`}>
        {label} ({clicks})
      </span>
      <button id={`count-${id}`} onClick={() => setClicks(clicks + 1)}>
        +1
      </button>
      <button id={`up-${id}`} disabled={first} onClick={() => onUp(id)}>
        Up
      </button>
      <button id={`remove-${id}`} onClick={() => onRemove(id)}>
        Remove
      </button>
    </li>
  );
}
