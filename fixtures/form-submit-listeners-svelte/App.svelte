<script lang="ts">
  import { onMount } from 'svelte';
  let form: HTMLElement | null = null;
  let mode = $state('replace');
  let log = $state('ready');
  let changed = false;
  let installed = false;
  let firstCount = $state(0);
  let laterCount = $state(0);
  let freshCount = $state(0);
  let addedCount = $state(0);
  function note(s: string) {
    log = (log === 'ready' ? s : log + ' ' + s).slice(-512);
  }
  function later() {
    laterCount++;
    note('late');
  }
  function fresh() {
    freshCount++;
    note('fresh');
  }
  function added() {
    addedCount++;
    note('added');
  }
  function first() {
    firstCount++;
    note('first');
    if ((mode === 'replace' || mode === 'readd') && !changed) {
      changed = true;
      // The callback slot can be reused, but its new occupant is not in this stage.
      document.removeEventListener('submit', later);
      if (mode === 'replace') {
        document.addEventListener('submit', fresh);
        note('replace');
      } else {
        document.addEventListener('submit', later);
        note('readd');
      }
    }
  }
  function capture() {
    note('capture');
    if (mode === 'capture' && !installed) {
      installed = true;
      // Document bubble has not started; this listener belongs to that later stage.
      document.addEventListener('submit', added);
      note('install');
    }
  }
  function removeBubble() {
    document.removeEventListener('submit', first);
    document.removeEventListener('submit', later);
    document.removeEventListener('submit', fresh);
    document.removeEventListener('submit', added);
  }
  function installBase() {
    removeBubble();
    document.addEventListener('submit', first);
    document.addEventListener('submit', later);
  }
  function cleanup() {
    document.removeEventListener('submit', capture, true);
    removeBubble();
  }
  function select(s: string) {
    mode = s;
    log = 'ready';
    changed = false;
    installed = false;
    firstCount = 0;
    laterCount = 0;
    freshCount = 0;
    addedCount = 0;
    installBase();
  }
  function submit(e: Event) {
    e.preventDefault();
    note('target');
  }
  function request() {
    note('before');
    form?.requestSubmit();
    note('after');
  }
  onMount(() => {
    document.addEventListener('submit', capture, true);
    installBase();
    return () => cleanup();
  });
</script>

<main>
  <h1>Submit listener mutation</h1>
  <div class="controls">
    <button id="mode-replace" type="button" onclick={() => select('replace')}
      >Replace during bubble</button
    >
    <button id="mode-capture" type="button" onclick={() => select('capture')}
      >Add during capture</button
    >
    <button id="mode-readd" type="button" onclick={() => select('readd')}
      >Readd same callback</button
    >
  </div>
  <p id="mode">{mode}</p>
  <form id="listener-form" bind:this={form} onsubmit={submit}>
    <input id="field" aria-label="Submission field" type="text" />
    <button id="physical" type="submit">Physical submission</button>
  </form>
  <button id="request" type="button" onclick={request}>Request submission</button>
  <p id="counts">
    {'first:' +
      firstCount +
      ' late:' +
      laterCount +
      ' fresh:' +
      freshCount +
      ' added:' +
      addedCount}
  </p>
  <p id="log">{log}</p>
</main>
