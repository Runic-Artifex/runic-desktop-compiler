<script lang="ts">
  let { label }: { label: string } = $props();
  let n = $state(0);
</script>
<p><button id={`count-${label}`} onclick={() => n += 1}>{label}: {n}</button></p>
