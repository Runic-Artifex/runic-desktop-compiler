<script lang="ts">
  // bits-ui 2.19.2's utilities/portal/portal-consumer.svelte (MIT License,
  // Copyright (c) 2023 Hunter Johnston).
  import type { Snippet } from 'svelte';

  const { children }: { children?: Snippet } = $props();
</script>

{#key children}
  {@render children?.()}
{/key}
