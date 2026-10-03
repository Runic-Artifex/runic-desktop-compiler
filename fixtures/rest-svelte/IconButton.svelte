<script lang="ts">
  import Button from './Button.svelte';
  let { label, ...rest }: { label: string; [key: string]: unknown } = $props();
</script>

<Button variant="ghost" {...rest}>{label}</Button>
