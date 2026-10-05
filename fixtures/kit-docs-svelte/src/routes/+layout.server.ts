// Server data (evaluated at generation, a data table natively): the
// sidebar's entries, from the site's velite content collection.
import { components } from '$content/index.js';

export const prerender = true;

export function load() {
  return {
    nav: components.map(doc => ({ title: doc.title, href: `/docs/${doc.path}` })),
  };
}
