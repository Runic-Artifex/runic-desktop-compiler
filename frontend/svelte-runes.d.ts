// Ambient declarations of Svelte 5 runes for type analysis of component
// scripts (the official declarations live in the svelte package's generated
// types; these cover the runes the adapter lowers).
declare function $state<T>(initial: T): T;
declare function $state<T>(): T | undefined;
declare namespace $state {
  function raw<T>(initial: T): T;
  function raw<T>(): T | undefined;
  function snapshot<T>(value: T): T;
}
declare function $derived<T>(expression: T): T;
declare namespace $derived {
  function by<T>(fn: () => T): T;
}
declare function $effect(fn: () => void | (() => void)): void;
declare namespace $effect {
  function pre(fn: () => void | (() => void)): void;
}
declare function $props<T = Record<string, unknown>>(): T;
declare function $bindable<T>(fallback?: T): T;
