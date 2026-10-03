import React, { useState } from 'react';

export function Tally({ id }: { id: number }) {
  const [n, setN] = useState(0);
  return (
    <button id={`tally-${id}`} onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}
