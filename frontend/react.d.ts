// Minimal React declarations for type analysis (React 19 ships no types in
// this repository's dependency set). Only the API the adapter lowers.
declare module 'react' {
  type SetState<S> = (value: S | ((previous: S) => S)) => void;
  export function useState<S>(initial: S | (() => S)): [S, SetState<S>];
  /** What a component can render: children and render-prop results. */
  export type ReactNode =
    JSX.Element | string | number | boolean | null | undefined | Iterable<ReactNode>;
  export type ReactElement = JSX.Element;
  // `React.ReactNode` through the default import.
  namespace React {
    type ReactNode = import('react').ReactNode;
    type ReactElement = JSX.Element;
  }
  const React: { useState: typeof useState };
  export default React;
}
declare module 'react-dom/client' {
  export function createRoot(container: Element | null): { render(node: unknown): void };
}
declare namespace JSX {
  interface Element {
    readonly __runicJsx: true;
  }
  /** Attribute types where an omitted value (`undefined`, `null`) needs its type. */
  interface Attributes {
    className?: string | null;
    id?: string | null;
    title?: string | null;
    [prop: string]: unknown;
  }
  interface IntrinsicElements {
    [name: string]: Attributes;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
}
