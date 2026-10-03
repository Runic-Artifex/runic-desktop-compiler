<script lang="ts">
  let count = $state(0);
  let shown = $state('');
  let log: string[] = [];
  let getterRuns = 0;
  let unusedRuns = 0;
  let even = $derived(count % 2 === 0);
  let doubled = $derived.by(() => {
    getterRuns += 1;
    return count * 2;
  });
  let unused = $derived.by(() => {
    unusedRuns += 1;
    return count + 1;
  });
  $effect(() => {
    log.push(`even ${even}`);
  });
  function addTwo() {
    count += 2;
    log.push(`read ${doubled} ${doubled} runs ${getterRuns}`);
  }
  function addOne() {
    count += 1;
  }
  function dump() {
    shown = `${log.join(' | ')} | getter ${getterRuns} unused ${unusedRuns}`;
    log = [];
  }
</script>
<main><h1 id="title">Derived timing</h1>
<p id="values">{count} {doubled} {even ? 'even' : 'odd'}</p>
<p id="log">{shown}</p>
<div class="controls"><button id="add-two" onclick={addTwo}>Add two</button><button id="add-one" onclick={addOne}>Add one</button><button id="dump" onclick={dump}>Dump</button></div>
</main>
