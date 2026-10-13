<script lang="ts">
  let { item }: { item: { id: number; label: string; done: boolean } } = $props();
  let clicks = $state(0);
  // The item this block was created with, by its label.
  const first = item.label;
</script>

<li id="row-{item.id}">
  <span id="row-{item.id}-text">{item.label} {item.done ? 'done' : 'open'} {clicks} {first}</span>
  <button id="row-{item.id}-click" onclick={() => (clicks += 1)}>+</button>
</li>
