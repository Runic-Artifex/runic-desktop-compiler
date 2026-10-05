<script lang="ts">
  // Form controls under an inherited line height of 32px: Chromium gives
  // them line-height: normal (BLITZ-GAPS, form-control line height).
  let count = $state(0);
  let choice = $state('one');
  let area = $state('Area');
</script>

<main>
  <p id="text">Body text at a 32px line height.</p>
  <div class="row">
    <button id="button" onclick={() => count++}>Button</button>
    <button id="big" class="big" onclick={() => count++}>Big button</button>
  </div>
  <div class="row">
    <select id="select" bind:value={choice}>
      <option value="one">One</option>
      <option value="two">Two</option>
    </select>
  </div>
  <div class="row">
    <input id="input" value="Text" />
  </div>
  <div class="row">
    <textarea id="area" rows="2" bind:value={area}></textarea>
  </div>
  <p id="state">{count} {choice}</p>
</main>
