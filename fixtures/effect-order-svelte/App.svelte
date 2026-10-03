<script lang="ts">
  let a = $state(0);
  let b = $state(0);
  let shown = $state('');
  let runs = 0;
  let log: string[] = [];
  $effect(() => {
    runs += 1;
    log.push(`early b=${b}`);
  });
  $effect(() => {
    runs += 1;
    b = a * 10;
    log.push(`writer a=${a}`);
  });
  $effect(() => {
    runs += 1;
    log.push(`late b=${b}`);
  });
  function inc() {
    queueMicrotask(() => log.push(`micro-before runs=${runs}`));
    a += 1;
    queueMicrotask(() => log.push(`micro-after runs=${runs}`));
    log.push(`handler b=${b}`);
  }
  function dump() {
    shown = log.join(' | ');
    log = [];
  }
</script>
<main><h1 id="title">Effect order</h1>
<p id="values">{a} {b}</p>
<p id="log">{shown}</p>
<div class="controls"><button id="inc" onclick={inc}>Increment</button><button id="dump" onclick={dump}>Dump</button></div>
</main>
