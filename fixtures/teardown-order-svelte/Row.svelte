<script lang="ts">
  import { onDestroy } from 'svelte';
  import { attachRef } from 'svelte-toolbelt';
  import Cell from './Cell.svelte';

  let { id, n, record }: { id: number; n: number; record: (line: string) => void } = $props();

  $effect.pre(() => {
    record(`row ${id} ${n}`);
    return () => record(`cleanup ${id} ${n}`);
  });
  $effect(() => {
    const seen = n;
    return () => record(`effect cleanup ${id} ${seen}`);
  });
  onDestroy(() => record(`destroy ${id}`));
  const mark = attachRef((node: HTMLElement | null) => {
    if (node === null) record(`detach ${id}`);
  });
</script>

<p id={'row-' + id}><span {...mark}>{id} {n}</span> <Cell {id} {n} {record} /></p>
