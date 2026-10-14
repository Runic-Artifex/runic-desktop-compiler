<script lang="ts">
  // Pre effects of keyed list items, logged into one plain array: Svelte's
  // each block creates the new items (running their pre effects) in array
  // order, then moves blocks; the flush then runs the dirty pre effects of
  // the other items in document order.
  import Row from './Row.svelte';

  let items = $state([1, 2, 3]);
  let n = $state(0);
  let next = 4;
  let entries: string[] = [];
  let shown = $state('');

  function record(line: string) {
    entries.push(line);
  }
  function dump() {
    shown = entries.join(' | ');
    entries = [];
  }
  function fresh(): number {
    const id = next;
    next += 1;
    return id;
  }
  function front() {
    items.unshift(fresh());
    n++;
  }
  function back() {
    items.push(fresh());
    n++;
  }
  function reverse() {
    items.reverse();
    n++;
  }
  function rotate() {
    const first = items.shift();
    if (first !== undefined) items.push(first);
    n++;
  }
  function shuffle() {
    const old = items.slice();
    const mid = Math.floor(old.length / 2);
    const out: number[] = [fresh()];
    for (const x of old.slice(mid).reverse()) out.push(x);
    out.push(fresh());
    for (const x of old.slice(0, mid)) out.push(x);
    items = out;
    n++;
  }
</script>

<main>
  <h1 id="title">Pre effects of list items</h1>
  {#each items as i (i)}<Row id={i} {n} {record} />{/each}
  <p id="log">{shown}</p>
  <div class="controls">
    <button id="bump" onclick={() => n++}>Bump</button><button id="front" onclick={front}>Front</button><button id="back" onclick={back}>Back</button><button id="reverse" onclick={reverse}>Reverse</button><button id="rotate" onclick={rotate}>Rotate</button><button id="shuffle" onclick={shuffle}>Shuffle</button><button id="dump" onclick={dump}>Dump</button>
  </div>
</main>
