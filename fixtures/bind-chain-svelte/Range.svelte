<script lang="ts">
  // shadcn-svelte's Slider shape: its own `value = $bindable()` bound on.
  import RangeCore from './RangeCore.svelte';

  let { value = $bindable(), ...rest }: { value?: number[]; max?: number; id: string } = $props();
</script>

<RangeCore bind:value={value as never} {...rest} />
