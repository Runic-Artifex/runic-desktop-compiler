// `$app/navigation` in a compiled SvelteKit app (Kit 2.70.1): `goto`,
// `beforeNavigate` and `afterNavigate`. The compiler lowers a component
// script's top-level `beforeNavigate(f)` / `afterNavigate(f)` to an
// `onMount` that registers `f` (and removes it on destroy), as Kit's
// `add_navigation_callback` does; called elsewhere they are rejected.
export { goto, type GotoOptions, type BeforeNavigate, type Navigation } from './client.ts';
import type { BeforeNavigate, Navigation } from './client.ts';

export function beforeNavigate(callback: (navigation: BeforeNavigate) => void): void {
  void callback;
  __runic.unsupported('beforeNavigate outside the top level of a component script');
}

export function afterNavigate(callback: (navigation: Navigation) => void): void {
  void callback;
  __runic.unsupported('afterNavigate outside the top level of a component script');
}
