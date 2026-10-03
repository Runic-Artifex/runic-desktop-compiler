<script lang="ts">
  import { tick } from 'svelte';
  let count = $state(0);
  let shown = $state('');
  let log: string[] = [];
  $effect(() => {
    log.push(`effect ${count}`);
  });
  function inc() {
    tick().then(() => log.push(`tick-before ${count}`));
    queueMicrotask(() => log.push('micro-before'));
    count += 1;
    queueMicrotask(() => log.push('micro-after'));
    tick().then(() => log.push(`tick-after ${count}`));
    log.push('handler');
  }
  async function later() {
    count += 1;
    log.push('before await');
    await tick();
    log.push(`after await ${count}`);
  }
  function dump() {
    shown = log.join(' | ');
    log = [];
  }
</script>
<main><h1 id="title">Flush timing</h1>
<p id="count">{count}</p>
<p id="log">{shown}</p>
<div class="controls"><button id="inc" onclick={inc}>Increment</button><button id="later" onclick={later}>Later</button><button id="dump" onclick={dump}>Dump</button></div>
</main>
