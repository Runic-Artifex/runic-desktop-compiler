<script lang="ts">
  interface Item {
    done: boolean;
  }
  let a = $state<number[]>([1]);
  let b = $state<number[]>([1]);
  let items = $state<Item[]>([{ done: false }, { done: false }]);
  let shown = $state('');
  let log: string[] = [];
  $effect(() => {
    log.push(`a ${a.length}`);
  });
  $effect(() => {
    log.push(`first ${items[0].done}`);
  });
  $effect(() => {
    log.push(`count ${items.length}`);
  });
  function dump() {
    shown = log.join(' | ');
    log = [];
  }
</script>
<main><h1 id="title">Deep tracking</h1>
<p id="values">{a.length} {b.length} {items.length}</p>
<p id="log">{shown}</p>
<div class="controls"><button id="push-b" onclick={() => b.push(1)}>Push b</button><button id="push-a" onclick={() => a.push(1)}>Push a</button><button id="toggle-second" onclick={() => (items[1].done = !items[1].done)}>Toggle second</button><button id="toggle-first" onclick={() => (items[0].done = !items[0].done)}>Toggle first</button><button id="add-item" onclick={() => items.push({ done: false })}>Add item</button><button id="dump" onclick={dump}>Dump</button></div>
</main>
