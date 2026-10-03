<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  let { name, count, note }: { name: string; count: number; note: (s: string) => void } = $props();
  $effect.pre(() => {
    note(`${name} pre ${count}`);
  });
  $effect(() => {
    note(`${name} effect ${count}`);
    return () => note(`${name} cleanup ${count}`);
  });
  onMount(() => {
    note(`${name} mount`);
    return () => note(`${name} unmount`);
  });
  onDestroy(() => note(`${name} destroy`));
</script>
<p id={'child-' + name}>{name}: {count}</p>
