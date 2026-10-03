<script lang="ts">
  let open = $state(false);
  let shortcuts = $state(0);
  let log = $state<string[]>([]);
  let panel = $state<HTMLElement | null>(null);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'k' && e.ctrlKey) {
      e.preventDefault();
      shortcuts++;
    }
    if (e.key === 'Escape') open = false;
    log.push(`window:${e.key}`);
  }

  // Click outside: a document listener while the panel is open.
  $effect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (e.target !== panel) {
        open = false;
        log.push('outside');
      }
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  });
</script>

<svelte:window onkeydown={onKey} />
<svelte:document onclick={() => log.push('document')} />

<main>
  <div class="row">
    <button id="open" onclick={(e) => { e.stopPropagation(); open = true; log.push('open'); }}>Open</button>
    <button id="open-late" onclick={() => { open = true; log.push('open-late'); }}>Open late</button>
  </div>
  {#if open}<div id="panel" bind:this={panel}>Panel</div>{/if}
  <div class="row"><input id="field" type="text" aria-label="Field" onkeydown={(e) => { if (e.key === 'q') e.stopPropagation(); }} /></div>
  <p id="state">{open} {shortcuts}</p>
  <p id="log">{log.join(' ')}</p>
</main>
