<script lang="ts">
  // Button layout as Chromium does it (BLITZ-GAPS, fixed in the fork:
  // buttons with an author display, flex buttons without justify-content).
  let on = $state(false);
  let count = $state(0);
</script>

<div id="area" class="area">
  <div class="row"><button id="default" onclick={() => count++}>Default</button></div>
  <div class="row"><button id="flex" class="flex tall"><span id="flex-label">Flex</span></button></div>
  <div class="row">
    <button id="track" class={on ? 'track on' : 'track'} onclick={() => (on = !on)}><span id="thumb" class="thumb"></span></button>
  </div>
  <div class="row"><button id="block" class="block tall">Block</button></div>
  <div class="row"><button id="inline-block" class="inline-block tall">Inline block</button></div>
  <div class="row"><button id="block-child" class="block tall wide"><div id="box" class="box"></div></button></div>
  <div class="row"><button id="grid" class="grid tall"><span id="grid-label">Grid</span></button></div>
  <div class="row column"><button id="column">Stretched in a column</button></div>
  <div class="row stretch"><button id="stretched">Stretched in a row</button></div>
  <div class="row"><button id="two-lines" class="tall">Two words wrap in a tall button</button></div>
  <div class="row list"><button id="list-row" class="list-row"><span id="list-id" class="list-id">12</span>Row 12 · beta</button></div>
  <div class="row"><button id="mixed" class="tall"><span id="mixed-icon" class="icon"></span> Icon and text</button></div>
  <p id="state">{on} {count}</p>
</div>
