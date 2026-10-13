<script lang="ts">
  // bits-ui's global id counter (globalThis.bitsIdCounter, use-id.js) shared
  // by components mounted, unmounted and mounted again: each id comes from
  // the counter at the point Svelte's component initialisation reaches it.
  import { useId } from 'bits-ui';
  import Section from './Section.svelte';

  const ui = $state({ second: true, third: false });
  const first = useId();
</script>

<main>
  <h1>Id counter</h1>
  <p id="first">{first}</p>
  <div class="controls">
    <button id="second" onclick={() => (ui.second = !ui.second)}>second</button>
    <button id="third" onclick={() => (ui.third = !ui.third)}>third</button>
  </div>
  <Section name="one" />
  {#if ui.second}
    <Section name="two" />
  {/if}
  {#if ui.third}
    <Section name="three" />
  {/if}
</main>
