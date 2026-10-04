<script lang="ts">
  import { tick } from 'svelte';

  // Scroll events: one per moved scroller in the rendering step after the
  // action; none at the wrapper (scroll does not bubble). Shrinking the
  // content clamps the scroll position, whose event follows a frame later.
  let n = $state(40);
  let log = $state<number[]>([]);
  let outer = $state(0);
  let readout = $state('');
  let list: HTMLDivElement;
  const items = $derived(range(n));

  function range(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }

  async function read() {
    n = 10;
    await tick();
    // A forced layout clamps at once.
    readout = String(list.scrollTop);
  }
</script>

<main>
  <!-- First: Blitz hit-tests a scrolled container over the area above it (docs/BLITZ-GAPS.md). -->
  <div id="outer" onscroll={() => (outer += 1)}>
    <div id="list" bind:this={list} onscroll={() => log.push(list.scrollTop)}>
      {#each items as i (i)}
        <div class="item">Item {i}</div>
      {/each}
    </div>
  </div>
  <div class="row">
    <button id="down" onclick={() => (list.scrollTop = 400)}>Down</button>
    <button id="shrink" onclick={() => (n = 20)}>Shrink</button>
    <button id="tiny" onclick={() => (n = 3)}>Tiny</button>
    <button id="grow" onclick={() => (n = 40)}>Grow</button>
    <button id="read" onclick={read}>Read</button>
  </div>
  <p id="log">{log.join(' ')}</p>
  <p id="state">{outer} {readout}</p>
</main>
