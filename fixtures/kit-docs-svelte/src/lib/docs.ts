// The markdown pages (the site's src/lib/docs.ts, narrowed to this fixture's
// collection): each page's module from a lazy glob, its metadata from the
// velite content collection.
import { error } from '@sveltejs/kit';
import type { Component } from 'svelte';
import { components } from '$content/index.js';
import type { HighlightedBlock } from '../routes/api/block/[block]/+server.js';

type DocModule = { default: Component<{ viewerData: HighlightedBlock | null }> };

const modules = import.meta.glob<DocModule>('/content/**/*.md');

export async function getDoc(slug: string) {
  const metadata = components.find(doc => doc.path === slug);
  const resolver = modules[`/content/${slug}.md`];
  if (!resolver || !metadata) error(404, 'Could not find the documentation page.');
  const doc = await resolver();
  return { component: doc.default, metadata };
}
