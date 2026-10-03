<script lang="ts">
  let count = $state(0);
  let log = $state('');
  function later() {
    count += 1;
    setTimeout(() => (log = `${log} later:${count}`), 100);
  }
  function micro() {
    count += 1;
    queueMicrotask(() => (log = `${log} micro:${count}`));
  }
  function functional() {
    setTimeout(() => (count += 10), 50);
    count += 1;
  }
</script>
<main><h1 id="title">Closures</h1>
<p id="count">{count}</p>
<p id="log">{log}</p>
<div class="controls"><button id="later" onclick={later}>Later</button><button id="micro" onclick={micro}>Micro</button><button id="functional" onclick={functional}>Functional</button></div>
</main>
