<script lang="ts">
  // This repository's stand-in for the site's IconPlaceholder, which loads
  // the icon of the chosen library with a dynamic import. It renders what
  // the shadcn-svelte CLI writes in its place when it installs a component:
  // the lucide icon with the placeholder's class and data-slot (the other
  // libraries' names are unused).
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
  import MoreHorizontalIcon from '@lucide/svelte/icons/ellipsis';

  let {
    lucide,
    hugeicons: _hugeicons,
    tabler: _tabler,
    phosphor: _phosphor,
    remixicon: _remixicon,
    class: className,
    'data-slot': slot,
  }: {
    lucide: 'ChevronLeftIcon' | 'ChevronRightIcon' | 'MoreHorizontalIcon';
    hugeicons: string;
    tabler: string;
    phosphor: string;
    remixicon: string;
    class?: string;
    'data-slot'?: string;
  } = $props();
</script>

{#if lucide === 'ChevronLeftIcon'}
  <ChevronLeftIcon class={className} data-slot={slot} />
{:else if lucide === 'ChevronRightIcon'}
  <ChevronRightIcon class={className} data-slot={slot} />
{:else}
  <MoreHorizontalIcon class={className} data-slot={slot} />
{/if}
