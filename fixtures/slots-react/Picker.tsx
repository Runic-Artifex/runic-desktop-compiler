import React, { useState, type ReactNode } from 'react';

interface Item {
  id: number;
  name: string;
}

interface PickerProps {
  items: Item[];
  row: (item: Item, first: boolean) => ReactNode;
}

export function Picker({ items, row }: PickerProps) {
  const [descending, setDescending] = useState(false);
  const shown = descending ? items.toReversed() : items;
  return (
    <>
      <ul>
        {shown.map((item, i) => (
          <li key={item.id}>{row(item, i === 0)}</li>
        ))}
      </ul>
      <button id="order" onClick={() => setDescending(!descending)}>
        {descending ? 'Ascending' : 'Descending'}
      </button>
    </>
  );
}
