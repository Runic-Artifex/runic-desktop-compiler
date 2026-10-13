<script lang="ts">
  // bits-ui's Slider.Root shape: `value = $bindable()` without a default,
  // written only through its box's setter.
  import { boxWith } from 'svelte-toolbelt';
  import { RangeState } from './state.svelte.ts';

  let {
    value = $bindable(),
    max = 100,
    id,
  }: { value?: number[]; max?: number; id: string } = $props();

  const range = new RangeState({
    value: boxWith(
      () => value,
      v => {
        value = v;
      },
    ),
    max,
  });
</script>

<div class="range" {id}>
  {#each range.thumbs as thumb, i (i)}
    <span class="thumb">
      <button id="{id}-down-{i}" onclick={() => range.step(i, -10)}>-</button>
      <span class="value" id="{id}-thumb-{i}">{thumb}</span>
      <button id="{id}-up-{i}" onclick={() => range.step(i, 10)}>+</button>
    </span>
  {/each}
</div>
