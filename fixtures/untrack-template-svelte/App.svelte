<script lang="ts">
  // untrack in a template: the read is not a dependency, but the block's
  // other dependencies re-run its template effect.
  import { untrack } from 'svelte';

  let state = $state({ count: 0 });
  let plain = $state(0);
  let other = $state(0);
</script>

<main>
  <h1 id="title">Untracked template reads</h1>
  <p id="mixed">{untrack(() => state.count)} {untrack(() => plain)} {other}</p>
  <p id="alone">{untrack(() => state.count)} {untrack(() => plain)}</p>
  {#if other >= 0}<p id="block">{untrack(() => state.count)} {untrack(() => plain)}</p>{/if}
  <div class="controls">
    <button id="bump" onclick={() => (state.count += 1)}>Bump</button>
    <button id="plain" onclick={() => (plain += 1)}>Plain</button>
    <button id="other" onclick={() => (other += 1)}>Other</button>
  </div>
</main>
