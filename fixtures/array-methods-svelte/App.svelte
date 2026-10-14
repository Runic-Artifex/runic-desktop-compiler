<script lang="ts">
  // pop, shift, unshift and splice through a $state proxy get,
  // set and delete elements one by one (the spec's steps through the
  // proxy's traps): an element they leave as it is (or set to an equal
  // value) is not written, so an effect reading only it does not run again
  // (docs/design/REACTIVITY-ALIASING.md, R4).
  let items = $state([1, 2, 3, 4, 5]);
  let log = $state('');
  let entries: string[] = [];

  $effect(() => {
    entries.push(`a ${items[0]}`);
  });
  $effect(() => {
    entries.push(`b ${items[1]}`);
  });
  $effect(() => {
    entries.push(`c ${items[2]}`);
  });
  $effect(() => {
    entries.push(`len ${items.length}`);
  });

  function dump() {
    log = entries.join(' | ');
    entries = [];
  }
  function reset() {
    items = [1, 2, 3, 4, 5];
  }
</script>

<main>
  <h1 id="title">Array methods</h1>
  <p id="items">{items.join(',')}</p>
  <p id="log">{log}</p>
  <div class="controls">
    <button id="pop" onclick={() => items.pop()}>Pop</button>
    <button id="shift" onclick={() => items.shift()}>Shift</button>
    <button id="unshift" onclick={() => items.unshift(0)}>Unshift</button>
    <button id="splice-cut" onclick={() => items.splice(2, 1)}>Splice cut</button>
    <button id="splice-same" onclick={() => items.splice(1, 1, items[1])}>Splice same</button>
    <button id="splice-add" onclick={() => items.splice(3, 0, 8)}>Splice add</button>
    <button id="reset" onclick={reset}>Reset</button>
    <button id="dump" onclick={dump}>Dump</button>
  </div>
</main>
