// A docs page, as the site's docs/[...slug]/+page.ts loads it: the
// markdown page's component and metadata (getDoc), and the highlighted
// source of the component it documents from the prerendered endpoint.
import { getDoc } from '$lib/docs.js';
import type { HighlightedBlock } from '../../api/block/[block]/+server.js';
import type { PageLoad } from './$types';

export const load = (async ({ params, fetch }) => {
  const doc = await getDoc(params.slug);
  const res = await fetch(`/api/block/${doc.metadata.slug}`);
  const viewerData: HighlightedBlock = await res.json();
  return { ...doc, viewerData };
}) satisfies PageLoad;
