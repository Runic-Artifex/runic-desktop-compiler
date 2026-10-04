<script lang="ts">
  // This repository's stand-in for the site's IconPlaceholder, which loads
  // the icon of the chosen library with a dynamic import. It renders what
  // the shadcn-svelte CLI writes in its place when it installs a component:
  // the lucide icon with the placeholder's class (the other libraries' names
  // are unused).
  import CheckIcon from '@lucide/svelte/icons/check';
  import MinusIcon from '@lucide/svelte/icons/minus';

  let {
    lucide,
    hugeicons: _hugeicons,
    tabler: _tabler,
    phosphor: _phosphor,
    remixicon: _remixicon,
    class: className,
  }: {
    lucide: 'CheckIcon' | 'MinusIcon';
    hugeicons: string;
    tabler: string;
    phosphor: string;
    remixicon: string;
    class?: string;
  } = $props();
</script>

{#if lucide === 'CheckIcon'}
  <CheckIcon class={className} />
{:else}
  <MinusIcon class={className} />
{/if}
