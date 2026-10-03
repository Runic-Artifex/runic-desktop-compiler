import React, { type ReactNode } from 'react';

interface CardProps {
  title: string;
  header?: (title: string) => ReactNode;
  children: ReactNode;
}

export function Card({ title, header, children }: CardProps) {
  return (
    <section id={`card-${title}`}>
      <h2>{header?.(title)}</h2>
      {children}
    </section>
  );
}
