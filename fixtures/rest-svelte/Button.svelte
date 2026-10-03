<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    variant = 'default',
    class: className = '',
    children,
    ...rest
  }: { variant?: string; class?: string; children?: Snippet; [key: string]: unknown } = $props();
</script>

<button class={`btn ${variant} ${className}`.trim()} type="button" {...rest}>{@render children?.()}</button>
