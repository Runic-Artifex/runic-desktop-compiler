// Minimal React declarations for type analysis (React 19 ships no types in
// this repository's dependency set). Only the API the adapter lowers.
declare module 'react' {
  type SetState<S> = (value: S | ((previous: S) => S)) => void;
  export function useState<S>(initial: S | (() => S)): [S, SetState<S>];
  /** A ref object: React sets `current` to the element of `ref={…}`; otherwise a mutable box. */
  export interface RefObject<T> {
    current: T;
  }
  export function useRef<T>(initial: T): RefObject<T>;
  export function useRef<T>(initial: T | null): RefObject<T | null>;
  export function useRef<T = undefined>(initial?: undefined): RefObject<T | undefined>;
  /** An effect function: returns nothing or a cleanup function. */
  export type EffectCallback = () => void | (() => void);
  export type DependencyList = readonly unknown[];
  export function useEffect(effect: EffectCallback, deps?: DependencyList): void;
  export function useLayoutEffect(effect: EffectCallback, deps?: DependencyList): void;
  // Declared so their uses are rejected with a diagnostic rather than a type error.
  export function useInsertionEffect(effect: EffectCallback, deps?: DependencyList): void;
  export function useMemo<T>(factory: () => T, deps: DependencyList): T;
  export function useCallback<T extends Function>(callback: T, deps: DependencyList): T;
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
