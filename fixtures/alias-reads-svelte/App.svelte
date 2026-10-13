<script lang="ts">
  import { setCounter, type Counter } from './counter.ts';
  import Reader from './Reader.svelte';

  let counter = $state<Counter>({ count: 0, items: [] });
  setCounter(counter);

  function bump() {
    counter.count += 1;
  }
  function add() {
    counter.items.push(counter.items.length);
  }
</script>

<main>
  <h1 id="title">Alias reads</h1>
  <p id="owner">{counter.count} {counter.items.length}</p>
  <Reader />
  <div class="controls">
    <button id="bump" onclick={bump}>Bump</button>
    <button id="add" onclick={add}>Add</button>
  </div>
</main>
