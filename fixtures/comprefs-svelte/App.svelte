<script lang="ts">
  import Field from './Field.svelte';
  let field = $state<HTMLInputElement | null>(null);
  let name = $state('');
  let shown = $state(true);
</script>

<main>
  {#if shown}<div class="row"><Field bind:ref={field} bind:value={name} id="name" aria-label="Name" /></div>{/if}
  <div class="row">
    <button id="focus" onclick={() => field?.focus()}>Focus</button>
    <button id="toggle" onclick={() => (shown = !shown)}>Toggle</button>
  </div>
  <p id="state">{field ? 'ref' : 'none'} {name}</p>
</main>
