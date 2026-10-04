import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load = (async ({ params, parent, url }) => {
  console.log('load item', params.id);
  if (params.id === '7') error(404, 'No item 7');
  const { section } = await parent();
  return {
    item: `Item ${params.id}`,
    tab: url.searchParams.get('tab') ?? 'overview',
    where: section,
  };
}) satisfies PageLoad;
