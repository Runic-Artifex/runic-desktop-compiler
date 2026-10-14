<script lang="ts">
  // Svelte actions (`use:`, M6 script DOM slice 4): the action runs once
  // with the element and the value; `update` runs when what the value reads
  // changes, also deep inside a proxy it is or holds at its top level
  // (Svelte 5's deep_read_state), and not for proxies inside plain objects;
  // `destroy` runs when the element's component is destroyed.
  import ActProxy from './ActProxy.svelte';
  import ActHolds from './ActHolds.svelte';
  import ActPlain from './ActPlain.svelte';
  import ActCount from './ActCount.svelte';
  import { counts, deep, far, held } from './state.svelte.ts';

  let count = $state(0);
  let other = $state(0);
  let shown = $state(true);
</script>

<div id="app">
  {#if shown}
    <ActProxy />
  {/if}
  <ActHolds />
  <ActPlain />
  <ActCount {count} />
  <button id="deep" onclick={() => deep.inner.m++}>deep</button>
  <button id="top" onclick={() => deep.n++}>top</button>
  <button id="held" onclick={() => held.k++}>held</button>
  <button id="far" onclick={() => far.k++}>far</button>
  <button id="count" onclick={() => count++}>count</button>
  <button id="same" onclick={() => (count = count)}>same</button>
  <button id="other" onclick={() => other++}>other {other}</button>
  <button id="toggle" onclick={() => (shown = !shown)}>toggle</button>
  <p id="destroyed">destroyed {counts.destroyed}</p>
</div>
