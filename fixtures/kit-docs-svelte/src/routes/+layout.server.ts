// Server data (evaluated at generation, a data table natively): the
// sidebar's entries, from the site's velite content collection.
import { components } from '$content/index.js';

export const prerender = true;
// Rendered in the browser (an SPA over prerendered data), as the native app
// renders: server rendering and hydration would differ in what they show
// first (Svelte gives hydrated elements other $props.id() ids).
export const ssr = false;

export function load() {
  return {
    nav: components.map(doc => ({ title: doc.title, href: `/docs/${doc.path}` })),
  };
}
