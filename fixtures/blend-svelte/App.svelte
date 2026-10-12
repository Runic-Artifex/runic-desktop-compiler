<script lang="ts">
  // mix-blend-mode and background-blend-mode as Chromium composites them
  // (Compositing and Blending 1): every value, over a solid colour, a
  // gradient and an image, with opacity, inside ancestors that isolate the
  // blend and ones that do not, on text, and shadcn's avatar ring.
  const MODES = [
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
    'plus-lighter',
  ];
  const BACKGROUND_MODES = ['multiply', 'screen', 'overlay', 'difference', 'hue', 'luminosity'];
  // Ancestors of a multiply-blended box: isolation, opacity, a transform
  // and z-index isolate it (it blends only with their half-yellow
  // background); none and overflow clips do not (it blends with the blue
  // behind them too).
  const ANCESTORS = ['none', 'isolate', 'opacity', 'transform', 'z-index', 'overflow', 'rounded'];
</script>

<main>
  <h1>Blending</h1>

  <p>Over a solid colour</p>
  <div class="tiles solid">
    {#each MODES as mode}
      <div id="solid-{mode}" class="tile" style="mix-blend-mode: {mode}"></div>
    {/each}
  </div>

  <p>Translucent over a gradient</p>
  <div class="tiles gradient">
    {#each MODES as mode}
      <div id="gradient-{mode}" class="tile translucent" style="mix-blend-mode: {mode}"></div>
    {/each}
  </div>

  <p>Over an image</p>
  <div class="tiles">
    {#each MODES as mode}
      <div id="image-{mode}" class="cell">
        <img src="/backdrop.png" width="40" height="40" alt="" />
        <div class="over" style="mix-blend-mode: {mode}"></div>
      </div>
    {/each}
  </div>

  <p>Opacity, nesting and isolation</p>
  <div class="tiles solid">
    <div id="opacity-multiply" class="tile" style="opacity: 0.5; mix-blend-mode: multiply"></div>
    <div id="opacity-screen" class="tile" style="opacity: 0.7; mix-blend-mode: screen"></div>
    <div id="nested" class="tile" style="mix-blend-mode: screen">
      <div class="inner" style="mix-blend-mode: multiply"></div>
    </div>
    {#each ANCESTORS as ancestor}
      <div id="ancestor-{ancestor}" class="ancestor {ancestor}">
        <div class="tile" style="mix-blend-mode: multiply"></div>
      </div>
    {/each}
    <div id="hoisted" class="ancestor overflow">
      <div class="tile hoisted" style="mix-blend-mode: difference"></div>
    </div>
  </div>

  <p>Text</p>
  <div class="tiles">
    <div id="text-difference" class="strip">
      <div class="blended-text" style="mix-blend-mode: difference">Blend text</div>
    </div>
    <div id="text-box" class="strip">
      <div class="label" style="mix-blend-mode: multiply">Multiply</div>
    </div>
  </div>

  <p>Avatar ring</p>
  <div class="tiles">
    <span id="ring" class="avatar"><img class="avatar-image" src="/backdrop.png" alt="" /></span>
    <span id="ring-large" class="avatar large"><img class="avatar-image" src="/avatar.png" alt="" /></span>
    <div class="dark">
      <span id="ring-lighten" class="avatar large lighten"><img class="avatar-image" src="/avatar.png" alt="" /></span>
    </div>
  </div>

  <p>background-blend-mode</p>
  <div class="tiles solid">
    {#each BACKGROUND_MODES as mode}
      <div id="background-{mode}" class="tile layered" style="background-blend-mode: {mode}"></div>
    {/each}
    <div id="background-layers" class="tile layers"></div>
  </div>
</main>
