<script lang="ts">
  // Array methods through a $state proxy set elements one by one: reverse,
  // sort and fill leave the elements they do not change as they are (an
  // effect reading one does not run again), and fill stores a new proxy of
  // a plain object at each index (docs/design/REACTIVITY-ALIASING.md, R4).
  let items = $state([1, 2, 3]);
  let objs = $state([{ n: 0 }, { n: 0 }]);
  let log = $state('');
  let entries: string[] = [];

  $effect(() => {
    entries.push(`mid ${items[1]}`);
  });
  $effect(() => {
    entries.push(`first ${items[0]}`);
  });

  function dump() {
    log = entries.join(' | ');
    entries = [];
  }
</script>

<main>
  <h1 id="title">Array writes</h1>
  <p id="items">{items.join(',')}</p>
  <p id="objs">{objs[0].n} {objs[1].n}</p>
  <p id="log">{log}</p>
  <div class="controls">
    <button id="reverse" onclick={() => items.reverse()}>Reverse</button>
    <button id="sort" onclick={() => items.sort((a, b) => a - b)}>Sort</button>
    <button id="fill-same" onclick={() => items.fill(2, 1, 2)}>Fill same</button>
    <button id="fill-first" onclick={() => items.fill(7, 0, 1)}>Fill first</button>
    <button id="fill-objs" onclick={() => objs.fill({ n: 5 })}>Fill objects</button>
    <button id="bump" onclick={() => (objs[0].n += 1)}>Bump</button>
    <button id="dump" onclick={dump}>Dump</button>
  </div>
</main>
