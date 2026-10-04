<script>
// Coloured stripes behind panels with backdrop filters, and a full-viewport
// overlay that blurs the page (a dialog backdrop).
const stripes = [
  'rgb(214, 64, 52)',
  'rgb(240, 180, 40)',
  'rgb(46, 140, 86)',
  'rgb(52, 92, 196)',
  'rgb(130, 60, 170)',
  'rgb(250, 250, 245)',
  'rgb(30, 40, 50)',
  'rgb(0, 170, 190)',
  'rgb(230, 110, 150)',
  'rgb(120, 130, 60)',
];
let open = $state(false);
</script>
<main>
  <div class="stripes">
    {#each stripes as color (color)}<div class="stripe" style="background: {color}"></div>{/each}
  </div>
  <div id="glass" class="panel glass"><div class="chip"></div></div>
  <div id="mono" class="panel mono"><div class="chip"></div></div>
  <div id="faded" class="panel faded"><div class="chip"></div></div>
  <button id="open" onclick={() => (open = true)}>Open</button>
  {#if open}<div id="overlay" class="overlay"></div>{/if}
</main>
