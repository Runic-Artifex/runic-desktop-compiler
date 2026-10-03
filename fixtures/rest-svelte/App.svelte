<script lang="ts">
  import Button from './Button.svelte';
  import IconButton from './IconButton.svelte';
  let count = $state(0);
  let busy = $state(false);
  let title = $state<string | undefined>('First');
  let log = $state<string[]>([]);
</script>

<main>
  <div class="row">
    <Button id="inc" onclick={() => count++} aria-label="Increment" {title}>Add</Button>
    <Button id="toggle" variant="outline" class="wide" onclick={() => { busy = !busy; title = busy ? undefined : 'Second'; }}>Toggle</Button>
    <IconButton id="icon" label="Icon" disabled={busy} data-count={count} onclick={(e) => log.push(e.type)} onpointerenter={() => log.push('enter')} />
  </div>
  <p id="state">{count} {busy}</p>
  <p id="log">{log.join(' ')}</p>
</main>
