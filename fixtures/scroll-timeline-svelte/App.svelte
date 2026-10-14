<script lang="ts">
  // Scroll-driven animations: each follows its scroller's offset (wheel
  // turns, programmatic scrolling) and range (content that grows).
  let tall = $state(false);
  let vertical: HTMLDivElement;
  let x: HTMLDivElement;
  const bands = [1, 2, 3, 4, 5, 6, 7];
  const cells = [1, 2, 3, 4, 5, 6, 7, 8];
</script>

<main>
  <div class="row">
    <button id="jump" onclick={() => (vertical.scrollTop = 120)}>Jump</button>
    <button id="end" onclick={() => (x.scrollLeft = 1000)}>End</button>
    <button id="more" onclick={() => (tall = !tall)}>Grow</button>
  </div>
  <section>
    <p>self y</p>
    <div id="self" class="scroller" bind:this={vertical}>
      <div class="content">{#each bands as b (b)}<div class="band">{b}</div>{/each}</div>
    </div>
  </section>
  <section>
    <p>0 96px</p>
    <div id="len" class="scroller">
      <div class="content">{#each bands as b (b)}<div class="band">{b}</div>{/each}</div>
    </div>
  </section>
  <section>
    <p>calc(100% - 96px) 100%</p>
    <div id="calc" class="scroller">
      <div class="content">{#each bands as b (b)}<div class="band">{b}</div>{/each}</div>
    </div>
  </section>
  <section>
    <p>delay, 2 iterations</p>
    <div id="delay" class="scroller">
      <div class="content">{#each bands as b (b)}<div class="band">{b}</div>{/each}</div>
    </div>
  </section>
  <section>
    <p>nearest</p>
    <div id="nearest" class="scroller">
      <div class="knob"></div>
      <div class="content">{#each bands as b (b)}<div class="band">{b}</div>{/each}</div>
    </div>
  </section>
  <section>
    <p>self x</p>
    <div id="x" class="hscroller" bind:this={x}>
      {#each cells as c (c)}<span class="cell">{c}</span>{/each}
    </div>
  </section>
  <section>
    <p>inline, right to left</p>
    <!-- One wide block (Parley does not yet order atomic inline boxes right to left). -->
    <div id="rtl" class="hscroller" dir="rtl">
      <div class="wide"></div>
    </div>
  </section>
  <section>
    <p>inactive</p>
    <div id="inactive" class="scroller">
      <div class="short">{#each [1] as b (b)}<div class="band">{b}</div>{/each}</div>
    </div>
  </section>
  <section>
    <p>growing range</p>
    <div id="grow" class="scroller">
      <div class="content" style:height={tall ? '400px' : '160px'}>{#each bands as b (b)}<div class="band">{b}</div>{/each}</div>
    </div>
  </section>
</main>
