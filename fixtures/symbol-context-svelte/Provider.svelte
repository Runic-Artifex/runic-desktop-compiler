<script lang="ts">
  import type { Snippet } from 'svelte';
  import { setTone } from './context.ts';

  let { label, children }: { label: string; children?: Snippet } = $props();

  let count = $state(0);

  // An object of getters, as shadcn-svelte's toggle group shares its props:
  // reads through it read the provider's state.
  setTone({
    get label() {
      return label;
    },
    get count() {
      return count;
    },
    bump,
    reset,
  });

  function bump() {
    count += 1;
  }

  function reset() {
    count = 0;
  }
</script>

<section data-label={label}>
  <h2>{label} ({count})</h2>
  <button id="{label}-reset" onclick={reset}>reset {label}</button>
  {@render children?.()}
</section>
