<script lang="ts">
  // shadcn-svelte's ui/field/field-legend.svelte.
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    ref = $bindable(null),
    class: className = '',
    variant = 'legend',
    children,
    ...restProps
  }: HTMLAttributes<HTMLLegendElement> & {
    ref?: HTMLLegendElement | null;
    variant?: 'legend' | 'label';
    children?: Snippet;
  } = $props();
</script>

<legend
  bind:this={ref}
  data-slot="field-legend"
  data-variant={variant}
  class="field-legend {className}"
  {...restProps}
>
  {@render children?.()}
</legend>
