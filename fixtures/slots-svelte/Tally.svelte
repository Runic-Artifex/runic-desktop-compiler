<script lang="ts">
  let { id }: { id: number } = $props();
  let n = $state(0);
</script>
<button id={`tally-${id}`} onclick={() => n += 1}>{n}</button>
