import type { ButtonHTMLAttributes } from 'react';
import { Button } from './Button.tsx';

type IconButtonProps = { label: string } & ButtonHTMLAttributes<HTMLButtonElement>;

export function IconButton({ label, ...rest }: IconButtonProps) {
  return (
    <Button variant="ghost" {...rest}>
      {label}
    </Button>
  );
}
