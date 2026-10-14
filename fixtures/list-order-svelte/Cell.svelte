<script lang="ts">
  let { id, n, record }: { id: number; n: number; record: (line: string) => void } = $props();

  $effect.pre(() => {
    record(`cell ${id} ${n}`);
  });
</script>

<span>{n % 2 === 0 ? 'even' : 'odd'}</span>
