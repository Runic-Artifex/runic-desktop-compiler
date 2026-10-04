// `$app/navigation` in a compiled SvelteKit app (Kit 2.70.1): `goto`,
// `beforeNavigate` and `afterNavigate`. A component script's top-level
// `beforeNavigate(f)` / `afterNavigate(f)` registers `f` when the
// component mounts and removes it when it is destroyed, as Kit's
// `add_navigation_callback` does with onMount (the compiler lowers the
// statement so); other calls are rejected.
export { goto, type GotoOptions, type BeforeNavigate, type Navigation } from './client.ts';
import {
  after_navigate_register,
  before_navigate_register,
  type BeforeNavigate,
  type Navigation,
} from './client.ts';

export function beforeNavigate(callback: (navigation: BeforeNavigate) => void): () => void {
  return before_navigate_register(callback);
}

export function afterNavigate(callback: (navigation: Navigation) => void): () => void {
  return after_navigate_register(callback);
}
