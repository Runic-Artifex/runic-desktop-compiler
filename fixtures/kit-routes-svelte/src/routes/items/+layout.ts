import type { LayoutLoad } from './$types';

export const load = (async ({ parent }) => {
  const { site } = await parent();
  console.log('load items');
  return { section: `${site} items` };
}) satisfies LayoutLoad;
