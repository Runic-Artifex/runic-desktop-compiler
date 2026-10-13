<script lang="ts">
  import { onDestroy } from 'svelte';

  let {
    state,
    n,
    record,
  }: { state: { count: number }; n: number; record: (line: string) => void } = $props();

  onDestroy(() => {
    record(`destroy ${state.count} ${n}`);
  });
</script>

<p id="child">{state.count} {n}</p>
