<script>
// Gradients Blitz draws differently from Chromium (docs/BLITZ-GAPS.md).
const cells = ['angle-border', 'angle-size', 'stop-fixup'];
</script>
<main>
  <div class="grid">
    {#each cells as name (name)}
      <div id={name} class={'cell ' + name}></div>
    {/each}
  </div>
</main>
