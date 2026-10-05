// A prerendered endpoint (the site's api/block/[block], narrowed to this
// fixture): a component's files, highlighted with the site's
// highlight-code.ts. Evaluated at generation natively (a table of responses
// by URL); prerendered by Kit for the browser reference.
import { json } from '@sveltejs/kit';
import { highlightCode } from '$lib/highlight-code.js';

export const prerender = true;

export interface HighlightedFile {
  target: string;
  highlightedContent: string;
}

export interface HighlightedBlock {
  name: string;
  files: HighlightedFile[];
}

const sources = import.meta.glob<string>('/src/lib/registry/ui/*/*', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export async function GET({ params }: { params: { block: string } }) {
  const prefix = `/src/lib/registry/ui/${params.block}/`;
  const files: HighlightedFile[] = [];
  for (const path of Object.keys(sources).sort()) {
    if (!path.startsWith(prefix)) continue;
    const target = `ui/${params.block}/${path.slice(prefix.length)}`;
    const language = path.endsWith('.ts') ? 'typescript' : 'svelte';
    files.push({ target, highlightedContent: await highlightCode(sources[path], language) });
  }
  return json({ name: params.block, files } satisfies HighlightedBlock);
}
