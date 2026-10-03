// Minimal React declarations for type analysis (React 19 ships no types in
// this repository's dependency set). Only the API the adapter lowers.
declare module 'react' {
  type SetState<S> = (value: S | ((previous: S) => S)) => void;
  export function useState<S>(initial: S | (() => S)): [S, SetState<S>];
  const React: { useState: typeof useState };
  export default React;
}
declare module 'react-dom/client' {
  export function createRoot(container: Element | null): { render(node: unknown): void };
}
declare namespace JSX {
  type Element = { readonly __jsx: unique symbol };
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
}
