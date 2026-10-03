import React, { useState } from 'react';

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function Editor({ value, onChange }: EditorProps) {
  const [edits, setEdits] = useState(0);
  return (
    <>
      <p>
        <input
          id="name"
          aria-label="Name"
          type="text"
          value={value}
          onChange={e => {
            setEdits(edits + 1);
            onChange(e.target.value);
          }}
        />
      </p>
      <p id="edits">Edits: {edits}</p>
    </>
  );
}
