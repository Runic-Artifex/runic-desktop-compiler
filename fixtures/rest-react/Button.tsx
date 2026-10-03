import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = {
  variant?: string;
  className?: string;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ variant = 'default', className = '', children, ...rest }: ButtonProps) {
  return (
    <button className={`btn ${variant} ${className}`.trim()} type="button" {...rest}>
      {children}
    </button>
  );
}
