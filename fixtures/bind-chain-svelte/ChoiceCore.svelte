<script lang="ts">
  // bits-ui's Menu.RadioGroup shape: `value = $bindable("")`, written only
  // through its box's setter.
  import { boxWith } from 'svelte-toolbelt';
  import { ChoiceState } from './state.svelte.ts';

  let {
    value = $bindable(''),
    options,
    id,
  }: { value?: string; options: string[]; id: string } = $props();

  const choice = new ChoiceState({
    value: boxWith(
      () => value,
      v => {
        value = v;
      },
    ),
  });
</script>

<div class="choice" {id} role="radiogroup">
  {#each options as option (option)}
    <button
      id="{id}-{option}"
      role="radio"
      aria-checked={value === option}
      class:checked={value === option}
      onclick={() => choice.select(option)}>{option}</button
    >
  {/each}
  <span id="{id}-changes">{choice.changes}</span>
</div>
