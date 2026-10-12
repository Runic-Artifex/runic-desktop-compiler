<script lang="ts">
  // shadcn-svelte's ui/field/field-set.svelte, without tailwind-merge: the
  // fieldset carries the element ref and the rest props.
  import type { Snippet } from 'svelte';
  import type { HTMLFieldsetAttributes } from 'svelte/elements';

  let {
    ref = $bindable(null),
    class: className = '',
    children,
    ...restProps
  }: HTMLFieldsetAttributes & { ref?: HTMLFieldSetElement | null; children?: Snippet } = $props();
</script>

<fieldset bind:this={ref} data-slot="field-set" class="field-set {className}" {...restProps}>
  {@render children?.()}
</fieldset>
