<script lang="ts">
  import Counter from './Counter.svelte';
  let round = $state(1);
  let name = $state('a');
</script>
<main><h1 id="title">Key blocks</h1>
{#key round}<Counter label="keyed" /><p id="round">Round {round}</p>{/key}
<Counter label="plain" />
{#key name}<p id="name">Name {name}</p>{/key}
<div class="controls"><button id="next" onclick={() => round += 1}>Next round</button><button id="same" onclick={() => round = round}>Same round</button><button id="rename" onclick={() => name = name === 'a' ? 'b' : 'a'}>Rename</button></div>
</main>
