<script lang="ts">
  // Filter and opacity layers as Chromium draws them (BLITZ-GAPS, fixed in
  // the fork: filtered elements, drop-shadow() in currentColor, backdrop
  // filters with rounded corners).
  let faded = $state(true);
</script>

<div class="grid">
  <div id="shadow-current" class="cell"><div class="box shadow-current">Aa</div></div>
  <div id="shadow-keyword" class="cell"><div class="box shadow-keyword">Aa</div></div>
  <div id="decorated" class="cell"><div class="box decorated"></div></div>
  <div id="overflowing" class="cell"><div class="box overflowing"><div class="child"></div></div></div>
  <div id="faded" class="cell">
    <div class={faded ? 'box faded' : 'box'}><div class="child"></div></div>
  </div>
  <div id="glass" class="cell stripes"><div id="glass-box" class="box glass"></div></div>
</div>
<button id="toggle" onclick={() => (faded = !faded)}>Toggle</button>
