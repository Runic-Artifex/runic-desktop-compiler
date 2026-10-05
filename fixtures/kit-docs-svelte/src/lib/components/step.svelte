<script lang="ts">
  // A step's heading (the site's step.svelte uses scroll-margin, which
  // Blitz does not support).
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();
</script>

<div role="heading" aria-level="3" class="mt-6 text-base font-medium tracking-tight">
  {@render children?.()}
</div>
