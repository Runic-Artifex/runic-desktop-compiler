<script lang="ts">
  import { getTone } from './context.ts';

  let { id }: { id: string } = $props();

  const tone = getTone('<Show/>');
</script>

<p class="show">
  <span id="{id}-text">{tone.label}: {tone.count}</span>
  <button id="{id}-bump" onclick={() => tone.bump()}>+1</button>
</p>
