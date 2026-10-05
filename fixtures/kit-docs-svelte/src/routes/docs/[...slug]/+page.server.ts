// The pages to prerender (Kit's `entries`), run at generation only: one per
// markdown page of the content collection.
import { components } from '$content/index.js';

export const prerender = true;

export function entries() {
  return components.map(doc => ({ slug: doc.path }));
}
