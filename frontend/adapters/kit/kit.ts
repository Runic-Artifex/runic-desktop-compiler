// `@sveltejs/kit` in a compiled SvelteKit app (docs/design/M6-SVELTEKIT.md):
// `error` and `redirect` (Kit 2.70.1, src/exports/index.js) and types. The
// errors they throw are Error values that only the router reads (the
// compiler rejects `catch` clauses that could see them).
import type { NavigationEvent } from './client.ts';
import type { KitError } from './page.svelte.ts';

/** `error(status, message)`: an HttpError with the body `{ message }`. */
export function error(status: number, message?: string): never {
  throw new Error(`\u0000HttpError ${status}\u0000${message ?? `Error: ${status}`}`);
}

/** `redirect(status, location)`. */
export function redirect(status: number, location: string): never {
  throw new Error(`\u0000Redirect ${status}\u0000${location}`);
}

/** `HandleClientError` (`src/hooks.client`): `error` is not provided. */
export type HandleClientError = (input: {
  event: NavigationEvent;
  status: number;
  message: string;
}) => KitError | void;

export type { NavigationEvent };
