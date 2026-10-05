<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Roving } from './roving.svelte.ts';

  let {
    roving,
    id,
    label,
    disabled = false,
  }: { roving: Roving; id: string; label: string; disabled?: boolean } = $props();

  const unregister = roving.register(id, label);
  onDestroy(() => unregister());
  const current = $derived(roving.current.current === id);
</script>

<button
  {id}
  data-roving-item=""
  data-disabled={disabled ? '' : undefined}
  class:current
  tabindex={current ? 0 : -1}
  onclick={() => (roving.current.current = id)}
>
  {label}
</button>
