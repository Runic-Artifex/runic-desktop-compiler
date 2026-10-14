<script lang="ts">
  import { onDestroy } from 'svelte';

  let { id, n, record }: { id: number; n: number; record: (line: string) => void } = $props();

  $effect.pre(() => {
    const seen = n;
    return () => record(`cell cleanup ${id} ${seen}`);
  });
  onDestroy(() => record(`cell destroy ${id}`));
</script>

<span>{n % 2 === 0 ? 'even' : 'odd'}</span>
