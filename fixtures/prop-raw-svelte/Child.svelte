<script lang="ts">
  let { id, item, other }: { id: string; item: { count: number }; other: number } = $props();
</script>

<p id="{id}-count">{item.count}</p>
<p id="{id}-both">{item.count} {other}</p>
<button id="{id}-bump" onclick={() => (item.count += 1)}>Bump {id}</button>
