<script lang="ts">
  let {
    ref = $bindable(null),
    value = $bindable(''),
    ...rest
  }: { ref?: HTMLInputElement | null; value?: string; [key: string]: unknown } = $props();
</script>

<input bind:this={ref} bind:value type="text" {...rest} />
