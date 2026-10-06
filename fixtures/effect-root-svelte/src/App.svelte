<script lang="ts">
  import { log, bump, current, start } from './log.svelte';
  let stop: (() => void) | null = $state(start('a'));
</script>

<main>
  <p id="log">{log.join(', ')}</p>
  <p id="value">{current()}</p>
  <button id="bump" onclick={bump}>bump</button>
  <button
    id="stop"
    onclick={() => {
      stop?.();
      stop = null;
    }}>stop</button
  >
  <button id="start" onclick={() => (stop = start('b'))}>start</button>
</main>
