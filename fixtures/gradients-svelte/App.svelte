<script>
// Each cell is one CSS gradient background.
const cells = [
  'linear',
  'linear-angle',
  'linear-stops',
  'linear-hard',
  'linear-alpha',
  'linear-repeating',
  'radial',
  'radial-ellipse',
  'radial-hard',
  'radial-repeating',
  'conic',
  'conic-hard',
  'layered',
  'rounded',
  'animated',
];
let shifted = $state(false);
</script>
<main>
  <div class="controls">
    <button id="toggle" onclick={() => (shifted = !shifted)}>{shifted ? 'Back' : 'Shift'}</button>
  </div>
  <div class="grid">
    {#each cells as name (name)}
      <div id={name} class={name === 'animated' && shifted ? 'cell animated shifted' : 'cell ' + name}></div>
    {/each}
  </div>
</main>
