<script lang="ts">
  // The installation steps (the site's steps.svelte numbers them with a CSS
  // counter utility of its own).
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();
</script>

<div class="mb-10 ml-4 flex flex-col gap-2 border-l pl-6">
  {@render children?.()}
</div>
