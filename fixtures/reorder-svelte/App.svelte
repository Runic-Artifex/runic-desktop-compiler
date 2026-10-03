<script lang="ts">
  import { MODES, reorder } from './order.ts';
  let items = $state([1, 2, 3, 4, 5, 6]);
  let mode = $state('reverse');
</script>
<main><p id="mode">Mode: {mode}</p><div class="modes">{#each MODES as m (m)}<button id={`mode-${m}`} onclick={() => mode = m}>{m}</button>{/each}</div><ul>{#each items as x (x)}<li><button id={`item-${x}`} onclick={() => items = reorder(items, mode, x)}>Item {x}</button></li>{/each}</ul></main>
