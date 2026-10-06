<script lang="ts">
  // Container queries as Chromium's (BLITZ-GAPS, fixed in the fork:
  // container queries). Size queries against containers of several widths,
  // named and nested containers, a block-size container,
  // and inline-size containment of flex items. Resize changes a container's
  // width, which restyles its descendants.
  let width = $state(240);
</script>

<button id="resize" onclick={() => (width = width === 240 ? 560 : 240)}>Resize</button>
<div id="c-var" class="c" style={`width: ${width}px`}><div id="box-var" class="box"></div></div>
<div id="c-200" class="c" style="width: 200px"><div id="box-200" class="box"></div></div>
<div id="c-320" class="c" style="width: 320px"><div id="box-320" class="box"></div></div>
<div id="c-full" class="c"><div id="box-full" class="box"></div></div>
<div id="named" class="c named" style="width: 260px"><div><p id="in-panel" class="in-panel">Panel text</p></div></div>
<div id="size" class="c size" style="width: 200px"><div id="tall-only" class="tall-only">Tall</div></div>
<div id="outer" class="c outer"><div id="inner" class="inner"><div id="deep" class="deep"></div></div></div>
<div id="flex" class="flex">
  <div id="item-a" class="item"><div class="wide"></div></div>
  <div id="item-b" class="item grow"><div id="box-b" class="box"></div></div>
</div>
