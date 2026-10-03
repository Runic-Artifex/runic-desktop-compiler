<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Child from './Child.svelte';
  let count = $state(0);
  let show = $state(true);
  let shown = $state('');
  let log: string[] = [];
  function note(s: string) {
    log.push(s);
  }
  $effect.pre(() => {
    note(`App pre ${count}`);
  });
  $effect(() => {
    note(`App effect ${count}`);
    return () => note(`App cleanup ${count}`);
  });
  onMount(() => note('App mount'));
  onDestroy(() => note('App destroy'));
  function dump() {
    shown = log.join(' | ');
    log = [];
  }
</script>
<main><h1 id="title">Effects</h1>
{#if show}<Child name="A" {count} {note} /><Child name="B" {count} {note} />{/if}
<p id="log">{shown}</p>
<div class="controls"><button id="inc" onclick={() => count++}>Increment</button><button id="toggle" onclick={() => (show = !show)}>Toggle</button><button id="dump" onclick={dump}>Dump</button></div>
</main>
