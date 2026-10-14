<script lang="ts">
  import Cell from './Cell.svelte';

  let { id, n, record }: { id: number; n: number; record: (line: string) => void } = $props();

  $effect.pre(() => {
    record(`row ${id} ${n}`);
    return () => record(`cleanup ${id} ${n}`);
  });
</script>

<p id={'row-' + id}>{id} {n} <Cell {id} {n} {record} /></p>
