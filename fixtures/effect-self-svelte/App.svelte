<script lang="ts">
  // Effects that write what they read: Svelte runs such an effect again
  // (a write through a proxy as a write of a cell), unless the write left
  // the value as it was.
  let items = $state([1, 2, 3, 4, 5]);
  let count = $state(5);
  let box = $state({ value: 5 });
  let sync = $state({ source: 1, mirror: 0, list: [0] });
  let log = $state('');
  let entries: string[] = [];

  $effect(() => {
    entries.push(`len ${items.length}`);
    if (items.length > 3) items.pop();
  });
  $effect(() => {
    entries.push(`count ${count}`);
    if (count > 3) count -= 1;
  });
  $effect(() => {
    entries.push(`box ${box.value}`);
    if (box.value > 3) box.value -= 1;
  });
  // Writes the value it read: once more after a change, then not again.
  $effect(() => {
    entries.push(`mirror ${sync.mirror} ${sync.list[0]}`);
    sync.mirror = sync.source;
    sync.list[0] = sync.source;
  });

  function grow() {
    items.push(6, 7);
    count = 6;
    box.value = 6;
    sync.source = 2;
  }
  function dump() {
    log = entries.join(' | ');
    entries = [];
  }
</script>

<main>
  <h1 id="title">Effects writing what they read</h1>
  <p id="values">{items.length} {count} {box.value} {sync.mirror} {sync.list[0]}</p>
  <p id="log">{log}</p>
  <div class="controls">
    <button id="grow" onclick={grow}>Grow</button>
    <button id="dump" onclick={dump}>Dump</button>
  </div>
</main>
