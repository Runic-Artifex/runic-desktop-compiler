<script lang="ts">
  import type { Snippet } from 'svelte';
  interface Item { id: number; name: string }
  let { items, row }: { items: Item[]; row: Snippet<[Item, boolean]> } = $props();
  let descending = $state(false);
  let shown = $derived(descending ? items.toReversed() : items);
</script>
<ul>{#each shown as item, i (item.id)}<li>{@render row(item, i === 0)}</li>{/each}</ul>
<button id="order" onclick={() => descending = !descending}>{descending ? 'Ascending' : 'Descending'}</button>
