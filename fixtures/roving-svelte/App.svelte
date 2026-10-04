<script lang="ts">
  // The roving list of roving.svelte.ts: keys move the focus among the
  // enabled items (Enter and Escape too, which the differential presses),
  // clicks pick one, and items register their labels in a SvelteMap.
  import { boxWith } from 'svelte-toolbelt';
  import { Roving } from './roving.svelte.ts';
  import Item from './Item.svelte';

  let root = $state<HTMLElement | null>(null);
  let loop = $state(true);
  let vertical = $state(false);
  let third = $state(true);
  let disabled = $state(false);

  const roving = new Roving({
    attr: 'data-roving-item',
    root: boxWith(() => root),
    loop: boxWith(() => loop),
    orientation: boxWith(() => (vertical ? 'vertical' : 'horizontal')),
  });
</script>

<main>
  <div class="list" class:vertical bind:this={root} onkeydown={(e) => roving.onkeydown(e)} role="toolbar" tabindex="-1">
    <Item {roving} id="a" label="Alpha" />
    <Item {roving} id="b" label="Beta" {disabled} />
    {#if third}<Item {roving} id="c" label="Gamma" />{/if}
    <Item {roving} id="d" label="Delta" />
  </div>
  <div class="controls">
    <button id="loop" onclick={() => (loop = !loop)}>{loop ? 'No loop' : 'Loop'}</button>
    <button id="vertical-toggle" onclick={() => (vertical = !vertical)}>{vertical ? 'Horizontal' : 'Vertical'}</button>
    <button id="third" onclick={() => (third = !third)}>{third ? 'Remove C' : 'Add C'}</button>
    <button id="disable" onclick={() => (disabled = !disabled)}>{disabled ? 'Enable B' : 'Disable B'}</button>
  </div>
  <p id="state">{roving.label} {roving.size} {roving.moves} {roving.history.join(',')}</p>
</main>
