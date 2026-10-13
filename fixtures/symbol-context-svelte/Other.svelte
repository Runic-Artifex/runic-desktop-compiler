<script lang="ts">
  import type { Snippet } from 'svelte';
  import { setOther } from './context.ts';

  let { value, children }: { value: string; children?: Snippet } = $props();

  // svelte-ignore state_referenced_locally
  setOther(value);
</script>

{@render children?.()}
