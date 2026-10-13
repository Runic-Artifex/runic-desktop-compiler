<script lang="ts">
  // Svelte gives teardowns the values signals had before the flush,
  // including the per-property signals of proxies; a derived value read
  // there is computed from them.
  import Child from './Child.svelte';

  let state = $state({ count: 0 });
  let n = $state(0);
  let show = $state(true);
  let log = $state('');
  let entries: string[] = [];
  const doubled = $derived(state.count * 2);

  $effect(() => {
    const seen = state.count;
    const seenN = n;
    return () => {
      entries.push(`cleanup ${seen}/${state.count} ${seenN}/${n} d${doubled}`);
    };
  });

  function bump() {
    state.count += 1;
    n += 1;
  }
  function twice() {
    state.count += 1;
    state.count += 1;
    n += 1;
    n += 1;
  }
  function hide() {
    show = false;
    state.count += 10;
    n += 10;
  }
  function record(line: string) {
    entries.push(line);
  }
  function dump() {
    log = entries.join(' | ');
    entries = [];
  }
</script>

<main>
  <h1 id="title">Teardown reads</h1>
  <p id="values">{state.count} {n}</p>
  {#if show}<Child {state} {n} {record} />{/if}
  <p id="log">{log}</p>
  <div class="controls">
    <button id="bump" onclick={bump}>Bump</button>
    <button id="twice" onclick={twice}>Twice</button>
    <button id="hide" onclick={hide}>Hide</button>
    <button id="dump" onclick={dump}>Dump</button>
  </div>
</main>
