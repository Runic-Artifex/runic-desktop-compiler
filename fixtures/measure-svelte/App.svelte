<script lang="ts">
  // Layout reads and scrolling: an effect measures the box after the DOM
  // update; handlers scroll a list and read its scroll position at once.
  let wide = $state(false);
  let box: HTMLDivElement;
  let list: HTMLDivElement;
  let mid: HTMLDivElement;
  let end: HTMLDivElement;
  let rect = $state('');
  let metrics = $state('');
  let scroll = $state('');
  let scrolls = $state<number[]>([]);
  const first = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const second = first.map(i => i + 15);

  $effect(() => {
    // Runs after the DOM update for `wide`.
    if (wide || !wide) {
      const r = box.getBoundingClientRect();
      rect = [r.x, r.y, r.width, r.height, r.top, r.right, r.bottom, r.left].join(' ');
      metrics = [
        box.offsetWidth,
        box.offsetHeight,
        box.offsetLeft,
        box.offsetTop,
        box.clientWidth,
        box.clientHeight,
        box.clientLeft,
        box.clientTop,
        box.scrollWidth,
        box.scrollHeight,
        window.innerWidth,
        window.innerHeight,
      ].join(' ');
    }
  });

  function report() {
    scroll = [list.scrollTop, list.scrollHeight, list.clientHeight, list.scrollLeft].join(' ');
  }
</script>

<main>
  <!-- First: Blitz hit-tests a scrolled container over the area above it (docs/BLITZ-GAPS.md). -->
  <div id="list" bind:this={list} onscroll={() => scrolls.push(list.scrollTop)}>
    {#each first as i (i)}
      <div>Item {i}</div>
    {/each}
    <div id="mid" bind:this={mid}>Middle</div>
    {#each second as i (i)}
      <div>Item {i}</div>
    {/each}
    <div id="end" bind:this={end}>End</div>
  </div>
  <div class="row">
    <button id="toggle" onclick={() => (wide = !wide)}>Toggle</button>
    <button id="down" onclick={() => { list.scrollTop += 40; list.scrollTop += 5; report(); }}>Down</button>
    <button id="by" onclick={() => { list.scrollBy(0, 33.5); report(); }}>By</button>
    <button id="top" onclick={() => { list.scrollTo({ top: 0 }); report(); }}>Top</button>
  </div>
  <div class="row">
    <button id="near" onclick={() => { mid.scrollIntoView({ block: 'nearest' }); report(); }}>Near</button>
    <button id="start" onclick={() => { mid.scrollIntoView(); report(); }}>Start</button>
    <button id="center" onclick={() => { end.scrollIntoView({ block: 'center' }); report(); }}>Center</button>
    <button id="last" onclick={() => { end.scrollIntoView(false); report(); }}>Last</button>
  </div>
  <div id="box" class={wide ? 'wide' : ''} bind:this={box}>Box</div>
  <p id="rect">{rect}</p>
  <p id="metrics">{metrics}</p>
  <p id="scroll">{scroll}</p>
  <p id="scrolls">{scrolls.join(' ')}</p>
</main>
