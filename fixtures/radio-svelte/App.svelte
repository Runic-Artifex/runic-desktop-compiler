<script lang="ts">
  let size = $state('m');
  let log = $state<string[]>([]);
  let locked = $state(false);
</script>

<main>
  <div class="row">
    <button id="before">Before</button>
    <label id="s-label"><input id="s" type="radio" name="size" value="s" bind:group={size} onchange={() => log.push('s')} /> Small</label>
    <label id="m-label"><input id="m" type="radio" name="size" value="m" bind:group={size} onchange={() => log.push('m')} /> Medium</label>
    <label id="l-label"><input id="l" type="radio" name="size" value="l" bind:group={size} disabled /> Large</label>
    <label id="xl-label"><input id="xl" type="radio" name="size" value="xl" bind:group={size} onclick={(e) => { if (locked) e.preventDefault(); }} onchange={() => log.push('xl')} /> Extra</label>
  </div>
  <div class="row">
    <button id="after">After</button>
    <button id="lock" onclick={() => (locked = !locked)}>Lock</button>
    <button id="pick" onclick={() => (size = 's')}>Pick small</button>
  </div>
  <p id="state">{size} {locked}</p>
  <p id="log">{log.join(' ')}</p>
</main>
