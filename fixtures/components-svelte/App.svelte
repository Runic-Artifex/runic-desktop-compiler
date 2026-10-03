<script lang="ts">
  import Row from './Row.svelte';
  import Editor from './Editor.svelte';
  interface Item { id: number; label: string }
  let items = $state<Item[]>([{ id: 1, label: 'Alpha' }, { id: 2, label: 'Beta' }, { id: 3, label: 'Gamma' }]);
  let next = $state(4);
  let name = $state('Delta');
  let showEditor = $state(true);
  function add() { items.push({ id: next, label: name }); next += 1; }
  function remove(id: number) { items = items.filter(i => i.id !== id); }
  function up(id: number) {
    const i = items.findIndex(x => x.id === id);
    if (i > 0) { const moved = items[i]; items[i] = items[i - 1]; items[i - 1] = moved; }
  }
  function reverse() { items = items.toReversed(); }
</script>
<main><h1 id="title">Components</h1>
<ul>{#each items as item, i (item.id)}<Row id={item.id} label={item.label} first={i === 0} onremove={remove} onup={up} />{:else}<li id="empty">Nothing left</li>{/each}</ul>
<p id="summary">{items.length} items, next {next}, name {name}</p>
<div class="controls"><button id="add" onclick={add}>Add</button><button id="reverse" onclick={reverse}>Reverse</button><button id="toggle" onclick={() => showEditor = !showEditor}>Toggle editor</button></div>
{#if showEditor}<Editor bind:value={name} />{/if}
</main>
