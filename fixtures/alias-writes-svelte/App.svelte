<script lang="ts">
  import { setCounter, type Counter } from './counter.ts';
  import Writer from './Writer.svelte';

  let counter = $state<Counter>({ count: 0, items: [] });
  setCounter(counter);
</script>

<main>
  <h1 id="title">Alias writes</h1>
  <p id="owner">{counter.count} {counter.items.join(',')}</p>
  <Writer />
</main>
