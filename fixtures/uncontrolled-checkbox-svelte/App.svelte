<script lang="ts">
  let watched = $state(false);
  let changes = $state(0);
  let other = $state(0);
  let size = $state('');
</script>

<main>
  <div class="row"><label id="plain-label"><input id="plain" type="checkbox" /> Plain</label></div>
  <div class="row"><label id="preset-label"><input id="preset" type="checkbox" checked /> Preset</label></div>
  <div class="row">
    <input
      id="watched"
      type="checkbox"
      aria-label="Watched"
      onchange={e => {
        watched = e.currentTarget.checked;
        changes++;
      }}
    />
    <button id="other" onclick={() => other++}>Other {other}</button>
  </div>
  <div class="row">
    <label><input id="small" type="radio" name="size" value="small" onchange={() => (size = 'small')} /> Small</label>
    <label><input id="large" type="radio" name="size" value="large" onchange={() => (size = 'large')} /> Large</label>
  </div>
  <p id="state">{watched} {changes} {size}</p>
</main>
