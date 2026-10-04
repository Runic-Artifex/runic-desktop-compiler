<script lang="ts">
  // svelte-toolbelt 0.10.6 and runed 0.35.1 used directly (their mapping
  // packs), in the patterns bits-ui builds on: see disclosure.svelte.ts.
  // The interpreter runs this program too (no layout reads), so the
  // differential covers attachments, contexts, merged bags and effects
  // created while instances are created.
  import Root from './Root.svelte';
  import Trigger from './Trigger.svelte';
  import Panel from './Panel.svelte';

  let open = $state(false);
  let changes = $state(0);
  let blocked = $state(false);
  let panel = $state<HTMLElement | null>(null);
  let shown = $state(true);
</script>

<main>
  {#if shown}
    <Root id="disclosure" class="user" bind:open onOpenChange={() => changes++} data-user="yes">
      <Trigger
        id="trigger"
        class="big"
        onclick={(e: MouseEvent) => {
          if (blocked) e.preventDefault();
        }}>Details</Trigger
      >
      <Panel id="panel" bind:ref={panel} style="color: #a04020">Panel content</Panel>
    </Root>
  {/if}
  <div class="controls">
    <button id="outside" onclick={() => (open = !open)}>Toggle from outside</button>
    <button id="block" onclick={() => (blocked = !blocked)}>{blocked ? 'Unblock' : 'Block'}</button>
    <button id="unmount" onclick={() => (shown = !shown)}>{shown ? 'Unmount' : 'Mount'}</button>
  </div>
  <p id="state">{open} {changes} {blocked} {panel ? 'ref' : 'no ref'}</p>
</main>
