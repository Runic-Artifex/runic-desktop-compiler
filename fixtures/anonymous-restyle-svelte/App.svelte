<script lang="ts">
  let on = $state(false);
</script>

<div class="row">
  <button id="swatch" class="swatch">■</button>
  <div id="box" class={on ? 'box on' : 'box'}>■</div>
</div>
<div class="row"><button id="toggle" onclick={() => (on = !on)}>Toggle</button></div>
