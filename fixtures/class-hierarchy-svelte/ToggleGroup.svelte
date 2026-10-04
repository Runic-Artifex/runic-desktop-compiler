<script lang="ts">
  import {
    ToggleGroupBaseState,
    ToggleGroupMultipleState,
    type Item,
  } from './toggle-group.svelte.ts';

  let {
    type,
    name,
    items,
  }: { type: 'single' | 'multiple'; name: string; items: Item[] } = $props();

  // The state class is chosen by the `type` prop, as bits-ui chooses its root states.
  const state = ToggleGroupBaseState.create(type, name, items);
  // The same instance through its base class.
  const base: ToggleGroupBaseState = state;
</script>

<section id={`${name}-group`}>
  <h2>{name}</h2>
  <div class="items">
    {#each items as item (item.value)}
      <button
        id={`${name}-${item.value}`}
        class:on={state.isPressed(item.value)}
        aria-pressed={state.isPressed(item.value) ? 'true' : 'false'}
        onclick={() => state.toggle(item.value)}>{item.label}</button
      >
    {/each}
    <button id={`${name}-clear`} onclick={() => base.clear()}>clear</button>
  </div>
  <p id={`${name}-summary`}>{base.summary}</p>
  <p id={`${name}-detail`}>
    {state.kind === 'single' ? `value=${state.value || '-'}` : `values=${state.values.join('+') || '-'}`}
  </p>
  <p id={`${name}-count`}>
    {state.pressedCount} pressed, {base.presses} presses, {state instanceof ToggleGroupMultipleState
      ? 'multiple'
      : 'single'}
  </p>
</section>
