<script lang="ts">
  import Counter from './Counter.svelte';
  import { store } from './store.svelte.ts';

  let show = $state(true);
</script>

<main>
  <h1 id="title">Shared state</h1>
  <Counter id="a" />
  {#if show}<Counter id="b" />{/if}
  <p id="total">{store.count}</p>
  <div class="controls">
    <button id="toggle" onclick={() => (show = !show)}>Toggle</button>
    <button id="reset" onclick={() => (store.count = 0)}>Reset</button>
  </div>
</main>
