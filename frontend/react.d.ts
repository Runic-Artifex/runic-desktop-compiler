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
  // Synthetic events: opaque event values (the `__runicEvent` marker) whose
  // members lower to `event.*` built-ins. React sets `currentTarget` to null
  // after each listener, so it is nullable here.
  export interface SyntheticEvent<T = Element> {
    readonly __runicEvent: true;
    readonly type: string;
    readonly target: HTMLElement;
    readonly currentTarget: T | null;
    readonly defaultPrevented: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  }
  export interface UIEvent<T = Element> extends SyntheticEvent<T> {}
  export interface FormEvent<T = Element> extends SyntheticEvent<T> {}
  /** The control a change event comes from: its value and checked state at dispatch. */
  interface EventControl {
    readonly value: string;
    readonly checked: boolean;
  }
  export interface ChangeEvent<T = Element> extends SyntheticEvent<T> {
    readonly target: HTMLElement & T & EventControl;
    readonly currentTarget: (T & EventControl) | null;
  }
  export interface KeyboardEvent<T = Element> extends UIEvent<T> {
    readonly key: string;
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly repeat: boolean;
  }
  export interface MouseEvent<T = Element> extends UIEvent<T> {
    readonly clientX: number;
    readonly clientY: number;
    readonly button: number;
    readonly buttons: number;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
  }
  export interface PointerEvent<T = Element> extends MouseEvent<T> {}
  /** onFocus and onBlur: React dispatches them from focusin and focusout. */
  export interface FocusEvent<T = Element> extends UIEvent<T> {
    readonly relatedTarget: HTMLElement | null;
  }
  export type EventHandler<E extends SyntheticEvent> = (event: E) => void;
  export type MouseEventHandler<T = Element> = EventHandler<MouseEvent<T>>;
  export type PointerEventHandler<T = Element> = EventHandler<PointerEvent<T>>;
  export type KeyboardEventHandler<T = Element> = EventHandler<KeyboardEvent<T>>;
  export type ChangeEventHandler<T = Element> = EventHandler<ChangeEvent<T>>;
  export type FocusEventHandler<T = Element> = EventHandler<FocusEvent<T>>;
  /**
   * The props of DOM elements, for components forwarding rest props to one
   * (`{ variant?: string } & ButtonHTMLAttributes<HTMLButtonElement>`).
   */
  export interface HTMLAttributes<T = Element> extends JSX.Attributes {}
  export interface ButtonHTMLAttributes<T = Element> extends HTMLAttributes<T> {
    disabled?: boolean;
  }
  export interface InputHTMLAttributes<T = Element> extends HTMLAttributes<T> {
    disabled?: boolean;
  }
  /** What a component can render: children and render-prop results. */
  export type ReactNode =
    JSX.Element | string | number | boolean | null | undefined | Iterable<ReactNode>;
  export type ReactElement = JSX.Element;
  // `React.ReactNode` through the default import.
  namespace React {
    type ReactNode = import('react').ReactNode;
    type ReactElement = JSX.Element;
    type SyntheticEvent<T = Element> = import('react').SyntheticEvent<T>;
    type ChangeEvent<T = Element> = import('react').ChangeEvent<T>;
    type FormEvent<T = Element> = import('react').FormEvent<T>;
    type KeyboardEvent<T = Element> = import('react').KeyboardEvent<T>;
    type MouseEvent<T = Element> = import('react').MouseEvent<T>;
    type PointerEvent<T = Element> = import('react').PointerEvent<T>;
    type FocusEvent<T = Element> = import('react').FocusEvent<T>;
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
    // Event props: inline handlers take React's synthetic event types.
    onClick?: import('react').MouseEventHandler;
    onDoubleClick?: import('react').MouseEventHandler;
    onContextMenu?: import('react').MouseEventHandler;
    onMouseDown?: import('react').MouseEventHandler;
    onMouseUp?: import('react').MouseEventHandler;
    onMouseMove?: import('react').MouseEventHandler;
    onMouseEnter?: import('react').MouseEventHandler;
    onMouseLeave?: import('react').MouseEventHandler;
    onPointerDown?: import('react').PointerEventHandler;
    onPointerUp?: import('react').PointerEventHandler;
    onPointerMove?: import('react').PointerEventHandler;
    onPointerEnter?: import('react').PointerEventHandler;
    onPointerLeave?: import('react').PointerEventHandler;
    onKeyDown?: import('react').KeyboardEventHandler;
    onKeyUp?: import('react').KeyboardEventHandler;
    onFocus?: import('react').FocusEventHandler;
    onBlur?: import('react').FocusEventHandler;
    onChange?: import('react').ChangeEventHandler<HTMLInputElement>;
    htmlFor?: string | null;
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
