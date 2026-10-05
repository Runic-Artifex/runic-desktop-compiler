<script lang="ts">
  // This repository's stand-in for the site's IconPlaceholder, which loads
  // the icon of the chosen library with a dynamic import. It renders what
  // the shadcn-svelte CLI writes in its place when it installs a component:
  // the lucide icon with the placeholder's class and data-slot (the other
  // libraries' names are unused).
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';

  let {
    lucide,
    hugeicons: _hugeicons,
    tabler: _tabler,
    phosphor: _phosphor,
    remixicon: _remixicon,
    class: className,
    'data-slot': slot,
  }: {
    lucide: 'ChevronDownIcon' | 'ChevronUpIcon';
    hugeicons: string;
    tabler: string;
    phosphor: string;
    remixicon: string;
    class?: string;
    'data-slot'?: string;
  } = $props();
</script>

{#if lucide === 'ChevronDownIcon'}
  <ChevronDownIcon class={className} data-slot={slot} />
{:else}
  <ChevronUpIcon class={className} data-slot={slot} />
{/if}
