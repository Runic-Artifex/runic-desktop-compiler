<script>
// Each cell draws the same striped tile through one CSS filter (list).
const cells = [
  'brightness',
  'contrast',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
  'blur',
  'shadow-hard',
  'shadow-soft',
  'list',
  'list-shadow',
  'with-opacity',
  'animated',
];
let dimmed = $state(false);
</script>
<main>
  <div class="controls">
    <button id="toggle" onclick={() => (dimmed = !dimmed)}>{dimmed ? 'Restore' : 'Dim'}</button>
  </div>
  <div class="grid">
    {#each cells as name (name)}
      <div id={name} class="cell">
        <div class={name === 'animated' && dimmed ? 'tile animated dimmed' : 'tile ' + name}>
          <div class="a"></div>
          <div class="b"></div>
          <div class="c"><div class="dot"></div></div>
        </div>
      </div>
    {/each}
  </div>
</main>
