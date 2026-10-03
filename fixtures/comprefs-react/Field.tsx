import type { InputHTMLAttributes, RefObject } from 'react';

type FieldProps = {
  ref?: RefObject<HTMLInputElement | null>;
  value: string;
  onValue: (value: string) => void;
} & InputHTMLAttributes<HTMLInputElement>;

// React 19 passes ref to function components as an ordinary prop.
export function Field({ ref, value, onValue, ...rest }: FieldProps) {
  return (
    <input ref={ref} value={value} onChange={e => onValue(e.target.value)} type="text" {...rest} />
  );
}
