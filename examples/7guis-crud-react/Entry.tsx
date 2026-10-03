import React from 'react';
import { display, type Person } from './people.ts';

interface EntryProps {
  person: Person;
  selected: boolean;
  onSelect: (id: number) => void;
}

export function Entry({ person, selected, onSelect }: EntryProps) {
  return (
    <li>
      <button
        id={`person-${person.id}`}
        className={selected ? 'selected' : undefined}
        aria-pressed={selected ? 'true' : 'false'}
        onClick={() => onSelect(person.id)}
      >
        {display(person)}
      </button>
    </li>
  );
}
