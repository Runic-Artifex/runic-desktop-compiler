<script lang="ts">
  // This repository's stand-in for the site's IconPlaceholder, which loads
  // the icon of the chosen library with a dynamic import. It renders what
  // the shadcn-svelte CLI writes in its place when it installs a component:
  // the lucide icon with the placeholder's class and data-slot (the other
  // libraries' names are unused).
  import XIcon from '@lucide/svelte/icons/x';

  let {
    lucide: _lucide,
    hugeicons: _hugeicons,
    tabler: _tabler,
    phosphor: _phosphor,
    remixicon: _remixicon,
    class: className,
    'data-slot': slot,
  }: {
    lucide: 'XIcon';
    hugeicons: string;
    tabler: string;
    phosphor: string;
    remixicon: string;
    class?: string;
    'data-slot'?: string;
  } = $props();
</script>

<XIcon class={className} data-slot={slot} />
