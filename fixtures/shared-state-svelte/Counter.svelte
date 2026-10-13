<script lang="ts">
  import { store, tally } from './store.svelte.ts';

  let { id }: { id: string } = $props();
  let mine = $state(0);
</script>

<p id="{id}-text">{store.count} {store.names.join(',')} {tally.value} {mine}</p>
<button
  id="{id}-bump"
  onclick={() => {
    store.count += 1;
    store.names.push(id);
    tally.bump();
    mine += 1;
  }}>Bump {id}</button
>
