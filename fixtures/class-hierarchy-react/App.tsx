import { useState } from 'react';
import { MultipleSelection, Selection, type AnySelection, type Item } from './selection.ts';

const items: Item[] = [
  { value: 'b', label: 'Bold' },
  { value: 'i', label: 'Italic' },
  { value: 'u', label: 'Underline' },
];

function ToggleGroup({
  type,
  name,
  items,
}: {
  type: 'single' | 'multiple';
  name: string;
  items: Item[];
}) {
  // The selection class is chosen by the `type` prop.
  const [selection, setSelection] = useState<AnySelection>(Selection.create(type, name, items));
  // The same instance through its base class.
  const base: Selection = selection;
  return (
    <section id={`${name}-group`}>
      <h2>{name}</h2>
      <div className="items">
        {items.map(item => (
          <button
            key={item.value}
            id={`${name}-${item.value}`}
            className={selection.isPressed(item.value) ? 'on' : 'off'}
            aria-pressed={selection.isPressed(item.value) ? 'true' : 'false'}
            onClick={() => setSelection(selection.toggled(item.value))}
          >
            {item.label}
          </button>
        ))}
        <button id={`${name}-clear`} onClick={() => setSelection(base.cleared())}>
          clear
        </button>
      </div>
      <p id={`${name}-summary`}>{base.summary}</p>
      <p id={`${name}-detail`}>
        {selection.kind === 'single'
          ? `value=${selection.value || '-'}`
          : `values=${selection.values.join('+') || '-'}`}
      </p>
      <p id={`${name}-count`}>
        {selection.pressedCount} pressed, {base.presses} presses,{' '}
        {selection instanceof MultipleSelection ? 'multiple' : 'single'}
      </p>
    </section>
  );
}

export function App() {
  return (
    <main>
      <h1>Class hierarchy</h1>
      <ToggleGroup type="single" name="align" items={items} />
      <ToggleGroup type="multiple" name="format" items={items} />
    </main>
  );
}
