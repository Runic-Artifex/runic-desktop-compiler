<script lang="ts">
  // This repository's stand-in for the site's IconPlaceholder, which loads
  // the icon of the chosen library with a dynamic import. It renders what
  // the shadcn-svelte CLI writes in its place when it installs a component:
  // the lucide icon with the placeholder's class and data-slot (the other
  // libraries' names are unused).
  import CheckIcon from '@lucide/svelte/icons/check';
  import SearchIcon from '@lucide/svelte/icons/search';
  import XIcon from '@lucide/svelte/icons/x';

  let {
    lucide,
    hugeicons: _hugeicons,
    tabler: _tabler,
    phosphor: _phosphor,
    remixicon: _remixicon,
    class: className,
    'data-slot': slot,
  }: {
    lucide: 'CheckIcon' | 'SearchIcon' | 'XIcon';
    hugeicons: string;
    tabler: string;
    phosphor: string;
    remixicon: string;
    class?: string;
    'data-slot'?: string;
  } = $props();
</script>

{#if lucide === 'CheckIcon'}
  <CheckIcon class={className} data-slot={slot} />
{:else if lucide === 'SearchIcon'}
  <SearchIcon class={className} data-slot={slot} />
{:else}
  <XIcon class={className} data-slot={slot} />
{/if}
