<script lang="ts">
  let off = $state(false);
</script>

<main>
  <button id="toggle" onclick={() => (off = !off)}>Toggle</button>
  <p id="demo" class="shimmer muted">Generating response&hellip;</p>
  <p id="large" class="shimmer large">Generating response&hellip;</p>
  <p id="angle" class="shimmer shimmer-angle-45 muted">Generating response&hellip;</p>
  <p id="color" class="shimmer shimmer-color-blue">Generating response&hellip;</p>
  <p id="duration" class="shimmer shimmer-duration-1000 shimmer-spread-24">Generating response&hellip;</p>
  <p id="once" class="shimmer shimmer-once">Generating response&hellip;</p>
  <p id="rtl" dir="rtl" class="shimmer">Generating response&hellip;</p>
  <div id="marker" class="marker" role="status">
    <span class="marker-icon"></span>
    <span id="marker-content" class="marker-content shimmer">Thinking...</span>
  </div>
  <span id="title" class="title shimmer">quarterly-report-final-draft.pdf</span>
  <p id="none" class={off ? 'shimmer shimmer-none' : 'shimmer'}>Generating response&hellip;</p>
</main>
