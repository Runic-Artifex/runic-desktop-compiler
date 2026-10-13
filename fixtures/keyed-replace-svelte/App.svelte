<script lang="ts">
  // Keyed list items replaced by new objects with the same key keep their
  // block (and its child's state); items mutated in place update; a sort in
  // place moves blocks.
  import Row from './Row.svelte';

  type Item = { id: number; label: string; done: boolean };
  let items = $state<Item[]>([
    { id: 1, label: 'one', done: false },
    { id: 2, label: 'two', done: false },
    { id: 3, label: 'three', done: false },
  ]);

  function replaceFirst() {
    items[0] = { ...items[0], label: items[0].label + '*' };
  }
  function toggleSecond() {
    items[1].done = !items[1].done;
  }
  function sortDesc() {
    items.sort((a, b) => b.id - a.id);
  }
  function rebuild() {
    items = items.map((i) => ({ ...i }));
  }
</script>

<main>
  <h1 id="title">Keyed replace</h1>
  <ul>
    {#each items as item (item.id)}
      <Row {item} />
    {/each}
  </ul>
  <div class="controls">
    <button id="replace" onclick={replaceFirst}>Replace first</button>
    <button id="toggle" onclick={toggleSecond}>Toggle second</button>
    <button id="sort" onclick={sortDesc}>Sort</button>
    <button id="rebuild" onclick={rebuild}>Rebuild</button>
  </div>
</main>
